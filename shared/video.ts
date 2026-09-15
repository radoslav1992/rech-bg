export const videoTiers = {
  low: { name: "Ниско качество", description: "Икономичен вариант за вашия портрет", creditsPerSecond: 300 },
  medium: { name: "Средно качество", description: "Баланс между детайл и цена", creditsPerSecond: 900 },
  high: { name: "Високо качество", description: "Повече детайл и изразително движение", creditsPerSecond: 1800 },
} as const;
export type VideoTier = keyof typeof videoTiers;
export const MIN_VIDEO_SECONDS = 5;
export const MAX_VIDEO_SECONDS = 60;
export function videoCredits(seconds: number, tier: VideoTier) {
  if (!Number.isFinite(seconds) || seconds < MIN_VIDEO_SECONDS || seconds > MAX_VIDEO_SECONDS)
    throw new Error("За видео използвайте запис от 5 до 60 секунди.");
  return Math.ceil(seconds) * videoTiers[tier].creditsPerSecond;
}
