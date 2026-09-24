import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ContextVars, Env } from "./types";
import { rate, sha } from "./security";
import { now } from "./types";
import { suggestDelivery } from "./studio-delivery";
import { captionKey } from "./studio-speech";
import { captionStyles, defaultCaptions } from "../shared/captions";
import { stripTags, validateStudioScript } from "../shared/studio";
import { publicStudioVoices } from "./studio-voices";
export const studio = new Hono<{ Bindings: Env; Variables: ContextVars }>();
studio.get("/config", async c => c.json({ enabled: !!c.env.ELEVENLABS_API_KEY?.trim(), voices: await publicStudioVoices(c.env) }));
studio.post("/delivery", async c => {
  if (!c.get("user").verified) throw new HTTPException(403, { message: "Потвърдете имейла си." });
  const { text, tone } = z.object({ text: z.string().max(1500), tone: z.enum(["ad", "story", "calm"]) }).parse(await c.req.json());
  try { validateStudioScript(text); } catch (e) { throw new HTTPException(400, { message: (e as Error).message }); }
  if (stripTags(text).length > 1495) throw new HTTPException(400, { message: "Съкратете сценария, за да оставите място за тагове за емоция (до 1500 символа общо)." });
  // Bound provider calls separately from the allowance of successful suggestions.
  await rate(c, "studio-delivery-attempts", 20, 3600, c.get("user").id);
  const day = Math.floor(now() / 86400);
  // New scope also releases users whose allowance was consumed by rejected text.
  const quotaKey = await sha(`studio-delivery-success-v2:${c.get("user").id}:${day}`);
  const reserved = await c.env.DB.prepare("INSERT INTO rate_limits(key,hits,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 WHERE hits<5 RETURNING hits")
    .bind(quotaKey, (day + 1) * 86400).first();
  if (!reserved) throw new HTTPException(429, { message: "Използвахте включените 5 предложения за емоции за днес. Можете да добавяте тагове ръчно или да опитате отново утре." });
  let success = false;
  try {
    const suggestion = await suggestDelivery(c.env, text, tone);
    success = true;
    return c.json({ text: suggestion });
  } finally {
    if (!success) await c.env.DB.prepare("UPDATE rate_limits SET hits=MAX(0,hits-1) WHERE key=?").bind(quotaKey).run();
  }
});
export const documentSchema = z.object({
  words: z.array(z.object({ text: z.string().trim().min(1).max(80).refine(s => !/[\[\]\r\n<>]/.test(s)), start: z.number().finite().min(0), end: z.number().finite().min(0) })).max(4000),
  style: z.enum(captionStyles), format: z.enum(["9:16", "1:1", "16:9", "4:5"]), position: z.enum(["bottom", "middle", "top"]), enabled: z.boolean(),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i).optional(), textColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  size: z.number().min(.7).max(1.4).optional(), uppercase: z.boolean().optional(),
  resolution: z.enum(["720p", "1080p"]).optional(), fit: z.enum(["contain", "cover"]).optional(),
});
studio.use("/captions/:id", async (c, next) => {
  const job = await c.env.DB.prepare("SELECT id FROM jobs WHERE id=? AND user_id=? AND mode='studio' AND kind='audio' AND status='completed'").bind(c.req.param("id"), c.get("user").id).first();
  if (!job) throw new HTTPException(404, { message: "Записът не е намерен." });
  await next();
});
studio.get("/captions/:id", async c => {
  const object = await c.env.AUDIO.get(captionKey(c.get("user").id, c.req.param("id")));
  return c.json(object ? await new Response(object.body).json() : defaultCaptions);
});
studio.put("/captions/:id", async c => {
  const document = documentSchema.parse(await c.req.json());
  const job = await c.env.DB.prepare("SELECT duration FROM jobs WHERE id=? AND user_id=?").bind(c.req.param("id"), c.get("user").id).first<{ duration: number }>();
  if (document.words.some((w, i) => w.end <= w.start || w.end > job!.duration + 0.1 || (i > 0 && w.start < document.words[i - 1].end)))
    throw new HTTPException(400, { message: "Времената трябва да са последователни, без застъпване и в рамките на записа." });
  await c.env.AUDIO.put(captionKey(c.get("user").id, c.req.param("id")), JSON.stringify(document), { httpMetadata: { contentType: "application/json" } });
  return c.json({ ok: true });
});
