import type { Env } from "./types";
import { now } from "./types";
import { mediaAllowance } from "./media";
import { failMedia } from "./media-workflow";
export async function maintainMedia(e: Env) {
  // Index pre-upgrade recordings without retroactively expiring them. Already indexed/deleted files never reappear.
  const legacy = (
    await e.DB.prepare(
      "SELECT * FROM jobs WHERE status='completed' AND NOT EXISTS(SELECT 1 FROM media_job_history WHERE job_id=jobs.id) LIMIT 100",
    ).all<any>()
  ).results;
  for (const j of legacy) {
    const key = j.kind === "video" ? j.video_key : j.audio_key,
      obj = key ? await e.AUDIO.head(key) : null;
    if (obj) {
      const user = await e.DB.prepare("SELECT * FROM users WHERE id=?")
        .bind(j.user_id)
        .first<any>();
      if (!user) continue;
      const plan = await mediaAllowance(e, user);
      // Existing files are counted even if they put an account over quota; no data is silently discarded.
      await e.DB.batch([
        e.DB.prepare(
          "UPDATE media_limits SET max_bytes=MAX(max_bytes,?+COALESCE((SELECT SUM(bytes) FROM media_assets WHERE user_id=?),0)) WHERE user_id=?",
        ).bind(obj.size, j.user_id, j.user_id),
        e.DB.prepare(
          "INSERT INTO media_assets(id,user_id,object_key,name,kind,mime,bytes,status,duration,job_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,'ready',?,?,?,?)",
        ).bind(
          j.id,
          j.user_id,
          key,
          j.title,
          j.kind === "video" ? "video" : "audio",
          j.kind === "video" ? "video/mp4" : "audio/wav",
          obj.size,
          j.duration,
          j.id,
          j.created_at,
          now() + plan.days * 86400,
        ),
        e.DB.prepare(
          "UPDATE media_limits SET max_bytes=? WHERE user_id=?",
        ).bind(plan.bytes, j.user_id),
      ]);
    } else
      await e.DB.prepare(
        "INSERT OR IGNORE INTO media_job_history(job_id) VALUES(?)",
      )
        .bind(j.id)
        .run();
  }
  const tasks = (
    await e.DB.prepare(
      "SELECT * FROM media_tasks WHERE status IN ('queued','running') AND updated_at<? LIMIT 100",
    )
      .bind(now() - 300)
      .all<any>()
  ).results;
  for (const task of tasks) {
    try {
      const instance = await e.MEDIA_GENERATION!.get(task.id),
        status = await instance.status();
      if (["errored", "terminated"].includes(status.status))
        await failMedia(e, task.id);
      else if (task.created_at < now() - 7200) {
        await instance.terminate();
        await failMedia(e, task.id);
      }
    } catch {
      if (task.status === "queued") {
        try {
          await e.MEDIA_GENERATION!.create({
            id: task.id,
            params: { taskId: task.id },
          });
        } catch {
          console.error("Media reconciliation pending", { taskId: task.id });
        }
      }
    }
  }
  // Extend saved library assets only while a subscription is active; cancellation leaves a 30-day download window.
  await e.DB.prepare(
    "UPDATE media_assets SET expires_at=MAX(expires_at,COALESCE((SELECT MAX(period_end)+2592000 FROM subscriptions WHERE user_id=media_assets.user_id AND status IN ('active','trialing') AND period_end>?),expires_at)) WHERE saved=1",
  )
    .bind(now())
    .run();
  await e.DB.prepare(
    "UPDATE media_assets SET status='deleting',expires_at=? WHERE job_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM jobs WHERE id=job_id) OR EXISTS(SELECT 1 FROM jobs WHERE id=job_id AND status='failed'))",
  )
    .bind(now())
    .run();
  const assets = (
    await e.DB.prepare(
      "SELECT * FROM media_assets WHERE expires_at<=? AND NOT EXISTS(SELECT 1 FROM media_tasks WHERE user_id=media_assets.user_id AND status IN ('queued','running')) AND NOT EXISTS(SELECT 1 FROM jobs WHERE user_id=media_assets.user_id AND status IN ('queued','running')) ORDER BY expires_at LIMIT 100",
    )
      .bind(now())
      .all<any>()
  ).results;
  for (const a of assets) {
    const claimed = await e.DB.prepare(
      "UPDATE media_assets SET status='deleting' WHERE id=? AND expires_at<=? AND NOT EXISTS(SELECT 1 FROM media_tasks WHERE user_id=? AND status IN ('queued','running')) AND NOT EXISTS(SELECT 1 FROM jobs WHERE user_id=? AND status IN ('queued','running'))",
    )
      .bind(a.id, now(), a.user_id, a.user_id)
      .run();
    if (!claimed.meta.changes) continue;
    if (a.upload_id) {
      try {
        await e.AUDIO.resumeMultipartUpload(a.object_key, a.upload_id).abort();
      } catch {
        /* Already complete. */
      }
    }
    await e.AUDIO.delete(a.object_key);
    if (a.kind === "audio")
      await e.AUDIO.delete(`audio/${a.user_id}/${a.job_id}.captions.json`);
    await e.DB.prepare("DELETE FROM media_assets WHERE id=?").bind(a.id).run();
  }
  // Remove provider capabilities and request snapshots after 30 days; keep billing receipts so included exports cannot be claimed twice.
  await e.DB.prepare(
    "UPDATE media_tasks SET payload='{}',provider=NULL,token='' WHERE status IN ('failed','completed') AND updated_at<? AND payload<>'{}'",
  )
    .bind(now() - 30 * 86400)
    .run();
  await e.DB.prepare(
    "DELETE FROM media_parts WHERE asset_id IN (SELECT id FROM media_assets WHERE status='ready')",
  ).run();
}
