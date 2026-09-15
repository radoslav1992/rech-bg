import { captionGroups, type CaptionDocument } from "../shared/captions";
export const frameSize = (format: CaptionDocument["format"]) => format === "9:16" ? [720, 1280] : format === "1:1" ? [720, 720] : [1280, 720];
export function drawCaptions(ctx: CanvasRenderingContext2D, width: number, height: number, time: number, document: CaptionDocument) {
  if (!document.enabled) return;
  const group = captionGroups(document.words).find(g => time >= g[0].start && time <= g.at(-1)!.end);
  if (!group) return;
  ctx.save();
  let size = Math.min(width * 0.065, height * 0.065);
  const bold = document.style !== "classic";
  ctx.font = `${bold ? 800 : 600} ${size}px Arial, sans-serif`;
  const text = group.map(w => w.text).join(" ");
  while (ctx.measureText(text).width > width * 0.88 && size > 12) { size -= 1; ctx.font = `${bold ? 800 : 600} ${size}px Arial, sans-serif`; }
  const textWidth = ctx.measureText(text).width;
  const y = height * (document.position === "middle" ? 0.5 : 0.79);
  ctx.textBaseline = "middle";
  if (document.style === "classic") {
    ctx.fillStyle = "rgba(15,20,16,0.85)";
    ctx.fillRect((width - textWidth) / 2 - 14, y - size * 0.78, textWidth + 28, size * 1.6);
  }
  let x = (width - textWidth) / 2;
  ctx.lineJoin = "round"; ctx.lineWidth = size * 0.12; ctx.strokeStyle = "#151b15";
  for (const word of group) {
    ctx.fillStyle = document.style === "karaoke" && time >= word.start && time <= word.end ? "#c8f560" : "#ffffff";
    if (bold) ctx.strokeText(word.text, x, y);
    ctx.fillText(word.text, x, y);
    x += ctx.measureText(word.text + " ").width;
  }
  ctx.restore();
}
export async function renderCaptionedVideo(url: string, document: CaptionDocument, onProgress: (progress: number) => void, signal: AbortSignal) {
  const { Input, UrlSource, ALL_FORMATS, Output, BufferTarget, Mp4OutputFormat, Conversion } = await import("mediabunny");
  const [width, height] = frameSize(document.format);
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const canvas = window.document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  let conversion: Awaited<ReturnType<typeof Conversion.init>> | undefined;
  const cancel = () => { void conversion?.cancel(); };
  signal.addEventListener("abort", cancel);
  try {
    conversion = await Conversion.init({ input, output, tracks: "primary", video: {
      codec: "avc", bitrate: 4_000_000, width, height, fit: "contain", forceTranscode: true,
      process(sample) {
        ctx.fillStyle = "#171d17"; ctx.fillRect(0, 0, width, height);
        sample.draw(ctx, 0, 0, width, height);
        drawCaptions(ctx, width, height, sample.timestamp, document);
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
