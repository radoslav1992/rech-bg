import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Captions, Clapperboard, Layers, Mic, Music, Plus, Upload, ZoomIn, ZoomOut } from "lucide-react";
import { captionGroups, type CaptionDocument } from "../../shared/captions";
import type { MediaAsset } from "../../shared/media";
import { MAX_SCENES, type ProjectDoc } from "../../shared/project";
import { clampMusicStart, formatTime, MAX_LEAD, moveWords } from "../../shared/timeline";
import { layerNames } from "../LayerTools";
import { portraitUrl } from "../project-document";
import { captionId, type SceneMedia, type Segment } from "./model";
import type { Player } from "./Player";

export type Selection =
  | { kind: "scene"; scene: number }
  | { kind: "layer"; scene: number; id: string }
  | { kind: "caption"; scene: number; group: number }
  | { kind: "music" }
  | { kind: "project" };

const LAYER_ROW = 30;
const round = (n: number) => Math.round(n * 100) / 100;
// Pointer drag in seconds, relative to the value captured on pointer down. Short presses count as clicks.
function drag(e: ReactPointerEvent, pxPerSecond: number, move: (seconds: number) => void, click?: () => void) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const el = e.currentTarget as HTMLElement, x0 = e.clientX;
  let moved = false;
  el.setPointerCapture(e.pointerId);
  const onMove = (ev: PointerEvent) => { if (Math.abs(ev.clientX - x0) > 3) moved = true; if (moved) move((ev.clientX - x0) / pxPerSecond); };
  const onUp = () => { el.removeEventListener("pointermove", onMove); el.removeEventListener("pointerup", onUp); el.removeEventListener("pointercancel", onUp); if (!moved) click?.(); };
  el.addEventListener("pointermove", onMove); el.addEventListener("pointerup", onUp); el.addEventListener("pointercancel", onUp);
}
const nudge = (e: ReactKeyboardEvent) => e.key === "ArrowLeft" ? (e.shiftKey ? -1 : -.1) : e.key === "ArrowRight" ? (e.shiftKey ? 1 : .1) : 0;

/**
 * The whole video on one clock: scenes (with the intro and outro), each scene's voice, layers and
 * captions, and the project music. Clips drag along the timeline; a click selects them for the inspector.
 */
