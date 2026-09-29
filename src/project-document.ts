import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./lib";
import { newProjectDoc, projectDocSchema, type ProjectDoc, type ProjectPortrait } from "../shared/project";

export type SaveState = "saved" | "saving" | "dirty" | "error";
type Stored = { document: ProjectDoc | null; revision: number };
const endpoint = (projectId: string) => `/video-studio/projects/${projectId}/document`;
export const portraitUrl = (p: ProjectPortrait | null) =>
  !p ? "" : p.type === "library" ? `/api/avatars/${encodeURIComponent(p.id)}/image` : `/api/media/assets/${p.id}/file`;

/**
 * The server copy of a studio project (scenes, timeline, media references). Edits apply locally at once
 * and save after a short pause, one request at a time. If another tab or device saved first, the
 * server's version wins and `conflict` explains why the view changed.
 */
/** Fills defaults for fields added after a document was saved (e.g. scene scripts), like the server does. */
const normalize = (value: unknown): ProjectDoc | null => {
  const parsed = projectDocSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
export function useProjectDocument(projectId: string | undefined) {
  const [doc, setDoc] = useState<ProjectDoc | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState(""), [conflict, setConflict] = useState("");
  const state = useRef({ projectId, revision: 0, pending: null as ProjectDoc | null, saving: false, loaded: false, failed: false });
  const save = useCallback(async (leaving = false): Promise<void> => {
    const s = state.current, id = s.projectId;
    if (!id || s.saving || !s.pending || !s.loaded) return;
    const next = s.pending;
    s.pending = null; s.saving = true; setSaveState("saving");
    let again = false;
    try {
      const payload = JSON.stringify({ document: next, revision: s.revision });
      const r = await fetch("/api" + endpoint(id), {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: payload,
        // keepalive lets a save finish while the page closes, but browsers reject bodies over 64 KB with it.
        keepalive: leaving && payload.length < 60000,
      });
      const body: any = await r.json().catch(() => ({}));
      if (state.current.projectId !== id) return;
      if (r.status === 409) {
        s.revision = body.revision; s.pending = null;
        const latest = normalize(body.document);
        if (latest) setDoc(latest);
        setConflict(body.error || ""); setSaveState("saved");
        return;
      }
      if (!r.ok) {
        // A rejected document (e.g. a file that is no longer available) will not succeed on retry.
        if (r.status < 500 && r.status !== 429) { s.failed = true; setSaveState("error"); setError(body.error || "Проектът не беше запазен."); return; }
        throw new Error(body.error || "Проектът не беше запазен. Опитайте отново.");
      }
      s.revision = body.revision; s.failed = false; setError("");
      setSaveState(s.pending ? "dirty" : "saved");
      // Edits made while this request was in flight are saved right after it.
      again = !!s.pending;
    } catch (e) {
      // Network or server trouble: keep the edit and retry.
      if (!s.pending) s.pending = next;
      setSaveState("error"); setError((e as Error).message);
    } finally {
      s.saving = false;
      // Also runs after the editor closed, so the last edit is not lost.
      if (again && state.current === s) void save(leaving);
    }
  }, []);
  useEffect(() => {
    state.current = { projectId, revision: 0, pending: null, saving: false, loaded: false, failed: false };
    setDoc(null); setError(""); setConflict(""); setSaveState("saved");
    if (!projectId) return;
    let live = true;
    api<Stored>(endpoint(projectId)).then(r => {
      if (!live) return;
      state.current.revision = r.revision; state.current.loaded = true;
      const stored = r.document && normalize(r.document);
      if (r.document && !stored) { setError("Проектът не може да се зареди. Презаредете страницата."); return; }
      if (stored) setDoc(stored);
      else { const first = newProjectDoc(); setDoc(first); state.current.pending = first; void save(); }
    }).catch(e => live && setError((e as Error).message));
    const flush = () => { void save(true); };
    window.addEventListener("pagehide", flush);
    return () => { live = false; window.removeEventListener("pagehide", flush); void save(true); };
  }, [projectId, save]);
  // Debounced autosave; a failed save retries on the next edit or after a longer pause.
  useEffect(() => {
    if (saveState !== "dirty" && !(saveState === "error" && state.current.pending)) return;
    const timer = window.setTimeout(() => void save(), saveState === "error" ? 5000 : 800);
    return () => window.clearTimeout(timer);
  }, [doc, saveState, save]);
  const update = useCallback((change: (d: ProjectDoc) => ProjectDoc) => {
    setDoc(current => {
      if (!current) return current;
      const next = change(current);
      if (next === current) return current;
      state.current.pending = next; state.current.failed = false;
      setSaveState("dirty"); setConflict("");
      return next;
    });
  }, []);
  /** Saves now and resolves once the server has the latest edits (before a server render). */
  const flush = useCallback(async () => {
    for (let i = 0; i < 50 && (state.current.pending || state.current.saving); i++) {
      await save();
      if (state.current.saving || state.current.pending) await new Promise(r => setTimeout(r, 200));
    }
    if (state.current.pending || state.current.failed) throw new Error("Проектът не беше запазен. Опитайте отново.");
  }, [save]);
  return { doc, update, flush, saveState, error, conflict };
}
