import type { CaptionWord } from "../shared/captions";

// Everything on the timeline is edited and rendered in the browser. Caption words keep
// their speech-relative times (the server contract); the voice clip offset is applied on top.
export type TimelineMusic = { name: string; start: number; volume: number; duck: boolean; fade: boolean };
export type TimelineSettings = { speechStart: number; tail: number; voiceVolume: number; music: TimelineMusic | null };
export const defaultTimeline: TimelineSettings = { speechStart: 0, tail: 0, voiceVolume: 1, music: null };
export const MAX_LEAD = 10, MAX_TAIL = 10, DUCK_LEVEL = .3, FADE_IN = 1, FADE_OUT = 1.5;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
const round = (n: number) => Math.round(n * 100) / 100;

export function timelineLength(settings: TimelineSettings, speechDuration: number) {
  return round(settings.speechStart + speechDuration + settings.tail);
}
export function sanitizeTimeline(value: unknown): TimelineSettings {
  const v = (value && typeof value === "object" ? value : {}) as Partial<TimelineSettings>;
  const m = v.music && typeof v.music === "object" ? v.music as Partial<TimelineMusic> : null;
  return {
    speechStart: round(clamp(Number(v.speechStart), 0, MAX_LEAD)), tail: round(clamp(Number(v.tail), 0, MAX_TAIL)),
    voiceVolume: clamp(v.voiceVolume === undefined ? 1 : Number(v.voiceVolume), 0, 1),
    music: m && typeof m.name === "string" ? {
      name: m.name.slice(0, 120), start: round(clamp(Number(m.start), -3600, 3600)), volume: clamp(m.volume === undefined ? .35 : Number(m.volume), 0, 1),
      duck: m.duck !== false, fade: m.fade !== false,
    } : null,
  };
}
// Moves the music clip so at least one second of it stays inside the video.
export function clampMusicStart(start: number, musicDuration: number, length: number) {
  return round(clamp(start, Math.min(0, 1 - musicDuration), Math.max(0, length - 1)));
}
// Moves a caption block without crossing its neighbours or leaving the recording.
export function moveWords(words: CaptionWord[], first: number, last: number, delta: number, speechDuration: number): CaptionWord[] {
  if (first < 0 || last >= words.length || first > last) return words;
  const min = first > 0 ? words[first - 1].end : 0, max = last < words.length - 1 ? words[last + 1].start : speechDuration;
  const d = clamp(delta, min - words[first].start, max - words[last].end);
  return words.map((w, i) => i < first || i > last ? w : { ...w, start: round(w.start + d), end: round(w.end + d) });
}
// Time ranges (timeline seconds) where the voice is audible; music ducks under these.
export function speechRanges(words: CaptionWord[], settings: TimelineSettings, speechDuration: number): [number, number][] {
  const offset = settings.speechStart;
  if (!words.length) return [[offset, offset + speechDuration]];
  const ranges: [number, number][] = [];
  for (const w of words) {
    const last = ranges.at(-1);
    if (last && w.start + offset - last[1] < .6) last[1] = Math.max(last[1], w.end + offset);
    else ranges.push([w.start + offset, w.end + offset]);
  }
  return ranges;
}
// Music loudness (0–1) at a timeline moment. Preview and export share this envelope.
export function musicGain(time: number, settings: TimelineSettings, ranges: [number, number][], musicDuration: number, length: number) {
  const music = settings.music;
  if (!music) return 0;
  const begin = Math.max(0, music.start), end = Math.min(length, music.start + musicDuration);
  if (time < begin || time >= end) return 0;
  let gain = music.volume;
  if (music.fade) gain *= Math.min(1, (time - begin) / FADE_IN, (end - time) / FADE_OUT);
  if (music.duck) {
    const ramp = .3;
    let duck = 0;
    for (const [a, b] of ranges) {
      if (time >= a - ramp && time <= b + ramp) duck = Math.max(duck, Math.min(1, (time - (a - ramp)) / ramp, (b + ramp - time) / ramp));
    }
    gain *= 1 - duck * (1 - DUCK_LEVEL);
  }
  return clamp(gain, 0, 1);
}
export function formatTime(seconds: number) {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

// Per-user, per-recording browser storage. Music never leaves the device.
const settingsKey = (user: string, audio: string) => `rech:timeline:v1:${user}:${audio}`;
export function loadTimeline(user: string, audio: string): TimelineSettings {
  try { return sanitizeTimeline(JSON.parse(localStorage.getItem(settingsKey(user, audio)) || "{}")); } catch { return { ...defaultTimeline }; }
}
export function saveTimeline(user: string, audio: string, settings: TimelineSettings) {
  try { localStorage.setItem(settingsKey(user, audio), JSON.stringify(settings)); } catch { /* storage unavailable */ }
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("rech-timeline", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const db = await database();
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction("files", mode).objectStore("files"));
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }).finally(() => db.close());
  } catch { return undefined; }
}
export const readLocalFile = (key: string) => transact<Blob | string | undefined>("readonly", s => s.get(key));
export const writeLocalFile = (key: string, value: Blob | string) => transact("readwrite", s => s.put(value, key));
export const removeLocalFile = (key: string) => transact("readwrite", s => s.delete(key));
