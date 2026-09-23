import { BackgroundExport } from "./MediaTools";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Captions, Download, Film, Image as ImageIcon, Mic, Music, Pause, Play, SkipBack, Trash2, Upload, ZoomIn, ZoomOut } from "lucide-react";
import { api, Button, Notice, useAuth, type Job } from "./lib";
import { captionGroups, defaultCaptions, subtitleFile, type CaptionDocument } from "../shared/captions";
import { downloadBlob, drawCaptions, fitSource, frameSize } from "./caption-render";
import { CaptionStyles } from "./CaptionStyles";
import { exportTimeline } from "./timeline-export";
import {
  clampMusicStart, formatTime, loadTimeline, MAX_LEAD, MAX_TAIL, moveWords, musicGain, readLocalFile, removeLocalFile,
  saveTimeline, speechRanges, timelineLength, writeLocalFile, type TimelineSettings,
} from "./timeline";
import "./captions.css";
import "./timeline.css";

type Selection = { kind: "speech" } | { kind: "music" } | { kind: "caption"; group: number };
type Wave = { duration: number; peaks: number[] };
const MAX_MUSIC_BYTES = 50 * 1024 * 1024;

async function waveform(blob: Blob, bins = 400): Promise<Wave> {
  const buffer = await new OfflineAudioContext(1, 1, 22050).decodeAudioData(await blob.arrayBuffer());
  const data = buffer.getChannelData(0), size = Math.max(1, Math.floor(data.length / bins)), peaks: number[] = [];
  for (let b = 0; b < bins; b++) {
    let max = 0;
    for (let i = b * size, end = Math.min(data.length, i + size); i < end; i += 16) max = Math.max(max, Math.abs(data[i]));
    peaks.push(max);
  }
  const top = Math.max(.01, ...peaks);
  return { duration: buffer.duration, peaks: peaks.map(p => p / top) };
}
function WaveShape({ wave }: { wave: Wave | null }) {
  if (!wave) return null;
  const n = wave.peaks.length;
  const d = wave.peaks.map((p, i) => `M${i} ${50 - p * 46}V${50 + p * 46}`).join("");
  return <svg className="tl-wave" viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden="true"><path d={d} /></svg>;
}
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

