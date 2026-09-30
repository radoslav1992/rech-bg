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
  sourceAssetId: string; outputAssetId: string; sourceName: string; language?: string; mode?: TranslateMode;
  credits: number; error: string | null; createdAt: number;
};
