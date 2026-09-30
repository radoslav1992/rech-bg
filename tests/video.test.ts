import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import worker, { maintenance } from "../server/index";
import { VideoGeneration, outputUrl, queueUrl, storeVideo } from "../server/video-workflow";
import { sha } from "../server/security";
import { now } from "../server/types";
import { videoCredits, videoTiers } from "../shared/video";
import { videoFailureMessage } from "../server/video-errors";
import { notifyVideo } from "../server/video-notifications";
import { getHeyGenVideo } from "../server/video-heygen";
import { prepareHeyGenAvatar, cleanupHeyGenAvatars } from "../server/video-heygen-avatar";
import { database, bucket } from "./helpers";
const ticket = { request_id: "remote-1", status_url: "https://queue.fal.run/fal-ai/kling-video/requests/remote-1/status", response_url: "https://queue.fal.run/fal-ai/kling-video/requests/remote-1", cancel_url: "https://queue.fal.run/fal-ai/kling-video/requests/remote-1/cancel" };
const videoUrl = "https://v3.fal.media/files/test.mp4";
const mp4 = new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
const png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,1,44,0,0,1,44]);
const step = { do: async (_: string, options: any, fn?: any) => (fn || options)(), sleep: async () => {} };
let sqlite: ReturnType<typeof database>["sqlite"], env: any, sourceId: string, projectId: string;
function used() { return sqlite.prepare("SELECT used FROM usage_windows WHERE id='u:sub_t:1'").get()!.used; }
function request(path: string, init: RequestInit = {}, cookie = true) {
  return worker.fetch(new Request("https://rechbg.com/api" + path, {
    ...init, headers: { Origin: "https://rechbg.com", ...(cookie ? { Cookie: "rech_session=test-session" } : {}), ...init.headers },
  }), env, { waitUntil: () => {} } as any);
}
function form(tier = "medium", changes: Record<string, string> = {}) {
  const body = new FormData();
  for (const [key, value] of Object.entries({ sourceId, tier, idempotencyKey: crypto.randomUUID(), credits: tier in videoTiers ? String(videoCredits(30, tier as "low" | "medium" | "high")) : "12000", consent: "true", ...changes })) body.set(key, value);
  body.set("image", new Blob([png]), "portrait.png");
  return body;
}
async function create(body = form()) {
  const r = await request("/videos", { method: "POST", body });
  expect(r.status).toBe(202);
  return (await r.json() as any).id as string;
}
/** A HeyGen job accepted by the previous release (a photo per video), before saved avatars. */
async function legacyHeyGen(body = form("high")) {
  const key = env.FAL_KEY, mode = env.VIDEO_PROVIDER;
  env.FAL_KEY ||= "test-secret"; env.VIDEO_PROVIDER = "fal";
  const id = await create(body);
  env.FAL_KEY = key; env.VIDEO_PROVIDER = mode;
  sqlite.prepare("UPDATE jobs SET video_meta=json_set(video_meta,'$.provider','heygen') WHERE id=?").run(id);
  return id;
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
  // Video needs a plan that includes it (Създател or Студио).
  sqlite.prepare("INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end,cancel_at_period_end,event_created) VALUES('sub_t','u','studio','active',1,?,0,0)").run(now() + 30 * 86400);
  sqlite.prepare("INSERT INTO projects VALUES(?,'u','Story','tts','Hello','mila','boris',400,?,?)").run(projectId, now(), now());
  sqlite.prepare("INSERT INTO usage_windows(id,user_id,quota,plan,used) VALUES('u:sub_t:1','u',250000,'studio',0)").run();
  sqlite.prepare("INSERT INTO jobs(id,user_id,project_id,window_id,idempotency_key,title,mode,script,voice,second_voice,pause_ms,chars,status,audio_key,duration,created_at,updated_at) VALUES(?,'u',?,'u:sub_t:1',?,'Story','tts','Hello','mila','boris',400,100,'completed',?,30,?,?)")
    .run(sourceId, projectId, sourceId, `audio/u/${sourceId}.wav`, now(), now());
  await env.AUDIO.put(`audio/u/${sourceId}.wav`, new Uint8Array(44));
});
afterEach(() => { vi.unstubAllGlobals(); sqlite.close(); });
describe("Video credits and request validation", () => {
  it("prices real duration, rounding up, and bounds supported clips", () => {
    expect(videoCredits(30, "medium")).toBe(12000);
    expect(videoCredits(30, "low")).toBe(4500);
    expect(videoCredits(30.1, "low")).toBe(4650);
    expect(videoCredits(30.1, "high")).toBe(37200);
    expect(() => videoCredits(4.9, "medium")).toThrow();
    expect(() => videoCredits(120.1, "medium")).toThrow();
    expect(() => videoCredits(60.1, "medium", 60)).toThrow();
    expect(videoCredits(120, "high")).toBe(144000);
    expect(() => videoCredits(NaN, "high")).toThrow();
  });
  it("reserves credits once for retries and enforces a single active job", async () => {
    const body = form(); const id = await create(body);
    const retry = await request("/videos", { method: "POST", body });
    expect((await retry.json() as any).id).toBe(id);
    expect(used()).toBe(12100); expect(env.VIDEO_GENERATION.create).toHaveBeenCalledTimes(1);
    expect((await request("/videos", { method: "POST", body: form() })).status).toBe(409);
    expect(used()).toBe(12100);
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
    sqlite.prepare("UPDATE usage_windows SET used=240000").run();
    expect((await request("/videos", { method: "POST", body: form() })).status).toBe(402);
    expect(used()).toBe(240000); expect(env.VIDEO_GENERATION.create).not.toHaveBeenCalled();
  });
  it("keeps the trial and Начало audio only", async () => {
    for (const plan of ["starter", null]) {
      if (plan) sqlite.prepare("UPDATE subscriptions SET plan=?").run(plan);
      else sqlite.prepare("DELETE FROM subscriptions").run();
      const r = await request("/videos", { method: "POST", body: form() });
      expect(r.status).toBe(403);
      expect((await r.json() as any).error).toContain("Създател и Студио");
    }
    expect(used()).toBe(100); expect(env.VIDEO_GENERATION.create).not.toHaveBeenCalled();
  });
  it("rejects prices quoted before the rate change without reserving credits", async () => {
    env.WAVESPEED_API_KEY = "test-key";
    for (const [tier, credits] of [["low", "9000"], ["medium", "27000"], ["high", "54000"]]) {
      expect((await request("/videos", { method: "POST", body: form(tier, { credits }) })).status).toBe(409);
    }
    expect(used()).toBe(100);
    expect(env.VIDEO_GENERATION.create).not.toHaveBeenCalled();
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
    const id = await create(); expect(used()).toBe(12100);
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
    expect(row.status).toBe("completed"); expect(used()).toBe(4600);
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
    expect(used()).toBe(4600);
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
    expect(used()).toBe(12100);
  });
});
describe("Configurable video providers", () => {
  const heygenUrl = "https://api.heygen.com/v3/videos";
  const output = "https://files.heygen.ai/video/example.mp4";
  function heygenMock() {
    let checks = 0;
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === output) {
        expect(init?.headers).toBeUndefined();
        return new Response(mp4);
      }
      expect((init?.headers as any)["x-api-key"]).toBe("heygen-secret");
      expect(init?.redirect).toBe("manual");
      if (init?.method === "POST") {
        expect(url).toBe(heygenUrl);
        return Response.json({ data: { video_id: "v_video1", status: "waiting", output_format: "mp4" } });
      }
      expect(url).toBe(`${heygenUrl}/v_video1`);
      return Response.json({ data: { id: "v_video1", status: ++checks === 1 ? "pending" : checks === 2 ? "processing" : "completed", video_url: output } });
    });
    vi.stubGlobal("fetch", mock);
    return mock;
  }
  it("offers Low/Medium with saved avatars in HeyGen mode, High as coming soon, and rejects invalid configuration", async () => {
    env.VIDEO_PROVIDER = " HEYGEN ";
    env.WAVESPEED_API_KEY = "wave-secret";
    expect((await (await request("/videos/config")).json() as any).tiers.medium.enabled).toBe(false);
    expect((await request("/videos", { method: "POST", body: form("medium") })).status).toBe(503);
    env.HEYGEN_API_KEY = "heygen-secret";
    const config = await (await request("/videos/config")).json() as any;
    expect(config.enabled).toBe(true);
    expect(config.avatarMode).toBe(true);
    expect(config.tiers.low).toMatchObject({ enabled: true, creditsPerSecond: 150, maxSeconds: 120, needsAvatar: true, soon: false });
    expect(config.tiers.medium).toMatchObject({ enabled: true, creditsPerSecond: 400, maxSeconds: 120, needsAvatar: true, soon: false });
    // High waits for the Avatar V digital twin: shown, not offered.
    expect(config.tiers.high).toMatchObject({ enabled: false, creditsPerSecond: 1200, soon: true });
    expect(JSON.stringify(config)).not.toMatch(/heygen|secret|\bfal\b/i);
    expect((await request("/videos", { method: "POST", body: form("high") })).status).toBe(503);
    // A plain photo is not enough: a saved avatar is required.
    expect((await request("/videos", { method: "POST", body: form("medium") })).status).toBe(400);
    env.VIDEO_PROVIDER = "typo";
    expect((await (await request("/videos/config")).json() as any).enabled).toBe(false);
    expect((await request("/videos", { method: "POST", body: form("high") })).status).toBe(503);
    expect(used()).toBe(100);
    expect(env.VIDEO_GENERATION.create).not.toHaveBeenCalled();
    env.VIDEO_PROVIDER = "fal.ai";
    const fal = await (await request("/videos/config")).json() as any;
    expect(fal.tiers.medium).toMatchObject({ enabled: true, needsAvatar: false, soon: false });
    expect(fal.avatarMode).toBe(false);
  });
  it("finishes a High job accepted by the previous release with HeyGen's image schema, then privately stores it", async () => {
    env.HEYGEN_API_KEY = " heygen-secret\n";
    const body = form("high"); const id = await legacyHeyGen(body);
    const meta = JSON.parse(sqlite.prepare("SELECT video_meta FROM jobs WHERE id=?").get(id)!.video_meta as string);
    expect(meta.provider).toBe("heygen");
    delete env.FAL_KEY;
    const retry = await request("/videos", { method: "POST", body });
    expect((await retry.json() as any).id).toBe(id);
    const mock = heygenMock();
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    const submits = mock.mock.calls.filter(c => c[1]?.method === "POST");
    expect(submits).toHaveLength(1);
    expect((submits[0][1]?.headers as any)["Idempotency-Key"]).toBe(id);
    const input = JSON.parse(submits[0][1]!.body as string);
    expect(input).toEqual({
      type: "image", image: { type: "url", url: `https://rechbg.com/api/video-inputs/${id}/image?token=${meta.token}` },
      audio_url: `https://rechbg.com/api/video-inputs/${id}/audio?token=${meta.token}`,
      title: `Rech BG ${id}`, resolution: "1080p", aspect_ratio: "auto", output_format: "mp4",
      motion_prompt: "A person speaking naturally to the camera. Subtle facial expressions and head movements.", expressiveness: "low",
    });
    const row = sqlite.prepare("SELECT * FROM jobs WHERE id=?").get(id)!;
    expect(row.status).toBe("completed"); expect(used()).toBe(36100);
    expect(JSON.parse(row.provider_request as string)).toMatchObject({ provider: "heygen", request_id: "v_video1" });
    expect(env.AUDIO.objects.has(meta.imageKey)).toBe(false);
    expect((await request(`/video-inputs/${id}/image?token=${meta.token}`, {}, false)).status).toBe(404);
    expect(new Uint8Array(await (await request(`/jobs/${id}/video`)).arrayBuffer())).toEqual(mp4);
    expect(await (await request(`/jobs/${id}`)).text()).not.toMatch(/heygen|provider_request|video_meta|heygen-secret/);
  });
  it.each([false, true])("keeps fal routing across a switch, including legacy jobs: %s", async legacy => {
    const id = await create();
    if (legacy) sqlite.prepare("UPDATE jobs SET video_meta=json_remove(video_meta,'$.provider') WHERE id=?").run(id);
    env.VIDEO_PROVIDER = "heygen"; env.HEYGEN_API_KEY = "heygen-secret";
    const mock = mockProvider();
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    expect(mock.mock.calls.find(c => c[1]?.method === "POST")![0]).toContain("queue.fal.run");
    expect(used()).toBe(12100);
  });
  it("resumes a saved HeyGen request without submitting again or trusting stored URLs", async () => {
    env.VIDEO_PROVIDER = "heygen"; env.HEYGEN_API_KEY = "heygen-secret";
    const id = await legacyHeyGen();
    sqlite.prepare("UPDATE jobs SET submitted_at=?,provider_request=? WHERE id=?").run(now(), JSON.stringify({ provider: "heygen", request_id: "v_video1", status_url: "https://evil.invalid/status", response_url: "https://evil.invalid/result" }), id);
    env.VIDEO_PROVIDER = "fal";
    const mock = heygenMock();
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    expect(mock.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(0);
    expect(sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(id)!.status).toBe("completed");
  });
  it.each([401, 402, 422, 429])("refunds a rejected HeyGen submission (%s) without fallback", async status => {
    env.VIDEO_PROVIDER = "heygen"; env.HEYGEN_API_KEY = "heygen-secret";
    const id = await legacyHeyGen();
    const mock = vi.fn().mockResolvedValue(Response.json({ error: { code: "rejected", message: "private input heygen-secret" } }, { status }));
    vi.stubGlobal("fetch", mock);
    const flow = new (VideoGeneration as any)({}, env);
    await expect(flow.run({ payload: { jobId: id } }, step)).rejects.toThrow("VIDEO_SUBMIT_");
    await expect(flow.run({ payload: { jobId: id } }, step)).rejects.toThrow();
    expect(used()).toBe(100); expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toBe(heygenUrl);
    expect(await (await request(`/jobs/${id}`)).text()).not.toMatch(/heygen-secret|private input/);
  });
  it("refunds failed rendering and does not try a fal cancellation or fallback", async () => {
    env.VIDEO_PROVIDER = "heygen"; env.HEYGEN_API_KEY = "heygen-secret";
    const id = await legacyHeyGen();
    const mock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ data: init?.method === "POST"
      ? { video_id: "v_video1" }
      : { id: "v_video1", status: "failed", failure_message: "private provider details" } }));
    vi.stubGlobal("fetch", mock);
    await expect(new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step)).rejects.toThrow("VIDEO_STATUS_PROVIDER_0");
    expect(used()).toBe(100);
    expect(mock.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1);
    expect(mock.mock.calls.every(c => c[0].startsWith(heygenUrl))).toBe(true);
  });
  it("keeps polling through a short provider outage instead of refunding a video that is still rendering", async () => {
    env.HEYGEN_API_KEY = "heygen-secret";
    const id = await legacyHeyGen();
    let gets = 0;
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === output) return new Response(mp4);
      if (init?.method === "POST") return Response.json({ data: { video_id: "v_video1" } });
      gets++;
      if (gets <= 3) return new Response("bad gateway", { status: gets === 2 ? 429 : 502 });
      return Response.json({ data: { id: "v_video1", status: "completed", video_url: output } });
    });
    vi.stubGlobal("fetch", mock);
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    expect(sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(id)!.status).toBe("completed");
    expect(used()).toBe(36100);
  });
  it("still fails (and refunds) when the provider itself reports a failed video", async () => {
    env.HEYGEN_API_KEY = "heygen-secret";
    const id = await legacyHeyGen();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => Response.json({ data: init?.method === "POST"
      ? { video_id: "v_video1" } : { id: "v_video1", status: "failed" } })));
    await expect(new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step)).rejects.toThrow("VIDEO_STATUS_PROVIDER_0");
    expect(used()).toBe(100);
  });
  it("does not retry an ambiguous paid HeyGen POST", async () => {
    env.VIDEO_PROVIDER = "heygen"; env.HEYGEN_API_KEY = "heygen-secret";
    const id = await legacyHeyGen();
    const mock = vi.fn().mockRejectedValue(new Error("network interrupted")); vi.stubGlobal("fetch", mock);
    const flow = new (VideoGeneration as any)({}, env);
    await expect(flow.run({ payload: { jobId: id } }, step)).rejects.toThrow();
    await expect(flow.run({ payload: { jobId: id } }, step)).rejects.toThrow();
    expect(mock).toHaveBeenCalledTimes(1); expect(used()).toBe(100);
  });
  it("rejects malformed IDs, mismatched results and untrusted output hosts", async () => {
    env.HEYGEN_API_KEY = "heygen-secret";
    const mock = vi.fn().mockResolvedValue(Response.json({ data: { id: "wrong", status: "completed", video_url: output } }));
    vi.stubGlobal("fetch", mock);
    const t = { provider: "heygen" as const, request_id: "../evil", status_url: "", response_url: "" };
    await expect(getHeyGenVideo(env, t)).rejects.toThrow("Invalid video request ID");
    expect(mock).not.toHaveBeenCalled();
    await expect(getHeyGenVideo(env, { ...t, request_id: "v_video1" })).rejects.toThrow("VIDEO_STATUS_PROVIDER_0");
    expect(outputUrl(output)).toBe(output);
    expect(() => outputUrl("https://files.heygen.ai.evil.invalid/video.mp4")).toThrow();
    expect(() => outputUrl("https://user:secret@files.heygen.ai/video.mp4")).toThrow();
  });
  it("routes new Medium jobs through Kling Standard in fal mode without creating a photo avatar", async () => {
    env.VIDEO_PROVIDER = "fal"; env.HEYGEN_API_KEY = "heygen-secret";
    const id = await create(); const mock = mockProvider();
    const meta = JSON.parse(sqlite.prepare("SELECT video_meta FROM jobs WHERE id=?").get(id)!.video_meta as string);
    expect(meta.provider).toBe("fal");
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    const posts = mock.mock.calls.filter(c => c[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe("https://queue.fal.run/fal-ai/kling-video/ai-avatar/v2/standard");
    expect(mock.mock.calls.some(c => c[0].includes("heygen.com"))).toBe(false);
    expect(sqlite.prepare("SELECT * FROM cleanup_tasks WHERE prefix LIKE 'heygen-avatar/%'").all()).toHaveLength(0);
    expect(sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(id)!.status).toBe("completed");
    expect(used()).toBe(12100);
  });
  // Simulate a job accepted by the previous release. New requests no longer use III.
  async function legacyMedium() { return legacyHeyGen(form()); }
  function photoMock(id: string, lookResult?: Record<string, unknown>) {
    const mock = heygenMock();
    const video = mock.getMockImplementation()!;
    let checks = 0;
    mock.mockImplementation(async (url, init) => {
      if (!url.startsWith("https://api.heygen.com/v3/avatars")) return video(url, init);
      expect((init?.headers as any)["x-api-key"]).toBe("heygen-secret");
      expect(init?.redirect).toBe("manual");
      if (init?.method === "POST") {
        expect(url).toBe("https://api.heygen.com/v3/avatars");
        expect((init?.headers as any)["Idempotency-Key"]).toBe(`avatar:${id}`);
        const input = JSON.parse(init.body as string);
        expect(Object.keys(input).sort()).toEqual(["file", "name", "type"]);
        expect(input).toMatchObject({ type: "photo", name: `Rech BG ${id}`, file: { type: "url" } });
        const u = new URL(input.file.url);
        expect(u.pathname).toBe(`/api/video-inputs/${id}/image`);
        expect((await request(u.pathname.replace("/api", "") + u.search, {}, false)).status).toBe(200);
        return Response.json({ data: { avatar_item: { id: "look_photo1" }, avatar_group: { id: "group_photo1" } } });
      }
      if (init?.method === "DELETE") {
        expect(url).toBe("https://api.heygen.com/v3/avatars/group_photo1");
        return Response.json({ data: { id: "group_photo1" } });
      }
      expect(url).toBe("https://api.heygen.com/v3/avatars/looks/look_photo1");
      expect((await (await request(`/jobs/${id}`)).json() as any).job.video_phase).toBe("preparing");
      return Response.json({ data: { id: "look_photo1", avatar_type: "photo_avatar", supported_api_engines: ["avatar_iii", "avatar_iv"],
        status: ++checks === 1 ? "processing" : "completed", ...lookResult } });
    });
    return mock;
  }
  it("preserves an already-queued Avatar III job, uses Avatar III with original audio, and removes the temporary group", async () => {
    env.VIDEO_PROVIDER = "heygen"; env.HEYGEN_API_KEY = "heygen-secret"; delete env.FAL_KEY;
    const id = await legacyMedium();
    env.VIDEO_PROVIDER = "fal";
    const mock = photoMock(id);
    const workflowStep = { ...step, sleep: vi.fn(async () => {}) };
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, workflowStep);
    const posts = mock.mock.calls.filter(c => c[1]?.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0][0]).toBe("https://api.heygen.com/v3/avatars");
    expect(posts[1][0]).toBe(heygenUrl);
    expect(JSON.parse(posts[1][1]!.body as string)).toEqual({
      type: "avatar", avatar_id: "look_photo1", engine: { type: "avatar_iii" },
      audio_url: expect.stringContaining(`/api/video-inputs/${id}/audio?token=`),
      title: `Rech BG ${id}`, resolution: "1080p", aspect_ratio: "auto", output_format: "mp4",
    });
    expect(workflowStep.sleep).toHaveBeenCalledWith("photo-avatar-wait-0", "10 seconds");
    const row = sqlite.prepare("SELECT * FROM jobs WHERE id=?").get(id)!;
    expect(row.status).toBe("completed"); expect(used()).toBe(12100);
    expect(JSON.parse(row.video_meta as string).heygenAvatar).toEqual({ lookId: "look_photo1", groupId: "group_photo1" });
    expect(mock.mock.calls.filter(c => c[1]?.method === "DELETE")).toHaveLength(1);
    expect(sqlite.prepare("SELECT * FROM cleanup_tasks WHERE prefix LIKE 'heygen-avatar/%'").all()).toHaveLength(0);
    expect(await (await request(`/jobs/${id}`)).text()).not.toMatch(/look_photo1|group_photo1|heygenAvatar/);
  });
  it("recovers a saved photo avatar without another avatar POST", async () => {
    env.VIDEO_PROVIDER = "heygen"; env.HEYGEN_API_KEY = "heygen-secret";
    const id = await legacyMedium(); const mock = photoMock(id);
    await prepareHeyGenAvatar(env, id);
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    expect(mock.mock.calls.filter(c => c[0].endsWith("/avatars") && c[1]?.method === "POST")).toHaveLength(1);
    expect(mock.mock.calls.filter(c => c[0] === heygenUrl && c[1]?.method === "POST")).toHaveLength(1);
  });
  it("resumes Medium video polling without preparing an avatar again", async () => {
    env.VIDEO_PROVIDER = "heygen"; env.HEYGEN_API_KEY = "heygen-secret";
    const id = await legacyMedium();
    sqlite.prepare("UPDATE jobs SET submitted_at=?,provider_request=? WHERE id=?").run(now(), JSON.stringify({ provider: "heygen", request_id: "v_video1" }), id);
    const mock = heygenMock();
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    expect(mock.mock.calls.some(c => c[1]?.method === "POST" || c[0].includes("/avatars"))).toBe(false);
    expect(sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(id)!.status).toBe("completed");
  });
  it("never repeats an ambiguous avatar creation or submits a video afterward", async () => {
    env.VIDEO_PROVIDER = "heygen"; env.HEYGEN_API_KEY = "heygen-secret";
    const id = await legacyMedium(); const mock = vi.fn().mockRejectedValue(new Error("network interrupted")); vi.stubGlobal("fetch", mock);
    await expect(prepareHeyGenAvatar(env, id)).rejects.toThrow();
    await expect(new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step)).rejects.toThrow("VIDEO_SUBMIT_INTERNAL_0");
    expect(mock).toHaveBeenCalledTimes(1); expect(used()).toBe(100);
    expect(mock.mock.calls[0][0]).toBe("https://api.heygen.com/v3/avatars");
    expect(sqlite.prepare("SELECT submitted_at FROM jobs WHERE id=?").get(id)!.submitted_at).toBeNull();
  });
  it.each([
    [{ status: "failed", error: { code: "moderation_failed", message: "private details" } }, "CONTENT"],
    [{ status: "completed", supported_api_engines: ["avatar_iv"] }, "ACCESS"],
    [{ status: "processing" }, "TIMEOUT"],
  ])("refunds once and cleans up when photo preparation cannot finish (%j)", async (look, code) => {
    env.VIDEO_PROVIDER = "heygen"; env.HEYGEN_API_KEY = "heygen-secret";
    const id = await legacyMedium(); const mock = photoMock(id, look);
    const flow = new (VideoGeneration as any)({}, env);
    await expect(flow.run({ payload: { jobId: id } }, step)).rejects.toThrow(`VIDEO_STATUS_${code}_0`);
    await expect(flow.run({ payload: { jobId: id } }, step)).rejects.toThrow();
    expect(used()).toBe(100);
    expect(mock.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1);
    expect(mock.mock.calls.filter(c => c[1]?.method === "DELETE")).toHaveLength(1);
    expect(await (await request(`/jobs/${id}`)).text()).not.toContain("private details");
  });
  it("retries avatar cleanup in maintenance without changing a completed video or its credits", async () => {
    env.VIDEO_PROVIDER = "heygen"; env.HEYGEN_API_KEY = "heygen-secret";
    const id = await legacyMedium(); const mock = photoMock(id); const normal = mock.getMockImplementation()!;
    mock.mockImplementation(async (url, init) => init?.method === "DELETE" ? Response.json({ error: {} }, { status: 503 }) : normal(url, init));
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    expect(sqlite.prepare("SELECT * FROM cleanup_tasks WHERE prefix LIKE 'heygen-avatar/%'").all()).toHaveLength(1);
    expect(sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(id)!.status).toBe("completed");
    expect(used()).toBe(12100);
    mock.mockImplementation(normal);
    await maintenance(env);
    expect(mock.mock.calls.filter(c => c[1]?.method === "DELETE")).toHaveLength(2);
    expect(sqlite.prepare("SELECT * FROM cleanup_tasks WHERE prefix LIKE 'heygen-avatar/%'").all()).toHaveLength(0);
    expect(used()).toBe(12100);
  });
  it("preserves active avatar cleanup tasks and cleans up even after the job is deleted", async () => {
    env.VIDEO_PROVIDER = "heygen"; env.HEYGEN_API_KEY = "heygen-secret";
    const id = await legacyMedium(); const mock = photoMock(id);
    await prepareHeyGenAvatar(env, id);
    await maintenance(env);
    expect(mock.mock.calls.some(c => c[1]?.method === "DELETE")).toBe(false);
    expect(sqlite.prepare("SELECT * FROM cleanup_tasks WHERE prefix LIKE 'heygen-avatar/%'").all()).toHaveLength(1);
    sqlite.prepare("DELETE FROM jobs WHERE id=?").run(id);
    await cleanupHeyGenAvatars(env);
    expect(mock.mock.calls.filter(c => c[1]?.method === "DELETE")).toHaveLength(1);
    expect(sqlite.prepare("SELECT * FROM cleanup_tasks WHERE prefix LIKE 'heygen-avatar/%'").all()).toHaveLength(0);
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
    expect(used()).toBe(12100);
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
    expect(used()).toBe(12100);
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
    sqlite.prepare("INSERT INTO usage_windows(id,user_id,quota,used) VALUES('next-period','u',100000,0)").run();
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
describe("Recovery of slow, interrupted and stuck video jobs", () => {
  const heygenOutput = "https://files.heygen.ai/video/example.mp4";
  function heygen(statuses: string[] = ["completed"]) {
    let checks = 0;
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === heygenOutput) return new Response(mp4);
      if (init?.method === "POST") return Response.json({ data: { video_id: "v_video1", status: "waiting" } });
      return Response.json({ data: { id: "v_video1", status: statuses[Math.min(checks++, statuses.length - 1)], video_url: heygenOutput } });
    });
    vi.stubGlobal("fetch", mock);
    return mock;
  }
  it("recovers a HeyGen submission interrupted before its ticket was saved, using the same idempotency key", async () => {
    env.VIDEO_PROVIDER = "heygen"; env.HEYGEN_API_KEY = "heygen-secret";
    const id = await legacyHeyGen();
    // The Worker was evicted after claiming the submission but before saving the ticket.
    sqlite.prepare("UPDATE jobs SET submitted_at=? WHERE id=?").run(now() - 60, id);
    const mock = heygen();
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    const submits = mock.mock.calls.filter(c => c[1]?.method === "POST");
    expect(submits).toHaveLength(1);
    expect((submits[0][1]?.headers as any)["Idempotency-Key"]).toBe(id);
    expect(sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(id)!.status).toBe("completed");
    expect(used()).toBe(36100);
  });
  it("does not resubmit to HeyGen once its idempotency window has passed", async () => {
    env.VIDEO_PROVIDER = "heygen"; env.HEYGEN_API_KEY = "heygen-secret";
    const id = await legacyHeyGen();
    sqlite.prepare("UPDATE jobs SET submitted_at=? WHERE id=?").run(now() - 21 * 3600, id);
    const mock = heygen();
    await expect(new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step)).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled(); expect(used()).toBe(100);
  });
  it("keeps polling a slow provider for more than an hour instead of refunding a video that is still rendering", async () => {
    env.VIDEO_PROVIDER = "heygen"; env.HEYGEN_API_KEY = "heygen-secret";
    const id = await legacyHeyGen();
    const sleeps: string[] = [];
    const slowStep = { ...step, sleep: async (_: string, duration: string) => { sleeps.push(duration); } };
    heygen([...Array(200).fill("processing"), "completed"]);
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, slowStep);
    expect(sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(id)!.status).toBe("completed");
    expect(sleeps.filter(s => s === "5 minutes").length).toBe(20);
  });
  it("follows up to two redirects to allowed hosts when saving the output", async () => {
    const hop = (to: string) => new Response(null, { status: 302, headers: { Location: to } });
    const chain = (locations: string[]) => {
      const mock = vi.fn(async (url: string) => {
        const i = ["https://files.heygen.ai/a.mp4", ...locations].indexOf(url);
        return i < locations.length ? hop(locations[i]) : new Response(mp4);
      });
      vi.stubGlobal("fetch", mock);
      return mock;
    };
    chain(["https://files.heygen.ai/b.mp4", "https://d1.cloudfront.net/c.mp4"]);
    await storeVideo(env, "audio/u/ok.mp4", "https://files.heygen.ai/a.mp4");
    expect(env.AUDIO.objects.has("audio/u/ok.mp4")).toBe(true);
    const evil = chain(["https://evil.invalid/b.mp4"]);
    await expect(storeVideo(env, "audio/u/evil.mp4", "https://files.heygen.ai/a.mp4")).rejects.toThrow();
    expect(evil).toHaveBeenCalledTimes(1);
    chain(["https://files.heygen.ai/b.mp4", "https://files.heygen.ai/c.mp4", "https://files.heygen.ai/d.mp4"]);
    await expect(storeVideo(env, "audio/u/loop.mp4", "https://files.heygen.ai/a.mp4")).rejects.toThrow();
    expect(env.AUDIO.objects.has("audio/u/evil.mp4") || env.AUDIO.objects.has("audio/u/loop.mp4")).toBe(false);
  });
  it("keeps input links valid for hours after a late submission, but not for unsubmitted old jobs", async () => {
    const id = await create();
    const meta = JSON.parse(sqlite.prepare("SELECT video_meta FROM jobs WHERE id=?").get(id)!.video_meta as string);
    const audio = () => request(`/video-inputs/${id}/audio?token=${meta.token}`, {}, false);
    sqlite.prepare("UPDATE jobs SET created_at=?,submitted_at=? WHERE id=?").run(now() - 3 * 3600, now() - 60, id);
    expect((await audio()).status).toBe(200);
    sqlite.prepare("UPDATE jobs SET submitted_at=NULL WHERE id=?").run(id);
    expect((await audio()).status).toBe(200);
    sqlite.prepare("UPDATE jobs SET created_at=? WHERE id=?").run(now() - 7 * 3600, id);
    expect((await audio()).status).toBe(404);
  });
  it("fails and refunds jobs stuck past the time limit, and jobs whose workflow ended without a result", async () => {
    const stuck = await create();
    sqlite.prepare("UPDATE jobs SET status='running',created_at=?,updated_at=? WHERE id=?").run(now() - 9 * 3600, now() - 3600, stuck);
    const terminate = vi.fn().mockResolvedValue(undefined);
    env.VIDEO_GENERATION.get.mockResolvedValue({ status: async () => ({ status: "running" }), terminate });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await maintenance(env);
    expect(terminate).toHaveBeenCalled();
    expect(sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(stuck)!.status).toBe("failed");
    expect(used()).toBe(100);
    const ended = await create();
    sqlite.prepare("UPDATE jobs SET status='running',updated_at=? WHERE id=?").run(now() - 3600, ended);
    env.VIDEO_GENERATION.get.mockResolvedValue({ status: async () => ({ status: "complete" }), terminate });
    await maintenance(env);
    expect(sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(ended)!.status).toBe("failed");
    expect(used()).toBe(100);
  });
  it("leaves a long-running job alone while its workflow is still working within the limit", async () => {
    const id = await create();
    sqlite.prepare("UPDATE jobs SET status='running',created_at=?,updated_at=? WHERE id=?").run(now() - 3 * 3600, now() - 3600, id);
    const terminate = vi.fn();
    env.VIDEO_GENERATION.get.mockResolvedValue({ status: async () => ({ status: "waiting" }), terminate });
    await maintenance(env);
    expect(terminate).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(id)!.status).toBe("running");
  });
});
describe("Medium with reusable HeyGen library avatars", () => {
  it("submits Avatar III with the linked avatar, without creating or deleting any avatar", async () => {
    env.VIDEO_MEDIUM = "heygen"; env.HEYGEN_API_KEY = "heygen-secret";
    const avatarId = `avatar-${crypto.randomUUID()}`;
    await env.AUDIO.put(`config/avatar-library/${avatarId}.json`, JSON.stringify({ name: "Ана", description: "Водеща", category: "business", presentation: "female",
      active: true, mime: "image/png", updatedAt: 1, heygen: { lookId: "look_lib", groupId: "group_lib", status: "ready" } }));
    await env.AUDIO.put(`library/avatars/${avatarId}`, png);
    const body = form("medium"); body.delete("image"); body.set("libraryAvatarId", avatarId);
    const id = await create(body);
    const output = "https://files.heygen.ai/video/lib.mp4";
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === output) return new Response(mp4);
      if (url === "https://api.heygen.com/v3/avatars/looks/look_lib")
        return Response.json({ data: { id: "look_lib", group_id: "group_lib", avatar_type: "photo_avatar", supported_api_engines: ["avatar_iii"], status: "completed" } });
      if (url === "https://api.heygen.com/v3/videos" && init?.method === "POST") return Response.json({ data: { video_id: "v_lib" } });
      if (url === "https://api.heygen.com/v3/videos/v_lib") return Response.json({ data: { id: "v_lib", status: "completed", video_url: output } });
      throw new Error("Unexpected " + url);
    });
    vi.stubGlobal("fetch", mock);
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    const posts = mock.mock.calls.filter(c => c[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1]!.body as string)).toMatchObject({ type: "avatar", avatar_id: "look_lib", engine: { type: "avatar_iii" } });
    expect(mock.mock.calls.some(c => c[1]?.method === "DELETE")).toBe(false);
    expect(sqlite.prepare("SELECT * FROM cleanup_tasks WHERE prefix LIKE 'heygen-avatar/%'").all()).toHaveLength(0);
    expect(sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(id)!.status).toBe("completed");
    expect(await (await request(`/jobs/${id}`)).text()).not.toMatch(/look_lib|group_lib/);
  });
});
describe("Per-model recording limits", () => {
  it("allows 2-minute recordings except on Kling Standard, which takes at most 60 s", async () => {
    sqlite.prepare("UPDATE jobs SET duration=90 WHERE id=?").run(sourceId);
    // Medium on Kling Standard (fal): 60 s at most.
    const kling = await request("/videos", { method: "POST", body: form("medium", { credits: "36000" }) });
    expect(kling.status).toBe(400);
    expect((await kling.json() as any).error).toContain("до 60 секунди");
    // High (Kling Pro) takes it.
    expect((await request("/videos", { method: "POST", body: form("high", { credits: "108000" }) })).status).toBe(202);
    sqlite.prepare("UPDATE jobs SET duration=121 WHERE id=?").run(sourceId);
    sqlite.prepare("UPDATE jobs SET status='completed' WHERE kind='video'").run();
    expect((await request("/videos", { method: "POST", body: form("high", { credits: String(121 * 1200) }) })).status).toBe(400);
  });
});
