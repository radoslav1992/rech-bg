import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { database, bucket } from "./helpers";
import { sha } from "../server/security";
import { now } from "../server/types";
import { mediaAllowance } from "../server/media";
import { mediaCredits, MB } from "../shared/media";
import { defaultCaptions } from "../shared/captions";
import { newProjectDoc, type ProjectDoc } from "../shared/project";
import { MediaGeneration } from "../server/media-workflow";

let sqlite: ReturnType<typeof database>["sqlite"], env: any;
const project = crypto.randomUUID(), audio = crypto.randomUUID(), video = crypto.randomUUID();
const music = crypto.randomUUID(), portrait = crypto.randomUUID();
beforeEach(async () => {
  const d = database();
  sqlite = d.sqlite;
  sqlite.exec("INSERT INTO users VALUES('u','u@example.com','User','hash',1,NULL,1); INSERT INTO users VALUES('other','o@example.com','Other','hash',1,NULL,1)");
  sqlite.prepare("INSERT INTO sessions VALUES(?,'u',?)").run(await sha("s"), now() + 3600);
  sqlite.prepare("INSERT INTO sessions VALUES(?,'other',?)").run(await sha("o"), now() + 3600);
  const insertProject = sqlite.prepare("INSERT INTO projects VALUES(?,?,?,?,'[calm] Здравей','studio-mila','boris',0,1,1)");
  insertProject.run(project, "u", "Видео", "studio");
  insertProject.run("tts-project", "u", "Аудио", "tts");
  sqlite.exec("INSERT INTO usage_windows(id,user_id,quota,used) VALUES('w','u',1000000,0)");
  const job = sqlite.prepare("INSERT INTO jobs(id,user_id,project_id,window_id,idempotency_key,title,mode,script,voice,second_voice,pause_ms,chars,status,audio_key,duration,created_at,updated_at,kind,source_job_id,video_key) VALUES(?,'u',?,'w',?,'Видео','studio','Здравей','studio-mila','boris',0,1,'completed',?,10,1,1,?,?,?)");
  job.run(audio, project, audio, `audio/u/${audio}.wav`, "audio", null, null);
  job.run(video, project, video, null, "video", audio, `audio/u/${video}.mp4`);
  env = {
    DB: d.db, AUDIO: bucket(), SITE_URL: "https://rechbg.com", MEDIA_ENABLED: "true",
    MEDIA_GENERATION: { create: vi.fn(), get: vi.fn() }, MEDIA_RENDERER: { idFromName: (s: string) => s, get: vi.fn() },
  };
  await env.AUDIO.put(`audio/u/${video}.mp4`, new Uint8Array(24));
  await mediaAllowance(env, sqlite.prepare("SELECT * FROM users WHERE id='u'").get() as any);
  const asset = sqlite.prepare("INSERT INTO media_assets(id,user_id,object_key,name,kind,mime,bytes,status,created_at,expires_at) VALUES(?,?,?,?,?,?,1000,'ready',1,?)");
  asset.run(music, "u", `media/u/${music}/original`, "Песен.mp3", "audio", "audio/mpeg", now() + 86400);
  asset.run(portrait, "u", `media/u/${portrait}/original`, "Портрет.png", "portrait", "image/png", now() + 86400);
  await env.AUDIO.put(`media/u/${music}/original`, new Uint8Array(1000));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); sqlite.close(); });
