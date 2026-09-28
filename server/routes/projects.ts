import type { Env, ContextVars } from "../types";
import { Hono } from "hono";
import { hasActiveMediaTask } from "../db";
import { isStudioVoice, resolveStudioVoice } from "../studio-voices";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { uid, now } from "../types";
import { rate } from "../security";
import { voiceMap } from "../audio";
import { drainCleanup } from "../maintenance";
/** Project CRUD for the signed-in user. */
export const projects = new Hono<{ Bindings: Env; Variables: ContextVars }>();
const projectSchema = z.object({
  title: z.string().trim().min(1).max(120),
  mode: z.enum(["tts", "podcast", "voiceover", "studio"]),
  script: z.string().max(14000),
  voice: z.string().refine((s) => Object.hasOwn(voiceMap, s) || isStudioVoice(s)),
  second_voice: z.string().refine((s) => Object.hasOwn(voiceMap, s)),
  pause_ms: z.number().int().min(0).max(1500).default(400),
}).refine(p => p.mode === "studio" ? isStudioVoice(p.voice) && p.script.length <= 1500 : Object.hasOwn(voiceMap, p.voice), { message: "Невалиден глас или сценарий за този тип проект." });
projects.get("/api/projects", async (c) => {
  const r = await c.env.DB.prepare(
    "SELECT p.*,j.id AS latest_job,j.status,j.duration FROM projects p LEFT JOIN jobs j ON j.id=(SELECT id FROM jobs WHERE project_id=p.id ORDER BY created_at DESC, rowid DESC LIMIT 1) WHERE p.user_id=? ORDER BY p.updated_at DESC LIMIT 100",
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ projects: r.results });
});
projects.get("/api/projects/:id", async (c) => {
  const p = await c.env.DB.prepare(
    "SELECT * FROM projects WHERE id=? AND user_id=?",
  )
    .bind(c.req.param("id"), c.get("user").id)
    .first();
  if (!p) throw new HTTPException(404, { message: "Проектът не е намерен." });
  return c.json({ project: p });
});
projects.post("/api/projects", async (c) => {
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
projects.put("/api/projects/:id", async (c) => {
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
projects.delete("/api/projects/:id", async (c) => {
  const user = c.get("user"),
    id = c.req.param("id");
  if (c.env.MEDIA_ENABLED === "true" && (await hasActiveMediaTask(c.env, user.id)))
    throw new HTTPException(409, { message: "Изчакайте медийната обработка да завърши." });
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
