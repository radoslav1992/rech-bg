import type { Env, ContextVars } from "../types";
import { Hono } from "hono";
import { isStudioVoice, resolveStudioVoice } from "../studio-voices";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { voiceList } from "../../shared/catalog";
import { uid, now, ready } from "../types";
import { rate } from "../security";
/** Unauthenticated API: site configuration, voice catalog and samples, contact form. */
export const publicRoutes = new Hono<{ Bindings: Env; Variables: ContextVars }>();
publicRoutes.get("/api/public/config", (c) =>
  c.json({
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || null,
    registrationEnabled: c.env.REGISTRATION_ENABLED === "true" && ready(c.env),
    company: {
      name: c.env.COMPANY_NAME || null,
      id: c.env.COMPANY_ID || null,
      address: c.env.COMPANY_ADDRESS || null,
      city: c.env.COMPANY_CITY || null,
      phone: c.env.CONTACT_PHONE || null,
      email: c.env.CONTACT_EMAIL || null,
    },
  }),
);
publicRoutes.get("/api/voices", async (c) => {
  let samples: any[] = [];
  try {
    samples = (
      await c.env.DB.prepare(
        "SELECT voice_id,updated_at FROM voice_samples",
      ).all()
    ).results;
  } catch {
    /* Public catalog still renders before database provisioning. */
  }
  return c.json({
    voices: voiceList.map((v) => ({
      ...v,
      sampleUrl: samples.some((s) => s.voice_id === v.id)
        ? `/api/voices/${v.id}/sample?v=${samples.find((s) => s.voice_id === v.id).updated_at}`
        : null,
    })),
  });
});
publicRoutes.get("/api/voices/:id/sample", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT * FROM voice_samples WHERE voice_id=?",
  )
    .bind(c.req.param("id"))
    .first<any>();
  if (!row) throw new HTTPException(404, { message: "Примерът предстои." });
  if (isStudioVoice(c.req.param("id"))) {
    const voice = await resolveStudioVoice(c.env, c.req.param("id"), true);
    if (voice.removed || !row.object_key.startsWith(`samples/${voice.id}/${voice.revision}/`))
      throw new HTTPException(404, { message: "Примерът предстои." });
  }
  const o = await c.env.AUDIO.get(row.object_key);
  if (!o) throw new HTTPException(404, { message: "Примерът не е наличен." });
  return new Response(o.body, {
    headers: {
      "Content-Type": row.mime,
      "Cache-Control": isStudioVoice(c.req.param("id")) ? "no-store" : "public,max-age=3600",
      "Content-Length": String(o.size),
    },
  });
});
publicRoutes.post("/api/contact", async (c) => {
  await rate(c, "contact", 5);
  const body = await c.req.json();
  if (body && typeof body === "object" && body.website) return c.json({ ok: true });
  const d = z
    .object({
      name: z.string().trim().min(2).max(100),
      email: z.email().max(254),
      message: z.string().trim().min(10).max(5000),
    })
    .parse(body);
  await c.env.DB.prepare(
    "INSERT INTO contact_messages(id,name,email,message,created_at) VALUES (?,?,?,?,?)",
  )
    .bind(uid(), d.name, d.email, d.message, now())
    .run();
  return c.json({ ok: true });
});
