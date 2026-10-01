import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../server/index";
import { database, bucket } from "./helpers";
import { sha } from "../server/security";
import { now } from "../server/types";
import {
  createMediaTask,
  exportQuote,
  mediaAllowance,
  validDocument,
} from "../server/media";
import { MediaGeneration, failMedia } from "../server/media-workflow";
import { maintainMedia } from "../server/media-maintenance";
import { imageFits, imageSize } from "../shared/image-size";
import { mediaCredits, MB } from "../shared/media";
import { captionAss, renderDimensions } from "../server/caption-ass";
import { captionPresets, defaultCaptions } from "../shared/captions";
let sqlite: ReturnType<typeof database>["sqlite"], env: any, user: any;
const step: any = {
  do: async (_name: string, ...args: any[]) => args.at(-1)(),
  sleep: async () => {},
};
beforeEach(async () => {
  const d = database();
  sqlite = d.sqlite;
  sqlite.exec(
    "INSERT INTO users VALUES('u','u@example.com','User','hash',1,NULL,1); INSERT INTO users VALUES('other','o@example.com','Other','hash',1,NULL,1)",
  );
  sqlite
    .prepare("INSERT INTO sessions VALUES(?,'u',?)")
    .run(await sha("media-session"), now() + 3600);
  sqlite
    .prepare(
      "INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end) VALUES('sub','u','studio','active',?,?)",
    )
    .run(now() - 10, now() + 86400);
  env = {
    DB: d.db,
    AUDIO: bucket(),
    MEDIA_ENABLED: "true",
    SITE_URL: "https://rechbg.com",
    MEDIA_GENERATION: { create: vi.fn(), get: vi.fn() },
    MEDIA_RENDERER: { idFromName: (s: string) => s, get: vi.fn() },
    FAL_KEY: "fal-secret",
    ELEVENLABS_API_KEY: "eleven-secret",
  };
  user = sqlite.prepare("SELECT * FROM users WHERE id='u'").get();
  await mediaAllowance(env, user);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sqlite.close();
});
function request(path: string, data?: unknown, method = "POST") {
  return worker.fetch(
    new Request("https://rechbg.com/api" + path, {
      method,
      headers: {
        Origin: "https://rechbg.com",
        Cookie: "rech_session=media-session",
        "Content-Type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }),
    env,
    { waitUntil: () => {} } as any,
  );
}
function asset(kind = "upload", duration = 60, owner = "u") {
  const id = crypto.randomUUID();
  sqlite
    .prepare("INSERT OR IGNORE INTO media_limits VALUES(?,20000000000,180)")
    .run(owner);
  sqlite
    .prepare(
      "INSERT INTO media_assets(id,user_id,object_key,name,kind,mime,bytes,status,duration,created_at,expires_at) VALUES(?,?,?,'Test',?,'video/mp4',100,'ready',?,?,?)",
    )
    .run(
      id,
      owner,
      `media/${owner}/${id}/original`,
      kind,
      duration,
      now(),
      now() + 86400,
    );
  return id;
}
const usage = () =>
  Number(
    sqlite
      .prepare(
        "SELECT COALESCE(SUM(used),0) n FROM usage_windows WHERE user_id='u'",
      )
      .get()!.n,
  );
async function task(
  kind: string,
  source: string,
  credits: number,
  extra: any = {},
) {
  return createMediaTask(env, user, {
    kind,
    source,
    credits,
    key: crypto.randomUUID(),
    payload: { inputs: [`media/u/${source}/original`], duration: 60, ...extra },
  });
}
it("rounds quotes by started minute and limits 2/4 image variants", () => {
  expect(mediaCredits("transcribe", 60)).toBe(1000);
  expect(mediaCredits("export", 60.01)).toBe(1000);
  expect(mediaCredits("product", 0, 4)).toBe(10000);
  expect(() => mediaCredits("transcribe", 601)).toThrow();
  expect(() => mediaCredits("product", 0, 3)).toThrow();
});
it("reserves quota once, locks input deletion, refunds the original window exactly once", async () => {
  const a = asset(),
    key = crypto.randomUUID(),
    d = {
      kind: "transcribe",
      source: a,
      credits: 1000,
      key,
      payload: { inputs: [`media/u/${a}/original`] },
    };
  const id = await createMediaTask(env, user, d);
  expect(await createMediaTask(env, user, d)).toBe(id);
  expect(usage()).toBe(1000);
  expect(
    (await request("/media/assets/" + a, undefined, "DELETE")).status,
  ).toBe(409);
  expect(() => sqlite.prepare("DELETE FROM users WHERE id='u'").run()).toThrow(
    "MEDIA_ACTIVE",
  );
  await failMedia(env, id);
  await failMedia(env, id);
  expect(usage()).toBe(0);
  expect(
    sqlite.prepare("SELECT COUNT(*) n FROM media_task_assets").get()!.n,
  ).toBe(0);
});
it("rolls back credit reservations when there is insufficient storage", async () => {
  const a = asset();
  sqlite
    .prepare("UPDATE media_limits SET max_bytes=200 WHERE user_id='u'")
    .run();
  // mediaAllowance restores the actual plan limit; exceed the Studio allowance deliberately.
  await expect(
    createMediaTask(env, user, {
      kind: "export",
      source: a,
      credits: 500,
      key: crypto.randomUUID(),
      payload: { inputs: [`media/u/${a}/original`] },
      outputs: 1,
      outputBytes: 30 * 1024 * MB,
    }),
  ).rejects.toThrow();
  expect(usage()).toBe(0);
  expect(env.MEDIA_GENERATION.create).not.toHaveBeenCalled();
});
it("rejects cross-user sources, forged quotes, disabled feature and unauthorised callers", async () => {
  const other = asset("upload", 60, "other");
  expect(
    (
      await request("/media/transcribe", {
        assetId: other,
        idempotencyKey: crypto.randomUUID(),
        credits: 1000,
      })
    ).status,
  ).toBe(404);
  const a = asset();
  expect(
    (
      await request("/media/transcribe", {
        assetId: a,
        idempotencyKey: crypto.randomUUID(),
        credits: 1,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await worker.fetch(
        new Request("https://rechbg.com/api/media"),
        env,
        {} as any,
      )
    ).status,
  ).toBe(401);
  env.MEDIA_ENABLED = "false";
  expect((await request("/media", undefined, "GET")).status).toBe(503);
});
it("gives exactly one included export and retains that receipt after snapshot cleanup", async () => {
  const a = asset();
  const transcript = await task("transcribe", a, 1000);
  sqlite
    .prepare(
      "UPDATE media_tasks SET status='completed',phase='completed' WHERE id=?",
    )
    .run(transcript);
  expect(await exportQuote(env, "u", a, 60, false)).toBe(0);
  const exportId = await task("export", a, 0);
  sqlite
    .prepare(
      "UPDATE media_tasks SET status='completed',updated_at=?,payload='{}' WHERE id=?",
    )
    .run(now() - 31 * 86400, exportId);
  expect(await exportQuote(env, "u", a, 60, false)).toBe(500);
  await maintainMedia(env);
  expect(await exportQuote(env, "u", a, 60, false)).toBe(500);
});
it("transcribes Bulgarian using a private input URL and never repeats an ambiguous paid call", async () => {
  const a = asset(),
    id = await task("transcribe", a, 1000);
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      words: [
        { type: "word", text: "Здравей", start: 0, end: 0.5 },
        { type: "spacing", text: " ", start: 0.5, end: 0.5 },
        { type: "word", text: "свят", start: 0.5, end: 1 },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await new MediaGeneration({} as any, env).run(
    { payload: { taskId: id } } as any,
    step,
  );
  const [url, opts] = fetch.mock.calls[0];
  expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
  expect(opts.headers["xi-api-key"]).toBe("eleven-secret");
  expect(opts.body.get("source_url")).toContain(
    `/api/media-inputs/${id}/0?token=`,
  );
  expect(opts.body.get("language_code")).toBe("bul");
  expect(
    JSON.parse(
      String(
        sqlite.prepare("SELECT captions FROM media_assets WHERE id=?").get(a)!
          .captions,
      ),
    ).words,
  ).toHaveLength(2);
  sqlite.prepare("UPDATE media_tasks SET status='running' WHERE id=?").run(id);
  await new MediaGeneration({} as any, env).run(
    { payload: { taskId: id } } as any,
    step,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  const second = asset(),
    uncertain = await task("transcribe", second, 1000);
  sqlite
    .prepare("UPDATE media_tasks SET submitted_at=1 WHERE id=?")
    .run(uncertain);
  await expect(
    new MediaGeneration({} as any, env).run(
      { payload: { taskId: uncertain } } as any,
      step,
    ),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(usage()).toBe(1000);
});
it.each([
  { scene: undefined, count: 2 },
  { scene: "original", count: 4 },
  { scene: "studio", count: 2 },
  { scene: "home", count: 2 },
  { scene: "outdoor", count: 2 },
])("queues product edits ($scene, $count variants), stores private variants, and exposes no provider ticket", async ({ scene, count }) => {
  const portrait = asset("portrait"),
    product = asset("product"),
    key = crypto.randomUUID();
  const response = await request("/media/products", {
    portraitId: portrait,
    productId: product,
    count,
    placement: "hold",
    scene,
    consent: true,
    idempotencyKey: key,
    credits: count * 2500,
  });
  expect(response.status).toBe(202);
  const { id } = (await response.json()) as any;
  const payload = JSON.parse(String(sqlite.prepare("SELECT payload FROM media_tasks WHERE id=?").get(id)!.payload));
  expect(payload.scene).toBe(scene ?? "original");
  const ticket = {
    request_id: "r",
    status_url:
      "https://queue.fal.run/fal-ai/nano-banana-pro/requests/r/status",
    response_url: "https://queue.fal.run/fal-ai/nano-banana-pro/requests/r",
  };
  // Bucket mock supports arrayBuffer through a real Response, just like R2.
  const get = env.AUDIO.get;
  env.AUDIO.get = async (...args: any[]) => {
    const o = await get(...args);
    return o
      ? { ...o, arrayBuffer: () => new Response(o.body).arrayBuffer() }
      : null;
  };
  const mock = vi.fn(async (url: string, init: any) => {
    if (init?.method === "POST") {
      const input = JSON.parse(init.body);
      expect(input.num_images).toBe(count);
      expect(input.resolution).toBe("1K");
      expect(input.aspect_ratio).toBe("9:16");
      expect(input.limit_generations).toBe(true);
      expect(input.image_urls).toHaveLength(2);
      expect(input.image_urls[0]).toContain(`/api/media-inputs/${id}/0?token=`);
      expect(input.image_urls[1]).toContain(`/api/media-inputs/${id}/1?token=`);
      return Response.json(ticket);
    }
    if (url === ticket.status_url)
      return Response.json({ status: "COMPLETED" });
    if (url === ticket.response_url)
      return Response.json({
        images: Array.from({ length: count }, (_, i) => ({ url: `https://fal.media/${i + 1}.jpg` })),
      });
    return new Response(new Uint8Array([255, 216, 255, ...Array(30).fill(0)]));
  });
  vi.stubGlobal("fetch", mock);
  await new MediaGeneration({} as any, env).run(
    { payload: { taskId: id } } as any,
    step,
  );
  expect(
    sqlite
      .prepare(
        "SELECT COUNT(*) n FROM media_assets WHERE kind='variant' AND status='ready'",
      )
      .get()!.n,
  ).toBe(count);
  expect(usage()).toBe(count * 2500);
  const publicResponse = await (
    await request("/media", undefined, "GET")
  ).text();
  expect(publicResponse).not.toContain("queue.fal");
  expect(publicResponse).not.toContain("fal-secret");
});
it("renders asynchronously, stores output, and survives a repeated workflow invocation without rendering twice", async () => {
  const a = asset();
  const id = await createMediaTask(env, user, {
    kind: "export",
    source: a,
    credits: 500,
    key: crypto.randomUUID(),
    payload: {
      inputs: [`media/u/${a}/original`],
      document: defaultCaptions,
      duration: 60,
    },
    outputs: 1,
    outputBytes: 50 * MB,
  });
  const call = vi.fn(async (url: string, opts: any) =>
    opts?.method === "POST"
      ? Response.json({ status: "running" })
      : url.endsWith("/file")
        ? new Response(new Uint8Array(50))
        : Response.json({ status: "completed", duration: 60 }),
  );
  env.MEDIA_RENDERER.get.mockReturnValue({ fetch: call });
  await new MediaGeneration({} as any, env).run(
    { payload: { taskId: id } } as any,
    step,
  );
  const n = call.mock.calls.length;
  expect(
    sqlite.prepare("SELECT bytes FROM media_assets WHERE kind='export'").get()!
      .bytes,
  ).toBe(50);
  await new MediaGeneration({} as any, env).run(
    { payload: { taskId: id } } as any,
    step,
  );
  expect(call).toHaveBeenCalledTimes(n);
});
it("protects active inputs from cleanup and removes expired files after processing", async () => {
  const a = asset();
  await env.AUDIO.put(`media/u/${a}/original`, new Uint8Array(100));
  const id = await task("transcribe", a, 1000);
  sqlite
    .prepare("UPDATE media_assets SET expires_at=? WHERE id=?")
    .run(now() - 1, a);
  await maintainMedia(env);
  expect(await env.AUDIO.head(`media/u/${a}/original`)).toBeTruthy();
  await failMedia(env, id);
  await maintainMedia(env);
  expect(await env.AUDIO.head(`media/u/${a}/original`)).toBeNull();
});
it("validates caption ranges and escapes subtitle control syntax", () => {
  expect(() =>
    validDocument(
      { ...defaultCaptions, words: [{ text: "x", start: 1, end: 3 }] },
      2,
    ),
  ).toThrow();
  const doc = {
    ...defaultCaptions,
    style: "bold" as const,
    resolution: "1080p" as const,
    words: [{ text: "{\\p1}Здравей", start: 0, end: 1 }],
  };
  const ass = captionAss(doc);
  expect(ass).not.toContain("{\\p1}");
  expect(ass).toContain("Здравей");
  expect(renderDimensions(doc)).toEqual([1080, 1920]);
});
it("renders every caption preset to ASS with style-specific word emphasis", () => {
  const words = [{ text: "Едно", start: 0, end: .4 }, { text: "две", start: .5, end: .9 }];
  for (const preset of captionPresets) {
    const ass = captionAss({ ...defaultCaptions, style: preset.id, accent: preset.accent, words });
    expect(ass.match(/^Dialogue:/gm)?.length).toBeGreaterThan(0);
    expect(ass).not.toContain("{}");
  }
  const outline = captionAss({ ...defaultCaptions, style: "outline", words });
  expect(outline).toMatch(/Style: Default,Noto Sans,\d+,&HFF/);
  expect(outline).toContain("\\1a&H00&");
  const banner = captionAss({ ...defaultCaptions, style: "banner", accent: "#ffe16b", words });
  expect(banner).toContain("&H006be1ff,&H006be1ff");
  expect(banner).toContain("{\\1a&H70&}две");
  expect(captionAss({ ...defaultCaptions, style: "retro", accent: "#ff5fa2", words })).toMatch(/,&H00a25fff,-1,/);
  expect(captionAss({ ...defaultCaptions, style: "luxe", words })).toMatch(/Style: Default,Noto Serif,\d+,.*,0,-1,0,0,/);
  const fade = captionAss({ ...defaultCaptions, style: "fade", words });
  expect(fade).toContain("Едно {\\1c");
  expect(fade).toContain("\\t(0,220,\\alpha&H00&)}две");
  expect(captionAss({ ...defaultCaptions, style: "impact", words }).match(/\\frz3/g)?.length).toBe(2);
});
it("accepts chunked uploads beyond the ordinary API body limit and rejects missing parts", async () => {
  const uploads = new Map<string, any>();
  const create = env.AUDIO.createMultipartUpload;
  env.AUDIO.createMultipartUpload = async (key: string, opts: any) => {
    const u = await create(key, opts);
    const uploadId = crypto.randomUUID();
    uploads.set(uploadId, u);
    return { ...u, uploadId };
  };
  env.AUDIO.resumeMultipartUpload = (_key: string, id: string) =>
    uploads.get(id);
  const start = await request("/media/uploads", {
    name: "clip.mp4",
    bytes: 9 * MB,
    mime: "video/mp4",
    kind: "upload",
  });
  expect(start.status).toBe(200);
  const upload = (await start.json()) as any;
  expect(
    (await request(`/media/uploads/${upload.id}/complete`, {})).status,
  ).toBe(400);
  for (let part = 1; part <= 2; part++) {
    const r = await worker.fetch(
      new Request(
        `https://rechbg.com/api/media/uploads/${upload.id}/parts/${part}`,
        {
          method: "PUT",
          headers: {
            Origin: "https://rechbg.com",
            Cookie: "rech_session=media-session",
          },
          body: new Uint8Array((part === 1 ? 8 : 1) * MB),
        },
      ),
      env,
      {} as any,
    );
    expect(r.status).toBe(200);
  }
  const done = await request(`/media/uploads/${upload.id}/complete`, {});
  expect(done.status).toBe(202);
  expect(env.MEDIA_GENERATION.create).toHaveBeenCalledTimes(1);
  const row = sqlite.prepare("SELECT * FROM media_tasks").get()!;
  const input = `https://rechbg.com/api/media-inputs/${row.id}/0?token=${row.token}`;
  expect((await worker.fetch(new Request(input), env, {} as any)).status).toBe(
    200,
  );
  expect(
    (await worker.fetch(new Request(input + "invalid"), env, {} as any)).status,
  ).toBe(404);
  await failMedia(env, String(row.id));
  expect((await worker.fetch(new Request(input), env, {} as any)).status).toBe(
    404,
  );
});
it("atomically reserves ordinary generated recording storage before starting paid speech", async () => {
  const project = crypto.randomUUID();
  sqlite
    .prepare(
      "INSERT INTO projects VALUES(?,'u','Audio','tts','Здравей свят','mila','boris',0,1,1)",
    )
    .run(project);
  env.GENERATION = { create: vi.fn() };
  const r = await request("/generate", {
    projectId: project,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(r.status).toBe(202);
  expect(
    sqlite
      .prepare("SELECT kind,status FROM media_assets WHERE job_id IS NOT NULL")
      .get(),
  ).toMatchObject({ kind: "audio", status: "uploading" });
  expect(
    sqlite.prepare("SELECT COUNT(*) n FROM media_job_history").get()!.n,
  ).toBe(1);
});
it("fails a lost or finished-but-open media task after two hours, refunds it and stops its render", async () => {
  const usedNow = () => (sqlite.prepare("SELECT SUM(used) n FROM usage_windows WHERE user_id='u'").get() as any).n || 0;
  const before = usedNow();
  const a = asset(),
    id = await task("export", a, 500);
  expect(usedNow()).toBe(before + 500);
  const renderer = { fetch: vi.fn().mockResolvedValue(Response.json({})) };
  env.MEDIA_RENDERER.get = vi.fn(() => renderer);
  sqlite.prepare("UPDATE media_tasks SET status='running',updated_at=?,created_at=? WHERE id=?").run(now() - 600, now() - 600, id);
  // The workflow ended without recording its result.
  env.MEDIA_GENERATION.get = vi.fn().mockResolvedValue({ status: async () => ({ status: "complete" }), terminate: vi.fn() });
  await maintainMedia(env);
  expect((sqlite.prepare("SELECT status FROM media_tasks WHERE id=?").get(id) as any).status).toBe("failed");
  expect(usedNow()).toBe(before);
  expect(renderer.fetch).toHaveBeenCalledWith(`http://renderer/jobs/${id}`, { method: "DELETE" });
  // No workflow instance at all: failed once it is two hours old, so the user is never blocked.
  const b = asset(),
    lost = await task("transcribe", b, 1000);
  sqlite.prepare("UPDATE media_tasks SET status='running',updated_at=?,created_at=? WHERE id=?").run(now() - 600, now() - 600, lost);
  env.MEDIA_GENERATION.get = vi.fn().mockRejectedValue(new Error("not found"));
  await maintainMedia(env);
  expect((sqlite.prepare("SELECT status FROM media_tasks WHERE id=?").get(lost) as any).status).toBe("running");
  sqlite.prepare("UPDATE media_tasks SET created_at=? WHERE id=?").run(now() - 7300, lost);
  await maintainMedia(env);
  expect((sqlite.prepare("SELECT status FROM media_tasks WHERE id=?").get(lost) as any).status).toBe("failed");
  expect(usedNow()).toBe(before);
});
it("does not undo a task that completed while it was being failed", async () => {
  const a = asset(),
    id = await task("inspect", a, 0);
  sqlite.prepare("UPDATE media_tasks SET status='completed' WHERE id=?").run(id);
  await failMedia(env, id);
  expect((sqlite.prepare("SELECT status FROM media_tasks WHERE id=?").get(id) as any).status).toBe("completed");
  expect((sqlite.prepare("SELECT status FROM media_assets WHERE id=?").get(a) as any).status).toBe("ready");
});
it("reads image sizes from headers and refuses pictures too large to decode safely", async () => {
  const pngHeader = (w: number, h: number) => {
    const b = new Uint8Array(64);
    b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
    return b;
  };
  // JPEG: SOI, an APP0 segment, then SOF0 with height 300, width 400.
  const jpeg = new Uint8Array([255, 216, 255, 224, 0, 4, 1, 2, 255, 192, 0, 11, 8, 1, 44, 1, 144, 1, 1, 17, 0, 255, 217]);
  expect(imageSize(pngHeader(300, 400))).toEqual({ width: 300, height: 400 });
  expect(imageSize(jpeg)).toEqual({ width: 400, height: 300 });
  expect(imageFits(imageSize(pngHeader(4096, 4096)))).toBe(true);
  expect(imageFits(imageSize(pngHeader(30000, 30000)))).toBe(false);
  expect(imageFits(imageSize(new Uint8Array([255, 216, 255, 218, 0, 2])))).toBe(false);
  // Through the upload route: a 64-byte "portrait" declaring 30000×30000 pixels is refused.
  const uploads = new Map<string, any>();
  const create = env.AUDIO.createMultipartUpload;
  env.AUDIO.createMultipartUpload = async (key: string, opts: any) => {
    const u = await create(key, opts), uploadId = crypto.randomUUID();
    uploads.set(uploadId, u);
    return { ...u, uploadId };
  };
  env.AUDIO.resumeMultipartUpload = (_key: string, id: string) => uploads.get(id);
  const send = async (bytes: Uint8Array) => {
    const upload = (await (await request("/media/uploads", { name: "p.png", bytes: bytes.length, mime: "image/png", kind: "portrait" })).json()) as any;
    const r = await worker.fetch(new Request(`https://rechbg.com/api/media/uploads/${upload.id}/parts/1`, {
      method: "PUT", headers: { Origin: "https://rechbg.com", Cookie: "rech_session=media-session" }, body: new Blob([bytes as BlobPart]),
    }), env, {} as any);
    expect(r.status).toBe(200);
    return request(`/media/uploads/${upload.id}/complete`, {});
  };
  expect((await send(pngHeader(30000, 30000))).status).toBe(400);
  expect((await send(pngHeader(900, 1200))).status).toBe(200);
});
