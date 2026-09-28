import { z } from "zod";
import { MAX_LEAD, MAX_TAIL, type TimelineSettings } from "./timeline";

// A video studio project as stored on the server: small JSON that only references media
// (recordings and videos by job ID, uploads by media asset ID). Captions stay per recording.
// Phase 1 edits one scene; the array keeps the format ready for multi-scene projects.
export const PROJECT_DOC_VERSION = 1;
export const MAX_SCENES = 20;
export const MAX_DOC_BYTES = 64 * 1024;

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
  audioJobId: z.uuid().nullable(),
  videoJobId: z.uuid().nullable(),
  portrait: portraitSchema.nullable(),
  speechStart: seconds(MAX_LEAD),
  tail: seconds(MAX_TAIL),
  voiceVolume: z.number().finite().min(0).max(1),
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
});
export type ProjectPortrait = z.infer<typeof portraitSchema>;
export type ProjectScene = z.infer<typeof sceneSchema>;
export type ProjectMusic = z.infer<typeof musicSchema>;
export type ProjectDoc = z.infer<typeof projectDocSchema>;

export function newScene(): ProjectScene {
  return { id: crypto.randomUUID(), audioJobId: null, videoJobId: null, portrait: null, speechStart: 0, tail: 0, voiceVolume: 1 };
}
export function newProjectDoc(): ProjectDoc {
  return { version: PROJECT_DOC_VERSION, scenes: [newScene()], music: null };
}
/** The timeline editor's view of a scene plus the project's music. */
export function sceneTimeline(scene: ProjectScene, music: ProjectMusic | null): TimelineSettings {
  return {
    speechStart: scene.speechStart, tail: scene.tail, voiceVolume: scene.voiceVolume,
    music: music && { name: music.name, start: music.start, volume: music.volume, duck: music.duck, fade: music.fade },
  };
}
