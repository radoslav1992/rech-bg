import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Job } from "../lib";
import { useJobs } from "../JobActivity";
import { mergeJobs } from "../job-state";
import type { StudioVoice } from "../../shared/studio";
import type { VideoTier } from "../../shared/video";
import type { LibraryAvatar, UserAvatar } from "../../shared/avatars";
import type { VideoConfig } from "./SceneInspector";

/** Every recording and video of one project: loaded once, then kept fresh by the app-wide job polling. */
export function useProjectJobs(projectId: string) {
  const { jobs: recent, error } = useJobs();
  const [own, setOwn] = useState<Job[]>([]), [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => api<{ jobs: Job[] }>(`/jobs?project=${encodeURIComponent(projectId)}`)
      .then((d) => { if (live) { setOwn((list) => mergeJobs(list, d.jobs)); setLoaded(true); } })
      .catch(() => { if (live) setLoaded(true); });
    void load();
    window.addEventListener("rech:jobs-changed", load);
    return () => { live = false; window.removeEventListener("rech:jobs-changed", load); };
  }, [projectId]);
  /** Adds a job the studio just created, before the next poll lists it. */
  const add = useCallback((job: Job) => setOwn((list) => mergeJobs(list, [job])), []);
  // The app-wide poll has the freshest status of recent jobs.
  const jobs = mergeJobs(own, recent.filter((j) => j.project_id === projectId));
  return { jobs, loaded, add, error };
}

export function useStudioConfig() {
  const [voices, setVoices] = useState<StudioVoice[] | null>(null), [enabled, setEnabled] = useState(false), [error, setError] = useState("");
  const [video, setVideo] = useState<VideoConfig | null>(null);
  // Library avatars linked to HeyGen: ready for tiers that need a saved avatar.
  const [linkedAvatars, setLinkedAvatars] = useState<Set<string>>(new Set());
  const request = useRef(0);
  const loadVoices = useCallback(async () => {
    const n = ++request.current;
    try {
      const d = await api<{ enabled: boolean; voices: StudioVoice[] }>("/video-studio/config");
      if (!Array.isArray(d.voices)) throw new Error("Списъкът с гласове не се зареди. Опитайте отново.");
      if (n !== request.current) return;
      setEnabled(d.enabled); setVoices(d.voices); setError("");
    } catch (e) { if (n === request.current) setError((e as Error).message); }
  }, []);
  useEffect(() => {
    void loadVoices();
    const refresh = () => { void loadVoices(); };
    window.addEventListener("rech:studio-voices-changed", refresh);
    type Tier = { enabled: boolean; maxSeconds?: number; needsAvatar?: boolean; soon?: boolean };
    const each = <T,>(f: (t: VideoTier) => T) => ({ low: f("low"), medium: f("medium"), high: f("high") });
    api<{ enabled: boolean; emailNotifications: boolean; avatarMode?: boolean; tiers: Record<VideoTier, Tier> }>("/videos/config")
      .then((d) => setVideo({
        enabled: d.enabled, emailNotifications: d.emailNotifications, avatarMode: !!d.avatarMode,
        tiers: each((t) => !!d.tiers[t]?.enabled), maxSeconds: each((t) => d.tiers[t]?.maxSeconds ?? 60),
        needsAvatar: each((t) => !!d.tiers[t]?.needsAvatar), soon: each((t) => !!d.tiers[t]?.soon),
      }))
      .catch(() => setVideo({ enabled: false, emailNotifications: false, avatarMode: false, tiers: each(() => false), maxSeconds: each(() => 60), needsAvatar: each(() => false), soon: each(() => false) }));
    const loadAvatars = () => api<{ avatars: LibraryAvatar[] }>("/avatars")
      .then((d) => setLinkedAvatars(new Set(d.avatars.filter((a) => a.heygen).map((a) => a.id)))).catch(() => {});
    void loadAvatars();
    window.addEventListener("rech:avatars-changed", loadAvatars);
    const pending = request;
    return () => { pending.current++; window.removeEventListener("rech:studio-voices-changed", refresh); window.removeEventListener("rech:avatars-changed", loadAvatars); };
  }, [loadVoices]);
  return { voices, enabled, error, video, linkedAvatars, reloadVoices: loadVoices };
}

/** Length of an audio file (e.g. the project music), read from its metadata. */
export function useAudioDuration(url: string | null) {
  const [duration, setDuration] = useState(0);
  useEffect(() => {
    setDuration(0);
    if (!url) return;
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    audio.src = url;
    return () => { audio.onloadedmetadata = null; audio.src = ""; };
  }, [url]);
  return duration;
}

export type MyAvatars = ReturnType<typeof useMyAvatars>;
/** The user's own saved avatars ("Моите аватари"); followed while HeyGen creates one. */
export function useMyAvatars() {
  const [data, setData] = useState<{ avatars: UserAvatar[]; enabled: boolean; credits: number; max: number } | null>(null), [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      const d = await api<{ avatars?: UserAvatar[]; enabled?: boolean; credits?: number; max?: number }>("/my-avatars");
      // Never let an unexpected answer take the editor down.
      setData({ avatars: Array.isArray(d?.avatars) ? d.avatars : [], enabled: !!d?.enabled, credits: Number(d?.credits) || 0, max: Number(d?.max) || 0 });
      setError("");
    }
    catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const creating = !!data?.avatars?.some((a) => a.status === "processing");
  useEffect(() => {
    if (!creating) return;
    const timer = window.setInterval(() => { if (!document.hidden) void reload(); }, 8000);
    return () => window.clearInterval(timer);
  }, [creating, reload]);
  const ready = new Set((data?.avatars || []).filter((a) => a.status === "ready").map((a) => a.id));
  return { avatars: data?.avatars || [], enabled: !!data?.enabled, credits: data?.credits ?? 0, max: data?.max ?? 0, loaded: !!data, error, ready, reload };
}
