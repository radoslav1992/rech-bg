import type { Env } from "./types";
import { providerFailure, VideoFailure, type VideoStage } from "./video-errors";
import { videoFetch } from "./video-http";

export type HeyGenTicket = { provider: "heygen"; request_id: string; status_url: string; response_url: string };
export type HeyGenAvatar = { lookId: string; groupId: string };
/** Video engines (HeyGen `engine.type`): III and IV animate a photo avatar; V needs a video avatar. */
export type HeyGenEngine = "avatar_iii" | "avatar_iv" | "avatar_v";
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
  if (body?.error || !look || look.id !== avatar.lookId || (avatar.groupId && look.group_id && look.group_id !== avatar.groupId))
    throw new VideoFailure("STATUS", "PROVIDER");
  if (look.status === "processing") return "processing";
  if (look.status === "completed") {
    if (look.avatar_type !== "photo_avatar" || !Array.isArray(look.supported_api_engines) || !look.supported_api_engines.includes("avatar_iii"))
      throw new VideoFailure("STATUS", "ACCESS");
    return "completed";
  }
  throw new VideoFailure("STATUS", look.error?.code === "moderation_failed" ? "CONTENT" : "PROVIDER");
}

/** A photo avatar (look) in the HeyGen account, e.g. one linked to a library avatar. */
export async function getHeyGenLook(env: Env, lookId: string) {
  const response = await videoFetch(`${avatars}/looks/${validId(lookId)}`, {
    headers: headers(env, "STATUS"), signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw await providerFailure(response, "STATUS");
  const body = await response.json() as any;
  const look = body?.data;
  if (body?.error || !look || look.id !== lookId) throw new VideoFailure("STATUS", "PROVIDER");
  const status: "processing" | "completed" | "failed" = look.status === "processing" ? "processing" : look.status === "completed" ? "completed" : "failed";
  const engines = Array.isArray(look.supported_api_engines)
    ? look.supported_api_engines.filter((e: unknown): e is string => typeof e === "string" && /^[a-z0-9_]{1,40}$/.test(e)).slice(0, 10) as string[]
    : [];
  return {
    status,
    groupId: typeof look.group_id === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(look.group_id) ? look.group_id as string : "",
    avatarIII: look.avatar_type === "photo_avatar" && engines.includes("avatar_iii"),
    /** The engines HeyGen lists for this avatar (e.g. avatar_iii, avatar_iv). */
    engines,
    moderation: look.error?.code === "moderation_failed",
  };
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

export async function submitHeyGenVideo(env: Env, id: string, image: string, audio: string, avatar?: HeyGenAvatar, engine: HeyGenEngine = "avatar_iii"): Promise<HeyGenTicket> {
  const response = await videoFetch(endpoint, {
    method: "POST",
    headers: { ...headers(env, "SUBMIT"), "Content-Type": "application/json", "Idempotency-Key": id },
    body: JSON.stringify({
      ...(avatar
        ? { type: "avatar", avatar_id: validId(avatar.lookId), engine: { type: engine } }
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

// Video Translation (dubbing): POST /v3/video-translations, then GET /v3/video-translations/{id}.
const translations = "https://api.heygen.com/v3/video-translations";
export type HeyGenTranslationTicket = { provider: "heygen"; kind: "translate"; request_id: string };
export async function submitHeyGenTranslation(env: Env, id: string, video: string, language: string, mode: "speed" | "precision", audioOnly: boolean): Promise<HeyGenTranslationTicket> {
  const response = await videoFetch(translations, {
    method: "POST",
    headers: { ...headers(env, "SUBMIT"), "Content-Type": "application/json", "Idempotency-Key": id },
    body: JSON.stringify({ video: { type: "url", url: video }, output_languages: [language], mode, translate_audio_only: audioOnly, title: `Rech BG ${id}` }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw await providerFailure(response, "SUBMIT");
  const body = await response.json() as any;
  const ids = body?.data?.video_translation_ids;
  if (body?.error || !Array.isArray(ids) || ids.length !== 1) throw new VideoFailure("SUBMIT", "PROVIDER");
  return { provider: "heygen", kind: "translate", request_id: validId(ids[0]) };
}
export async function getHeyGenTranslation(env: Env, ticket: HeyGenTranslationTicket, stage: VideoStage = "STATUS") {
  const response = await videoFetch(`${translations}/${validId(ticket.request_id)}`, { headers: headers(env, stage), signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw await providerFailure(response, stage);
  const body = await response.json() as any;
  const data = body?.data;
  if (body?.error || !data) throw new VideoFailure(stage, "PROVIDER");
  switch (data.status) {
    case "pending":
    case "queued":
    case "waiting": return { status: "IN_QUEUE" as const };
    case "running":
    case "processing": return { status: "IN_PROGRESS" as const };
    case "completed":
    case "success":
      if (typeof data.video_url !== "string" || !data.video_url) throw new VideoFailure(stage, "PROVIDER");
      return { status: "COMPLETED" as const, url: data.video_url as string };
    default: throw new VideoFailure(stage, data.failure_code === "moderation" || /moderat|policy/i.test(String(data.failure_message || "")) ? "CONTENT" : "PROVIDER");
  }
}
// Lipsync ("Преозвучаване"): POST /v3/lipsyncs with the filmed video and the new speech, then GET /v3/lipsyncs/{id}.
const lipsyncs = "https://api.heygen.com/v3/lipsyncs";
export type HeyGenLipsyncTicket = { provider: "heygen"; kind: "lipsync"; request_id: string };
export async function submitHeyGenLipsync(env: Env, id: string, video: string, audio: string, mode: "speed" | "precision"): Promise<HeyGenLipsyncTicket> {
  const response = await videoFetch(lipsyncs, {
    method: "POST",
    headers: { ...headers(env, "SUBMIT"), "Content-Type": "application/json", "Idempotency-Key": id },
    body: JSON.stringify({
      video: { type: "url", url: video }, audio: { type: "url", url: audio }, mode, title: `Rech BG ${id}`,
      // The video follows the new speech's length; its picture keeps the original format.
      keep_the_same_format: true, enable_dynamic_duration: true, enable_caption: false, enable_watermark: false,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw await providerFailure(response, "SUBMIT");
  const body = await response.json() as any;
  const lipsyncId = body?.data?.lipsync_id ?? body?.data?.id;
  if (body?.error || !lipsyncId) throw new VideoFailure("SUBMIT", "PROVIDER");
  return { provider: "heygen", kind: "lipsync", request_id: validId(lipsyncId) };
}
export async function getHeyGenLipsync(env: Env, ticket: HeyGenLipsyncTicket, stage: VideoStage = "STATUS") {
  const response = await videoFetch(`${lipsyncs}/${validId(ticket.request_id)}`, { headers: headers(env, stage), signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw await providerFailure(response, stage);
  const body = await response.json() as any;
  const data = body?.data;
  if (body?.error || !data) throw new VideoFailure(stage, "PROVIDER");
  switch (data.status) {
    case "pending":
    case "queued":
    case "waiting": return { status: "IN_QUEUE" as const };
    case "running":
    case "processing": return { status: "IN_PROGRESS" as const };
    case "completed":
      if (typeof data.video_url !== "string" || !data.video_url) throw new VideoFailure(stage, "PROVIDER");
      return { status: "COMPLETED" as const, url: data.video_url as string, duration: typeof data.duration === "number" ? data.duration : 0 };
    default: throw new VideoFailure(stage, /moderat|policy/i.test(String(data.failure_message || data.failure_code || "")) ? "CONTENT" : "PROVIDER");
  }
}

/**
 * Our copies at HeyGen: once a result is saved in our storage (or the request failed) the provider's copy is
 * deleted. Queued as cleanup tasks `heygen-file/{kind}/{id}`, retried by maintenance.
 */
const heygenFiles = { translation: translations, lipsync: lipsyncs, video: endpoint } as const;
export type HeyGenFileKind = keyof typeof heygenFiles;
export async function deleteHeyGenFile(env: Env, kind: HeyGenFileKind, id: string) {
  const response = await videoFetch(`${heygenFiles[kind]}/${validId(id)}`, {
    method: "DELETE", headers: headers(env, "CLEANUP"), signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404 || response.ok) return;
  throw await providerFailure(response, "CLEANUP");
}
export const queueHeyGenFile = (env: Env, kind: HeyGenFileKind, id: string) =>
  env.DB.prepare("INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES (?,?)").bind(`heygen-file/${kind}/${validId(id)}`, Math.floor(Date.now() / 1000)).run();
export async function cleanupHeyGenFiles(env: Env) {
  if (!env.HEYGEN_API_KEY?.trim()) return;
  const tasks = (await env.DB.prepare("SELECT prefix,created_at FROM cleanup_tasks WHERE prefix LIKE 'heygen-file/%' ORDER BY created_at LIMIT 50").all<{ prefix: string; created_at: number }>()).results;
  for (const task of tasks) {
    const match = /^heygen-file\/(translation|lipsync|video)\/([a-zA-Z0-9_-]{1,160})$/.exec(task.prefix);
    try {
      if (match) await deleteHeyGenFile(env, match[1] as HeyGenFileKind, match[2]);
      await env.DB.prepare("DELETE FROM cleanup_tasks WHERE prefix=?").bind(task.prefix).run();
    } catch {
      // Give up after two weeks: HeyGen's own retention removes it eventually; the log says which one.
      if (task.created_at < Date.now() / 1000 - 14 * 86400) {
        console.error("HeyGen copy could not be deleted; remove it in HeyGen", { file: task.prefix });
        await env.DB.prepare("DELETE FROM cleanup_tasks WHERE prefix=?").bind(task.prefix).run();
      } else console.error("HeyGen copy cleanup will retry", { file: task.prefix });
    }
  }
}

/** Target languages HeyGen accepts (names such as "English" or "Spanish (Spain)"). */
export async function listHeyGenLanguages(env: Env): Promise<string[]> {
  const response = await videoFetch(`${translations}/languages`, { headers: headers(env, "LOAD"), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw await providerFailure(response, "LOAD");
  const body = await response.json() as any;
  const list = body?.data?.languages;
  if (!Array.isArray(list)) throw new VideoFailure("LOAD", "PROVIDER");
  return list.filter((l: unknown): l is string => typeof l === "string" && l.length > 0 && l.length <= 80).slice(0, 400);
}
