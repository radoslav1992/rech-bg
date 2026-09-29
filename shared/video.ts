export const videoTiers = {
  low: { name: "Ниско качество", description: "Икономичен вариант за вашия портрет", creditsPerSecond: 300 },
  medium: { name: "Средно качество", description: "Баланс между детайл и цена", creditsPerSecond: 900 },
  high: { name: "Високо качество", description: "Повече детайл и изразително движение", creditsPerSecond: 1800 },
} as const;
export type VideoTier = keyof typeof videoTiers;
export const MIN_VIDEO_SECONDS = 5;
/** Longest recording for one avatar video (one scene). Longer videos join several scenes. */
export const MAX_VIDEO_SECONDS = 120;
/** Kling AI Avatar v2 Standard (fal) accepts at most 60 s of audio. */
export const KLING_STANDARD_MAX_SECONDS = 60;
export function videoCredits(seconds: number, tier: VideoTier, maxSeconds: number = MAX_VIDEO_SECONDS) {
  if (!Number.isFinite(seconds) || seconds < MIN_VIDEO_SECONDS || seconds > maxSeconds)
    throw new Error(`За видео с това качество използвайте запис от ${MIN_VIDEO_SECONDS} до ${maxSeconds} секунди.`);
  return Math.ceil(seconds) * videoTiers[tier].creditsPerSecond;
}
