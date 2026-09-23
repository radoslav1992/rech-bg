export type CaptionWord = { text: string; start: number; end: number };
export const captionStyles = ["classic", "bold", "karaoke", "highlight", "pop", "minimal", "neon", "typewriter", "bounce", "outline", "banner", "retro", "underline", "bubble", "wave", "sticker", "fade", "tiles", "luxe", "impact"] as const;
export type CaptionStyle = typeof captionStyles[number];
export type CaptionFormat = "9:16" | "1:1" | "16:9" | "4:5";
export type CaptionDocument = {
  words: CaptionWord[]; style: CaptionStyle; format: CaptionFormat;
  position: "bottom" | "middle" | "top"; enabled: boolean;
  accent?: string; textColor?: string; size?: number; uppercase?: boolean;
  resolution?: "720p" | "1080p"; fit?: "contain" | "cover";
};
export type CaptionLook = Omit<CaptionDocument, "words">;
export const captionPresets: { id: CaptionStyle; name: string; description: string; accent: string; uppercase: boolean }[] = [
  { id: "karaoke", name: "Караоке", description: "Всяка дума получава своя момент", accent: "#c8f560", uppercase: true },
  { id: "highlight", name: "Маркер", description: "Цветен фон следва гласа", accent: "#ffe16b", uppercase: false },
  { id: "bold", name: "Силен глас", description: "Едър текст с ясен контур", accent: "#c8f560", uppercase: true },
  { id: "pop", name: "На фокус", description: "Една дума. Цялото внимание.", accent: "#c8f560", uppercase: true },
  { id: "classic", name: "Класика", description: "Четлив текст върху тъмен фон", accent: "#c8f560", uppercase: false },
  { id: "minimal", name: "Чисто", description: "Дискретен текст, повече картина", accent: "#c8f560", uppercase: false },
  { id: "neon", name: "Неон", description: "Цветен акцент с меко сияние", accent: "#73e8ec", uppercase: true },
  { id: "typewriter", name: "Разкриване", description: "Думите се появяват с разказа", accent: "#c8f560", uppercase: false },
  { id: "bounce", name: "Скок", description: "Активната дума подскача", accent: "#ffd84d", uppercase: true },
  { id: "outline", name: "Контур", description: "Кухи букви, които гласът изпълва", accent: "#c8f560", uppercase: true },
  { id: "banner", name: "Лента", description: "Цветна лента през кадъра", accent: "#ffe16b", uppercase: true },
  { id: "retro", name: "Ретро", description: "Твърда цветна сянка", accent: "#ff5fa2", uppercase: true },
  { id: "underline", name: "Подчертаване", description: "Линия следва всяка дума", accent: "#73e8ec", uppercase: false },
  { id: "bubble", name: "Балон", description: "Текст като в комикс", accent: "#5667f5", uppercase: false },
  { id: "wave", name: "Вълна", description: "Думите се полюшват в ритъм", accent: "#7cf5c4", uppercase: true },
  { id: "sticker", name: "Стикер", description: "Изрязани думи с бял кант", accent: "#ff4d4d", uppercase: true },
  { id: "fade", name: "Плавно", description: "Думите изплуват една по една", accent: "#ffffff", uppercase: false },
  { id: "tiles", name: "Плочки", description: "Всяка дума в своя плочка", accent: "#c8f560", uppercase: true },
  { id: "luxe", name: "Лукс", description: "Елегантен курсив със златен акцент", accent: "#e8c170", uppercase: false },
  { id: "impact", name: "Удар", description: "Една дума върху наклонен етикет", accent: "#ff3b30", uppercase: true },
];
// Dark or white text, whichever reads better on the given colour.
export function readableOn(hex: string) {
  const [r, g, b] = hex.slice(1).match(/.{2}/g)!.map(v => parseInt(v, 16));
  return r * .299 + g * .587 + b * .114 > 150 ? "#111611" : "#ffffff";
}
export const defaultCaptions: CaptionDocument = { words: [], style: "karaoke", format: "9:16", position: "bottom", enabled: true };
export const demoWords: CaptionWord[] = [
  { text: "Всяка", start: 0, end: .65 }, { text: "история", start: .65, end: 1.3 },
  { text: "заслужава", start: 1.3, end: 2 }, { text: "глас.", start: 2, end: 2.8 },
];
export function captionLook(document: CaptionDocument): CaptionLook {
  return {
    style: document.style, format: document.format, position: document.position, enabled: document.enabled,
    accent: document.accent || captionPresets.find(p => p.id === document.style)!.accent,
    textColor: document.textColor || "#ffffff", size: document.size || 1, uppercase: document.uppercase || false,
    resolution: document.resolution || "720p", fit: document.fit || "contain",
  };
}
export function alignmentWords(alignment: { characters: string[]; characterStartTimesSeconds: number[]; characterEndTimesSeconds: number[] } | undefined): CaptionWord[] {
  if (!alignment) return [];
  const { characters, characterStartTimesSeconds: starts, characterEndTimesSeconds: ends } = alignment;
  if (characters.length !== starts.length || characters.length !== ends.length) return [];
  const words: CaptionWord[] = [];
  let word: CaptionWord | null = null, inTag = false;
  const flush = () => { if (word) words.push(word); word = null; };
  for (let i = 0; i < characters.length; i++) {
    const char = characters[i];
    if (!Number.isFinite(starts[i]) || !Number.isFinite(ends[i]) || starts[i] < 0 || ends[i] < starts[i]) return [];
    if (char === "[") { flush(); inTag = true; }
    if (inTag) { if (char === "]") inTag = false; continue; }
    if (/\s/.test(char)) { flush(); continue; }
    if (!word) word = { text: "", start: starts[i], end: ends[i] };
    word.text += char; word.end = ends[i];
  }
  flush();
  return words;
}
export function captionGroups(words: CaptionWord[]) {
  const groups: CaptionWord[][] = [];
  let group: CaptionWord[] = [];
  for (const word of words) {
    if (group.length && (group.length === 4 || word.start - group.at(-1)!.end > 0.8 || group.map(w => w.text).join(" ").length + word.text.length > 38)) {
      groups.push(group); group = [];
    }
    group.push(word);
    if (/[.!?]$/.test(word.text)) { groups.push(group); group = []; }
  }
  if (group.length) groups.push(group);
  return groups;
}
export function subtitleFile(words: CaptionWord[], type: "srt" | "vtt") {
  const time = (n: number) => new Date(Math.round(n * 1000)).toISOString().slice(11, 23).replace(".", type === "srt" ? "," : ".");
  return (type === "vtt" ? "WEBVTT\n\n" : "") + captionGroups(words).map((g, i) =>
    `${i + 1}\n${time(g[0].start)} --> ${time(g.at(-1)!.end)}\n${g.map(w => w.text).join(" ")}\n`).join("\n");
}
