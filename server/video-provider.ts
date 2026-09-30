import type { Env } from "./types";
import { KLING_STANDARD_MAX_SECONDS, MAX_VIDEO_SECONDS, type VideoTier } from "../shared/video";
import type { HeyGenEngine } from "./video-heygen";

export type VideoProvider = "fal" | "wavespeed" | "heygen";

// VIDEO_PROVIDER=heygen: every video uses a saved avatar (a library avatar or one of the user's own, created
// once): Low with Avatar III, Medium with Avatar IV; High (Avatar V, a digital twin from a filmed video) comes later.
// "fal" preserves the older stack that animates a photo per video: WaveSpeed Low, fal Medium/High.
// An unknown setting disables new generation instead of silently billing a fallback.
export function configuredVideoProvider(env: Env, tier: VideoTier): VideoProvider | null {
  const mode = env.VIDEO_PROVIDER?.trim().toLowerCase() || "fal";
  if (mode === "heygen") return tier === "high" ? null : "heygen";
  if (tier === "medium" && mediumUsesLibrary(env)) return "heygen";
  if (mode === "fal" || mode === "fal.ai") return tier === "low" ? "wavespeed" : "fal";
  return null;
}
/** Whether videos use saved avatars (see configuredVideoProvider). */
export const avatarMode = (env: Env) => env.VIDEO_PROVIDER?.trim().toLowerCase() === "heygen";
/** The HeyGen engine a tier uses with a saved avatar, or null when the tier animates the photo itself. */
export function tierEngine(env: Env, tier: VideoTier): HeyGenEngine | null {
  if (avatarMode(env)) return tier === "low" ? "avatar_iii" : tier === "medium" ? "avatar_iv" : null;
  return tier === "medium" && mediumUsesLibrary(env) ? "avatar_iii" : null;
}
/** A tier that is announced but not available yet (High until the Avatar V digital twin). */
export const tierComingSoon = (env: Env, tier: VideoTier) => avatarMode(env) && tier === "high";

/**
 * VIDEO_MEDIUM=heygen (with VIDEO_PROVIDER=fal only): Medium uses HeyGen Avatar III with the library avatars
 * linked to a HeyGen avatar. VIDEO_PROVIDER=heygen replaces it.
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
