import type { Env } from "./types";
import { videoFetch } from "./video-http";
import { providerFailure, VideoFailure, type VideoStage } from "./video-errors";

export type WaveTicket = { provider: "wavespeed"; request_id: string; status_url: string; response_url: string };
function resultUrl(id: string) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("Invalid prediction ID");
  return `https://api.wavespeed.ai/api/v3/predictions/${id}/result`;
}
async function waveRequest(env: Env, url: string, stage: VideoStage, input?: { image: string; audio: string }) {
  const key = env.WAVESPEED_API_KEY?.trim();
  if (!key) throw new VideoFailure(stage, "AUTH");
  const response = await videoFetch(url, {
    method: input ? "POST" : "GET", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(input ? 60000 : 45000),
  });
  if (!response.ok) throw await providerFailure(response, stage);
  const body = await response.json() as any;
  if (typeof body?.code === "number" && (body.code < 200 || body.code >= 300)) {
    const status = body.code >= 400 && body.code <= 599 ? body.code : 502;
    throw await providerFailure(Response.json({ detail: body.message }, { status }), stage);
  }
  const data = body?.data ?? body;
  if (!data || typeof data !== "object") throw new VideoFailure(stage, "PROVIDER");
  return data;
}
export async function submitWaveVideo(env: Env, image: string, audio: string): Promise<WaveTicket> {
  const data = await waveRequest(env, "https://api.wavespeed.ai/api/v3/wavespeed-ai/infinitetalk-fast", "SUBMIT", { image, audio });
  const url = resultUrl(data.id);
  // Build the status URL ourselves; never send credentials to a returned host.
  return { provider: "wavespeed", request_id: data.id, status_url: url, response_url: url };
}
export async function getWaveVideo(env: Env, ticket: WaveTicket) {
  const data = await waveRequest(env, resultUrl(ticket.request_id), "STATUS");
  if (data.id && data.id !== ticket.request_id) throw new VideoFailure("STATUS", "PROVIDER");
  if (["failed", "cancelled", "timeout", "deleted"].includes(data.status))
    throw new VideoFailure("STATUS", data.status === "timeout" ? "TIMEOUT" : "PROVIDER");
  if (data.status === "completed") {
    const first = Array.isArray(data.outputs) ? data.outputs[0] : null;
    const url = typeof first === "string" ? first : first?.url;
    if (typeof url !== "string" || !url) throw new VideoFailure("RESULT", "MEDIA");
    return { status: "COMPLETED", video: { url } };
  }
  if (["created", "pending", "queued", "in_queue"].includes(data.status)) return { status: "IN_QUEUE" };
  // The provider documents all other non-terminal states as still pending.
  if (typeof data.status === "string" && data.status) return { status: "IN_PROGRESS" };
  throw new VideoFailure("STATUS", "PROVIDER");
}
