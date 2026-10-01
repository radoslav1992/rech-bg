import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { bucket, database } from "./helpers";
import { now } from "../server/types";
import { sha } from "../server/security";
import { acceptSuggestions, sentencesOf } from "../server/shorts";

let sqlite: ReturnType<typeof database>["sqlite"], env: any;
const video = "11111111-2222-4333-8444-555555555555";
// 20 sentences of 4 seconds each (0–80 s).
const words = Array.from({ length: 20 }, (_, i) => [
  { text: `Изречение`, start: i * 4, end: i * 4 + 1 }, { text: `номер ${i}.`, start: i * 4 + 1.2, end: i * 4 + 3.5 },
]).flat();
function request(path: string, body?: unknown) {
  return worker.fetch(new Request("https://rechbg.com/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: "https://rechbg.com", "Content-Type": "application/json", Cookie: "rech_session=session" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil: () => {} } as any);
}
const ai = (clips: unknown) => vi.fn(async () => ({ status: "completed", output_text: JSON.stringify({ clips }) }));
beforeEach(async () => {
  const d = database(); sqlite = d.sqlite;
  env = { DB: d.db, AUDIO: bucket(), AI: { run: ai([]) }, SITE_URL: "https://rechbg.com", MEDIA_ENABLED: "true",
    MEDIA_GENERATION: { create: vi.fn(), get: vi.fn() }, MEDIA_RENDERER: { idFromName: (s: string) => s, get: vi.fn() } };
  sqlite.prepare("INSERT INTO users VALUES('u','u@example.com','User','hash',1,NULL,?)").run(now());
  sqlite.prepare("INSERT INTO sessions VALUES(?,'u',?)").run(await sha("session"), now() + 3600);
  sqlite.prepare("INSERT INTO usage_windows(id,user_id,quota,plan,used) VALUES('u:trial','u',100000,'free',0)").run();
  sqlite.prepare("INSERT INTO media_limits VALUES('u',5000000000,30)").run();
  sqlite.prepare("INSERT INTO media_assets(id,user_id,object_key,name,kind,mime,bytes,status,duration,captions,created_at,expires_at) VALUES(?,'u',?,'Подкаст.mp4','upload','video/mp4',1000,'ready',80,?,1,?)")
    .run(video, `media/u/${video}/original`, JSON.stringify({ words, style: "classic", format: "16:9", position: "bottom", enabled: true }), now() + 86400);
});
afterEach(() => { vi.unstubAllGlobals(); sqlite.close(); });

describe("Кратки клипове", () => {
  it("splits a transcript into sentences", () => {
    const s = sentencesOf(words);
    expect(s).toHaveLength(20);
    expect(s[3]).toEqual({ start: 12, end: 15.5, text: "Изречение номер 3." });
    // A long pause also ends a sentence.
    expect(sentencesOf([{ text: "а", start: 0, end: 1 }, { text: "б", start: 3, end: 4 }])).toHaveLength(2);
  });
  it("keeps only valid, non-overlapping picks of 8–90 seconds, on sentence boundaries", () => {
    const s = sentencesOf(words);
    const picks = acceptSuggestions({ clips: [
      { title: "Първи", hook: "Силно начало", first: 2, last: 6 }, // 7.85–27.85 s
      { title: "Застъпва се", hook: "", first: 5, last: 9 },
      { title: "Твърде кратък", hook: "", first: 12, last: 12 },
      { title: "Извън текста", hook: "", first: 18, last: 25 },
      { title: "<b>Втори</b>", hook: "", first: 10, last: 15 },
    ] }, s, 80);
    expect(picks.map((p) => [p.title, p.start, p.end])).toEqual([["Първи", 7.85, 27.85], ["bВтори/b", 39.85, 63.85]]);
    expect(picks[0].text).toBe("Изречение номер 2. Изречение номер 3. Изречение номер 4. Изречение номер 5. Изречение номер 6.");
  });
  it("suggests moments with AI, with a daily allowance that failures do not use", async () => {
    env.AI.run = ai([{ title: "Началото", hook: "Добра кука", first: 0, last: 4 }]);
    const res = await request("/tools/shorts/suggest", { assetId: video });
    expect(res.status).toBe(200);
    expect((await res.json() as any).clips).toMatchObject([{ title: "Началото", start: 0, end: 19.85 }]);
    const input = (env.AI.run.mock.calls[0] as any)[1].input as string;
    expect(input.split("\n")[1]).toBe("1 [4.0-7.5] Изречение номер 1.");
    env.AI.run = vi.fn(async () => { throw new Error("down"); });
    expect((await request("/tools/shorts/suggest", { assetId: video })).status).toBe(503);
    env.AI.run = ai([{ title: "Нищо", hook: "", first: 3, last: 3 }]);
    expect((await request("/tools/shorts/suggest", { assetId: video })).status).toBe(422);
    const hits = (sqlite.prepare("SELECT hits FROM rate_limits WHERE key LIKE '%' ORDER BY hits DESC").all() as any[]);
    expect(hits.some((h) => h.hits === 1)).toBe(true);
  });
  it("needs a transcript", async () => {
    sqlite.prepare("UPDATE media_assets SET captions=NULL").run();
    expect((await request("/tools/shorts/suggest", { assetId: video })).status).toBe(400);
  });
  it("creates a vertical one-scene project with the chosen part, ready for the usual export", async () => {
    const res = await request("/tools/shorts/project", { assetId: video, start: 7.85, end: 23.85, title: "Първи" });
    expect(res.status).toBe(201);
    const { id } = await res.json() as any;
    const project = sqlite.prepare("SELECT title,mode FROM projects WHERE id=?").get(id) as any;
    expect(project).toEqual({ title: "Кратък клип · Първи", mode: "studio" });
    const doc = JSON.parse((sqlite.prepare("SELECT document FROM project_documents WHERE project_id=?").get(id) as any).document);
    expect(doc.scenes[0].clip).toEqual({ assetId: video, keep: [[7.85, 23.85]], clean: true });
    expect(doc.captionLook).toMatchObject({ format: "9:16", fit: "cover" });
    // 16 s of the clip, charged as an export (no paid transcription).
    expect(await (await request(`/video-studio/projects/${id}/render/quote`)).json()).toEqual({ credits: 500, length: 16 });
    expect((await request("/tools/shorts/project", { assetId: video, start: 10, end: 11, title: "x" })).status).toBe(400);
  });
});
