import { captionGroups, type CaptionDocument, type CaptionWord } from "../shared/captions";
import { animState, captionTimeline, type CaptionInterval, type CaptionItem, type CaptionText } from "../shared/caption-scene";
import { BASELINE, CAPTION_FAMILIES } from "../shared/caption-fonts";
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
// Captions are drawn from the shared description (shared/caption-scene.ts) that the server render also uses.
const timelines = new WeakMap<CaptionDocument, Map<string, CaptionInterval[]>>();
function timelineOf(document: CaptionDocument, width: number, height: number) {
  let byFrame = timelines.get(document);
  if (!byFrame) { byFrame = new Map(); timelines.set(document, byFrame); }
  const key = `${width}x${height}`;
  let timeline = byFrame.get(key);
  if (!timeline) { timeline = captionTimeline(document, width, height); byFrame.set(key, timeline); }
  return timeline;
}
let fontsRequested = false;
/** The caption fonts (the same files the server renders with); drawing falls back to Arial until they load. */
export function loadCaptionFonts() {
  if (fontsRequested || typeof document === "undefined" || !document.fonts) return;
  fontsRequested = true;
  for (const f of Object.values(CAPTION_FAMILIES)) void document.fonts.load(`${f.italic ? "italic " : ""}${f.weight} 40px "${f.family}"`).catch(() => {});
}
const fontString = (font: CaptionText["font"], size: number) => {
  const f = CAPTION_FAMILIES[font];
  return `${f.italic ? "italic " : ""}${f.weight} ${size}px "${f.family}", Arial, sans-serif`;
};
const hasFilter = typeof CanvasRenderingContext2D !== "undefined" && "filter" in CanvasRenderingContext2D.prototype;
/** The same rounded rectangle the server draws (corner curves with both control points on the corner). */
export function roundedPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.bezierCurveTo(x + w, y, x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
  ctx.bezierCurveTo(x + w, y + h, x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.bezierCurveTo(x, y + h, x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
  ctx.bezierCurveTo(x, y, x, y, x + r, y); ctx.closePath();
}
let scratch: HTMLCanvasElement | null = null;
/** Letters with only their border (hollow): stroked, then the inside cut out, on a scratch canvas. */
function hollowText(ctx: CanvasRenderingContext2D, item: CaptionText, border: NonNullable<CaptionText["border"]>) {
  const font = fontString(item.font, item.size), pad = Math.ceil(border.width * 2 + item.size * .2);
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(item.text).width + pad * 2), h = Math.ceil(item.size * 1.6 + pad * 2);
  scratch ??= document.createElement("canvas");
  if (scratch.width < w) scratch.width = w;
  if (scratch.height < h) scratch.height = h;
  const s = scratch.getContext("2d")!;
  s.clearRect(0, 0, scratch.width, scratch.height);
  s.font = font; s.textAlign = "center"; s.textBaseline = "alphabetic"; s.lineJoin = "round";
  s.lineWidth = border.width * 2; s.strokeStyle = border.color;
  const bx = w / 2, by = h / 2 + item.size * BASELINE;
  s.strokeText(item.text, bx, by);
  s.globalCompositeOperation = "destination-out"; s.fillText(item.text, bx, by); s.globalCompositeOperation = "source-over";
  ctx.globalAlpha *= border.alpha ?? 1;
  ctx.drawImage(scratch, 0, 0, w, h, -w / 2, -h / 2, w, h);
}
export function drawCaptionItem(ctx: CanvasRenderingContext2D, item: CaptionItem, time: number) {
  loadCaptionFonts();
  const a = animState(item, time), alpha = (item.alpha ?? 1) * a.alpha;
  if (alpha <= 0.002) return;
  ctx.save();
  ctx.translate(item.x + a.dx, item.y + a.dy);
  if (item.rotate) ctx.rotate(item.rotate);
  ctx.scale(a.scale * a.sx, a.scale);
  ctx.globalAlpha = alpha;
  if (item.blur) {
    if (hasFilter) ctx.filter = `blur(${item.blur * a.scale}px)`;
    else ctx.globalAlpha *= .6;
  }
  if (item.kind === "box") {
    ctx.fillStyle = item.color;
    roundedPath(ctx, item.fromLeft ? 0 : -item.w / 2, -item.h / 2, item.w, item.h, item.radius); ctx.fill();
  } else if (item.kind === "tail") {
    ctx.fillStyle = item.color; ctx.beginPath();
    item.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath(); ctx.fill();
  } else if (item.fill === null) {
    if (item.border) hollowText(ctx, item, item.border);
  } else {
    ctx.font = fontString(item.font, item.size); ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.lineJoin = "round";
    const y = item.size * BASELINE;
    if (item.border) {
      ctx.save(); ctx.globalAlpha *= item.border.alpha ?? 1;
      ctx.lineWidth = item.border.width * 2; ctx.strokeStyle = item.border.color; ctx.strokeText(item.text, 0, y);
      ctx.restore();
    }
    ctx.globalAlpha *= item.fillAlpha ?? 1; ctx.fillStyle = item.fill; ctx.fillText(item.text, 0, y);
  }
  ctx.restore();
}
export function drawCaptions(ctx: CanvasRenderingContext2D, width: number, height: number, time: number, document: CaptionDocument, _groups?: CaptionWord[][]) {
  if (!document.enabled) return;
  loadCaptionFonts();
  const timeline = timelineOf(document, width, height);
  // Binary search for the interval at `time`.
  let lo = 0, hi = timeline.length - 1, found: CaptionInterval | null = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, interval = timeline[m];
    if (time < interval.start) hi = m - 1;
    else if (time >= interval.end) lo = m + 1;
    else { found = interval; break; }
  }
  if (!found) return;
  const items = [...found.items].sort((a, b) => a.layer - b.layer);
  for (const item of items) drawCaptionItem(ctx, item, time);
}
export async function renderCaptionedVideo(url: string, document: CaptionDocument, onProgress: (progress: number) => void, signal: AbortSignal) {
  const { Input, UrlSource, MP4, QTFF, WEBM, Output, BufferTarget, Mp4OutputFormat, Conversion } = await import("mediabunny");
  const [width, height] = frameSize(document.format, document.resolution);
  const input = new Input({ source: new UrlSource(url), formats: [MP4, QTFF, WEBM] });
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