const call = (path: string, method = "GET", body?: unknown, session = "s") =>
  worker.fetch(new Request("https://rechbg.com/api" + path, {
    method, headers: { Origin: "https://rechbg.com", Cookie: "rech_session=" + session, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil: () => {} } as any);
const doc = (changes: Partial<ProjectDoc["scenes"][0]> = {}, withMusic = true): ProjectDoc => {
  const d = newProjectDoc();
  d.scenes[0] = { ...d.scenes[0], audioJobId: audio, videoJobId: video, portrait: { type: "asset", id: portrait }, speechStart: 1.5, tail: 2, voiceVolume: 0.9, ...changes };
  d.music = withMusic ? { assetId: music, name: "Песен.mp3", start: -3, volume: 0.4, duck: true, fade: true } : null;
  return d;
};
const save = (document: unknown, revision: number, session = "s") => call(`/video-studio/projects/${project}/document`, "PUT", { document, revision }, session);

describe("project documents", () => {
  it("stores the document on the server and rejects stale revisions with the latest version", async () => {
    expect(await (await call(`/video-studio/projects/${project}/document`)).json()).toEqual({ document: null, revision: 0 });
    expect(await (await save(doc(), 0)).json()).toEqual({ revision: 1 });
    const stored = await (await call(`/video-studio/projects/${project}/document`)).json() as any;
    expect(stored.revision).toBe(1);
    expect(stored.document.scenes[0]).toMatchObject({ audioJobId: audio, speechStart: 1.5, tail: 2 });
    // Another tab still holds revision 0.
    const stale = await save(doc({ speechStart: 0 }), 0);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ revision: 1, document: { scenes: [{ speechStart: 1.5 }] } });
    expect(await (await save(doc({ speechStart: 3 }), 1)).json()).toEqual({ revision: 2 });
  });
  it("only serves the owner's studio projects", async () => {
    expect((await call(`/video-studio/projects/${project}/document`, "GET", undefined, "o")).status).toBe(404);
    expect((await save(doc(), 0, "o")).status).toBe(404);
    expect((await call(`/video-studio/projects/tts-project/document`)).status).toBe(404);
  });
  it("rejects references to other projects' recordings, unrelated videos and other users' files", async () => {
    const otherAudio = crypto.randomUUID();
    sqlite.prepare("INSERT INTO projects VALUES('p2','u','Друг','studio','x','studio-mila','boris',0,1,1)").run();
    sqlite.prepare("INSERT INTO jobs(id,user_id,project_id,window_id,idempotency_key,title,mode,script,voice,second_voice,pause_ms,chars,status,duration,created_at,updated_at) VALUES(?,'u','p2','w',?,'x','studio','x','studio-mila','boris',0,1,'completed',5,1,1)").run(otherAudio, otherAudio);
    const foreign = crypto.randomUUID();
    sqlite.prepare("INSERT INTO media_limits VALUES('other',1000000000,30)").run();
    sqlite.prepare("INSERT INTO media_assets(id,user_id,object_key,name,kind,mime,bytes,status,created_at,expires_at) VALUES(?,'other',?,'x','audio','audio/mpeg',10,'ready',1,?)").run(foreign, `media/other/${foreign}/original`, now() + 86400);
    expect((await save(doc({ audioJobId: otherAudio, videoJobId: null }), 0)).status).toBe(400);
    expect((await save(doc({ videoJobId: audio }), 0)).status).toBe(400);
    expect((await save(doc({ audioJobId: null }), 0)).status).toBe(400);
    expect((await save(doc({ portrait: { type: "asset", id: music } }), 0)).status).toBe(400);
    expect((await save({ ...doc(), music: { ...doc().music!, assetId: foreign } }, 0)).status).toBe(400);
    expect((await save({ ...doc(), scenes: [] }, 0)).status).toBe(400);
    expect((await save(doc({ speechStart: 99 }), 0)).status).toBe(400);
    expect((await save(doc({ portrait: { type: "library", id: "mila" } }), 0)).status).toBe(200);
  });
  it("keeps saving a project whose already-referenced music has since expired", async () => {
    expect((await save(doc(), 0)).status).toBe(200);
    sqlite.prepare("UPDATE media_assets SET status='deleting' WHERE id=?").run(music);
    expect((await save(doc({ tail: 1 }), 1)).status).toBe(200);
  });
});

describe("music uploads", () => {
  it("stores music as a job-less audio asset and checks the file signature", async () => {
    const uploads = new Map<string, any>();
    const create = env.AUDIO.createMultipartUpload;
    env.AUDIO.createMultipartUpload = async (key: string, opts: any) => {
      const u = await create(key, opts); const uploadId = crypto.randomUUID(); uploads.set(uploadId, u); return { ...u, uploadId };
    };
    env.AUDIO.resumeMultipartUpload = (_key: string, id: string) => uploads.get(id);
    expect((await call("/media/uploads", "POST", { name: "a.png", bytes: 100, mime: "image/png", kind: "music" })).status).toBe(400);
    expect((await call("/media/uploads", "POST", { name: "a.mp3", bytes: 100, mime: "audio/mpeg", kind: "portrait" })).status).toBe(400);
    expect((await call("/media/uploads", "POST", { name: "a.mp3", bytes: 51 * MB, mime: "audio/mpeg", kind: "music" })).status).toBe(400);
    const upload = async (bytes: Uint8Array) => {
      const start = await (await call("/media/uploads", "POST", { name: "Песен.mp3", bytes: bytes.length, mime: "audio/mpeg", kind: "music" })).json() as any;
      const part = await worker.fetch(new Request(`https://rechbg.com/api/media/uploads/${start.id}/parts/1`, {
        method: "PUT", headers: { Origin: "https://rechbg.com", Cookie: "rech_session=s" }, body: bytes as BodyInit,
      }), env, {} as any);
      expect(part.status).toBe(200);
      return { id: start.id as string, done: await call(`/media/uploads/${start.id}/complete`, "POST", {}) };
    };
    const fake = await upload(new Uint8Array(100));
    expect(fake.done.status).toBe(400);
    const real = await upload(new Uint8Array([73, 68, 51, ...new Uint8Array(97)]));
    expect(await real.done.json()).toEqual({ id: real.id });
    expect(sqlite.prepare("SELECT kind,job_id,status FROM media_assets WHERE id=?").get(real.id)).toEqual({ kind: "audio", job_id: null, status: "ready" });
    expect((await save({ ...doc(), music: { ...doc().music!, assetId: real.id } }, 0)).status).toBe(200);
  });
});

