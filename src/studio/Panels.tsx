import { useEffect, useRef, useState } from "react";
import { Captions, Download, Music, Trash2, Upload } from "lucide-react";
import { Button, Disclosure, Notice } from "../lib";
import { LayerInspector } from "../LayerTools";
import { CaptionStyles } from "../CaptionStyles";
import { BackgroundExport } from "../MediaTools";
import { BrandPanel } from "../BrandPanel";
import { downloadBlob } from "../caption-render";
import { exportTimeline } from "../timeline-export";
import { captionGroups, subtitleFile, type CaptionDocument } from "../../shared/captions";
import type { BrandKit } from "../../shared/brand";
import type { Layer } from "../../shared/layers";
import type { MediaAsset } from "../../shared/media";
import { sceneTimeline, type ProjectDoc } from "../../shared/project";
import { formatTime } from "../../shared/timeline";
import { mediaUrl } from "../layers-render";
import type { SceneMedia, SceneSegment } from "./model";
import type { Selection } from "./ProjectTimeline";

/** The clip selected on the timeline: a layer, a caption block or the music. */
export function ElementInspector({ selection, doc, segment, captions, assets, update, editCaptions, onSelect, onReplaceMusic }: {
  selection: Selection; doc: ProjectDoc; segment: SceneSegment | null; captions: CaptionDocument | null; assets: MediaAsset[];
  update: (change: (d: ProjectDoc) => ProjectDoc) => void;
  editCaptions: (change: (d: CaptionDocument) => CaptionDocument) => void;
  onSelect: (s: Selection) => void; onReplaceMusic: () => void;
}) {
  if (selection.kind === "layer" && segment) {
    const layer = doc.scenes[selection.scene]?.layers.find((l) => l.id === selection.id);
    if (!layer) return <p className="st-fine">Слоят е премахнат.</p>;
    const setLayers = (change: (layers: Layer[]) => Layer[]) =>
      update((d) => ({ ...d, scenes: d.scenes.map((s, i) => i === selection.scene ? { ...s, layers: change(s.layers) } : s) }));
    return <div className="tl-inspector st-inspector-body">
      <p className="st-fine">Сцена {selection.scene + 1} · времената са от началото на сцената.</p>
      <LayerInspector layer={layer} length={segment.length} assets={assets}
        onChange={(next) => setLayers((ls) => ls.map((l) => l.id === next.id ? next : l))}
        onRemove={() => { setLayers((ls) => ls.filter((l) => l.id !== layer.id)); onSelect({ kind: "scene", scene: selection.scene }); }} />
    </div>;
  }
  if (selection.kind === "caption" && captions) {
    const groups = captionGroups(captions.words);
    const group = groups[selection.group];
    if (!group) return <p className="st-fine">Субтитърът е премахнат.</p>;
    const first = groups.slice(0, selection.group).reduce((n, g) => n + g.length, 0);
    const speechStart = doc.scenes[selection.scene].speechStart;
    return <div className="tl-inspector st-inspector-body">
      <h3><Captions size={17} /> Субтитър {selection.group + 1} · сцена {selection.scene + 1}</h3>
      <p>{formatTime(group[0].start + speechStart)} – {formatTime(group.at(-1)!.end + speechStart)} в сцената · плъзнете блока, за да го преместите.</p>
      <div className="tl-caption-words">{group.map((w, n) => {
        const index = first + n;
        return <input key={index} aria-label={`Дума ${n + 1}`} value={w.text} maxLength={80}
          onChange={(e) => editCaptions((d) => ({ ...d, words: d.words.map((x, i) => i === index ? { ...x, text: e.target.value } : x) }))} />;
      })}</div>
      <button type="button" className="btn" onClick={() => { editCaptions((d) => ({ ...d, words: d.words.filter((_, i) => i < first || i >= first + group.length) })); onSelect({ kind: "scene", scene: selection.scene }); }}>
        <Trash2 size={15} /> Изтрий субтитъра</button>
      <label className="checkbox-label"><input type="checkbox" checked={captions.enabled} onChange={(e) => editCaptions((d) => ({ ...d, enabled: e.target.checked }))} /> Субтитри в тази сцена</label>
    </div>;
  }
  if (selection.kind === "music" && doc.music) {
    const music = doc.music;
    const set = (fields: Partial<typeof music>) => update((d) => d.music ? { ...d, music: { ...d.music, ...fields } } : d);
    return <div className="tl-inspector st-inspector-body">
      <h3><Music size={17} /> {music.name}</h3>
      <label>Сила на музиката · {Math.round(music.volume * 100)}%<input type="range" min="0" max="1" step=".05" value={music.volume} onChange={(e) => set({ volume: Number(e.target.value) })} /></label>
      <label className="checkbox-label"><input type="checkbox" checked={music.duck} onChange={(e) => set({ duck: e.target.checked })} /> По-тиха музика, докато се говори</label>
      <label className="checkbox-label"><input type="checkbox" checked={music.fade} onChange={(e) => set({ fade: e.target.checked })} /> Плавно начало и край</label>
      <p>Музиката звучи под цялото видео. Плъзнете клипа, за да изберете коя част от песента звучи.</p>
      <div className="tl-inline-actions">
        <button type="button" className="btn" onClick={onReplaceMusic}><Upload size={15} /> Смени</button>
        <button type="button" className="btn" onClick={() => { update((d) => ({ ...d, music: null })); onSelect({ kind: "project" }); }}><Trash2 size={15} /> Премахни</button>
      </div>
    </div>;
  }
  return <p className="st-fine">Изберете клип от времевата линия — слой, субтитър или музика.</p>;
}

