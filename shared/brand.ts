import { z } from "zod";
import { captionStyles } from "./captions";
import { layerPositions } from "./layers";

// Brand kit (one per account) and the pieces a project can take from it or a template.
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
/** Caption appearance without the words; new recordings in a branded project start with it. */
export const captionLookSchema = z.object({
  style: z.enum(captionStyles),
  format: z.enum(["9:16", "1:1", "16:9", "4:5"]),
  position: z.enum(["bottom", "middle", "top"]),
  enabled: z.boolean(),
  accent: color.optional(),
  textColor: color.optional(),
  size: z.number().min(0.7).max(1.4).optional(),
  uppercase: z.boolean().optional(),
  resolution: z.enum(["720p", "1080p"]).optional(),
  fit: z.enum(["contain", "cover"]).optional(),
});
export type CaptionLook = z.infer<typeof captionLookSchema>;
export const MAX_BUMPER_SECONDS = 15;
/** An intro or outro: an image shown for `seconds`, or a video clip cut to at most `seconds`. */
export const bumperSchema = z.object({
  assetId: z.uuid(),
  seconds: z.number().finite().min(1).max(MAX_BUMPER_SECONDS).transform((n) => Math.round(n * 10) / 10),
});
export type Bumper = z.infer<typeof bumperSchema>;
export const brandKitSchema = z.object({
  name: z.string().trim().max(80).default(""),
  logo: z.object({
    assetId: z.uuid(),
    position: z.enum(layerPositions),
    width: z.number().finite().min(0.05).max(0.5),
    opacity: z.number().finite().min(0.1).max(1),
  }).nullable().default(null),
  colors: z.object({ primary: color, secondary: color, text: color }).default({ primary: "#5667f5", secondary: "#111111", text: "#ffffff" }),
  captionLook: captionLookSchema.nullable().default(null),
  intro: bumperSchema.nullable().default(null),
  outro: bumperSchema.nullable().default(null),
});
export type BrandKit = z.infer<typeof brandKitSchema>;
export const defaultBrandKit = (): BrandKit => brandKitSchema.parse({});
/** Picks the look fields of a caption document (drops the words). */
export function lookOf(doc: CaptionLook & { words?: unknown }): CaptionLook {
  const { style, format, position, enabled, accent, textColor, size, uppercase, resolution, fit } = doc;
  return captionLookSchema.parse({ style, format, position, enabled, accent, textColor, size, uppercase, resolution, fit });
}
export const MAX_TEMPLATES = 50;
