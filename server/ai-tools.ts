import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ContextVars, Env } from "./types";
import { now, uid } from "./types";
import { rate, safeEqual, token } from "./security";
import { mediaAllowance, mediaError, ownedAsset, serveObject } from "./media";
import { listHeyGenLanguages } from "./video-heygen";
import { canCreateVideo, VIDEO_PLAN_MESSAGE } from "../shared/catalog";
import { MB } from "../shared/media";
import { videoAssetKinds } from "../shared/layers";
import { CLONE_VOICE, popularLanguages, REVOICE_MAX_CHARS, revoiceCredits, revoiceModes, translateCredits, translateModes, type AiTask, type TranslateMode } from "../shared/tools";
import { publicStudioVoices, resolveStudioVoice } from "./studio-voices";

// "Медийни инструменти" backed by a provider: dubbing (HeyGen Video Translation). A task is paid when created,
// runs in the video Workflow and saves its result as a new video in the media library; a failure refunds it.
type Bindings = { Bindings: Env; Variables: ContextVars };
type Row = {
  id: string; user_id: string; kind: "translate" | "lipsync"; source_asset_id: string; output_asset_id: string; params: string;
  credits: number; status: AiTask["status"]; phase: string; error: string | null; token: string; created_at: number;
};
const LANGUAGES_KEY = "config/heygen-languages.json";
export const toolsEnabled = (env: Env) => !!env.HEYGEN_API_KEY?.trim() && !!env.VIDEO_GENERATION;

/** HeyGen's target languages, kept for a day; the popular ones if HeyGen cannot be reached. */
export async function translationLanguages(env: Env): Promise<string[]> {
  const stored = await env.AUDIO.get(LANGUAGES_KEY);
  const cached = stored ? await new Response(stored.body).json<{ at: number; list: string[] }>().catch(() => null) : null;
  if (cached && cached.at > now() - 86400 && cached.list.length) return cached.list;
  try {
    const list = await listHeyGenLanguages(env);
    if (list.length) await env.AUDIO.put(LANGUAGES_KEY, JSON.stringify({ at: now(), list }), { httpMetadata: { contentType: "application/json" } });
    return list.length ? list : cached?.list || popularLanguages;
  } catch {
    console.error("Translation languages unavailable");
    return cached?.list || popularLanguages;
  }
}

const publicTask = (r: Row & { source_name: string | null }): AiTask => {
  const p = JSON.parse(r.params || "{}");
  return { id: r.id, kind: r.kind, status: r.status, phase: r.phase, sourceAssetId: r.source_asset_id, outputAssetId: r.output_asset_id,
    sourceName: r.source_name || "Видео", language: p.language, mode: p.mode, voice: p.voice, credits: r.credits, error: r.error, createdAt: r.created_at };
};

