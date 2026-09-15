import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../server/index";
import { AudioGeneration } from "../server/workflow";
import { database, bucket } from "./helpers";
import { sha } from "../server/security";
import { now } from "../server/types";
import { alignmentWords, captionStyles, subtitleFile } from "../shared/captions";
import { validateStudioScript, validateSuggestedDelivery } from "../shared/studio";

let env: any, sqlite: ReturnType<typeof database>["sqlite"];
const projectId = "c2c73a21-e858-4cc0-b1bf-dcda90777001";
const step: any = { do: async (_name: string, ...args: any[]) => args.at(-1)() };
beforeEach(async () => {
  const d = database(); sqlite = d.sqlite;
  sqlite.exec("INSERT INTO users VALUES('u','owner@example.com','Owner','hash',1,NULL,1)");
  sqlite.prepare("INSERT INTO sessions VALUES(?,'u',?)").run(await sha("session"), now() + 3600);
  sqlite.prepare("INSERT INTO projects VALUES(?,'u','Video','studio','Здравей свят!','studio-boris','boris',0,1,1)").run(projectId);
  env = { DB: d.db, AUDIO: bucket(), AI: { run: vi.fn() }, ELEVENLABS_API_KEY: "private-key", GENERATION: { create: vi.fn() } };
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); sqlite.close(); });
function request(path: string, data?: unknown, method = "POST") {
  return worker.fetch(new Request("https://rechbg.com/api" + path, {
    method, headers: { Origin: "https://rechbg.com", Cookie: "rech_session=session", "Content-Type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), env, { waitUntil: () => {} } as any);
}
async function generate(key = crypto.randomUUID(), credits = 39) {
  return request("/generate", { projectId, idempotencyKey: key, credits });
}
function speech() {
  const chars = [..."Здравей свят!"];
  return { audio_base64: btoa("\0".repeat(48000)), normalized_alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * .05), character_end_times_seconds: chars.map((_, i) => (i + 1) * .05) } };
}
it("reserves the premium quote once and rejects stale quotes or missing credentials", async () => {
  expect((await generate(crypto.randomUUID(), 12)).status).toBe(409);
  env.ELEVENLABS_API_KEY = "";
  expect((await generate()).status).toBe(503);
  expect(sqlite.prepare("SELECT COUNT(*) n FROM jobs").get()!.n).toBe(0);
  env.ELEVENLABS_API_KEY = "private-key";
  const key = crypto.randomUUID();
  const first = await (await generate(key)).json();
  expect(await (await generate(key)).json()).toEqual(first);
  expect(sqlite.prepare("SELECT used FROM usage_windows").get()!.used).toBe(39);
  expect(env.GENERATION.create).toHaveBeenCalledTimes(1);
});
it("sends v3 Bulgarian speech through the official SDK, stores WAV and timings, and replays without another paid call", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(speech())); vi.stubGlobal("fetch", fetch);
  const { id } = await (await generate()).json() as any;
  await new AudioGeneration({} as any, env).run({ payload: { jobId: id } } as any, step);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, opts] = fetch.mock.calls[0];
  expect(String(url)).toContain("/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/with-timestamps");
  expect(String(url)).toContain("output_format=pcm_24000");
  expect(JSON.parse(opts.body)).toMatchObject({ model_id: "eleven_v3", language_code: "bg", text: "Здравей свят!" });
  const job = sqlite.prepare("SELECT * FROM jobs WHERE id=?").get(id)!;
  expect(job.status).toBe("completed"); expect(job.duration).toBe(1);
  const wav = env.AUDIO.objects.get(job.audio_key).bytes;
  expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
  const captions = await (await request(`/video-studio/captions/${id}`, undefined, "GET")).json() as any;
  expect(captions.words.map((w: any) => w.text)).toEqual(["Здравей", "свят!"]);
  sqlite.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);
  await new AudioGeneration({} as any, env).run({ payload: { jobId: id } } as any, step);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sqlite.prepare("SELECT used FROM usage_windows").get()!.used).toBe(39);
});
it("does not retry paid provider failures and refunds only once", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ detail: { status: "quota_exceeded", message: "No credits" } }, { status: 429 })); vi.stubGlobal("fetch", fetch);
  const { id } = await (await generate()).json() as any;
  await expect(new AudioGeneration({} as any, env).run({ payload: { jobId: id } } as any, step)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(id)!.status).toBe("failed");
  expect(sqlite.prepare("SELECT used FROM usage_windows").get()!.used).toBe(0);
  await expect(new AudioGeneration({} as any, env).run({ payload: { jobId: id } } as any, step)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sqlite.prepare("SELECT used FROM usage_windows").get()!.used).toBe(0);
});
it("never resubmits an ambiguous previous paid request", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const { id } = await (await generate()).json() as any;
  sqlite.prepare("UPDATE jobs SET submitted_at=1 WHERE id=?").run(id);
  await expect(new AudioGeneration({} as any, env).run({ payload: { jobId: id } } as any, step)).rejects.toThrow("already attempted");
  expect(fetch).not.toHaveBeenCalled();
});
it("prevents cheap audio mode from selecting a premium voice", async () => {
  const result = await request("/projects", { title: "Cheap", mode: "tts", script: "Text", voice: "studio-boris", second_voice: "boris" });
  expect(result.status).toBe(400);
});
it("limits delivery assistance and rejects script rewriting", async () => {
  env.AI.run.mockResolvedValue({ output_text: "[excited]Здравей свят!" });
  const result = await request("/video-studio/delivery", { text: "Здравей свят!", tone: "ad" });
  expect(await result.json()).toEqual({ text: "[excited]Здравей свят!" });
  env.AI.run.mockResolvedValue({ output_text: "Купете сега!" });
  expect((await request("/video-studio/delivery", { text: "Здравей свят!", tone: "ad" })).status).toBe(422);
  for (let i = 0; i < 3; i++) await request("/video-studio/delivery", { text: "Здравей свят!", tone: "ad" });
  expect((await request("/video-studio/delivery", { text: "Здравей свят!", tone: "ad" })).status).toBe(429);
});
it("protects caption ownership and validates edited timings", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(speech())));
  const { id } = await (await generate()).json() as any;
  await new AudioGeneration({} as any, env).run({ payload: { jobId: id } } as any, step);
  const doc = { words: [{ text: "Здравей", start: 0, end: .4 }, { text: "свят!", start: .5, end: .9 }], style: "bold", format: "1:1", position: "middle", enabled: true };
  expect((await request(`/video-studio/captions/${id}`, doc, "PUT")).status).toBe(200);
  expect((await request(`/video-studio/captions/${id}`, { ...doc, words: [{ text: "test", start: 0, end: 100 }] }, "PUT")).status).toBe(400);
  sqlite.exec("INSERT INTO users VALUES('other','other@example.com','Other','hash',1,NULL,1)");
  sqlite.prepare("UPDATE jobs SET user_id='other' WHERE id=?").run(id);
  expect((await request(`/video-studio/captions/${id}`, undefined, "GET")).status).toBe(404);
  expect((await request(`/video-studio/captions/${id}`, doc, "PUT")).status).toBe(404);
});
it("round-trips every caption preset and export option while rejecting malformed looks", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(speech())));
  const { id } = await (await generate()).json() as any;
  await new AudioGeneration({} as any, env).run({ payload: { jobId: id } } as any, step);
  const path = `/video-studio/captions/${id}`;
  const doc = { words: [{ text: "История", start: 0, end: .4 }], style: "karaoke", format: "4:5", position: "top", enabled: true, accent: "#ffe16b", textColor: "#ffffff", size: 1.2, uppercase: true, resolution: "1080p", fit: "cover" };
  for (const style of captionStyles) {
    expect((await request(path, { ...doc, style }, "PUT")).status).toBe(200);
    expect(await (await request(path, undefined, "GET")).json()).toEqual({ ...doc, style });
  }
  for (const invalid of [{ accent: "red" }, { textColor: "url(x)" }, { size: 10 }, { resolution: "4k" }, { fit: "stretch" }, { style: "unknown" }]) {
    expect((await request(path, { ...doc, ...invalid }, "PUT")).status).toBe(400);
  }
  expect((await request(path, { ...doc, enabled: false }, "PUT")).status).toBe(200);
});
it("strips performance cues from timed captions and exports proper subtitle files", () => {
  const characters = [..."[laughs]Здравей свят!"];
  const words = alignmentWords({ characters, characterStartTimesSeconds: characters.map((_, i) => i / 10), characterEndTimesSeconds: characters.map((_, i) => (i + 1) / 10) });
  expect(words.map(w => w.text)).toEqual(["Здравей", "свят!"]);
  expect(subtitleFile(words, "srt")).toContain("00:00:00,800 --> 00:00:02,100");
  expect(subtitleFile(words, "vtt")).toMatch(/^WEBVTT\n\n/);
  expect(() => validateSuggestedDelivery("Здравей!", "[excited]Здравей!")).not.toThrow();
  expect(() => validateSuggestedDelivery("Здравей!", "[excited]Друго!")).toThrow();
  expect(() => validateStudioScript("[unknown]Текст")).toThrow();
});
