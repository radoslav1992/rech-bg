import type { Env } from "./types";
import { now } from "./types";
import { withDefaults } from "./config";
import { VideoFailure } from "./video-errors";
import { createHeyGenAvatar, deleteHeyGenAvatar, type HeyGenAvatar } from "./video-heygen";

// A separate claim/checkpoint keeps avatar creation out of the paid-video step.
export async function prepareHeyGenAvatar(env: Env, id: string): Promise<HeyGenAvatar | null> {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=? AND kind='video'").bind(id).first<any>();
  if (!job || !["queued", "running"].includes(job.status)) throw new VideoFailure("SUBMIT", "INTERNAL");
  // A saved/ambiguous video submission must never create a second avatar.
  if (job.provider_request || job.submitted_at != null) return null;
  const meta = JSON.parse(job.video_meta);
  if (meta.heygenAvatar) return meta.heygenAvatar as HeyGenAvatar;
  if (!env.HEYGEN_API_KEY?.trim()) throw new VideoFailure("SUBMIT", "AUTH");
  const source = await env.DB.prepare("SELECT audio_key FROM jobs WHERE id=? AND user_id=? AND status='completed'")
    .bind(job.source_job_id, job.user_id).first<any>();
  if (!source?.audio_key || !(await env.AUDIO.head(source.audio_key)) || !meta.imageKey || !(await env.AUDIO.head(meta.imageKey)))
    throw new VideoFailure("SUBMIT", "MEDIA");
  const claim = await env.DB.prepare("UPDATE jobs SET video_meta=json_set(video_meta,'$.avatarSubmittedAt',?,'$.phase','preparing'),updated_at=? WHERE id=? AND status IN ('queued','running') AND json_extract(video_meta,'$.avatarSubmittedAt') IS NULL")
    .bind(now(), now(), id).run();
  if (!claim.meta.changes) throw new VideoFailure("SUBMIT", "INTERNAL");
  const base = withDefaults(env).SITE_URL!.replace(/\/$/, "");
  const avatar = await createHeyGenAvatar(env, id, `${base}/api/video-inputs/${id}/image?token=${meta.token}`);
  // This queue survives project/account deletion. Only groups created here enter it.
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES (?,?)")
      .bind(`heygen-avatar/${id}/${avatar.groupId}`, now()),
    env.DB.prepare("UPDATE jobs SET video_meta=json_set(video_meta,'$.heygenAvatar',json(?)),updated_at=? WHERE id=?")
      .bind(JSON.stringify(avatar), now(), id),
  ]);
  return avatar;
}

export async function cleanupHeyGenAvatars(env: Env, jobId?: string) {
  if (!env.HEYGEN_API_KEY?.trim()) return;
  const tasks = (await env.DB.prepare("SELECT prefix FROM cleanup_tasks WHERE prefix LIKE ? ORDER BY created_at LIMIT 20")
    .bind(jobId ? `heygen-avatar/${jobId}/%` : "heygen-avatar/%").all<{ prefix: string }>()).results;
  for (const task of tasks) {
    const match = /^heygen-avatar\/([a-zA-Z0-9_-]{1,160})\/([a-zA-Z0-9_-]{1,160})$/.exec(task.prefix);
    if (!match) continue;
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id=?").bind(match[1]).first<{ status: string }>();
    if (job && !["failed", "completed"].includes(job.status)) continue;
    try {
      await deleteHeyGenAvatar(env, match[2]);
      await env.DB.prepare("DELETE FROM cleanup_tasks WHERE prefix=?").bind(task.prefix).run();
    } catch {
      // Cleanup must not undo a successful video or charge/refund credits again.
      console.error("Temporary video avatar cleanup will retry", { jobId: match[1] });
    }
  }
}
