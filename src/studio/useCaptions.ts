import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib";
import { defaultCaptions, type CaptionDocument } from "../../shared/captions";

// Recordings keep their captions in the studio; uploaded videos ("asset:<id>") in the media library.
const endpoint = (id: string) => id.startsWith("asset:") ? `/media/assets/${id.slice(6)}/captions` : `/video-studio/captions/${id}`;

/**
 * Caption documents of the scenes' recordings and filmed clips (words, timing and look are stored per
 * recording or video on the server, where the export reads them). Edits apply at once and save after a short pause.
 */
export function useCaptions(audioIds: string[]) {
  const [docs, setDocs] = useState<Record<string, CaptionDocument>>({});
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "error">("saved"), [error, setError] = useState("");
  const pending = useRef(new Map<string, CaptionDocument>()), requested = useRef(new Set<string>());
  const [version, setVersion] = useState(0);
  const key = audioIds.join(",");
  useEffect(() => {
    for (const id of audioIds) {
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      api<CaptionDocument>(endpoint(id))
        .then((d) => setDocs((all) => ({ ...all, [id]: { ...defaultCaptions, ...d } })))
        .catch(() => { requested.current.delete(id); });
    }
  }, [key, version]);
  const save = useCallback(async () => {
    if (!pending.current.size) return;
    const batch = [...pending.current];
    pending.current.clear(); setSaveState("saving");
    try {
      await Promise.all(batch.map(([id, doc]) => api(endpoint(id), { method: "PUT", body: JSON.stringify(doc) })));
      setSaveState(pending.current.size ? "dirty" : "saved"); setError("");
    } catch (e) {
      for (const [id, doc] of batch) if (!pending.current.has(id)) pending.current.set(id, doc);
      setSaveState("error"); setError((e as Error).message);
      throw e;
    }
  }, []);
  useEffect(() => {
    if (saveState !== "dirty") return;
    const timer = window.setTimeout(() => void save().catch(() => {}), 1200);
    return () => window.clearTimeout(timer);
  }, [docs, saveState, save]);
  // Leaving the studio still saves the last caption edit.
  useEffect(() => () => {
    for (const [id, doc] of pending.current) void api(endpoint(id), { method: "PUT", body: JSON.stringify(doc) }).catch(() => {});
  }, []);
  /** Changes one recording's captions. */
  const edit = useCallback((audioId: string, change: (d: CaptionDocument) => CaptionDocument) => {
    setDocs((all) => {
      const current = all[audioId];
      if (!current) return all;
      const next = change(current);
      pending.current.set(audioId, next);
      return { ...all, [audioId]: next };
    });
    setSaveState("dirty");
  }, []);
  /** Changes the look (format, style, framing…) of every loaded recording at once. */
  const editAll = useCallback((look: Partial<CaptionDocument>) => {
    setDocs((all) => {
      const next = { ...all };
      for (const id of Object.keys(all)) { next[id] = { ...all[id], ...look, words: all[id].words }; pending.current.set(id, next[id]); }
      return next;
    });
    setSaveState("dirty");
  }, []);
  /** Reloads documents changed elsewhere (e.g. the brand look applied on the server). */
  const reload = useCallback(() => { requested.current.clear(); setDocs({}); setVersion((v) => v + 1); }, []);
  const flush = useCallback(async () => { await save(); }, [save]);
  return { docs, edit, editAll, saveState, error, flush, reload };
}
