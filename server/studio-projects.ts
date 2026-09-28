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
import { MAX_DOC_BYTES, MAX_PROJECT_SECONDS, projectDocSchema, sceneTimeline, type ProjectDoc } from "../shared/project";
import { speechRanges, timelineLength } from "../shared/timeline";
import { imageAssetKinds, videoAssetKinds } from "../shared/layers";

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

/** Media a scene's layers and background refer to, keyed by how each is used ("image:<id>", "broll:<id>", …). */
export const layerAssets = (s: ProjectDoc["scenes"][number]) => [
  ...s.layers.flatMap((l) => (l.type === "text" ? [] : [`${l.type}:${l.assetId}`])),
  ...(s.background?.type === "image" ? [`background:${s.background.assetId}`] : []),
];
async function ownedMedia(e: Env, userId: string, id: string, kinds: readonly string[], statuses: string[]) {
  return e.DB.prepare(
    `SELECT id,object_key,kind,mime,duration FROM media_assets WHERE id=? AND user_id=? AND kind IN (${kinds.map(() => "?").join(",")}) AND status IN (${statuses.map(() => "?").join(",")})`,
  )
    .bind(id, userId, ...kinds, ...statuses)
    .first<{ id: string; object_key: string; kind: string; mime: string; duration: number }>();
}
/** Checks that every reference added since the stored version belongs to this user and project. */
async function checkReferences(e: Env, userId: string, projectId: string, next: ProjectDoc, previous: ProjectDoc | null) {
  const known = new Set<string>();
  for (const s of previous?.scenes || []) {
    for (const id of [s.audioJobId, s.videoJobId, s.portrait?.type === "asset" ? s.portrait.id : null, ...s.history, ...layerAssets(s)]) if (id) known.add(id);
  }
  if (previous?.music) known.add(previous.music.assetId);
  const fresh = (id: string | null | undefined): id is string => !!id && !known.has(id);
  if (new Set(next.scenes.map((s) => s.id)).size !== next.scenes.length) throw invalid();
  for (const s of next.scenes) {
    if (!s.audioJobId && s.videoJobId) throw invalid();
    for (const audioId of new Set([s.audioJobId, ...s.history])) {
      if (!fresh(audioId)) continue;
      const audio = await e.DB.prepare("SELECT id FROM jobs WHERE id=? AND user_id=? AND project_id=? AND kind='audio'")
        .bind(audioId, userId, projectId).first();
      if (!audio) throw invalid();
    }
    if (fresh(s.videoJobId) || (s.videoJobId && fresh(s.audioJobId))) {
      const video = await e.DB.prepare("SELECT id FROM jobs WHERE id=? AND user_id=? AND kind='video' AND source_job_id=?")
        .bind(s.videoJobId, userId, s.audioJobId).first();
      if (!video) throw invalid();
    }
    // Checked per use: a file saved as B-roll must still pass the image checks when reused as an overlay.
    for (const layer of s.layers) {
      if (layer.type === "text" || !fresh(`${layer.type}:${layer.assetId}`)) continue;
      // Stills and overlays must be ready images; a B-roll video may still be under its automatic check.
      const kinds = layer.type === "image" ? imageAssetKinds : [...imageAssetKinds, ...videoAssetKinds];
      const statuses = layer.type === "image" ? ["ready"] : ["ready", "checking"];
      if (!(await ownedMedia(e, userId, layer.assetId, kinds, statuses))) throw invalid();
    }
    if (s.background?.type === "image" && fresh(`background:${s.background.assetId}`) && !(await ownedMedia(e, userId, s.background.assetId, imageAssetKinds, ["ready"])))
      throw invalid();
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
  if (!stored) throw new HTTPException(400, { message: "Експортът се отключва, когато видео аватарът е готов." });
  const music = stored.document.music;
  const scenes = [];
  // Layer media follows the scenes' own inputs; a file used the same way is sent once.
  const extras: string[] = [], extraIndex = new Map<string, number>();
  const extra = (key: string, objectKey: string) => {
    if (!extraIndex.has(key)) { extraIndex.set(key, extras.length); extras.push(objectKey); }
    return extraIndex.get(key)!;
  };
  const media = async (label: string, id: string, kinds: readonly string[]) => {
    const asset = await e.DB.prepare(
      `SELECT object_key,kind,mime,duration FROM media_assets WHERE id=? AND user_id=? AND status='ready' AND expires_at>? AND kind IN (${kinds.map(() => "?").join(",")})`,
    )
      .bind(id, user.id, now(), ...kinds)
      .first<{ object_key: string; kind: string; mime: string; duration: number }>();
    if (!asset) throw new HTTPException(400, { message: `${label}Файл от слоевете вече не е наличен или още се проверява. Заменете го или го премахнете.` });
    return asset;
  };
  const overlays: any[] = [], texts: any[] = [];
  let offset = 0;
  for (const [i, scene] of stored.document.scenes.entries()) {
    const label = stored.document.scenes.length > 1 ? `Сцена ${i + 1}: ` : "";
    if (!scene.audioJobId || !scene.videoJobId)
      throw new HTTPException(400, { message: `${label}Експортът се отключва, когато видео аватарът е готов.` });
    const audio = await e.DB.prepare("SELECT audio_key,duration FROM jobs WHERE id=? AND user_id=? AND kind='audio' AND status='completed'")
      .bind(scene.audioJobId, user.id)
      .first<{ audio_key: string; duration: number }>();
    if (!audio?.audio_key) throw invalid();
    const video = await exportSource(e, user.id, scene.videoJobId);
    if (!video.generated) throw invalid();
    const saved = await e.AUDIO.get(captionKey(user.id, scene.audioJobId));
    const captions = validDocument(saved ? await new Response(saved.body).json() : defaultCaptions, audio.duration);
    const settings = sceneTimeline(scene, music);
    const length = timelineLength(settings, audio.duration);
    let background: { color: string } | { input: number } | null = null;
    if (scene.background?.type === "color") background = { color: scene.background.color };
    if (scene.background?.type === "image") {
      const asset = await media(label, scene.background.assetId, imageAssetKinds);
      // A background is looped for its scene's length, so each scene gets its own input.
      background = { input: extra(`background:${i}`, asset.object_key) };
    }
    for (const layer of scene.layers) {
      if (layer.start >= length) continue;
      const start = offset + layer.start, end = offset + Math.min(layer.end, length);
      if (layer.type === "text") { texts.push({ ...layer, start, end }); continue; }
      const asset = await media(label, layer.assetId, layer.type === "image" ? imageAssetKinds : [...imageAssetKinds, ...videoAssetKinds]);
      const still = asset.mime.startsWith("image/");
      if (layer.type === "broll" && !still && layer.trim >= asset.duration)
        throw new HTTPException(400, { message: `${label}Началото на видео слоя е след края на клипа.` });
      const input = extra(`media:${asset.object_key}`, asset.object_key);
      overlays.push(layer.type === "image"
        ? { kind: "image", input, start, end, position: layer.position, width: layer.width, opacity: layer.opacity }
        : { kind: "broll", input, start, end, trim: still || layer.type !== "broll" ? 0 : layer.trim, still });
    }
    scenes.push({ scene, audio, video, captions, settings, offset, length, background });
    offset += length;
  }
  if (offset > MAX_PROJECT_SECONDS)
    throw new HTTPException(400, { message: `Цялото видео трябва да е до ${MAX_PROJECT_SECONDS / 60} минути.` });
  let musicKey: string | null = null;
  if (music) {
    const asset = await e.DB.prepare("SELECT object_key FROM media_assets WHERE id=? AND user_id=? AND kind='audio' AND job_id IS NULL AND status='ready' AND expires_at>?")
      .bind(music.assetId, user.id, now())
      .first<{ object_key: string }>();
    if (!asset) throw new HTTPException(400, { message: "Музиката вече не е налична. Качете я отново или я премахнете от монтажа." });
    musicKey = asset.object_key;
  }
  // A one-scene project keeps pricing per generated video; a multi-scene project is priced as one video.
  const source = scenes.length === 1 ? scenes[0].scene.videoJobId! : projectId;
  const credits = await exportQuote(e, user.id, source, offset, true);
  if (extras.length > 40) throw new HTTPException(400, { message: "Проектът използва твърде много файлове в слоевете (до 40)." });
  return { scenes, length: offset, credits, source, music, musicKey, extras, overlays, texts };
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
  const inputs = plan.scenes.flatMap((x) => [x.video.key, x.audio.audio_key]);
  // Layer media follows the scenes' video/voice pairs; music is always last.
  const first = inputs.length;
  const id = await createMediaTask(c.env, user, {
    kind: "export",
    source: plan.source,
    key: d.idempotencyKey,
    credits: plan.credits,
    payload: {
      inputs: [...inputs, ...plan.extras, ...(plan.musicKey ? [plan.musicKey] : [])],
      texts: plan.texts,
      // Frame size and fit come from the first scene; every scene keeps its own caption look.
      document: plan.scenes[0].captions,
      captions: plan.scenes.map((x) => ({ document: x.captions, offset: x.offset + x.settings.speechStart })),
      duration: plan.length,
      timeline: {
        scenes: plan.scenes.map((x) => ({
          speechStart: x.settings.speechStart,
          tail: x.settings.tail,
          voiceVolume: x.settings.voiceVolume,
          speechDuration: x.audio.duration,
          background: x.background && ("color" in x.background ? x.background : { input: first + x.background.input }),
        })),
        layers: plan.overlays.map((o) => ({ ...o, input: first + o.input })),
        music: plan.music && {
          start: plan.music.start, volume: plan.music.volume, duck: plan.music.duck, fade: plan.music.fade,
          // Speech of every scene, on the final video's clock, so music ducks under all of it.
          ranges: plan.scenes.flatMap((x) =>
            speechRanges(x.captions.words, x.settings, x.audio.duration).map(([a, b]) => [x.offset + a, x.offset + b])),
        },
      },
    },
    outputs: 1,
    outputBytes: Math.ceil(plan.length * 650000) + 5 * MB,
  });
  return c.json({ id }, 202);
});
