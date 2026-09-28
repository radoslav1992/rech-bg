import type { Env } from "./types";
import { now, MINUTE, DAY } from "./types";
import { notifyVideo } from "./video-notifications";
import { cleanupHeyGenAvatars } from "./video-heygen-avatar";
import { maintainMedia } from "./media-maintenance";

async function deletePrefix(e: Env, prefix: string) {
  let cursor: string | undefined;
  do {
    const list = await e.AUDIO.list({ prefix, cursor });
    if (list.objects.length)
      await e.AUDIO.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}
export async function drainCleanup(e: Env) {
  const tasks = (
    await e.DB.prepare(
      "SELECT prefix FROM cleanup_tasks WHERE prefix NOT LIKE 'heygen-avatar/%' ORDER BY created_at LIMIT 100",
    ).all<{ prefix: string }>()
  ).results;
  for (const task of tasks) {
    try {
      await deletePrefix(e, task.prefix);
      await e.DB.prepare("DELETE FROM cleanup_tasks WHERE prefix=?")
        .bind(task.prefix)
        .run();
    } catch {
      console.error("Storage cleanup will retry");
    }
  }
}
/** Runs one maintenance stage so a failure in it cannot skip the others. */
async function stage(name: string, work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    console.error("Maintenance stage failed", { stage: name, error: (error as Error)?.name });
  }
}
export async function maintenance(e: Env) {
  if (e.MEDIA_ENABLED === "true") await stage("media", () => maintainMedia(e));
  await stage("cleanup", () => drainCleanup(e));
  await stage("expiry", () =>
    e.DB.batch([
      e.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(now()),
      e.DB.prepare("DELETE FROM auth_tokens WHERE expires_at<?").bind(now()),
      e.DB.prepare("DELETE FROM rate_limits WHERE expires_at<?").bind(now()),
      e.DB.prepare("DELETE FROM contact_messages WHERE created_at<?").bind(
        now() - 365 * DAY,
      ),
      e.DB.prepare("DELETE FROM users WHERE verified=0 AND created_at<?").bind(
        now() - 7 * DAY,
      ),
    ]),
  );
  await stage("jobs", () => reconcileJobs(e));
  await stage("segments", async () => {
    // Backstop for segment cleanup: each finished job is swept once, oldest first.
    const old = (
      await e.DB.prepare(
        "SELECT id,user_id FROM jobs WHERE status IN ('failed','completed') AND updated_at<? AND NOT EXISTS(SELECT 1 FROM segment_sweeps WHERE job_id=jobs.id) ORDER BY updated_at LIMIT 100",
      )
        .bind(now() - DAY)
        .all<any>()
    ).results;
    for (const j of old) {
      await deletePrefix(e, `segments/${j.user_id}/${j.id}/`);
      await e.DB.prepare("INSERT OR IGNORE INTO segment_sweeps(job_id) VALUES (?)").bind(j.id).run();
    }
  });
  await stage("notifications", async () => {
    // Read only matching metadata, keeping this compatible with audio-only rows.
    const notifications = (await e.DB.prepare("SELECT id FROM jobs WHERE kind='video' AND status IN ('completed','failed') AND json_extract(video_meta,'$.notifyEmail')=1 AND json_extract(video_meta,'$.emailStatus') IS NULL ORDER BY created_at DESC LIMIT 50").all<{ id: string }>()).results;
    for (const j of notifications) {
      try { await notifyVideo(e, j.id); }
      catch { console.error("Video notification reconciliation failed", { jobId: j.id }); }
    }
  });
  await stage("heygen", () => cleanupHeyGenAvatars(e));
}
async function reconcileJobs(e: Env) {
  const jobs = (
    await e.DB.prepare(
      "SELECT * FROM jobs WHERE status IN ('queued','running') AND updated_at<? LIMIT 100",
    )
      .bind(now() - 10 * MINUTE)
      .all<any>()
  ).results;
  for (const j of jobs) {
    const workflow = j.kind === "video" ? e.VIDEO_GENERATION : e.GENERATION;
    if (!workflow) continue;
    try {
      const instance = await workflow.get(j.id);
      const status = await instance.status();
      if (["errored", "terminated"].includes(status.status)) {
        await e.DB.prepare(
          "UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status IN ('queued','running')",
        )
          .bind(
            "Генерацията беше прекъсната. Кредитите са върнати.",
            now(),
            j.id,
          )
          .run();
      }
    } catch {
      if (j.status === "queued") {
        try {
          await workflow.create({ id: j.id, params: { jobId: j.id } });
        } catch {
          console.error("Workflow reconciliation pending", { jobId: j.id });
        }
      }
    }
  }
}
