import type { Env } from "./types";
import { withDefaults } from "./config";
import { sendMail } from "./security";

export async function notifyVideo(env: Env, id: string) {
  const e = withDefaults(env);
  if (!e.EMAIL) return;
  const job = await e.DB.prepare("SELECT j.*,u.email,u.verified FROM jobs j JOIN users u ON u.id=j.user_id WHERE j.id=? AND j.kind='video' AND j.status IN ('completed','failed')")
    .bind(id).first<any>();
  if (!job || !job.verified || !JSON.parse(job.video_meta || "{}").notifyEmail) return;
  // Claim before sending: replaying a Workflow must not send duplicate emails.
  // An ambiguous send remains 'sending'; do not blindly repeat it.
  const claim = await e.DB.prepare("UPDATE jobs SET video_meta=json_set(video_meta,'$.emailStatus','sending') WHERE id=? AND json_extract(video_meta,'$.emailStatus') IS NULL")
    .bind(id).run();
  if (!claim.meta.changes) return;
  const complete = job.status === "completed";
  const link = `${e.SITE_URL!.replace(/\/$/, "")}/app/studio/${job.project_id}?job=${id}`;
  try {
    await sendMail(e, job.email,
      complete ? "Видеото ви е готово — Реч БГ" : "Видеото не беше създадено — Реч БГ",
      complete
        ? `Вашето видео „${job.title}“ е готово.\n\nГледайте и изтеглете записа от профила си:\n${link}\n\nРеч БГ`
        : `Видеото „${job.title}“ не беше създадено. Кредитите за видеото са върнати, а аудиозаписът остава наличен.\n\nПодробности и нов опит:\n${link}\n\nРеч БГ`);
    await e.DB.prepare("UPDATE jobs SET video_meta=json_set(video_meta,'$.emailStatus','sent') WHERE id=?").bind(id).run();
  } catch {
    await e.DB.prepare("UPDATE jobs SET video_meta=json_set(video_meta,'$.emailStatus','failed') WHERE id=?").bind(id).run();
    console.error("Video notification was not confirmed", { jobId: id });
  }
}
