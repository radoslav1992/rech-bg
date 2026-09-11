import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { voiceList } from "../shared/catalog";
import type { Env, ContextVars, DbUser } from "./types";
import { uid, now, ready } from "./types";
import { sha, rate, checkPassword, hashPassword } from "./security";
import { auth, isAdmin } from "./auth";
import { billing, webhook, allowance, stripe } from "./billing";
import { segments, voiceMap } from "./audio";
import { withDefaults } from "./config";
export { AudioGeneration } from "./workflow";
const app = new Hono<{ Bindings: Env; Variables: ContextVars }>();
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self' blob:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'",
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
  "/api/*",
  bodyLimit({
    maxSize: 3 * 1024 * 1024,
    onError: (c) =>
      c.json({ error: "Файлът или заявката е твърде голяма." }, 413),
  }),
);
app.use("/api/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.path !== "/api/billing/webhook") {
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
  const o = await c.env.AUDIO.get(row.object_key);
  if (!o) throw new HTTPException(404, { message: "Примерът не е наличен." });
  return new Response(o.body, {
    headers: {
      "Content-Type": row.mime,
      "Cache-Control": "public,max-age=3600",
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
const projectSchema = z.object({
  title: z.string().trim().min(1).max(120),
  mode: z.enum(["tts", "podcast", "voiceover"]),
  script: z.string().max(14000),
  voice: z.string().refine((s) => !!voiceMap[s]),
  second_voice: z.string().refine((s) => !!voiceMap[s]),
  pause_ms: z.number().int().min(0).max(1500).default(400),
});
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
  const noActive =
    "NOT EXISTS(SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','running'))";
  // Capture cleanup paths inside the deletion transaction so a concurrently completed job is included.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) SELECT 'segments/'||user_id||'/'||id||'/',? FROM jobs WHERE project_id=? AND user_id=? AND " +
        noActive,
    ).bind(now(), id, user.id, id),
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) SELECT 'audio/'||user_id||'/'||id||'.wav',? FROM jobs WHERE project_id=? AND user_id=? AND " +
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
    .object({ projectId: z.uuid(), idempotencyKey: z.uuid() })
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
  let turns;
  try {
    turns = segments(p.script, p.mode, p.voice, p.second_voice);
  } catch (e) {
    throw new HTTPException(400, { message: (e as Error).message });
  }
  const chars = turns.reduce((s, t) => s + t.text.length, 0);
  if (chars < 1 || chars > 10000 || turns.length > 40)
    throw new HTTPException(400, {
      message: "Записът трябва да е до 10 000 символа и до 40 реплики/части.",
    });
  const a = await allowance(c.env, u);
  const id = uid();
  try {
    await c.env.DB.prepare(
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
      )
      .run();
  } catch (e) {
    const msg = String(e);
    if (msg.includes("QUOTA_EXCEEDED"))
      throw new HTTPException(402, {
        message:
          "Недостатъчно символи. Изберете по-висок план или съкратете текста.",
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
    throw e;
  }
  // Preserve the reservation on ambiguous create errors. Cron reconciles by deterministic workflow ID.
  try {
    await c.env.GENERATION.create({ id, params: { jobId: id } });
  } catch {
    console.error("Workflow dispatch requires reconciliation", { jobId: id });
  }
  return c.json({ id }, 202);
});
app.get("/api/jobs", async (c) => {
  const jobs = (
    await c.env.DB.prepare(
      "SELECT id,project_id,title,status,chars,duration,created_at,error FROM jobs WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 100",
    )
      .bind(c.get("user").id)
      .all()
  ).results;
  return c.json({ jobs });
});
app.get("/api/jobs/:id", async (c) => {
  const job = await c.env.DB.prepare(
    "SELECT id,project_id,title,status,chars,duration,created_at,error FROM jobs WHERE id=? AND user_id=?",
  )
    .bind(c.req.param("id"), c.get("user").id)
    .first();
  if (!job) throw new HTTPException(404, { message: "Записът не е намерен." });
  return c.json({ job });
});
app.get("/api/jobs/:id/audio", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT audio_key FROM jobs WHERE id=? AND user_id=? AND status='completed'",
  )
    .bind(c.req.param("id"), c.get("user").id)
    .first<{ audio_key: string }>();
  if (!row) throw new HTTPException(404, { message: "Записът не е готов." });
  const range = c.req.header("Range");
  const object = await c.env.AUDIO.get(
    row.audio_key,
    range ? { range: c.req.raw.headers } : undefined,
  );
  if (!object)
    throw new HTTPException(404, { message: "Записът не е наличен." });
  const h = new Headers({
    "Content-Type": "audio/wav",
    "Cache-Control": "private,no-store",
    "Accept-Ranges": "bytes",
    "Content-Disposition": `${c.req.query("download") ? "attachment" : "inline"}; filename="rech-${c.req.param("id")}.wav"`,
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
      "SELECT id,project_id,title,mode,script,voice,second_voice,chars,duration,status,created_at FROM jobs WHERE user_id=?",
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
        jobs,
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
app.post("/api/admin/voices/:id/sample", async (c) => {
  const id = c.req.param("id");
  if (!voiceMap[id])
    throw new HTTPException(400, { message: "Невалиден глас." });
  const form = await c.req.formData();
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
    key = `samples/${id}.${wav ? "wav" : "mp3"}`;
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
      "SELECT id,user_id,status,created_at FROM jobs WHERE status IN ('queued','running') AND updated_at<? LIMIT 100",
    )
      .bind(now() - 600)
      .all<any>()
  ).results;
  for (const j of jobs) {
    try {
      const instance = await e.GENERATION.get(j.id);
      const status = await instance.status();
      if (["errored", "terminated"].includes(status.status)) {
        await e.DB.prepare(
          "UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status IN ('queued','running')",
        )
          .bind(
            "Генерацията беше прекъсната. Символите са върнати.",
            now(),
            j.id,
          )
          .run();
      }
    } catch {
      if (j.status === "queued") {
        try {
          await e.GENERATION.create({ id: j.id, params: { jobId: j.id } });
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
}
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, withDefaults(env), ctx),
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) =>
    ctx.waitUntil(maintenance(withDefaults(env))),
};
