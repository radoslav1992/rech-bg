import { useEffect, useMemo, useRef, useState } from "react";
import { Film, Pause, Play } from "lucide-react";
import { captionGroups, demoWords, type CaptionDocument } from "../shared/captions";
import { drawCaptions, fitVideo, frameSize } from "./caption-render";

export function CaptionPreview({ document, url }: { document: CaptionDocument; url: string }) {
  const canvas = useRef<HTMLCanvasElement>(null), player = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(() => !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [failed, setFailed] = useState(false);
  const groups = useMemo(() => captionGroups(url ? document.words : demoWords), [url, document.words]);
  useEffect(() => { setFailed(false); }, [url]);
  useEffect(() => {
    let frame = 0, started = performance.now();
    const paint = (now: number) => {
      const c = canvas.current;
      if (c) {
        const [w, h] = frameSize(document.format);
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#171d17"; ctx.fillRect(0, 0, w, h);
        const v = player.current;
        if (url && v && v.readyState >= 2) {
          fitVideo(ctx, v, w, h, document.fit);
          drawCaptions(ctx, w, h, v.currentTime, document, groups);
        } else if (!url) {
          const base = Math.min(w, h);
          ctx.fillStyle = "#30392d"; ctx.beginPath(); ctx.arc(w / 2, h * .36, base * .15, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#c8f560"; ctx.textAlign = "center"; ctx.font = `800 ${base * .095}px Arial`; ctx.fillText("реч", w / 2, h * .38);
          ctx.fillStyle = "#abb4a5"; ctx.font = `500 ${base * .025}px Arial`; ctx.fillText("ТВОЯТА ИСТОРИЯ. ТВОЯТ СТИЛ.", w / 2, h * .59); ctx.textAlign = "start";
          drawCaptions(ctx, w, h, playing ? ((now - started) / 1000) % 2.8 : .85, { ...document, words: demoWords }, groups);
        }
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint); return () => cancelAnimationFrame(frame);
  }, [document, url, playing, groups]);
  return <div className="caption-preview">
    <div className="caption-preview-top"><span><Film size={14} /> {url ? "Вашето видео" : "Примерна анимация"}</span><b>{document.resolution || "720p"}</b></div>
    <div className="caption-stage"><canvas ref={canvas} aria-label={url ? "Преглед на видеото със субтитри" : "Примерен преглед на стила"} style={{ aspectRatio: document.format.replace(":", "/") }} /></div>
    {url ? <video key={url} ref={player} src={url} controls controlsList="nofullscreen nodownload" disablePictureInPicture playsInline preload="auto" aria-label="Управление на видеото" onLoadedData={e => { const v = e.currentTarget; if (v.currentTime === 0 && document.words.length) v.currentTime = Math.min(document.words[0].start + .02, v.duration || 0); }} onError={() => setFailed(true)} /> : <button type="button" className="caption-demo-toggle" onClick={() => setPlaying(p => !p)}>{playing ? <Pause size={15} /> : <Play size={15} />}{playing ? "Пауза на примера" : "Пусни примера"}</button>}
    <p>{failed ? "Видеото не може да се зареди. Презаредете страницата и опитайте отново." : url ? "Избраната визия се вгражда в MP4 при експорт." : "Изберете визия още сега. Готовото видео ще се появи тук."}</p>
  </div>;
}
