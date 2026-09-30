import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ContextVars, Env } from "./types";
import { now, uid } from "./types";
import { withDefaults } from "./config";
import { rate, safeEqual, token } from "./security";
import { allowance } from "./billing";
import { ownedAsset } from "./media";
import { avatarMode } from "./video-provider";
import { createHeyGenAvatar, deleteHeyGenAvatar, getHeyGenLook, type HeyGenEngine } from "./video-heygen";
import { AVATAR_CREDITS, MAX_USER_AVATARS } from "../shared/video";
import { canCreateVideo, VIDEO_PLAN_MESSAGE } from "../shared/catalog";
import type { UserAvatar } from "../shared/avatars";

// "Моите аватари": a photo becomes a reusable HeyGen photo avatar once (paid once in credits); every later
// video only references it, which is what makes Avatar III/IV videos cheap.
/** Bump when the confirmation shown before creating an avatar changes. */
export const AVATAR_CONSENT_TEXT = "user-avatar-consent-2026-09-30";
const PROCESSING_LIMIT = 30 * 60;
type Row = {
  id: string; user_id: string; name: string; image_key: string; mime: string; status: UserAvatar["status"];
  look_id: string | null; group_id: string | null; engines: string | null; error: string | null;
  credits: number; token: string; created_at: number; updated_at: number;
};
type Bindings = { Bindings: Env; Variables: ContextVars };
const publicAvatar = (r: Row): UserAvatar => ({
  id: r.id, name: r.name, status: r.status, error: r.error, imageUrl: `/api/my-avatars/${r.id}/image`, createdAt: r.created_at,
  engines: r.engines ? JSON.parse(r.engines) : [],
});
const fail = (env: Env, id: string, error: string) =>
  env.DB.prepare("UPDATE user_avatars SET status='failed',error=?,updated_at=? WHERE id=? AND status='processing'").bind(error, now(), id).run();
const enabled = (env: Env) => avatarMode(env) && !!env.HEYGEN_API_KEY?.trim();

/** Follows an avatar HeyGen is still creating; a failed or stuck one is refunded. */
async function refresh(env: Env, row: Row): Promise<Row> {
  if (row.status !== "processing") return row;
  if (!row.look_id) {
    if (row.created_at < now() - 5 * 60) await fail(env, row.id, "Аватарът не беше създаден. Кредитите са върнати.");
  } else {
    try {
      const look = await getHeyGenLook(env, row.look_id);
      if (look.status === "completed")
        await env.DB.prepare("UPDATE user_avatars SET status='ready',engines=?,updated_at=? WHERE id=? AND status='processing'")
          .bind(JSON.stringify(look.engines), now(), row.id).run();
      else if (look.status === "failed")
        await fail(env, row.id, look.moderation
          ? "Снимката не беше приета от проверката за съдържание. Кредитите са върнати."
          : "Аватарът не беше създаден. Опитайте с друга снимка. Кредитите са върнати.");
      else if (row.created_at < now() - PROCESSING_LIMIT) await fail(env, row.id, "Създаването отне твърде дълго. Кредитите са върнати.");
    } catch {
      // A temporary provider error: try again on the next refresh, unless it has been failing too long.
      console.error("Avatar status check failed", { avatar: row.id });
      if (row.created_at < now() - PROCESSING_LIMIT) await fail(env, row.id, "Създаването отне твърде дълго. Кредитите са върнати.");
    }
  }
  return (await env.DB.prepare("SELECT * FROM user_avatars WHERE id=?").bind(row.id).first<Row>()) || row;
}

/** A ready avatar of the user, as a video job needs it. */
export async function userAvatarInput(env: Env, userId: string, id: string) {
  const row = await env.DB.prepare("SELECT * FROM user_avatars WHERE id=? AND user_id=?").bind(id, userId).first<Row>();
  if (!row) throw new HTTPException(404, { message: "Аватарът не е наличен. Изберете друг." });
  const fresh = await refresh(env, row);
  if (fresh.status !== "ready" || !fresh.look_id)
    throw new HTTPException(400, { message: fresh.status === "processing" ? "Аватарът още се създава. Опитайте след минута." : "Този аватар не е създаден успешно. Изберете друг." });
  return { heygen: { lookId: fresh.look_id, groupId: fresh.group_id || "" }, engines: (fresh.engines ? JSON.parse(fresh.engines) : []) as string[] };
}
/** Whether a saved avatar can be animated by the engine (unknown lists are allowed; HeyGen then decides). */
export const supportsEngine = (engines: string[], engine: HeyGenEngine) => !engines.length || engines.includes(engine);

