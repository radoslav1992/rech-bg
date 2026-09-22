import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { defaultAvatars, type LibraryAvatar } from "../shared/avatars";
import { rate } from "./security";
import { uid, now, type Env, type ContextVars } from "./types";

const prefix = "config/avatar-library/";
const key = (id: string) => `${prefix}${id}.json`;
const validId = (id: string) => /^(mila|boris|elena|avatar-[a-f0-9-]{36})$/.test(id);
const fields = z.object({
  name: z.string().trim().min(1).max(50),
  description: z.string().trim().min(1).max(180),
  category: z.enum(["business", "casual", "creative"]),
  presentation: z.enum(["female", "male"]),
});
const recordSchema = fields.extend({ active: z.boolean(), mime: z.enum(["image/jpeg", "image/png"]), updatedAt: z.number() });
type RecordData = z.infer<typeof recordSchema>;
async function resolve(env: Env, id: string): Promise<RecordData> {
  if (!validId(id)) throw new HTTPException(404, { message: "Аватарът не е наличен." });
  const stored = await env.AUDIO.get(key(id));
  if (stored) return recordSchema.parse(await new Response(stored.body).json());
  const base = defaultAvatars.find(a => a.id === id);
  if (!base) throw new HTTPException(404, { message: "Аватарът не е наличен." });
  return { ...base, active: true, mime: "image/jpeg", updatedAt: 0 };
}
function publicAvatar(id: string, record: RecordData): LibraryAvatar {
  const { name, description, category, presentation, active } = record;
  return { id, name, description, category, presentation, active, imageUrl: `/api/avatars/${id}/image` };
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
  const avatars = await Promise.all([...ids].map(async id => publicAvatar(id, await resolve(env, id))));
  return avatars.filter(a => admin || a.active);
}
type Bindings = { Bindings: Env; Variables: ContextVars };
export const avatars = new Hono<Bindings>();
avatars.get("/", async c => c.json({ avatars: await catalog(c.env) }));
avatars.get("/:id/image", async c => {
  const id = c.req.param("id"), record = await resolve(c.env, id);
  if (!record.active) throw new HTTPException(404, { message: "Аватарът е премахнат от библиотеката. Изберете друг." });
  const builtIn = defaultAvatars.some(a => a.id === id);
  const object = builtIn
    ? await c.env.ASSETS.fetch(new Request(`https://rechbg.com/images/avatar-library/${id}.jpg`))
    : await c.env.AUDIO.get(`library/avatars/${id}`);
  if (!object || (object instanceof Response && (!object.ok || !object.headers.get("Content-Type")?.startsWith("image/jpeg")))) throw new HTTPException(404, { message: "Изображението не е налично." });
  return new Response(object.body, { headers: { "Content-Type": record.mime, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
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
  return c.json({ avatar: publicAvatar(id, record) }, 201);
});
adminAvatars.put("/:id", async c => {
  const id = c.req.param("id"), old = await resolve(c.env, id);
  const data = fields.extend({ active: z.boolean() }).parse(await c.req.json());
  const record = { ...old, ...data, updatedAt: now() };
  await c.env.AUDIO.put(key(id), JSON.stringify(record), { httpMetadata: { contentType: "application/json" } });
  return c.json({ avatar: publicAvatar(id, record) });
});
adminAvatars.delete("/:id", async c => {
  const id = c.req.param("id"), record = await resolve(c.env, id);
  // A tombstone prevents defaults from returning on redeploy. Keep the image for restore;
  // jobs already have their own input copies and are unaffected by catalog edits.
  await c.env.AUDIO.put(key(id), JSON.stringify({ ...record, active: false, updatedAt: now() }), { httpMetadata: { contentType: "application/json" } });
  return c.json({ ok: true });
});
