import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { VideoGeneration } from "../server/video-workflow";
import { maintenance } from "../server/maintenance";
import { bucket, database } from "./helpers";
import { now } from "../server/types";
import { sha } from "../server/security";
import { AVATAR_CREDITS, videoCredits } from "../shared/video";

const photo = new Uint8Array([255, 216, 255, 224, ...new Array(60).fill(7)]);
const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112, 52, 50]);
const step = { do: async (_: string, options: any, fn?: any) => (fn || options)(), sleep: async () => {} };
let sqlite: ReturnType<typeof database>["sqlite"], env: any, sourceId: string;
const used = () => sqlite.prepare("SELECT used FROM usage_windows WHERE id='u:sub_t:1'").get()!.used as number;
function request(path: string, init: RequestInit = {}, cookie = true) {
  return worker.fetch(new Request("https://rechbg.com/api" + path, {
    ...init, headers: { Origin: "https://rechbg.com", ...(cookie ? { Cookie: "rech_session=session" } : {}), ...(init.headers || {}) },
  }), env, { waitUntil: () => {} } as any);
}
function avatarForm(changes: Record<string, string | Blob> = {}) {
  const form = new FormData();
  Object.entries({ name: "Аз в офиса", idempotencyKey: crypto.randomUUID(), credits: String(AVATAR_CREDITS), consent: "true" }).forEach(([k, v]) => form.set(k, v));
  form.set("image", new Blob([photo], { type: "image/jpeg" }), "me.jpg");
  Object.entries(changes).forEach(([k, v]) => form.set(k, v));
  return form;
}
/** HeyGen: creates look_u1 and reports it as `status` with the given engines. */
function heygen(status = "completed", extra: Record<string, unknown> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "https://api.heygen.com/v3/avatars" && init?.method === "POST")
      return Response.json({ data: { avatar_item: { id: "look_u1" }, avatar_group: { id: "group_u1" } } });
    if (url.startsWith("https://api.heygen.com/v3/avatars/looks/"))
      return Response.json({ data: { id: "look_u1", group_id: "group_u1", avatar_type: "photo_avatar", supported_api_engines: ["avatar_iii", "avatar_iv"], status, ...extra } });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url === "https://api.heygen.com/v3/videos" && init?.method === "POST") return Response.json({ data: { video_id: "v_1" } });
    if (url === "https://api.heygen.com/v3/videos/v_1") return Response.json({ data: { id: "v_1", status: "completed", video_url: "https://files.heygen.ai/v.mp4" } });
    if (url === "https://files.heygen.ai/v.mp4") return new Response(mp4);
    throw new Error("unexpected " + url);
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}
beforeEach(async () => {
  const d = database(); sqlite = d.sqlite;
  env = { DB: d.db, AUDIO: bucket(), SITE_URL: "https://rechbg.com", VIDEO_PROVIDER: "heygen", HEYGEN_API_KEY: "heygen-secret",
    VIDEO_GENERATION: { create: vi.fn().mockResolvedValue({}), get: vi.fn() }, GENERATION: { get: vi.fn(), create: vi.fn() } };
  sqlite.prepare("INSERT INTO users VALUES('u','u@example.com','User','hash',1,NULL,?)").run(now());
  sqlite.prepare("INSERT INTO users VALUES('other','o@example.com','Other','hash',1,NULL,?)").run(now());
  sqlite.prepare("INSERT INTO sessions VALUES(?,'u',?)").run(await sha("session"), now() + 3600);
  sqlite.prepare("INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end,cancel_at_period_end,event_created) VALUES('sub_t','u','studio','active',1,?,0,0)").run(now() + 30 * 86400);
  sqlite.prepare("INSERT INTO usage_windows(id,user_id,quota,plan,used) VALUES('u:sub_t:1','u',250000,'studio',0)").run();
  const project = crypto.randomUUID(); sourceId = crypto.randomUUID();
  sqlite.prepare("INSERT INTO projects VALUES(?,'u','Story','tts','Hello','mila','boris',400,?,?)").run(project, now(), now());
  sqlite.prepare("INSERT INTO jobs(id,user_id,project_id,window_id,idempotency_key,title,mode,script,voice,second_voice,pause_ms,chars,status,audio_key,duration,created_at,updated_at) VALUES(?,'u',?,'u:sub_t:1',?,'Story','tts','Hello','mila','boris',400,0,'completed',?,10,?,?)")
    .run(sourceId, project, sourceId, `audio/u/${sourceId}.wav`, now(), now());
  await env.AUDIO.put(`audio/u/${sourceId}.wav`, new Uint8Array(44));
});
afterEach(() => { vi.unstubAllGlobals(); sqlite.close(); });

