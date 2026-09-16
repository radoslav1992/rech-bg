import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { isStudioVoice, resolveStudioVoice, studioVoiceCatalog, studioVoiceKey, studioVoiceSchema } from "./studio-voices";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { voiceList, sampleSentence } from "../shared/catalog";
import type { Env, ContextVars, DbUser } from "./types";
import { uid, now, ready } from "./types";
import { sha, rate, checkPassword, hashPassword } from "./security";
import { auth, isAdmin } from "./auth";
import { billing, webhook, allowance, stripe } from "./billing";
import { billingFailure } from "./billing-errors";
import { segments, voiceMap, TTS_MODEL, decodeAudio, wavHeader } from "./audio";
import { withDefaults } from "./config";
import { studio } from "./studio";
import { validateStudioScript } from "../shared/studio";
import { videos, videoInputs } from "./video";
import { notifyVideo } from "./video-notifications";
import { jobStorage } from './media-storage';
import { mediaError } from './media';
import { media, mediaInputs } from './media';
import { maintainMedia } from './media-maintenance';
export { MediaGeneration } from './media-workflow';
export { MediaRenderer } from './media-container';
export { AudioGeneration } from "./workflow";
export { VideoGeneration } from "./video-workflow";
const app = new Hono<{ Bindings: Env; Variables: ContextVars }>();
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'",
  );
  if (new URL(c.req.url).protocol === "https:")
    c.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  if (c.req.path.startsWith("/api/") && !c.req.path.startsWith("/api/voices/"))
    c.header("Cache-Control", "no-store");
});
app.use(
  "/api/media/uploads/:id/parts/:part",
  bodyLimit({ maxSize: 8 * 1024 * 1024, onError: c => c.json({error: "Фрагментът е твърде голям."}, 413) }),
);
app.use(
  "/api/*",
  async (c, next) => { if (/^\/api\/media\/uploads\/[^/]+\/parts\/\d+$/.test(c.req.path)) return next(); return bodyLimit({
    maxSize: 3 * 1024 * 1024,
    onError: (c) =>
      c.json({ error: "Файлът или заявката е твърде голяма." }, 413),
  })(c, next); },
);
app.use("/api/*", async (c, next) => {
  if (!["GET", "HEAD"].includes(c.req.method) && c.req.path !== "/api/billing/webhook") {
    const supplied = c.req.header("Origin");
    const allowed = new URL(c.env.SITE_URL || c.req.url).origin;
    if (supplied !== allowed)
      throw new HTTPException(403, {
        message: "Невалиден произход на заявката.",
      });
  }
  await next();
});
app.post("/api/billing/webhook", async (c) =>
  c.json(await webhook(c.req.raw, c.env)),
);
app.get("/api/public/config", (c) =>
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
app.get("/api/voices", async (c) => {
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
app.get("/api/voices/:id/sample", async (c) => {
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
app.post("/api/contact", async (c) => {
  await rate(c, "contact", 5);
  const body = await c.req.json();
  if (body.website) return c.json({ ok: true });
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
app.route("/api/video-inputs", videoInputs);
app.route("/api/media-inputs", mediaInputs);
app.use("/api/*", async (c, next) => {
  const t = getCookie(c, "rech_session");
  if (t) {
    const hash = await sha(t);
    const u = await c.env.DB.prepare(
      "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?",
    )
      .bind(hash, now())
      .first<DbUser>();
    if (u) {
      c.set("user", u);
      c.set("session", hash);
    }
  }
  await next();
});
app.route("/api/auth", auth);
app.use("/api/*", async (c, next) => {
  if (!c.get("user"))
    throw new HTTPException(401, { message: "Влезте в профила си." });
  await next();
});
app.route("/api/billing", billing);
app.route("/api/videos", videos);
app.route("/api/video-studio", studio);
app.route("/api/media", media);
const projectSchema = z.object({
  title: z.string().trim().min(1).max(120),
  mode: z.enum(["tts", "podcast", "voiceover", "studio"]),
  script: z.string().max(14000),
  voice: z.string().refine((s) => !!voiceMap[s] || isStudioVoice(s)),
  second_voice: z.string().refine((s) => !!voiceMap[s]),
  pause_ms: z.number().int().min(0).max(1500).default(400),
}).refine(p => p.mode === "studio" ? isStudioVoice(p.voice) && p.script.length <= 1500 : !!voiceMap[p.voice], { message: "Невалиден глас или сценарий за този тип проект." });
app.get("/api/projects", async (c) => {
  const r = await c.env.DB.prepare(
    "SELECT p.*,j.id AS latest_job,j.status,j.duration FROM projects p LEFT JOIN jobs j ON j.id=(SELECT id FROM jobs WHERE project_id=p.id ORDER BY created_at DESC, rowid DESC LIMIT 1) WHERE p.user_id=? ORDER BY p.updated_at DESC LIMIT 100",
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ projects: r.results });
});
app.get("/api/projects/:id", async (c) => {
  const p = await c.env.DB.prepare(
    "SELECT * FROM projects WHERE id=? AND user_id=?",
  )
    .bind(c.req.param("id"), c.get("user").id)
    .first();
  if (!p) throw new HTTPException(404, { message: "Проектът не е намерен." });
  return c.json({ project: p });
});
app.post("/api/projects", async (c) => {
  await rate(c, "project-create", 100, 3600, c.get("user").id);
  const d = projectSchema.parse(await c.req.json());
  if (d.mode === "studio") await resolveStudioVoice(c.env, d.voice);
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) n FROM projects WHERE user_id=?",
  )
    .bind(c.get("user").id)
    .first<{ n: number }>();
  if ((count?.n || 0) >= 100)
    throw new HTTPException(400, {
      message: "Имате 100 проекта. Изтрийте ненужните, за да добавите нов.",
    });
  const id = uid();
  await c.env.DB.prepare(
    "INSERT INTO projects(id,user_id,title,mode,script,voice,second_voice,pause_ms,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      c.get("user").id,
      d.title,
      d.mode,
      d.script,
      d.voice,
      d.second_voice,
      d.pause_ms,
      now(),
      now(),
    )
    .run();
  return c.json({ id });
});
app.put("/api/projects/:id", async (c) => {
  const d = projectSchema.parse(await c.req.json());
  if (d.mode === "studio") await resolveStudioVoice(c.env, d.voice);
  const r = await c.env.DB.prepare(
    "UPDATE projects SET title=?,mode=?,script=?,voice=?,second_voice=?,pause_ms=?,updated_at=? WHERE id=? AND user_id=?",
  )
    .bind(
      d.title,
      d.mode,
      d.script,
      d.voice,
      d.second_voice,
      d.pause_ms,
      now(),
      c.req.param("id"),
      c.get("user").id,
    )
    .run();
  if (!r.meta.changes)
    throw new HTTPException(404, { message: "Проектът не е намерен." });
  return c.json({ ok: true });
});
app.delete("/api/projects/:id", async (c) => {
  const user = c.get("user"),
    id = c.req.param("id");
  if (c.env.MEDIA_ENABLED === "true" && await c.env.DB.prepare("SELECT id FROM media_tasks WHERE user_id=? AND status IN ('queued','running')").bind(c.get("user").id).first()) throw new HTTPException(409,{message:"Изчакайте медийната обработка да завърши."});
  const noActive =
    "NOT EXISTS(SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','running'))";
  // Capture cleanup paths inside the deletion transaction so a concurrently completed job is included.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) SELECT 'segments/'||user_id||'/'||id||'/',? FROM jobs WHERE project_id=? AND user_id=? AND " +
        noActive,
    ).bind(now(), id, user.id, id),
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) SELECT 'audio/'||user_id||'/'||id||'.',? FROM jobs WHERE project_id=? AND user_id=? AND " +
        noActive,
    ).bind(now(), id, user.id, id),
    c.env.DB.prepare(
      "DELETE FROM projects WHERE id=? AND user_id=? AND " + noActive,
    ).bind(id, user.id, id),
  ]);
  if (!results[2].meta.changes)
    throw new HTTPException(409, {
      message:
        "Проектът не съществува или има активен запис. Изчакайте и опитайте отново.",
    });
  c.executionCtx.waitUntil(drainCleanup(c.env));
  return c.json({ ok: true });
});
app.post("/api/generate", async (c) => {
  const u = c.get("user");
  if (!u.verified)
    throw new HTTPException(403, {
      message: "Потвърдете имейла си, за да създадете запис.",
    });
  await rate(c, "generate", 30, 3600, u.id);
  const d = z
    .object({ projectId: z.uuid(), idempotencyKey: z.uuid(), credits: z.number().int().positive().optional() })
    .parse(await c.req.json());
  const previous = await c.env.DB.prepare(
    "SELECT id FROM jobs WHERE user_id=? AND idempotency_key=?",
  )
    .bind(u.id, d.idempotencyKey)
    .first<{ id: string }>();
  if (previous) return c.json({ id: previous.id });
  const p = await c.env.DB.prepare(
    "SELECT * FROM projects WHERE id=? AND user_id=?",
  )
    .bind(d.projectId, u.id)
    .first<any>();
  if (!p) throw new HTTPException(404, { message: "Проектът не е намерен." });
  if (p.mode === "studio" && !c.env.ELEVENLABS_API_KEY?.trim())
    throw new HTTPException(503, { message: "Озвучаването във видео студиото още не е активирано." });
  if (p.mode === "studio") await resolveStudioVoice(c.env, p.voice);
  let turns;
  try {
    if (p.mode === "studio") validateStudioScript(p.script);
    turns = p.mode === "studio" ? [{ text: p.script, voice: p.voice }] : segments(p.script, p.mode, p.voice, p.second_voice);
  } catch (e) {
    throw new HTTPException(400, { message: (e as Error).message });
  }
  const chars = turns.reduce((s, t) => s + t.text.length, 0) * (p.mode === "studio" ? 3 : 1);
  if (p.mode === "studio" && d.credits !== chars)
    throw new HTTPException(409, { message: "Сценарият или цената се промени. Прегледайте сумата и опитайте отново." });
  if (chars < 1 || chars > 10000 || turns.length > 40)
    throw new HTTPException(400, {
      message: "Записът трябва да е до 10 000 символа и до 40 реплики/части.",
    });
  const a = await allowance(c.env, u);
  const id = uid();
  try {
    await c.env.DB.batch([c.env.DB.prepare(
      "INSERT INTO jobs(id,user_id,project_id,window_id,idempotency_key,title,mode,script,voice,second_voice,pause_ms,chars,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        u.id,
        p.id,
        a.window,
        d.idempotencyKey,
        p.title,
        p.mode,
        p.script,
        p.voice,
        p.second_voice,
        p.pause_ms,
        chars,
        now(),
        now(),
      ), ...(await jobStorage(c.env,u,id,p.title,"audio"))
      ]);
  } catch (e) {
    const msg = String(e);
    if (msg.includes("QUOTA_EXCEEDED"))
      throw new HTTPException(402, {
        message:
          "Недостатъчно кредити. Изберете по-висок план или съкратете текста.",
      });
    if (msg.includes("UNIQUE")) {
      const existing = await c.env.DB.prepare(
        "SELECT id FROM jobs WHERE user_id=? AND idempotency_key=?",
      )
        .bind(u.id, d.idempotencyKey)
        .first<{ id: string }>();
      if (existing) return c.json({ id: existing.id });
      throw new HTTPException(409, {
        message: "Вече се създава запис. Изчакайте той да завърши.",
      });
    }
    mediaError(e);
  }
  // Preserve the reservation on ambiguous create errors. Cron reconciles by deterministic workflow ID.
  try {
    await c.env.GENERATION.create({ id, params: { jobId: id } });
  } catch {
    console.error("Workflow dispatch requires reconciliation", { jobId: id });
  }
  return c.json({ id }, 202);
});
const publicJob = (j: any) => {
  const meta = j.kind === "video" ? JSON.parse(j.video_meta || "{}") : {};
  return ({
  id: j.id, project_id: j.project_id, title: j.title, status: j.status,
  chars: j.chars, duration: j.duration, created_at: j.created_at, error: j.error,
  kind: j.kind || "audio", video_tier: ["low", "medium", "high"].includes(meta.tier) ? meta.tier : j.video_tier || null,
  source_job_id: j.source_job_id || null, mode: j.mode,
  video_phase: ["queued", "processing", "saving"].includes(meta.phase) ? meta.phase : null,
  notify_email: meta.notifyEmail === true,
  email_status: ["sending", "sent", "failed"].includes(meta.emailStatus) ? meta.emailStatus : null,
});
};
app.get("/api/jobs", async (c) => {
  const jobs = (
    await c.env.DB.prepare(
      "SELECT * FROM jobs WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 100",
    )
      .bind(c.get("user").id)
      .all()
  ).results;
  return c.json({ jobs: jobs.map(publicJob) });
});
app.get("/api/jobs/:id", async (c) => {
  const job = await c.env.DB.prepare(
    "SELECT * FROM jobs WHERE id=? AND user_id=?",
  )
    .bind(c.req.param("id"), c.get("user").id)
    .first();
  if (!job) throw new HTTPException(404, { message: "Записът не е намерен." });
  return c.json({ job: publicJob(job) });
});
app.get("/api/jobs/:id/:media", async (c) => {
  const video = c.req.param("media") === "video";
  if (!video && c.req.param("media") !== "audio") throw new HTTPException(404);
  const row = await c.env.DB.prepare(
    "SELECT * FROM jobs WHERE id=? AND user_id=? AND status='completed'",
  )
    .bind(c.req.param("id"), c.get("user").id)
    .first<any>();
  const key = video ? row?.video_key : row?.audio_key;
  if (!key) throw new HTTPException(404, { message: "Записът не е готов." });
  const range = c.req.header("Range");
  const object = await c.env.AUDIO.get(
    key,
    range ? { range: c.req.raw.headers } : undefined,
  );
  if (!object)
    throw new HTTPException(404, { message: "Записът не е наличен." });
  const h = new Headers({
    "Content-Type": video ? "video/mp4" : "audio/wav",
    "Cache-Control": "private,no-store",
    "Accept-Ranges": "bytes",
    "Content-Disposition": `${c.req.query("download") ? "attachment" : "inline"}; filename="rech-${c.req.param("id")}.${video ? "mp4" : "wav"}"`,
  });
  let status = 200;
  if (object.range && "offset" in object.range && "length" in object.range) {
    const { offset = 0, length = object.size } = object.range;
    h.set(
      "Content-Range",
      `bytes ${offset}-${offset + length - 1}/${object.size}`,
    );
    h.set("Content-Length", String(length));
    status = 206;
  } else h.set("Content-Length", String(object.size));
  return new Response(object.body, { headers: h, status });
});
app.put("/api/settings", async (c) => {
  const d = z
    .object({ name: z.string().trim().min(2).max(80) })
    .parse(await c.req.json());
  await c.env.DB.prepare("UPDATE users SET name=? WHERE id=?")
    .bind(d.name, c.get("user").id)
    .run();
  return c.json({ ok: true });
});
app.post("/api/settings/password", async (c) => {
  const d = z
    .object({
      currentPassword: z.string().max(128),
      password: z.string().min(10).max(128),
    })
    .parse(await c.req.json());
  await rate(c, "password-change", 5, 3600, c.get("user").id);
  if (!(await checkPassword(d.currentPassword, c.get("user").password_hash)))
    throw new HTTPException(400, { message: "Текущата парола е неправилна." });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(
      await hashPassword(d.password),
      c.get("user").id,
    ),
    c.env.DB.prepare(
      "DELETE FROM sessions WHERE user_id=? AND token_hash<>?",
    ).bind(c.get("user").id, c.get("session")),
    c.env.DB.prepare("DELETE FROM auth_tokens WHERE user_id=?").bind(
      c.get("user").id,
    ),
  ]);
  return c.json({ ok: true });
});
app.get("/api/settings/export", async (c) => {
  const u = c.get("user");
  const projects = (
    await c.env.DB.prepare("SELECT * FROM projects WHERE user_id=?")
      .bind(u.id)
      .all()
  ).results;
  const jobs = (
    await c.env.DB.prepare(
      "SELECT * FROM jobs WHERE user_id=?",
    )
      .bind(u.id)
      .all()
  ).results;
  const subscriptions = (
    await c.env.DB.prepare(
      "SELECT plan,status,period_start,period_end FROM subscriptions WHERE user_id=?",
    )
      .bind(u.id)
      .all()
  ).results;
  return new Response(
    JSON.stringify(
      {
        profile: { name: u.name, email: u.email, created_at: u.created_at },
        projects,
        jobs: jobs.map((j: any) => ({ ...publicJob(j), script: j.script, voice: j.voice, second_voice: j.second_voice })),
        subscriptions,
      },
      null,
      2,
    ),
    {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="rech-bg-data.json"',
      },
    },
  );
});
app.delete("/api/settings/account", async (c) => {
  await rate(c, "account-delete", 5, 3600, c.get("user").id);
  const d = z
    .object({ password: z.string().max(128) })
    .parse(await c.req.json());
  const u = c.get("user");
  if (!(await checkPassword(d.password, u.password_hash)))
    throw new HTTPException(400, { message: "Паролата е неправилна." });
  if (u.stripe_customer) {
    const list = await stripe(c.env).subscriptions.list({
      customer: u.stripe_customer,
      status: "all",
      limit: 100,
    });
    if (
      list.data.some(
        (s) => !["canceled", "incomplete_expired"].includes(s.status),
      )
    )
      throw new HTTPException(409, {
        message:
          "Първо прекратете абонамента и изчакайте края на платения период.",
      });
  }
  if (
    await c.env.DB.prepare(
      "SELECT id FROM jobs WHERE user_id=? AND status IN ('queued','running')",
    )
      .bind(u.id)
      .first()
  )
    throw new HTTPException(409, {
      message: "Изчакайте текущия запис да завърши.",
    });
  if (c.env.MEDIA_ENABLED === "true" && await c.env.DB.prepare("SELECT id FROM media_tasks WHERE user_id=? AND status IN ('queued','running')").bind(c.get("user").id).first()) throw new HTTPException(409,{message:"Изчакайте медийната обработка да завърши."});
  const noActive =
    "NOT EXISTS(SELECT 1 FROM jobs WHERE user_id=? AND status IN ('queued','running'))";
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) SELECT ?,? WHERE " +
        noActive,
    ).bind(`audio/${u.id}/`, now(), u.id),
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) SELECT ?,? WHERE " +
        noActive,
    ).bind(`segments/${u.id}/`, now(), u.id),
    c.env.DB.prepare("DELETE FROM users WHERE id=? AND " + noActive).bind(
      u.id,
      u.id,
    ),
  ]);
  if (!results[2].meta.changes)
    throw new HTTPException(409, {
      message: "Има активен запис. Изчакайте и опитайте отново.",
    });
  c.executionCtx.waitUntil(drainCleanup(c.env));
  return c.json({ ok: true });
});
app.use("/api/admin/*", async (c, next) => {
  if (!isAdmin(c.env, c.get("user")))
    throw new HTTPException(403, { message: "Нямате достъп." });
  await next();
});
app.get("/api/admin/messages", async (c) =>
  c.json({
    messages: (
      await c.env.DB.prepare(
        "SELECT * FROM contact_messages ORDER BY created_at DESC, rowid DESC LIMIT 100",
      ).all()
    ).results,
  }),
);
app.get("/api/admin/studio-voices", async c => c.json({
  enabled: !!c.env.ELEVENLABS_API_KEY?.trim(), voices: await studioVoiceCatalog(c.env),
}));
app.post("/api/admin/studio-voices", async c => {
  await rate(c, "studio-voice-create", 60, 3600, c.get("user").id);
  const configuration = studioVoiceSchema.parse(await c.req.json());
  const id = `studio-${uid()}`;
  await c.env.AUDIO.put(studioVoiceKey(id), JSON.stringify(configuration), { httpMetadata: { contentType: "application/json" } });
  return c.json({ voice: await resolveStudioVoice(c.env, id) }, 201);
});
app.put("/api/admin/studio-voices/:id", async c => {
  const id = c.req.param("id");
  await resolveStudioVoice(c.env, id);
  const configuration = studioVoiceSchema.parse(await c.req.json());
  await c.env.AUDIO.put(studioVoiceKey(id), JSON.stringify(configuration), { httpMetadata: { contentType: "application/json" } });
  return c.json({ voice: await resolveStudioVoice(c.env, id) });
});
app.delete("/api/admin/studio-voices/:id", async c => {
  const id = c.req.param("id"), voice = await resolveStudioVoice(c.env, id, true);
  // A tombstone prevents built-in voices from reappearing. Keep the mapping for already-queued jobs.
  await c.env.AUDIO.put(studioVoiceKey(id), JSON.stringify({ ...studioVoiceSchema.parse(voice), removed: true }), { httpMetadata: { contentType: "application/json" } });
  return c.json({ ok: true });
});
app.post("/api/admin/voices/:id/sample/generate", async (c) => {
  const id = c.req.param("id");
  if (!Object.hasOwn(voiceMap, id) && !isStudioVoice(id))
    throw new HTTPException(400, { message: "Невалиден глас." });
  await rate(c, "sample-generation", 60, 3600, c.get("user").id);
  if (isStudioVoice(id)) {
    if (!c.env.ELEVENLABS_API_KEY?.trim()) throw new HTTPException(503, { message: "Добавете ELEVENLABS_API_KEY в Cloudflare, за да генерирате примери." });
    const voice = await resolveStudioVoice(c.env, id);
    try {
      const client = new ElevenLabsClient({ apiKey: c.env.ELEVENLABS_API_KEY.trim() });
      const result = await client.textToSpeech.convertWithTimestamps(voice.providerVoiceId, {
        text: sampleSentence, modelId: "eleven_v3", languageCode: "bg", outputFormat: "pcm_24000",
      }, { maxRetries: 0, timeoutInSeconds: 90 });
      if (!result.audioBase64 || result.audioBase64.length > 3_000_000) throw new Error("Invalid sample");
      const pcm = Uint8Array.from(atob(result.audioBase64), c => c.charCodeAt(0));
      if (!pcm.length || pcm.length % 2 || pcm.length + 44 > 2 * 1024 * 1024) throw new Error("Invalid sample size");
      const wav = new Uint8Array(pcm.length + 44); wav.set(wavHeader(pcm.length, 24000)); wav.set(pcm, 44);
      return new Response(wav, { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-Voice-Revision": voice.revision } });
    } catch {
      throw new HTTPException(502, { message: "Примерът не беше създаден. Проверете Voice ID, достъпа до гласа и наличните кредити в ElevenLabs." });
    }
  }
  try {
    const result = (await c.env.AI.run(TTS_MODEL, {
      text: sampleSentence,
      voice: voiceMap[id],
    })) as { audio?: string };
    if (!result?.audio) throw new Error("Missing audio");
    const { pcm, rate: sampleRate } = decodeAudio(result.audio);
    if (pcm.length + 44 > 2 * 1024 * 1024)
      throw new Error("Sample too large");
    const wav = new Uint8Array(pcm.length + 44);
    wav.set(wavHeader(pcm.length, sampleRate));
    wav.set(pcm, 44);
    return new Response(wav, {
      headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
    });
  } catch {
    throw new HTTPException(502, {
      message: "Примерът не беше създаден. Опитайте отново след малко.",
    });
  }
});
app.post("/api/admin/voices/:id/sample", async (c) => {
  const id = c.req.param("id");
  if (!voiceMap[id] && !isStudioVoice(id))
    throw new HTTPException(400, { message: "Невалиден глас." });
  const form = await c.req.formData();
  const studioVoice = isStudioVoice(id) ? await resolveStudioVoice(c.env, id) : null;
  if (studioVoice && form.get("voiceRevision") !== studioVoice.revision)
    throw new HTTPException(409, { message: "Гласът е променен. Презаредете настройките и създайте нов пример." });
  const file = form.get("file");
  if (!(file instanceof File) || file.size > 2 * 1024 * 1024 || file.size < 44)
    throw new HTTPException(400, {
      message: "Качете WAV или MP3 файл до 2 MB.",
    });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  const wav =
    tag === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE";
  const mp3 =
    tag.startsWith("ID3") || (bytes[0] === 255 && (bytes[1] & 224) === 224);
  if (!wav && !mp3)
    throw new HTTPException(400, {
      message: "Невалиден аудио файл. Използвайте WAV или MP3.",
    });
  const mime = wav ? "audio/wav" : "audio/mpeg",
    key = studioVoice ? `samples/${id}/${studioVoice.revision}/${crypto.randomUUID()}.${wav ? "wav" : "mp3"}` : `samples/${id}.${wav ? "wav" : "mp3"}`;
  const old = await c.env.DB.prepare(
    "SELECT object_key FROM voice_samples WHERE voice_id=?",
  )
    .bind(id)
    .first<{ object_key: string }>();
  await c.env.AUDIO.put(key, bytes, { httpMetadata: { contentType: mime } });
  await c.env.DB.prepare(
    "INSERT INTO voice_samples(voice_id,object_key,mime,updated_at) VALUES (?,?,?,?) ON CONFLICT(voice_id) DO UPDATE SET object_key=excluded.object_key,mime=excluded.mime,updated_at=excluded.updated_at",
  )
    .bind(id, key, mime, now())
    .run();
  if (old && old.object_key !== key) await c.env.AUDIO.delete(old.object_key);
  return c.json({ ok: true });
});
app.delete("/api/admin/voices/:id/sample", async (c) => {
  const row = await c.env.DB.prepare(
    "DELETE FROM voice_samples WHERE voice_id=? RETURNING object_key",
  )
    .bind(c.req.param("id"))
    .first<{ object_key: string }>();
  if (row) await c.env.AUDIO.delete(row.object_key);
  return c.json({ ok: true });
});
app.all("/api/*", (c) => c.json({ error: "Страницата не е намерена." }, 404));
app.get("/robots.txt", (c) =>
  c.text(
    "User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api\nDisallow: /reset\nDisallow: /verify\n",
  ),
);
app.get("*", async (c) => {
  const path = c.req.path;
  const titles: Record<string, string> = {
    "/": "Дайте глас на думите си",
    "/pricing": "Цени",
    "/voices": "30 гласа на български",
    "/about": "За нас",
    "/contact": "Контакт",
    "/terms": "Общи условия",
    "/privacy": "Поверителност",
    "/cookies": "Бисквитки",
    "/refunds": "Отказ и възстановяване",
    "/login": "Вход",
    "/register": "Регистрация",
  };
  const r = await c.env.ASSETS.fetch(c.req.raw);
  if (!r.headers.get("content-type")?.includes("text/html")) return r;
  const result = new HTMLRewriter()
    .on("title", {
      element(el) {
        el.setInnerContent(
          (titles[path] || "Вашето аудио студио") + " — Реч БГ",
        );
      },
    })
    .on("head", {
      element(el) {
        if (
          path.startsWith("/app") ||
          ["/reset", "/verify", "/login", "/register", "/forgot"].includes(path)
        )
          el.append('<meta name="robots" content="noindex,nofollow">', {
            html: true,
          });
      },
    })
    .transform(r);
  return result;
});
app.onError((e, c) => {
  if (e instanceof HTTPException) return c.json({ error: e.message }, e.status);
  if (e instanceof z.ZodError)
    return c.json(
      {
        error:
          "Проверете въведените данни. " +
          e.issues.map((x) => x.path.join(".")).join(", "),
      },
      400,
    );
  if (c.req.path.startsWith("/api/billing/"))
    return c.json(billingFailure(e), 503);
  console.error("Request failed", { path: c.req.path, error: e.name });
  return c.json(
    { error: "Услугата временно не е достъпна. Опитайте отново след малко." },
    503,
  );
});
async function deletePrefix(e: Env, prefix: string) {
  let cursor: string | undefined;
  do {
    const list = await e.AUDIO.list({ prefix, cursor });
    if (list.objects.length)
      await e.AUDIO.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}
async function drainCleanup(e: Env) {
  const tasks = (
    await e.DB.prepare(
      "SELECT prefix FROM cleanup_tasks ORDER BY created_at LIMIT 100",
    ).all<{ prefix: string }>()
  ).results;
  for (const task of tasks) {
    try {
      await deletePrefix(e, task.prefix);
      await e.DB.prepare("DELETE FROM cleanup_tasks WHERE prefix=?")
        .bind(task.prefix)
        .run();
    } catch {
      console.error("Storage cleanup will retry");
    }
  }
}
export async function maintenance(e: Env) {
  if (e.MEDIA_ENABLED === "true") await maintainMedia(e);
  await drainCleanup(e);
  await e.DB.batch([
    e.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(now()),
    e.DB.prepare("DELETE FROM auth_tokens WHERE expires_at<?").bind(now()),
    e.DB.prepare("DELETE FROM rate_limits WHERE expires_at<?").bind(now()),
    e.DB.prepare("DELETE FROM contact_messages WHERE created_at<?").bind(
      now() - 365 * 86400,
    ),
    e.DB.prepare("DELETE FROM users WHERE verified=0 AND created_at<?").bind(
      now() - 7 * 86400,
    ),
  ]);
  const jobs = (
    await e.DB.prepare(
      "SELECT * FROM jobs WHERE status IN ('queued','running') AND updated_at<? LIMIT 100",
    )
      .bind(now() - 600)
      .all<any>()
  ).results;
  for (const j of jobs) {
    const workflow = j.kind === "video" ? e.VIDEO_GENERATION : e.GENERATION;
    if (!workflow) continue;
    try {
      const instance = await workflow.get(j.id);
      const status = await instance.status();
      if (["errored", "terminated"].includes(status.status)) {
        await e.DB.prepare(
          "UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status IN ('queued','running')",
        )
          .bind(
            "Генерацията беше прекъсната. Кредитите са върнати.",
            now(),
            j.id,
          )
          .run();
      }
    } catch {
      if (j.status === "queued") {
        try {
          await workflow.create({ id: j.id, params: { jobId: j.id } });
        } catch {
          console.error("Workflow reconciliation pending", { jobId: j.id });
        }
      }
    }
  }
  const old = (
    await e.DB.prepare(
      "SELECT id,user_id FROM jobs WHERE status IN ('failed','completed') AND updated_at<? ORDER BY updated_at DESC LIMIT 100",
    )
      .bind(now() - 86400)
      .all<any>()
  ).results;
  for (const j of old) await deletePrefix(e, `segments/${j.user_id}/${j.id}/`);
  // Read only matching metadata, keeping this compatible with audio-only rows.
  const notifications = (await e.DB.prepare("SELECT id FROM jobs WHERE kind='video' AND status IN ('completed','failed') AND json_extract(video_meta,'$.notifyEmail')=1 AND json_extract(video_meta,'$.emailStatus') IS NULL ORDER BY created_at DESC LIMIT 50").all<{ id: string }>()).results;
  for (const j of notifications) {
    try { await notifyVideo(e, j.id); }
    catch { console.error("Video notification reconciliation failed", { jobId: j.id }); }
  }
}
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, withDefaults(env), ctx),
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) =>
    ctx.waitUntil(maintenance(withDefaults(env))),
};
