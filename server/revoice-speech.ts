import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { Env } from "./types";
import { now } from "./types";
import { resolveStudioVoice } from "./studio-voices";
import { CLONE_VOICE } from "../shared/tools";

// "Преозвучаване" speech: the new text in a studio voice, or in the speaker's own voice cloned from the video
// for this one task (an ElevenLabs instant voice clone, deleted right after; maintenance retries a failed delete).
const client = (env: Env) => new ElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY?.trim() });
const voiceTask = (voiceId: string) => `elevenlabs-voice/${voiceId}`;
const MAX_SPEECH_BYTES = 20 * 1024 * 1024;

export async function speakRevoice(env: Env, o: { taskId: string; voice: string; text: string; sample?: ArrayBuffer }): Promise<ArrayBuffer> {
  if (!env.ELEVENLABS_API_KEY?.trim()) throw new Error("Speech unavailable");
  let voiceId: string, cloned = false;
  if (o.voice === CLONE_VOICE) {
    if (!o.sample) throw new Error("Voice sample missing");
    const created = await client(env).voices.ivc.create({
      name: `Rech BG ${o.taskId}`, files: [new File([o.sample], "sample.mp3", { type: "audio/mpeg" })], removeBackgroundNoise: true,
    }, { maxRetries: 0, timeoutInSeconds: 120 });
    voiceId = created.voiceId;
    cloned = true;
    // Recorded before anything else can fail, so the clone is always removed.
    await env.DB.prepare("INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES (?,?)").bind(voiceTask(voiceId), now()).run();
  } else {
    const { providerVoiceId } = await resolveStudioVoice(env, o.voice, true);
    if (typeof providerVoiceId !== "string" || !providerVoiceId) throw new Error("Studio voice unavailable");
    voiceId = providerVoiceId;
  }
  try {
    const stream = await client(env).textToSpeech.convert(voiceId, {
      text: o.text, modelId: "eleven_v3", outputFormat: "mp3_44100_128",
      // Bulgarian text gets the Bulgarian pronunciation; other languages are detected.
      ...(/[а-яА-Я]/.test(o.text) ? { languageCode: "bg" } : {}),
    }, { maxRetries: 0, timeoutInSeconds: 240 });
    const audio = await new Response(stream).arrayBuffer();
    if (!audio.byteLength || audio.byteLength > MAX_SPEECH_BYTES) throw new Error("Invalid speech");
    return audio;
  } finally {
    if (cloned) await deleteClone(env, voiceId).catch(() => console.error("Voice clone cleanup will retry", { taskId: o.taskId }));
  }
}
async function deleteClone(env: Env, voiceId: string) {
  try { await client(env).voices.delete(voiceId, { maxRetries: 1, timeoutInSeconds: 30 }); }
  catch (e) { if ((e as { statusCode?: number })?.statusCode !== 404) throw e; }
  await env.DB.prepare("DELETE FROM cleanup_tasks WHERE prefix=?").bind(voiceTask(voiceId)).run();
}
/** Maintenance: voice clones whose deletion failed. */
export async function cleanupVoiceClones(env: Env) {
  if (!env.ELEVENLABS_API_KEY?.trim()) return;
  const rows = (await env.DB.prepare("SELECT prefix FROM cleanup_tasks WHERE prefix LIKE 'elevenlabs-voice/%' LIMIT 20").all<{ prefix: string }>()).results;
  for (const r of rows) {
    const id = r.prefix.slice("elevenlabs-voice/".length);
    if (!/^[a-zA-Z0-9]{1,64}$/.test(id)) { await env.DB.prepare("DELETE FROM cleanup_tasks WHERE prefix=?").bind(r.prefix).run(); continue; }
    try { await deleteClone(env, id); } catch { console.error("Voice clone cleanup will retry", { voice: id }); }
  }
}