export const tools = new Hono<Bindings>();
tools.get("/config", async (c) => {
  const revoice = toolsEnabled(c.env) && !!c.env.ELEVENLABS_API_KEY?.trim();
  return c.json({
    translate: { enabled: toolsEnabled(c.env), modes: translateModes },
    revoice: { enabled: revoice, modes: revoiceModes, voices: revoice ? await publicStudioVoices(c.env) : [] },
  });
});
tools.get("/languages", async (c) => {
  if (!toolsEnabled(c.env)) return c.json({ languages: [] });
  const list = await translationLanguages(c.env);
  // Popular languages first, in their usual order, then the rest alphabetically.
  const popular = popularLanguages.filter((l) => list.includes(l));
  return c.json({ languages: [...popular, ...list.filter((l) => !popular.includes(l)).sort()] , popular });
});
tools.get("/tasks", async (c) => {
  const rows = (await c.env.DB.prepare(
    "SELECT t.*,a.name AS source_name FROM ai_tasks t LEFT JOIN media_assets a ON a.id=t.source_asset_id WHERE t.user_id=? ORDER BY t.created_at DESC LIMIT 30",
  ).bind(c.get("user").id).all<Row & { source_name: string | null }>()).results;
  return c.json({ tasks: rows.map(publicTask) });
});
tools.post("/translate", async (c) => {
  const user = c.get("user");
  if (!user.verified) throw new HTTPException(403, { message: "Потвърдете имейла си, за да използвате инструментите." });
  if (!toolsEnabled(c.env)) throw new HTTPException(503, { message: "Преводът на видео ще бъде достъпен скоро." });
  const d = z.object({
    assetId: z.uuid(), language: z.string().trim().min(2).max(80), mode: z.enum(["speed", "precision", "audio"]),
    idempotencyKey: z.uuid(), credits: z.number().int().positive(), consent: z.literal(true),
  }).parse(await c.req.json());
  const previous = await c.env.DB.prepare("SELECT id FROM ai_tasks WHERE user_id=? AND idempotency_key=?").bind(user.id, d.idempotencyKey).first<{ id: string }>();
  if (previous) return c.json({ id: previous.id });
  await rate(c, "tool-translate", 20, 3600, user.id);
  const a = await mediaAllowance(c.env, user);
  if (!canCreateVideo(a.plan)) throw new HTTPException(403, { message: `${VIDEO_PLAN_MESSAGE} Изберете по-висок план.` });
  const asset = await ownedAsset(c.env, user.id, d.assetId);
  // Uploads, studio exports and avatar videos made in the studio (kind "video").
  if (![...videoAssetKinds, "video"].includes(asset.kind) || !asset.mime.startsWith("video/") || !asset.duration)
    throw new HTTPException(400, { message: "Изберете проверено видео от библиотеката." });
  if (!(await translationLanguages(c.env)).includes(d.language)) throw new HTTPException(400, { message: "Изберете език от списъка." });
  let credits: number;
  try { credits = translateCredits(asset.duration, d.mode as TranslateMode); }
  catch (e) { throw new HTTPException(400, { message: (e as Error).message }); }
  if (credits !== d.credits) throw new HTTPException(409, { message: "Цената е променена. Обновете страницата." });
  const t = now();
  return createToolTask(c, { kind: "translate", asset, credits, key: d.idempotencyKey, window: a.window, days: a.days,
    name: `${asset.name.replace(/\.[a-z0-9]{2,4}$/i, "")} · ${d.language}`, params: { language: d.language, mode: d.mode, consentAt: t, duration: asset.duration } });
});

/** Reserves the result in the library, charges the task (D1 trigger) and starts its Workflow. */
async function createToolTask(c: Context<Bindings>, o: {
  kind: "translate" | "lipsync"; asset: { id: string; bytes: number }; credits: number; key: string; window: string; days: number;
  name: string; params: Record<string, unknown>;
}) {
  const user = c.get("user"), id = uid(), output = uid(), t = now();
  // The new video is about the size of the source; reserve room for it up front.
  const reserve = Math.min(1024 * MB, Math.max(100 * MB, Math.ceil(o.asset.bytes * 1.5)));
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO media_assets(id,user_id,object_key,name,kind,mime,bytes,status,created_at,expires_at) VALUES(?,?,?,?,'upload','video/mp4',?,'checking',?,?)")
        .bind(output, user.id, `media/${user.id}/${output}/result`, o.name.slice(0, 120), reserve, t, t + o.days * 86400),
      c.env.DB.prepare("INSERT INTO ai_tasks(id,user_id,kind,source_asset_id,output_asset_id,params,window_id,credits,token,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id, user.id, o.kind, o.asset.id, output, JSON.stringify(o.params), o.window, o.credits, token(), o.key, t, t),
    ]);
  } catch (e) {
    if (String(e).includes("AI_TASKS_BUSY")) throw new HTTPException(409, { message: "Вече се обработват две видеа. Изчакайте едното да завърши." });
    if (String(e).includes("UNIQUE")) {
      const again = await c.env.DB.prepare("SELECT id FROM ai_tasks WHERE user_id=? AND idempotency_key=?").bind(user.id, o.key).first<{ id: string }>();
      if (again) return c.json({ id: again.id });
    }
    mediaError(e);
  }
  try { await c.env.VIDEO_GENERATION!.create({ id, params: { toolTaskId: id } }); }
  catch { console.error("Tool dispatch requires reconciliation", { taskId: id }); }
  return c.json({ id }, 202);
}

/**
 * "Преозвучаване": new words for a filmed video, spoken by the speaker's cloned voice (deleted after this task)
 * or a studio voice, with the lips following them.
 */
