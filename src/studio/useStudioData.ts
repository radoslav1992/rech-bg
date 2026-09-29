import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Job } from "../lib";
import { useJobs } from "../JobActivity";
import { mergeJobs } from "../job-state";
import type { StudioVoice } from "../../shared/studio";
import type { VideoTier } from "../../shared/video";
import type { LibraryAvatar } from "../../shared/avatars";
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
  // Library avatars linked to HeyGen: the only ones Medium accepts when the server says so.
  const [mediumAvatars, setMediumAvatars] = useState<Set<string>>(new Set());
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
    api<{ enabled: boolean; emailNotifications: boolean; mediumLibraryOnly?: boolean; tiers: Record<VideoTier, { enabled: boolean }> }>("/videos/config")
      .then((d) => setVideo({
        enabled: d.enabled, emailNotifications: d.emailNotifications, mediumLibraryOnly: !!d.mediumLibraryOnly,
        tiers: { low: !!d.tiers.low?.enabled, medium: !!d.tiers.medium?.enabled, high: !!d.tiers.high?.enabled },
      }))
      .catch(() => setVideo({ enabled: false, emailNotifications: false, mediumLibraryOnly: false, tiers: { low: false, medium: false, high: false } }));
    const loadAvatars = () => api<{ avatars: LibraryAvatar[] }>("/avatars")
      .then((d) => setMediumAvatars(new Set(d.avatars.filter((a) => a.heygen).map((a) => a.id)))).catch(() => {});
    void loadAvatars();
    window.addEventListener("rech:avatars-changed", loadAvatars);
    const pending = request;
    return () => { pending.current++; window.removeEventListener("rech:studio-voices-changed", refresh); window.removeEventListener("rech:avatars-changed", loadAvatars); };
  }, [loadVoices]);
  return { voices, enabled, error, video, mediumAvatars, reloadVoices: loadVoices };
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
