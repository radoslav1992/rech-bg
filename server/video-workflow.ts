import { finishJobStorage } from './media-storage';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./types";
import { now } from "./types";
import { withDefaults } from "./config";
import { avatarMap, failVideo, videoModels, jobVideoTier, type VideoMeta } from "./video";
import { submitWaveVideo, getWaveVideo, type WaveTicket } from "./video-wavespeed";
import { providerFailure, VideoFailure, videoFailureMessage, type VideoStage } from "./video-errors";
import { videoFetch } from "./video-http";
import { notifyVideo } from "./video-notifications";

type Ticket = { provider?: "fal" | "wavespeed"; request_id: string; status_url: string; response_url: string; cancel_url?: string };
export function queueUrl(value: string) {
  const url = new URL(value);
  if (url.origin !== "https://queue.fal.run" || url.username || url.password || !url.pathname.includes("/requests/")) throw new Error("Invalid queue URL");
  return url.href;
}
export function outputUrl(value: string) {
  const url = new URL(value);
  const allowed = ["fal.media", "falserverless.io", "amazonaws.com", "storage.googleapis.com", "wavespeed.ai", "cloudfront.net"];
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !allowed.some(h => url.hostname === h || url.hostname.endsWith("." + h)))
    throw new Error("Invalid video host");
  return url.href;
}
async function queueGet(env: Env, url: string, stage: VideoStage) {
  const r = await videoFetch(queueUrl(url), { headers: { Authorization: `Key ${env.FAL_KEY?.trim()}` }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw await providerFailure(r, stage);
  return r.json() as Promise<any>;
}
// Multipart upload bounds memory and accepts CDN responses without Content-Length.
export async function storeVideo(env: Env, key: string, url: string) {
  const r = await videoFetch(outputUrl(url), { signal: AbortSignal.timeout(240000) });
  if (!r.ok || !r.body) throw new VideoFailure("DOWNLOAD", "MEDIA", r.status);
  const limit = 100 * 1024 * 1024;
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
export class VideoGeneration extends WorkflowEntrypoint<Env, { jobId: string }> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep) {
    const id = event.payload.jobId;
    let ticket: Ticket | undefined;
    let stage: VideoStage = "LOAD";
    try {
      const job = await step.do("load-video", async () => {
        const row = await this.env.DB.prepare("SELECT * FROM jobs WHERE id=? AND kind='video'").bind(id).first<any>();
        if (!row || !["queued", "running"].includes(row.status)) throw new Error("Video unavailable");
        await this.env.DB.prepare("UPDATE jobs SET status='running',updated_at=? WHERE id=?").bind(now(), id).run();
        return row;
      });
      stage = "SUBMIT";
      ticket = await step.do("submit-video-once", { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" }, async () => {
        const row = await this.env.DB.prepare("SELECT provider_request,submitted_at FROM jobs WHERE id=?").bind(id).first<any>();
        if (row?.provider_request) return JSON.parse(row.provider_request) as Ticket;
        const tier = jobVideoTier(job);
        if (!(tier === "low" ? this.env.WAVESPEED_API_KEY?.trim() : this.env.FAL_KEY?.trim())) throw new VideoFailure("SUBMIT", "AUTH");
        const meta: VideoMeta = JSON.parse(job.video_meta);
        const source = await this.env.DB.prepare("SELECT audio_key FROM jobs WHERE id=? AND user_id=? AND status='completed'").bind(job.source_job_id, job.user_id).first<any>();
        if (!source?.audio_key || !(await this.env.AUDIO.head(source.audio_key))) throw new Error("Missing audio");
        if (tier !== "standard" && (!meta.imageKey || !(await this.env.AUDIO.head(meta.imageKey)))) throw new Error("Missing portrait");
        const base = `${withDefaults(this.env).SITE_URL!.replace(/\/$/, "")}/api/video-inputs/${id}`;
        const audio_url = `${base}/audio?token=${meta.token}`;
        const input = tier === "standard"
          ? { avatar: avatarMap[meta.avatar], audio_url, remove_background: false }
          : { image_url: `${base}/image?token=${meta.token}`, audio_url, prompt: "A person speaking naturally to the camera. Subtle facial expressions and head movements." };
        // Never repeat an ambiguous external submission: it may already be billable.
        const claim = await this.env.DB.prepare("UPDATE jobs SET submitted_at=? WHERE id=? AND submitted_at IS NULL").bind(now(), id).run();
        if (!claim.meta.changes) throw new Error("Submission requires reconciliation");
        if (tier === "low") {
          const t = await submitWaveVideo(this.env, `${base}/image?token=${meta.token}`, audio_url);
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
        await this.env.DB.prepare("UPDATE jobs SET provider_request=?,updated_at=? WHERE id=?").bind(JSON.stringify(t), now(), id).run();
        return t;
      });
      let completed = false;
      stage = "STATUS";
      for (let i = 0; i < 180; i++) {
        const status = await step.do(`video-status-${i}`, { retries: { limit: 2, delay: "10 seconds" }, timeout: "2 minutes" }, async () => {
          const s = ticket!.provider === "wavespeed" ? await getWaveVideo(this.env, ticket! as WaveTicket) : await queueGet(this.env, ticket!.status_url, "STATUS");
          await this.env.DB.prepare("UPDATE jobs SET updated_at=? WHERE id=?").bind(now(), id).run();
          if (!["IN_QUEUE", "IN_PROGRESS", "COMPLETED"].includes(s.status)) throw new Error("Unexpected video status");
          await this.env.DB.prepare("UPDATE jobs SET video_meta=json_set(video_meta,'$.phase',?) WHERE id=?")
            .bind(s.status === "IN_QUEUE" ? "queued" : s.status === "IN_PROGRESS" ? "processing" : "saving", id).run();
          return s.status as string;
        });
        if (status === "COMPLETED") { completed = true; break; }
        await step.sleep(`video-wait-${i}`, "20 seconds");
      }
      if (!completed) throw new VideoFailure("STATUS", "TIMEOUT");
      stage = "SAVE";
      await step.do("save-video", { retries: { limit: 2, delay: "15 seconds" }, timeout: "5 minutes" }, async () => {
        const key = `audio/${job.user_id}/${id}.mp4`;
        if (!(await this.env.AUDIO.head(key))) {
          const result = ticket!.provider === "wavespeed" ? await getWaveVideo(this.env, ticket! as WaveTicket) : await queueGet(this.env, ticket!.response_url, "RESULT");
          if (result.moderation_flagged) throw new VideoFailure("RESULT", "CONTENT");
          if (result.moderation_error || !result.video?.url) throw new VideoFailure("RESULT", "PROVIDER");
          await storeVideo(this.env, key, result.video.url);
        }
        await finishJobStorage(this.env,id,key,job.duration);
        await this.env.DB.prepare("UPDATE jobs SET status='completed',video_key=?,updated_at=? WHERE id=? AND status IN ('queued','running')").bind(key, now(), id).run();
      });
      stage = "CLEANUP";
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
      if (ticket?.cancel_url && ticket.provider !== "wavespeed") {
        try { await videoFetch(queueUrl(ticket.cancel_url), { method: "PUT", headers: { Authorization: `Key ${this.env.FAL_KEY?.trim()}` }, signal: AbortSignal.timeout(15000) }); } catch { /* Best effort cancellation; never resubmit. */ }
      }
      throw new Error(failure.code);
    } finally {
      try {
        await step.do("notify-video", { retries: { limit: 2, delay: "1 minute" }, timeout: "1 minute" }, () => notifyVideo(this.env, id));
      } catch { console.error("Video notification requires reconciliation", { jobId: id }); }
    }
  }
}
