import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import worker from "../server/index";
import { database, bucket } from "./helpers";
import { now } from "../server/types";
import { sha } from "../server/security";

let env: any, sqlite: ReturnType<typeof database>["sqlite"];
const photo = readFileSync(new URL("../public/images/avatar-library/mila.jpg", import.meta.url));
const fields = { name: "Ралица", description: "Водеща в студио", category: "business", presentation: "female" };
beforeEach(async () => {
  const d = database(); sqlite = d.sqlite;
  sqlite.exec("INSERT INTO users VALUES('u','owner@example.com','Owner','hash',1,NULL,1)");
  sqlite.prepare("INSERT INTO sessions VALUES(?,'u',?)").run(await sha("session"), now() + 3600);
  env = { DB: d.db, AUDIO: bucket(), ADMIN_EMAILS: "owner@example.com", GENERATION: { create: vi.fn() },
    FAL_KEY: "test", VIDEO_GENERATION: { create: vi.fn().mockResolvedValue({}) },
    ASSETS: { fetch: vi.fn(async (r: Request) => {
      const name = new URL(r.url).pathname.split("/").pop();
      return new Response(readFileSync(new URL(`../public/images/avatar-library/${name}`, import.meta.url)), {headers: {"Content-Type":"image/jpeg"}});
    }) },
  };
});
afterEach(() => { sqlite.close(); });
function request(path: string, body?: unknown, method = "GET", authenticated = true) {
  return worker.fetch(new Request("https://rechbg.com/api" + path, { method,
    headers: { Origin: "https://rechbg.com", ...(authenticated ? { Cookie: "rech_session=session" } : {}), ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  }), env, { waitUntil: () => {} } as any);
}
function upload(bytes: Uint8Array = photo, consent = true) {
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => form.set(k, v));
  form.set("rightsConfirmed", String(consent));
  form.set("file", new Blob([bytes as BlobPart], { type: "image/jpeg" }), "portrait.jpg");
  return form;
}
it("requires authentication and administrator permissions for library writes", async () => {
  expect((await request("/avatars", undefined, "GET", false)).status).toBe(401);
  expect((await request("/avatars/mila/image", undefined, "GET", false)).status).toBe(401);
  expect((await request("/admin/avatars", upload(), "POST", false)).status).toBe(401);
  env.ADMIN_EMAILS = "other@example.com";
  expect((await request("/avatars")).status).toBe(200);
  expect((await request("/admin/avatars", upload(), "POST")).status).toBe(403);
  expect((await request("/admin/avatars/mila", undefined, "DELETE")).status).toBe(403);
  expect((await request("/admin/avatars/mila", {...fields, active:false}, "PUT")).status).toBe(403);
});
it("serves bundled JPEGs and rejects forged, oversized and unconfirmed uploads", async () => {
  const list = await (await request("/avatars")).json() as any;
  expect(list.avatars.map((a:any) => a.id)).toEqual(["mila", "boris", "elena", "daria", "alexander", "stefan", "yana"]);
  for (const a of list.avatars) {
    const response = await request(`/avatars/${a.id}/image`);
    expect(response.status).toBe(200); expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0,3)]).toEqual([255,216,255]); expect(bytes.length).toBeLessThan(2*1024*1024);
  }
  expect((await request("/admin/avatars", upload(new TextEncoder().encode('<svg onload="alert(1)">bad</svg>')), "POST")).status).toBe(400);
  expect((await request("/admin/avatars", upload(photo,false), "POST")).status).toBe(400);
  expect((await request("/admin/avatars", upload(new Uint8Array(2*1024*1024+1)), "POST")).status).toBe(400);
  expect((await request("/avatars/missing/image")).status).toBe(404);
  expect(env.AUDIO.objects.size).toBe(0);
});
it("persists independent additions, edits and tombstones without resetting hidden defaults", async () => {
  const [one,two] = await Promise.all([request("/admin/avatars",upload(),"POST"),request("/admin/avatars",upload(),"POST")]);
  expect(one.status).toBe(201); expect(two.status).toBe(201);
  const id = ((await one.json()) as any).avatar.id;
  expect((await request(`/admin/avatars/${id}`, {...fields,name:"Дария",active:true}, "PUT")).status).toBe(200);
  await request("/admin/avatars/mila", undefined, "DELETE");
  await request(`/admin/avatars/${id}`, undefined, "DELETE");
  // A new request/environment object reads the persisted per-avatar objects.
  env = {...env};
  const visible = (await (await request("/avatars")).json() as any).avatars;
  expect(visible).toHaveLength(7); expect(visible.some((a:any)=>a.id==="mila"||a.id===id)).toBe(false);
  expect((await request(`/avatars/${id}/image`)).status).toBe(404);
  const admin = (await (await request("/admin/avatars")).json() as any).avatars;
  expect(admin.find((a:any)=>a.id===id)).toMatchObject({name:"Дария",active:false});
  expect((await request(`/admin/avatars/${id}`, {...fields,name:"Дария",active:true}, "PUT")).status).toBe(200);
  expect((await request(`/avatars/${id}/image`)).status).toBe(200);
  expect(JSON.stringify(visible)).not.toContain("config/");
});
it("creates a normal video input copy from a library portrait without extra library credits", async () => {
  const p = crypto.randomUUID(), source = crypto.randomUUID(), time = now();
  sqlite.prepare("INSERT INTO projects VALUES(?,'u','Story','tts','Hello','mila','boris',400,?,?)").run(p,time,time);
  sqlite.exec("INSERT INTO usage_windows VALUES('u:trial','u',250000,0)");
  sqlite.prepare("INSERT INTO jobs(id,user_id,project_id,window_id,idempotency_key,title,mode,script,voice,second_voice,pause_ms,chars,status,audio_key,duration,created_at,updated_at) VALUES(?,'u',?,'u:trial',?,'Story','tts','Hello','mila','boris',400,0,'completed',?,5,?,?)").run(source,p,source,`audio/u/${source}.wav`,time,time);
  await env.AUDIO.put(`audio/u/${source}.wav`, new Uint8Array(44));
  const portrait = await request("/avatars/mila/image");
  expect(sqlite.prepare("SELECT used FROM usage_windows").get()!.used).toBe(0);
  const form = new FormData();
  Object.entries({sourceId:source,tier:"medium",credits:"4500",consent:"true",idempotencyKey:crypto.randomUUID()}).forEach(([k,v])=>form.set(k,v));
  form.set("image",await portrait.blob(),"Мила.jpg");
  const response = await request("/videos",form,"POST"); expect(response.status).toBe(202);
  const id = (await response.json() as any).id;
  const meta = JSON.parse(sqlite.prepare("SELECT video_meta FROM jobs WHERE id=?").get(id)!.video_meta as string);
  expect(meta.imageMime).toBe("image/jpeg"); expect(meta.imageKey).toContain(`segments/u/${id}/`);
  expect(sqlite.prepare("SELECT used FROM usage_windows").get()!.used).toBe(4500);
  await request("/admin/avatars/mila",undefined,"DELETE");
  expect((await request("/avatars/mila/image")).status).toBe(404);
  expect(await env.AUDIO.head(meta.imageKey)).not.toBeNull();
  expect(env.VIDEO_GENERATION.create).toHaveBeenCalledTimes(1);
});