describe("server timeline render", () => {
  it("renders from the saved document and captions, with the timeline and music snapshotted", async () => {
    const words = [{ text: "Здравей", start: 0.2, end: 0.8 }, { text: "свят", start: 3, end: 3.5 }];
    await env.AUDIO.put(`audio/u/${audio}.captions.json`, JSON.stringify({ ...defaultCaptions, words }));
    expect((await call(`/video-studio/projects/${project}/render/quote`)).status).toBe(400);
    await save(doc(), 0);
    const quote = await (await call(`/video-studio/projects/${project}/render/quote`)).json() as any;
    expect(quote).toEqual({ credits: 0, length: 13.5 });
    const key = crypto.randomUUID();
    expect((await call(`/video-studio/projects/${project}/render`, "POST", { idempotencyKey: key, credits: 5 })).status).toBe(409);
    const r = await call(`/video-studio/projects/${project}/render`, "POST", { idempotencyKey: key, credits: 0 });
    expect(r.status).toBe(202);
    const task = sqlite.prepare("SELECT * FROM media_tasks").get() as any;
    expect(task).toMatchObject({ kind: "export", source_id: video, credits: 0 });
    const payload = JSON.parse(task.payload);
    expect(payload.inputs).toEqual([`audio/u/${video}.mp4`, `audio/u/${audio}.wav`, `media/u/${music}/original`]);
    expect(payload.document.words).toEqual(words);
    expect(payload.timeline).toEqual({
      scenes: [{ speechStart: 1.5, tail: 2, voiceVolume: 0.9, speechDuration: 10, clip: null, background: null }],
      music: { start: -3, volume: 0.4, duck: true, fade: true, ranges: [[1.7, 2.3], [4.5, 5]] },
      layers: [], intro: null, outro: null,
    });
    expect(payload.texts).toEqual([]);
    expect(payload.captions).toEqual([{ document: expect.objectContaining({ words }), offset: 1.5 }]);
    // The same key returns the same task; a later edit does not change the queued render.
    await save(doc({ tail: 0 }), 1);
    expect(await (await call(`/video-studio/projects/${project}/render`, "POST", { idempotencyKey: key, credits: 0 })).json()).toEqual({ id: task.id });
    expect(JSON.parse((sqlite.prepare("SELECT payload FROM media_tasks").get() as any).payload).timeline.scenes[0].tail).toBe(2);
  });
  it("charges later renders per started minute, like other additional exports", async () => {
    await save(doc(), 0);
    sqlite.prepare("INSERT INTO media_tasks(id,user_id,kind,source_id,idempotency_key,window_id,credits,status,payload,token,created_at,updated_at) VALUES('t','u','export',?,'k','w',0,'completed','{}','x',1,1)").run(video);
    expect(await (await call(`/video-studio/projects/${project}/render/quote`)).json()).toEqual({ credits: mediaCredits("export", 13.5), length: 13.5 });
  });
  it("explains missing music and a disabled renderer instead of rendering without them", async () => {
    await save(doc(), 0);
    sqlite.prepare("UPDATE media_assets SET expires_at=1 WHERE id=?").run(music);
    expect((await call(`/video-studio/projects/${project}/render/quote`)).status).toBe(400);
    env.MEDIA_ENABLED = "false";
    expect((await call(`/video-studio/projects/${project}/render/quote`)).status).toBe(503);
  });
});

it("sends the timeline, every input and caption times shifted by the lead-in to the renderer", async () => {
  await env.AUDIO.put(`audio/u/${audio}.captions.json`, JSON.stringify({ ...defaultCaptions, words: [{ text: "Здравей", start: 0.2, end: 0.8 }] }));
  await save(doc(), 0);
  await call(`/video-studio/projects/${project}/render`, "POST", { idempotencyKey: crypto.randomUUID(), credits: 0 });
  const task = sqlite.prepare("SELECT id FROM media_tasks").get() as any;
  const requests: any[] = [];
  env.MEDIA_RENDERER.get = () => ({ fetch: async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { requests.push(JSON.parse(String(init.body))); return Response.json({ status: "running" }, { status: 202 }); }
    if (url.endsWith("/file")) return new Response(new Uint8Array(24));
    if (init?.method === "DELETE") return Response.json({});
    return Response.json({ status: "completed", duration: 13.5 });
  } });
  const step = { do: async (_n: string, ...args: any[]) => args.at(-1)(), sleep: async () => {} };
  await new (MediaGeneration as any)({}, env).run({ payload: { taskId: task.id } }, step);
  expect(requests[0]).toMatchObject({
    operation: "timeline",
    timeline: { scenes: [{ speech_start: 1.5, tail: 2, voice_volume: 0.9, speech_duration: 10 }], music: { start: -3, duck: true } },
  });
  expect(requests[0].urls).toHaveLength(3);
  expect(requests[0].urls.every((u: string) => u.startsWith(`https://rechbg.com/api/media-inputs/${task.id}/`))).toBe(true);
  // 0.2 s into the voice + 1.5 s lead-in.
  expect(requests[0].ass).toContain("Dialogue: 0,0:00:01.70,0:00:02.30,S0,");
  expect(sqlite.prepare("SELECT status FROM media_tasks").get()).toEqual({ status: "completed" });
});

