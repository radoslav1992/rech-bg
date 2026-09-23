import { captionGroups, type CaptionDocument } from "../shared/captions";
import { drawCaptions, fitSource, frameSize } from "./caption-render";
import { musicGain, speechRanges, timelineLength, type TimelineSettings } from "./timeline";

const FPS = 30, RATE = 48000, BG = "#171d17";
const unsupported = "Този браузър не може да експортира видеото. Използвайте актуален Chrome или Edge на компютър. Оригиналът и SRT остават достъпни.";

async function decode(bytes: ArrayBuffer) {
  return new OfflineAudioContext(2, 1, RATE).decodeAudioData(bytes.slice(0));
}
async function fetchBlob(url: string, signal: AbortSignal) {
  const r = await fetch(url, { signal, credentials: "same-origin" });
  if (!r.ok) throw new Error("Файлът за монтажа не може да се зареди. Опитайте отново.");
  return r.blob();
}
// Voice, music, ducking and fades are mixed with the same envelope the preview uses.
async function mixAudio(voice: AudioBuffer, music: AudioBuffer | null, settings: TimelineSettings, document: CaptionDocument, speechDuration: number, length: number) {
  const ctx = new OfflineAudioContext(2, Math.ceil(length * RATE), RATE);
  const voiceSource = ctx.createBufferSource(), voiceGain = ctx.createGain();
  voiceSource.buffer = voice; voiceGain.gain.value = settings.voiceVolume;
  voiceSource.connect(voiceGain).connect(ctx.destination);
  voiceSource.start(settings.speechStart, 0, Math.min(voice.duration, length - settings.speechStart));
  if (music && settings.music) {
    const source = ctx.createBufferSource(), gain = ctx.createGain();
    source.buffer = music; source.connect(gain).connect(ctx.destination);
    const ranges = speechRanges(document.words, settings, speechDuration), steps = Math.max(2, Math.ceil(length * 100));
    const curve = new Float32Array(steps);
    for (let i = 0; i < steps; i++) curve[i] = musicGain(i / (steps - 1) * length, settings, ranges, music.duration, length);
    gain.gain.setValueCurveAtTime(curve, 0, length);
    const begin = Math.max(0, settings.music.start), offset = Math.max(0, -settings.music.start);
    if (offset < music.duration && begin < length) source.start(begin, offset, Math.min(music.duration - offset, length - begin));
  }
  return ctx.startRendering();
}

export async function exportTimeline({ document, settings, videoUrl, voiceUrl, music, speechDuration, onProgress, signal }: {
  document: CaptionDocument; settings: TimelineSettings; videoUrl: string; voiceUrl: string; music: Blob | null;
  speechDuration: number; onProgress: (progress: number) => void; signal: AbortSignal;
}) {
  const mb = await import("mediabunny");
  const [width, height] = frameSize(document.format, document.resolution);
  const length = timelineLength(settings, speechDuration);
  const videoCodec = await mb.getFirstEncodableVideoCodec(["avc", "vp9", "av1"], { width, height, quality: mb.QUALITY_HIGH });
  const audioCodec = await mb.getFirstEncodableAudioCodec(["aac", "opus"], { numberOfChannels: 2, sampleRate: RATE, quality: mb.QUALITY_HIGH });
  if (!videoCodec || !audioCodec) throw new Error(unsupported);

  const videoBlob = await fetchBlob(videoUrl, signal);
  // Prefer the generated video's own soundtrack so lips and voice stay in sync; fall back to the approved WAV.
  let voice: AudioBuffer;
  try { voice = await decode(await videoBlob.arrayBuffer()); }
  catch { voice = await decode(await (await fetchBlob(voiceUrl, signal)).arrayBuffer()); }
  let musicBuffer: AudioBuffer | null = null;
  if (music && settings.music) {
    try { musicBuffer = await decode(await music.arrayBuffer()); }
    catch { throw new Error("Музикалният файл не може да се прочете. Изберете MP3, WAV или M4A файл."); }
  }
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const mixed = await mixAudio(voice, musicBuffer, settings, document, speechDuration, length);

  const input = new mb.Input({ source: new mb.BlobSource(videoBlob), formats: mb.ALL_FORMATS });
  const target = new mb.BufferTarget();
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const canvas = window.document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const cancel = () => { void output.cancel(); };
  signal.addEventListener("abort", cancel);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error(unsupported);
    const videoDuration = Math.max(.04, await track.computeDuration());
    const sink = new mb.CanvasSink(track, { poolSize: 3 });
    const video = new mb.CanvasSource(canvas, { codec: videoCodec, bitrate: document.resolution === "1080p" ? 8_000_000 : 4_000_000 });
    const audio = new mb.AudioBufferSource({ codec: audioCodec, bitrate: 160_000 });
    output.addVideoTrack(video, { frameRate: FPS }); output.addAudioTrack(audio);
    await output.start();
    await audio.add(mixed); audio.close();

    const groups = captionGroups(document.words), frames = Math.ceil(length * FPS);
    // Before and after the voice clip, the first/last video frame is held.
    function* times() { for (let i = 0; i < frames; i++) yield Math.min(videoDuration - .001, Math.max(0, i / FPS - settings.speechStart)); }
    let i = 0, last: HTMLCanvasElement | OffscreenCanvas | null = null;
    for await (const frame of sink.canvasesAtTimestamps(times())) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (frame) last = frame.canvas;
      const t = i / FPS;
      ctx.fillStyle = BG; ctx.fillRect(0, 0, width, height);
      if (last) fitSource(ctx, last, last.width, last.height, width, height, document.fit);
      drawCaptions(ctx, width, height, t - settings.speechStart, document, groups);
      await video.add(t, 1 / FPS);
      onProgress(++i / frames);
    }
    await output.finalize();
    if (!target.buffer) throw new Error("Експортът не завърши.");
    return new Blob([target.buffer], { type: "video/mp4" });
  } catch (e) {
    if (output.state !== "canceled" && output.state !== "finalized") await output.cancel().catch(() => {});
    throw e;
  } finally { signal.removeEventListener("abort", cancel); input.dispose(); }
}
