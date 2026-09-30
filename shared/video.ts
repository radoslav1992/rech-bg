export const videoTiers = {
  low: { name: "Ниско качество", description: "Бързо и икономично", creditsPerSecond: 150 },
  medium: { name: "Средно качество", description: "По-изразително движение и мимика", creditsPerSecond: 400 },
  high: { name: "Високо качество", description: "Дигитален двойник от ваше видео", creditsPerSecond: 1200 },
} as const;
/** One-time price of turning a photo into a reusable video avatar (HeyGen Photo Avatar). */
export const AVATAR_CREDITS = 10000;
/** Avatars one account can keep. */
export const MAX_USER_AVATARS = 20;
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
