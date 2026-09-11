import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decodeAudio, wavHeader, segments, voiceMap } from "../server/audio";
import { hashPassword, checkPassword, sha } from "../server/security";
import { database, bucket } from "./helpers";
import worker from "../server/index";
import { AudioGeneration } from "../server/workflow";
import type { Env } from "../server/types";
import { now } from "../server/types";
import { allowance } from "../server/billing";
import { voiceList } from "../shared/catalog";
function wav() {
  const bytes = new Uint8Array(244);
  bytes.set(wavHeader(200, 24000));
  return bytes;
}
function jobSql(
  db: any,
  id: string,
  user = "u",
  window = "u:trial",
  chars = 200,
) {
  return db
    .prepare(
      "INSERT INTO jobs(id,user_id,project_id,window_id,idempotency_key,title,mode,script,voice,second_voice,pause_ms,chars,created_at,updated_at) VALUES (?,?,?,?,?,'Тест','tts','Тестов запис','mila','boris',400,?,?,?)",
    )
    .bind(id, user, "p", window, id, chars, now(), now())
    .run();
}
describe("Cloudflare audio contract", () => {
  it("has 30 distinct server mappings and Bulgarian-only public voice IDs", () => {
    expect(voiceList).toHaveLength(30);
    expect(new Set(Object.values(voiceMap)).size).toBe(30);
    expect(JSON.stringify(voiceList)).not.toMatch(/Zephyr|Gemini|google/);
  });
  it("decodes actual WAV and notebook-compatible PCM data URLs", () => {
    const d = decodeAudio(Buffer.from(wav()).toString("base64"));
    expect(d.rate).toBe(24000);
    expect(d.pcm.length).toBe(200);
    expect(
      decodeAudio("data:audio/l16;rate=24000;base64,AAAAAA==").pcm.length,
    ).toBe(4);
  });
  it("rejects unknown audio, MP3, invalid rates and truncated WAV", () => {
    expect(() => decodeAudio("AAAAAA==")).toThrow();
    expect(() => decodeAudio("data:audio/mpeg;base64,SUQzAA==")).toThrow();
    expect(() =>
      decodeAudio("data:audio/l16;rate=0;base64,AAAAAA=="),
    ).toThrow();
    expect(() =>
      decodeAudio(Buffer.from(wav().slice(0, 60)).toString("base64")),
    ).toThrow();
  });
  it("splits speakers without speaking their labels and bounds long segments", () => {
    const s = segments(
      "1: Здравейте!\n2: Радвам се да съм тук.",
      "podcast",
      "mila",
      "boris",
    );
    expect(s).toEqual([
      { text: "Здравейте!", voice: "mila" },
      { text: "Радвам се да съм тук.", voice: "boris" },
    ]);
    const long = segments("Дума. ".repeat(1700), "tts", "mila", "boris");
    expect(long.every((x) => x.text.length <= 1800)).toBe(true);
    expect(long.length).toBeGreaterThan(1);
  });
  it("rejects malformed dialogue and identical voices", () => {
    expect(() => segments("без водещ", "podcast", "mila", "boris")).toThrow();
    expect(() =>
      segments("1: Здравей\n2: Здрасти", "podcast", "mila", "mila"),
    ).toThrow();
  });
});
describe("Authentication and actual SQL quota invariants", () => {
  it("hashes passwords with per-user salts and verifies without plaintext storage", async () => {
    const a = await hashPassword("testing-password-123"),
      b = await hashPassword("testing-password-123");
    expect(a).not.toBe(b);
    expect(await checkPassword("testing-password-123", a)).toBe(true);
    expect(await checkPassword("wrong", a)).toBe(false);
  });
  it("reserves atomically, prevents concurrent jobs, refunds once and never resets spent trial credits", async () => {
    const { db, sqlite } = database();
    sqlite.exec(
      "INSERT INTO users VALUES('u','u@test.invalid','Тест','hash',1,NULL,1); INSERT INTO projects VALUES('p','u','Тест','tts','Текст','mila','boris',400,1,1); INSERT INTO usage_windows VALUES('u:trial','u',1000,0)",
    );
    await jobSql(db, "j1");
    expect(sqlite.prepare("SELECT used FROM usage_windows").get()?.used).toBe(
      200,
    );
    await expect(jobSql(db, "j2")).rejects.toThrow("UNIQUE");
    expect(sqlite.prepare("SELECT used FROM usage_windows").get()?.used).toBe(
      200,
    );
    await db.prepare("UPDATE jobs SET status='failed' WHERE id='j1'").run();
    await db.prepare("UPDATE jobs SET status='failed' WHERE id='j1'").run();
    expect(sqlite.prepare("SELECT used FROM usage_windows").get()?.used).toBe(
      0,
    );
    await jobSql(db, "j3", "u", "u:trial", 900);
    await db.prepare("UPDATE jobs SET status='completed' WHERE id='j3'").run();
    await expect(jobSql(db, "j4", "u", "u:trial", 200)).rejects.toThrow(
      "QUOTA_EXCEEDED",
    );
    const u = sqlite.prepare("SELECT * FROM users").get() as any;
    const limits = await allowance({ DB: db } as Env, u);
    expect(limits.used).toBe(900);
  });
});
describe("Authenticated API and generation workflow", () => {
  let env: any, sqlite: ReturnType<typeof database>["sqlite"], cookie: string;
  beforeEach(async () => {
    const d = database();
    sqlite = d.sqlite;
    env = {
      DB: d.db,
      AUDIO: bucket(),
      GENERATION: { create: vi.fn().mockResolvedValue({}) },
      AI: {
        run: vi
          .fn()
          .mockResolvedValue({ audio: Buffer.from(wav()).toString("base64") }),
      },
      SITE_URL: "https://test.invalid",
      ASSETS: { fetch: async () => new Response("asset") },
    };
    cookie = "session-test";
    sqlite
      .prepare("INSERT INTO users VALUES(?,?,?,?,?,?,?)")
      .run("u", "u@test.invalid", "Тест", "hash", 1, null, now());
    sqlite
      .prepare("INSERT INTO users VALUES(?,?,?,?,?,?,?)")
      .run("other", "other@test.invalid", "Друг", "hash", 1, null, now());
    sqlite
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(await sha(cookie), "u", now() + 3600);
    sqlite
      .prepare("INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        "p",
        "u",
        "Тест",
        "tts",
        "Текст",
        "mila",
        "boris",
        400,
        now(),
        now(),
      );
  });
  const call = (
    path: string,
    method = "GET",
    body?: any,
    authenticated = true,
    origin = "https://test.invalid",
  ) =>
    worker.fetch(
      new Request("https://test.invalid/api" + path, {
        method,
        headers: {
          ...(authenticated ? { Cookie: "rech_session=" + cookie } : {}),
          Origin: origin,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env,
      { waitUntil: () => {} } as any,
    );
  it("blocks unauthenticated project access and cross-origin mutations", async () => {
    expect((await call("/projects", "GET", undefined, false)).status).toBe(401);
    expect(
      (
        await call(
          "/settings",
          "PUT",
          { name: "Ново име" },
          true,
          "https://evil.invalid",
        )
      ).status,
    ).toBe(403);
  });
  it("keeps provider voice names out of public API and protects ownership", async () => {
    const r = await call("/voices", "GET", undefined, false);
    expect(await r.text()).not.toMatch(/Zephyr|Gemini|google/);
    sqlite
      .prepare("INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        "private",
        "other",
        "Чужд",
        "tts",
        "Чужд текст",
        "mila",
        "boris",
        400,
        now(),
        now(),
      );
    expect((await call("/projects/private")).status).toBe(404);
    expect((await call("/projects")).status).toBe(200);
  });
  it("gates registration and billing until configured", async () => {
    expect((await call("/auth/register", "POST", {}, false)).status).toBe(503);
    expect(
      (await call("/billing/checkout", "POST", { plan: "creator" })).status,
    ).toBe(503);
  });
  it("only allows verified users to generate and idempotently reserves credits", async () => {
    const project = crypto.randomUUID();
    sqlite.prepare("UPDATE projects SET id=? WHERE id=?").run(project, "p");
    const payload = { projectId: project, idempotencyKey: crypto.randomUUID() };
    const first = await call("/generate", "POST", payload);
    expect(first.status).toBe(202);
    const a: any = await first.json();
    const retry: any = await (await call("/generate", "POST", payload)).json();
    expect(retry.id).toBe(a.id);
    expect(env.GENERATION.create).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT used FROM usage_windows").get()?.used).toBe(
      5,
    );
    sqlite.prepare("UPDATE users SET verified=0 WHERE id=?").run("u");
    expect(
      (
        await call("/generate", "POST", {
          ...payload,
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(403);
  });
  it("does not refund ambiguous dispatch failures, allowing cron recovery", async () => {
    const project = crypto.randomUUID();
    sqlite.prepare("UPDATE projects SET id=? WHERE id=?").run(project, "p");
    env.GENERATION.create.mockRejectedValue(new Error("Timeout after create"));
    expect(
      (
        await call("/generate", "POST", {
          projectId: project,
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(202);
    expect(sqlite.prepare("SELECT status FROM jobs").get()?.status).toBe(
      "queued",
    );
  });
  it("only exposes a completed audio file to its owner", async () => {
    sqlite
      .prepare("INSERT INTO usage_windows VALUES(?,?,?,?)")
      .run("u:trial", "u", 1000, 0);
    await jobSql(env.DB, "test-audio");
    await env.AUDIO.put("audio/u/test-audio.wav", wav());
    sqlite.exec(
      "UPDATE jobs SET status='completed',audio_key='audio/u/test-audio.wav' WHERE id='test-audio'",
    );
    expect(
      (await call("/jobs/test-audio/audio", "GET", undefined, false)).status,
    ).toBe(401);
    const r = await call("/jobs/test-audio/audio");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/wav");
    expect((await r.arrayBuffer()).byteLength).toBe(244);
  });
  it("runs the actual workflow through synthesis, WAV assembly, private storage and completion", async () => {
    sqlite
      .prepare("INSERT INTO usage_windows VALUES(?,?,?,?)")
      .run("u:trial", "u", 1000, 0);
    await jobSql(env.DB, "workflow");
    vi.stubGlobal(
      "FixedLengthStream",
      class extends TransformStream {
        constructor(_size: number) {
          super();
        }
      },
    );
    const workflow = new (AudioGeneration as any)({}, env);
    const step = {
      do: async (_name: string, options: any, fn?: any) => (fn || options)(),
    };
    await workflow.run({ payload: { jobId: "workflow" } }, step);
    expect(env.AI.run).toHaveBeenCalledWith("google/gemini-3.1-flash-tts", {
      text: "Тестов запис",
      voice: "Zephyr",
    });
    expect(
      sqlite.prepare("SELECT status FROM jobs WHERE id='workflow'").get()
        ?.status,
    ).toBe("completed");
    expect(env.AUDIO.objects.has("audio/u/workflow.wav")).toBe(true);
    expect(
      [...env.AUDIO.objects.keys()].some((k: any) => k.startsWith("segments/")),
    ).toBe(false);
    vi.unstubAllGlobals();
  });
  it("refunds a failed synthesis and does not expose provider errors", async () => {
    sqlite
      .prepare("INSERT INTO usage_windows VALUES(?,?,?,?)")
      .run("u:trial", "u", 1000, 0);
    await jobSql(env.DB, "failure");
    env.AI.run.mockRejectedValue(new Error("secret provider error"));
    const workflow = new (AudioGeneration as any)({}, env);
    const step = {
      do: async (_name: string, options: any, fn?: any) => (fn || options)(),
    };
    await expect(
      workflow.run({ payload: { jobId: "failure" } }, step),
    ).rejects.toThrow();
    expect(sqlite.prepare("SELECT used FROM usage_windows").get()?.used).toBe(
      0,
    );
    const j = sqlite
      .prepare("SELECT status,error FROM jobs WHERE id='failure'")
      .get();
    expect(j?.status).toBe("failed");
    expect(j?.error).not.toContain("provider");
  });
});
