import { finishJobStorage } from './media-storage';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./types";
import { now } from "./types";
import { withDefaults } from "./config";
import { avatarMap, failVideo, videoModels, jobVideoTier, type VideoMeta } from "./video";
import { submitWaveVideo, getWaveVideo, type WaveTicket } from "./video-wavespeed";
import { submitHeyGenVideo, getHeyGenVideo, getHeyGenAvatarStatus, deleteHeyGenFile, queueHeyGenFile, type HeyGenTicket, type HeyGenAvatar } from "./video-heygen";
import { prepareHeyGenAvatar, cleanupHeyGenAvatars } from "./video-heygen-avatar";
import { hasVideoCredential, savedVideoProvider, type VideoProvider } from "./video-provider";
import { providerFailure, VideoFailure, videoFailureMessage, type VideoStage } from "./video-errors";
import { videoFetch } from "./video-http";
import { notifyVideo } from "./video-notifications";
import { runToolTask } from "./tools-workflow";

const FAST_POLLS = 180, SLOW_POLLS = 60;
const HEYGEN_IDEMPOTENCY_WINDOW = 20 * 3600;
type Ticket = { provider?: VideoProvider; request_id: string; status_url: string; response_url: string; cancel_url?: string };
export function queueUrl(value: string) {
  const url = new URL(value);
  if (url.origin !== "https://queue.fal.run" || url.username || url.password || !url.pathname.includes("/requests/")) throw new Error("Invalid queue URL");
  return url.href;
}
export function outputUrl(value: string) {
  const url = new URL(value);
  const allowed = ["fal.media", "falserverless.io", "amazonaws.com", "storage.googleapis.com", "wavespeed.ai", "cloudfront.net", "heygen.ai"];
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !allowed.some(h => url.hostname === h || url.hostname.endsWith("." + h)))
    throw new Error("Invalid video host");
  return url.href;
}
async function queueGet(env: Env, url: string, stage: VideoStage) {
  const r = await videoFetch(queueUrl(url), { headers: { Authorization: `Key ${env.FAL_KEY?.trim()}` }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw await providerFailure(r, stage);
  return r.json() as Promise<any>;
}
async function getVideo(env: Env, ticket: Ticket, stage: "STATUS" | "RESULT") {
  if (ticket.provider === "heygen") return getHeyGenVideo(env, ticket as HeyGenTicket, stage);
  if (ticket.provider === "wavespeed") return getWaveVideo(env, ticket as WaveTicket);
  if (ticket.provider != null && ticket.provider !== "fal") throw new VideoFailure(stage, "INTERNAL");
  return queueGet(env, stage === "STATUS" ? ticket.status_url : ticket.response_url, stage);
}
// Multipart upload bounds memory and accepts CDN responses without Content-Length.
/** Downloads a provider output, following at most two CDN redirects; every hop must pass outputUrl. */
async function fetchOutput(url: string, signal: AbortSignal) {
  let next = outputUrl(url);
  for (let hop = 0; hop <= 2; hop++) {
    const r = await fetch(next, { redirect: "manual", signal });
    if (r.status < 300 || r.status >= 400) return r;
    await r.body?.cancel();
    const location = r.headers.get("Location");
    if (!location || hop === 2) break;
    next = outputUrl(new URL(location, next).href);
  }
  throw new VideoFailure("DOWNLOAD", "MEDIA");
}
/** Our copy at HeyGen is deleted once the video is saved here (or failed); maintenance retries. */
async function forgetHeyGenVideo(env: Env, jobId: string, videoId: string) {
  await queueHeyGenFile(env, "video", videoId);
  try {
    await deleteHeyGenFile(env, "video", videoId);
    await env.DB.prepare("DELETE FROM cleanup_tasks WHERE prefix=?").bind(`heygen-file/video/${videoId}`).run();
  } catch { console.error("HeyGen copy cleanup will retry", { jobId }); }
}
export async function storeVideo(env: Env, key: string, url: string, maxBytes = 300 * 1024 * 1024) {
  const r = await fetchOutput(url, AbortSignal.timeout(240000));
  if (!r.ok || !r.body) throw new VideoFailure("DOWNLOAD", "MEDIA", r.status);
  // A 2-minute 1080p avatar video can exceed 100 MB.
  const limit = maxBytes;
  if (Number(r.headers.get("Content-Length")) > limit) { await r.body.cancel(); throw new Error("Video too large"); }
  const upload = await env.AUDIO.createMultipartUpload(key, { httpMetadata: { contentType: "video/mp4" } });
  const reader = r.body.getReader();
  const parts: R2UploadedPart[] = [];
  let buffer = new Uint8Array(5 * 1024 * 1024), offset = 0, total = 0, checked = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error("Video too large");
      let at = 0;
      while (at < value.length) {
        const count = Math.min(buffer.length - offset, value.length - at);
        buffer.set(value.subarray(at, at + count), offset); offset += count; at += count;
        if (!checked && offset >= 12) {
          if (String.fromCharCode(...buffer.subarray(4, 8)) !== "ftyp") throw new Error("Invalid video format");
          checked = true;
        }
        if (offset === buffer.length) {
          parts.push(await upload.uploadPart(parts.length + 1, buffer)); offset = 0;
          buffer = new Uint8Array(buffer.length);
        }
      }
    }
    if (!checked) throw new Error("Empty video");
    if (offset) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, offset)));
    await upload.complete(parts);
  } catch (e) { await reader.cancel().catch(() => {}); await upload.abort().catch(() => {}); throw e; }
}
/** Errors that do not mean the video failed: rate limits, provider 5xx, timeouts and network failures. */
export function transientStatusError(e: unknown) {
  if (!(e instanceof Error)) return false;
  if (["TimeoutError", "AbortError", "TypeError"].includes(e.name)) return true;
  const m = /^VIDEO_[A-Z]+_([A-Z]+)_(\d{1,3})$/.exec(e.message);
  if (!m) return false;
  const status = Number(m[2]);
  return m[1] === "CAPACITY" || m[1] === "TIMEOUT" || status === 429 || status >= 500;
}
export class VideoGeneration extends WorkflowEntrypoint<Env, { jobId?: string; toolTaskId?: string }> {
  async run(event: WorkflowEvent<{ jobId?: string; toolTaskId?: string }>, step: WorkflowStep) {
    // Media tools (dubbing) share this Workflow: the same provider polling, saving and refunds.
    if (event.payload.toolTaskId) return runToolTask(this.env, event.payload.toolTaskId, step);
    const id = event.payload.jobId!;
    let ticket: Ticket | undefined;
    let stage: VideoStage = "LOAD";
    try {
      const job = await step.do("load-video", async () => {
        const row = await this.env.DB.prepare("SELECT * FROM jobs WHERE id=? AND kind='video'").bind(id).first<any>();
        if (!row || !["queued", "running"].includes(row.status)) throw new Error("Video unavailable");
        // Guarded so a job failed in the meantime (and already refunded) is never revived.
        const started = await this.env.DB.prepare("UPDATE jobs SET status='running',updated_at=? WHERE id=? AND status IN ('queued','running')").bind(now(), id).run();
        if (!started.meta.changes) throw new Error("Video unavailable");
        return row;
      });
      stage = "SUBMIT";
      const jobTier = jobVideoTier(job), jobMeta: VideoMeta = JSON.parse(job.video_meta);
      // A saved avatar (library or the user's own) is used as it is. Older Medium jobs created a
      // temporary avatar from the photo first.
      let avatar: HeyGenAvatar | null = jobMeta.engine && jobMeta.heygenAvatar ? jobMeta.heygenAvatar : null;
      if (!jobMeta.engine && savedVideoProvider(jobMeta.provider, jobTier) === "heygen" && jobTier === "medium") {
        avatar = await step.do("create-photo-avatar-once", { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" },
          () => prepareHeyGenAvatar(this.env, id));
        if (avatar) {
          let ready = false;
          for (let i = 0; i < 60; i++) {
            const status = await step.do(`photo-avatar-status-${i}`, { retries: { limit: 2, delay: "10 seconds" }, timeout: "2 minutes" }, async () => {
              const status = await getHeyGenAvatarStatus(this.env, avatar!);
              await this.env.DB.prepare("UPDATE jobs SET updated_at=? WHERE id=?").bind(now(), id).run();
              return status;
            });
            if (status === "completed") { ready = true; break; }
            await step.sleep(`photo-avatar-wait-${i}`, "10 seconds");
          }
          if (!ready) throw new VideoFailure("STATUS", "TIMEOUT");
        }
      }
      ticket = await step.do("submit-video-once", { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" }, async () => {
        const row = await this.env.DB.prepare("SELECT provider_request,submitted_at FROM jobs WHERE id=?").bind(id).first<any>();
        if (row?.provider_request) return JSON.parse(row.provider_request) as Ticket;
        const tier = jobVideoTier(job);
        const meta: VideoMeta = JSON.parse(job.video_meta);
        const provider = savedVideoProvider(meta.provider, tier);
        if (!hasVideoCredential(this.env, provider)) throw new VideoFailure("SUBMIT", "AUTH");
        if (provider === "heygen" && (meta.engine || tier === "medium") && !avatar) throw new VideoFailure("SUBMIT", "INTERNAL");
        const source = await this.env.DB.prepare("SELECT audio_key FROM jobs WHERE id=? AND user_id=? AND status='completed'").bind(job.source_job_id, job.user_id).first<any>();
        if (!source?.audio_key || !(await this.env.AUDIO.head(source.audio_key))) throw new Error("Missing audio");
        if (tier !== "standard" && !meta.engine && (!meta.imageKey || !(await this.env.AUDIO.head(meta.imageKey)))) throw new Error("Missing portrait");
        const base = `${withDefaults(this.env).SITE_URL!.replace(/\/$/, "")}/api/video-inputs/${id}`;
        const audio_url = `${base}/audio?token=${meta.token}`;
        const input = tier === "standard"
          ? { avatar: avatarMap[meta.avatar], audio_url, remove_background: false }
          : { image_url: `${base}/image?token=${meta.token}`, audio_url, prompt: "A person speaking naturally to the camera. Subtle facial expressions and head movements." };
        // Never repeat an ambiguous external submission: it may already be billable. HeyGen is the exception:
        // it receives Idempotency-Key = job ID, so re-sending returns the original video instead of a new charge.
        const claim = await this.env.DB.prepare("UPDATE jobs SET submitted_at=? WHERE id=? AND submitted_at IS NULL").bind(now(), id).run();
        if (!claim.meta.changes && !(provider === "heygen" && row?.submitted_at > now() - HEYGEN_IDEMPOTENCY_WINDOW))
          throw new Error("Submission requires reconciliation");
        if (provider === "heygen" || provider === "wavespeed") {
          const t = provider === "heygen"
            ? await submitHeyGenVideo(this.env, id, `${base}/image?token=${meta.token}`, audio_url, avatar || undefined, meta.engine ?? "avatar_iii")
            : await submitWaveVideo(this.env, `${base}/image?token=${meta.token}`, audio_url);
          await this.env.DB.prepare("UPDATE jobs SET provider_request=?,updated_at=? WHERE id=?").bind(JSON.stringify(t), now(), id).run();
          return t;
        }
        const r = await videoFetch(`https://queue.fal.run/${videoModels[tier]}`, {
          method: "POST", headers: { Authorization: `Key ${this.env.FAL_KEY!.trim()}`, "Content-Type": "application/json" },
          body: JSON.stringify(input), signal: AbortSignal.timeout(60000),
        });
        if (!r.ok) throw await providerFailure(r, "SUBMIT");
        const t = await r.json() as Ticket;
        if (!t.request_id || typeof t.request_id !== "string") throw new Error("Missing request ID");
        queueUrl(t.status_url); queueUrl(t.response_url);
        if (t.cancel_url) queueUrl(t.cancel_url);
        t.provider = "fal";
        await this.env.DB.prepare("UPDATE jobs SET provider_request=?,updated_at=? WHERE id=?").bind(JSON.stringify(t), now(), id).run();
        return t;
      });
      let completed = false, unknown = 0;
      stage = "STATUS";
      // ~1 hour at 20 s, then up to ~5 more hours at 5 min: a slow provider queue still finishes (and is
      // still billed), so give up only when a result is very unlikely.
      for (let i = 0; i < FAST_POLLS + SLOW_POLLS; i++) {
        const status = await step.do(`video-status-${i}`, { retries: { limit: 2, delay: "10 seconds" }, timeout: "2 minutes" }, async () => {
          let s;
          try { s = await getVideo(this.env, ticket!, "STATUS"); }
          catch (e) {
            // A provider outage or network error says nothing about the video, which is still rendering (and billed):
            // keep polling. Only a real failure reported by the provider ends the job.
            if (transientStatusError(e)) return "UNKNOWN";
            throw e;
          }
          await this.env.DB.prepare("UPDATE jobs SET updated_at=? WHERE id=?").bind(now(), id).run();
          if (!["IN_QUEUE", "IN_PROGRESS", "COMPLETED"].includes(s.status)) throw new Error("Unexpected video status");
          await this.env.DB.prepare("UPDATE jobs SET video_meta=json_set(video_meta,'$.phase',?) WHERE id=?")
            .bind(s.status === "IN_QUEUE" ? "queued" : s.status === "IN_PROGRESS" ? "processing" : "saving", id).run();
          return s.status as string;
        });
        if (status === "COMPLETED") { completed = true; break; }
        if (status === "UNKNOWN") {
          // About 15 minutes without an answer: give up (the timeout log below asks for a manual review).
          if (++unknown >= 45) { console.error("Video status unavailable; review for manual pickup", { jobId: id, provider: ticket.provider, requestId: ticket.request_id }); throw new VideoFailure("STATUS", "CAPACITY"); }
        } else unknown = 0;
        await step.sleep(`video-wait-${i}`, i < FAST_POLLS ? "20 seconds" : "5 minutes");
      }
      if (!completed) {
        // Only fal can be cancelled below; other providers may still finish and bill. Log the ticket for review.
        if (ticket.provider === "heygen" || ticket.provider === "wavespeed")
          console.error("Video provider still running after timeout; review for manual pickup", { jobId: id, provider: ticket.provider, requestId: ticket.request_id });
        throw new VideoFailure("STATUS", "TIMEOUT");
      }
      stage = "SAVE";
      await step.do("save-video", { retries: { limit: 2, delay: "15 seconds" }, timeout: "5 minutes" }, async () => {
        const key = `audio/${job.user_id}/${id}.mp4`;
        if (!(await this.env.AUDIO.head(key))) {
          const result = await getVideo(this.env, ticket!, "RESULT");
          if (result.moderation_flagged) throw new VideoFailure("RESULT", "CONTENT");
          if (result.moderation_error || !result.video?.url) throw new VideoFailure("RESULT", "PROVIDER");
          await storeVideo(this.env, key, result.video.url);
        }
        await finishJobStorage(this.env,id,key,job.duration);
        await this.env.DB.prepare("UPDATE jobs SET status='completed',video_key=?,updated_at=? WHERE id=? AND status IN ('queued','running')").bind(key, now(), id).run();
      });
      stage = "CLEANUP";
      if (ticket?.provider === "heygen") { const t = ticket; await step.do("forget-heygen-video", () => forgetHeyGenVideo(this.env, id, t.request_id)); }
      await step.do("clean-video-input", async () => {
        const meta: VideoMeta = JSON.parse(job.video_meta);
        if (meta.imageKey) await this.env.AUDIO.delete(meta.imageKey);
      });
    } catch (e) {
      // Do not expose provider payloads, input URLs, or credentials in user-visible errors.
      const failure = videoFailureMessage(e, stage);
      console.error("Video workflow failed", { jobId: id, stage, code: failure.code });
      await step.do("refund-video", async () => {
        await this.env.DB.prepare("INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) SELECT 'segments/'||user_id||'/'||id||'/',? FROM jobs WHERE id=?").bind(now(), id).run();
        await failVideo(this.env, id, failure.message);
      });
      if (ticket?.provider === "heygen") { const t = ticket; await step.do("forget-failed-heygen-video", () => forgetHeyGenVideo(this.env, id, t.request_id)).catch(() => {}); }
      if (ticket?.cancel_url && (ticket.provider == null || ticket.provider === "fal")) {
        try { await videoFetch(queueUrl(ticket.cancel_url), { method: "PUT", headers: { Authorization: `Key ${this.env.FAL_KEY?.trim()}` }, signal: AbortSignal.timeout(15000) }); } catch { /* Best effort cancellation; never resubmit. */ }
      }
      throw new Error(failure.code);
    } finally {
      try {
        await step.do("notify-video", { retries: { limit: 2, delay: "1 minute" }, timeout: "1 minute" }, () => notifyVideo(this.env, id));
      } catch { console.error("Video notification requires reconciliation", { jobId: id }); }
      try {
        await step.do("clean-photo-avatar", { retries: { limit: 2, delay: "1 minute" }, timeout: "1 minute" }, () => cleanupHeyGenAvatars(this.env, id));
      } catch { console.error("Temporary video avatar cleanup requires reconciliation", { jobId: id }); }
    }
  }
}
