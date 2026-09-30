import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { VideoGeneration } from "../server/video-workflow";
import { bucket, database } from "./helpers";
import { now } from "../server/types";
import { sha } from "../server/security";
import { translateCredits } from "../shared/tools";

const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112, 52, 50]);
const step = { do: async (_: string, options: any, fn?: any) => (fn || options)(), sleep: async () => {} };
let sqlite: ReturnType<typeof database>["sqlite"], env: any;
const source = "11111111-2222-4333-8444-555555555555";
const used = () => sqlite.prepare("SELECT used FROM usage_windows WHERE id='u:sub_t:1'").get()!.used as number;
function request(path: string, init: RequestInit = {}, cookie = true) {
  return worker.fetch(new Request("https://rechbg.com/api" + path, {
    ...init, headers: { Origin: "https://rechbg.com", "Content-Type": "application/json", ...(cookie ? { Cookie: "rech_session=session" } : {}), ...(init.headers || {}) },
  }), env, { waitUntil: () => {} } as any);
}
const order = (changes: Record<string, unknown> = {}) => request("/tools/translate", { method: "POST", body: JSON.stringify({
  assetId: source, language: "English", mode: "speed", idempotencyKey: crypto.randomUUID(), credits: translateCredits(12.4, "speed"), consent: true, ...changes }) });
/** HeyGen: languages, one translation (optionally failing), its result file. */
function heygen(statuses: (string | number)[] = ["running", "completed"]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let checks = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "https://api.heygen.com/v3/video-translations/languages") return Response.json({ data: { languages: ["English", "German", "Bulgarian", "Spanish (Spain)"] } });
    if (url === "https://api.heygen.com/v3/video-translations" && init?.method === "POST") return Response.json({ data: { video_translation_ids: ["tr_1"] } });
    if (url === "https://api.heygen.com/v3/video-translations/tr_1") {
      const s = statuses[Math.min(checks++, statuses.length - 1)];
      if (typeof s === "number") return new Response("unavailable", { status: s });
      return Response.json({ data: { id: "tr_1", status: s, video_url: "https://files.heygen.ai/out.mp4", failure_message: "private details" } });
    }
    if (url === "https://files.heygen.ai/out.mp4") return new Response(mp4);
    throw new Error("unexpected " + url);
  }));
  return calls;
}
beforeEach(async () => {
  const d = database(); sqlite = d.sqlite;
  env = { DB: d.db, AUDIO: bucket(), SITE_URL: "https://rechbg.com", HEYGEN_API_KEY: "heygen-secret", MEDIA_ENABLED: "true",
    VIDEO_GENERATION: { create: vi.fn().mockResolvedValue({}), get: vi.fn() }, GENERATION: { get: vi.fn(), create: vi.fn() } };
  sqlite.prepare("INSERT INTO users VALUES('u','u@example.com','User','hash',1,NULL,?)").run(now());
  sqlite.prepare("INSERT INTO sessions VALUES(?,'u',?)").run(await sha("session"), now() + 3600);
  sqlite.prepare("INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end,cancel_at_period_end,event_created) VALUES('sub_t','u','studio','active',1,?,0,0)").run(now() + 30 * 86400);
  sqlite.prepare("INSERT INTO usage_windows(id,user_id,quota,plan,used) VALUES('u:sub_t:1','u',250000,'studio',0)").run();
  sqlite.prepare("INSERT INTO media_limits VALUES('u',5000000000,30)").run();
  sqlite.prepare("INSERT INTO media_assets(id,user_id,object_key,name,kind,mime,bytes,status,duration,created_at,expires_at) VALUES(?,'u',?,'Интервю.mp4','upload','video/mp4',1000,'ready',12.4,1,?)")
    .run(source, `media/u/${source}/original`, now() + 86400);
  await env.AUDIO.put(`media/u/${source}/original`, mp4, { httpMetadata: { contentType: "video/mp4" } });
});
afterEach(() => { vi.unstubAllGlobals(); sqlite.close(); });

