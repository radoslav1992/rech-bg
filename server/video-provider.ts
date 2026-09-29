import type { Env } from "./types";
import { KLING_STANDARD_MAX_SECONDS, MAX_VIDEO_SECONDS, type VideoTier } from "../shared/video";

export type VideoProvider = "fal" | "wavespeed" | "heygen";

// "fal" preserves the existing stack: WaveSpeed Low, fal Medium/High.
// An unknown setting disables new generation instead of silently billing a fallback.
export function configuredVideoProvider(env: Env, tier: VideoTier): VideoProvider | null {
  if (tier === "medium" && mediumUsesLibrary(env)) return "heygen";
  const mode = env.VIDEO_PROVIDER?.trim().toLowerCase() || "fal";
  // Low uses WaveSpeed InfiniteTalk in both modes (it has no HeyGen equivalent).
  if (mode === "heygen") return tier === "high" ? "heygen" : tier === "medium" ? "fal" : "wavespeed";
  if (mode === "fal" || mode === "fal.ai") return tier === "low" ? "wavespeed" : "fal";
  return null;
}

/**
 * VIDEO_MEDIUM=heygen: Medium uses HeyGen Avatar III with the library avatars linked to a HeyGen avatar
 * (one reusable avatar each, no per-video avatar creation). Own portraits cannot use Medium then.
 */
export function mediumUsesLibrary(env: Env) {
  return env.VIDEO_MEDIUM?.trim().toLowerCase() === "heygen";
}

/** Longest recording the tier's current model accepts for one video. */
export function videoMaxSeconds(provider: VideoProvider | null, tier: VideoTier) {
  return provider === "fal" && tier === "medium" ? KLING_STANDARD_MAX_SECONDS : MAX_VIDEO_SECONDS;
}

export function hasVideoCredential(env: Env, provider: VideoProvider | null): boolean {
  switch (provider) {
    case "heygen": return !!env.HEYGEN_API_KEY?.trim();
    case "wavespeed": return !!env.WAVESPEED_API_KEY?.trim();
    case "fal": return !!env.FAL_KEY?.trim();
    default: return false;
  }
}

// Never consult today's setting when resuming an existing job. Jobs created
// before provider snapshots retain their historical tier-based routing.
export function savedVideoProvider(provider: unknown, tier: string): VideoProvider {
  if (provider == null) return tier === "low" ? "wavespeed" : "fal";
  if (provider === "fal" || provider === "wavespeed" || provider === "heygen") return provider;
  throw new Error("Invalid saved video provider");
}
