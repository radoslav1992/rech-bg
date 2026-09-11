const messages = {
  AUTH: "Видео услугата има проблем с достъпа. Свържете се с поддръжката.",
  BALANCE: "Видео услугата временно няма наличен ресурс за генериране. Свържете се с поддръжката.",
  ACCESS: "Достъпът до избраното качество временно е ограничен. Свържете се с поддръжката.",
  INPUT: "Аудиото или портретът не бяха приети за видео. Свържете се с поддръжката с кода по-долу.",
  MEDIA: "Видео услугата не успя да прочете аудиото или портрета.",
  CAPACITY: "Видео услугата е натоварена. Опитайте отново след малко.",
  CONTENT: "Съдържанието не беше прието за генериране на видео.",
  TIMEOUT: "Видеото не беше готово в разрешеното време.",
  PROVIDER: "Видео услугата върна грешка при генериране.",
  INTERNAL: "Видеото не беше създадено поради техническа грешка.",
} as const;
type Category = keyof typeof messages;
export type VideoStage = "LOAD" | "SUBMIT" | "STATUS" | "RESULT" | "DOWNLOAD" | "SAVE" | "CLEANUP";
export class VideoFailure extends Error {
  constructor(stage: VideoStage, category: Category, status = 0) {
    // A fixed-format message survives serialization by Cloudflare Workflows.
    super(`VIDEO_${stage}_${category}_${status}`);
  }
}
export function videoFailureMessage(error: unknown, stage: VideoStage) {
  const message = error instanceof Error ? error.message : "";
  const match = message.match(/\bVIDEO_(LOAD|SUBMIT|STATUS|RESULT|DOWNLOAD|SAVE|CLEANUP)_(AUTH|BALANCE|ACCESS|INPUT|MEDIA|CAPACITY|CONTENT|TIMEOUT|PROVIDER|INTERNAL)_(\d{1,3})\b/);
  const category: Category = match ? match[2] as Category : (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "TIMEOUT" : "INTERNAL");
  const code = match?.[0] || `VIDEO_${stage}_${category}_0`;
  return { code, message: `${messages[category]} Кредитите за видеото са върнати. Аудиозаписът остава наличен. Код: ${code}.` };
}
export async function providerFailure(response: Response, stage: VideoStage): Promise<VideoFailure> {
  const body = await response.json().catch(() => null) as any;
  const types = [body?.error_type, ...(Array.isArray(body?.detail) ? body.detail.map((d: any) => d?.type) : [])];
  // Some account/balance failures still use unstructured detail strings. Only
  // classify them; never persist or log raw bodies, input URLs, or input fields.
  const detail = typeof body?.detail === "string" ? body.detail.toLowerCase() : "";
  let category: Category = "PROVIDER";
  if (response.status === 401) category = "AUTH";
  else if (response.status === 402 || ((response.status === 403 || response.status === 400) && /balance|credits|top.?up/.test(detail))) category = "BALANCE";
  else if (response.status === 403) category = "ACCESS";
  else if (response.status === 429) category = "CAPACITY";
  else if (types.includes("content_policy_violation")) category = "CONTENT";
  else if (types.some(t => ["file_download_error", "file_download_failed", "audio_load_error", "image_load_error"].includes(t))) category = "MEDIA";
  else if (types.some(t => ["request_timeout", "generation_timeout", "startup_timeout"].includes(t))) category = "TIMEOUT";
  else if ([400, 422].includes(response.status)) category = "INPUT";
  return new VideoFailure(stage, category, response.status);
}
