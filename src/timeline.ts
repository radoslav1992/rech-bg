// Browser side of the timeline; the arrangement math lives in shared/timeline.ts.
export * from "../shared/timeline";
import { defaultTimeline, sanitizeTimeline, type TimelineSettings } from "../shared/timeline";

// Per-user, per-recording browser storage. Music never leaves the device.
const settingsKey = (user: string, audio: string) => `rech:timeline:v1:${user}:${audio}`;
export function loadTimeline(user: string, audio: string): TimelineSettings {
  try { return sanitizeTimeline(JSON.parse(localStorage.getItem(settingsKey(user, audio)) || "{}")); } catch { return { ...defaultTimeline }; }
}
export function saveTimeline(user: string, audio: string, settings: TimelineSettings) {
  try { localStorage.setItem(settingsKey(user, audio), JSON.stringify(settings)); } catch { /* storage unavailable */ }
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("rech-timeline", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const db = await database();
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction("files", mode).objectStore("files"));
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }).finally(() => db.close());
  } catch { return undefined; }
}
export const readLocalFile = (key: string) => transact<Blob | string | undefined>("readonly", s => s.get(key));
export const writeLocalFile = (key: string, value: Blob | string) => transact("readwrite", s => s.put(value, key));
export const removeLocalFile = (key: string) => transact("readwrite", s => s.delete(key));