describe("multi-scene projects", () => {
  const audio2 = crypto.randomUUID(), video2 = crypto.randomUUID();
  beforeEach(async () => {
    const job = sqlite.prepare("INSERT INTO jobs(id,user_id,project_id,window_id,idempotency_key,title,mode,script,voice,second_voice,pause_ms,chars,status,audio_key,duration,created_at,updated_at,kind,source_job_id,video_key) VALUES(?,'u',?,'w',?,'Видео','studio','Втора','studio-boris','boris',0,1,'completed',?,6,1,1,?,?,?)");
    job.run(audio2, project, audio2, `audio/u/${audio2}.wav`, "audio", null, null);
    job.run(video2, project, video2, null, "video", audio2, `audio/u/${video2}.mp4`);
    await env.AUDIO.put(`audio/u/${video2}.mp4`, new Uint8Array(24));
    await env.AUDIO.put(`audio/u/${audio}.captions.json`, JSON.stringify({ ...defaultCaptions, words: [{ text: "Първа", start: 0, end: 1 }] }));
    await env.AUDIO.put(`audio/u/${audio2}.captions.json`, JSON.stringify({ ...defaultCaptions, style: "neon", words: [{ text: "Втора", start: 0.5, end: 1.5 }] }));
  });
  const twoScenes = (second: Partial<ProjectDoc["scenes"][0]> = {}): ProjectDoc => {
    const d = doc();
    d.scenes.push({ ...d.scenes[0], id: crypto.randomUUID(), title: "Край", script: "[calm] Втора сцена.", voice: "studio-boris",
      history: [audio2], audioJobId: audio2, videoJobId: video2, speechStart: 0, tail: 1, voiceVolume: 1, ...second });
    return d;
  };
  it("parses documents saved before scenes had scripts, and rejects duplicate scene IDs", async () => {
    sqlite.prepare("INSERT INTO project_documents VALUES(?,'u',?,1,1)").run(project, JSON.stringify({
      version: 1, music: null,
      scenes: [{ id: crypto.randomUUID(), audioJobId: audio, videoJobId: video, portrait: null, speechStart: 0, tail: 0, voiceVolume: 1 }],
    }));
    const stored = await (await call(`/video-studio/projects/${project}/document`)).json() as any;
    expect(stored.document.scenes[0]).toMatchObject({ script: "", voice: null, history: [], title: "" });
    const d = twoScenes();
    expect((await save({ ...d, scenes: [d.scenes[0], { ...d.scenes[1], id: d.scenes[0].id }] }, 1)).status).toBe(400);
    expect((await save(twoScenes({ history: [crypto.randomUUID()] }), 1)).status).toBe(400);
  });
  it("generates a scene's recording from its own saved script and voice", async () => {
    env.ELEVENLABS_API_KEY = "key";
    env.GENERATION = { create: vi.fn() };
    const d = twoScenes();
    await save(d, 0);
    const script = d.scenes[1].script;
    const wrongPrice = await call("/generate", "POST", { projectId: project, idempotencyKey: crypto.randomUUID(), credits: 3, sceneId: d.scenes[1].id });
    expect(wrongPrice.status).toBe(409);
    const r = await call("/generate", "POST", { projectId: project, idempotencyKey: crypto.randomUUID(), credits: script.length * 3, sceneId: d.scenes[1].id });
    expect(r.status).toBe(202);
    const id = (await r.json() as any).id;
    expect(sqlite.prepare("SELECT script,voice,title FROM jobs WHERE id=?").get(id)).toEqual({ script, voice: "studio-boris", title: "Видео · Сцена 2" });
    // The recording names its scene, so the editor can place it even if the project was not saved afterwards.
    expect(((await (await call(`/jobs?project=${project}`)).json()) as any).jobs.find((j: any) => j.id === id).scene_id).toBe(d.scenes[1].id);
    expect((await call("/generate", "POST", { projectId: project, idempotencyKey: crypto.randomUUID(), credits: 3, sceneId: crypto.randomUUID() })).status).toBe(404);
  });
  it("renders all scenes in order as one video with music across them and each scene's captions", async () => {
    await save(twoScenes(), 0);
    const quote = await (await call(`/video-studio/projects/${project}/render/quote`)).json() as any;
    expect(quote).toEqual({ credits: 0, length: 20.5 });
    const r = await call(`/video-studio/projects/${project}/render`, "POST", { idempotencyKey: crypto.randomUUID(), credits: 0 });
    expect(r.status).toBe(202);
    const task = sqlite.prepare("SELECT * FROM media_tasks").get() as any;
    expect(task.source_id).toBe(project);
    const payload = JSON.parse(task.payload);
    expect(payload.inputs).toEqual([`audio/u/${video}.mp4`, `audio/u/${audio}.wav`, `audio/u/${video2}.mp4`, `audio/u/${audio2}.wav`, `media/u/${music}/original`]);
    expect(payload.timeline.scenes).toEqual([
      { speechStart: 1.5, tail: 2, voiceVolume: 0.9, speechDuration: 10, clip: null, background: null },
      { speechStart: 0, tail: 1, voiceVolume: 1, speechDuration: 6, clip: null, background: null },
    ]);
    // Scene 2 starts at 13.5 s; its word at 0.5–1.5 s is speech at 14–15 s on the final clock.
    expect(payload.timeline.music.ranges).toEqual([[1.5, 2.5], [14, 15]]);
    expect(payload.captions.map((c: any) => c.offset)).toEqual([1.5, 13.5]);
    // Each scene keeps its caption look as its own ASS style.
    const { captionAssScenes } = await import("../server/caption-ass");
    const ass = captionAssScenes(payload.document, payload.captions);
    expect(ass).toMatch(/Style: S0,/); expect(ass).toMatch(/Style: S1,/);
    expect(ass).toContain("Dialogue: 0,0:00:14.00,");
  });
  it("names the scene that is not ready and caps the final length", async () => {
    await save(twoScenes({ videoJobId: null }), 0);
    const r = await call(`/video-studio/projects/${project}/render/quote`);
    expect(r.status).toBe(400);
    expect((await r.json() as any).error).toMatch(/^Сцена 2:/);
    sqlite.prepare("UPDATE jobs SET duration=590 WHERE id=?").run(audio2);
    await save(twoScenes(), 1);
    expect(((await (await call(`/video-studio/projects/${project}/render/quote`)).json()) as any).error).toMatch(/10 минути/);
  });
});

