export type CaptionWord = { text: string; start: number; end: number };
export type CaptionStyle = "classic" | "bold" | "karaoke";
export type CaptionFormat = "9:16" | "1:1" | "16:9";
export type CaptionDocument = { words: CaptionWord[]; style: CaptionStyle; format: CaptionFormat; position: "bottom" | "middle"; enabled: boolean };
export const defaultCaptions: CaptionDocument = { words: [], style: "karaoke", format: "9:16", position: "bottom", enabled: true };
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
