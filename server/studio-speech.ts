import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { WorkflowStep } from "cloudflare:workers";
import type { Env } from "./types";
import { now } from "./types";
import { wavHeader } from "./audio";
import { alignmentWords, defaultCaptions } from "../shared/captions";
import { stripTags, validateStudioScript } from "../shared/studio";

const providerVoices: Record<string, string> = {
  "studio-boris": "JBFqnCBsd6RMkjVDRZzb", "studio-mila": "EXAVITQu4vr4xnSDxMaL",
  "studio-nikola": "onwK4e9ZLuTAKqWW03F9", "studio-elena": "XB0fDUnXU5powFXDhCwa",
};
export const captionKey = (user: string, id: string) => `audio/${user}/${id}.captions.json`;
export async function runStudioSpeech(env: Env, job: any, step: WorkflowStep) {
  const key = `audio/${job.user_id}/${job.id}.wav`;
  await step.do("studio-speech-once", { retries: { limit: 0, delay: "5 seconds" }, timeout: "5 minutes" }, async () => {
    if (await env.AUDIO.head(key)) return;
    validateStudioScript(job.script);
    const overrides = JSON.parse(env.ELEVENLABS_VOICES || "{}");
    const voice = overrides[job.voice] || providerVoices[job.voice];
    if (!env.ELEVENLABS_API_KEY?.trim() || typeof voice !== "string" || !voice) throw new Error("Studio voice unavailable");
    const claim = await env.DB.prepare("UPDATE jobs SET submitted_at=?,updated_at=? WHERE id=? AND submitted_at IS NULL AND status IN ('queued','running')")
      .bind(now(), now(), job.id).run();
    if (!claim.meta.changes) throw new Error("Studio speech submission already attempted");
    const client = new ElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY?.trim() });
    const result = await client.textToSpeech.convertWithTimestamps(voice, {
      text: job.script, modelId: "eleven_v3", languageCode: "bg", outputFormat: "pcm_24000",
    }, { maxRetries: 0, timeoutInSeconds: 240 });
    if (!result.audioBase64 || result.audioBase64.length > 20_000_000) throw new Error("Invalid studio audio");
    const pcm = Uint8Array.from(atob(result.audioBase64), c => c.charCodeAt(0));
    if (!pcm.length || pcm.length % 2) throw new Error("Invalid studio PCM");
    const audio = new Uint8Array(pcm.length + 44);
    audio.set(wavHeader(pcm.length, 24000)); audio.set(pcm, 44);
    const words = alignmentWords(result.normalizedAlignment || result.alignment);
    // Store timing first. A saved WAV is the durable marker that the paid call completed.
    await env.AUDIO.put(captionKey(job.user_id, job.id), JSON.stringify({ ...defaultCaptions, words }), { httpMetadata: { contentType: "application/json" } });
    await env.AUDIO.put(key, audio, { httpMetadata: { contentType: "audio/wav" }, customMetadata: { duration: String(pcm.length / 48000) } });
  });
  await step.do("studio-caption-timing", { retries: { limit: 0, delay: "5 seconds" }, timeout: "2 minutes" }, async () => {
    // Missing alignment must never discard or regenerate a successfully purchased voice.
    try {
      const saved = await env.AUDIO.get(captionKey(job.user_id, job.id));
      const document = saved ? await new Response(saved.body).json() as any : defaultCaptions;
      if (document.words?.length) return;
      const audio = await env.AUDIO.get(key);
      if (!audio) return;
      const client = new ElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY?.trim() });
      const alignment = await client.forcedAlignment.create({
        file: new File([await new Response(audio.body).arrayBuffer()], "recording.wav", { type: "audio/wav" }),
        text: stripTags(job.script),
      }, { maxRetries: 0, timeoutInSeconds: 90 });
      const words = alignment.words.map(({ text, start, end }) => ({ text, start, end }));
      if (words.some(w => !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < 0 || w.end <= w.start)) return;
      await env.AUDIO.put(captionKey(job.user_id, job.id), JSON.stringify({ ...defaultCaptions, words }), { httpMetadata: { contentType: "application/json" } });
    } catch { console.warn("Studio caption timing unavailable", { jobId: job.id }); }
  });
  await step.do("complete-studio-speech", async () => {
    const audio = await env.AUDIO.head(key);
    if (!audio) throw new Error("Missing studio recording");
    await env.DB.prepare("UPDATE jobs SET status='completed',audio_key=?,duration=?,updated_at=? WHERE id=? AND status IN ('queued','running')")
      .bind(key, Number(audio.customMetadata?.duration) || (audio.size - 44) / 48000, now(), job.id).run();
  });
}
