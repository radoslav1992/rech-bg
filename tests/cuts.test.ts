import { describe, expect, it } from "vitest";
import { autoCuts, cutWords, isFiller, keptDuration, normalizeKeep, toCutTime, toSourceTime } from "../shared/cuts";

const w = (text: string, start: number, end: number) => ({ text, start, end });
const words = [w("Здравейте,", 0.5, 1), w("ъъъ", 1.2, 1.6), w("днес", 1.7, 2), w("ще", 4, 4.2), w("говорим.", 4.3, 4.9)];

describe("Мигновен монтаж", () => {
  it("recognises hesitation sounds but not words", () => {
    expect(["ъъ", "Ммм…", "ъхъ", "Хм,", "uhm", "Ерм", "Ааа", "еее", "ъм"].every(isFiller)).toBe(true);
    expect(["а", "и", "ами", "мама", "е", "ем", "ама", "аха", "хляб"].some(isFiller)).toBe(false);
  });
  it("keeps speech with some air around it and cuts long pauses and fillers", () => {
    const keep = autoCuts(words, 8);
    // Cut points sit on the 1/30 s frame grid (0.38 → 0.366667), so the render cuts picture and sound alike.
    expect(keep).toEqual([[0.366667, 1.2], [1.566667, 2.2], [3.866667, 5.1]]);
    expect(keptDuration(keep, 8)).toBe(2.7);
    // Keeping fillers joins the first phrase; a longer allowed pause keeps the gap after "днес" too.
    expect(autoCuts(words, 8, { maxPause: 0.6, fillers: false })).toEqual([[0.366667, 2.2], [3.866667, 5.1]]);
    expect(autoCuts(words, 8, { maxPause: 3, fillers: true })).toEqual([[0.366667, 5.1]]);
  });
  it("never needs more parts than the render accepts", () => {
    const choppy = Array.from({ length: 400 }, (_, i) => w("дума", i * 1.5, i * 1.5 + 0.3));
    const keep = autoCuts(choppy, 600);
    expect(keep.length).toBeLessThanOrEqual(300);
    expect(keep.at(-1)![1]).toBe(599);
  });
  it("keeps the whole clip when no speech was found", () => {
    expect(autoCuts([], 6)).toEqual([[0, 6]]);
  });
  it("maps times between the source and the cut clip and moves captions", () => {
    const keep: [number, number][] = [[1, 2], [5, 6]];
    expect(toCutTime(1.5, keep)).toBe(0.5);
    expect(toCutTime(3, keep)).toBeNull();
    expect(toCutTime(5.5, keep)).toBe(1.5);
    expect(toSourceTime(1.5, keep)).toBe(5.5);
    expect(toSourceTime(0.2, null)).toBe(0.2);
    expect(cutWords([w("а", 1.2, 1.5), w("б", 3, 3.5), w("в", 5.1, 5.4)], keep)).toEqual([w("а", 0.2, 0.5), w("в", 1.1, 1.4)]);
    // "ъъ" runs from the end of one kept part into the next: it is dropped, not squeezed.
    expect(cutWords([w("ъъ", 1.9, 5.2)], keep)).toEqual([]);
  });
  it("sorts, merges and bounds ranges", () => {
    expect(normalizeKeep([[4, 6], [0, 1], [0.98, 2], [5.5, 9], [7.95, 7.99]], 8)).toEqual([[0, 2], [4, 8]]);
  });
});
