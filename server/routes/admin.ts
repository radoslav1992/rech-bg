import type { Env, ContextVars } from "../types";
import { Hono } from "hono";
import { adminAvatars } from "../avatars";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { isStudioVoice, resolveStudioVoice, studioVoiceCatalog, studioVoiceKey, studioVoiceSchema } from "../studio-voices";
import { HTTPException } from "hono/http-exception";
import { sampleSentence } from "../../shared/catalog";
import { uid, now } from "../types";
import { rate } from "../security";
import { isAdmin } from "../auth";
import { voiceMap, TTS_MODEL, decodeAudio, wavHeader } from "../audio";
/** Admin-only routes: avatar library, contact messages, studio voices and voice samples. */
export const admin = new Hono<{ Bindings: Env; Variables: ContextVars }>();
admin.use("/api/admin/*", async (c, next) => {
  if (!isAdmin(c.env, c.get("user")))
    throw new HTTPException(403, { message: "Нямате достъп." });
  await next();
});
admin.route("/api/admin/avatars", adminAvatars);
admin.get("/api/admin/messages", async (c) =>
  c.json({
    messages: (
      await c.env.DB.prepare(
        "SELECT * FROM contact_messages ORDER BY created_at DESC, rowid DESC LIMIT 100",
      ).all()
    ).results,
  }),
);
admin.get("/api/admin/studio-voices", async c => c.json({
  enabled: !!c.env.ELEVENLABS_API_KEY?.trim(), voices: await studioVoiceCatalog(c.env),
}));
admin.post("/api/admin/studio-voices", async c => {
  await rate(c, "studio-voice-create", 60, 3600, c.get("user").id);
  const configuration = studioVoiceSchema.parse(await c.req.json());
  const id = `studio-${uid()}`;
  await c.env.AUDIO.put(studioVoiceKey(id), JSON.stringify(configuration), { httpMetadata: { contentType: "application/json" } });
  return c.json({ voice: await resolveStudioVoice(c.env, id) }, 201);
});
admin.put("/api/admin/studio-voices/:id", async c => {
  const id = c.req.param("id");
  await resolveStudioVoice(c.env, id);
  const configuration = studioVoiceSchema.parse(await c.req.json());
  await c.env.AUDIO.put(studioVoiceKey(id), JSON.stringify(configuration), { httpMetadata: { contentType: "application/json" } });
  return c.json({ voice: await resolveStudioVoice(c.env, id) });
});
admin.delete("/api/admin/studio-voices/:id", async c => {
  const id = c.req.param("id"), voice = await resolveStudioVoice(c.env, id, true);
  // A tombstone prevents built-in voices from reappearing. Keep the mapping for already-queued jobs.
  await c.env.AUDIO.put(studioVoiceKey(id), JSON.stringify({ ...studioVoiceSchema.parse(voice), removed: true }), { httpMetadata: { contentType: "application/json" } });
  return c.json({ ok: true });
});
admin.post("/api/admin/voices/:id/sample/generate", async (c) => {
  const id = c.req.param("id");
  if (!Object.hasOwn(voiceMap, id) && !isStudioVoice(id))
    throw new HTTPException(400, { message: "Невалиден глас." });
  await rate(c, "sample-generation", 60, 3600, c.get("user").id);
  if (isStudioVoice(id)) {
    if (!c.env.ELEVENLABS_API_KEY?.trim()) throw new HTTPException(503, { message: "Добавете ELEVENLABS_API_KEY в Cloudflare, за да генерирате примери." });
    const voice = await resolveStudioVoice(c.env, id);
    try {
      const client = new ElevenLabsClient({ apiKey: c.env.ELEVENLABS_API_KEY.trim() });
      const result = await client.textToSpeech.convertWithTimestamps(voice.providerVoiceId, {
        text: sampleSentence, modelId: "eleven_v3", languageCode: "bg", outputFormat: "pcm_24000",
      }, { maxRetries: 0, timeoutInSeconds: 90 });
      if (!result.audioBase64 || result.audioBase64.length > 3_000_000) throw new Error("Invalid sample");
      const pcm = Uint8Array.from(atob(result.audioBase64), c => c.charCodeAt(0));
      if (!pcm.length || pcm.length % 2 || pcm.length + 44 > 2 * 1024 * 1024) throw new Error("Invalid sample size");
      const wav = new Uint8Array(pcm.length + 44); wav.set(wavHeader(pcm.length, 24000)); wav.set(pcm, 44);
      return new Response(wav, { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-Voice-Revision": voice.revision } });
    } catch {
      throw new HTTPException(502, { message: "Примерът не беше създаден. Проверете Voice ID, достъпа до гласа и наличните кредити в ElevenLabs." });
    }
  }
  try {
    const result = (await c.env.AI.run(TTS_MODEL, {
      text: sampleSentence,
      voice: voiceMap[id],
    })) as { audio?: string };
    if (!result?.audio) throw new Error("Missing audio");
    const { pcm, rate: sampleRate } = decodeAudio(result.audio);
    if (pcm.length + 44 > 2 * 1024 * 1024)
      throw new Error("Sample too large");
    const wav = new Uint8Array(pcm.length + 44);
    wav.set(wavHeader(pcm.length, sampleRate));
    wav.set(pcm, 44);
    return new Response(wav, {
      headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
    });
  } catch {
    throw new HTTPException(502, {
      message: "Примерът не беше създаден. Опитайте отново след малко.",
    });
  }
});
admin.post("/api/admin/voices/:id/sample", async (c) => {
  const id = c.req.param("id");
  if (!Object.hasOwn(voiceMap, id) && !isStudioVoice(id))
    throw new HTTPException(400, { message: "Невалиден глас." });
  const form = await c.req.formData();
  const studioVoice = isStudioVoice(id) ? await resolveStudioVoice(c.env, id) : null;
  if (studioVoice && form.get("voiceRevision") !== studioVoice.revision)
    throw new HTTPException(409, { message: "Гласът е променен. Презаредете настройките и създайте нов пример." });
  const file = form.get("file");
  if (!(file instanceof File) || file.size > 2 * 1024 * 1024 || file.size < 44)
    throw new HTTPException(400, {
      message: "Качете WAV или MP3 файл до 2 MB.",
    });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  const wav =
    tag === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE";
  const mp3 =
    tag.startsWith("ID3") || (bytes[0] === 255 && (bytes[1] & 224) === 224);
  if (!wav && !mp3)
    throw new HTTPException(400, {
      message: "Невалиден аудио файл. Използвайте WAV или MP3.",
    });
  const mime = wav ? "audio/wav" : "audio/mpeg",
    key = studioVoice ? `samples/${id}/${studioVoice.revision}/${crypto.randomUUID()}.${wav ? "wav" : "mp3"}` : `samples/${id}.${wav ? "wav" : "mp3"}`;
  const old = await c.env.DB.prepare(
    "SELECT object_key FROM voice_samples WHERE voice_id=?",
  )
    .bind(id)
    .first<{ object_key: string }>();
  await c.env.AUDIO.put(key, bytes, { httpMetadata: { contentType: mime } });
  await c.env.DB.prepare(
    "INSERT INTO voice_samples(voice_id,object_key,mime,updated_at) VALUES (?,?,?,?) ON CONFLICT(voice_id) DO UPDATE SET object_key=excluded.object_key,mime=excluded.mime,updated_at=excluded.updated_at",
  )
    .bind(id, key, mime, now())
    .run();
  if (old && old.object_key !== key) await c.env.AUDIO.delete(old.object_key);
  return c.json({ ok: true });
});
admin.delete("/api/admin/voices/:id/sample", async (c) => {
  const row = await c.env.DB.prepare(
    "DELETE FROM voice_samples WHERE voice_id=? RETURNING object_key",
  )
    .bind(c.req.param("id"))
    .first<{ object_key: string }>();
  if (row) await c.env.AUDIO.delete(row.object_key);
  return c.json({ ok: true });
});