/** Settings of the whole video: frame, caption look, brand, intro and outro, templates. */
export function ProjectPanel({ projectId, doc, look, update, editLook, brand, onSaveBrand, captionSource, sceneLengths, onCaptionsChanged }: {
  projectId: string; doc: ProjectDoc; look: CaptionDocument;
  update: (change: (d: ProjectDoc) => ProjectDoc) => void;
  editLook: (change: Partial<CaptionDocument>) => void;
  brand: BrandKit | null; onSaveBrand: (kit: BrandKit) => Promise<void>;
  captionSource: string | null; sceneLengths: number[]; onCaptionsChanged: () => void;
}) {
  return <div className="st-inspector-body">
    <section className="st-block st-frame">
      <h3>Кадър</h3>
      <label>Формат<select value={look.format} onChange={(e) => editLook({ format: e.target.value as CaptionDocument["format"] })}>
        <option value="9:16">9:16 · Reels и TikTok</option><option value="4:5">4:5 · Публикация</option><option value="1:1">1:1 · Квадрат</option><option value="16:9">16:9 · YouTube</option>
      </select></label>
      <label>Резолюция<select value={look.resolution || "720p"} onChange={(e) => editLook({ resolution: e.target.value as CaptionDocument["resolution"] })}><option>720p</option><option>1080p</option></select></label>
      <label>Кадриране<select value={look.fit || "contain"} onChange={(e) => editLook({ fit: e.target.value as CaptionDocument["fit"] })}>
        <option value="contain">Целият кадър · с полета</option><option value="cover">Запълни · с изрязване</option>
      </select></label>
      <label>Позиция на субтитрите<select value={look.position} onChange={(e) => editLook({ position: e.target.value as CaptionDocument["position"] })}>
        <option value="bottom">Долу · над бутоните</option><option value="middle">В средата</option><option value="top">Горе</option>
      </select></label>
      <label className="checkbox-label"><input type="checkbox" checked={look.enabled} onChange={(e) => editLook({ enabled: e.target.checked })} /> Субтитри във видеото</label>
    </section>
    <Disclosure className="st-block" summary="Визия на субтитрите">
      <p className="st-fine">Важи за всички сцени, включително новите записи.</p>
      <CaptionStyles document={look} edit={editLook} disabled={false} />
    </Disclosure>
    {brand && <Disclosure className="st-block" summary="Бранд, интро, финал и шаблони">
      <BrandPanel kit={brand} onSaveKit={onSaveBrand} projectId={projectId} doc={doc} update={update}
        captionSource={captionSource} sceneLengths={sceneLengths} onCaptionsChanged={onCaptionsChanged} />
    </Disclosure>}
  </div>;
}

