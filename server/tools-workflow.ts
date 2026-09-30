import type { WorkflowStep } from "cloudflare:workers";
import type { Env } from "./types";
import { now } from "./types";
import { withDefaults } from "./config";
import { failTool } from "./ai-tools";
import { getHeyGenTranslation, submitHeyGenTranslation, type HeyGenTranslationTicket } from "./video-heygen";
import { VideoFailure, videoFailureMessage, type VideoStage } from "./video-errors";
import { storeVideo, transientStatusError } from "./video-workflow";

const FAST_POLLS = 180, SLOW_POLLS = 72;
const HEYGEN_IDEMPOTENCY_WINDOW = 20 * 3600;
const toolMessage = (e: unknown, stage: VideoStage) =>
  videoFailureMessage(e, stage).message.replace("Кредитите за видеото са върнати. Аудиозаписът остава наличен.", "Кредитите са върнати.");

/** Dubbing: submit once, follow the provider (through outages), save the result to the media library. */
export async function runToolTask(env: Env, id: string, step: WorkflowStep) {
  let stage: VideoStage = "LOAD";
  try {
    const task = await step.do("load-tool", async () => {
      const row = await env.DB.prepare("SELECT * FROM ai_tasks WHERE id=?").bind(id).first<any>();
      if (!row || !["queued", "running"].includes(row.status)) throw new Error("Task unavailable");
      const started = await env.DB.prepare("UPDATE ai_tasks SET status='running',updated_at=? WHERE id=? AND status IN ('queued','running')").bind(now(), id).run();
      if (!started.meta.changes) throw new Error("Task unavailable");
      return row;
    });
    const params = JSON.parse(task.params);
    stage = "SUBMIT";
    const ticket = await step.do("submit-tool-once", { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" }, async () => {
      const row = await env.DB.prepare("SELECT provider_request,submitted_at,status FROM ai_tasks WHERE id=?").bind(id).first<any>();
      if (row?.provider_request) return JSON.parse(row.provider_request) as HeyGenTranslationTicket;
      if (!env.HEYGEN_API_KEY?.trim()) throw new VideoFailure("SUBMIT", "AUTH");
      // Never repeat a paid submission blindly; HeyGen returns the original for the same Idempotency-Key.
      const claim = await env.DB.prepare("UPDATE ai_tasks SET submitted_at=?,phase='queued',updated_at=? WHERE id=? AND submitted_at IS NULL").bind(now(), now(), id).run();
      if (!claim.meta.changes && !(row?.submitted_at > now() - HEYGEN_IDEMPOTENCY_WINDOW)) throw new Error("Submission requires reconciliation");
      const base = withDefaults(env).SITE_URL!.replace(/\/$/, "");
      const t = await submitHeyGenTranslation(env, id, `${base}/api/tool-inputs/${id}?token=${task.token}`, params.language,
        params.mode === "precision" ? "precision" : "speed", params.mode === "audio");
      await env.DB.prepare("UPDATE ai_tasks SET provider_request=?,updated_at=? WHERE id=?").bind(JSON.stringify(t), now(), id).run();
      return t;
    });
    stage = "STATUS";
    let url = "", unknown = 0;
    for (let i = 0; i < FAST_POLLS + SLOW_POLLS && !url; i++) {
      const result = await step.do(`tool-status-${i}`, { retries: { limit: 2, delay: "10 seconds" }, timeout: "2 minutes" }, async () => {
        let s;
        try { s = await getHeyGenTranslation(env, ticket, "STATUS"); }
        catch (e) { if (transientStatusError(e)) return { status: "UNKNOWN", url: "" }; throw e; }
        await env.DB.prepare("UPDATE ai_tasks SET phase=?,updated_at=? WHERE id=?")
          .bind(s.status === "IN_QUEUE" ? "queued" : s.status === "IN_PROGRESS" ? "processing" : "saving", now(), id).run();
        return { status: s.status as string, url: s.status === "COMPLETED" ? s.url : "" };
      });
      if (result.status === "COMPLETED") { url = result.url; break; }
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
        env.DB.prepare("UPDATE media_assets SET status='ready',bytes=?,duration=? WHERE id=? AND user_id=?").bind(stored.size, params.duration || 0, task.output_asset_id, task.user_id),
        env.DB.prepare("UPDATE ai_tasks SET status='completed',phase='completed',updated_at=? WHERE id=? AND status IN ('queued','running')").bind(now(), id),
      ]);
    });
  } catch (e) {
    const failure = videoFailureMessage(e, stage);
    console.error("Tool task failed", { taskId: id, stage, code: failure.code });
    await step.do("refund-tool", () => failTool(env, id, toolMessage(e, stage)));
    throw new Error(failure.code);
  }
}
