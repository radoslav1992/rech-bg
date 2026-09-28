import type { Env } from "./types";
/** SQL fragment for work that is still in progress. */
export const ACTIVE = "('queued','running')";
/** Whether the user has an audio/video job in progress. */
export async function hasActiveJob(e: Env, userId: string) {
  return !!(await e.DB.prepare(`SELECT id FROM jobs WHERE user_id=? AND status IN ${ACTIVE}`)
    .bind(userId)
    .first());
}
/** Whether the user has a media task in progress. */
export async function hasActiveMediaTask(e: Env, userId: string) {
  return !!(await e.DB.prepare(`SELECT id FROM media_tasks WHERE user_id=? AND status IN ${ACTIVE}`)
    .bind(userId)
    .first());
}
/** The job or media task a client already created with this idempotency key, if any. */
export function findByIdempotencyKey<T = { id: string }>(
  e: Env,
  table: "jobs" | "media_tasks",
  userId: string,
  key: string,
  columns = "id",
) {
  return e.DB.prepare(`SELECT ${columns} FROM ${table} WHERE user_id=? AND idempotency_key=?`)
    .bind(userId, key)
    .first<T>();
}