describe("Моите аватари", () => {
  it("creates an avatar once for its credits, lets HeyGen read the photo privately, and becomes ready", async () => {
    const calls = heygen("processing");
    const key = crypto.randomUUID();
    const res = await request("/my-avatars", { method: "POST", body: avatarForm({ idempotencyKey: key }) });
    expect(res.status).toBe(201);
    const { avatar } = await res.json() as any;
    expect(avatar).toMatchObject({ name: "Аз в офиса", status: "processing", imageUrl: `/api/my-avatars/${avatar.id}/image` });
    expect(used()).toBe(AVATAR_CREDITS);
    // A retry with the same key is the same avatar, charged once.
    expect(((await (await request("/my-avatars", { method: "POST", body: avatarForm({ idempotencyKey: key }) })).json()) as any).avatar.id).toBe(avatar.id);
    expect(used()).toBe(AVATAR_CREDITS);
    const create = calls.find((c) => c.init?.method === "POST")!;
    const input = new URL(JSON.parse(create.init!.body as string).file.url);
    expect(input.pathname).toBe(`/api/user-avatar-inputs/${avatar.id}`);
    expect(new Uint8Array(await (await request(input.pathname.replace("/api", "") + input.search, {}, false)).arrayBuffer())).toEqual(photo);
    expect((await request(`/user-avatar-inputs/${avatar.id}?token=wrong`, {}, false)).status).toBe(404);
    heygen("completed");
    const list = await (await request("/my-avatars")).json() as any;
    expect(list).toMatchObject({ enabled: true, credits: AVATAR_CREDITS });
    expect(list.avatars[0]).toMatchObject({ id: avatar.id, status: "ready", engines: ["avatar_iii", "avatar_iv"] });
    // The private link ends once the avatar is ready; the owner still sees the photo.
    expect((await request(input.pathname.replace("/api", "") + input.search, {}, false)).status).toBe(404);
    expect((await request(`/my-avatars/${avatar.id}/image`)).status).toBe(200);
    expect(await (await request("/my-avatars")).text()).not.toMatch(/look_u1|group_u1|heygen-secret|token/);
  });
  it("checks price, consent and plan before charging", async () => {
    heygen();
    expect((await request("/my-avatars", { method: "POST", body: avatarForm({ credits: "1" }) })).status).toBe(409);
    expect((await request("/my-avatars", { method: "POST", body: avatarForm({ consent: "false" }) })).status).toBe(400);
    expect((await request("/my-avatars", { method: "POST", body: avatarForm({ image: new Blob([new Uint8Array(40)]) }) })).status).toBe(400);
    sqlite.prepare("DELETE FROM subscriptions").run();
    expect((await request("/my-avatars", { method: "POST", body: avatarForm() })).status).toBe(403);
    expect(used()).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM user_avatars").get()!.n).toBe(0);
  });
  it("refunds when HeyGen refuses the photo, at once or in moderation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "invalid" } }, { status: 400 })));
    expect((await request("/my-avatars", { method: "POST", body: avatarForm() })).status).toBe(502);
    expect(used()).toBe(0);
    heygen("processing");
    const { avatar } = await (await request("/my-avatars", { method: "POST", body: avatarForm() })).json() as any;
    expect(used()).toBe(AVATAR_CREDITS);
    heygen("failed", { error: { code: "moderation_failed" } });
    const list = await (await request("/my-avatars")).json() as any;
    expect(list.avatars.find((a: any) => a.id === avatar.id)).toMatchObject({ status: "failed", error: expect.stringContaining("върнати") });
    expect(used()).toBe(0);
  });
  it("refunds an avatar HeyGen never finishes, even while its status checks fail", async () => {
    heygen("processing");
    const { avatar } = await (await request("/my-avatars", { method: "POST", body: avatarForm() })).json() as any;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    expect((await (await request("/my-avatars")).json() as any).avatars[0].status).toBe("processing");
    expect(used()).toBe(AVATAR_CREDITS);
    sqlite.prepare("UPDATE user_avatars SET created_at=? WHERE id=?").run(now() - 31 * 60, avatar.id);
    expect((await (await request("/my-avatars")).json() as any).avatars[0].status).toBe("failed");
    expect(used()).toBe(0);
  });
  it("maintenance follows every avatar being created, removes failed ones from HeyGen and deletes them after 7 days", async () => {
    heygen("processing");
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(((await (await request("/my-avatars", { method: "POST", body: avatarForm() })).json()) as any).avatar.id);
    expect(used()).toBe(7 * AVATAR_CREDITS);
    // Never looked at in the list: maintenance still finishes them all (here, HeyGen refused them).
    const calls = heygen("failed");
    await maintenance(env);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM user_avatars WHERE status='failed'").get()!.n).toBe(7);
    expect(used()).toBe(0);
    // The HeyGen avatars of failed ones are deleted at once; the photos stay while the error is shown.
    expect(calls.filter((c) => c.init?.method === "DELETE")).toHaveLength(7);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM user_avatars WHERE group_id IS NOT NULL").get()!.n).toBe(0);
    const photo = (sqlite.prepare("SELECT image_key FROM user_avatars WHERE id=?").get(ids[0]) as any).image_key;
    expect(await env.AUDIO.head(photo)).toBeTruthy();
    sqlite.prepare("UPDATE user_avatars SET updated_at=?").run(now() - 8 * 86400);
    await maintenance(env);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM user_avatars").get()!.n).toBe(0);
    expect(await env.AUDIO.head(photo)).toBeNull();
  });
  it("maintenance logs one summary line when something is overdue", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await maintenance(env);
    expect(log.mock.calls.some((c) => c[0] === "Maintenance attention")).toBe(false);
    sqlite.prepare("INSERT INTO cleanup_tasks(prefix,created_at) VALUES ('avatars/u/x/',?)").run(now() - 2 * 86400);
    env.AUDIO.list = async () => { throw new Error("R2 down"); };
    await maintenance(env);
    expect(log.mock.calls.find((c) => c[0] === "Maintenance attention")?.[1]).toMatchObject({ cleanup: 1, jobs: 0 });
  });
  it("makes a Medium video with Avatar IV from the saved avatar, and deletes it only when no video uses it", async () => {
    heygen("completed");
    const { avatar } = await (await request("/my-avatars", { method: "POST", body: avatarForm() })).json() as any;
    await request("/my-avatars");
    // Someone else's avatar cannot be used.
    sqlite.prepare("INSERT INTO usage_windows(id,user_id,quota,plan,used) VALUES('o:1','other',1000,'free',0)").run();
    const other = { window_id: "o:1" };
    sqlite.prepare("INSERT INTO user_avatars(id,user_id,name,image_key,mime,status,look_id,group_id,window_id,credits,idempotency_key,token,consent_at,consent_text,created_at,updated_at) VALUES(?,?,?,?,?,'ready','look_x','g',?,0,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), "other", "x", "k", "image/jpeg", other.window_id, "k", "t", now(), "c", now(), now());
    const foreign = (sqlite.prepare("SELECT id FROM user_avatars WHERE user_id='other'").get() as any).id;
    const form = (id: string) => {
      const f = new FormData();
      Object.entries({ sourceId, tier: "medium", idempotencyKey: crypto.randomUUID(), credits: String(videoCredits(10, "medium")), consent: "true", userAvatarId: id }).forEach(([k, v]) => f.set(k, v));
      return f;
    };
    expect((await request("/videos", { method: "POST", body: form(foreign) })).status).toBe(404);
    const res = await request("/videos", { method: "POST", body: form(avatar.id) });
    expect(res.status).toBe(202);
    const { id } = await res.json() as any;
    expect(used()).toBe(AVATAR_CREDITS + 4000);
    const meta = JSON.parse(sqlite.prepare("SELECT video_meta FROM jobs WHERE id=?").get(id)!.video_meta as string);
    expect(meta).toMatchObject({ engine: "avatar_iv", userAvatarId: avatar.id, heygenAvatar: { lookId: "look_u1", groupId: "group_u1" } });
    expect(meta.imageKey).toBeUndefined();
    expect((await request(`/my-avatars/${avatar.id}`, { method: "DELETE" })).status).toBe(409);
    const calls = heygen("completed");
    await new (VideoGeneration as any)({}, env).run({ payload: { jobId: id } }, step);
    const submit = calls.find((c) => c.url === "https://api.heygen.com/v3/videos" && c.init?.method === "POST")!;
    expect(JSON.parse(submit.init!.body as string)).toMatchObject({ type: "avatar", avatar_id: "look_u1", engine: { type: "avatar_iv" } });
    // No per-video avatar was created or removed.
    expect(calls.some((c) => c.url === "https://api.heygen.com/v3/avatars")).toBe(false);
    // Only HeyGen's copy of the finished video is deleted; the avatar stays.
    expect(calls.filter((c) => c.init?.method === "DELETE").map((c) => c.url)).toEqual(["https://api.heygen.com/v3/videos/v_1"]);
    expect(sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(id)!.status).toBe("completed");
    const cleanup = heygen();
    expect((await request(`/my-avatars/${avatar.id}`, { method: "DELETE" })).status).toBe(200);
    expect(cleanup.some((c) => c.init?.method === "DELETE" && c.url.endsWith("/avatars/group_u1"))).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM user_avatars WHERE user_id='u'").get()!.n).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM cleanup_tasks").get()!.n).toBe(0);
    expect([...env.AUDIO.objects.keys()].some((k: string) => k.startsWith("avatars/"))).toBe(false);
  });
});