export const userAvatars = new Hono<Bindings>();
userAvatars.get("/", async (c) => {
  const user = c.get("user");
  const rows = (await c.env.DB.prepare("SELECT * FROM user_avatars WHERE user_id=? AND (status!='failed' OR updated_at>?) ORDER BY created_at DESC LIMIT 50")
    .bind(user.id, now() - 7 * 86400).all<Row>()).results;
  const list = await Promise.all(rows.map((r, i) => i < 5 ? refresh(c.env, r) : r));
  return c.json({ avatars: list.map(publicAvatar), enabled: enabled(c.env), credits: AVATAR_CREDITS, max: MAX_USER_AVATARS });
});
userAvatars.post("/", async (c) => {
  const user = c.get("user");
  if (!user.verified) throw new HTTPException(403, { message: "Потвърдете имейла си, за да създадете аватар." });
  if (!enabled(c.env)) throw new HTTPException(503, { message: "Създаването на аватари ще бъде достъпно скоро." });
  const form = await c.req.formData();
  const d = z.object({ name: z.string().trim().min(1).max(50), idempotencyKey: z.uuid(), credits: z.coerce.number().int() }).parse(Object.fromEntries(form));
  const previous = await c.env.DB.prepare("SELECT * FROM user_avatars WHERE user_id=? AND idempotency_key=?").bind(user.id, d.idempotencyKey).first<Row>();
  if (previous) return c.json({ avatar: publicAvatar(previous) });
  await rate(c, "user-avatar", 20, 3600, user.id);
  const a = await allowance(c.env, user);
  if (!canCreateVideo(a.plan)) throw new HTTPException(403, { message: `${VIDEO_PLAN_MESSAGE} Изберете по-висок план.` });
  if (d.credits !== AVATAR_CREDITS) throw new HTTPException(409, { message: "Цената е променена. Обновете страницата." });
  if (form.get("consent") !== "true") throw new HTTPException(400, { message: "Потвърдете правото си да използвате снимката." });
  const count = await c.env.DB.prepare("SELECT COUNT(*) n FROM user_avatars WHERE user_id=? AND status!='failed'").bind(user.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_USER_AVATARS) throw new HTTPException(400, { message: `Можете да пазите до ${MAX_USER_AVATARS} аватара. Изтрийте някой, за да създадете нов.` });

  // The photo: an upload (up to 5 MB) or an image from the user's media library.
  let bytes: Uint8Array;
  const file = form.get("image"), assetId = form.get("assetId");
  if (typeof assetId === "string" && assetId) {
    const asset = await ownedAsset(c.env, user.id, assetId);
    if (!["portrait", "variant", "product"].includes(asset.kind) || asset.bytes > 8 * 1024 * 1024) throw new HTTPException(400, { message: "Изберете снимка от библиотеката." });
    const object = await c.env.AUDIO.get(asset.object_key);
    if (!object) throw new HTTPException(404, { message: "Снимката вече не е налична." });
    bytes = new Uint8Array(await object.arrayBuffer());
  } else if (file instanceof File && file.size >= 24 && file.size <= 5 * 1024 * 1024) {
    bytes = new Uint8Array(await file.arrayBuffer());
  } else throw new HTTPException(400, { message: "Качете JPG или PNG снимка до 5 MB." });
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpg) throw new HTTPException(400, { message: "Невалидна снимка. Използвайте JPG или PNG." });

  const id = uid(), mime = png ? "image/png" : "image/jpeg", imageKey = `avatars/${user.id}/${id}/photo.${png ? "png" : "jpg"}`, t = now(), secret = token();
  await c.env.AUDIO.put(imageKey, bytes, { httpMetadata: { contentType: mime } });
  try {
    await c.env.DB.prepare(
      "INSERT INTO user_avatars(id,user_id,name,image_key,mime,window_id,credits,idempotency_key,token,consent_at,consent_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(id, user.id, d.name, imageKey, mime, a.window, AVATAR_CREDITS, d.idempotencyKey, secret, t, AVATAR_CONSENT_TEXT, t, t).run();
  } catch (e) {
    await c.env.AUDIO.delete(imageKey).catch(() => {});
    if (String(e).includes("QUOTA_EXCEEDED")) throw new HTTPException(402, { message: "Нямате достатъчно кредити за нов аватар." });
    if (String(e).includes("UNIQUE")) {
      const existing = await c.env.DB.prepare("SELECT * FROM user_avatars WHERE user_id=? AND idempotency_key=?").bind(user.id, d.idempotencyKey).first<Row>();
      if (existing) return c.json({ avatar: publicAvatar(existing) });
    }
    throw e;
  }
  // HeyGen reads the photo once through a short-lived link while it creates the avatar.
  const url = `${withDefaults(c.env).SITE_URL!.replace(/\/$/, "")}/api/user-avatar-inputs/${id}?token=${secret}`;
  try {
    const created = await createHeyGenAvatar(c.env, `user-${id}`, url);
    await c.env.DB.prepare("UPDATE user_avatars SET look_id=?,group_id=?,updated_at=? WHERE id=?").bind(created.lookId, created.groupId, now(), id).run();
  } catch {
    console.error("Avatar creation failed", { avatar: id });
    await fail(c.env, id, "HeyGen не прие снимката. Кредитите са върнати.");
    throw new HTTPException(502, { message: "Аватарът не беше създаден. Кредитите са върнати. Опитайте отново или с друга снимка." });
  }
  const row = await c.env.DB.prepare("SELECT * FROM user_avatars WHERE id=?").bind(id).first<Row>();
  return c.json({ avatar: publicAvatar(row!) }, 201);
});
userAvatars.get("/:id/image", async (c) => {
  const row = await c.env.DB.prepare("SELECT image_key,mime FROM user_avatars WHERE id=? AND user_id=?").bind(c.req.param("id"), c.get("user").id).first<Row>();
  const object = row && await c.env.AUDIO.get(row.image_key);
  if (!row || !object) throw new HTTPException(404, { message: "Снимката не е налична." });
  return new Response(object.body, { headers: { "Content-Type": row.mime, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
});
userAvatars.delete("/:id", async (c) => {
  const user = c.get("user"), id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM user_avatars WHERE id=? AND user_id=?").bind(id, user.id).first<Row>();
  if (!row) throw new HTTPException(404, { message: "Аватарът не е наличен." });
  if (row.status === "processing") throw new HTTPException(409, { message: "Аватарът още се създава. Изтрийте го, след като е готов." });
  const busy = await c.env.DB.prepare("SELECT id FROM jobs WHERE user_id=? AND kind='video' AND status IN ('queued','running') AND json_extract(video_meta,'$.userAvatarId')=? LIMIT 1")
    .bind(user.id, id).first();
  if (busy) throw new HTTPException(409, { message: "С този аватар се създава видео. Изтрийте го, след като видеото е готово." });
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES (?,?)").bind(`avatars/${user.id}/${id}/`, now()),
    ...(row.group_id ? [c.env.DB.prepare("INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES (?,?)").bind(`heygen-avatar/${id}/${row.group_id}`, now())] : []),
    c.env.DB.prepare("DELETE FROM user_avatars WHERE id=?").bind(id),
  ]);
  // Best effort now; the maintenance run retries both.
  try {
    await c.env.AUDIO.delete(row.image_key);
    await c.env.DB.prepare("DELETE FROM cleanup_tasks WHERE prefix=?").bind(`avatars/${user.id}/${id}/`).run();
    if (row.group_id && c.env.HEYGEN_API_KEY?.trim()) {
      await deleteHeyGenAvatar(c.env, row.group_id);
      await c.env.DB.prepare("DELETE FROM cleanup_tasks WHERE prefix=?").bind(`heygen-avatar/${id}/${row.group_id}`).run();
    }
  } catch { console.error("Avatar cleanup will retry", { avatar: id }); }
  return c.json({ ok: true });
});

// Unauthenticated, for HeyGen only: the photo while its avatar is being created (token, 1 hour).
export const userAvatarInputs = new Hono<{ Bindings: Env }>();
userAvatarInputs.get("/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM user_avatars WHERE id=? AND status='processing' AND created_at>?").bind(c.req.param("id"), now() - 3600).first<Row>();
  if (!row || !safeEqual(c.req.query("token") || "", row.token)) throw new HTTPException(404, { message: "Файлът не е наличен." });
  const object = await c.env.AUDIO.get(row.image_key);
  if (!object) throw new HTTPException(404, { message: "Файлът не е наличен." });
  return new Response(object.body, { headers: { "Content-Type": row.mime, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
});