describe("Превод с дублаж", () => {
  it("lists HeyGen's languages with the popular ones first, and remembers them for a day", async () => {
    const calls = heygen();
    const d = await (await request("/tools/languages")).json() as any;
    expect(d.languages.slice(0, 2)).toEqual(["English", "German"]);
    expect(d.languages).toContain("Spanish (Spain)");
    await request("/tools/languages");
    expect(calls.filter((c) => c.url.endsWith("/languages"))).toHaveLength(1);
  });
  it("checks price, language, consent and plan before charging", async () => {
    heygen();
    expect((await order({ credits: 1 })).status).toBe(409);
    expect((await order({ language: "Klingon" })).status).toBe(400);
    expect((await order({ consent: false })).status).toBe(400);
    sqlite.prepare("DELETE FROM subscriptions").run();
    expect((await order()).status).toBe(403);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM ai_tasks").get()!.n).toBe(0);
  });
  it("dubs a library video through HeyGen, through a short outage, into a new library video", async () => {
    heygen();
    const key = crypto.randomUUID();
    const res = await order({ idempotencyKey: key, language: "German", mode: "precision", credits: translateCredits(12.4, "precision") });
    expect(res.status).toBe(202);
    const { id } = await res.json() as any;
    expect(used()).toBe(13 * 300);
    expect((await (await order({ idempotencyKey: key, language: "German", mode: "precision", credits: translateCredits(12.4, "precision") })).json() as any).id).toBe(id);
    expect(env.VIDEO_GENERATION.create).toHaveBeenCalledWith({ id, params: { toolTaskId: id } });
    const task = sqlite.prepare("SELECT * FROM ai_tasks WHERE id=?").get(id) as any;
    expect(sqlite.prepare("SELECT name,status,kind FROM media_assets WHERE id=?").get(task.output_asset_id)).toEqual({ name: "Интервю · German", status: "checking", kind: "upload" });
    const calls = heygen(["pending", 502, "running", "completed"]);
    await new (VideoGeneration as any)({}, env).run({ payload: { toolTaskId: id } }, step);
    const submit = calls.find((c) => c.init?.method === "POST")!;
    const body = JSON.parse(submit.init!.body as string);
    expect(body).toMatchObject({ output_languages: ["German"], mode: "precision", translate_audio_only: false, video: { type: "url" } });
    expect((submit.init!.headers as any)["Idempotency-Key"]).toBe(id);
    expect(sqlite.prepare("SELECT status FROM ai_tasks WHERE id=?").get(id)!.status).toBe("completed");
    expect(sqlite.prepare("SELECT status,bytes,duration FROM media_assets WHERE id=?").get(task.output_asset_id)).toEqual({ status: "ready", bytes: mp4.length, duration: 12.4 });
    expect(used()).toBe(13 * 300);
    // The private input link served the source while the task ran and ends with it.
    const input = new URL(body.video.url);
    expect(input.pathname).toBe(`/api/tool-inputs/${id}`);
    expect((await request(input.pathname.replace("/api", "") + input.search, {}, false)).status).toBe(404);
    const list = await (await request("/tools/tasks")).json() as any;
    expect(list.tasks[0]).toMatchObject({ id, status: "completed", language: "German", mode: "precision", sourceName: "Интервю.mp4" });
    expect(JSON.stringify(list)).not.toMatch(/tr_1|heygen|token/i);
  });
  it("serves the source to HeyGen only with the task's token", async () => {
    heygen();
    const { id } = await (await order()).json() as any;
    const token = (sqlite.prepare("SELECT token FROM ai_tasks WHERE id=?").get(id) as any).token;
    expect((await request(`/tool-inputs/${id}?token=${token}`, {}, false)).status).toBe(200);
    expect((await request(`/tool-inputs/${id}?token=wrong`, {}, false)).status).toBe(404);
  });
  it("refunds and frees the reserved result when HeyGen reports a failure", async () => {
    heygen();
    const { id } = await (await order({ mode: "audio", credits: translateCredits(12.4, "audio") })).json() as any;
    const output = (sqlite.prepare("SELECT output_asset_id FROM ai_tasks WHERE id=?").get(id) as any).output_asset_id;
    const calls = heygen(["failed"]);
    await expect(new (VideoGeneration as any)({}, env).run({ payload: { toolTaskId: id } }, step)).rejects.toThrow("VIDEO_STATUS_PROVIDER_0");
    expect(JSON.parse(calls.find((c) => c.init?.method === "POST")!.init!.body as string)).toMatchObject({ mode: "speed", translate_audio_only: true });
    const task = sqlite.prepare("SELECT status,error FROM ai_tasks WHERE id=?").get(id) as any;
    expect(task.status).toBe("failed"); expect(task.error).toContain("Кредитите са върнати"); expect(task.error).not.toContain("private details");
    expect(used()).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM media_assets WHERE id=?").get(output)!.n).toBe(0);
  });
  it("dubs an avatar video made in the studio too", async () => {
    heygen();
    const avatar = "99999999-8888-4777-8666-555555555555";
    sqlite.prepare("INSERT INTO media_assets(id,user_id,object_key,name,kind,mime,bytes,status,duration,created_at,expires_at) VALUES(?,'u',?,'Сцена 1','video','video/mp4',1000,'ready',12.4,1,?)")
      .run(avatar, `audio/u/${avatar}.mp4`, now() + 86400);
    expect((await order({ assetId: avatar })).status).toBe(202);
  });
  it("runs at most two tools at a time", async () => {
    heygen();
    expect((await order()).status).toBe(202);
    expect((await order()).status).toBe(202);
    expect((await order()).status).toBe(409);
  });
});
