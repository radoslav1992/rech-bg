export type StudioVoice = { id: string; name: string; description: string; sampleUrl?: string | null };
export const studioVoices = [
  { id: "studio-boris", name: "Борис", description: "Плътен и уверен разказвач" },
  { id: "studio-mila", name: "Мила", description: "Мек и естествен глас" },
  { id: "studio-nikola", name: "Никола", description: "Ясно и спокойно представяне" },
  { id: "studio-elena", name: "Елена", description: "Топъл и изразителен разказ" },
] as const;
export const emotionTags = [
  ["excited", "Вълнение"], ["curious", "Любопитство"],
  ["whispers", "Шепот"], ["laughs", "Смях"],
  ["sighs", "Въздишка"], ["sad", "Тъга"],
  ["calm", "Спокойно"], ["serious", "Сериозно"],
] as const;
export const studioMaxChars = 1500;
export const studioCreditsPerChar = 3;
export const stripTags = (text: string) => text.replace(/\[[^\]]*\]/g, "");
export function validateStudioScript(text: string) {
  if (!stripTags(text).trim() || text.length > studioMaxChars)
    throw new Error(`Сценарият трябва да съдържа текст и да е до ${studioMaxChars} символа, включително таговете.`);
  if (text.replace(/\[[a-z ]+\]/g, "").match(/[\[\]]/) ||
      [...text.matchAll(/\[([^\]]+)\]/g)].some(m => !emotionTags.some(([tag]) => tag === m[1])))
    throw new Error("Използвайте таговете за емоция от лентата над сценария.");
  return text.length * studioCreditsPerChar;
}
export function validateSuggestedDelivery(original: string, suggestion: string) {
  validateStudioScript(suggestion);
  if (stripTags(suggestion) !== stripTags(original))
    throw new Error("Предложението промени думите. Опитайте отново или добавете емоциите ръчно.");
  return suggestion;
}
