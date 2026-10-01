import type { WorkflowStep } from "cloudflare:workers";
import type { Env } from "./types";
import { now } from "./types";
import { withDefaults } from "./config";
import { failTool, toolFiles, toolSpeechKey } from "./ai-tools";
import {
  deleteHeyGenFile, getHeyGenLipsync, getHeyGenTranslation, queueHeyGenFile, submitHeyGenLipsync, submitHeyGenTranslation,
  type HeyGenLipsyncTicket, type HeyGenTranslationTicket,
} from "./video-heygen";
import { rendererFor } from "./media-workflow";
import { speakRevoice } from "./revoice-speech";
import { CLONE_VOICE } from "../shared/tools";
import { VideoFailure, videoFailureMessage, type VideoStage } from "./video-errors";
import { storeVideo, transientStatusError } from "./video-workflow";

const FAST_POLLS = 180, SLOW_POLLS = 72;
const HEYGEN_IDEMPOTENCY_WINDOW = 20 * 3600;
const toolMessage = (e: unknown, stage: VideoStage) =>
  videoFailureMessage(e, stage).message.replace("Кредитите за видеото са върнати. Аудиозаписът остава наличен.", "Кредитите са върнати.");

type Ticket = HeyGenTranslationTicket | HeyGenLipsyncTicket;
const noRetry = { retries: { limit: 0, delay: "1 second" as const }, timeout: "10 minutes" as const };

/** A voice sample cut from the source video by the renderer (for cloning the speaker's voice). */
async function voiceSample(env: Env, id: string, userId: string, input: string, step: WorkflowStep) {
  const key = `${toolFiles(userId, id)}sample.mp3`;
  const renderer = () => rendererFor(env, id);
  for (let i = 0; i < 40; i++) {
    const done = await step.do(`voice-sample-${i}`, { retries: { limit: 2, delay: "10 seconds" }, timeout: "2 minutes" }, async () => {
      if (await env.AUDIO.head(key)) return true;
      const r = await renderer().fetch("http://renderer/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, operation: "sample", url: input }) });
      if (r.status === 429) return false;
      if (!r.ok) throw new Error("RENDERER_UNAVAILABLE");
      const s = await (await renderer().fetch(`http://renderer/jobs/${id}`)).json() as { status: string };
      if (s.status === "failed") throw new VideoFailure("SUBMIT", "MEDIA");
      if (s.status !== "completed") return false;
      const file = await renderer().fetch(`http://renderer/jobs/${id}/file`);
      if (!file.ok) throw new Error("RENDERER_UNAVAILABLE");
      await env.AUDIO.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: "audio/mpeg" } });
      await renderer().fetch(`http://renderer/jobs/${id}`, { method: "DELETE" }).catch(() => {});
      return true;
    });
    if (done) return key;
    await step.sleep(`voice-sample-wait-${i}`, "10 seconds");
  }
  throw new VideoFailure("SUBMIT", "TIMEOUT");
}

/**
 * Dubbing and re-voicing: (re-voicing first makes the new speech), submit once, follow the provider through
 * outages, save the result to the media library, then delete the provider's copy and the working files.
 */
