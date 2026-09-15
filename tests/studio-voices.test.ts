import { beforeEach, afterEach, expect, it, vi } from "vitest";
import worker from "../server/index";
import { AudioGeneration } from "../server/workflow";
import { database, bucket } from "./helpers";
import { now } from "../server/types";
import { sha } from "../server/security";
import { sampleSentence } from "../shared/catalog";
let env: any, sqlite: ReturnType<typeof database>["sqlite"];
const adminPath = "/admin/studio-voices/studio-boris";
const configuration = { name: "Александър", description: "Уверен разказвач", providerVoiceId: "CustomVoice123" };
beforeEach(async () => {
  const d = database(); sqlite = d.sqlite;
  sqlite.exec("INSERT INTO users VALUES('u','owner@example.com','Owner','hash',1,NULL,1)");
  sqlite.prepare("INSERT INTO sessions VALUES(?,'u',?)").run(await sha("session"), now() + 3600);
  env = { DB: d.db, AUDIO: bucket(), AI: { run: vi.fn() }, ELEVENLABS_API_KEY: "private-key", ADMIN_EMAILS: "owner@example.com", GENERATION: { create: vi.fn() } };
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); sqlite.close(); });
function request(path: string, body?: unknown, method = "GET", authenticated = true) {
  return worker.fetch(new Request("https://rechbg.com/api" + path, { method,
    headers: { Origin: "https://rechbg.com", ...(authenticated ? { Cookie: "rech_session=session" } : {}), ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  }), env, { waitUntil: () => {} } as any);
}
it("restricts management to admins and redacts provider mappings from the studio", async () => {
  expect((await request(adminPath, configuration, "PUT", false)).status).toBe(401);
  env.ADMIN_EMAILS = "someone@example.com";
  expect((await request(adminPath, configuration, "PUT")).status).toBe(403);
  expect((await request("/admin/voices/studio-boris/sample/generate", undefined, "POST")).status).toBe(403);
  env.ADMIN_EMAILS = "owner@example.com";
  expect((await request(adminPath, configuration, "PUT")).status).toBe(200);
  const publicConfig = await (await request("/video-studio/config")).json() as any;
  expect(publicConfig.voices[0]).toEqual({ id: "studio-boris", name: configuration.name, description: configuration.description, sampleUrl: null });
  expect(JSON.stringify(publicConfig)).not.toContain("CustomVoice123");
  expect(JSON.stringify(publicConfig)).not.toContain("providerVoiceId");
  expect((await request(adminPath, { ...configuration, providerVoiceId: "../bad" }, "PUT")).status).toBe(400);
  expect((await request("/admin/studio-voices/unknown", configuration, "PUT")).status).toBe(400);
});
it("uses admin mappings ahead of environment and defaults, including normal generation", async () => {
  env.ELEVENLABS_VOICES = JSON.stringify({ "studio-boris": "EnvironmentVoice" });
  const initial = await (await request("/admin/studio-voices")).json() as any;
  expect(initial.voices[0]).toMatchObject({ providerVoiceId: "EnvironmentVoice", source: "environment" });
  await request(adminPath, configuration, "PUT");
  const mock = vi.fn().mockImplementation(() => Response.json({ audio_base64: btoa("\0".repeat(48000)), alignment: { characters: ["З"], character_start_times_seconds: [0], character_end_times_seconds: [.3] } }));
  vi.stubGlobal("fetch", mock);
  const p = await (await request("/projects", { title: "Test", mode: "studio", voice: "studio-boris", second_voice: "boris", script: "Здравей!" }, "POST")).json() as any;
  const result = await (await request("/generate", { projectId: p.id, idempotencyKey: crypto.randomUUID(), credits: 24 }, "POST")).json() as any;
  await new AudioGeneration({} as any, env).run({ payload: { jobId: result.id } } as any, { do: async (_: string, ...args: any[]) => args.at(-1)() } as any);
  expect(String(mock.mock.calls[0][0])).toContain("/CustomVoice123/with-timestamps");
  expect(sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(result.id)!.status).toBe("completed");
  expect((await request(adminPath, undefined, "DELETE")).status).toBe(200);
  const remaining = await (await request("/admin/studio-voices")).json() as any;
  expect(remaining.voices.some((v: any) => v.id === "studio-boris")).toBe(false);
});
it("generates a private draft, publishes it explicitly, and rejects stale voice samples", async () => {
  const saved = await (await request(adminPath, configuration, "PUT")).json() as any;
  const mock = vi.fn().mockImplementation(() => Response.json({ audio_base64: btoa("\0".repeat(48000)) }));
  vi.stubGlobal("fetch", mock);
  const generated = await request("/admin/voices/studio-boris/sample/generate", undefined, "POST");
  expect(generated.status).toBe(200);
  expect(generated.headers.get("X-Voice-Revision")).toBe(saved.voice.revision);
  expect(String(mock.mock.calls[0][0])).toContain("/CustomVoice123/with-timestamps");
  expect(JSON.parse(mock.mock.calls[0][1].body)).toMatchObject({ text: sampleSentence, model_id: "eleven_v3", language_code: "bg" });
  expect(sqlite.prepare("SELECT COUNT(*) n FROM voice_samples").get()!.n).toBe(0);
  expect(sqlite.prepare("SELECT COUNT(*) n FROM jobs").get()!.n).toBe(0);
  expect(sqlite.prepare("SELECT COUNT(*) n FROM usage_windows").get()!.n).toBe(0);
  const sample = await generated.blob();
  const upload = () => { const form = new FormData(); form.set("file", sample, "sample.wav"); form.set("voiceRevision", saved.voice.revision); return form; };
  expect((await request("/admin/voices/studio-boris/sample", upload(), "POST")).status).toBe(200);
  const catalog = await (await request("/video-studio/config")).json() as any;
  expect(catalog.voices[0].sampleUrl).toContain("/api/voices/studio-boris/sample");
  expect((await request("/voices/studio-boris/sample", undefined, "GET", false)).status).toBe(200);
  await request(adminPath, { ...configuration, providerVoiceId: "ChangedVoice" }, "PUT");
  expect((await (await request("/video-studio/config")).json() as any).voices[0].sampleUrl).toBeNull();
  expect((await request("/voices/studio-boris/sample", undefined, "GET", false)).status).toBe(404);
  expect((await request("/admin/voices/studio-boris/sample", upload(), "POST")).status).toBe(409);
  await request("/admin/voices/studio-boris/sample", undefined, "DELETE");
  expect(sqlite.prepare("SELECT COUNT(*) n FROM voice_samples").get()!.n).toBe(0);
});
it("does not retry failed paid sample calls and handles missing keys", async () => {
  env.ELEVENLABS_API_KEY = "";
  expect((await request("/admin/voices/studio-boris/sample/generate", undefined, "POST")).status).toBe(503);
  env.ELEVENLABS_API_KEY = "key";
  const mock = vi.fn().mockResolvedValue(Response.json({ detail: "Provider private error" }, { status: 500 }));
  vi.stubGlobal("fetch", mock);
  const result = await request("/admin/voices/studio-boris/sample/generate", undefined, "POST");
  expect(result.status).toBe(502); expect(mock).toHaveBeenCalledTimes(1);
  expect(await result.text()).not.toContain("Provider private error");
});

it("persists added voices independently, lists later pages, and can remove every default without resurrection", async () => {
  env.ADMIN_EMAILS = "other@example.com";
  expect((await request("/admin/studio-voices", configuration, "POST")).status).toBe(403);
  env.ADMIN_EMAILS = "owner@example.com";
  const [one, two] = await Promise.all([request("/admin/studio-voices", configuration, "POST"), request("/admin/studio-voices", { ...configuration, name: "Мария" }, "POST")]);
  expect(one.status).toBe(201); expect(two.status).toBe(201);
  const a = (await one.json() as any).voice, b = (await two.json() as any).voice;
  expect(a.id).not.toBe(b.id);
  const keys = [...env.AUDIO.objects.keys()];
  env.AUDIO.list = vi.fn(async ({ cursor }: any) => cursor ? { objects: [{ key: keys[1] }], truncated: false } : { objects: [{ key: keys[0] }], truncated: true, cursor: "page2" });
  const list = await (await request("/admin/studio-voices")).json() as any;
  expect(list.voices).toHaveLength(6);
  expect(list.voices.find((v: any) => v.id === a.id)).toMatchObject(configuration);
  expect(list.voices.find((v: any) => v.id === b.id)).toMatchObject({ name: "Мария" });
  expect(env.AUDIO.list).toHaveBeenCalledWith(expect.objectContaining({ cursor: "page2" }));
  for (const v of list.voices) expect((await request(`/admin/studio-voices/${v.id}`, undefined, "DELETE")).status).toBe(200);
  expect((await (await request("/video-studio/config")).json() as any).voices).toEqual([]);
  expect((await request(`/admin/studio-voices/${a.id}`, configuration, "PUT")).status).toBe(400);
});
it("accepts custom voices for projects and samples, and completes queued work after catalogue removal", async () => {
  const v = (await (await request("/admin/studio-voices", configuration, "POST")).json() as any).voice;
  const mock = vi.fn().mockImplementation(() => Response.json({ audio_base64: btoa("\0".repeat(48000)), alignment: { characters: ["З"], character_start_times_seconds: [0], character_end_times_seconds: [.3] } }));
  vi.stubGlobal("fetch", mock);
  const sample = await request(`/admin/voices/${v.id}/sample/generate`, undefined, "POST");
  expect(sample.status).toBe(200);
  const form = new FormData(); form.set("file", await sample.blob(), "sample.wav"); form.set("voiceRevision", v.revision);
  expect((await request(`/admin/voices/${v.id}/sample`, form, "POST")).status).toBe(200);
  const body = { title: "Custom", mode: "studio", voice: v.id, second_voice: "boris", script: "Здравей!" };
  const p = (await (await request("/projects", body, "POST")).json() as any).id;
  expect(p).toBeDefined();
  expect((await request(`/projects/${p}`, { ...body, title: "Updated" }, "PUT")).status).toBe(200);
  const job = (await (await request("/generate", { projectId: p, idempotencyKey: crypto.randomUUID(), credits: 24 }, "POST")).json() as any).id;
  expect(job).toBeDefined();
  expect((await request(`/admin/studio-voices/${v.id}`, undefined, "DELETE")).status).toBe(200);
  expect((await request(`/voices/${v.id}/sample`, undefined, "GET", false)).status).toBe(404);
  expect((await request("/generate", { projectId: p, idempotencyKey: crypto.randomUUID(), credits: 24 }, "POST")).status).toBe(400);
  await new AudioGeneration({} as any, env).run({ payload: { jobId: job } } as any, { do: async (_: string, ...args: any[]) => args.at(-1)() } as any);
  expect(sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(job)!.status).toBe("completed");
  expect(String(mock.mock.calls.at(-1)![0])).toContain("/CustomVoice123/with-timestamps");
  expect((await request("/projects", { ...body, voice: "studio-missing" }, "POST")).status).toBe(400);
  expect((await request("/projects", { ...body, mode: "tts" }, "POST")).status).toBe(400);
});
