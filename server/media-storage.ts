import type { DbUser, Env } from "./types";
import { now } from "./types";
import { mediaAllowance } from "./media";
import { MB } from "../shared/media";
export async function jobStorage(
  e: Env,
  user: DbUser,
  id: string,
  title: string,
  kind: "audio" | "video",
) {
  if (e.MEDIA_ENABLED !== "true") return [];
  const a = await mediaAllowance(e, user);
  return [
    e.DB.prepare(
      "INSERT INTO media_assets(id,user_id,object_key,name,kind,mime,bytes,job_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      id,
      user.id,
      `audio/${user.id}/${id}.${kind === "video" ? "mp4" : "wav"}`,
      title,
      kind,
      kind === "video" ? "video/mp4" : "audio/wav",
      (kind === "video" ? 100 : 96) * MB,
      id,
      now(),
      now() + a.days * 86400,
    ),
  ];
}
export async function finishJobStorage(
  e: Env,
  id: string,
  key: string,
  duration: number,
) {
  if (e.MEDIA_ENABLED !== "true") return;
  const a = await e.DB.prepare("SELECT bytes FROM media_assets WHERE id=?")
    .bind(id)
    .first<any>();
  if (!a) return;
  const o = await e.AUDIO.head(key);
  if (!o || o.size > a.bytes) throw new Error("MEDIA_OUTPUT_LIMIT");
  await e.DB.prepare(
    "UPDATE media_assets SET status='ready',bytes=?,duration=? WHERE id=?",
  )
    .bind(o.size, duration, id)
    .run();
}
export async function releaseJobStorage(e: Env, id: string) {
  if (e.MEDIA_ENABLED !== "true") return;
  const asset = await e.DB.prepare(
    "SELECT a.* FROM media_assets a JOIN jobs j ON j.id=a.job_id WHERE j.id=? AND j.status='failed'",
  )
    .bind(id)
    .first<any>();
  if (!asset) return;
  await e.AUDIO.delete(asset.object_key);
  if (asset.kind === "audio")
    await e.AUDIO.delete(`audio/${asset.user_id}/${id}.captions.json`);
  await e.DB.prepare("DELETE FROM media_assets WHERE id=?")
    .bind(asset.id)
    .run();
}
