import { BackgroundExport } from "./MediaTools";
import { useEffect, useRef, useState } from "react";
import { Captions, Download } from "lucide-react";
import { api, Button, Notice, type Job } from "./lib";
import { defaultCaptions, subtitleFile, type CaptionDocument } from "../shared/captions";
import { downloadBlob, renderCaptionedVideo } from "./caption-render";
import { CaptionStyles } from "./CaptionStyles";
import { CaptionPreview } from "./CaptionPreview";
import "./captions.css";
export function CaptionEditor({ audioId, video, uploaded = false }: { audioId: string; video: Job | null; uploaded?: boolean }) {
  const [document, setDocument] = useState<CaptionDocument>(defaultCaptions);
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  const [exporting, setExporting] = useState(false), [progress, setProgress] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const endpoint = uploaded ? `/media/assets/${audioId}/captions` : `/video-studio/captions/${audioId}`;
  const url = uploaded ? `/api/media/assets/${audioId}/file` : video ? `/api/jobs/${video.id}/video` : "";
  useEffect(() => { let live = true; setLoaded(false); setError(""); api<CaptionDocument>(endpoint).then(d => { if (live) { setDocument({ ...defaultCaptions, ...d }); setLoaded(true); } }).catch(e => live && setError(e.message)); return () => { live = false; abort.current?.abort(); }; }, [audioId, endpoint]);
  useEffect(() => { if (!exporting) return; const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [exporting]);
  const edit = (change: Partial<CaptionDocument>) => { setDocument(d => ({ ...d, ...change })); setSaved(false); };
  const save = async () => { setError(""); await api(endpoint, { method: "PUT", body: JSON.stringify(document) }); setSaved(true); };
  const render = async () => {
    setError(""); setExporting(true); setProgress(0); abort.current = new AbortController();
    try { await save(); const blob = await renderCaptionedVideo(url, document, setProgress, abort.current.signal); downloadBlob(blob, `rechbg-${(video?.id || audioId)}-${document.format.replace(":", "x")}.mp4`); }
    catch (e) { if (!abort.current.signal.aborted) setError((e as Error).message); }
    finally { setExporting(false); }
  };
  return <section className="vs-card caption-editor"><div className="sub-heading"><h2><Captions size={22} /> Думите вече се виждат.</h2><span>03 / ЕКСПОРТ</span></div>
    <p className="caption-intro">Изберете визия. Направете я своя. Изтеглете видео, готово за публикуване.</p>
    {error && <Notice>{error}</Notice>}
    {!loaded ? <p>Зареждане на субтитрите…</p> : <>
      {!document.words.length && <Notice>За този запис няма автоматични времена. Можете да добавите думите и времената ръчно. Аудиото остава готово.</Notice>}
      <div className="caption-workbench">
        <CaptionPreview document={document} url={url} />
        <div className="caption-options">
          <CaptionStyles document={document} edit={edit} disabled={exporting} />
          <fieldset disabled={exporting} className="caption-output-controls">
            <label>Формат<select value={document.format} onChange={e => edit({ format: e.target.value as CaptionDocument["format"] })}><option value="9:16">9:16 · Reels и TikTok</option><option value="4:5">4:5 · Публикация</option><option value="1:1">1:1 · Квадрат</option><option value="16:9">16:9 · YouTube</option></select></label>
            <label>Позиция<select value={document.position} disabled={!document.enabled} onChange={e => edit({ position: e.target.value as CaptionDocument["position"] })}><option value="bottom">Долу · над бутоните</option><option value="middle">В средата</option><option value="top">Горе</option></select></label>
            <label>Резолюция<select value={document.resolution || "720p"} onChange={e => edit({ resolution: e.target.value as CaptionDocument["resolution"] })}><option>720p</option><option>1080p</option></select></label>
            <label>Кадриране<select value={document.fit || "contain"} onChange={e => edit({ fit: e.target.value as CaptionDocument["fit"] })}><option value="contain">Целият кадър · с полета</option><option value="cover">Запълни · с изрязване</option></select></label>
          </fieldset>
          <p className="caption-output-note">1080p задава размера на експорта. Детайлността зависи от оригиналното видео.</p>
        </div>
      </div>
      <details className="vs-word-editor"><summary>Редактирайте думите и времената ({document.words.length})</summary><p>Времената са в секунди от началото на записа.</p><fieldset disabled={exporting}>
        {document.words.map((word, i) => <div className="vs-word" key={i}><input aria-label={`Дума ${i + 1}`} value={word.text} maxLength={80} onChange={e => edit({ words: document.words.map((w, n) => n === i ? { ...w, text: e.target.value } : w) })} /><input aria-label={`Начало ${i + 1}`} type="number" min="0" step="0.01" value={word.start} onChange={e => edit({ words: document.words.map((w, n) => n === i ? { ...w, start: Number(e.target.value) } : w) })} /><input aria-label={`Край ${i + 1}`} type="number" min="0" step="0.01" value={word.end} onChange={e => edit({ words: document.words.map((w, n) => n === i ? { ...w, end: Number(e.target.value) } : w) })} /><button className="btn" aria-label={`Изтрий дума ${i + 1}`} onClick={() => edit({ words: document.words.filter((_, n) => n !== i) })}>×</button></div>)}
        <button className="btn" onClick={() => { const start = document.words.at(-1)?.end || 0; edit({ words: [...document.words, { text: "Дума", start, end: start + 0.3 }] }); }}>Добави дума</button>
      </fieldset></details>
      {(video || uploaded) && <BackgroundExport sourceId={uploaded ? audioId : video!.id} document={document} onSave={save} />}
      <div className="vs-actions caption-export-actions"><Button className="btn" disabled={exporting} onClick={() => void save().catch(e => setError(e.message))}>{saved ? "Запазено ✓" : "Запази субтитрите"}</Button>{(["srt", "vtt"] as const).map(type => <Button key={type} className="btn" disabled={!document.words.length || exporting} onClick={async () => { try { await save(); downloadBlob(new Blob([subtitleFile(document.words, type)], { type: "text/plain;charset=utf-8" }), `rechbg.${type}`); } catch (e) { setError((e as Error).message); } }}><Download size={16} /> {type.toUpperCase()}</Button>)}
      {(video || uploaded) && <><a className="btn" href={url} download>Оригинален MP4</a><Button className="btn" busy={exporting} onClick={render}><Download size={16} /> {exporting ? `Експорт · ${Math.round(progress * 100)}%` : document.enabled ? "Локален експорт със субтитри" : "Локален експорт без субтитри"}</Button></>}</div>
      {exporting && <div className="caption-export-progress" role="status"><progress value={progress} max={1} aria-label="Експорт на видео" /><span>{Math.round(progress * 100)}% · Вграждаме визията във видеото</span><Button className="btn" onClick={() => abort.current?.abort()}>Спри експорта</Button></div>}
      <p className="vs-fine">Локалният експорт в браузъра е безплатен. Проверете текста преди публикуване. За локален MP4 оставете страницата отворена до завършване; препоръчваме Chrome или Edge на компютър.</p>
    </>}
  </section>;
}
