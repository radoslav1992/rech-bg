import { voiceList } from "../shared/catalog";
// Provider identifiers never leave the server. Public IDs are stable Bulgarian aliases.
const upstream = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Gacrux",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
];
export const voiceMap = Object.fromEntries(
  voiceList.map((v, i) => [v.id, upstream[i]]),
);
export const TTS_MODEL = "google/gemini-3.1-flash-tts";
export { segments } from "../shared/text";
export function decodeAudio(raw: string): { pcm: Uint8Array; rate: number } {
  let b64 = raw.trim(),
    mime = "";
  if (b64.startsWith("data:")) {
    const comma = b64.indexOf(",");
    if (comma < 0) throw new Error("Invalid audio");
    mime = b64.slice(5, comma);
    b64 = b64.slice(comma + 1);
  }
  b64 = b64.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  b64 += "=".repeat((4 - (b64.length % 4)) % 4);
  const decoded = atob(b64);
  if (decoded.length > 20_000_000) throw new Error("Audio too large");
  const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
  const tag = (i: number) => String.fromCharCode(...bytes.subarray(i, i + 4));
  if (tag(0) === "RIFF" && tag(8) === "WAVE") {
    const view = new DataView(bytes.buffer);
    let rate = 0,
      pcm: Uint8Array | undefined,
      valid = false;
    for (let pos = 12; pos + 8 <= bytes.length;) {
      const kind = tag(pos),
        len = view.getUint32(pos + 4, true);
      if (pos + 8 + len > bytes.length) throw new Error("Truncated WAV");
      if (kind === "fmt ") {
        if (len < 16) throw new Error("Invalid WAV");
        valid =
          view.getUint16(pos + 8, true) === 1 &&
          view.getUint16(pos + 10, true) === 1 &&
          view.getUint16(pos + 22, true) === 16;
        rate = view.getUint32(pos + 12, true);
      }
      if (kind === "data") pcm = bytes.subarray(pos + 8, pos + 8 + len);
      pos += 8 + len + (len % 2);
    }
    if (!valid || !pcm?.length || pcm.length % 2 || rate < 8000 || rate > 48000)
      throw new Error("Unsupported WAV");
    return { pcm, rate };
  }
  if (
    /audio\/(?:l16|pcm|linear16)/i.test(mime) &&
    bytes.length > 0 &&
    bytes.length % 2 === 0
  ) {
    const rate = Number(/rate=(\d+)/i.exec(mime)?.[1] || 24000);
    if (rate < 8000 || rate > 48000) throw new Error("Invalid sample rate");
    return { pcm: bytes, rate };
  }
  throw new Error("Unsupported audio format");
}
export function wavHeader(size: number, rate: number) {
  const b = new Uint8Array(44),
    v = new DataView(b.buffer);
  const t = (s: string, p: number) =>
    [...s].forEach((c, i) => (b[p + i] = c.charCodeAt(0)));
  t("RIFF", 0);
  v.setUint32(4, 36 + size, true);
  t("WAVEfmt ", 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  t("data", 36);
  v.setUint32(40, size, true);
  return b;
}
