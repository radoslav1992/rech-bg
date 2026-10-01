import { z } from "zod";

// Scene layers drawn over the avatar video, identically in the browser preview/export and the server render.
// Times are seconds on the scene's own timeline (0 = scene start, including its lead-in).
export const MAX_LAYERS = 30;
export const LAYER_MARGIN = 0.05;
export const layerPositions = [
  "top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right",
] as const;
export type LayerPosition = (typeof layerPositions)[number];
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const time = z.number().finite().min(0).max(600).transform((n) => Math.round(n * 100) / 100);
const timed = { id: z.uuid(), start: time, end: time };
export const textLayerSchema = z.object({
  ...timed,
  type: z.literal("text"),
  /** Plain text; line breaks allowed. */
  // May be empty while the user retypes it; an empty title is simply not drawn (an invalid document would stop saving).
  text: z.string().max(200),
  position: z.enum(layerPositions),
  /** Letter height as a share of the frame height. */
  size: z.number().finite().min(0.02).max(0.15),
  color,
  /** Box behind the text, or none. */
  box: color.nullable(),
  bold: z.boolean(),
});
export const imageLayerSchema = z.object({
  ...timed,
  type: z.literal("image"),
  assetId: z.uuid(),
  position: z.enum(layerPositions),
  /** Width as a share of the frame width; height follows the image. */
  width: z.number().finite().min(0.05).max(1),
  opacity: z.number().finite().min(0.1).max(1),
});
export const brollLayerSchema = z.object({
  ...timed,
  type: z.literal("broll"),
  /** A full-frame cutaway (image or video) while the voice continues. */
  assetId: z.uuid(),
  /** Seconds skipped at the start of a video clip. */
  trim: time,
});
export const layerSchema = z
  .discriminatedUnion("type", [textLayerSchema, imageLayerSchema, brollLayerSchema])
  .refine((l) => l.end > l.start, { message: "Слоят трябва да свършва след началото си." });
export const backgroundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("color"), color }),
  z.object({ type: z.literal("image"), assetId: z.uuid() }),
]);
export type TextLayer = z.infer<typeof textLayerSchema>;
export type ImageLayer = z.infer<typeof imageLayerSchema>;
export type BrollLayer = z.infer<typeof brollLayerSchema>;
export type Layer = z.infer<typeof layerSchema>;
export type SceneBackground = z.infer<typeof backgroundSchema>;

/** Media library kinds that can be used as still images (overlays, stills, backgrounds). */
export const imageAssetKinds = ["portrait", "product", "variant"] as const;
/** Media library kinds that can be used as video B-roll. */
export const videoAssetKinds = ["upload", "export"] as const;

/** Horizontal and vertical anchor (0 = left/top, 0.5 = centre, 1 = right/bottom). */
export function anchor(position: LayerPosition): [number, number] {
  const x = position.endsWith("left") ? 0 : position.endsWith("right") ? 1 : 0.5;
  const y = position.startsWith("top") ? 0 : position.startsWith("bottom") ? 1 : 0.5;
  return [x, y];
}
/** Top-left corner of a box of size w×h placed at `position` inside a W×H frame, inside the safe margin. */
export function placeBox(position: LayerPosition, W: number, H: number, w: number, h: number): [number, number] {
  const [ax, ay] = anchor(position);
  const mx = W * LAYER_MARGIN, my = H * LAYER_MARGIN;
  return [mx + ax * (W - w - 2 * mx), my + ay * (H - h - 2 * my)];
}
export const layerActive = (layer: Layer, t: number) => t >= layer.start && t < layer.end;
export function newTextLayer(start: number, end: number): TextLayer {
  return { id: crypto.randomUUID(), type: "text", start, end, text: "Вашият текст", position: "top", size: 0.06, color: "#ffffff", box: "#111111", bold: true };
}