describe("filmed scenes", () => {
  const film = crypto.randomUUID(), otherFilm = crypto.randomUUID();
  beforeEach(() => {
    const asset = sqlite.prepare("INSERT INTO media_assets(id,user_id,object_key,name,kind,mime,bytes,status,duration,captions,created_at,expires_at) VALUES(?,?,?,?,?,?,1000,'ready',?,?,1,?)");
    const words = [{ text: "Здравейте", start: 0.5, end: 1 }, { text: "ъъъ", start: 1.1, end: 1.4 }, { text: "приятели", start: 4, end: 4.6 }];
    asset.run(film, "u", `media/u/${film}/original`, "Клип.mp4", "upload", "video/mp4", 8, JSON.stringify({ ...defaultCaptions, style: "bold", words }), now() + 86400);
    sqlite.prepare("INSERT INTO media_limits VALUES('other',1000000000,30)").run();
    asset.run(otherFilm, "other", `media/other/${otherFilm}/original`, "x.mp4", "upload", "video/mp4", 8, null, now() + 86400);
  });
  const filmed = (clip: any) => { const d = doc({ audioJobId: null, videoJobId: null, portrait: null, clip } as any, false); return d; };
  const transcribed = (assetId: string) => sqlite.prepare("INSERT INTO media_tasks(id,user_id,kind,source_id,idempotency_key,window_id,credits,status,payload,token,created_at,updated_at) VALUES(?,'u','transcribe',?,?,'w',1000,'completed','{}','t',1,1)")
    .run(crypto.randomUUID(), assetId, crypto.randomUUID());
  it("renders a filmed scene with its own sound, the kept parts and captions moved onto the cut clock", async () => {
    transcribed(film);
    expect((await save(filmed({ assetId: otherFilm, keep: null, clean: false }), 0)).status).toBe(400);
    const keep = [[0.38, 1.2], [3.88, 4.8]];
    expect((await save(filmed({ assetId: film, keep, clean: true }), 0)).status).toBe(200);
    const quote = await (await call(`/video-studio/projects/${project}/render/quote`)).json() as any;
    // 1.5 s lead-in + (0.82 + 0.92) s kept + 2 s hold
    expect(quote).toEqual({ credits: 0, length: 5.24 });
    expect((await call(`/video-studio/projects/${project}/render`, "POST", { idempotencyKey: crypto.randomUUID(), credits: 0 })).status).toBe(202);
    const task = sqlite.prepare("SELECT * FROM media_tasks WHERE kind='export'").get() as any;
    expect(task.source_id).toBe(project);
    const payload = JSON.parse(task.payload);
    expect(payload.inputs).toEqual([`media/u/${film}/original`, `media/u/${film}/original`]);
    expect(payload.timeline.scenes[0]).toMatchObject({ speechDuration: 1.74, clip: { keep, clean: true } });
    // "ъъъ" was cut; "приятели" moved from 4 s to 0.82 + 0.12 s.
    expect(payload.captions[0].document.words).toEqual([{ text: "Здравейте", start: 0.12, end: 0.62 }, { text: "приятели", start: 0.94, end: 1.54 }]);
    expect(payload.document.style).toBe("bold");
  });
  it("counts a paid transcription for one free export only, and never captions typed in by hand", async () => {
    // Captions exist (e.g. typed in), but no transcription was paid for.
    expect((await save(filmed({ assetId: film, keep: null, clean: false }), 0)).status).toBe(200);
    expect(await (await call(`/video-studio/projects/${project}/render/quote`)).json()).toEqual({ credits: 500, length: 11.5 });
    transcribed(film);
    expect(await (await call(`/video-studio/projects/${project}/render/quote`)).json()).toEqual({ credits: 0, length: 11.5 });
    // The free export used up: another project with the same clip pays.
    sqlite.prepare("INSERT INTO media_tasks(id,user_id,kind,source_id,idempotency_key,window_id,credits,status,payload,token,created_at,updated_at) VALUES(?,'u','export',?,?,'w',0,'completed',?,'t',1,1)")
      .run(crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), JSON.stringify({ inputs: [`media/u/${film}/original`] }));
    expect(await (await call(`/video-studio/projects/${project}/render/quote`)).json()).toEqual({ credits: 500, length: 11.5 });
  });
  it("charges the export of a filmed clip that was never transcribed, as for any uploaded video", async () => {
    sqlite.prepare("UPDATE media_assets SET captions=NULL WHERE id=?").run(film);
    expect((await save(filmed({ assetId: film, keep: null, clean: false }), 0)).status).toBe(200);
    // 1.5 s + 8 s + 2 s: one started minute of export
    expect(await (await call(`/video-studio/projects/${project}/render/quote`)).json()).toEqual({ credits: 500, length: 11.5 });
  });
  it("rejects overlapping cut ranges", async () => {
    expect((await save(filmed({ assetId: film, keep: [[0, 2], [1, 3]], clean: false }), 0)).status).toBe(400);
  });
});

