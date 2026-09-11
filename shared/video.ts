export const videoTiers = {
  standard: { name: "Стандартно", creditsPerSecond: 300 },
  quality: { name: "Високо качество", creditsPerSecond: 1200 },
} as const;
export type VideoTier = keyof typeof videoTiers;
export const MIN_VIDEO_SECONDS = 5;
export const MAX_VIDEO_SECONDS = 60;
export function videoCredits(seconds: number, tier: VideoTier) {
  if (!Number.isFinite(seconds) || seconds < MIN_VIDEO_SECONDS || seconds > MAX_VIDEO_SECONDS)
    throw new Error("За видео използвайте запис от 5 до 60 секунди.");
  return Math.ceil(seconds) * videoTiers[tier].creditsPerSecond;
}
export const avatars = [
  { id: "mia", name: "Мия", scene: "На открито" },
  { id: "lara", name: "Лара", scene: "Обучение" },
  { id: "ines", name: "Инес", scene: "Социални мрежи" },
  { id: "maria", name: "Мария", scene: "Обучение" },
  { id: "emma", name: "Ема", scene: "Социални мрежи" },
  { id: "ryan", name: "Раян", scene: "Подкаст студио" },
  { id: "tyler", name: "Тайлър", scene: "Обучение" },
  { id: "paul", name: "Пол", scene: "Обучение" },
  { id: "matteo", name: "Матео", scene: "Социални мрежи" },
  { id: "noemie", name: "Ноеми", scene: "В автомобил" },
] as const;
