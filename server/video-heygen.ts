import type { Env } from "./types";
import { providerFailure, VideoFailure, type VideoStage } from "./video-errors";
import { videoFetch } from "./video-http";

export type HeyGenTicket = { provider: "heygen"; request_id: string; status_url: string; response_url: string };
const endpoint = "https://api.heygen.com/v3/videos";

function videoUrl(id: unknown): string {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("Invalid video request ID");
  return `${endpoint}/${id}`;
}

function headers(env: Env, stage: VideoStage) {
  const key = env.HEYGEN_API_KEY?.trim();
  if (!key) throw new VideoFailure(stage, "AUTH");
  return { "x-api-key": key };
}

export async function submitHeyGenVideo(env: Env, id: string, image: string, audio: string): Promise<HeyGenTicket> {
  const response = await videoFetch(endpoint, {
    method: "POST",
    headers: { ...headers(env, "SUBMIT"), "Content-Type": "application/json", "Idempotency-Key": id },
    body: JSON.stringify({
      type: "image", image: { type: "url", url: image }, audio_url: audio,
      title: `Rech BG ${id}`, resolution: "1080p", aspect_ratio: "auto", output_format: "mp4",
      // Raw-image generation uses Avatar IV; the image schema has no engine field.
      motion_prompt: "A person speaking naturally to the camera. Subtle facial expressions and head movements.",
      expressiveness: "low",
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw await providerFailure(response, "SUBMIT");
  const body = await response.json() as any;
  if (body?.error || !body?.data?.video_id) throw new VideoFailure("SUBMIT", "PROVIDER");
  const url = videoUrl(body.data.video_id);
  return { provider: "heygen", request_id: body.data.video_id, status_url: url, response_url: url };
}

export async function getHeyGenVideo(env: Env, ticket: HeyGenTicket, stage: VideoStage = "STATUS") {
  // Rebuild the URL from the ID: never send a credential to a saved/provider URL.
  const response = await videoFetch(videoUrl(ticket.request_id), { headers: headers(env, stage), signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw await providerFailure(response, stage);
  const body = await response.json() as any;
  const data = body?.data;
  if (body?.error || !data || data.id !== ticket.request_id) throw new VideoFailure(stage, "PROVIDER");
  switch (data.status) {
    case "waiting":
    case "pending": return { status: "IN_QUEUE" };
    case "processing": return { status: "IN_PROGRESS" };
    case "completed":
      if (typeof data.video_url !== "string" || !data.video_url) throw new VideoFailure(stage, "PROVIDER");
      return { status: "COMPLETED", video: { url: data.video_url } };
    default: throw new VideoFailure(stage, "PROVIDER");
  }
}
