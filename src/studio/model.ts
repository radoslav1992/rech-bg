import type { Job } from "../lib";
import type { MediaAsset } from "../../shared/media";
import type { CaptionDocument } from "../../shared/captions";
import { estimateSpeechSeconds } from "../../shared/studio";
import { scriptFingerprint, sceneTimeline, type ProjectDoc, type ProjectScene } from "../../shared/project";
import { speechRanges } from "../../shared/timeline";
import { cutWords, keptDuration } from "../../shared/cuts";

// The studio's view of a project: which recordings and videos belong to each scene, and where every
// scene sits on the final video's clock (intro, scenes in order, outro — the same order the server renders).
export const isBusy = (j?: Job | null) => !!j && (j.status === "queued" || j.status === "running");
const newest = (a: Job, b: Job) => b.created_at - a.created_at;

export type SceneMedia = {
  /** Recordings of this scene, newest first. */
  audios: Job[];
  videos: Job[];
  /** The recording the scene uses (may still be in progress or failed). */
  audio: Job | null;
  /** The avatar video the scene uses, if it has one. */
  video: Job | null;
  /** A video being created for the scene's recording. */
  pendingVideo: Job | null;
  /** The script or voice changed after the recording was made. */
  stale: boolean;
};

export function sceneMedia(doc: ProjectDoc, index: number, jobs: Job[]): SceneMedia {
  const scene = doc.scenes[index];
  const owned = (id: string) => doc.scenes.some((s) => s.history.includes(id) || s.audioJobId === id);
  // Recordings made before scenes existed belong to the first scene. Only in such a project (no scene has
  // its own recordings yet): otherwise an unowned recording is one of a deleted scene, with another script.
  // A recording made for a scene says so (scene_id): it belongs to that scene even if the editor closed before
  // the project was saved, and never to another one.
  const legacy = index === 0 && doc.scenes.every((s) => !s.history.length);
  const audios = jobs
    .filter((j) => j.kind !== "video" && (scene.history.includes(j.id) || scene.audioJobId === j.id || j.scene_id === scene.id || (legacy && !j.scene_id && !owned(j.id))))
    .sort(newest);
  const audio = audios.find((j) => j.id === scene.audioJobId) || null;
  const videos = jobs.filter((j) => j.kind === "video" && audios.some((a) => a.id === j.source_job_id)).sort(newest);
  const video = videos.find((v) => v.id === scene.videoJobId) || null;
  const pendingVideo = audio ? videos.find((v) => v.source_job_id === audio.id && isBusy(v)) || null : null;
  const stale = !!audio && !!scene.audioFor && scene.audioFor !== scriptFingerprint(scene.voice, scene.script);
  return { audios, videos, audio, video, pendingVideo, stale };
}

/**
 * What a scene should point at once jobs finish: the newest finished recording when none is chosen,
 * and the newest finished video of the chosen recording when it has none (or its video failed).
 */
export function adoptedMedia(doc: ProjectDoc, index: number, media: SceneMedia): { audioJobId: string | null; videoJobId: string | null } | null {
  const scene = doc.scenes[index];
  // A newer recording made for this scene that the project never saved (the editor closed in between) is the
  // one the user asked for.
  const unsaved = media.audios.find((j) => j.scene_id === scene.id && j.id !== scene.audioJobId && !scene.history.includes(j.id) && j.status !== "failed"
    && (!media.audio || j.created_at >= media.audio.created_at));
  if (unsaved) return { audioJobId: unsaved.id, videoJobId: null };
  const audio = media.audio ?? media.audios.find((j) => j.status === "completed") ?? null;
  if (!audio) return null;
  const forAudio = media.videos.filter((v) => v.source_job_id === audio.id);
  const current = forAudio.find((v) => v.id === scene.videoJobId), done = forAudio.find((v) => v.status === "completed");
  let videoJobId = scene.videoJobId;
  // A video not in the list yet (just created) is kept; one made for another recording is not.
  if (!current) videoJobId = done?.id ?? (media.videos.some((v) => v.id === scene.videoJobId) ? null : scene.videoJobId);
  else if (current.status === "failed" && done) videoJobId = done.id;
  if (audio.id === scene.audioJobId && videoJobId === scene.videoJobId) return null;
  return { audioJobId: audio.id, videoJobId };
}

