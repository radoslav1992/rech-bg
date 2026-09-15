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
export const isStudioVoice = (id: string) => /^studio-[a-z0-9][a-z0-9-]{0,79}$/.test(id);
export async function resolveStudioVoice(env: Env, id: string, includeRemoved = false) {
  if (!isStudioVoice(id)) throw new HTTPException(400, { message: "Невалиден студиен глас." });
  const defaults = studioVoices.find(v => v.id === id);
  const stored = await env.AUDIO.get(studioVoiceKey(id));
  let source: "admin" | "environment" | "default" = "default";
  let configured;
  let removed = false;
  if (stored) {
    const data = await new Response(stored.body).json() as Record<string, unknown>;
    removed = data.removed === true;
    if (removed && !includeRemoved) throw new HTTPException(400, { message: "Този глас е премахнат. Изберете друг глас." });
    configured = studioVoiceSchema.parse(data); source = "admin";
  } else {
    if (!defaults) throw new HTTPException(400, { message: "Гласът не съществува. Изберете друг глас." });
    let override: unknown;
    try { override = JSON.parse(env.ELEVENLABS_VOICES || "{}")[id]; } catch { throw new Error("Invalid studio voice environment configuration"); }
    configured = studioVoiceSchema.parse({ ...defaults, providerVoiceId: override || providerVoices[id] });
    if (override) source = "environment";
  }
  const revision = await sha(configured.providerVoiceId);
  const row = await env.DB.prepare("SELECT object_key,updated_at FROM voice_samples WHERE voice_id=?").bind(id).first<{ object_key: string; updated_at: number }>();
  const sampleUrl = row?.object_key.startsWith(`samples/${id}/${revision}/`)
    ? `/api/voices/${id}/sample?v=${encodeURIComponent(row.object_key)}` : null;
  return { id, ...configured, revision, source, sampleUrl, removed };
}
export async function studioVoiceCatalog(env: Env) {
  // Keep legacy per-voice settings; discover added voices without a shared index that can lose concurrent writes.
  const ids = new Set<string>(studioVoices.map(v => v.id));
  let cursor: string | undefined;
  do {
    const page = await env.AUDIO.list({ prefix: "config/studio-voices/", cursor });
    for (const object of page.objects) {
      const id = object.key.slice("config/studio-voices/".length).replace(/\.json$/, "");
      if (object.key.endsWith(".json") && isStudioVoice(id)) ids.add(id);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const voices = await Promise.all([...ids].map(id => resolveStudioVoice(env, id, true)));
  return voices.filter(v => !v.removed);
}
export async function publicStudioVoices(env: Env) {
  return (await studioVoiceCatalog(env)).map(({ id, name, description, sampleUrl }) => ({ id, name, description, sampleUrl }));
}
