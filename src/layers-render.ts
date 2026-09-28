import { anchor, LAYER_MARGIN, layerActive, placeBox, type Layer, type SceneBackground, type TextLayer } from "../shared/layers";

// Canvas drawing of scene backgrounds and layers for the timeline preview and the browser export.
// The server render draws the same things with FFmpeg/libass (renderer/server.py, server/caption-ass.ts).
export type Visual = { source: CanvasImageSource; width: number; height: number };
export const mediaUrl = (assetId: string) => `/api/media/assets/${assetId}/file`;

function cover(ctx: CanvasRenderingContext2D, v: Visual, W: number, H: number) {
  const scale = Math.max(W / v.width, H / v.height), w = v.width * scale, h = v.height * scale;
  ctx.drawImage(v.source, (W - w) / 2, (H - h) / 2, w, h);
}
/** Fills the frame before the avatar is drawn; visible where "contain" framing leaves space. */
export function drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number, background: SceneBackground | null, image: Visual | null, fallback = "#000000") {
  ctx.fillStyle = background?.type === "color" ? background.color : fallback;
  ctx.fillRect(0, 0, W, H);
  if (background?.type === "image" && image) cover(ctx, image, W, H);
}
function drawText(ctx: CanvasRenderingContext2D, W: number, H: number, layer: TextLayer) {
  const size = layer.size * H, lines = layer.text.split(/\r?\n/);
  ctx.save();
  ctx.font = `${layer.bold ? 700 : 400} ${size}px "Noto Sans", Arial, sans-serif`;
  ctx.textBaseline = "alphabetic";
  const widths = lines.map((l) => ctx.measureText(l).width), lineHeight = size * 1.2;
  const blockW = Math.max(...widths), blockH = lineHeight * lines.length;
  const [ax, ay] = anchor(layer.position);
  // Same anchor point as the ASS \pos in the server render.
  const px = W * LAYER_MARGIN + ax * W * (1 - 2 * LAYER_MARGIN), py = H * LAYER_MARGIN + ay * H * (1 - 2 * LAYER_MARGIN);
  const left = px - ax * blockW, top = py - ay * blockH;
  if (layer.box) {
    const pad = size * 0.3;
    ctx.fillStyle = layer.box;
    ctx.fillRect(left - pad, top - pad, blockW + pad * 2, blockH + pad * 2);
  } else {
    ctx.lineWidth = Math.max(1, size * 0.12); ctx.strokeStyle = "#000000"; ctx.lineJoin = "round";
  }
  ctx.fillStyle = layer.color;
  lines.forEach((line, i) => {
    const x = left + ax * (blockW - widths[i]), y = top + lineHeight * i + size * 0.95;
    if (!layer.box) ctx.strokeText(line, x, y);
    ctx.fillText(line, x, y);
  });
  ctx.restore();
}
/**
 * Draws the layers active at scene time `t`, in render order: B-roll cutaways, image overlays, then text.
 * `visual` returns the loaded image or current video frame for an asset (null while loading).
 */
export function drawLayers(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, layers: Layer[], visual: (layer: Layer) => Visual | null) {
  const active = layers.filter((l) => layerActive(l, t));
  for (const layer of active) {
    if (layer.type !== "broll") continue;
    const v = visual(layer);
    if (v) cover(ctx, v, W, H);
  }
  for (const layer of active) {
    if (layer.type !== "image") continue;
    const v = visual(layer);
    if (!v) continue;
    const w = layer.width * W, h = w * (v.height / v.width);
    const [x, y] = placeBox(layer.position, W, H, w, h);
    ctx.save(); ctx.globalAlpha = layer.opacity; ctx.drawImage(v.source, x, y, w, h); ctx.restore();
  }
  for (const layer of active) if (layer.type === "text") drawText(ctx, W, H, layer);
}