describe("scene layers and backgrounds", () => {
  const image = crypto.randomUUID(), clip = crypto.randomUUID(), otherImage = crypto.randomUUID();
  beforeEach(async () => {
    const asset = sqlite.prepare("INSERT INTO media_assets(id,user_id,object_key,name,kind,mime,bytes,status,duration,created_at,expires_at) VALUES(?,?,?,?,?,?,1000,?,?,1,?)");
    asset.run(image, "u", `media/u/${image}/original`, "Лого.png", "product", "image/png", "ready", 0, now() + 86400);
    asset.run(clip, "u", `media/u/${clip}/original`, "Клип.mp4", "upload", "video/mp4", "ready", 12, now() + 86400);
    sqlite.prepare("INSERT INTO media_limits VALUES('other',1000000000,30)").run();
    asset.run(otherImage, "other", `media/other/${otherImage}/original`, "x.png", "product", "image/png", "ready", 0, now() + 86400);
  });
  const text = (changes = {}) => ({ id: crypto.randomUUID(), type: "text", start: 0, end: 3, text: "Ново: {лято}\nОферта", position: "bottom", size: 0.06, color: "#ffffff", box: "#111111", bold: true, ...changes });
  const withLayers = (layers: any[], background: any = null) => doc({ layers, background } as any);
  it("accepts the user's own images and clips and rejects other users' files, wrong kinds and reversed times", async () => {
    const logo = { id: crypto.randomUUID(), type: "image", assetId: image, start: 0, end: 5, position: "top-right", width: 0.2, opacity: 0.8 };
    const broll = { id: crypto.randomUUID(), type: "broll", assetId: clip, start: 4, end: 6, trim: 2 };
    expect((await save(withLayers([text(), logo, broll], { type: "image", assetId: image }), 0)).status).toBe(200);
    expect((await save(withLayers([{ ...logo, assetId: otherImage }]), 1)).status).toBe(400);
    // A video cannot be an image overlay or a background.
    expect((await save(withLayers([{ ...logo, assetId: clip }]), 1)).status).toBe(400);
    expect((await save(withLayers([], { type: "image", assetId: clip }), 1)).status).toBe(400);
    expect((await save(withLayers([text({ start: 3, end: 1 })]), 1)).status).toBe(400);
    expect((await save(withLayers([], { type: "color", color: "red" }), 1)).status).toBe(400);
  });
  it("puts layers on the final clock and sends their media once, after the scenes' inputs", async () => {
    const logo = { id: crypto.randomUUID(), type: "image", assetId: image, start: 0, end: 5, position: "top-right", width: 0.2, opacity: 0.8 };
    const broll = { id: crypto.randomUUID(), type: "broll", assetId: clip, start: 4, end: 6, trim: 2 };
    const still = { id: crypto.randomUUID(), type: "broll", assetId: image, start: 7, end: 8, trim: 0 };
    const late = { ...text(), id: crypto.randomUUID(), start: 50, end: 60 };
    await save(withLayers([text(), logo, broll, still, late], { type: "image", assetId: image }), 0);
    expect((await call(`/video-studio/projects/${project}/render`, "POST", { idempotencyKey: crypto.randomUUID(), credits: 0 })).status).toBe(202);
    const payload = JSON.parse((sqlite.prepare("SELECT payload FROM media_tasks").get() as any).payload);
    // video, voice | background (looped, its own input) | image (overlay and still share one input) | clip | music
    expect(payload.inputs).toEqual([`audio/u/${video}.mp4`, `audio/u/${audio}.wav`, `media/u/${image}/original`, `media/u/${image}/original`, `media/u/${clip}/original`, `media/u/${music}/original`]);
    expect(payload.timeline.scenes[0].background).toEqual({ input: 2 });
    expect(payload.timeline.layers).toEqual([
      { kind: "image", input: 3, start: 0, end: 5, position: "top-right", width: 0.2, opacity: 0.8 },
      { kind: "broll", input: 4, start: 4, end: 6, trim: 2, still: false },
      { kind: "broll", input: 3, start: 7, end: 8, trim: 0, still: true },
    ]);
    // A layer starting after the scene ends is dropped; text becomes subtitle events.
    expect(payload.texts.map((t: any) => t.start)).toEqual([0]);
  });
  it("explains a clip trimmed past its end and a missing layer file", async () => {
    await save(withLayers([{ id: crypto.randomUUID(), type: "broll", assetId: clip, start: 1, end: 2, trim: 12 }]), 0);
    expect(((await (await call(`/video-studio/projects/${project}/render/quote`)).json()) as any).error).toMatch(/след края на клипа/);
    await save(withLayers([{ id: crypto.randomUUID(), type: "image", assetId: image, start: 1, end: 2, position: "center", width: 0.3, opacity: 1 }]), 1);
    sqlite.prepare("UPDATE media_assets SET expires_at=1 WHERE id=?").run(image);
    expect(((await (await call(`/video-studio/projects/${project}/render/quote`)).json()) as any).error).toMatch(/слоевете/);
  });
  it("writes text layers as positioned, escaped subtitle events under the captions", async () => {
    const { captionAss, withTextLayers } = await import("../server/caption-ass");
    const base = captionAss({ ...defaultCaptions, words: [{ text: "Здравей", start: 0, end: 1 }] });
    const ass = withTextLayers(base, [text({ position: "top-left", box: null, bold: false }) as any, text() as any], 720, 1280);
    expect(ass).toContain("Style: T,"); expect(ass).toContain("Style: TB,");
    expect(ass).toContain("{\\an7\\pos(36,64)\\fs77\\b0");
    expect(ass).toContain("{\\an2\\pos(360,1216)\\fs77\\b1");
    // Braces cannot inject override tags; line breaks become \N.
    expect(ass).toContain("Ново: ｛лято｝\\NОферта");
    // Text events come before the captions, so captions are drawn on top.
    expect(ass.indexOf("Ново")).toBeLessThan(ass.indexOf("Здравей"));
  });
});

