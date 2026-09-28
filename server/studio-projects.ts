import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ContextVars, DbUser, Env } from "./types";
import { now } from "./types";
import { rate } from "./security";
import { findByIdempotencyKey } from "./db";
import { createMediaTask, exportQuote, exportSource, validDocument } from "./media";
import { captionKey } from "./studio-speech";
import { defaultCaptions } from "../shared/captions";
import { MB } from "../shared/media";
import { MAX_DOC_BYTES, projectDocSchema, sceneTimeline, type ProjectDoc } from "../shared/project";
import { speechRanges, timelineLength } from "../shared/timeline";

// Server-side video studio projects: the JSON document (scenes, timeline, media references) and its render.
export const studioProjects = new Hono<{ Bindings: Env; Variables: ContextVars }>();

type Stored = { document: ProjectDoc; revision: number };
export async function loadProjectDoc(e: Env, userId: string, projectId: string): Promise<Stored | null> {
  const row = await e.DB.prepare("SELECT document,revision FROM project_documents WHERE project_id=? AND user_id=?")
    .bind(projectId, userId)
    .first<{ document: string; revision: number }>();
  return row ? { document: projectDocSchema.parse(JSON.parse(row.document)), revision: row.revision } : null;
}
const conflictBody = (stored: Stored | null) => ({
  error: "Проектът е променен в друг прозорец или устройство. Заредихме последната версия.",
  document: stored?.document ?? null,
  revision: stored?.revision ?? 0,
});
const invalid = () => new HTTPException(400, { message: "Проектът съдържа файл или запис, който не е наличен." });

/** Checks that every reference added since the stored version belongs to this user and project. */
async function checkReferences(e: Env, userId: string, projectId: string, next: ProjectDoc, previous: ProjectDoc | null) {
  const known = new Set<string>();
  for (const s of previous?.scenes || []) {
    for (const id of [s.audioJobId, s.videoJobId, s.portrait?.type === "asset" ? s.portrait.id : null]) if (id) known.add(id);
  }
  if (previous?.music) known.add(previous.music.assetId);
  const fresh = (id: string | null | undefined): id is string => !!id && !known.has(id);
  for (const s of next.scenes) {
    if (!s.audioJobId && s.videoJobId) throw invalid();
    if (fresh(s.audioJobId)) {
      const audio = await e.DB.prepare("SELECT id FROM jobs WHERE id=? AND user_id=? AND project_id=? AND kind='audio'")
        .bind(s.audioJobId, userId, projectId).first();
      if (!audio) throw invalid();
    }
    if (fresh(s.videoJobId) || (s.videoJobId && fresh(s.audioJobId))) {
      const video = await e.DB.prepare("SELECT id FROM jobs WHERE id=? AND user_id=? AND kind='video' AND source_job_id=?")
        .bind(s.videoJobId, userId, s.audioJobId).first();
      if (!video) throw invalid();
    }
    if (s.portrait?.type === "asset" && fresh(s.portrait.id)) {
      const asset = await e.DB.prepare("SELECT id FROM media_assets WHERE id=? AND user_id=? AND kind IN ('portrait','variant','product') AND status='ready'")
        .bind(s.portrait.id, userId).first();
      if (!asset) throw invalid();
    }
  }
  if (next.music && fresh(next.music.assetId)) {
    const asset = await e.DB.prepare("SELECT id FROM media_assets WHERE id=? AND user_id=? AND kind='audio' AND job_id IS NULL AND status='ready'")
      .bind(next.music.assetId, userId).first();
    if (!asset) throw invalid();
  }
}
studioProjects.use("/:id/*", async (c, next) => {
  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id=? AND user_id=? AND mode='studio'")
    .bind(c.req.param("id"), c.get("user").id)
    .first();
  if (!project) throw new HTTPException(404, { message: "Проектът не е намерен." });
  await next();
});
studioProjects.get("/:id/document", async (c) => {
  const stored = await loadProjectDoc(c.env, c.get("user").id, c.req.param("id"));
  return c.json(stored ?? { document: null, revision: 0 });
});
studioProjects.put("/:id/document", async (c) => {
  const user = c.get("user").id, id = c.req.param("id");
  await rate(c, "project-document", 1200, 3600, user);
  const body = z.object({ document: z.unknown(), revision: z.number().int().min(0) }).parse(await c.req.json());
  const document = projectDocSchema.parse(body.document);
  const json = JSON.stringify(document);
  if (json.length > MAX_DOC_BYTES) throw new HTTPException(413, { message: "Проектът е твърде голям." });
  const stored = await loadProjectDoc(c.env, user, id);
  if ((stored?.revision ?? 0) !== body.revision) return c.json(conflictBody(stored), 409);
  await checkReferences(c.env, user, id, document, stored?.document ?? null);
  const result = stored
    ? await c.env.DB.prepare("UPDATE project_documents SET document=?,revision=revision+1,updated_at=? WHERE project_id=? AND user_id=? AND revision=?")
        .bind(json, now(), id, user, body.revision).run()
    : await c.env.DB.prepare("INSERT INTO project_documents(project_id,user_id,document,revision,updated_at) VALUES (?,?,?,1,?) ON CONFLICT(project_id) DO NOTHING")
        .bind(id, user, json, now()).run();
  // A concurrent save won between the read and the write.
  if (!result.meta.changes) return c.json(conflictBody(await loadProjectDoc(c.env, user, id)), 409);
  return c.json({ revision: body.revision + 1 });
});

