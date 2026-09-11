import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Env, ContextVars } from "./types";
import { now, uid } from "./types";
import { allowance } from "./billing";
import { rate, token, safeEqual } from "./security";
import { avatars, videoTiers, videoCredits } from "../shared/video";

export const avatarMap: Record<string, string> = {
  mia: "Mia outdoor (UGC)", lara: "Lara (Masterclass)", ines: "Ines (UGC)",
  maria: "Maria (Masterclass)", emma: "Emma (UGC)", ryan: "Ryan podcast (UGC)",
  tyler: "Tyler (Masterclass)", paul: "Paul (Masterclass)",
  matteo: "Matteo (UGC)", noemie: "Noemie car (UGC)",
};
export const videoModels = {
  standard: "argil/avatars/audio-to-video",
  quality: "fal-ai/kling-video/ai-avatar/v2/pro",
} as const;
export type VideoMeta = { avatar: string; imageKey?: string; imageMime?: string; token: string; consent: boolean; notifyEmail?: boolean };
export async function failVideo(env: Env, id: string, message = "Видеото не беше създадено. Кредитите за него са върнати. Аудиозаписът остава наличен.") {
  await env.DB.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status IN ('queued','running')")
    .bind(message, now(), id).run();
}
export const videos = new Hono<{ Bindings: Env; Variables: ContextVars }>();
videos.get("/config", (c) => c.json({ enabled: !!(c.env.FAL_KEY && c.env.VIDEO_GENERATION), emailNotifications: !!c.env.EMAIL, avatars, tiers: videoTiers }));
videos.post("/", async (c) => {
  const user = c.get("user");
  if (!user.verified) throw new HTTPException(403, { message: "Потвърдете имейла си, за да създадете видео." });
  if (!c.env.FAL_KEY || !c.env.VIDEO_GENERATION) throw new HTTPException(503, { message: "Създаването на видео ще бъде достъпно скоро." });
  await rate(c, "video", 20, 3600, user.id);
  const form = await c.req.formData();
  const d = z.object({ sourceId: z.uuid(), idempotencyKey: z.uuid(), tier: z.enum(["standard", "quality"]), credits: z.coerce.number().int().positive() })
    .parse(Object.fromEntries(form));
  const previous = await c.env.DB.prepare("SELECT id,kind FROM jobs WHERE user_id=? AND idempotency_key=?").bind(user.id, d.idempotencyKey).first<any>();
  if (previous) {
    if (previous.kind !== "video") throw new HTTPException(409, { message: "Невалидна заявка. Обновете страницата." });
    return c.json({ id: previous.id });
  }
  const source = await c.env.DB.prepare("SELECT * FROM jobs WHERE id=? AND user_id=? AND status='completed'").bind(d.sourceId, user.id).first<any>();
  if (!source || source.kind === "video" || !source.audio_key) throw new HTTPException(404, { message: "Изберете готов аудиозапис." });
  if (source.mode === "podcast") throw new HTTPException(400, { message: "За аватар използвайте запис с един глас." });
  let credits: number;
  try { credits = videoCredits(source.duration, d.tier); }
  catch (e) { throw new HTTPException(400, { message: (e as Error).message }); }
  if (credits !== d.credits) throw new HTTPException(409, { message: "Цената е променена. Обновете страницата и потвърдете отново." });
  if (!(await c.env.AUDIO.head(source.audio_key))) throw new HTTPException(404, { message: "Аудиозаписът вече не е наличен." });
  const id = uid();
  const meta: VideoMeta = { avatar: String(form.get("avatar") || ""), token: token(), consent: form.get("consent") === "true", notifyEmail: !!c.env.EMAIL && form.get("notifyEmail") === "true" };
  let image: Uint8Array | undefined;
  if (d.tier === "standard") {
    if (!Object.hasOwn(avatarMap, meta.avatar)) throw new HTTPException(400, { message: "Изберете аватар." });
  } else {
    if (!meta.consent) throw new HTTPException(400, { message: "Потвърдете правото си да използвате изображението." });
    const file = form.get("image");
    if (!(file instanceof File) || file.size < 24 || file.size > 2 * 1024 * 1024)
      throw new HTTPException(400, { message: "Качете JPG или PNG портрет до 2 MB." });
    image = new Uint8Array(await file.arrayBuffer());
    const png = image.slice(0, 8).every((b, i) => b === [137,80,78,71,13,10,26,10][i]);
    const jpg = image[0] === 255 && image[1] === 216 && image[2] === 255;
    if (!png && !jpg) throw new HTTPException(400, { message: "Невалидно изображение. Използвайте JPG или PNG." });
    meta.imageKey = `segments/${user.id}/${id}/portrait.${png ? "png" : "jpg"}`;
    meta.imageMime = png ? "image/png" : "image/jpeg";
  }
  const a = await allowance(c.env, user);
  try {
    await c.env.DB.prepare("INSERT INTO jobs(id,user_id,project_id,window_id,idempotency_key,title,mode,script,voice,second_voice,pause_ms,chars,created_at,updated_at,kind,source_job_id,video_tier,video_meta,duration) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'video',?,?,?,?)")
      .bind(id,user.id,source.project_id,a.window,d.idempotencyKey,source.title,source.mode,source.script,source.voice,source.second_voice,0,credits,now(),now(),source.id,d.tier,JSON.stringify(meta),source.duration).run();
  } catch (e) {
    if (String(e).includes("QUOTA_EXCEEDED")) throw new HTTPException(402, { message: "Недостатъчно кредити за това видео. Изберете по-висок план." });
    if (String(e).includes("UNIQUE")) {
      const existing = await c.env.DB.prepare("SELECT id FROM jobs WHERE user_id=? AND idempotency_key=?").bind(user.id, d.idempotencyKey).first<any>();
      if (existing) return c.json({ id: existing.id });
      throw new HTTPException(409, { message: "Вече се създава запис. Изчакайте той да завърши." });
    }
    throw e;
  }
  if (image && meta.imageKey) {
    try { await c.env.AUDIO.put(meta.imageKey, image, { httpMetadata: { contentType: meta.imageMime } }); }
    catch { await failVideo(c.env, id); return c.json({ id }, 202); }
  }
  try { await c.env.VIDEO_GENERATION.create({ id, params: { jobId: id } }); }
  catch { console.error("Video workflow dispatch requires reconciliation", { jobId: id }); }
  return c.json({ id }, 202);
});

