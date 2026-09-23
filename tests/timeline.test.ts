import { describe, expect, it } from "vitest";
import { clampMusicStart, defaultTimeline, DUCK_LEVEL, musicGain, moveWords, sanitizeTimeline, speechRanges, timelineLength } from "../src/timeline";

const words = [
  { text: "Едно", start: 0.2, end: 0.6 }, { text: "две", start: 0.7, end: 1.0 },
  { text: "три", start: 3.0, end: 3.4 }, { text: "четири", start: 3.5, end: 4.0 },
];
const music = { name: "song.mp3", start: 0, volume: .5, duck: true, fade: false };

describe("timeline", () => {
  it("adds the lead-in and tail to the speech length", () => {
    expect(timelineLength({ ...defaultTimeline, speechStart: 2, tail: 1.5 }, 10)).toBe(13.5);
  });
  it("sanitizes stored settings", () => {
    expect(sanitizeTimeline({ speechStart: 99, tail: -4, voiceVolume: 3, music: { name: "a", start: "x", volume: 2 } }))
      .toEqual({ speechStart: 10, tail: 0, voiceVolume: 1, music: { name: "a", start: -3600, volume: 1, duck: true, fade: true } });
    expect(sanitizeTimeline("broken")).toEqual(defaultTimeline);
  });
  it("moves a caption block without overlapping its neighbours or leaving the recording", () => {
    expect(moveWords(words, 2, 3, -5, 5)[2]).toEqual({ text: "три", start: 1.0, end: 1.4 });
    const late = moveWords(words, 2, 3, 5, 5);
    expect(late[3].end).toBe(5); expect(late[2].start).toBe(4);
    expect(moveWords(words, 0, 1, -1, 5)[0].start).toBe(0);
    expect(moveWords(words, 0, 1, .3, 5)[1]).toEqual({ text: "две", start: 1, end: 1.3 });
  });
  it("merges close words into speech ranges shifted by the lead-in", () => {
    expect(speechRanges(words, { ...defaultTimeline, speechStart: 1 }, 5)).toEqual([[1.2, 2], [4, 5]]);
    expect(speechRanges([], { ...defaultTimeline, speechStart: 1 }, 5)).toEqual([[1, 6]]);
  });
  it("ducks music under speech and keeps it silent outside the clip", () => {
    const settings = { ...defaultTimeline, music }, ranges = [[2, 3]] as [number, number][];
    expect(musicGain(0.5, settings, ranges, 30, 10)).toBe(.5);
    expect(musicGain(2.5, settings, ranges, 30, 10)).toBeCloseTo(.5 * DUCK_LEVEL);
    expect(musicGain(2.5, { ...settings, music: { ...music, duck: false } }, ranges, 30, 10)).toBe(.5);
    expect(musicGain(10, settings, ranges, 30, 10)).toBe(0);
    expect(musicGain(1, { ...settings, music: { ...music, start: 2 } }, ranges, 30, 10)).toBe(0);
    expect(musicGain(1, { ...defaultTimeline }, ranges, 30, 10)).toBe(0);
  });
  it("fades music in and out at the clip edges", () => {
    const settings = { ...defaultTimeline, music: { ...music, duck: false, fade: true } };
    expect(musicGain(0.5, settings, [], 30, 10)).toBeCloseTo(.25);
    expect(musicGain(9.25, settings, [], 30, 10)).toBeCloseTo(.25);
    expect(musicGain(5, settings, [], 30, 10)).toBe(.5);
  });
  it("keeps at least a second of music inside the video", () => {
    expect(clampMusicStart(-100, 30, 10)).toBe(-29);
    expect(clampMusicStart(50, 30, 10)).toBe(9);
    expect(clampMusicStart(-2, 30, 10)).toBe(-2);
  });
});
