import { layerActive, placeBox, type Layer, type SceneBackground, type TextLayer } from "../shared/layers";
import { textLayerItems } from "../shared/caption-scene";
import { drawCaptionItem } from "./caption-render";

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
  // The same items the server turns into ASS (shared/caption-scene.ts).
  for (const item of textLayerItems(layer, W, H)) drawCaptionItem(ctx, item, 0);
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
