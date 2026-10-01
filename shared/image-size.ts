/** Pixel size declared in a PNG or JPEG header, or null when none is found. Header-only: nothing is decoded. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length >= 24 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (b[0] !== 255 || b[1] !== 216) return null;
  // JPEG: walk the segments to the first start-of-frame marker (C0–CF except DHT C4, JPG C8 and DAC CC).
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 255) return null;
    const marker = b[i + 1];
    if (marker === 255) { i++; continue; }
    if (marker === 216 || marker === 1 || (marker >= 208 && marker <= 215)) { i += 2; continue; }
    if (marker === 218 || marker === 217) return null; // image data or end before any frame header
    const length = (b[i + 2] << 8) | b[i + 3];
    if (length < 2) return null;
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker))
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    i += 2 + length;
  }
  return null;
}
/** The largest picture the renderer accepts (it would otherwise decode to gigabytes from a tiny file). */
export const MAX_IMAGE_SIDE = 4096, MAX_IMAGE_PIXELS = 4096 * 4096;
export const imageFits = (s: { width: number; height: number } | null) =>
  !!s && s.width > 0 && s.height > 0 && s.width <= MAX_IMAGE_SIDE && s.height <= MAX_IMAGE_SIDE && s.width * s.height <= MAX_IMAGE_PIXELS;