describe("brand kit and templates", () => {
  const logo = crypto.randomUUID(), sting = crypto.randomUUID(), foreign = crypto.randomUUID();
  beforeEach(() => {
    const asset = sqlite.prepare("INSERT INTO media_assets(id,user_id,object_key,name,kind,mime,bytes,status,duration,created_at,expires_at) VALUES(?,?,?,?,?,?,1000,'ready',?,1,?)");
    asset.run(logo, "u", `media/u/${logo}/original`, "Лого.png", "product", "image/png", 0, now() + 86400);
    asset.run(sting, "u", `media/u/${sting}/original`, "Интро.mp4", "upload", "video/mp4", 4, now() + 86400);
    sqlite.prepare("INSERT INTO media_limits VALUES('other',1000000000,30)").run();
    asset.run(foreign, "other", `media/other/${foreign}/original`, "x.png", "product", "image/png", 0, now() + 86400);
  });
  const kit = (changes = {}) => ({
    name: "Реч БГ", logo: { assetId: logo, position: "top-right", width: 0.2, opacity: 0.9 },
    colors: { primary: "#5667f5", secondary: "#111111", text: "#ffffff" },
    captionLook: { style: "neon", format: "1:1", position: "top", enabled: true, accent: "#ff00aa" },
    intro: { assetId: sting, seconds: 3 }, outro: { assetId: logo, seconds: 2 }, ...changes,
  });
  it("returns a default kit, saves the user's own files and rejects other users' files", async () => {
    const empty = await (await call("/video-studio/brand")).json() as any;
    expect(empty.kit).toMatchObject({ logo: null, intro: null, colors: { primary: "#5667f5" } });
    expect((await call("/video-studio/brand", "PUT", kit())).status).toBe(200);
    expect((await (await call("/video-studio/brand")).json() as any).kit.captionLook.style).toBe("neon");
    expect((await call("/video-studio/brand", "PUT", kit({ logo: { assetId: foreign, position: "top", width: 0.2, opacity: 1 } }))).status).toBe(400);
    // A clip is not a logo.
    expect((await call("/video-studio/brand", "PUT", kit({ logo: { assetId: sting, position: "top", width: 0.2, opacity: 1 } }))).status).toBe(400);
    expect((await call("/video-studio/brand", "GET", undefined, "o")).status).toBe(200);
    expect(((await (await call("/video-studio/brand", "GET", undefined, "o")).json()) as any).kit.logo).toBeNull();
  });
  it("saves a template without recordings and starts a new project from it with fresh scene IDs", async () => {
    await save({ ...doc(), captionLook: kit().captionLook, intro: kit().intro } as any, 0);
    expect((await call("/video-studio/templates", "POST", { projectId: project, name: "Реклама" })).status).toBe(201);
    expect((await call("/video-studio/templates", "POST", { projectId: project, name: "x" }, "o")).status).toBe(404);
    const list = await (await call("/video-studio/templates")).json() as any;
    expect(list.templates).toEqual([expect.objectContaining({ name: "Реклама", scenes: 1, intro: true, music: true })]);
    const stored = JSON.parse((sqlite.prepare("SELECT document FROM studio_templates").get() as any).document);
    expect(stored.scenes[0]).toMatchObject({ audioJobId: null, videoJobId: null, history: [], audioFor: null, speechStart: 1.5 });
    const r = await call(`/video-studio/templates/${list.templates[0].id}/use`, "POST", { title: "Нова реклама" });
    expect(r.status).toBe(201);
    const { id } = await r.json() as any;
    expect(sqlite.prepare("SELECT title,mode FROM projects WHERE id=?").get(id)).toEqual({ title: "Нова реклама", mode: "studio" });
    const created = await (await call(`/video-studio/projects/${id}/document`)).json() as any;
    expect(created.revision).toBe(1);
    expect(created.document.scenes[0].id).not.toBe(stored.scenes[0].id);
    expect(created.document).toMatchObject({ intro: { assetId: sting }, captionLook: { style: "neon" }, music: { assetId: music } });
    expect((await call(`/video-studio/templates/${list.templates[0].id}/use`, "POST", { title: "x" }, "o")).status).toBe(404);
    expect((await call(`/video-studio/templates/${list.templates[0].id}`, "DELETE", undefined, "o")).status).toBe(200);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM studio_templates").get()!.n).toBe(1);
  });
  it("wraps the final video in the intro and outro and shifts everything after the intro", async () => {
    await env.AUDIO.put(`audio/u/${audio}.captions.json`, JSON.stringify({ ...defaultCaptions, words: [{ text: "Здравей", start: 0.2, end: 0.8 }] }));
    await save({ ...doc(), intro: { assetId: sting, seconds: 10 }, outro: { assetId: logo, seconds: 2 } } as any, 0);
    const quote = await (await call(`/video-studio/projects/${project}/render/quote`)).json() as any;
    // The 4-second clip caps the intro: 4 + 13.5 + 2.
    expect(quote.length).toBe(19.5);
    await call(`/video-studio/projects/${project}/render`, "POST", { idempotencyKey: crypto.randomUUID(), credits: quote.credits });
    const payload = JSON.parse((sqlite.prepare("SELECT payload FROM media_tasks").get() as any).payload);
    expect(payload.timeline.intro).toEqual({ input: 2, seconds: 4, still: false });
    expect(payload.timeline.outro).toEqual({ input: 3, seconds: 2, still: true });
    expect(payload.captions[0].offset).toBe(5.5);
    expect(payload.timeline.music.ranges).toEqual([[5.7, 6.3]]);
  });
  it("starts a new recording's captions with the project's caption look", async () => {
    const { initialCaptions } = await import("../server/studio-speech");
    await save({ ...doc(), captionLook: kit().captionLook } as any, 0);
    const captions = JSON.parse(await initialCaptions(env, { project_id: project, user_id: "u" }, [{ text: "Здравей", start: 0, end: 1 }]));
    expect(captions).toMatchObject({ style: "neon", format: "1:1", position: "top", accent: "#ff00aa", words: [{ text: "Здравей" }] });
    const plain = JSON.parse(await initialCaptions(env, { project_id: "tts-project", user_id: "u" }, []));
    expect(plain).toEqual({ ...defaultCaptions, words: [] });
  });
});

describe("project job listing", () => {
  it("lists only the signed-in user's jobs of one project", async () => {
    const mine = await (await call(`/jobs?project=${project}`)).json() as any;
    expect(mine.jobs.map((j: any) => j.id).sort()).toEqual([audio, video].sort());
    expect((await (await call(`/jobs?project=tts-project`)).json() as any).jobs).toEqual([]);
    expect((await (await call(`/jobs?project=${project}`, "GET", undefined, "o")).json() as any).jobs).toEqual([]);
  });
});
