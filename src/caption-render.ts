import { captionGroups, captionPresets, readableOn, type CaptionDocument, type CaptionWord } from "../shared/captions";
export const frameSize = (format: CaptionDocument["format"], resolution: CaptionDocument["resolution"] = "720p") => {
  const edge = resolution === "1080p" ? 1080 : 720;
  return format === "9:16" ? [edge, edge * 16 / 9] : format === "1:1" ? [edge, edge] : format === "4:5" ? [edge, edge * 5 / 4] : [edge * 16 / 9, edge];
};
export function fitVideo(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, width: number, height: number, fit: CaptionDocument["fit"]) {
  fitSource(ctx, video, video.videoWidth, video.videoHeight, width, height, fit);
}
export function fitSource(ctx: CanvasRenderingContext2D, source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, fit: CaptionDocument["fit"]) {
  if (!sourceWidth || !sourceHeight) return;
  const scale = (fit === "cover" ? Math.max : Math.min)(width / sourceWidth, height / sourceHeight);
  const dw = sourceWidth * scale, dh = sourceHeight * scale;
  ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh);
}
export function drawCaptions(ctx: CanvasRenderingContext2D, width: number, height: number, time: number, document: CaptionDocument, groups = captionGroups(document.words)) {
  if (!document.enabled) return;
  const group = groups.find(g => time >= g[0].start && time < g.at(-1)!.end);
  if (!group) return;
  const active = (word: CaptionWord) => time >= word.start && time < word.end;
  const style = document.style, accent = document.accent || captionPresets.find(p => p.id === style)!.accent;
  let words = style === "pop" ? group.filter(active) : style === "typewriter" ? group.filter(w => time >= w.start) : group;
  if (!words.length) return;
  words = words.map(w => ({ ...w, text: document.uppercase ? w.text.toLocaleUpperCase("bg") : w.text }));
  ctx.save();
  const base = Math.min(width, height), maxWidth = width * (style === "bubble" ? .78 : .84);
  let size = base * (style === "minimal" ? .045 : style === "pop" ? .09 : .065) * (document.size || 1);
  if (style === "pop") size *= 1 + .1 * Math.max(0, 1 - (time - words[0].start) / .12);
  const weight = style === "minimal" || style === "classic" ? 600 : style === "bubble" || style === "underline" ? 800 : 900;
  let lines: CaptionWord[][] = [];
  const lineWidth = (line: CaptionWord[]) => ctx.measureText(line.map(w => w.text).join(" ")).width;
  // Wrap into at most two lines and shrink long words to stay inside the frame.
  do {
    ctx.font = `${weight} ${size}px Arial, sans-serif`;
    lines = [[]];
    for (const word of words) {
      const line = lines.at(-1)!;
      if (line.length && lineWidth([...line, word]) > maxWidth) lines.push([word]);
      else line.push(word);
    }
    if (lines.length <= 2 && lines.every(l => lineWidth(l) <= maxWidth)) break;
    size -= 1;
  } while (size > 10);
  const center = height * (document.position === "top" ? .2 : document.position === "middle" ? .5 : .79);
  const lineHeight = size * 1.4, textColor = document.textColor || "#ffffff", dark = "#121612";
  ctx.textBaseline = "middle"; ctx.lineJoin = "round";
  ctx.strokeStyle = dark; ctx.lineWidth = size * .12;
  const onAccent = readableOn(accent);
  const top = center - (lines.length - 1) / 2 * lineHeight;
  if (style === "banner") { ctx.fillStyle = accent; ctx.fillRect(0, top - size * .78, width, (lines.length - 1) * lineHeight + size * 1.56); }
  if (style === "bubble") {
    const wide = Math.max(...lines.map(lineWidth)), left = (width - wide) / 2 - size * .5, bottom = top + (lines.length - 1) * lineHeight + size * .8;
    ctx.fillStyle = "#ffffff"; ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = size * .3; ctx.shadowOffsetY = size * .08;
    ctx.beginPath(); ctx.roundRect(left, top - size * .8, wide + size, bottom - top + size * .8, size * .45);
    ctx.moveTo(width / 2 - size * .35, bottom - 1); ctx.lineTo(width / 2 - size * .55, bottom + size * .45); ctx.lineTo(width / 2 + size * .2, bottom - 1); ctx.fill();
    ctx.shadowColor = "transparent";
  }
  lines.forEach((line, index) => {
    const total = lineWidth(line), y = top + index * lineHeight;
    let x = (width - total) / 2;
    if (style === "classic" || style === "typewriter") {
      ctx.fillStyle = "rgba(15,20,16,.85)";
      ctx.beginPath(); ctx.roundRect(x - size * .3, y - size * .68, total + size * .6, size * 1.36, size * .16); ctx.fill();
    }
    for (const word of line) {
      const selected = active(word), wordWidth = ctx.measureText(word.text).width;
      const progress = Math.min(1, Math.max(0, (time - word.start) / Math.max(.05, word.end - word.start)));
      ctx.save();
      ctx.fillStyle = textColor;
      if (selected && ["karaoke", "pop", "neon", "bounce"].includes(style)) ctx.fillStyle = accent;
      if (style === "highlight" && selected) {
        ctx.fillStyle = accent; ctx.beginPath(); ctx.roundRect(x - size * .1, y - size * .65, wordWidth + size * .2, size * 1.3, size * .12); ctx.fill(); ctx.fillStyle = onAccent;
      } else if (style === "banner") {
        ctx.fillStyle = onAccent; ctx.globalAlpha = selected ? 1 : .55;
      } else if (style === "bubble") {
        ctx.fillStyle = selected ? accent : "#111611";
      } else if (style === "outline") {
        // Hollow letters; the spoken word fills with the accent colour.
        ctx.shadowColor = "#000000"; ctx.shadowBlur = size * .12;
        ctx.lineWidth = size * .16; ctx.strokeStyle = dark; ctx.strokeText(word.text, x, y);
        ctx.shadowColor = "transparent";
        if (!selected) { ctx.lineWidth = size * .07; ctx.strokeStyle = textColor; ctx.strokeText(word.text, x, y); }
        if (!selected) { ctx.restore(); x += wordWidth + ctx.measureText(" ").width; continue; }
        ctx.shadowColor = "transparent"; ctx.fillStyle = accent;
      } else if (style === "retro") {
        ctx.lineWidth = size * .06; ctx.strokeText(word.text, x, y);
        ctx.shadowColor = selected ? dark : accent; ctx.shadowBlur = 0; ctx.shadowOffsetX = ctx.shadowOffsetY = size * (selected ? .1 : .07);
        if (selected) ctx.fillStyle = accent;
      } else if (!["classic", "typewriter"].includes(style)) {
        ctx.shadowColor = style === "neon" && selected ? accent : "#000000";
        ctx.shadowBlur = style === "neon" && selected ? size * .45 : size * .1;
        ctx.shadowOffsetY = size * .03;
        if (style === "bounce" && selected) {
          // Quick lift and settle while the word is spoken.
          const lift = Math.sin(Math.min(1, (time - word.start) / .18) * Math.PI) * .2 + .05, scale = 1.05;
          ctx.translate(x + wordWidth / 2, y - size * lift); ctx.scale(scale, scale); ctx.translate(-(x + wordWidth / 2), -y);
        }
        if (style !== "minimal") ctx.strokeText(word.text, x, y);
      }
      if (style === "underline" && selected) {
        ctx.save(); ctx.shadowColor = "transparent"; ctx.fillStyle = accent;
        ctx.beginPath(); ctx.roundRect(x, y + size * .5, Math.max(size * .3, wordWidth * Math.min(1, progress * 2.5)), size * .18, size * .09); ctx.fill(); ctx.restore();
      }
      ctx.fillText(word.text, x, y); ctx.restore();
      x += wordWidth + ctx.measureText(" ").width;
    }
  });
  ctx.restore();
}
export async function renderCaptionedVideo(url: string, document: CaptionDocument, onProgress: (progress: number) => void, signal: AbortSignal) {
  const { Input, UrlSource, ALL_FORMATS, Output, BufferTarget, Mp4OutputFormat, Conversion } = await import("mediabunny");
  const [width, height] = frameSize(document.format, document.resolution);
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const canvas = window.document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const groups = captionGroups(document.words);
  let conversion: Awaited<ReturnType<typeof Conversion.init>> | undefined;
  const cancel = () => { void conversion?.cancel(); };
  signal.addEventListener("abort", cancel);
  try {
    conversion = await Conversion.init({ input, output, tracks: "primary", video: {
      codec: "avc", bitrate: document.resolution === "1080p" ? 8_000_000 : 4_000_000, width, height, fit: document.fit || "contain", forceTranscode: true,
      process(sample) {
        ctx.fillStyle = "#171d17"; ctx.fillRect(0, 0, width, height);
        sample.draw(ctx, 0, 0, width, height);
        drawCaptions(ctx, width, height, sample.timestamp, document, groups);
        return canvas;
      },
    } });
    if (!conversion.isValid || conversion.discardedTracks.length || !conversion.utilizedTracks.some(t => t.type === "audio"))
      throw new Error("Този браузър не може да експортира видеото със звук. Използвайте актуален Chrome или Edge на компютър. Оригиналът и SRT остават достъпни.");
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    conversion.onProgress = onProgress;
    await conversion.execute();
    if (!target.buffer) throw new Error("Експортът не завърши.");
    return new Blob([target.buffer], { type: "video/mp4" });
  } finally { signal.removeEventListener("abort", cancel); input.dispose(); }
}
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), a = window.document.createElement("a");
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
