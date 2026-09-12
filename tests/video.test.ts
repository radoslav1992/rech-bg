import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import worker, { maintenance } from "../server/index";
import { VideoGeneration, outputUrl, queueUrl, storeVideo } from "../server/video-workflow";
import { sha } from "../server/security";
import { now } from "../server/types";
import { videoCredits } from "../shared/video";
import { videoFailureMessage } from "../server/video-errors";
import { notifyVideo } from "../server/video-notifications";
import { database, bucket } from "./helpers";
const ticket = { request_id: "remote-1", status_url: "https://queue.fal.run/fal-ai/kling-video/requests/remote-1/status", response_url: "https://queue.fal.run/fal-ai/kling-video/requests/remote-1", cancel_url: "https://queue.fal.run/fal-ai/kling-video/requests/remote-1/cancel" };
const videoUrl = "https://v3.fal.media/files/test.mp4";
const mp4 = new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,1,44,0,0,1,44]);
const step = { do: async (_: string, options: any, fn?: any) => (fn || options)(), sleep: async () => {} };
let sqlite: ReturnType<typeof database>["sqlite"], env: any, sourceId: string, projectId: string;
function used() { return sqlite.prepare("SELECT used FROM usage_windows WHERE id='u:trial'").get()!.used; }
function request(path: string, init: RequestInit = {}, cookie = true) {
  return worker.fetch(new Request("https://rechbg.com/api" + path, {
    ...init, headers: { Origin: "https://rechbg.com", ...(cookie ? { Cookie: "rech_session=test-session" } : {}), ...init.headers },
  }), env, { waitUntil: () => {} } as any);
}
function form(tier = "medium", changes: Record<string, string> = {}) {
  const body = new FormData();
  for (const [key, value] of Object.entries({ sourceId, tier, idempotencyKey: crypto.randomUUID(), credits: tier === "high" ? "36000" : tier === "low" ? "6000" : "18000", consent: "true", ...changes })) body.set(key, value);
  body.set("image", new Blob([png]), "portrait.png");
  return body;
}
async function create(body = form()) {
  const r = await request("/videos", { method: "POST", body });
  expect(r.status).toBe(202);
  return (await r.json() as any).id as string;
}
function mockProvider() {
  let checks = 0;
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json(ticket);
    if (url === ticket.status_url) return Response.json({ status: ++checks === 1 ? "IN_PROGRESS" : "COMPLETED" });
    if (url === ticket.response_url) return Response.json({ video: { url: videoUrl } });
    if (url === videoUrl) return new Response(mp4, { headers: { "Content-Type": "video/mp4" } });
    if (url === ticket.cancel_url) return Response.json({});
    throw new Error("Unexpected request " + url);
  });
  vi.stubGlobal("fetch", mock); return mock;
}
beforeEach(async () => {
  const d = database(); sqlite = d.sqlite;
  env = { DB: d.db, AUDIO: bucket(), FAL_KEY: "test-secret", SITE_URL: "https://rechbg.com", VIDEO_GENERATION: { create: vi.fn().mockResolvedValue({}), get: vi.fn() }, GENERATION: { get: vi.fn(), create: vi.fn() } };
  projectId = crypto.randomUUID(); sourceId = crypto.randomUUID();
  sqlite.prepare("INSERT INTO users VALUES('u','u@example.com','User','hash',1,NULL,?)").run(now());
  sqlite.prepare("INSERT INTO users VALUES('other','other@example.com','Other','hash',1,NULL,?)").run(now());
  sqlite.prepare("INSERT INTO sessions VALUES(?,'u',?)").run(await sha("test-session"), now() + 3600);
  sqlite.prepare("INSERT INTO projects VALUES(?,'u','Story','tts','Hello','mila','boris',400,?,?)").run(projectId, now(), now());
  sqlite.prepare("INSERT INTO usage_windows VALUES('u:trial','u',250000,0)").run();
  sqlite.prepare("INSERT INTO jobs(id,user_id,project_id,window_id,idempotency_key,title,mode,script,voice,second_voice,pause_ms,chars,status,audio_key,duration,created_at,updated_at) VALUES(?,'u',?,'u:trial',?,'Story','tts','Hello','mila','boris',400,100,'completed',?,30,?,?)")
    .run(sourceId, projectId, sourceId, `audio/u/${sourceId}.wav`, now(), now());
  await env.AUDIO.put(`audio/u/${sourceId}.wav`, new Uint8Array(44));
});
afterEach(() => { vi.unstubAllGlobals(); sqlite.close(); });
describe("Video credits and request validation", () => {
  it("prices real duration, rounding up, and bounds supported clips", () => {
    expect(videoCredits(30, "medium")).toBe(18000);
    expect(videoCredits(30, "low")).toBe(6000);
    expect(videoCredits(30.1, "low")).toBe(6200);
    expect(videoCredits(30.1, "high")).toBe(37200);
    expect(() => videoCredits(4.9, "medium")).toThrow();
    expect(() => videoCredits(60.1, "medium")).toThrow();
    expect(() => videoCredits(NaN, "high")).toThrow();
  });
  it("reserves credits once for retries and enforces a single active job", async () => {
    const body = form(); const id = await create(body);
    const retry = await request("/videos", { method: "POST", body });
    expect((await retry.json() as any).id).toBe(id);
    expect(used()).toBe(18100); expect(env.VIDEO_GENERATION.create).toHaveBeenCalledTimes(1);
    expect((await request("/videos", { method: "POST", body: form() })).status).toBe(409);
    expect(used()).toBe(18100);
  });
  it("rejects missing auth, unverified users, cross-origin requests and missing configuration", async () => {
    expect((await request("/videos", { method: "POST", body: form() }, false)).status).toBe(401);
    expect((await request("/videos", { method: "POST", body: form(), headers: { Origin: "https://evil.invalid" } })).status).toBe(403);
    sqlite.prepare("UPDATE users SET verified=0 WHERE id='u'").run();
    expect((await request("/videos", { method: "POST", body: form() })).status).toBe(403);
    sqlite.prepare("UPDATE users SET verified=1 WHERE id='u'").run(); env.FAL_KEY = undefined;
    expect((await request("/videos", { method: "POST", body: form() })).status).toBe(503);
    expect(used()).toBe(100);
  });
  it("rejects forged costs, missing consent, missing source and insufficient credits", async () => {
    expect((await request("/videos", { method: "POST", body: form("medium", { credits: "1" }) })).status).toBe(409);
    expect((await request("/videos", { method: "POST", body: form("medium", { consent: "false" }) })).status).toBe(400);
    expect((await request("/videos", { method: "POST", body: form("medium", { sourceId: crypto.randomUUID() }) })).status).toBe(404);
    sqlite.prepare("UPDATE jobs SET user_id='other' WHERE id=?").run(sourceId);
    expect((await request("/videos", { method: "POST", body: form() })).status).toBe(404);
    sqlite.prepare("UPDATE jobs SET user_id='u',mode='podcast' WHERE id=?").run(sourceId);
    expect((await request("/videos", { method: "POST", body: form() })).status).toBe(400);
    sqlite.prepare("UPDATE jobs SET mode='tts' WHERE id=?").run(sourceId);
    sqlite.prepare("UPDATE usage_windows SET quota=1000").run();
    expect((await request("/videos", { method: "POST", body: form() })).status).toBe(402);
    expect(used()).toBe(100); expect(env.VIDEO_GENERATION.create).not.toHaveBeenCalled();
  });
  it("requires a real image and consent for high quality", async () => {
    expect((await request("/videos", { method: "POST", body: form("high", { consent: "false" }) })).status).toBe(400);
    const bad = form("high", { consent: "true" }); bad.set("image", new Blob(["x".repeat(100)]), "portrait.png");
    expect((await request("/videos", { method: "POST", body: bad })).status).toBe(400);
    const body = form("high", { consent: "true" }); body.set("image", new Blob([png]), "portrait.png");
    await create(body); expect(used()).toBe(36100);
  });
  it("keeps a reservation on ambiguous dispatch and cron selects the video workflow", async () => {
    env.VIDEO_GENERATION.create.mockRejectedValueOnce(new Error("timeout"));
    const id = await create(); expect(used()).toBe(18100);
    sqlite.prepare("UPDATE jobs SET updated_at=? WHERE id=?").run(now()-1000, id);
    env.VIDEO_GENERATION.get.mockRejectedValue(new Error("not found"));
    await maintenance(env);
    expect(env.VIDEO_GENERATION.create).toHaveBeenCalledTimes(2);
    expect(env.GENERATION.get).not.toHaveBeenCalled();
  });
});
describe("Three-tier provider routing", () => {
  it("enables each tier independently and rejects unavailable tiers before reserving credits", async () => {
    let config = await (await request("/videos/config")).json() as any;
    expect(config.tiers.low.enabled).toBe(false);
    expect(config.tiers.medium.enabled).toBe(true);
    expect(config.tiers.high.enabled).toBe(true);
    expect((await request("/videos", { method: "POST", body: form("low") })).status).toBe(503);
    expect(used()).toBe(100);
    env.WAVESPEED_API_KEY = "wave-secret"; delete env.FAL_KEY;
    config = await (await request("/videos/config")).json() as any;
    expect(config.enabled).toBe(true);
    expect(config.tiers.low.enabled).toBe(true);
    expect(config.tiers.medium.enabled).toBe(false);
    expect(config.tiers.high.enabled).toBe(false);
    expect((await request("/videos", { method: "POST", body: form("high") })).status).toBe(503);
    expect((await request("/videos", { method: "POST", body: form("low", { consent: "false" }) })).status).toBe(400);
    const noImage = form("low"); noImage.delete("image");
    expect((await request("/videos", { method: "POST", body: noImage })).status).toBe(400);
    expect(used()).toBe(100);
  });
  it("completes low-quality video through WaveSpeed with private inputs and no fal credential", async () => {
    env.WAVESPEED_API_KEY = " wave-secret\n"; delete env.FAL_KEY;
    const id = await create(form("low"));
    const output = "https://cdn.wavespeed.ai/outputs/clip.mp4";
    const statusUrl = "https://api.wavespeed.ai/api/v3/predictions/wave-1/result";
    let checks = 0;
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === output) { expect(init?.headers).toBeUndefined(); return new Response(mp4); }
      expect((init?.headers as any).Authorization).toBe("Bearer wave-secret");
      if (init?.method === "POST") {
        expect(url).toBe("https://api.wavespeed.ai/api/v3/wavespeed-ai/infinitetalk-fast");
        const input = JSON.parse(init.body as string);
        expect(Object.keys(input).sort()).toEqual(["audio", "image"]);
        for (const asset of ["audio", "image"]) {
          const u = new URL(input[asset]);
          expect(u.pathname).toBe(`/api/video-inputs/${id}/${asset}`);
          expect((await request(u.pathname.replace("/api", "") + u.search, {}, false)).status).toBe(200);
        }
        return Response.json({ code: 200, data: { id: "wave-1", status: "created", urls: { get: "https://evil.test/status" } } });
      }
      expect(url).toBe(statusUrl);
      return Response.json({ code: 200, data: { id: "wave-1", status: ++checks === 1 ? "created" : checks === 2 ? "processing" : "completed", outputs: checks >= 3 ? [output] : [] } });
    }); vi.stubGlobal("fetch", mock);
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    const row = sqlite.prepare("SELECT * FROM jobs WHERE id=?").get(id)!;
    expect(row.status).toBe("completed"); expect(used()).toBe(6100);
    expect(JSON.parse(row.provider_request as string)).toMatchObject({ provider: "wavespeed", request_id: "wave-1", status_url: statusUrl });
    expect(env.AUDIO.objects.has(JSON.parse(row.video_meta as string).imageKey)).toBe(false);
    expect((await (await request(`/jobs/${id}`)).json() as any).job.video_tier).toBe("low");
    expect(new Uint8Array(await (await request(`/jobs/${id}/video`)).arrayBuffer())).toEqual(mp4);
    expect(mock.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1);
  });
  it.each(["failed", "cancelled", "timeout", "deleted"])("refunds low-quality credits once on provider status %s", async terminal => {
    env.WAVESPEED_API_KEY = "wave-secret";
    const id = await create(form("low"));
    const mock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ code: 200, data: {
      id: "wave-1", status: init?.method === "POST" ? "created" : terminal, error: "private input-url and provider details",
    } })); vi.stubGlobal("fetch", mock);
    const flow = new (VideoGeneration as any)({}, env);
    await expect(flow.run({ payload: { jobId: id } }, step)).rejects.toThrow();
    await expect(flow.run({ payload: { jobId: id } }, step)).rejects.toThrow();
    expect(used()).toBe(100);
    expect(mock.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1);
    expect(await (await request(`/jobs/${id}`)).text()).not.toContain("private input-url");
  });
  it("handles WaveSpeed application errors in HTTP 200 responses without keeping reserved credits", async () => {
    env.WAVESPEED_API_KEY = "wave-secret";
    const id = await create(form("low"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ code: 402, message: "insufficient balance" })));
    await expect(new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step)).rejects.toThrow("VIDEO_SUBMIT_BALANCE_402");
    expect(used()).toBe(100);
  });
  it("resumes a saved WaveSpeed ticket without another paid POST", async () => {
    env.WAVESPEED_API_KEY = "wave-secret";
    const id = await create(form("low"));
    sqlite.prepare("UPDATE jobs SET submitted_at=?,provider_request=? WHERE id=?").run(now(), JSON.stringify({ provider: "wavespeed", request_id: "wave-1", status_url: "https://evil.test", response_url: "https://evil.test" }), id);
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).not.toBe("POST");
      if (url === videoUrl) { expect(init?.headers).toBeUndefined(); return new Response(mp4); }
      expect(url).toBe("https://api.wavespeed.ai/api/v3/predictions/wave-1/result");
      return Response.json({ data: { id: "wave-1", status: "completed", outputs: [{ url: videoUrl }] } });
    }); vi.stubGlobal("fetch", mock);
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    expect(used()).toBe(6100);
  });
  it("preserves old Argil job routing and does not offer Argil for new requests", async () => {
    expect((await request("/videos", { method: "POST", body: form("standard") })).status).toBe(400);
    const id = await create();
    sqlite.prepare("UPDATE jobs SET video_tier='standard',video_meta=json_set(json_remove(video_meta,'$.tier'),'$.avatar','mia') WHERE id=?").run(id);
    const mock = mockProvider();
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    const call = mock.mock.calls.find(c => c[1]?.method === "POST")!;
    expect(call[0]).toBe("https://queue.fal.run/argil/avatars/audio-to-video");
    expect(JSON.parse(call[1]!.body as string).avatar).toBe("Mia outdoor (UGC)");
    expect(used()).toBe(18100);
  });
});
describe("Video workflow and private assets", () => {
  it("notifies the verified owner once after completion with a link to the exact video", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "mail-1" });
    env.EMAIL = { send };
    const id = await create(form("medium", { notifyEmail: "true" }));
    mockProvider();
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    await notifyVideo(env, id);
    await maintenance(env);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: "u@example.com", subject: "Видеото ви е готово — Реч БГ" });
    expect(send.mock.calls[0][0].text).toContain(`/app/studio/${projectId}?job=${id}`);
    const job = (await (await request(`/jobs/${id}`)).json() as any).job;
    expect(job).toMatchObject({ status: "completed", notify_email: true, email_status: "sent", video_phase: "saving" });
    expect(JSON.stringify(job)).not.toMatch(/video_meta|token|test-secret/);
  });
  it("keeps completed media and charged quota if email delivery fails", async () => {
    const send = vi.fn().mockRejectedValue(new Error("Email unavailable")); env.EMAIL = { send };
    const id = await create(form("medium", { notifyEmail: "true" }));
    mockProvider();
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    await notifyVideo(env, id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(used()).toBe(18100);
    expect((await (await request(`/jobs/${id}`)).json() as any).job).toMatchObject({ status: "completed", email_status: "failed" });
    expect((await request(`/jobs/${id}/video`)).status).toBe(200);
  });
  it("does not send notification emails without opt-in", async () => {
    const send = vi.fn(); env.EMAIL = { send };
    const id = await create(); mockProvider();
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    expect(send).not.toHaveBeenCalled();
  });
  it("notifies of failure only after refunding video credits", async () => {
    const send = vi.fn(async () => { expect(used()).toBe(100); return { messageId: "failed-mail" }; }); env.EMAIL = { send };
    const id = await create(form("medium", { notifyEmail: "true" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ detail: "Payment required" }, { status: 402 })));
    await expect(new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as any)[0].subject).toBe("Видеото не беше създадено — Реч БГ");
  });
  it.each([
    [401, { detail: "Invalid key test-secret" }, "AUTH"],
    [402, { detail: "Payment required" }, "BALANCE"],
    [403, { detail: "User is locked. Reason: Exhausted balance. Top up your balance." }, "BALANCE"],
    [403, { detail: "Access denied" }, "ACCESS"],
    [422, { detail: [{ type: "string_type", loc: ["body", "audio_url"], input: "https://private.invalid/?token=test-secret" }] }, "INPUT"],
    [429, { detail: "Too many requests" }, "CAPACITY"],
  ])("reports submission HTTP %i safely and refunds once", async (status, body, category) => {
    const id = await create();
    const mock = vi.fn().mockImplementation(async () => Response.json(body, { status: status as number }));
    vi.stubGlobal("fetch", mock);
    const code = `VIDEO_SUBMIT_${category}_${status}`;
    await expect(new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step)).rejects.toThrow(code);
    const detail = await (await request(`/jobs/${id}`)).text();
    expect(detail).toContain(code);
    expect(detail).not.toMatch(/test-secret|private.invalid|User is locked/);
    expect(used()).toBe(100); expect(mock).toHaveBeenCalledTimes(1);
    expect(videoFailureMessage(new Error(`Workflow step failed: ${code}`), "LOAD").code).toBe(code);
  });
  it("distinguishes result validation failures from submission failures", async () => {
    const id = await create();
    const mock = mockProvider();
    const original = mock.getMockImplementation()!;
    mock.mockImplementation(async (url, init) => url === ticket.response_url
      ? Response.json({ detail: [{ type: "content_policy_violation", input: "private script" }] }, { status: 422 })
      : original(url, init));
    await expect(new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step)).rejects.toThrow("VIDEO_RESULT_CONTENT_422");
    expect(used()).toBe(100);
    expect(mock.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1);
  });
  it("completes Kling Standard generation, stores MP4 privately and expires input access", async () => {
    delete env.SITE_URL;
    env.FAL_KEY = " test-secret\n";
    const id = await create(); const mock = mockProvider();
    const meta = JSON.parse(sqlite.prepare("SELECT video_meta FROM jobs WHERE id=?").get(id)!.video_meta as string);
    expect((await request(`/video-inputs/${id}/audio?token=${meta.token}`, {}, false)).status).toBe(200);
    expect((await request(`/video-inputs/${id}/audio?token=wrong`, {}, false)).status).toBe(404);
    const detail = await (await request(`/jobs/${id}`)).text();
    expect(detail).not.toContain(meta.token); expect(detail).not.toContain("video_meta");
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    const submitted = mock.mock.calls.find(c => c[1]?.method === "POST")!;
    expect(submitted[0]).toBe("https://queue.fal.run/fal-ai/kling-video/ai-avatar/v2/standard");
    expect((submitted[1]!.headers as any).Authorization).toBe("Key test-secret");
    const input = JSON.parse(submitted[1]!.body as string);
    expect(new URL(input.audio_url).origin).toBe("https://rechbg.com");
    expect(typeof input.image_url).toBe("string"); expect(typeof input.audio_url).toBe("string");
    expect(input.avatar).toBeUndefined();
    expect(sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(id)!.status).toBe("completed");
    expect(used()).toBe(18100);
    expect((await request(`/video-inputs/${id}/audio?token=${meta.token}`, {}, false)).status).toBe(404);
    expect((await request(`/jobs/${id}/video`, {}, false)).status).toBe(401);
    const r = await request(`/jobs/${id}/video?download=1`);
    expect(r.headers.get("Content-Type")).toBe("video/mp4");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(mp4);
    const download = mock.mock.calls.find(c => c[0] === videoUrl)!;
    expect(download[1]?.headers).toBeUndefined();
  });
  it("submits Kling Pro with a protected portrait and deletes the temporary image", async () => {
    const body = form("high", { consent: "true" }); body.set("image", new Blob([png]), "portrait.png");
    const id = await create(body); const mock = mockProvider();
    const meta = JSON.parse(sqlite.prepare("SELECT video_meta FROM jobs WHERE id=?").get(id)!.video_meta as string);
    expect((await request(`/video-inputs/${id}/image?token=${meta.token}`, {}, false)).status).toBe(200);
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    const call = mock.mock.calls.find(c => c[1]?.method === "POST")!;
    expect(call[0]).toBe("https://queue.fal.run/fal-ai/kling-video/ai-avatar/v2/pro");
    expect(JSON.parse(call[1]!.body as string).image_url).toContain(`/video-inputs/${id}/image?token=`);
    expect(env.AUDIO.objects.has(meta.imageKey)).toBe(false);
    expect(used()).toBe(36100);
  });
  it("refunds the original window exactly once when provider submission fails", async () => {
    const id = await create();
    sqlite.prepare("INSERT INTO usage_windows VALUES('next-period','u',100000,0)").run();
    const mock = vi.fn().mockRejectedValue(new Error("secret provider timeout")); vi.stubGlobal("fetch", mock);
    const flow = new (VideoGeneration as any)({}, env);
    await expect(flow.run({ payload: { jobId: id } }, step)).rejects.toThrow();
    expect(used()).toBe(100);
    expect(sqlite.prepare("SELECT used FROM usage_windows WHERE id='next-period'").get()!.used).toBe(0);
    await expect(flow.run({ payload: { jobId: id } }, step)).rejects.toThrow();
    expect(used()).toBe(100); expect(mock).toHaveBeenCalledTimes(1);
    expect(await (await request(`/jobs/${id}`)).text()).not.toMatch(/secret|provider timeout/);
    expect(env.AUDIO.objects.has(`audio/u/${sourceId}.wav`)).toBe(true);
  });
  it("reuses a persisted request after recovery without another paid submission", async () => {
    const id = await create();
    sqlite.prepare("UPDATE jobs SET provider_request=?,submitted_at=? WHERE id=?").run(JSON.stringify(ticket), now(), id);
    const mock = mockProvider();
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    expect(mock.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(0);
  });
  it("does not resubmit an ambiguous request after a crash", async () => {
    const id = await create(); sqlite.prepare("UPDATE jobs SET submitted_at=? WHERE id=?").run(now(), id);
    const mock = mockProvider();
    await expect(new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step)).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled(); expect(used()).toBe(100);
  });
  it("blocks deleting a project while video is active and cleans completed media", async () => {
    const id = await create();
    expect((await request(`/projects/${projectId}`, { method: "DELETE" })).status).toBe(409);
    mockProvider(); await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    expect((await request(`/projects/${projectId}`, { method: "DELETE" })).status).toBe(200);
    await maintenance(env);
    expect(env.AUDIO.objects.has(`audio/u/${id}.mp4`)).toBe(false);
    expect(env.AUDIO.objects.has(`audio/u/${sourceId}.wav`)).toBe(false);
  });
  it("rejects private URLs and aborts invalid output without publishing it", async () => {
    expect(() => outputUrl("http://127.0.0.1/admin")).toThrow();
    expect(() => outputUrl("https://fal.media.evil.test/video")).toThrow();
    expect(() => queueUrl("https://evil.test/requests/id")).toThrow();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>This is not a video</html>")));
    await expect(storeVideo(env, "bad.mp4", videoUrl)).rejects.toThrow();
    expect(env.AUDIO.objects.has("bad.mp4")).toBe(false);
  });
});