/** Final video: the server joins every scene; a one-scene project can also be exported free in the browser. */
export function ExportPanel({ projectId, doc, media, segments, captions, look, onSave }: {
  projectId: string; doc: ProjectDoc; media: SceneMedia[]; segments: SceneSegment[];
  captions: Record<string, CaptionDocument>; look: CaptionDocument; onSave: () => Promise<void>;
}) {
  const [exporting, setExporting] = useState(false), [progress, setProgress] = useState(0), [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  // Closing the dialog stops a browser export instead of leaving it running unseen.
  useEffect(() => () => abort.current?.abort(), []);
  const missing = doc.scenes.map((s, i) => ({ i, s, m: media[i] })).filter(({ m }) => m.audio?.status !== "completed" || m.video?.status !== "completed");
  const single = doc.scenes.length === 1 && !doc.intro && !doc.outro && missing.length === 0;
  const browserExport = async () => {
    const scene = doc.scenes[0], m = media[0], caption = captions[m.audio!.id];
    if (!caption) return;
    setError(""); setExporting(true); setProgress(0); abort.current = new AbortController();
    try {
      await onSave();
      const music = doc.music ? await fetch(mediaUrl(doc.music.assetId)).then((r) => r.ok ? r.blob() : Promise.reject(new Error("Музиката не е налична."))) : null;
      const blob = await exportTimeline({
        document: caption, settings: sceneTimeline(scene, doc.music), videoUrl: `/api/jobs/${m.video!.id}/video`, voiceUrl: `/api/jobs/${m.audio!.id}/audio`,
        music, speechDuration: m.audio!.duration, onProgress: setProgress, signal: abort.current.signal, layers: scene.layers, background: scene.background,
      });
      downloadBlob(blob, `rechbg-${projectId}-${caption.format.replace(":", "x")}.mp4`);
    } catch (e) { if (!abort.current?.signal.aborted) setError((e as Error).message); }
    finally { setExporting(false); }
  };
  const hasVideoBroll = doc.scenes[0].layers.some((l) => l.type === "broll");
  return <div className="st-export">
    {missing.length > 0 ? <>
      <Notice>Финалното видео се отключва, когато всяка сцена има готов глас и видео аватар.</Notice>
      <ul className="st-checklist">{missing.map(({ i, s, m }) => <li key={s.id}>
        <strong>Сцена {i + 1}{s.title ? ` · ${s.title}` : ""}</strong>
        <span>{m.audio?.status !== "completed" ? "няма готов глас" : m.pendingVideo ? "видеото се създава" : "няма видео аватар"}</span>
      </li>)}</ul>
    </> : <BackgroundExport sourceId={projectId} projectId={projectId} document={look} onSave={onSave} />}
    {single && <Disclosure className="tl-more" summary="Безплатен експорт в браузъра">
      <p className="st-fine">Сглобява видеото на вашия компютър — оставете страницата отворена до края. Препоръчваме Chrome или Edge.{hasVideoBroll ? " Видео B-roll се поддържа само при експорта на сървъра." : ""}</p>
      {error && <Notice error>{error}</Notice>}
      <Button className="btn" busy={exporting} onClick={browserExport}><Download size={16} /> {exporting ? `Експорт · ${Math.round(progress * 100)}%` : "Експортирай в браузъра"}</Button>
      {exporting && <Button className="btn" onClick={() => abort.current?.abort()}>Спри</Button>}
    </Disclosure>}
    <h3>Файлове по сцени</h3>
    <ul className="st-files">{segments.map((seg) => {
      const m = media[seg.index], caption = m.audio && captions[m.audio.id];
      return <li key={doc.scenes[seg.index].id}>
        <strong>Сцена {seg.index + 1}</strong>
        {m.audio?.status === "completed" && <a className="btn" href={`/api/jobs/${m.audio.id}/audio`} download>WAV</a>}
        {m.video?.status === "completed" && <a className="btn" href={`/api/jobs/${m.video.id}/video`} download>Видео аватар</a>}
        {caption && caption.words.length > 0 && (["srt", "vtt"] as const).map((type) => <button key={type} type="button" className="btn"
          onClick={() => downloadBlob(new Blob([subtitleFile(caption.words, type)], { type: "text/plain;charset=utf-8" }), `rechbg-scene-${seg.index + 1}.${type}`)}>{type.toUpperCase()}</button>)}
      </li>;
    })}</ul>
  </div>;
}