tools.post("/revoice", async (c) => {
  const user = c.get("user");
  if (!user.verified) throw new HTTPException(403, { message: "Потвърдете имейла си, за да използвате инструментите." });
  if (!toolsEnabled(c.env) || !c.env.ELEVENLABS_API_KEY?.trim()) throw new HTTPException(503, { message: "Преозвучаването ще бъде достъпно скоро." });
  const d = z.object({
    assetId: z.uuid(), text: z.string().trim().min(1).max(REVOICE_MAX_CHARS), voice: z.string().min(1).max(40), mode: z.enum(["speed", "precision"]),
    idempotencyKey: z.uuid(), credits: z.number().int().positive(), consent: z.literal(true), voiceConsent: z.boolean().optional(),
  }).parse(await c.req.json());
  const previous = await c.env.DB.prepare("SELECT id FROM ai_tasks WHERE user_id=? AND idempotency_key=?").bind(user.id, d.idempotencyKey).first<{ id: string }>();
  if (previous) return c.json({ id: previous.id });
  await rate(c, "tool-revoice", 20, 3600, user.id);
  const a = await mediaAllowance(c.env, user);
  if (!canCreateVideo(a.plan)) throw new HTTPException(403, { message: `${VIDEO_PLAN_MESSAGE} Изберете по-висок план.` });
  const clone = d.voice === CLONE_VOICE;
  if (clone && d.voiceConsent !== true) throw new HTTPException(400, { message: "Потвърдете, че гласът във видеото може да бъде клониран." });
  if (!clone) await resolveStudioVoice(c.env, d.voice);
  const asset = await ownedAsset(c.env, user.id, d.assetId);
  if (![...videoAssetKinds, "video"].includes(asset.kind) || !asset.mime.startsWith("video/") || !asset.duration)
    throw new HTTPException(400, { message: "Изберете проверено видео от библиотеката." });
  let credits: number;
  try { credits = revoiceCredits(asset.duration, d.text, d.mode); }
  catch (e) { throw new HTTPException(400, { message: (e as Error).message }); }
  if (credits !== d.credits) throw new HTTPException(409, { message: "Цената е променена. Обновете страницата." });
  const t = now();
  return createToolTask(c, { kind: "lipsync", asset, credits, key: d.idempotencyKey, window: a.window, days: a.days,
    name: `${asset.name.replace(/\.[a-z0-9]{2,4}$/i, "")} · нов текст`,
    params: { mode: d.mode, voice: d.voice, text: d.text, duration: asset.duration, consentAt: t, ...(clone ? { voiceConsentAt: t } : {}) } });
});

// Unauthenticated, for the provider only: the source video of a running task (token; up to a day).
export const toolInputs = new Hono<{ Bindings: Env }>();
toolInputs.get("/:id", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT t.token,a.object_key FROM ai_tasks t JOIN media_assets a ON a.id=t.source_asset_id WHERE t.id=? AND t.status IN ('queued','running') AND t.created_at>?",
  ).bind(c.req.param("id"), now() - 86400).first<{ token: string; object_key: string }>();
  if (!row || !safeEqual(c.req.query("token") || "", row.token)) throw new HTTPException(404, { message: "Файлът не е наличен." });
  const response = await serveObject(c.env, row.object_key, c.req.header("Range"));
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
});

/** The new speech of a running re-voicing task (token), for the provider. */
toolInputs.get("/:id/speech", async (c) => {
  const row = await c.env.DB.prepare("SELECT token,user_id FROM ai_tasks WHERE id=? AND kind='lipsync' AND status IN ('queued','running') AND created_at>?")
    .bind(c.req.param("id"), now() - 86400).first<{ token: string; user_id: string }>();
  if (!row || !safeEqual(c.req.query("token") || "", row.token)) throw new HTTPException(404, { message: "Файлът не е наличен." });
  const response = await serveObject(c.env, toolSpeechKey(row.user_id, c.req.param("id")), c.req.header("Range"));
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
});
/** Working files of a tool task (voice sample, new speech); removed when it ends. */
export const toolFiles = (user: string, id: string) => `tools/${user}/${id}/`;
export const toolSpeechKey = (user: string, id: string) => `${toolFiles(user, id)}speech.mp3`;

/** Fails a tool task once: refunds it (trigger) and frees the reserved result. */
export async function failTool(env: Env, id: string, error: string) {
  const row = await env.DB.prepare("SELECT output_asset_id,user_id FROM ai_tasks WHERE id=?").bind(id).first<{ output_asset_id: string; user_id: string }>();
  const changed = await env.DB.prepare("UPDATE ai_tasks SET status='failed',error=?,updated_at=? WHERE id=? AND status IN ('queued','running')").bind(error, now(), id).run();
  if (!changed.meta.changes || !row) return;
  await env.DB.prepare("INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES (?,?)").bind(toolFiles(row.user_id, id), now()).run();
  await env.AUDIO.delete(`media/${row.user_id}/${row.output_asset_id}/result`).catch(() => {});
  await env.DB.prepare("DELETE FROM media_assets WHERE id=? AND status<>'ready'").bind(row.output_asset_id).run();
}
