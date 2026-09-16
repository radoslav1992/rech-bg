import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ContextVars, Env, DbUser } from "./types";
import { now, uid } from "./types";
import { allowance } from "./billing";
import { rate, token, safeEqual } from "./security";
import {
  mediaPlans,
  mediaCredits,
  MB,
  uploadLimit,
  uploadChunk,
} from "../shared/media";
import { defaultCaptions } from "../shared/captions";
import { documentSchema } from "./studio";

export async function mediaAllowance(e: Env, user: DbUser) {
  const a = await allowance(e, user),
    limits = mediaPlans[a.plan] || mediaPlans.free;
  await e.DB.prepare(
    "INSERT INTO media_limits(user_id,max_bytes,retention_days) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET max_bytes=excluded.max_bytes,retention_days=excluded.retention_days",
  )
    .bind(user.id, limits.bytes, limits.days)
    .run();
  return { ...a, ...limits };
}
export function mediaError(e: unknown): never {
  const text = String(e);
  if (text.includes("MEDIA_INPUT_UNAVAILABLE"))
    throw new HTTPException(409, {
      message: "Файлът вече не е достъпен. Обновете страницата.",
    });
  if (text.includes("STORAGE_FULL"))
    throw new HTTPException(409, {
      message:
        "Мястото за файлове е запълнено. Изтрийте ненужни файлове или сменете плана.",
    });
  if (text.includes("QUOTA_EXCEEDED"))
    throw new HTTPException(402, { message: "Нямате достатъчно кредити." });
  if (text.includes("UNIQUE"))
    throw new HTTPException(409, {
      message: "Вече обработваме заявка. Изчакайте завършването ѝ.",
    });
  throw e;
}
export async function ownedAsset(e: Env, user: string, id: string) {
  const a = await e.DB.prepare(
    "SELECT * FROM media_assets WHERE id=? AND user_id=? AND status='ready' AND expires_at>?",
  )
    .bind(id, user, now())
    .first<any>();
  if (!a)
    throw new HTTPException(404, {
      message: "Файлът не е наличен или срокът му е изтекъл.",
    });
  return a;
}
export function validDocument(input: unknown, duration: number) {
  const doc = documentSchema.parse(input);
  if (
    doc.words.some(
      (w, i) =>
        w.end <= w.start ||
        w.end > duration + 0.1 ||
        (i > 0 && w.start < doc.words[i - 1].end),
    )
  )
    throw new HTTPException(400, {
      message: "Проверете последователността и времената на субтитрите.",
    });
  return doc;
}
export async function serveObject(e: Env, key: string, range?: string) {
  const obj = await e.AUDIO.get(
    key,
    range ? { range: new Headers({ Range: range }) } : undefined,
  );
  if (!obj)
    throw new HTTPException(404, { message: "Файлът вече не е наличен." });
  const headers = new Headers({
    "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });
  if (obj.range && "offset" in obj.range && "length" in obj.range) {
    const r = obj.range as { offset: number; length: number };
    headers.set(
      "Content-Range",
      `bytes ${r.offset}-${r.offset + r.length - 1}/${obj.size}`,
    );
    headers.set("Content-Length", String(r.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
}
export const mediaInputs = new Hono<{ Bindings: Env }>();
mediaInputs.get("/:id/:index", async (c) => {
  if (c.env.MEDIA_ENABLED !== "true") throw new HTTPException(404);
  const task = await c.env.DB.prepare(
    "SELECT * FROM media_tasks WHERE id=? AND status IN ('queued','running') AND created_at>?",
  )
    .bind(c.req.param("id"), now() - 7200)
    .first<any>();
  if (!task || !safeEqual(task.token, c.req.query("token") || ""))
    throw new HTTPException(404);
  const index = Number(c.req.param("index")),
    inputs = JSON.parse(task.payload).inputs;
  if (!Number.isInteger(index) || index < 0 || !inputs?.[index])
    throw new HTTPException(404);
  return serveObject(c.env, inputs[index], c.req.header("Range"));
});
export const media = new Hono<{ Bindings: Env; Variables: ContextVars }>();
media.get("/config", (c) =>
  c.json({
    enabled:
      c.env.MEDIA_ENABLED === "true" &&
      !!c.env.MEDIA_GENERATION &&
      !!c.env.MEDIA_RENDERER,
    product: !!c.env.FAL_KEY,
    transcription: !!c.env.ELEVENLABS_API_KEY,
  }),
);
media.use("*", async (c, next) => {
  if (
    c.env.MEDIA_ENABLED !== "true" ||
    !c.env.MEDIA_GENERATION ||
    !c.env.MEDIA_RENDERER
  )
    throw new HTTPException(503, {
      message: "Новите инструменти се подготвят за активиране.",
    });
  if (c.req.method !== "GET" && !c.get("user").verified)
    throw new HTTPException(403, { message: "Потвърдете имейла си." });
  await next();
});
media.get("/", async (c) => {
  const a = await mediaAllowance(c.env, c.get("user"));
  const assets = (
    await c.env.DB.prepare(
      "SELECT id,name,kind,mime,bytes,status,duration,saved,created_at,expires_at,captions IS NOT NULL AS hasCaptions FROM media_assets WHERE user_id=? ORDER BY created_at DESC LIMIT 300",
    )
      .bind(c.get("user").id)
      .all()
  ).results;
  const tasks = (
    await c.env.DB.prepare(
      "SELECT id,kind,source_id,credits,status,phase,error,result,created_at FROM media_tasks WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
    )
      .bind(c.get("user").id)
      .all()
  ).results;
  const used = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(bytes),0) AS used FROM media_assets WHERE user_id=?",
  )
    .bind(c.get("user").id)
    .first<any>();
  return c.json({
    assets,
    tasks,
    storage: { used: used.used, limit: a.bytes, days: a.days },
  });
});
media.get("/assets/:id/file", async (c) => {
  const a = await ownedAsset(c.env, c.get("user").id, c.req.param("id"));
  return serveObject(c.env, a.object_key, c.req.header("Range"));
});
media.delete("/assets/:id", async (c) => {
  const id = c.req.param("id"),
    user = c.get("user").id;
  const busy = await c.env.DB.prepare(
    "SELECT id FROM media_tasks WHERE user_id=? AND status IN ('queued','running')",
  )
    .bind(user)
    .first();
  if (busy)
    throw new HTTPException(409, {
      message: "Изчакайте активната обработка, преди да изтривате файлове.",
    });
  const a = await c.env.DB.prepare(
    "SELECT * FROM media_assets WHERE id=? AND user_id=?",
  )
    .bind(id, user)
    .first<any>();
  if (!a) throw new HTTPException(404);
  if (
    a.job_id &&
    (await c.env.DB.prepare(
      "SELECT id FROM jobs WHERE user_id=? AND status IN ('queued','running')",
    )
      .bind(user)
      .first())
  )
    throw new HTTPException(409, { message: "Изчакайте текущия запис." });
  const claim = await c.env.DB.prepare(
    "UPDATE media_assets SET status='deleting',expires_at=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM media_tasks WHERE user_id=? AND status IN ('queued','running')) AND NOT EXISTS(SELECT 1 FROM jobs WHERE user_id=? AND status IN ('queued','running'))",
  )
    .bind(now(), id, user, user)
    .run();
  if (!claim.meta.changes)
    throw new HTTPException(409, { message: "Изчакайте активната обработка." });
  if (a.upload_id) {
    try {
      await c.env.AUDIO.resumeMultipartUpload(
        a.object_key,
        a.upload_id,
      ).abort();
    } catch {
      /* Already completed. */
    }
  }
  await c.env.AUDIO.delete(a.object_key);
  await c.env.DB.prepare("DELETE FROM media_assets WHERE id=?").bind(id).run();
  return c.json({ ok: true });
});
media.post("/assets/:id/save", async (c) => {
  const a = await ownedAsset(c.env, c.get("user").id, c.req.param("id"));
  if (!["portrait", "product", "variant"].includes(a.kind))
    throw new HTTPException(400);
  const plan = await mediaAllowance(c.env, c.get("user"));
  if (plan.plan === "free" || !plan.periodEnd)
    throw new HTTPException(403, {
      message: "Запазената библиотека е достъпна с активен абонамент.",
    });
  await c.env.DB.prepare(
    "UPDATE media_assets SET saved=1,expires_at=? WHERE id=?",
  )
    .bind(
      Math.max(now() + 30 * 86400, (plan.periodEnd || now()) + 30 * 86400),
      a.id,
    )
    .run();
  return c.json({ ok: true });
});
media.post("/uploads", async (c) => {
  await rate(c, "media-upload", 15, 3600, c.get("user").id);
  const d = z
    .object({
      name: z.string().trim().min(1).max(160),
      bytes: z.number().int().min(24).max(uploadLimit),
      kind: z.enum(["upload", "portrait", "product"]),
      mime: z.enum([
        "video/mp4",
        "video/quicktime",
        "video/webm",
        "image/jpeg",
        "image/png",
      ]),
    })
    .parse(await c.req.json());
  if (
    (d.kind === "upload") !== d.mime.startsWith("video/") ||
    (d.kind !== "upload" && d.bytes > 2 * MB)
  )
    throw new HTTPException(400, {
      message: "Качете видео до 500 MB или JPG/PNG до 2 MB.",
    });
  await mediaAllowance(c.env, c.get("user"));
  const id = uid(),
    key = `media/${c.get("user").id}/${id}/original`;
  try {
    await c.env.DB.prepare(
      "INSERT INTO media_assets(id,user_id,object_key,name,kind,mime,bytes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        c.get("user").id,
        key,
        d.name,
        d.kind,
        d.mime,
        d.bytes,
        now(),
        now() + 86400,
      )
      .run();
  } catch (e) {
    mediaError(e);
  }
  const upload = await c.env.AUDIO.createMultipartUpload(key, {
    httpMetadata: { contentType: d.mime },
  });
  await c.env.DB.prepare("UPDATE media_assets SET upload_id=? WHERE id=?")
    .bind(upload.uploadId, id)
    .run();
  return c.json({ id, chunkSize: uploadChunk });
});
media.put("/uploads/:id/parts/:part", async (c) => {
  const a = await c.env.DB.prepare(
    "SELECT * FROM media_assets WHERE id=? AND user_id=? AND status='uploading' AND expires_at>?",
  )
    .bind(c.req.param("id"), c.get("user").id, now())
    .first<any>();
  if (!a?.upload_id) throw new HTTPException(404);
  const part = z.coerce
    .number()
    .int()
    .min(1)
    .max(Math.ceil(a.bytes / uploadChunk))
    .parse(c.req.param("part"));
  const body = await c.req.arrayBuffer(),
    expected = Math.min(uploadChunk, a.bytes - (part - 1) * uploadChunk);
  if (body.byteLength !== expected)
    throw new HTTPException(400, {
      message: "Непълен фрагмент. Опитайте отново.",
    });
  const p = await c.env.AUDIO.resumeMultipartUpload(
    a.object_key,
    a.upload_id,
  ).uploadPart(part, body);
  await c.env.DB.prepare(
    "INSERT INTO media_parts(asset_id,part,etag,bytes) VALUES(?,?,?,?) ON CONFLICT(asset_id,part) DO UPDATE SET etag=excluded.etag,bytes=excluded.bytes",
  )
    .bind(a.id, part, p.etag, body.byteLength)
    .run();
  return c.json({ ok: true });
});
async function dispatch(e: Env, id: string) {
  try {
    await e.MEDIA_GENERATION!.create({ id, params: { taskId: id } });
  } catch {
    console.error("Media dispatch pending", { taskId: id });
  }
}
export async function createMediaTask(
  e: Env,
  user: DbUser,
  d: {
    kind: string;
    source: string;
    key: string;
    credits: number;
    payload: any;
    outputs?: number;
    outputBytes?: number;
    outputKind?: string;
  },
) {
  const prior = await e.DB.prepare(
    "SELECT id FROM media_tasks WHERE user_id=? AND idempotency_key=?",
  )
    .bind(user.id, d.key)
    .first<any>();
  if (prior) return prior.id as string;
  const a = await mediaAllowance(e, user),
    id = uid(),
    outputs = Array.from({ length: d.outputs || 0 }, () => uid());
  const payload = { ...d.payload, outputs, retentionDays: a.days };
  const statements = [
    e.DB.prepare(
      "INSERT INTO media_tasks(id,user_id,kind,source_id,idempotency_key,window_id,credits,payload,token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      id,
      user.id,
      d.kind,
      d.source,
      d.key,
      a.window,
      d.credits,
      JSON.stringify(payload),
      token(),
      now(),
      now(),
    ),
  ];
  for (const input of payload.inputs || [])
    statements.push(
      e.DB.prepare(
        "INSERT INTO media_task_assets(task_id,asset_id) SELECT ?,id FROM media_assets WHERE object_key=? AND user_id=?",
      ).bind(id, input, user.id),
    );
  for (const output of outputs)
    statements.push(
      e.DB.prepare(
        "INSERT INTO media_assets(id,user_id,object_key,name,kind,mime,bytes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).bind(
        output,
        user.id,
        `media/${user.id}/${output}/result`,
        d.kind === "product" ? "Аватар с продукт" : "Видео със субтитри",
        d.outputKind || "export",
        d.kind === "product" ? "image/jpeg" : "video/mp4",
        d.outputBytes || 400 * MB,
        now(),
        now() + 86400,
      ),
    );
  try {
    await e.DB.batch(statements);
  } catch (err) {
    const previous = await e.DB.prepare(
      "SELECT id FROM media_tasks WHERE user_id=? AND idempotency_key=?",
    )
      .bind(user.id, d.key)
      .first<any>();
    if (previous) return previous.id;
    mediaError(err);
  }
  await dispatch(e, id);
  return id;
}
media.post("/uploads/:id/complete", async (c) => {
  const a = await c.env.DB.prepare(
    "SELECT * FROM media_assets WHERE id=? AND user_id=?",
  )
    .bind(c.req.param("id"), c.get("user").id)
    .first<any>();
  if (!a) throw new HTTPException(404);
  if (a.status === "ready") return c.json({ id: a.id });
  const parts = (
    await c.env.DB.prepare(
      "SELECT part AS partNumber,etag,bytes FROM media_parts WHERE asset_id=? ORDER BY part",
    )
      .bind(a.id)
      .all<any>()
  ).results;
  if (
    parts.length !== Math.ceil(a.bytes / uploadChunk) ||
    parts.reduce((sum, p) => sum + p.bytes, 0) !== a.bytes
  )
    throw new HTTPException(400, { message: "Качването не е завършено." });
  if (!(await c.env.AUDIO.head(a.object_key)))
    await c.env.AUDIO.resumeMultipartUpload(a.object_key, a.upload_id).complete(
      parts.map(({ partNumber, etag }) => ({ partNumber, etag })),
    );
  if (a.kind === "upload") {
    const id = await createMediaTask(c.env, c.get("user"), {
      kind: "inspect",
      source: a.id,
      key: a.id,
      credits: 0,
      payload: { inputs: [a.object_key] },
    });
    await c.env.DB.prepare(
      "UPDATE media_assets SET status='checking' WHERE id=? AND status='uploading'",
    )
      .bind(a.id)
      .run();
    return c.json({ id: a.id, taskId: id }, 202);
  }
  const o = await c.env.AUDIO.get(a.object_key, {
      range: { offset: 0, length: 24 },
    }),
    b = new Uint8Array(await o!.arrayBuffer());
  const png =
      b.length >= 24 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v),
    jpg = b[0] === 255 && b[1] === 216 && b[2] === 255;
  if ((png && a.mime !== "image/png") || (jpg && a.mime !== "image/jpeg"))
    throw new HTTPException(400, {
      message: "Типът на файла не съответства на изображението.",
    });
  if (!png && !jpg)
    throw new HTTPException(400, { message: "Изберете валиден JPG или PNG." });
  const limits = await mediaAllowance(c.env, c.get("user"));
  await c.env.DB.prepare(
    "UPDATE media_assets SET status='ready',mime=?,expires_at=? WHERE id=?",
  )
    .bind(png ? "image/png" : "image/jpeg", now() + limits.days * 86400, a.id)
    .run();
  return c.json({ id: a.id });
});
media.get("/assets/:id/captions", async (c) => {
  const a = await ownedAsset(c.env, c.get("user").id, c.req.param("id"));
  return c.json(a.captions ? JSON.parse(a.captions) : defaultCaptions);
});
media.put("/assets/:id/captions", async (c) => {
  const a = await ownedAsset(c.env, c.get("user").id, c.req.param("id"));
  const doc = validDocument(await c.req.json(), a.duration);
  await c.env.DB.prepare("UPDATE media_assets SET captions=? WHERE id=?")
    .bind(JSON.stringify(doc), a.id)
    .run();
  return c.json({ ok: true });
});
media.post("/transcribe", async (c) => {
  const d = z
    .object({
      assetId: z.uuid(),
      idempotencyKey: z.uuid(),
      credits: z.number().int(),
    })
    .parse(await c.req.json());
  if (!c.env.ELEVENLABS_API_KEY)
    throw new HTTPException(503, {
      message: "Разпознаването на реч временно не е достъпно.",
    });
  const a = await ownedAsset(c.env, c.get("user").id, d.assetId);
  if (a.kind !== "upload" || !a.duration) throw new HTTPException(400);
  const credits = mediaCredits("transcribe", a.duration);
  if (credits !== d.credits)
    throw new HTTPException(409, {
      message: "Обновете цената и опитайте отново.",
    });
  if (a.captions)
    throw new HTTPException(409, {
      message: "Субтитрите вече са готови. Можете да ги редактирате.",
    });
  const id = await createMediaTask(c.env, c.get("user"), {
    kind: "transcribe",
    source: a.id,
    key: d.idempotencyKey,
    credits,
    payload: { inputs: [a.object_key], duration: a.duration },
  });
  return c.json({ id }, 202);
});
export async function exportSource(e: Env, user: string, source: string) {
  const job = await e.DB.prepare(
    "SELECT * FROM jobs WHERE id=? AND user_id=? AND kind='video' AND status='completed'",
  )
    .bind(source, user)
    .first<any>();
  if (job?.video_key && (await e.AUDIO.head(job.video_key)))
    return { key: job.video_key, duration: job.duration, generated: true };
  const a = await ownedAsset(e, user, source);
  if (a.kind !== "upload" || !a.duration) throw new HTTPException(400);
  return { key: a.object_key, duration: a.duration, generated: false };
}
export async function exportQuote(
  e: Env,
  user: string,
  source: string,
  duration: number,
  generated: boolean,
) {
  const previous = await e.DB.prepare(
    "SELECT id FROM media_tasks WHERE user_id=? AND source_id=? AND kind='export' AND status IN ('queued','running','completed') LIMIT 1",
  )
    .bind(user, source)
    .first();
  const transcription = await e.DB.prepare(
    "SELECT id FROM media_tasks WHERE user_id=? AND source_id=? AND kind='transcribe' AND status='completed' LIMIT 1",
  )
    .bind(user, source)
    .first();
  return !previous && (generated || transcription)
    ? 0
    : mediaCredits("export", duration);
}
media.get("/exports/:source/quote", async (c) => {
  const s = await exportSource(c.env, c.get("user").id, c.req.param("source"));
  return c.json({
    credits: await exportQuote(
      c.env,
      c.get("user").id,
      c.req.param("source"),
      s.duration,
      s.generated,
    ),
  });
});
media.post("/exports", async (c) => {
  const d = z
    .object({
      sourceId: z.uuid(),
      idempotencyKey: z.uuid(),
      credits: z.number().int().min(0),
      document: z.unknown(),
    })
    .parse(await c.req.json());
  const previous = await c.env.DB.prepare(
    "SELECT id FROM media_tasks WHERE user_id=? AND idempotency_key=?",
  )
    .bind(c.get("user").id, d.idempotencyKey)
    .first<any>();
  if (previous) return c.json({ id: previous.id });
  const s = await exportSource(c.env, c.get("user").id, d.sourceId),
    doc = validDocument(d.document, s.duration);
  const credits = await exportQuote(
    c.env,
    c.get("user").id,
    d.sourceId,
    s.duration,
    s.generated,
  );
  if (d.credits !== credits)
    throw new HTTPException(409, {
      message: "Цената се промени. Обновете страницата.",
    });
  const id = await createMediaTask(c.env, c.get("user"), {
    kind: "export",
    source: d.sourceId,
    key: d.idempotencyKey,
    credits,
    payload: { inputs: [s.key], document: doc, duration: s.duration },
    outputs: 1,
    outputBytes: Math.ceil(s.duration * 650000) + 5 * MB,
  });
  return c.json({ id }, 202);
});
media.post("/products", async (c) => {
  await rate(c, "product-images", 10, 3600, c.get("user").id);
  const d = z
    .object({
      portraitId: z.uuid(),
      productId: z.uuid(),
      count: z.union([z.literal(2), z.literal(4)]),
      placement: z.enum(["hold", "table", "beside"]),
      scene: z.enum(["studio", "home", "outdoor"]),
      consent: z.literal(true),
      idempotencyKey: z.uuid(),
      credits: z.number().int(),
    })
    .parse(await c.req.json());
  if (!c.env.FAL_KEY)
    throw new HTTPException(503, {
      message: "Създаването на варианти временно не е достъпно.",
    });
  const portrait = await ownedAsset(c.env, c.get("user").id, d.portraitId),
    product = await ownedAsset(c.env, c.get("user").id, d.productId);
  if (
    !["portrait", "variant"].includes(portrait.kind) ||
    product.kind !== "product"
  )
    throw new HTTPException(400);
  const credits = mediaCredits("product", 0, d.count);
  if (credits !== d.credits) throw new HTTPException(409);
  const id = await createMediaTask(c.env, c.get("user"), {
    kind: "product",
    source: portrait.id,
    key: d.idempotencyKey,
    credits,
    payload: { ...d, inputs: [portrait.object_key, product.object_key] },
    outputs: d.count,
    outputBytes: 8 * MB,
    outputKind: "variant",
  });
  return c.json({ id }, 202);
});