export async function runToolTask(env: Env, id: string, step: WorkflowStep) {
  let stage: VideoStage = "LOAD";
  let submitted: Ticket | null = null;
  try {
    const task = await step.do("load-tool", async () => {
      const row = await env.DB.prepare("SELECT * FROM ai_tasks WHERE id=?").bind(id).first<any>();
      if (!row || !["queued", "running"].includes(row.status)) throw new Error("Task unavailable");
      const started = await env.DB.prepare("UPDATE ai_tasks SET status='running',updated_at=? WHERE id=? AND status IN ('queued','running')").bind(now(), id).run();
      if (!started.meta.changes) throw new Error("Task unavailable");
      return row;
    });
    const params = JSON.parse(task.params);
    const base = withDefaults(env).SITE_URL!.replace(/\/$/, "");
    const input = `${base}/api/tool-inputs/${id}?token=${task.token}`;
    stage = "SUBMIT";
    if (task.kind === "lipsync") {
      await step.do("phase-voice", async () => {
        await env.DB.prepare("UPDATE ai_tasks SET phase='voice',updated_at=? WHERE id=?").bind(now(), id).run();
      });
      const sample = params.voice === CLONE_VOICE && !(await step.do("speech-exists", async () => !!(await env.AUDIO.head(toolSpeechKey(task.user_id, id)))))
        ? await voiceSample(env, id, task.user_id, input, step) : null;
      // Paid once: a failure here fails (and refunds) the task rather than repeating the purchase.
      await step.do("speech-once", noRetry, async () => {
        const key = toolSpeechKey(task.user_id, id);
        if (await env.AUDIO.head(key)) return;
        const stored = sample ? await env.AUDIO.get(sample) : null;
        if (sample && !stored) throw new VideoFailure("SUBMIT", "MEDIA");
        const audio = await speakRevoice(env, { taskId: id, voice: params.voice, text: params.text, sample: stored ? await stored.arrayBuffer() : undefined });
        await env.AUDIO.put(key, audio, { httpMetadata: { contentType: "audio/mpeg" } });
      });
    }
    const ticket = await step.do("submit-tool-once", { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" }, async () => {
      const row = await env.DB.prepare("SELECT provider_request,submitted_at,status FROM ai_tasks WHERE id=?").bind(id).first<any>();
      if (row?.provider_request) return JSON.parse(row.provider_request) as Ticket;
      if (!env.HEYGEN_API_KEY?.trim()) throw new VideoFailure("SUBMIT", "AUTH");
      // Never repeat a paid submission blindly; HeyGen returns the original for the same Idempotency-Key.
      const claim = await env.DB.prepare("UPDATE ai_tasks SET submitted_at=?,phase='queued',updated_at=? WHERE id=? AND submitted_at IS NULL").bind(now(), now(), id).run();
      if (!claim.meta.changes && !(row?.submitted_at > now() - HEYGEN_IDEMPOTENCY_WINDOW)) throw new Error("Submission requires reconciliation");
      const mode = params.mode === "precision" ? "precision" : "speed";
      const t: Ticket = task.kind === "lipsync"
        ? await submitHeyGenLipsync(env, id, input, `${base}/api/tool-inputs/${id}/speech?token=${task.token}`, mode)
        : await submitHeyGenTranslation(env, id, input, params.language, mode, params.mode === "audio");
      await env.DB.prepare("UPDATE ai_tasks SET provider_request=?,updated_at=? WHERE id=?").bind(JSON.stringify(t), now(), id).run();
      return t;
    });
    submitted = ticket;
    stage = "STATUS";
    let url = "", unknown = 0, duration = 0;
    for (let i = 0; i < FAST_POLLS + SLOW_POLLS && !url; i++) {
      const result = await step.do(`tool-status-${i}`, { retries: { limit: 2, delay: "10 seconds" }, timeout: "2 minutes" }, async () => {
        let s;
        try { s = ticket.kind === "lipsync" ? await getHeyGenLipsync(env, ticket, "STATUS") : await getHeyGenTranslation(env, ticket, "STATUS"); }
        catch (e) { if (transientStatusError(e)) return { status: "UNKNOWN", url: "", duration: 0 }; throw e; }
        await env.DB.prepare("UPDATE ai_tasks SET phase=?,updated_at=? WHERE id=?")
          .bind(s.status === "IN_QUEUE" ? "queued" : s.status === "IN_PROGRESS" ? "processing" : "saving", now(), id).run();
        return { status: s.status as string, url: s.status === "COMPLETED" ? s.url : "", duration: s.status === "COMPLETED" && "duration" in s ? Number(s.duration) || 0 : 0 };
      });
      if (result.status === "COMPLETED") { url = result.url; duration = result.duration; break; }
      if (result.status === "UNKNOWN") { if (++unknown >= 45) throw new VideoFailure("STATUS", "CAPACITY"); }
      else unknown = 0;
      await step.sleep(`tool-wait-${i}`, i < FAST_POLLS ? "20 seconds" : "5 minutes");
    }
    if (!url) {
      console.error("Tool provider still running after timeout; review for manual pickup", { taskId: id, requestId: ticket.request_id });
      throw new VideoFailure("STATUS", "TIMEOUT");
    }
    stage = "SAVE";
    await step.do("save-tool", { retries: { limit: 2, delay: "15 seconds" }, timeout: "10 minutes" }, async () => {
      const key = `media/${task.user_id}/${task.output_asset_id}/result`;
      if (!(await env.AUDIO.head(key))) await storeVideo(env, key, url, 1024 * 1024 * 1024);
      const stored = await env.AUDIO.head(key);
      if (!stored) throw new VideoFailure("SAVE", "MEDIA");
      await env.DB.batch([
        // A re-voiced video follows the new speech's length (the provider reports it).
        env.DB.prepare("UPDATE media_assets SET status='ready',bytes=?,duration=? WHERE id=? AND user_id=?").bind(stored.size, duration || params.duration || 0, task.output_asset_id, task.user_id),
        env.DB.prepare("UPDATE ai_tasks SET status='completed',phase='completed',updated_at=? WHERE id=? AND status IN ('queued','running')").bind(now(), id),
      ]);
    });
    await step.do("forget-provider-copy", () => forget(env, id, task.user_id, ticket));
  } catch (e) {
    const failure = videoFailureMessage(e, stage);
    console.error("Tool task failed", { taskId: id, stage, code: failure.code });
    await step.do("refund-tool", () => failTool(env, id, toolMessage(e, stage)));
    if (submitted) { const t = submitted; await step.do("forget-failed-copy", () => forget(env, id, null, t)).catch(() => {}); }
    throw new Error(failure.code);
  }
}
/** The provider's copy is deleted (or queued for maintenance); working files are removed by the cleanup run. */
async function forget(env: Env, id: string, userId: string | null, ticket: Ticket) {
  const kind = ticket.kind === "lipsync" ? "lipsync" : "translation";
  await queueHeyGenFile(env, kind, ticket.request_id);
  if (userId) await env.DB.prepare("INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES (?,?)").bind(toolFiles(userId, id), now()).run();
  try {
    await deleteHeyGenFile(env, kind, ticket.request_id);
    await env.DB.prepare("DELETE FROM cleanup_tasks WHERE prefix=?").bind(`heygen-file/${kind}/${ticket.request_id}`).run();
  } catch { console.error("HeyGen copy cleanup will retry", { taskId: id }); }
}
