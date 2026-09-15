import { useEffect, useRef, useState } from "react";
import { Captions, Download } from "lucide-react";
import { api, Button, Notice, type Job } from "./lib";
import { defaultCaptions, subtitleFile, type CaptionDocument } from "../shared/captions";
import { downloadBlob, drawCaptions, frameSize, renderCaptionedVideo } from "./caption-render";
export function CaptionEditor({ audioId, video }: { audioId: string; video: Job | null }) {
  const [document, setDocument] = useState<CaptionDocument>(defaultCaptions);
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  const [exporting, setExporting] = useState(false), [progress, setProgress] = useState(0);
  const abort = useRef<AbortController | null>(null), player = useRef<HTMLVideoElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const url = video ? `/api/jobs/${video.id}/video` : "";
  useEffect(() => { let live = true; setLoaded(false); api<CaptionDocument>(`/video-studio/captions/${audioId}`).then(d => { if (live) { setDocument(d); setLoaded(true); } }).catch(e => live && setError(e.message)); return () => { live = false; abort.current?.abort(); }; }, [audioId]);
  useEffect(() => {
    let frame = 0;
    const paint = () => {
      const v = player.current, c = canvas.current;
      if (v && c) {
        const [w, h] = frameSize(document.format); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        const ctx = c.getContext("2d")!; ctx.fillStyle = "#171d17"; ctx.fillRect(0, 0, w, h);
        if (v.readyState >= 2) {
          const scale = Math.min(w / v.videoWidth, h / v.videoHeight), dw = v.videoWidth * scale, dh = v.videoHeight * scale;
          ctx.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh);
          drawCaptions(ctx, w, h, v.currentTime, document);
        }
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint); return () => cancelAnimationFrame(frame);
  }, [document, url]);
  useEffect(() => { if (!exporting) return; const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [exporting]);
  const edit = (change: Partial<CaptionDocument>) => { setDocument(d => ({ ...d, ...change })); setSaved(false); };
  const save = async () => { setError(""); await api(`/video-studio/captions/${audioId}`, { method: "PUT", body: JSON.stringify(document) }); setSaved(true); };
  const render = async () => {
    setError(""); setExporting(true); setProgress(0); abort.current = new AbortController();
    try { await save(); const blob = await renderCaptionedVideo(url, document, setProgress, abort.current.signal); downloadBlob(blob, `rechbg-${video!.id}-${document.format.replace(":", "x")}.mp4`); }
    catch (e) { if (!abort.current.signal.aborted) setError((e as Error).message); }
    finally { setExporting(false); }
  };
  return <section className="vs-card"><div className="sub-heading"><h2><Captions size={22} /> Субтитри и финален вид</h2><span>03 / ЕКСПОРТ</span></div>
    {error && <Notice>{error}</Notice>}
    {!loaded ? <p>Зареждане на субтитрите…</p> : <>
      {!document.words.length && <Notice>За този запис няма автоматични времена. Можете да добавите думите и времената ръчно. Аудиото остава готово.</Notice>}
      <fieldset disabled={exporting} className="vs-caption-controls">
        <label className="vs-check"><input type="checkbox" checked={document.enabled} onChange={e => edit({ enabled: e.target.checked })} /> Показвай субтитрите</label>
        <label>Визия<select value={document.style} onChange={e => edit({ style: e.target.value as CaptionDocument["style"] })}><option value="classic">Класически · тъмен фон</option><option value="bold">Удебелени · бял текст</option><option value="karaoke">Дума по дума · акцент</option></select></label>
        <label>Формат<select value={document.format} onChange={e => edit({ format: e.target.value as CaptionDocument["format"] })}><option>9:16</option><option>1:1</option><option>16:9</option></select></label>
        <label>Позиция<select value={document.position} onChange={e => edit({ position: e.target.value as CaptionDocument["position"] })}><option value="bottom">Долу, над бутоните на социалните мрежи</option><option value="middle">В средата</option></select></label>
      </fieldset>
      {video && <div className="vs-preview"><canvas ref={canvas} aria-label="Преглед на видеото със субтитри" style={{ aspectRatio: document.format.replace(":", "/") }} /><video ref={player} src={url} controls playsInline preload="metadata" aria-label="Управление на видеото" /><small>Портретът се побира изцяло във формата. При нужда се добавят тъмни полета.</small></div>}
      <details className="vs-word-editor"><summary>Редактирайте думите и времената ({document.words.length})</summary><p>Времената са в секунди от началото на записа.</p><fieldset disabled={exporting}>
        {document.words.map((word, i) => <div className="vs-word" key={i}><input aria-label={`Дума ${i + 1}`} value={word.text} maxLength={80} onChange={e => edit({ words: document.words.map((w, n) => n === i ? { ...w, text: e.target.value } : w) })} /><input aria-label={`Начало ${i + 1}`} type="number" min="0" step="0.01" value={word.start} onChange={e => edit({ words: document.words.map((w, n) => n === i ? { ...w, start: Number(e.target.value) } : w) })} /><input aria-label={`Край ${i + 1}`} type="number" min="0" step="0.01" value={word.end} onChange={e => edit({ words: document.words.map((w, n) => n === i ? { ...w, end: Number(e.target.value) } : w) })} /><button className="btn" aria-label={`Изтрий дума ${i + 1}`} onClick={() => edit({ words: document.words.filter((_, n) => n !== i) })}>×</button></div>)}
        <button className="btn" onClick={() => { const start = document.words.at(-1)?.end || 0; edit({ words: [...document.words, { text: "Дума", start, end: start + 0.3 }] }); }}>Добави дума</button>
      </fieldset></details>
      <div className="vs-actions"><Button className="btn" disabled={exporting} onClick={() => void save().catch(e => setError(e.message))}>{saved ? "Запазено ✓" : "Запази субтитрите"}</Button>{(["srt", "vtt"] as const).map(type => <Button key={type} className="btn" disabled={!document.words.length || exporting} onClick={async () => { try { await save(); downloadBlob(new Blob([subtitleFile(document.words, type)], { type: "text/plain;charset=utf-8" }), `rechbg.${type}`); } catch (e) { setError((e as Error).message); } }}><Download size={16} /> {type.toUpperCase()}</Button>)}
      {video && <><a className="btn" href={url} download>Оригинален MP4</a><Button className="btn primary" busy={exporting} onClick={render}>Експорт MP4 {exporting ? `${Math.round(progress * 100)}%` : "с избраната визия"}</Button></>}</div>
      {exporting && <Button className="btn" onClick={() => abort.current?.abort()}>Спри експорта</Button>}
      <p className="vs-fine">Субтитрите и експортът са включени. Проверете текста преди публикуване. За MP4 оставете страницата отворена до завършване; препоръчваме Chrome или Edge на компютър.</p>
    </>}
  </section>;
}
