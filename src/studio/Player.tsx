import { useEffect, useRef, useState } from "react";
import { captionGroups, type CaptionDocument } from "../../shared/captions";
import type { MediaAsset } from "../../shared/media";
import type { ProjectDoc } from "../../shared/project";
import { musicGain, formatTime } from "../../shared/timeline";
import { drawCaptions, fitSource, frameSize } from "../caption-render";
import { drawBackground, drawLayers, mediaUrl, type Visual } from "../layers-render";
import { portraitUrl } from "../project-document";
import { toSourceTime } from "../../shared/cuts";
import { captionId, type SceneMedia, type Segment } from "./model";

export type PlayerInput = {
  doc: ProjectDoc; segments: Segment[]; total: number; media: SceneMedia[];
  captions: Record<string, CaptionDocument>; look: CaptionDocument; assets: MediaAsset[];
  ranges: [number, number][];
};

/** Keeps a media element on the timeline: plays from `local` while active, otherwise parks it there. */
function sync(el: HTMLMediaElement | null | undefined, local: number, duration: number, volume: number, active: boolean) {
  if (!el) return;
  el.volume = Math.min(1, Math.max(0, volume));
  if (active && local >= 0 && local < duration) {
    if (el.paused) { el.currentTime = local; el.playbackRate = 1; void el.play().catch(() => {}); return; }
    // Small drift is corrected by playing a little faster or slower (no audible jump); a large one by seeking.
    const drift = el.currentTime - local;
    if (Math.abs(drift) > .4) { el.currentTime = local; el.playbackRate = 1; }
    else el.playbackRate = Math.abs(drift) < .03 ? 1 : drift > 0 ? .95 : 1.05;
  } else {
    if (!el.paused) el.pause();
    if (el.playbackRate !== 1) el.playbackRate = 1;
    const target = Math.min(Math.max(0, local), Math.max(0, duration - .05));
    if (!el.seeking && Number.isFinite(target) && Math.abs(el.currentTime - target) > .04) el.currentTime = target;
  }
}
/** Still downloading what it needs to play on (a broken or missing file never holds the preview). */
const buffering = (el: HTMLMediaElement) => el.readyState < 3 && !el.error && el.networkState === HTMLMediaElement.NETWORK_LOADING;
function placeholder(ctx: CanvasRenderingContext2D, w: number, h: number, text: string) {
  const base = Math.min(w, h);
  ctx.fillStyle = "#30392d"; ctx.beginPath(); ctx.arc(w / 2, h * .4, base * .16, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#abb4a5"; ctx.textAlign = "center"; ctx.font = `600 ${base * .035}px Arial`;
  ctx.fillText(text, w / 2, h * .62); ctx.textAlign = "start";
}

/**
 * Plays the whole project in the browser: intro, every scene (its avatar video or portrait, voice,
 * background, layers and captions) and the outro, with the project music underneath. One animation
 * loop keeps the canvas, the media elements, the playhead and the timecode in step.
 */
export function usePlayer(input: PlayerInput) {
  const [playing, setPlaying] = useState(false);
  // The scene under the playhead: it and the next one load in full; others only their metadata (slow networks).
  const [activeScene, setActiveScene] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null), playhead = useRef<HTMLDivElement>(null), timecode = useRef<HTMLSpanElement>(null);
  const musicEl = useRef<HTMLAudioElement>(null);
  const clock = useRef({ playing: false, base: 0, startedAt: 0 }), time = useRef(0), pxPerSecond = useRef(10);
  const voices = useRef(new Map<string, HTMLMediaElement>());
  const images = useRef(new Map<string, HTMLImageElement>());
  const visuals = useRef(new Map<string, HTMLImageElement | HTMLVideoElement>());
  const live = useRef(input); live.current = input;

  const image = (url: string) => {
    let img = images.current.get(url);
    if (!img) { img = new Image(); img.src = url; images.current.set(url, img); }
    return img.complete && img.naturalWidth ? img : null;
  };
  const visual = (assetId: string): Visual | null => {
    let el = visuals.current.get(assetId);
    if (!el) {
      const mime = live.current.assets.find((a) => a.id === assetId)?.mime;
      if (!mime) return null;
      if (mime.startsWith("video/")) {
        const v = document.createElement("video");
        v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = mediaUrl(assetId);
        el = v;
      } else { el = new Image(); el.src = mediaUrl(assetId); }
      visuals.current.set(assetId, el);
    }
    if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth ? { source: el, width: el.naturalWidth, height: el.naturalHeight } : null;
    return el.readyState >= 2 ? { source: el, width: el.videoWidth, height: el.videoHeight } : null;
  };

  const seek = (t: number) => {
    const next = Math.min(Math.max(0, t), live.current.total);
    time.current = next; clock.current.base = next; clock.current.startedAt = performance.now();
  };
  const toggle = () => {
    const c = clock.current;
    if (c.playing) { c.playing = false; c.base = time.current; setPlaying(false); return; }
    if (time.current >= live.current.total - .05) time.current = 0;
    c.playing = true; c.base = time.current; c.startedAt = performance.now(); setPlaying(true);
  };
  const pause = () => { if (clock.current.playing) toggle(); };

  useEffect(() => {
    let frame = 0, stalled = false, stalledSince = 0, lastPaint = 0, lastTime = -1, lastInput: PlayerInput | null = null, lastScene = -1;
    const paint = (now: number) => {
      const { doc, segments, total, media, captions, look, ranges } = live.current, c = clock.current;
      // Paused and nothing changed: repaint only a few times a second (media still loading), not 60 (battery).
      if (!c.playing && live.current === lastInput && time.current === lastTime && now - lastPaint < 300) { frame = requestAnimationFrame(paint); return; }
      lastPaint = now; lastInput = live.current;
      if (c.playing) {
        // While the playing scene's media buffers, the clock waits for it instead of running ahead and seeking.
        // At most 4 s, so media that cannot load never freezes the preview.
        if (stalled && now - stalledSince < 4000) { c.base = time.current; c.startedAt = now; }
        else time.current = c.base + (now - c.startedAt) / 1000;
        if (time.current >= total) { time.current = total; c.playing = false; c.base = total; setPlaying(false); }
      }
      const t = time.current;
      lastTime = t;
      const wasStalled = stalled;
      stalled = false;
      const current = segments.find((s) => t >= s.start && t < s.start + s.length) || segments.at(-1);
      if (current?.kind === "scene" && current.index !== lastScene) { lastScene = current.index; setActiveScene(current.index); }
      // Voices of other scenes are parked; only the scene under the playhead plays.
      for (const seg of segments) {
        if (seg.kind !== "scene" || seg.estimated) continue;
        const scene = doc.scenes[seg.index], el = voices.current.get(scene.id), local = t - seg.start - scene.speechStart;
        if (scene.clip && el) {
          // A filmed scene plays only its kept parts: the cut clip's clock maps onto the source video.
          const source = Number.isFinite(el.duration) ? el.duration : seg.speech;
          const active = c.playing && seg === current && local >= 0 && local < seg.speech;
          sync(el, toSourceTime(Math.min(Math.max(0, local), Math.max(0, seg.speech - .05)), scene.clip.keep), source, scene.voiceVolume, active);
          if (active && buffering(el)) stalled = true;
        } else {
          const active = c.playing && seg === current;
          sync(el, local, seg.speech, scene.voiceVolume, active);
          if (active && el && local >= 0 && local < seg.speech && buffering(el)) stalled = true;
        }
      }
      for (const seg of segments) {
        if (seg.kind !== "bumper" || !seg.video) continue;
        const el = visuals.current.get(seg.assetId);
        if (el instanceof HTMLVideoElement) { el.muted = false; sync(el, t - seg.start, seg.length, 1, c.playing && seg === current); }
      }
      const musicDuration = musicEl.current && Number.isFinite(musicEl.current.duration) ? musicEl.current.duration : total;
      const settings = { speechStart: 0, tail: 0, voiceVolume: 1, music: doc.music };
      sync(musicEl.current, doc.music ? t - doc.music.start : -1, musicDuration, musicGain(t, settings, ranges, musicDuration, total), c.playing && !!doc.music);
      const el = canvas.current;
      if (el) {
        const [w, h] = frameSize(look.format);
        if (el.width !== w || el.height !== h) { el.width = w; el.height = h; }
        const ctx = el.getContext("2d")!;
        if (!current) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h); }
        else if (current.kind === "bumper") {
          ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
          const v = visual(current.assetId);
          // Intro and outro fill the frame, as in the render.
          if (v) fitSource(ctx, v.source, v.width, v.height, w, h, "cover");
        } else {
          const scene = doc.scenes[current.index], m = media[current.index], local = t - current.start;
          const bg = scene.background;
          drawBackground(ctx, w, h, bg, bg?.type === "image" ? visual(bg.assetId) : null);
          const voice = voices.current.get(scene.id), still = scene.portrait ? image(portraitUrl(scene.portrait)) : null;
          if (voice instanceof HTMLVideoElement && voice.readyState >= 2) fitSource(ctx, voice, voice.videoWidth, voice.videoHeight, w, h, look.fit);
          else if (still) fitSource(ctx, still, still.naturalWidth, still.naturalHeight, w, h, look.fit);
          else if (scene.clip) placeholder(ctx, w, h, current.estimated ? "Видеото се проверява…" : "Зареждане на видеото…");
          else if (!scene.portrait) placeholder(ctx, w, h, "Изберете аватар");
          for (const l of scene.layers) {
            if (l.type !== "broll") continue;
            const v = visuals.current.get(l.assetId);
            if (v instanceof HTMLVideoElement) sync(v, local - l.start + l.trim, Number.isFinite(v.duration) ? v.duration : 0, 0, c.playing && local >= l.start && local < l.end);
          }
          drawLayers(ctx, w, h, local, scene.layers, (l) => (l.type === "text" ? null : visual(l.assetId)));
          const id = captionId(scene, m), words = id ? captions[id] : null;
          if (words && !current.estimated) drawCaptions(ctx, w, h, local - scene.speechStart, words, captionGroups(words.words));
        }
      }
      if (stalled && !wasStalled) stalledSince = now;
      if (playhead.current) playhead.current.style.transform = `translateX(${t * pxPerSecond.current}px)`;
      if (timecode.current) timecode.current.textContent = `${formatTime(t)} / ${formatTime(total)}`;
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    const voiceEls = voices.current, visualEls = visuals.current, music = musicEl;
    return () => {
      cancelAnimationFrame(frame);
      for (const el of voiceEls.values()) el.pause();
      for (const el of visualEls.values()) if (el instanceof HTMLVideoElement) el.pause();
      music.current?.pause();
    };
  }, []);
  useEffect(() => { if (time.current > input.total) seek(input.total); }, [input.total]);

  // Voice (or avatar video with its voice) of every scene that has one; music of the project.
  const { doc, segments, media } = input;
  const elements = <>
    {segments.map((seg) => {
      if (seg.kind !== "scene" || seg.estimated) return null;
      const scene = doc.scenes[seg.index], m = media[seg.index];
      const preload = seg.index === activeScene || seg.index === activeScene + 1 ? "auto" : "metadata";
      const ref = (el: HTMLMediaElement | null) => { if (el) voices.current.set(scene.id, el); else voices.current.delete(scene.id); };
      if (scene.clip) return <video key={`${scene.id}:clip:${scene.clip.assetId}`} ref={ref} src={mediaUrl(scene.clip.assetId)} className="st-media" playsInline preload={preload} aria-hidden="true" />;
      return m.video?.status === "completed"
        ? <video key={`${scene.id}:${m.video.id}`} ref={ref} src={`/api/jobs/${m.video.id}/video`} className="st-media" playsInline preload={preload} aria-hidden="true" />
        : <audio key={`${scene.id}:${m.audio!.id}`} ref={ref} src={`/api/jobs/${m.audio!.id}/audio`} preload={preload} aria-hidden="true" />;
    })}
    {doc.music && <audio key={doc.music.assetId} ref={musicEl} src={mediaUrl(doc.music.assetId)} preload="auto" aria-hidden="true" />}
  </>;
  return { canvas, playhead, timecode, playing, toggle, seek, pause, time, pxPerSecond, elements };
}
export type Player = ReturnType<typeof usePlayer>;
