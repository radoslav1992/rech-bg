import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { defaultAvatars, type LibraryAvatar } from "../shared/avatars";
import { rate, safeEqual, token } from "./security";
import { uid, now, type Env, type ContextVars } from "./types";
import { withDefaults } from "./config";
import { createHeyGenAvatar, getHeyGenLook } from "./video-heygen";

const prefix = "config/avatar-library/";
const key = (id: string) => `${prefix}${id}.json`;
const validId = (id: string) => defaultAvatars.some(a => a.id === id) || /^avatar-[a-f0-9-]{36}$/.test(id);
const heygenId = z.string().trim().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const fields = z.object({
  name: z.string().trim().min(1).max(50),
  description: z.string().trim().min(1).max(180),
  category: z.enum(["business", "casual", "creative"]),
  presentation: z.enum(["female", "male"]),
});
const recordSchema = fields.extend({
  active: z.boolean(), mime: z.enum(["image/jpeg", "image/png"]), updatedAt: z.number(),
  // One reusable HeyGen photo avatar per library avatar (Medium quality with Avatar III).
  heygen: z.object({ lookId: heygenId, groupId: z.string().max(160), status: z.enum(["processing", "ready", "failed"]),
    // Video engines HeyGen lists for it (avatar_iii, avatar_iv…); missing for links made before this was kept.
    engines: z.array(z.string().max(40)).max(10).optional() }).optional(),
  // Short-lived link HeyGen uses to fetch the portrait while creating that avatar.
  heygenInput: z.object({ token: z.string(), expires: z.number() }).optional(),
});
type RecordData = z.infer<typeof recordSchema>;
async function resolve(env: Env, id: string): Promise<RecordData> {
  if (!validId(id)) throw new HTTPException(404, { message: "Аватарът не е наличен." });
  const stored = await env.AUDIO.get(key(id));
  if (stored) return recordSchema.parse(await new Response(stored.body).json());
  const base = defaultAvatars.find(a => a.id === id);
  if (!base) throw new HTTPException(404, { message: "Аватарът не е наличен." });
  return { ...base, active: true, mime: "image/jpeg", updatedAt: 0 };
}
const save = (env: Env, id: string, record: RecordData) =>
  env.AUDIO.put(key(id), JSON.stringify(record), { httpMetadata: { contentType: "application/json" } });