export function TimelineEditor({ audio, video, pendingVideo, portraitUrl }: { audio: Job; video: Job | null; pendingVideo: Job | null; portraitUrl: string }) {
  const { user } = useAuth();
  const speechDuration = audio.duration;
  const endpoint = `/video-studio/captions/${audio.id}`, voiceUrl = `/api/jobs/${audio.id}/audio`, videoUrl = video ? `/api/jobs/${video.id}/video` : "";
  const musicKey = `music:${user!.id}:${audio.id}`;
  const [document, setDocument] = useState<CaptionDocument>(defaultCaptions);
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(""), [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [settings, setSettings] = useState<TimelineSettings>(() => loadTimeline(user!.id, audio.id));
  const [music, setMusic] = useState<Blob | null>(null), [musicUrl, setMusicUrl] = useState(""), [musicWave, setMusicWave] = useState<Wave | null>(null);
  const [voiceWave, setVoiceWave] = useState<Wave | null>(null);
  const [playing, setPlaying] = useState(false), [selection, setSelection] = useState<Selection>({ kind: "speech" }), [panel, setPanel] = useState<"clip" | "captions" | "format">("clip");
  const [zoom, setZoom] = useState(1), [laneWidth, setLaneWidth] = useState(800);
  const [exporting, setExporting] = useState(false), [progress, setProgress] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null), voiceEl = useRef<HTMLMediaElement | null>(null), musicEl = useRef<HTMLAudioElement>(null);
  const tracks = useRef<HTMLDivElement>(null), playhead = useRef<HTMLDivElement>(null), timecode = useRef<HTMLSpanElement>(null), musicInput = useRef<HTMLInputElement>(null);
  const portrait = useRef<HTMLImageElement | null>(null), abort = useRef<AbortController | null>(null), pending = useRef<CaptionDocument | null>(null);
  const clock = useRef({ playing: false, base: 0, startedAt: 0 }), time = useRef(0);
  const length = timelineLength(settings, speechDuration);
  const groups = useMemo(() => captionGroups(document.words), [document.words]);
  const groupStarts = useMemo(() => { let n = 0; return groups.map(g => { const s = n; n += g.length; return s; }); }, [groups]);
  const ranges = useMemo(() => speechRanges(document.words, settings, speechDuration), [document.words, settings, speechDuration]);
  const pxPerSecond = Math.max(8, laneWidth / Math.max(1, length)) * zoom;
  const pxRef = useRef(pxPerSecond); pxRef.current = pxPerSecond;
  const live = useRef({ document, settings, groups, ranges, length, musicDuration: 0 });
  live.current = { document, settings, groups, ranges, length, musicDuration: musicWave?.duration || length };

  // Captions come from the server (shared with SRT/VTT and background export); edits autosave.
  useEffect(() => {
    let alive = true;
    api<CaptionDocument>(endpoint).then(d => { if (alive) { setDocument({ ...defaultCaptions, ...d }); setLoaded(true); } }).catch(e => alive && setError(e.message));
    return () => {
      alive = false; abort.current?.abort();
      // Leaving the editor still saves the last caption edit.
      if (pending.current) void api(endpoint, { method: "PUT", body: JSON.stringify(pending.current) }).catch(() => {});
      pending.current = null;
    };
  }, [endpoint]);
  const persist = async (doc: CaptionDocument) => {
    pending.current = null; setSaveState("saving");
    try { await api(endpoint, { method: "PUT", body: JSON.stringify(doc) }); setSaveState(pending.current ? "dirty" : "saved"); }
    catch (e) { setSaveState("error"); setError((e as Error).message); throw e; }
  };
  const edit = (change: Partial<CaptionDocument>) => {
    setDocument(d => { const next = { ...d, ...change }; pending.current = next; return next; });
    setSaveState("dirty"); setError("");
  };
  useEffect(() => {
    if (!pending.current) return;
    const timer = window.setTimeout(() => { if (pending.current) void persist(pending.current).catch(() => {}); }, 1200);
    return () => window.clearTimeout(timer);
  }, [document]);
  useEffect(() => { saveTimeline(user!.id, audio.id, settings); }, [settings, user, audio.id]);
  const change = (fn: (s: TimelineSettings) => TimelineSettings) => setSettings(s => fn(s));

  // Waveforms for the voice and the (local-only) music track.
  useEffect(() => {
    let alive = true;
    fetch(voiceUrl, { credentials: "same-origin" }).then(r => r.ok ? r.blob() : Promise.reject()).then(b => waveform(b)).then(w => alive && setVoiceWave(w)).catch(() => {});
    return () => { alive = false; };
  }, [voiceUrl]);
  useEffect(() => {
    let alive = true;
    if (!settings.music) return;
    readLocalFile(musicKey).then(file => {
      if (!alive) return;
      if (file instanceof Blob) setMusic(file);
      else { change(s => ({ ...s, music: null })); setError("Музиката за този проект не е запазена в този браузър. Добавете я отново."); }
    });
    return () => { alive = false; };
  }, [musicKey]);
  useEffect(() => {
    if (!music) { setMusicUrl(""); setMusicWave(null); return; }
    const url = URL.createObjectURL(music); setMusicUrl(url);
    let alive = true;
    waveform(music).then(w => alive && setMusicWave(w)).catch(() => alive && setError("Музикалният файл не може да се прочете. Изберете MP3, WAV или M4A файл."));
    return () => { alive = false; URL.revokeObjectURL(url); };
  }, [music]);
  useEffect(() => {
    if (!portraitUrl) { portrait.current = null; return; }
    const img = new Image(); img.src = portraitUrl; portrait.current = img;
  }, [portraitUrl]);
  useEffect(() => {
    const el = tracks.current; if (!el) return;
    const observer = new ResizeObserver(() => setLaneWidth(Math.max(240, el.clientWidth - (window.innerWidth <= 600 ? 78 : 112) - 26)));
    observer.observe(el); return () => observer.disconnect();
  }, [loaded]);
  useEffect(() => { if (!exporting) return; const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [exporting]);

  const seek = (t: number) => {
    const next = Math.min(Math.max(0, t), live.current.length);
    time.current = next; clock.current.base = next; clock.current.startedAt = performance.now();
  };
  const toggle = () => {
    const c = clock.current;
    if (c.playing) { c.playing = false; c.base = time.current; setPlaying(false); return; }
    if (time.current >= live.current.length - .05) time.current = 0;
    c.playing = true; c.base = time.current; c.startedAt = performance.now(); setPlaying(true);
  };
  // One loop keeps preview canvas, media elements, playhead and timecode in step.
  useEffect(() => {
    let frame = 0;
    const sync = (el: HTMLMediaElement | null, local: number, duration: number, volume: number, active: boolean) => {
      if (!el) return;
      el.volume = Math.min(1, Math.max(0, volume));
      if (active && local >= 0 && local < duration) {
        if (el.paused) { el.currentTime = local; void el.play().catch(() => {}); }
        else if (Math.abs(el.currentTime - local) > .25) el.currentTime = local;
      } else {
        if (!el.paused) el.pause();
        const target = Math.min(Math.max(0, local), Math.max(0, duration - .05));
        if (!el.seeking && Math.abs(el.currentTime - target) > .04) el.currentTime = target;
      }
    };
    const paint = (now: number) => {
      const { document: doc, settings: s, groups: g, ranges: r, length: len, musicDuration } = live.current, c = clock.current;
      if (c.playing) {
        time.current = c.base + (now - c.startedAt) / 1000;
        if (time.current >= len) { time.current = len; c.playing = false; c.base = len; setPlaying(false); }
      }
      const t = time.current;
      sync(voiceEl.current, t - s.speechStart, speechDuration, s.voiceVolume, c.playing);
      sync(musicEl.current, s.music ? t - s.music.start : -1, musicDuration, musicGain(t, s, r, musicDuration, len), c.playing && !!s.music);
      const el = canvas.current;
      if (el) {
        const [w, h] = frameSize(doc.format);
        if (el.width !== w || el.height !== h) { el.width = w; el.height = h; }
        const ctx = el.getContext("2d")!;
        ctx.fillStyle = "#171d17"; ctx.fillRect(0, 0, w, h);
        const v = voiceEl.current, img = portrait.current;
        if (v instanceof HTMLVideoElement && v.readyState >= 2) fitSource(ctx, v, v.videoWidth, v.videoHeight, w, h, doc.fit);
        else if (img?.complete && img.naturalWidth) fitSource(ctx, img, img.naturalWidth, img.naturalHeight, w, h, doc.fit);
        else {
          const base = Math.min(w, h);
          ctx.fillStyle = "#30392d"; ctx.beginPath(); ctx.arc(w / 2, h * .4, base * .16, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#abb4a5"; ctx.textAlign = "center"; ctx.font = `600 ${base * .035}px Arial`;
          ctx.fillText("Изберете аватар по-горе", w / 2, h * .62); ctx.textAlign = "start";
        }
        drawCaptions(ctx, w, h, t - s.speechStart, doc, g);
      }
      if (playhead.current) playhead.current.style.transform = `translateX(${t * pxRef.current}px)`;
      if (timecode.current) timecode.current.textContent = `${formatTime(t)} / ${formatTime(len)}`;
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => { cancelAnimationFrame(frame); voiceEl.current?.pause(); musicEl.current?.pause(); };
  }, [speechDuration]);
  useEffect(() => { if (time.current > length) seek(length); }, [length]);

  const addMusic = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_MUSIC_BYTES) { setError("Изберете аудиофайл до 50 MB."); return; }
    setError("");
    await writeLocalFile(musicKey, file);
    setMusic(file);
    change(s => ({ ...s, music: { name: file.name, start: 0, volume: s.music?.volume ?? .35, duck: s.music?.duck ?? true, fade: s.music?.fade ?? true } }));
    setSelection({ kind: "music" }); setPanel("clip");
  };
  const removeMusic = () => { void removeLocalFile(musicKey); setMusic(null); change(s => ({ ...s, music: null })); setSelection({ kind: "speech" }); };
  const moveSpeech = (start: number, delta: number) => change(s => ({ ...s, speechStart: Math.round(Math.min(MAX_LEAD, Math.max(0, start + delta)) * 100) / 100 }));
  const moveMusic = (start: number, delta: number) => change(s => s.music ? { ...s, music: { ...s.music, start: clampMusicStart(start + delta, musicWave?.duration || length, length) } } : s);
  const moveGroup = (group: number, words: CaptionDocument["words"], delta: number) =>
    edit({ words: moveWords(words, groupStarts[group], groupStarts[group] + groups[group].length - 1, delta, speechDuration) });

  const render = async () => {
    if (!video) return;
    setError(""); setExporting(true); setProgress(0); abort.current = new AbortController();
    if (clock.current.playing) toggle();
    try {
      await persist(document);
      const blob = await exportTimeline({ document, settings, videoUrl, voiceUrl, music: settings.music ? music : null, speechDuration, onProgress: setProgress, signal: abort.current.signal });
      downloadBlob(blob, `rechbg-${video.id}-${document.format.replace(":", "x")}.mp4`);
    } catch (e) { if (!abort.current.signal.aborted) setError((e as Error).message); }
    finally { setExporting(false); }
  };

  const selectedGroup = selection.kind === "caption" ? groups[selection.group] : undefined;
  const ticks = useMemo(() => {
    const step = pxPerSecond >= 60 ? 1 : pxPerSecond >= 25 ? 2 : pxPerSecond >= 12 ? 5 : 10;
    return Array.from({ length: Math.floor(length / step) + 1 }, (_, i) => i * step);
  }, [length, pxPerSecond]);
  const laneStyle = { width: `${length * pxPerSecond}px` };
  const at = (seconds: number, duration: number) => ({ left: `${seconds * pxPerSecond}px`, width: `${Math.max(2, duration * pxPerSecond)}px` });
  const seekFromLane = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    seek((e.clientX - rect.left) / pxPerSecond);
    const lane = e.currentTarget, move = (ev: PointerEvent) => seek((ev.clientX - rect.left) / pxPerSecond);
    lane.setPointerCapture(e.pointerId);
    lane.addEventListener("pointermove", move);
    lane.addEventListener("pointerup", () => lane.removeEventListener("pointermove", move), { once: true });
  };
  const musicStart = settings.music?.start ?? 0, musicDuration = musicWave?.duration || 0;
  const musicBegin = Math.max(0, musicStart), musicEnd = Math.min(length, musicStart + (musicDuration || length));
  const visualLabel = video ? "Видео аватар" : pendingVideo ? "Видеото се създава" : portraitUrl ? "Портрет" : "Без аватар";

  return <section className="vs-card timeline-editor" onKeyDown={e => { if (e.key === " " && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement)) { e.preventDefault(); toggle(); } }}>
    <div className="sub-heading"><h2><Film size={22} /> Монтаж</h2><span>03 / МОНТАЖ И ЕКСПОРТ</span></div>
    <p className="caption-intro">Подредете гласа, субтитрите и музиката. Докато видеото не е готово, прегледът показва избрания портрет. Всичко се обработва във вашия браузър.</p>
    {error && <Notice>{error}</Notice>}
    {!loaded ? <p>Зареждане на монтажа…</p> : <>
      <div className="tl-workbench">
        <div className="tl-stage">
          <div className="caption-preview-top"><span>{video ? <Film size={14} /> : <ImageIcon size={14} />} {visualLabel}</span><b>{document.format} · {document.resolution || "720p"}</b></div>
          <div className="caption-stage"><canvas ref={canvas} onClick={toggle} aria-label="Преглед на монтажа" style={{ aspectRatio: document.format.replace(":", "/") }} /></div>
          {!video && <p className="tl-stage-note">{pendingVideo ? "Видеото се създава във фонов режим. Дотогава преглеждате с портрета — гласът, субтитрите и музиката са истински." : portraitUrl ? "Това е преглед с портрета. Създайте видео аватар от секцията по-горе, за да се появи движението." : "Изберете аватар по-горе, за да го видите тук. Гласът, субтитрите и музиката вече могат да се подреждат."}</p>}
        </div>
        <div className="tl-panel">
          <div className="caption-tabs" role="group" aria-label="Настройки">
            <button type="button" aria-pressed={panel === "clip"} onClick={() => setPanel("clip")}>Избран клип</button>
            <button type="button" aria-pressed={panel === "captions"} onClick={() => setPanel("captions")}>Визия на субтитрите</button>
            <button type="button" aria-pressed={panel === "format"} onClick={() => setPanel("format")}>Формат</button>
          </div>
          {panel === "clip" && <fieldset disabled={exporting} className="tl-inspector">
            {selection.kind === "speech" && <>
              <h3><Mic size={17} /> Глас и аватар</h3>
              <p>Гласът, картината и субтитрите са свързани. Преместете ги по времевата линия, за да оставите начало само с музика.</p>
              <label>Сила на гласа · {Math.round(settings.voiceVolume * 100)}%<input type="range" min="0" max="1" step=".05" value={settings.voiceVolume} onChange={e => change(s => ({ ...s, voiceVolume: Number(e.target.value) }))} /></label>
              <label>Начало на гласа · {settings.speechStart.toFixed(1)} сек.<input type="range" min="0" max={MAX_LEAD} step=".1" value={settings.speechStart} onChange={e => change(s => ({ ...s, speechStart: Number(e.target.value) }))} /></label>
              <label>Задържане в края · {settings.tail.toFixed(1)} сек.<input type="range" min="0" max={MAX_TAIL} step=".1" value={settings.tail} onChange={e => change(s => ({ ...s, tail: Number(e.target.value) }))} /></label>
            </>}
            {selection.kind === "music" && settings.music && <>
              <h3><Music size={17} /> {settings.music.name}</h3>
              <label>Сила на музиката · {Math.round(settings.music.volume * 100)}%<input type="range" min="0" max="1" step=".05" value={settings.music.volume} onChange={e => change(s => s.music ? { ...s, music: { ...s.music, volume: Number(e.target.value) } } : s)} /></label>
              <label className="checkbox-label"><input type="checkbox" checked={settings.music.duck} onChange={e => change(s => s.music ? { ...s, music: { ...s.music, duck: e.target.checked } } : s)} /> По-тиха музика, докато се говори</label>
              <label className="checkbox-label"><input type="checkbox" checked={settings.music.fade} onChange={e => change(s => s.music ? { ...s, music: { ...s.music, fade: e.target.checked } } : s)} /> Плавно начало и край</label>
              <p>Плъзнете клипа, за да изберете коя част от песента звучи. Музиката остава само на вашето устройство.</p>
              <div className="tl-inline-actions"><button type="button" className="btn" onClick={() => musicInput.current?.click()}><Upload size={15} /> Смени</button><button type="button" className="btn" onClick={removeMusic}><Trash2 size={15} /> Премахни</button></div>
            </>}
            {selectedGroup && selection.kind === "caption" && <>
              <h3><Captions size={17} /> Субтитър {selection.group + 1}</h3>
              <p>{formatTime(selectedGroup[0].start + settings.speechStart)} – {formatTime(selectedGroup.at(-1)!.end + settings.speechStart)} · плъзнете блока, за да го преместите.</p>
              <div className="tl-caption-words">{selectedGroup.map((w, n) => {
                const index = groupStarts[selection.group] + n;
                return <input key={index} aria-label={`Дума ${n + 1}`} value={w.text} maxLength={80} onChange={e => edit({ words: document.words.map((x, i) => i === index ? { ...x, text: e.target.value } : x) })} />;
              })}</div>
              <button type="button" className="btn" onClick={() => { const first = groupStarts[selection.group]; edit({ words: document.words.filter((_, i) => i < first || i >= first + selectedGroup.length) }); setSelection({ kind: "speech" }); }}><Trash2 size={15} /> Изтрий субтитъра</button>
            </>}
          </fieldset>}
          {panel === "captions" && <CaptionStyles document={document} edit={edit} disabled={exporting} />}
          {panel === "format" && <fieldset disabled={exporting} className="caption-output-controls tl-format">
            <label>Формат<select value={document.format} onChange={e => edit({ format: e.target.value as CaptionDocument["format"] })}><option value="9:16">9:16 · Reels и TikTok</option><option value="4:5">4:5 · Публикация</option><option value="1:1">1:1 · Квадрат</option><option value="16:9">16:9 · YouTube</option></select></label>
            <label>Позиция на субтитрите<select value={document.position} disabled={!document.enabled} onChange={e => edit({ position: e.target.value as CaptionDocument["position"] })}><option value="bottom">Долу · над бутоните</option><option value="middle">В средата</option><option value="top">Горе</option></select></label>
            <label>Резолюция<select value={document.resolution || "720p"} onChange={e => edit({ resolution: e.target.value as CaptionDocument["resolution"] })}><option>720p</option><option>1080p</option></select></label>
            <label>Кадриране<select value={document.fit || "contain"} onChange={e => edit({ fit: e.target.value as CaptionDocument["fit"] })}><option value="contain">Целият кадър · с полета</option><option value="cover">Запълни · с изрязване</option></select></label>
          </fieldset>}
        </div>
      </div>

      <div className="tl-transport">
        <button type="button" className="btn" aria-label="Към началото" onClick={() => seek(0)}><SkipBack size={16} /></button>
        <button type="button" className="btn dark tl-play" onClick={toggle}>{playing ? <Pause size={16} /> : <Play size={16} />} {playing ? "Пауза" : "Пусни"}</button>
        <span ref={timecode} className="tl-timecode">0:00.0 / {formatTime(length)}</span>
        <span className="tl-save" role="status">{saveState === "saving" ? "Запазване…" : saveState === "dirty" ? "Незапазени промени" : saveState === "error" ? "Не е запазено" : "Субтитрите са запазени"}</span>
        <div className="tl-zoom"><button type="button" className="btn" aria-label="Намали мащаба" disabled={zoom <= 1} onClick={() => setZoom(z => Math.max(1, z / 1.5))}><ZoomOut size={16} /></button><button type="button" className="btn" aria-label="Увеличи мащаба" disabled={zoom >= 8} onClick={() => setZoom(z => Math.min(8, z * 1.5))}><ZoomIn size={16} /></button></div>
      </div>

      <div className="tl-tracks" ref={tracks}>
        <div className="tl-inner">
        <div ref={playhead} className="tl-playhead" aria-hidden="true" />
        <div className="tl-row tl-ruler-row"><div className="tl-label" /><div className="tl-lane tl-ruler" style={laneStyle} onPointerDown={seekFromLane}>
          {ticks.map(t => <span key={t} style={{ left: `${t * pxPerSecond}px` }}>{formatTime(t).replace(/\.0$/, "")}</span>)}
        </div></div>
        <div className="tl-row"><div className="tl-label"><ImageIcon size={15} /> Картина</div><div className="tl-lane" style={laneStyle} onPointerDown={seekFromLane}>
          {settings.speechStart > 0 && <div className="tl-hold" style={at(0, settings.speechStart)} title="Първият кадър се задържа" />}
          <button type="button" className={`tl-clip tl-visual${selection.kind === "speech" ? " selected" : ""}${video ? " ready" : ""}`} style={{ ...at(settings.speechStart, speechDuration), ...(portraitUrl ? { backgroundImage: `url("${portraitUrl}")` } : {}) }}
            aria-label={`${visualLabel}, начало ${settings.speechStart.toFixed(1)} сек.`} onPointerDown={e => { const s = settings.speechStart; drag(e, pxPerSecond, d => moveSpeech(s, d), () => { setSelection({ kind: "speech" }); setPanel("clip"); }); }}
            onKeyDown={e => { const d = nudge(e); if (d) { e.preventDefault(); moveSpeech(settings.speechStart, d); } }}><span>{video ? <Film size={13} /> : <ImageIcon size={13} />} {visualLabel}</span></button>
          {settings.tail > 0 && <div className="tl-hold" style={at(settings.speechStart + speechDuration, settings.tail)} title="Последният кадър се задържа" />}
        </div></div>
        <div className="tl-row"><div className="tl-label"><Mic size={15} /> Глас</div><div className="tl-lane" style={laneStyle} onPointerDown={seekFromLane}>
          <button type="button" className={`tl-clip tl-voice${selection.kind === "speech" ? " selected" : ""}`} style={at(settings.speechStart, speechDuration)} aria-label={`Глас, ${speechDuration.toFixed(1)} сек.`}
            onPointerDown={e => { const s = settings.speechStart; drag(e, pxPerSecond, d => moveSpeech(s, d), () => { setSelection({ kind: "speech" }); setPanel("clip"); }); }}
            onKeyDown={e => { const d = nudge(e); if (d) { e.preventDefault(); moveSpeech(settings.speechStart, d); } }}><WaveShape wave={voiceWave} /><span>Глас · {speechDuration.toFixed(1)} сек.</span></button>
        </div></div>
        <div className="tl-row"><div className="tl-label"><Captions size={15} /> Субтитри</div><div className="tl-lane" style={laneStyle} onPointerDown={seekFromLane}>
          {!document.words.length && <span className="tl-empty">Няма субтитри. Добавете думи от „Думи и времена“ по-долу.</span>}
          {groups.map((g, i) => <button type="button" key={groupStarts[i]} className={`tl-clip tl-caption${selection.kind === "caption" && selection.group === i ? " selected" : ""}${document.enabled ? "" : " muted"}`}
            style={at(settings.speechStart + g[0].start, g.at(-1)!.end - g[0].start)} title={g.map(w => w.text).join(" ")}
            onPointerDown={e => { const words = document.words; drag(e, pxPerSecond, d => moveGroup(i, words, d), () => { setSelection({ kind: "caption", group: i }); setPanel("clip"); seek(settings.speechStart + g[0].start); }); }}
            onKeyDown={e => { const d = nudge(e); if (d) { e.preventDefault(); moveGroup(i, document.words, d); } }}>{g.map(w => w.text).join(" ")}</button>)}
        </div></div>
        <div className="tl-row"><div className="tl-label"><Music size={15} /> Музика</div><div className="tl-lane" style={laneStyle} onPointerDown={seekFromLane}>
          {settings.music && music ? <button type="button" className={`tl-clip tl-music${selection.kind === "music" ? " selected" : ""}`} style={at(musicBegin, musicEnd - musicBegin)} aria-label={`Музика ${settings.music.name}`}
            onPointerDown={e => { const s = musicStart; drag(e, pxPerSecond, d => moveMusic(s, d), () => { setSelection({ kind: "music" }); setPanel("clip"); }); }}
            onKeyDown={e => { const d = nudge(e); if (d) { e.preventDefault(); moveMusic(musicStart, d); } }}>
            <WaveShape wave={musicWave && musicDuration ? { duration: musicDuration, peaks: musicWave.peaks.slice(Math.floor((musicBegin - musicStart) / musicDuration * musicWave.peaks.length), Math.ceil((musicEnd - musicStart) / musicDuration * musicWave.peaks.length)) } : null} />
            <span><Music size={13} /> {settings.music.name} · {Math.round(settings.music.volume * 100)}%</span></button>
            : <button type="button" className="tl-add" onClick={() => musicInput.current?.click()}><Upload size={14} /> Добави фонова музика</button>}
        </div></div>
        </div>
      </div>
      <input ref={musicInput} type="file" accept="audio/*" hidden style={{ display: "none" }} onChange={e => { void addMusic(e.target.files?.[0]); e.target.value = ""; }} />
      <p className="tl-hint">Плъзгайте клиповете, за да ги подредите. Щракнете върху клип, за да го редактирате. Интервал пуска и спира прегледа; стрелките местят избран клип.</p>

      <details className="vs-word-editor"><summary>Думи и времена ({document.words.length})</summary><p>Времената са в секунди от началото на гласа.</p><fieldset disabled={exporting}>
        {document.words.map((word, i) => <div className="vs-word" key={i}><input aria-label={`Дума ${i + 1}`} value={word.text} maxLength={80} onChange={e => edit({ words: document.words.map((w, n) => n === i ? { ...w, text: e.target.value } : w) })} /><input aria-label={`Начало ${i + 1}`} type="number" min="0" step="0.01" value={word.start} onChange={e => edit({ words: document.words.map((w, n) => n === i ? { ...w, start: Number(e.target.value) } : w) })} /><input aria-label={`Край ${i + 1}`} type="number" min="0" step="0.01" value={word.end} onChange={e => edit({ words: document.words.map((w, n) => n === i ? { ...w, end: Number(e.target.value) } : w) })} /><button className="btn" aria-label={`Изтрий дума ${i + 1}`} onClick={() => edit({ words: document.words.filter((_, n) => n !== i) })}>×</button></div>)}
        <button className="btn" onClick={() => { const start = document.words.at(-1)?.end || 0; edit({ words: [...document.words, { text: "Дума", start, end: Math.min(speechDuration, start + 0.3) }] }); }}>Добави дума</button>
      </fieldset></details>

      <div className="vs-actions caption-export-actions">
        <Button className="btn primary" busy={exporting} disabled={!video} onClick={render}><Download size={16} /> {exporting ? `Експорт · ${Math.round(progress * 100)}%` : "Експортирай MP4"}</Button>
        {(["srt", "vtt"] as const).map(type => <Button key={type} className="btn" disabled={!document.words.length || exporting} onClick={() => downloadBlob(new Blob([subtitleFile(document.words, type)], { type: "text/plain;charset=utf-8" }), `rechbg.${type}`)}><Download size={16} /> {type.toUpperCase()}</Button>)}
        {video && <a className="btn" href={videoUrl} download>Оригинален MP4</a>}
      </div>
      {!video && <p className="vs-fine">Експортът се отключва, когато видео аватарът е готов. Дотогава можете да подготвите субтитрите, музиката и подредбата.</p>}
      {exporting && <div className="caption-export-progress" role="status"><progress value={progress} max={1} aria-label="Експорт на видео" /><span>{Math.round(progress * 100)}% · Сглобяваме видеото, гласа, музиката и субтитрите</span><Button className="btn" onClick={() => abort.current?.abort()}>Спри експорта</Button></div>}
      <p className="vs-fine">Експортът в браузъра е безплатен. Оставете страницата отворена до завършване; препоръчваме Chrome или Edge на компютър.</p>
      {video && <details className="tl-more"><summary>Експорт на сървъра</summary><p className="vs-fine">Фоновият експорт включва само видеото и субтитрите — без музиката и отместванията от монтажа.</p><BackgroundExport sourceId={video.id} document={document} onSave={() => persist(document)} /></details>}
    </>}
    {video ? <video key={videoUrl} ref={el => { voiceEl.current = el; }} src={videoUrl} className="tl-media" playsInline preload="auto" muted={false} aria-hidden="true" />
      : <audio key={voiceUrl} ref={el => { voiceEl.current = el; }} src={voiceUrl} preload="auto" aria-hidden="true" />}
    {musicUrl && <audio ref={musicEl} src={musicUrl} preload="auto" aria-hidden="true" />}
  </section>;
}
