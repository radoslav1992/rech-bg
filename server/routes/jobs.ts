import type { Env, ContextVars } from "../types";
import { Hono } from "hono";
import { findByIdempotencyKey } from "../db";
import { resolveStudioVoice } from "../studio-voices";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { uid, now } from "../types";
import { rate } from "../security";
import { allowance } from "../billing";
import { segments } from "../audio";
import { validateStudioScript } from "../../shared/studio";
import { jobStorage } from "../media-storage";
import { audioReserveBytes } from "../../shared/media";
import { mediaError } from "../media";
/** Starting audio generation and reading the user's jobs and their files. */
export const jobs = new Hono<{ Bindings: Env; Variables: ContextVars }>();
jobs.post("/api/generate", async (c) => {
  const u = c.get("user");
  if (!u.verified)
    throw new HTTPException(403, {
      message: "Потвърдете имейла си, за да създадете запис.",
    });
  await rate(c, "generate", 30, 3600, u.id);
  const d = z
    .object({ projectId: z.uuid(), idempotencyKey: z.uuid(), credits: z.number().int().positive().optional() })
    .parse(await c.req.json());
  const previous = await findByIdempotencyKey(c.env, "jobs", u.id, d.idempotencyKey);
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
      ), ...(await jobStorage(c.env,u,id,p.title,"audio",audioReserveBytes(turns.reduce((s, t) => s + t.text.length, 0), turns.length, p.pause_ms)))
      ]);
  } catch (e) {
    const msg = String(e);
    if (msg.includes("QUOTA_EXCEEDED"))
      throw new HTTPException(402, {
        message:
          "Недостатъчно кредити. Изберете по-висок план или съкратете текста.",
      });
    if (msg.includes("UNIQUE")) {
      const existing = await findByIdempotencyKey(c.env, "jobs", u.id, d.idempotencyKey);
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
export const publicJob = (j: any) => {
  const meta = j.kind === "video" ? JSON.parse(j.video_meta || "{}") : {};
  return ({
  id: j.id, project_id: j.project_id, title: j.title, status: j.status,
  chars: j.chars, duration: j.duration, created_at: j.created_at, error: j.error,
  kind: j.kind || "audio", video_tier: ["low", "medium", "high"].includes(meta.tier) ? meta.tier : j.video_tier || null,
  source_job_id: j.source_job_id || null, mode: j.mode,
  video_phase: ["preparing", "queued", "processing", "saving"].includes(meta.phase) ? meta.phase : null,
  notify_email: meta.notifyEmail === true,
  email_status: ["sending", "sent", "failed"].includes(meta.emailStatus) ? meta.emailStatus : null,
});
};
jobs.get("/api/jobs", async (c) => {
  const jobs = (
    await c.env.DB.prepare(
      "SELECT * FROM jobs WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 100",
    )
      .bind(c.get("user").id)
      .all()
  ).results;
  return c.json({ jobs: jobs.map(publicJob) });
});
jobs.get("/api/jobs/:id", async (c) => {
  const job = await c.env.DB.prepare(
    "SELECT * FROM jobs WHERE id=? AND user_id=?",
  )
    .bind(c.req.param("id"), c.get("user").id)
    .first();
  if (!job) throw new HTTPException(404, { message: "Записът не е намерен." });
  return c.json({ job: publicJob(job) });
});
jobs.get("/api/jobs/:id/:media", async (c) => {
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
