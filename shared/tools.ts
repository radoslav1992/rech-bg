import { maxVideoSeconds } from "./media";

// Provider-backed media tools ("Медийни инструменти"). Prices are per started second of the source video.
export const translateModes = {
  speed: { name: "Бързо", description: "Дублаж с движение на устните", creditsPerSecond: 150 },
  precision: { name: "Прецизно", description: "По-точен превод и по-естествено движение на устните", creditsPerSecond: 300 },
  audio: { name: "Само глас", description: "Дублаж без промяна на картината", creditsPerSecond: 100 },
} as const;
export type TranslateMode = keyof typeof translateModes;
export function translateCredits(seconds: number, mode: TranslateMode) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > maxVideoSeconds) throw new Error("Видеото трябва да бъде до 10 минути.");
  return Math.ceil(seconds) * translateModes[mode].creditsPerSecond;
}
/** Shown first in the language list (the full list comes from the provider). */
export const popularLanguages = ["English", "German", "Spanish", "French", "Italian", "Greek", "Romanian", "Turkish", "Serbian", "Russian", "Ukrainian", "Bulgarian"];
export type AiTask = {
  id: string; kind: "translate" | "lipsync"; status: "queued" | "running" | "completed" | "failed"; phase: string;
  sourceAssetId: string; outputAssetId: string; sourceName: string; language?: string; mode?: TranslateMode | RevoiceMode; voice?: string;
  credits: number; error: string | null; createdAt: number;
};

// "Преозвучаване": new words in a filmed video — a new voice (the speaker's own, cloned, or a studio voice) and
// lips that follow it (HeyGen Lipsync). Lipsync is priced per started second of the longer of video and speech,
// plus the speech itself like studio speech.
export const revoiceModes = {
  speed: { name: "Бързо", description: "Нов глас с движение на устните", creditsPerSecond: 150 },
  precision: { name: "Прецизно", description: "По-естествено движение на устните, по-бавно", creditsPerSecond: 350 },
} as const;
export type RevoiceMode = keyof typeof revoiceModes;
export const REVOICE_MAX_SECONDS = 180, REVOICE_MAX_CHARS = 2500, REVOICE_CREDITS_PER_CHAR = 3;
/** The speaker's own voice, cloned from the video for this one task (and deleted right after). */
export const CLONE_VOICE = "clone";
/** Rough speech length (~13 spoken characters per second). */
export const speechSeconds = (text: string) => Math.round(text.trim().length / 13);
export function revoiceCredits(seconds: number, text: string, mode: RevoiceMode) {
  const chars = text.trim().length;
  if (!Number.isFinite(seconds) || seconds < 3 || seconds > REVOICE_MAX_SECONDS) throw new Error("Видеото трябва да е от 3 секунди до 3 минути.");
  if (!chars || chars > REVOICE_MAX_CHARS) throw new Error(`Текстът трябва да е до ${REVOICE_MAX_CHARS} символа.`);
  // A much longer text would stretch the video far beyond what was filmed.
  if (speechSeconds(text) > seconds * 1.25 + 3) throw new Error("Новият текст е много по-дълъг от видеото. Съкратете го или изберете по-дълго видео.");
  return Math.ceil(Math.max(seconds, speechSeconds(text))) * revoiceModes[mode].creditsPerSecond + chars * REVOICE_CREDITS_PER_CHAR;
}