export function ProjectTimeline({ doc, segments, total, media, captions, assets, selection, player, musicDuration, musicUpload,
  onSelect, update, editCaptions, onAddScene, onAddMusic }: {
  doc: ProjectDoc; segments: Segment[]; total: number; media: SceneMedia[];
  captions: Record<string, CaptionDocument>; assets: MediaAsset[]; selection: Selection; player: Player;
  musicDuration: number; musicUpload: number | null;
  onSelect: (s: Selection) => void;
  update: (change: (d: ProjectDoc) => ProjectDoc) => void;
  editCaptions: (audioId: string, change: (d: CaptionDocument) => CaptionDocument) => void;
  onAddScene: () => void; onAddMusic: () => void;
}) {
  const [zoom, setZoom] = useState(1), [laneWidth, setLaneWidth] = useState(800);
  const tracks = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = tracks.current; if (!el) return;
    const observer = new ResizeObserver(() => setLaneWidth(Math.max(240, el.clientWidth - (window.innerWidth <= 600 ? 78 : 112) - 60)));
    observer.observe(el); return () => observer.disconnect();
  }, []);
  const length = Math.max(1, total);
  const pxPerSecond = Math.max(6, laneWidth / length) * zoom;
  player.pxPerSecond.current = pxPerSecond;
  const laneStyle = { width: `${length * pxPerSecond + 48}px` };
  const at = (seconds: number, duration: number) => ({ left: `${seconds * pxPerSecond}px`, width: `${Math.max(2, duration * pxPerSecond)}px` });
  const ticks = useMemo(() => {
    const step = pxPerSecond >= 60 ? 1 : pxPerSecond >= 25 ? 2 : pxPerSecond >= 12 ? 5 : pxPerSecond >= 5 ? 10 : 30;
    return Array.from({ length: Math.floor(length / step) + 1 }, (_, i) => i * step);
  }, [length, pxPerSecond]);
  const seekFromLane = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    player.seek((e.clientX - rect.left) / pxPerSecond);
    const lane = e.currentTarget, move = (ev: PointerEvent) => player.seek((ev.clientX - rect.left) / pxPerSecond);
    lane.setPointerCapture(e.pointerId);
    lane.addEventListener("pointermove", move);
    lane.addEventListener("pointerup", () => lane.removeEventListener("pointermove", move), { once: true });
  };
  const scenes = segments.filter((s) => s.kind === "scene");
  const layerRows = Math.max(1, ...doc.scenes.map((s) => s.layers.length));
  const isScene = (i: number) => selection.kind !== "music" && selection.kind !== "project" && selection.scene === i;

  const moveSpeech = (index: number, start: number, delta: number) =>
    update((d) => ({ ...d, scenes: d.scenes.map((s, i) => i === index ? { ...s, speechStart: round(Math.min(MAX_LEAD, Math.max(0, start + delta))) } : s) }));
  const moveLayer = (index: number, sceneLength: number, id: string, start: number, delta: number) => update((d) => ({
    ...d,
    scenes: d.scenes.map((s, i) => i !== index ? s : {
      ...s,
      layers: s.layers.map((l) => {
        if (l.id !== id) return l;
        const duration = l.end - l.start, next = round(Math.min(Math.max(0, start + delta), Math.max(0, sceneLength - duration)));
        return { ...l, start: next, end: round(next + duration) };
      }),
    }),
  }));
  const moveMusic = (start: number, delta: number) =>
    update((d) => d.music ? { ...d, music: { ...d.music, start: clampMusicStart(start + delta, musicDuration || length, length) } } : d);

  const music = doc.music, musicStart = music?.start ?? 0;
  const musicBegin = Math.max(0, musicStart), musicEnd = Math.min(length, musicStart + (musicDuration || length));

  // Space toggles playback anywhere in the timeline; the clips themselves stay native buttons.
  // eslint-disable-next-line jsx-a11y/no-static-element-interactions
  return <div className="st-timeline" onKeyDown={(e) => { if (e.key === " " && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement)) { e.preventDefault(); player.toggle(); } }}>
    <div className="st-timeline-bar">
      <span className="st-timeline-title">Времева линия</span>
      <span className="st-fine">Плъзгайте клиповете · щракнете, за да редактирате · стрелките местят избрания клип</span>
      <div className="tl-zoom">
        <button type="button" className="btn" aria-label="Намали мащаба" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z / 1.5))}><ZoomOut size={16} /></button>
        <button type="button" className="btn" aria-label="Увеличи мащаба" disabled={zoom >= 8} onClick={() => setZoom((z) => Math.min(8, z * 1.5))}><ZoomIn size={16} /></button>
      </div>
    </div>
    <div className="tl-tracks" ref={tracks}>
      <div className="tl-inner">
        <div ref={player.playhead} className="tl-playhead" aria-hidden="true" />
        <div className="tl-row tl-ruler-row"><div className="tl-label" /><div className="tl-lane tl-ruler" style={laneStyle} onPointerDown={seekFromLane}>
          {ticks.map((t) => <span key={t} style={{ left: `${t * pxPerSecond}px` }}>{formatTime(t).replace(/\.0$/, "")}</span>)}
        </div></div>

        <div className="tl-row"><div className="tl-label"><Clapperboard size={15} /> Сцени</div><div className="tl-lane" style={laneStyle} onPointerDown={seekFromLane}>
          {segments.map((seg) => {
            if (seg.kind === "bumper") return <button type="button" key={seg.which} className={`tl-clip st-bumper${selection.kind === "project" ? " selected" : ""}`} style={at(seg.start, seg.length)}
              onClick={() => { onSelect({ kind: "project" }); player.seek(seg.start); }}><span>{seg.which === "intro" ? "Интро" : "Финал"}</span></button>;
            const scene = doc.scenes[seg.index], m = media[seg.index], thumb = portraitUrl(scene.portrait);
            const state = scene.clip ? (seg.estimated ? "Заснето · проверка" : "Заснето ✓") : m.video?.status === "completed" ? "Видео ✓" : m.pendingVideo ? "Видео…" : m.audio?.status === "completed" ? (m.stale ? "Глас · остарял" : "Глас ✓") : m.audio && m.audio.status !== "failed" ? "Глас…" : "Чернова";
            return <button type="button" key={scene.id} className={`tl-clip tl-visual st-scene-clip${isScene(seg.index) ? " selected" : ""}${m.video?.status === "completed" || (scene.clip && !seg.estimated) ? " ready" : ""}`}
              style={{ ...at(seg.start, seg.length), ...(thumb ? { backgroundImage: `url("${thumb}")` } : {}) }}
              aria-label={`Сцена ${seg.index + 1}${scene.title ? ` „${scene.title}“` : ""}, ${state}`}
              onClick={() => { onSelect({ kind: "scene", scene: seg.index }); player.seek(seg.start); }}>
              <span>{seg.index + 1}. {scene.title || `Сцена ${seg.index + 1}`} · {state}</span>
            </button>;
          })}
          <button type="button" className="st-add-scene" style={{ left: `${length * pxPerSecond + 6}px` }} disabled={doc.scenes.length >= MAX_SCENES} aria-label="Добави сцена" onClick={onAddScene}><Plus size={16} /></button>
        </div></div>

        <div className="tl-row"><div className="tl-label"><Mic size={15} /> Глас</div><div className="tl-lane" style={laneStyle} onPointerDown={seekFromLane}>
          {scenes.map((seg) => {
            if (seg.kind !== "scene") return null;
            const scene = doc.scenes[seg.index], start = seg.start + scene.speechStart;
            const select = () => onSelect({ kind: "scene", scene: seg.index });
            if (seg.estimated) return <button type="button" key={scene.id} className="tl-clip st-voice-empty" style={at(start, seg.speech)} onClick={select}>
              <span>{scene.clip ? "Видеото се проверява…" : media[seg.index].audio && media[seg.index].audio!.status !== "failed" ? "Гласът се създава…" : "Още няма глас"}</span></button>;
            return <button type="button" key={scene.id} className={`tl-clip tl-voice${isScene(seg.index) ? " selected" : ""}`} style={at(start, seg.speech)}
              aria-label={`${scene.clip ? "Звук на видеото" : "Глас"} в сцена ${seg.index + 1}, ${seg.speech.toFixed(1)} сек., начало ${scene.speechStart.toFixed(1)} сек.`}
              onPointerDown={(e) => { const s = scene.speechStart; drag(e, pxPerSecond, (d) => moveSpeech(seg.index, s, d), select); }}
              onClick={(e) => { if (e.detail === 0) select(); }}
              onKeyDown={(e) => { const d = nudge(e); if (d) { e.preventDefault(); moveSpeech(seg.index, scene.speechStart, d); } }}>
              <span>{scene.clip ? "Звук от видеото · " : ""}{seg.speech.toFixed(1)} сек.</span></button>;
          })}
        </div></div>

        <div className="tl-row"><div className="tl-label"><Layers size={15} /> Слоеве</div><div className="tl-lane" style={{ ...laneStyle, height: `${layerRows * LAYER_ROW + 8}px` }} onPointerDown={seekFromLane}>
          {!doc.scenes.some((s) => s.layers.length) && <span className="tl-empty">Текст, лого, изображения и B-roll · добавете от панела на сцената.</span>}
          {scenes.flatMap((seg) => {
            if (seg.kind !== "scene") return [];
            return doc.scenes[seg.index].layers.map((l, row) => {
              const name = l.type === "text" ? l.text : assets.find((a) => a.id === l.assetId)?.name || layerNames[l.type];
              const open = () => onSelect({ kind: "layer", scene: seg.index, id: l.id });
              const selected = selection.kind === "layer" && selection.id === l.id;
              return <button type="button" key={l.id} className={`tl-clip tl-layer tl-layer-${l.type}${selected ? " selected" : ""}`}
                style={{ ...at(seg.start + l.start, Math.min(l.end, seg.length) - l.start), top: `${row * LAYER_ROW + 4}px`, bottom: "auto", height: `${LAYER_ROW - 6}px` }}
                aria-label={`${layerNames[l.type]} „${name}“ в сцена ${seg.index + 1}, ${formatTime(l.start)} – ${formatTime(l.end)}`}
                onPointerDown={(e) => { const start = l.start; drag(e, pxPerSecond, (d) => moveLayer(seg.index, seg.length, l.id, start, d), open); }}
                onClick={(e) => { if (e.detail === 0) open(); }}
                onKeyDown={(e) => { const d = nudge(e); if (d) { e.preventDefault(); moveLayer(seg.index, seg.length, l.id, l.start, d); } }}>
                <span>{layerNames[l.type]} · {name}</span></button>;
            });
          })}
        </div></div>

        <div className="tl-row"><div className="tl-label"><Captions size={15} /> Субтитри</div><div className="tl-lane" style={laneStyle} onPointerDown={seekFromLane}>
          {scenes.flatMap((seg) => {
            if (seg.kind !== "scene" || seg.estimated) return [];
            const scene = doc.scenes[seg.index], id = captionId(scene, media[seg.index]), caption = id ? captions[id] : null;
            if (!id || !caption) return [];
            // A filmed clip's captions follow its cuts: they are selected here and edited in the media library.
            const fixed = !!scene.clip;
            const groups = captionGroups(caption.words);
            let first = 0;
            return groups.map((g, i) => {
              const from = first; first += g.length;
              const open = () => { onSelect({ kind: "caption", scene: seg.index, group: i }); player.seek(seg.start + scene.speechStart + g[0].start); };
              const move = (words: CaptionDocument["words"], delta: number) => {
                if (!fixed) editCaptions(id, (d) => ({ ...d, words: moveWords(words, from, from + g.length - 1, delta, seg.speech) }));
              };
              const selected = selection.kind === "caption" && selection.scene === seg.index && selection.group === i;
              return <button type="button" key={`${id}:${from}`} className={`tl-clip tl-caption${selected ? " selected" : ""}${caption.enabled ? "" : " muted"}`}
                style={at(seg.start + scene.speechStart + g[0].start, g.at(-1)!.end - g[0].start)} title={g.map((w) => w.text).join(" ")}
                onPointerDown={fixed ? undefined : (e) => { const words = caption.words; drag(e, pxPerSecond, (d) => move(words, d), open); }}
                onClick={(e) => { if (fixed || e.detail === 0) open(); }}
                onKeyDown={(e) => { const d = nudge(e); if (d) { e.preventDefault(); move(caption.words, d); } }}>{g.map((w) => w.text).join(" ")}</button>;
            });
          })}
        </div></div>

        <div className="tl-row"><div className="tl-label"><Music size={15} /> Музика</div><div className="tl-lane" style={laneStyle} onPointerDown={seekFromLane}>
          {music ? <button type="button" className={`tl-clip tl-music${selection.kind === "music" ? " selected" : ""}`} style={at(musicBegin, musicEnd - musicBegin)} aria-label={`Музика ${music.name}`}
            onPointerDown={(e) => { const s = musicStart; drag(e, pxPerSecond, (d) => moveMusic(s, d), () => onSelect({ kind: "music" })); }}
            onClick={(e) => { if (e.detail === 0) onSelect({ kind: "music" }); }}
            onKeyDown={(e) => { const d = nudge(e); if (d) { e.preventDefault(); moveMusic(musicStart, d); } }}>
            <span><Music size={13} /> {music.name} · {Math.round(music.volume * 100)}%</span></button>
            : <button type="button" className="tl-add" disabled={musicUpload !== null} onClick={onAddMusic}><Upload size={14} /> {musicUpload !== null ? `Качване на музиката · ${musicUpload}%` : "Добави фонова музика"}</button>}
        </div></div>
      </div>
    </div>
  </div>;
}