/** Key of an uploaded video's transcript in the studio's caption record. */
export const assetCaptionKey = (assetId: string) => `asset:${assetId}`;
/**
 * Key of the captions a scene shows: its recording's, or (for a filmed scene) its clip's transcript moved
 * onto the cut clip's clock by `shownCaptions`.
 */
export function captionId(scene: ProjectScene, media: SceneMedia | undefined): string | null {
  if (scene.clip) return `cut:${scene.id}`;
  return media?.audio?.status === "completed" ? media.audio.id : null;
}
/** The loaded caption documents plus, for every filmed scene, its transcript with the cut-out words removed. */
export function shownCaptions(doc: ProjectDoc, docs: Record<string, CaptionDocument>): Record<string, CaptionDocument> {
  const out = { ...docs };
  for (const s of doc.scenes) {
    const source = s.clip && docs[assetCaptionKey(s.clip.assetId)];
    if (s.clip && source) out[`cut:${s.id}`] = { ...source, ...(doc.captionLook || {}), words: cutWords(source.words, s.clip.keep) };
  }
  return out;
}
/** The uploaded video of a filmed scene, once it passed its check. */
export const readyClip = (scene: ProjectScene, assets: MediaAsset[]) => {
  const asset = scene.clip ? assets.find((a) => a.id === scene.clip!.assetId) : undefined;
  return asset?.status === "ready" && asset.duration > 0 ? asset : null;
};

export type SceneSegment = {
  kind: "scene"; index: number; start: number; length: number;
  /** Voice length; an estimate from the script until the recording is ready. */
  speech: number; estimated: boolean;
};
export type BumperSegment = { kind: "bumper"; which: "intro" | "outro"; start: number; length: number; assetId: string; video: boolean };
export type Segment = SceneSegment | BumperSegment;

export function projectLayout(doc: ProjectDoc, media: SceneMedia[], assets: MediaAsset[]) {
  const segments: Segment[] = [];
  let t = 0;
  const bumper = (which: "intro" | "outro") => {
    const b = doc[which];
    if (!b) return;
    const asset = assets.find((a) => a.id === b.assetId);
    const video = !!asset?.mime.startsWith("video/");
    const length = Math.round((video && asset!.duration > 0 ? Math.min(b.seconds, asset!.duration) : b.seconds) * 100) / 100;
    segments.push({ kind: "bumper", which, start: t, length, assetId: b.assetId, video });
    t += length;
  };
  bumper("intro");
  doc.scenes.forEach((scene, index) => {
    const audio = media[index]?.audio, clip = readyClip(scene, assets);
    // A filmed scene lasts as long as the parts of its clip that are kept.
    const ready = scene.clip ? !!clip : audio?.status === "completed" && audio.duration > 0;
    const speech = clip ? keptDuration(scene.clip!.keep, clip.duration) : ready ? audio!.duration : Math.max(2, estimateSpeechSeconds(scene.script) || 3);
    const length = Math.round((scene.speechStart + speech + scene.tail) * 100) / 100;
    segments.push({ kind: "scene", index, start: t, length, speech, estimated: !ready });
    t += length;
  });
  bumper("outro");
  return { segments, total: Math.round(t * 100) / 100 };
}

/** Speech of every scene on the final video's clock, so music ducks under all of it (as in the server render). */
export function projectSpeech(doc: ProjectDoc, segments: Segment[], captions: Record<string, CaptionDocument>, media: SceneMedia[]) {
  return segments.flatMap((seg) => {
    if (seg.kind !== "scene" || seg.estimated) return [];
    const scene = doc.scenes[seg.index], id = captionId(scene, media[seg.index]), words = (id && captions[id]?.words) || [];
    return speechRanges(words, sceneTimeline(scene, doc.music), seg.speech).map(([a, b]) => [seg.start + a, seg.start + b] as [number, number]);
  });
}
