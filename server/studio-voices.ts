import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { studioVoices } from "../shared/studio";
import { sha } from "./security";
import type { Env } from "./types";

const providerVoices: Record<string, string> = {
  "studio-boris": "JBFqnCBsd6RMkjVDRZzb", "studio-mila": "EXAVITQu4vr4xnSDxMaL",
  "studio-nikola": "onwK4e9ZLuTAKqWW03F9", "studio-elena": "XB0fDUnXU5powFXDhCwa",
};
export const studioVoiceSchema = z.object({
  name: z.string().trim().min(1).max(40), description: z.string().trim().min(1).max(120),
  providerVoiceId: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
});
export const studioVoiceKey = (id: string) => `config/studio-voices/${id}.json`;
export const isStudioVoice = (id: string) => studioVoices.some(v => v.id === id);
export async function resolveStudioVoice(env: Env, id: string) {
  const defaults = studioVoices.find(v => v.id === id);
  if (!defaults) throw new HTTPException(400, { message: "Невалиден студиен глас." });
  const stored = await env.AUDIO.get(studioVoiceKey(id));
  let source: "admin" | "environment" | "default" = "default";
  let configured;
  if (stored) {
    configured = studioVoiceSchema.parse(await new Response(stored.body).json()); source = "admin";
  } else {
    let override: unknown;
    try { override = JSON.parse(env.ELEVENLABS_VOICES || "{}")[id]; } catch { throw new Error("Invalid studio voice environment configuration"); }
    configured = studioVoiceSchema.parse({ ...defaults, providerVoiceId: override || providerVoices[id] });
    if (override) source = "environment";
  }
  const revision = await sha(configured.providerVoiceId);
  const row = await env.DB.prepare("SELECT object_key,updated_at FROM voice_samples WHERE voice_id=?").bind(id).first<{ object_key: string; updated_at: number }>();
  const sampleUrl = row?.object_key.startsWith(`samples/${id}/${revision}/`)
    ? `/api/voices/${id}/sample?v=${encodeURIComponent(row.object_key)}` : null;
  return { id, ...configured, revision, source, sampleUrl };
}
export async function studioVoiceCatalog(env: Env) {
  return Promise.all(studioVoices.map(v => resolveStudioVoice(env, v.id)));
}
export async function publicStudioVoices(env: Env) {
  return (await studioVoiceCatalog(env)).map(({ id, name, description, sampleUrl }) => ({ id, name, description, sampleUrl }));
}
