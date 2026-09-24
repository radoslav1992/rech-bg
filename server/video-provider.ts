import type { Env } from "./types";
import type { VideoTier } from "../shared/video";

export type VideoProvider = "fal" | "wavespeed" | "heygen";

// "fal" preserves the existing stack: WaveSpeed Low, fal Medium/High.
// An unknown setting disables new generation instead of silently billing a fallback.
export function configuredVideoProvider(env: Env, tier: VideoTier): VideoProvider | null {
  const mode = env.VIDEO_PROVIDER?.trim().toLowerCase() || "fal";
  if (mode === "heygen") return tier === "high" ? "heygen" : tier === "medium" ? "fal" : null;
  if (mode === "fal" || mode === "fal.ai") return tier === "low" ? "wavespeed" : "fal";
  return null;
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
