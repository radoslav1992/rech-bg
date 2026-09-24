import type { Env } from "./types";
import { providerFailure, VideoFailure, type VideoStage } from "./video-errors";
import { videoFetch } from "./video-http";

export type HeyGenTicket = { provider: "heygen"; request_id: string; status_url: string; response_url: string };
export type HeyGenAvatar = { lookId: string; groupId: string };
const endpoint = "https://api.heygen.com/v3/videos";
const avatars = "https://api.heygen.com/v3/avatars";

function validId(id: unknown): string {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("Invalid video request ID");
  return id;
}
const videoUrl = (id: unknown) => `${endpoint}/${validId(id)}`;

function headers(env: Env, stage: VideoStage) {
  const key = env.HEYGEN_API_KEY?.trim();
  if (!key) throw new VideoFailure(stage, "AUTH");
  return { "x-api-key": key };
}

export async function createHeyGenAvatar(env: Env, id: string, image: string): Promise<HeyGenAvatar> {
  const response = await videoFetch(avatars, {
    method: "POST",
    headers: { ...headers(env, "SUBMIT"), "Content-Type": "application/json", "Idempotency-Key": `avatar:${id}` },
    // Create an isolated group belonging only to this job; never attach a user group.
    body: JSON.stringify({ type: "photo", name: `Rech BG ${id}`, file: { type: "url", url: image } }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw await providerFailure(response, "SUBMIT");
  const body = await response.json() as any;
  if (body?.error) throw new VideoFailure("SUBMIT", "PROVIDER");
  return { lookId: validId(body?.data?.avatar_item?.id), groupId: validId(body?.data?.avatar_group?.id) };
}

export async function getHeyGenAvatarStatus(env: Env, avatar: HeyGenAvatar) {
  const response = await videoFetch(`${avatars}/looks/${validId(avatar.lookId)}`, {
    headers: headers(env, "STATUS"), signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw await providerFailure(response, "STATUS");
  const body = await response.json() as any;
  const look = body?.data;
  if (body?.error || !look || look.id !== avatar.lookId || (look.group_id && look.group_id !== avatar.groupId))
    throw new VideoFailure("STATUS", "PROVIDER");
  if (look.status === "processing") return "processing";
  if (look.status === "completed") {
    if (look.avatar_type !== "photo_avatar" || !Array.isArray(look.supported_api_engines) || !look.supported_api_engines.includes("avatar_iii"))
      throw new VideoFailure("STATUS", "ACCESS");
    return "completed";
  }
  throw new VideoFailure("STATUS", look.error?.code === "moderation_failed" ? "CONTENT" : "PROVIDER");
}

export async function deleteHeyGenAvatar(env: Env, groupId: string) {
  const response = await videoFetch(`${avatars}/${validId(groupId)}`, {
    method: "DELETE", headers: headers(env, "CLEANUP"), signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return;
  if (!response.ok) throw await providerFailure(response, "CLEANUP");
  if (response.status !== 204) {
    const body = await response.json() as any;
    if (body?.error || body?.data?.id !== groupId) throw new VideoFailure("CLEANUP", "PROVIDER");
  }
}

export async function submitHeyGenVideo(env: Env, id: string, image: string, audio: string, avatar?: HeyGenAvatar): Promise<HeyGenTicket> {
  const response = await videoFetch(endpoint, {
    method: "POST",
    headers: { ...headers(env, "SUBMIT"), "Content-Type": "application/json", "Idempotency-Key": id },
    body: JSON.stringify({
      ...(avatar
        ? { type: "avatar", avatar_id: validId(avatar.lookId), engine: { type: "avatar_iii" } }
        : { type: "image", image: { type: "url", url: image },
            // Raw-image generation uses Avatar IV. III rejects these motion controls.
            motion_prompt: "A person speaking naturally to the camera. Subtle facial expressions and head movements.",
            expressiveness: "low" }),
      audio_url: audio,
      title: `Rech BG ${id}`, resolution: "1080p", aspect_ratio: "auto", output_format: "mp4",
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
