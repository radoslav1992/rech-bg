export const MB = 1024 * 1024;
export const mediaPlans: Record<string, { bytes: number; days: number }> = {
  free: { bytes: 100 * MB, days: 7 },
  starter: { bytes: 2 * 1024 * MB, days: 30 },
  creator: { bytes: 10 * 1024 * MB, days: 90 },
  studio: { bytes: 20 * 1024 * MB, days: 180 },
};
export const uploadChunk = 8 * MB;
export const uploadLimit = 500 * MB;
export const maxVideoSeconds = 600;
export function mediaCredits(
  kind: "product" | "transcribe" | "export",
  seconds = 0,
  count = 2,
) {
  if (kind === "product") {
    if (count !== 2 && count !== 4)
      throw new Error("Изберете 2 или 4 варианта.");
    return count * 2500;
  }
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > maxVideoSeconds)
    throw new Error("Видеото трябва да бъде до 10 минути.");
  return Math.ceil(seconds / 60) * (kind === "transcribe" ? 1000 : 500);
}
export type MediaAsset = {
  id: string;
  name: string;
  kind: string;
  mime: string;
  bytes: number;
  status: string;
  duration: number;
  saved: number;
  expires_at: number;
  created_at: number;
  hasCaptions?: boolean;
};
export type MediaTask = {
  id: string;
  kind: string;
  source_id: string;
  credits: number;
  status: string;
  phase: string;
  error: string | null;
  result: string | null;
  created_at: number;
};
export const mediaPhase: Record<string, string> = {
  queued: "На опашка",
  inspecting: "Проверка на видеото",
  transcribing: "Разпознаване на речта",
  rendering: "Вграждане на субтитрите",
  generating: "Създаване на варианти",
  saving: "Запазване",
  completed: "Готово",
  failed: "Неуспешно",
};