function publicAvatar(id: string, record: RecordData, admin = false): LibraryAvatar {
  const { name, description, category, presentation, active } = record;
  return {
    id, name, description, category, presentation, active, imageUrl: `/api/avatars/${id}/image`, heygen: record.heygen?.status === "ready",
    ...(admin ? { heygenLookId: record.heygen?.lookId ?? null, heygenStatus: record.heygen?.status ?? null } : {}),
  };
}
async function catalog(env: Env, admin = false) {
  const ids = new Set<string>(defaultAvatars.map(a => a.id));
  let cursor: string | undefined;
  do {
    const page = await env.AUDIO.list({ prefix, cursor });
    page.objects.forEach(o => {
      const id = o.key.slice(prefix.length).replace(/\.json$/, "");
      if (o.key.endsWith(".json") && validId(id)) ids.add(id);
    });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const avatars = await Promise.all([...ids].map(async id => publicAvatar(id, await resolve(env, id), admin)));
  return avatars.filter(a => admin || a.active);
}
/** The portrait of a library avatar: bundled with the site, or uploaded by an administrator. */
async function libraryImage(env: Env, id: string): Promise<ReadableStream | null> {
  if (defaultAvatars.some(a => a.id === id)) {
    const r = await env.ASSETS.fetch(new Request(`https://rechbg.com/images/avatar-library/${id}.jpg`));
    return r.ok && r.headers.get("Content-Type")?.startsWith("image/jpeg") ? r.body : null;
  }
  return (await env.AUDIO.get(`library/avatars/${id}`))?.body ?? null;
}
/** What a video job needs from a library avatar: its portrait, and its HeyGen avatar when one is ready. */
export async function libraryAvatarInput(env: Env, id: string) {
  const record = await resolve(env, id);
  if (!record.active) throw new HTTPException(404, { message: "Аватарът е премахнат от библиотеката. Изберете друг." });
  const body = await libraryImage(env, id);
  if (!body) throw new HTTPException(404, { message: "Изображението не е налично." });
  const bytes = new Uint8Array(await new Response(body).arrayBuffer());
  return { bytes, mime: record.mime, name: record.name, heygen: record.heygen?.status === "ready" ? { lookId: record.heygen.lookId, groupId: record.heygen.groupId } : null,
    engines: record.heygen?.engines ?? [] };
}
type Bindings = { Bindings: Env; Variables: ContextVars };
export const avatars = new Hono<Bindings>();
avatars.get("/", async c => c.json({ avatars: await catalog(c.env) }));
avatars.get("/:id/image", async c => {
  const id = c.req.param("id"), record = await resolve(c.env, id);
  if (!record.active) throw new HTTPException(404, { message: "Аватарът е премахнат от библиотеката. Изберете друг." });
  const body = await libraryImage(c.env, id);
  if (!body) throw new HTTPException(404, { message: "Изображението не е налично." });
  return new Response(body, { headers: { "Content-Type": record.mime, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
});
// Unauthenticated, for HeyGen only: the portrait while its avatar is being created (token, 15 minutes).
export const avatarInputs = new Hono<Bindings>();
avatarInputs.get("/:id/image", async c => {
  const id = c.req.param("id");
  const record = validId(id) ? await resolve(c.env, id).catch(() => null) : null;
  const input = record?.heygenInput;
  if (!record || !input || input.expires < now() || !safeEqual(c.req.query("token") || "", input.token)) throw new HTTPException(404, { message: "Файлът не е наличен." });
  const body = await libraryImage(c.env, id);
  if (!body) throw new HTTPException(404, { message: "Файлът не е наличен." });
  return new Response(body, { headers: { "Content-Type": record.mime, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
});

// Mounted after the existing authenticated administrator middleware.
export const adminAvatars = new Hono<Bindings>();
adminAvatars.get("/", async c => c.json({ avatars: await catalog(c.env, true) }));
adminAvatars.post("/", async c => {
  await rate(c, "avatar-create", 30, 3600, c.get("user").id);
  const form = await c.req.formData(), data = fields.parse(Object.fromEntries(form));
  if (form.get("rightsConfirmed") !== "true") throw new HTTPException(400, { message: "Потвърдете, че аватарът е синтетичен и имате право да го предоставяте на потребителите." });
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 24 || file.size > 2 * 1024 * 1024) throw new HTTPException(400, { message: "Качете JPG или PNG до 2 MB." });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = [137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b);
  const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpg) throw new HTTPException(400, { message: "Невалиден файл. Използвайте JPG или PNG." });
  const id = `avatar-${uid()}`, imageKey = `library/avatars/${id}`;
  const record: RecordData = { ...data, active: true, mime: png ? "image/png" : "image/jpeg", updatedAt: now() };
  await c.env.AUDIO.put(imageKey, bytes, { httpMetadata: { contentType: record.mime } });
  try { await c.env.AUDIO.put(key(id), JSON.stringify(record), { httpMetadata: { contentType: "application/json" } }); }
  catch (e) { await c.env.AUDIO.delete(imageKey); throw e; }
  return c.json({ avatar: publicAvatar(id, record, true) }, 201);
});
adminAvatars.put("/:id", async c => {
  const id = c.req.param("id"), old = await resolve(c.env, id);
  const data = fields.extend({ active: z.boolean() }).parse(await c.req.json());
  const record = { ...old, ...data, updatedAt: now() };
  await save(c.env, id, record);
  return c.json({ avatar: publicAvatar(id, record, true) });
});
adminAvatars.delete("/:id", async c => {
  const id = c.req.param("id"), record = await resolve(c.env, id);
  // A tombstone prevents defaults from returning on redeploy. Keep the image for restore;
  // jobs already have their own input copies and are unaffected by catalog edits.
  await c.env.AUDIO.put(key(id), JSON.stringify({ ...record, active: false, updatedAt: now() }), { httpMetadata: { contentType: "application/json" } });
  return c.json({ ok: true });
});

// HeyGen link: reuse one photo avatar per library avatar for every Medium video.
const heygenFailure = (e: unknown) => {
  if (e instanceof HTTPException) return e;
  const code = e instanceof Error ? /VIDEO_\w+/.exec(e.message)?.[0] : undefined;
  return new HTTPException(502, { message: `HeyGen не прие заявката${code ? ` (${code})` : ""}. Проверете API ключа и ID на аватара.` });
};
function requireHeyGen(env: Env) {
  if (!env.HEYGEN_API_KEY?.trim()) throw new HTTPException(503, { message: "Добавете HEYGEN_API_KEY, за да свържете аватари с HeyGen." });
}
/** Links an avatar that already exists in the HeyGen account (or removes the link with `lookId: null`). */
adminAvatars.put("/:id/heygen", async c => {
  await rate(c, "avatar-heygen", 60, 3600, c.get("user").id);
  const id = c.req.param("id"), record = await resolve(c.env, id);
  const { lookId } = z.object({ lookId: heygenId.nullable() }).parse(await c.req.json());
  if (!lookId) {
    const { heygen: _removed, heygenInput: _input, ...rest } = record;
    const next = { ...rest, updatedAt: now() };
    await save(c.env, id, next);
    return c.json({ avatar: publicAvatar(id, next, true) });
  }
  requireHeyGen(c.env);
  let look;
  try { look = await getHeyGenLook(c.env, lookId); } catch (e) { throw heygenFailure(e); }
  if (look.status === "failed") throw new HTTPException(400, { message: "Този аватар в HeyGen не е завършен успешно." });
  if (look.status === "completed" && !look.avatarIII)
    throw new HTTPException(400, { message: "Този аватар в HeyGen не поддържа Avatar III. Използвайте фото аватар." });
  const next: RecordData = { ...record, heygen: { lookId, groupId: look.groupId, status: look.status === "completed" ? "ready" : "processing", engines: look.engines }, updatedAt: now() };
  await save(c.env, id, next);
  return c.json({ avatar: publicAvatar(id, next, true) });
});
/** Creates the HeyGen photo avatar once from the library portrait. */
adminAvatars.post("/:id/heygen", async c => {
  await rate(c, "avatar-heygen", 60, 3600, c.get("user").id);
  requireHeyGen(c.env);
  const id = c.req.param("id"), record = await resolve(c.env, id);
  if (!record.active) throw new HTTPException(400, { message: "Възстановете аватара, преди да го свържете с HeyGen." });
  if (record.heygen && record.heygen.status !== "failed") throw new HTTPException(409, { message: "Аватарът вече е свързан с HeyGen." });
  const input = { token: token(), expires: now() + 900 };
  await save(c.env, id, { ...record, heygenInput: input });
  const url = `${withDefaults(c.env).SITE_URL!.replace(/\/$/, "")}/api/avatar-inputs/${id}/image?token=${input.token}`;
  let created;
  try { created = await createHeyGenAvatar(c.env, `library-${id}-${now()}`, url); } catch (e) { throw heygenFailure(e); }
  const next: RecordData = { ...record, heygen: { lookId: created.lookId, groupId: created.groupId, status: "processing" }, heygenInput: input, updatedAt: now() };
  await save(c.env, id, next);
  return c.json({ avatar: publicAvatar(id, next, true) }, 202);
});
/** Refreshes a linked avatar's state (HeyGen needs a minute or two to create one). */
adminAvatars.post("/:id/heygen/check", async c => {
  requireHeyGen(c.env);
  const id = c.req.param("id"), record = await resolve(c.env, id);
  if (!record.heygen) throw new HTTPException(404, { message: "Аватарът не е свързан с HeyGen." });
  let look;
  try { look = await getHeyGenLook(c.env, record.heygen.lookId); } catch (e) { throw heygenFailure(e); }
  const status = look.status === "processing" ? "processing" : look.status === "completed" && look.avatarIII ? "ready" : "failed";
  const { heygenInput, ...rest } = record;
  const next: RecordData = { ...rest, ...(status === "processing" && heygenInput ? { heygenInput } : {}),
    heygen: { ...record.heygen, groupId: look.groupId || record.heygen.groupId, status, engines: look.engines }, updatedAt: now() };
  await save(c.env, id, next);
  return c.json({ avatar: publicAvatar(id, next, true) });
});