// Short-lived capability URLs expose only the two inputs of an active video job.
export const videoInputs = new Hono<{ Bindings: Env }>();
videoInputs.get("/:id/:asset", async (c) => {
  const job = await c.env.DB.prepare("SELECT * FROM jobs WHERE id=? AND kind='video' AND status IN ('queued','running') AND created_at>?").bind(c.req.param("id"), now()-7200).first<any>();
  const meta: VideoMeta | null = job?.video_meta ? JSON.parse(job.video_meta) : null;
  if (!meta || !safeEqual(c.req.query("token") || "", meta.token)) throw new HTTPException(404, { message: "Файлът не е наличен." });
  let key: string | undefined, mime: string | undefined;
  if (c.req.param("asset") === "image") { key = meta.imageKey; mime = meta.imageMime; }
  if (c.req.param("asset") === "audio") {
    const source = await c.env.DB.prepare("SELECT audio_key FROM jobs WHERE id=? AND user_id=? AND status='completed'").bind(job.source_job_id, job.user_id).first<any>();
    key = source?.audio_key; mime = "audio/wav";
  }
  if (!key) throw new HTTPException(404);
  const obj = await c.env.AUDIO.get(key);
  if (!obj) throw new HTTPException(404);
  return new Response(obj.body, { headers: { "Content-Type": mime!, "Content-Length": String(obj.size), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
});
