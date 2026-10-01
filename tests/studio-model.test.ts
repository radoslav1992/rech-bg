import { describe, expect, it } from "vitest";
import { adoptedMedia, sceneMedia } from "../src/studio/model";
import { newScene, PROJECT_DOC_VERSION, type ProjectDoc } from "../shared/project";

const job = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, kind: "tts", status: "completed", created_at: 1, project_id: "p", ...extra }) as any;
const doc = (scene: Record<string, unknown>): ProjectDoc =>
  ({ version: PROJECT_DOC_VERSION, scenes: [newScene(scene as any)], music: null, intro: null, outro: null, captionLook: null }) as ProjectDoc;

describe("studio scenes follow their jobs", () => {
  it("keeps a chosen recording that is missing from the list instead of pairing its video with another voice", () => {
    // The scene uses recording a1 with video v1; the list only has an older recording a0 (a1 failed to load).
    const d = doc({ audioJobId: "a1", videoJobId: "v1", history: ["a1", "a0"] });
    const jobs = [job("a0", { created_at: 0 })];
    expect(adoptedMedia(d, 0, sceneMedia(d, 0, jobs))).toBeNull();
  });
  it("switches to a newer recording only with that recording's own video", () => {
    const d = doc({ audioJobId: null, videoJobId: "v-old", history: [] });
    const jobs = [job("a2", { scene_id: d.scenes[0].id, created_at: 5 })];
    expect(adoptedMedia(d, 0, sceneMedia(d, 0, jobs))).toEqual({ audioJobId: "a2", videoJobId: null });
    const withVideo = [...jobs, job("v2", { kind: "video", source_job_id: "a2", created_at: 6 })];
    const d2 = doc({ id: d.scenes[0].id, audioJobId: null, videoJobId: "v-old", history: ["a2"] });
    expect(adoptedMedia(d2, 0, sceneMedia(d2, 0, withVideo))).toEqual({ audioJobId: "a2", videoJobId: "v2" });
  });
});