// Server render of the timeline (voice offset, end hold, music envelope, captions) through the media renderer.
// Everything is read from the saved document and captions, never from the request, and snapshotted into the task.
async function renderPlan(e: Env, user: DbUser, projectId: string) {
  if (e.MEDIA_ENABLED !== "true" || !e.MEDIA_GENERATION || !e.MEDIA_RENDERER)
    throw new HTTPException(503, { message: "Експортът на сървъра временно не е достъпен." });
  const stored = await loadProjectDoc(e, user.id, projectId);
  const scene = stored?.document.scenes[0];
  if (!scene?.audioJobId || !scene.videoJobId)
    throw new HTTPException(400, { message: "Експортът се отключва, когато видео аватарът е готов." });
  const audio = await e.DB.prepare("SELECT audio_key,duration FROM jobs WHERE id=? AND user_id=? AND kind='audio' AND status='completed'")
    .bind(scene.audioJobId, user.id)
    .first<{ audio_key: string; duration: number }>();
  if (!audio?.audio_key) throw invalid();
  const video = await exportSource(e, user.id, scene.videoJobId);
  if (!video.generated) throw invalid();
  const saved = await e.AUDIO.get(captionKey(user.id, scene.audioJobId));
  const captions = validDocument(saved ? await new Response(saved.body).json() : defaultCaptions, audio.duration);
  const music = stored!.document.music;
  let musicKey: string | null = null;
  if (music) {
    const asset = await e.DB.prepare("SELECT object_key FROM media_assets WHERE id=? AND user_id=? AND kind='audio' AND job_id IS NULL AND status='ready' AND expires_at>?")
      .bind(music.assetId, user.id, now())
      .first<{ object_key: string }>();
    if (!asset) throw new HTTPException(400, { message: "Музиката вече не е налична. Качете я отново или я премахнете от монтажа." });
    musicKey = asset.object_key;
  }
  const settings = sceneTimeline(scene, music);
  const length = timelineLength(settings, audio.duration);
  const credits = await exportQuote(e, user.id, scene.videoJobId, length, true);
  return { scene, audio, video, captions, settings, length, credits, musicKey };
}
studioProjects.get("/:id/render/quote", async (c) => {
  const plan = await renderPlan(c.env, c.get("user"), c.req.param("id"));
  return c.json({ credits: plan.credits, length: plan.length });
});
studioProjects.post("/:id/render", async (c) => {
  const user = c.get("user");
  if (!user.verified) throw new HTTPException(403, { message: "Потвърдете имейла си." });
  const d = z.object({ idempotencyKey: z.uuid(), credits: z.number().int().min(0) }).parse(await c.req.json());
  const previous = await findByIdempotencyKey(c.env, "media_tasks", user.id, d.idempotencyKey);
  if (previous) return c.json({ id: previous.id });
  const plan = await renderPlan(c.env, user, c.req.param("id"));
  if (d.credits !== plan.credits)
    throw new HTTPException(409, { message: "Цената се промени. Обновете страницата." });
  const { settings, audio, captions } = plan;
  const id = await createMediaTask(c.env, user, {
    kind: "export",
    source: plan.scene.videoJobId!,
    key: d.idempotencyKey,
    credits: plan.credits,
    payload: {
      inputs: [plan.video.key, audio.audio_key, ...(plan.musicKey ? [plan.musicKey] : [])],
      document: captions,
      duration: plan.length,
      timeline: {
        speechStart: settings.speechStart,
        tail: settings.tail,
        voiceVolume: settings.voiceVolume,
        speechDuration: audio.duration,
        music: settings.music && {
          start: settings.music.start, volume: settings.music.volume, duck: settings.music.duck, fade: settings.music.fade,
          ranges: speechRanges(captions.words, settings, audio.duration),
        },
      },
    },
    outputs: 1,
    outputBytes: Math.ceil(plan.length * 650000) + 5 * MB,
  });
  return c.json({ id }, 202);
});
