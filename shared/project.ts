import { z } from "zod";
import { MAX_LEAD, MAX_TAIL, type TimelineSettings } from "./timeline";
import { studioMaxChars } from "./studio";
import { backgroundSchema, layerSchema, MAX_LAYERS } from "./layers";
import { bumperSchema, captionLookSchema } from "./brand";

// A video studio project as stored on the server: small JSON that only references media
// (recordings and videos by job ID, uploads by media asset ID). Captions stay per recording.
// Each scene has its own script, voice, portrait and recordings; the final video joins the scenes in order.
// Scene fields added after the first release have defaults, so earlier documents still parse.
export const PROJECT_DOC_VERSION = 1;
export const MAX_SCENES = 20;
export const MAX_DOC_BYTES = 128 * 1024;
/** Longest final video the server render joins (seconds). */
export const MAX_PROJECT_SECONDS = 600;

const round = (n: number) => Math.round(n * 100) / 100;
const seconds = (max: number) => z.number().finite().min(0).max(max).transform(round);
export const portraitSchema = z.discriminatedUnion("type", [
  // Bundled or admin-managed synthetic presenters (see shared/avatars.ts).
  z.object({ type: z.literal("library"), id: z.string().regex(/^(?:[a-z]{2,20}|avatar-[a-f0-9-]{36})$/) }),
  // A portrait, product variant or product image in the user's media library.
  z.object({ type: z.literal("asset"), id: z.uuid() }),
]);
export const sceneSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().max(80).default(""),
  /** Script with emotion tags (validated like any studio script when it is generated). */
  script: z.string().max(studioMaxChars).default(""),
  voice: z.string().regex(/^studio-[a-z0-9][a-z0-9-]{0,79}$/).nullable().default(null),
  /** Recordings generated for this scene, newest first. */
  history: z.array(z.uuid()).max(20).default([]),
  /** Fingerprint of the voice + script the selected recording was made from (shows a stale recording). */
  audioFor: z.string().max(16).nullable().default(null),
  audioJobId: z.uuid().nullable(),
  videoJobId: z.uuid().nullable(),
  portrait: portraitSchema.nullable(),
  speechStart: seconds(MAX_LEAD),
  tail: seconds(MAX_TAIL),
  voiceVolume: z.number().finite().min(0).max(1),
  /** Text, image and B-roll layers over the avatar (see shared/layers.ts). */
  layers: z.array(layerSchema).max(MAX_LAYERS).default([]),
  /** Fills the frame around the avatar when framing leaves space; null = black. */
  background: backgroundSchema.nullable().default(null),
});
export const musicSchema = z.object({
  assetId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  start: z.number().finite().min(-3600).max(3600).transform(round),
  volume: z.number().finite().min(0).max(1),
  duck: z.boolean(),
  fade: z.boolean(),
});
export const projectDocSchema = z.object({
  version: z.literal(PROJECT_DOC_VERSION),
  scenes: z.array(sceneSchema).min(1).max(MAX_SCENES),
  music: musicSchema.nullable(),
  /** Shown before the first and after the last scene in the final video. */
  intro: bumperSchema.nullable().default(null),
  outro: bumperSchema.nullable().default(null),
  /** Caption look new recordings in this project start with (e.g. from the brand kit). */
  captionLook: captionLookSchema.nullable().default(null),
});
export type ProjectPortrait = z.infer<typeof portraitSchema>;
export type ProjectScene = z.infer<typeof sceneSchema>;
export type ProjectMusic = z.infer<typeof musicSchema>;
export type ProjectDoc = z.infer<typeof projectDocSchema>;

export function newScene(fields: Partial<ProjectScene> = {}): ProjectScene {
  return {
    id: crypto.randomUUID(), title: "", script: "", voice: null, history: [], audioFor: null,
    audioJobId: null, videoJobId: null, portrait: null, speechStart: 0, tail: 0, voiceVolume: 1, layers: [], background: null, ...fields,
  };
}
/** Short, stable fingerprint of what a recording says (FNV-1a), to spot a recording older than its script. */
export function scriptFingerprint(voice: string | null, script: string) {
  let h = 0x811c9dc5;
  for (const ch of `${voice || ""}\n${script}`) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
/** Updates one scene by index. */
export function withScene(d: ProjectDoc, index: number, change: (s: ProjectScene) => ProjectScene): ProjectDoc {
  return { ...d, scenes: d.scenes.map((s, i) => (i === index ? change(s) : s)) };
}
export function newProjectDoc(): ProjectDoc {
  return { version: PROJECT_DOC_VERSION, scenes: [newScene()], music: null, intro: null, outro: null, captionLook: null };
}
/** Applies timeline editor settings to one scene and the project music. */
export function withTimeline(d: ProjectDoc, next: TimelineSettings, musicAssetId?: string | null, index = 0): ProjectDoc {
  const assetId = musicAssetId === undefined ? d.music?.assetId : musicAssetId;
  return {
    ...withScene(d, index, (s) => ({ ...s, speechStart: next.speechStart, tail: next.tail, voiceVolume: next.voiceVolume })),
    music: next.music && assetId ? { assetId, ...next.music } : null,
  };
}
/** The timeline editor's view of a scene plus the project's music. */
export function sceneTimeline(scene: ProjectScene, music: ProjectMusic | null): TimelineSettings {
  return {
    speechStart: scene.speechStart, tail: scene.tail, voiceVolume: scene.voiceVolume,
    music: music && { name: music.name, start: music.start, volume: music.volume, duck: music.duck, fade: music.fade },
  };
}
