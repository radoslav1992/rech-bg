import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowDown, ArrowLeft, ArrowUp, Copy, Download, Film, Mic, Pause, Play, Plus, SkipBack, Sparkles, Trash2 } from "lucide-react";
import { api, Button, Notice, number, post, useAuth } from "../lib";
import { jobsChanged } from "../JobActivity";
import { uploadMedia, useMediaLibrary } from "../MediaTools";
import { TemplatePicker, useBrandKit } from "../BrandPanel";
import { portraitUrl, useProjectDocument } from "../project-document";
import { readLocalFile, removeLocalFile, takeLocalTimeline } from "../timeline";
import { lookOf } from "../../shared/brand";
import { canCreateVideo, VIDEO_PLAN_MESSAGE } from "../../shared/catalog";
import { defaultCaptions, type CaptionDocument } from "../../shared/captions";
import { newTextLayer, type Layer } from "../../shared/layers";
import { MAX_SCENES, newScene, scriptFingerprint, withScene, type ProjectPortrait, type ProjectScene } from "../../shared/project";
import { AvatarModal } from "./AvatarModal";
import { Modal } from "./Modal";
import { adoptedMedia, assetCaptionKey, captionId, isBusy, projectLayout, projectSpeech, readyClip, sceneMedia, shownCaptions, type SceneSegment } from "./model";
import { ClipPicker, ClipSection } from "./ClipPanel";
import { ScriptWriter, type WrittenScene } from "./ScriptWriter";
import { usePlayer } from "./Player";
import { ProjectTimeline, type Selection } from "./ProjectTimeline";
import { SceneInspector, type VideoRequest } from "./SceneInspector";
import { ElementInspector, ExportPanel, ProjectPanel } from "./Panels";
import { useCaptions } from "./useCaptions";
import { useAudioDuration, useMyAvatars, useProjectJobs, useStudioConfig } from "./useStudioData";
import "../video-studio.css";
import "../captions.css";
import "../timeline.css";
import "./studio.css";

const MAX_MUSIC_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** The video studio: one screen where scenes are written, voiced, given a presenter, arranged and exported. */
export function StudioEditor() {
  const { id } = useParams();
  return id ? <Editor key={id} projectId={id} /> : <NewProject />;
}

/** Starts a project: a title, or a saved template. */
function NewProject() {
  const navigate = useNavigate(), [params] = useSearchParams();
  const { user } = useAuth();
  const config = useStudioConfig();
  const [title, setTitle] = useState("Моята видео история"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const voice = config.voices?.[0]?.id;
  const create = async (written?: WrittenScene[]) => {
    if (!voice) return;
    setBusy(true); setError("");
    try {
      const { id } = await post<{ id: string }>("/projects", { title: title.trim(), mode: "studio", script: written?.[0]?.script || "", voice, second_voice: "boris", pause_ms: 0 });
      const avatar = params.get("avatar");
      // Written scenes are placed in the new project's document by the editor.
      navigate(`/app/video-studio/${id}${avatar ? `?avatar=${encodeURIComponent(avatar)}` : ""}`, { replace: true, state: written ? { written } : null });
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return <div className="video-studio st-new">
    <header className="vs-heading"><div><span className="eyebrow">ВИДЕО СТУДИО</span><h1>Нов видео проект.</h1>
      <p>Сцени, гласове, аватари, субтитри, музика и експорт — всичко на една времева линия.</p></div>
      <Link className="btn" to="/app/studio"><Mic size={17} /> Само аудио</Link></header>
    <section className="vs-card st-new-card">
      <h2>Започнете от празен проект</h2>
      {!canCreateVideo(user?.plan) && <Notice>{VIDEO_PLAN_MESSAGE} С текущия план можете да подготвите сцените и гласа. <Link to="/app/billing">Вижте плановете</Link></Notice>}
      {error && <Notice error>{error}</Notice>}
      {config.error && <Notice>{config.error}</Notice>}
      {config.voices && !voice && <Notice>В момента няма активни гласове за видео. Администраторът може да добави глас от настройките.</Notice>}
      <form onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <label>Име на проекта<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></label>
        <Button type="submit" className="btn primary" busy={busy} disabled={!title.trim() || !voice || busy}><Plus size={17} /> Създай проекта</Button>
      </form>
    </section>
    <section className="vs-card st-new-card">
      <h2><Sparkles size={20} /> Или започнете със сценарий от ИИ</h2>
      <p className="st-fine">Опишете темата — ИИ разделя текста на сцени, готови за глас, аватар или заснето видео.</p>
      <ScriptWriter action="Създай проекта с тези сцени" onUse={(written) => create(written)} />
    </section>
    <TemplatePicker />
  </div>;
}

function Editor({ projectId }: { projectId: string }) {
  const navigate = useNavigate(), [params, setParams] = useSearchParams(), location = useLocation();
  const { user, refresh } = useAuth();
  const config = useStudioConfig();
  const myAvatars = useMyAvatars();
  const project = useProjectDocument(projectId);
  const { jobs, loaded: jobsLoaded, add: addJob, error: pollingError } = useProjectJobs(projectId);
  const brand = useBrandKit();
  const { data: library, reload: reloadLibrary } = useMediaLibrary();
  const assets = useMemo(() => library?.assets || [], [library]);
  const [row, setRow] = useState<{ title: string; script: string; voice: string } | null>(null), [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [selection, setSelection] = useState<Selection>({ kind: "scene", scene: 0 });
  const [tab, setTab] = useState<"scene" | "element" | "project">("scene");
  // The scene (by id, so a reorder while the dialog is open cannot misplace the choice) choosing a presenter.
  const [avatarFor, setAvatarFor] = useState<string | null>(null), [exportOpen, setExportOpen] = useState(false);
  const [sending, setSending] = useState<{ scene: string; what: "audio" | "video" } | null>(null);
  const [musicUpload, setMusicUpload] = useState<number | null>(null);
  const [adding, setAdding] = useState<"clip" | "writer" | null>(null);
  const musicInput = useRef<HTMLInputElement>(null), keys = useRef(new Map<string, string>());

  // The project row keeps the title (and mirrors the first scene for the project list).
  useEffect(() => {
    let live = true;
    api(`/projects/${projectId}`).then(({ project: p }) => {
      if (!live) return;
      if (p.mode !== "studio") { navigate(`/app/studio/${projectId}`, { replace: true }); return; }
      setRow({ title: p.title, script: p.script, voice: p.voice }); setTitle(p.title);
    }).catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [projectId]);

  const doc = project.doc;
  const scenes = doc?.scenes || [];
  const sceneIndex = selection.kind === "music" || selection.kind === "project" ? -1 : Math.min(selection.scene, scenes.length - 1);
  const focusIndex = Math.max(0, sceneIndex);
  const media = useMemo(() => doc ? doc.scenes.map((_, i) => sceneMedia(doc, i, jobs)) : [], [doc, jobs]);
  // Captions of the recordings and of the transcribed filmed clips.
  const captionSources = [
    ...media.map((m) => m.audio?.status === "completed" ? m.audio.id : null),
    ...scenes.map((s) => s.clip && assets.find((a) => a.id === s.clip!.assetId)?.hasCaptions ? assetCaptionKey(s.clip.assetId) : null),
  ].filter((x): x is string => !!x);
  const captions = useCaptions([...new Set(captionSources)]);
  // What the scenes show: a filmed clip's transcript follows its cuts.
  const shown = useMemo(() => doc ? shownCaptions(doc, captions.docs) : captions.docs, [doc, captions.docs]);
  const first0 = doc?.scenes[0];
  const firstSource = first0?.clip ? assetCaptionKey(first0.clip.assetId) : media[0]?.audio?.status === "completed" ? media[0].audio.id : null;
  // Frame size and fit follow the first scene, as in the server render.
  // The project's look applies on top (a filmed clip's transcript keeps the look it was transcribed with).
  const look: CaptionDocument = { ...((firstSource && captions.docs[firstSource]) || defaultCaptions), ...(doc?.captionLook || {}) };
  const { segments, total } = useMemo(() => doc ? projectLayout(doc, media, assets) : { segments: [], total: 0 }, [doc, media, assets]);
  const sceneSegments = segments.filter((s): s is SceneSegment => s.kind === "scene");
  const ranges = useMemo(() => doc ? projectSpeech(doc, segments, shown, media) : [], [doc, segments, shown, media]);
  const player = usePlayer({ doc: doc || { version: 1, scenes: [], music: null, intro: null, outro: null, captionLook: null }, segments, total, media, captions: shown, look, assets, ranges });
  const musicDuration = useAudioDuration(doc?.music ? `/api/media/assets/${doc.music.assetId}/file` : null);
  const update = project.update;
  const changeScene = (index: number, change: (s: ProjectScene) => ProjectScene) => update((d) => withScene(d, index, change));

  // Scenes follow their jobs: a finished recording or video is picked up without a click.
  useEffect(() => {
    if (!doc || !jobsLoaded) return;
    const changes = doc.scenes.map((_, i) => adoptedMedia(doc, i, media[i]));
    if (changes.some(Boolean)) update((d) => ({ ...d, scenes: d.scenes.map((s, i) => {
      const change = changes[i];
      if (!change || s.id !== doc.scenes[i].id) return s;
      // A recording adopted from the server (e.g. made just before the editor closed) joins the scene's history.
      const history = change.audioJobId && !s.history.includes(change.audioJobId) ? [change.audioJobId, ...s.history].slice(0, 20) : s.history;
      return { ...s, ...change, history };
    }) }));
  }, [doc, media, jobsLoaded]);
  // Scenes written by the AI on the new project page.
  useEffect(() => {
    const written = (location.state as { written?: WrittenScene[] } | null)?.written;
    if (!doc || !written?.length) return;
    const pristine = doc.scenes.length === 1 && !doc.scenes[0].script.trim() && !doc.scenes[0].clip;
    if (pristine) update((d) => ({ ...d, scenes: written.slice(0, MAX_SCENES).map((w) => newScene({ title: w.title, script: w.script, voice: d.scenes[0].voice })) }));
    navigate(location.pathname + location.search, { replace: true, state: null });
  }, [!!doc]);
  // Earlier versions kept the first script in the project row and some settings only in this browser.
  const migrated = useRef(false);
  useEffect(() => {
    if (!doc || !row || !user || migrated.current) return;
    migrated.current = true;
    const first = doc.scenes[0];
    if (!first.script && row.script) changeScene(0, (s) => ({ ...s, script: row.script, voice: s.voice || row.voice }));
    const audio = first.audioJobId;
    const local = audio && !doc.music && first.speechStart === 0 && first.tail === 0 ? takeLocalTimeline(user.id, audio) : null;
    if (local) {
      changeScene(0, (s) => ({ ...s, speechStart: local.speechStart, tail: local.tail, voiceVolume: local.voiceVolume }));
      const music = local.music, key = `music:${user.id}:${audio}`;
      if (music) readLocalFile(key).then(async (file) => {
        if (!(file instanceof Blob)) return;
        const assetId = await uploadMedia(new File([file], music.name, { type: file.type }), "music", () => {});
        update((d) => ({ ...d, music: { assetId, ...music } }));
        void removeLocalFile(key);
      }).catch(() => { /* The music can be added again. */ });
    }
    if (!first.portrait) readLocalFile(`portrait:${user.id}:${projectId}`).then(async (p) => {
      if (!p) return;
      const asset = typeof p === "string" ? /^\/api\/media\/assets\/([0-9a-f-]{36})\/file$/.exec(p)?.[1] : undefined;
      const id = asset || (p instanceof Blob ? await uploadMedia(new File([p], "portrait.jpg", { type: p.type }), "portrait", () => {}) : undefined);
      if (id) { changeScene(0, (s) => s.portrait ? s : { ...s, portrait: { type: "asset", id } }); void removeLocalFile(`portrait:${user.id}:${projectId}`); }
    }).catch(() => {});
  }, [doc, row, user]);
  // New scenes and templates start without a voice: use the project's.
  useEffect(() => {
    // Waits for the project row, whose voice new scenes should use.
    if (!doc || !row || !config.voices?.length) return;
    const fallback = config.voices.some((v) => v.id === row.voice) ? row.voice : config.voices[0].id;
    if (doc.scenes.some((s) => !s.voice)) update((d) => ({ ...d, scenes: d.scenes.map((s) => s.voice ? s : { ...s, voice: fallback }) }));
  }, [doc, config.voices, row]);
  // Links from the media library (?avatar=) and from finished jobs (?job=).
  useEffect(() => {
    if (!doc) return;
    const avatar = params.get("avatar"), job = params.get("job");
    if (avatar && /^[0-9a-f-]{36}$/.test(avatar)) changeScene(focusIndex, (s) => ({ ...s, portrait: { type: "asset", id: avatar } }));
    if (job && jobsLoaded) {
      const found = media.findIndex((m) => m.audios.some((a) => a.id === job) || m.videos.some((v) => v.id === job));
      if (found >= 0) { setSelection({ kind: "scene", scene: found }); setTab("scene"); }
    }
    if (avatar || (job && jobsLoaded)) setParams({}, { replace: true });
  }, [!!doc, jobsLoaded]);

  // Title and the first scene are mirrored to the project row after a pause.
  const first = scenes[0];
  useEffect(() => {
    if (!row || !first || !title.trim()) return;
    const voice = config.voices?.some((v) => v.id === first.voice) ? first.voice! : row.voice;
    if (title === row.title && first.script === row.script && voice === row.voice) return;
    const timer = window.setTimeout(() => {
      api(`/projects/${projectId}`, { method: "PUT", body: JSON.stringify({ title: title.trim(), mode: "studio", script: first.script, voice, second_voice: "boris", pause_ms: 0 }) })
        .then(() => setRow({ title, script: first.script, voice })).catch((e) => setError((e as Error).message));
    }, 900);
    return () => window.clearTimeout(timer);
  }, [title, first?.script, first?.voice, row, config.voices]);

  const select = (s: Selection) => { setSelection(s); setTab(s.kind === "scene" ? "scene" : s.kind === "project" ? "project" : "element"); };
  const addScene = (copy?: ProjectScene) => {
    if (!doc || doc.scenes.length >= MAX_SCENES) return;
    const base = doc.scenes[focusIndex];
    const scene = copy
      ? newScene({ title: copy.title, script: copy.script, voice: copy.voice, portrait: copy.portrait, background: copy.background, speechStart: copy.speechStart, tail: copy.tail, voiceVolume: copy.voiceVolume, clip: copy.clip, layers: copy.layers.map((l) => ({ ...l, id: crypto.randomUUID() })) })
      : newScene({ voice: base?.voice ?? null, portrait: base?.portrait ?? null, background: base?.background ?? null });
    insertScenes([scene]);
  };
  /** Puts scenes after the focused one; an untouched first scene is replaced instead of kept empty. */
  const insertScenes = (added: ProjectScene[]) => {
    if (!doc || !added.length) return;
    const blank = doc.scenes.length === 1 && !doc.scenes[0].script.trim() && !doc.scenes[0].clip && !doc.scenes[0].audioJobId && !doc.scenes[0].layers.length;
    const at = blank ? 0 : Math.min(doc.scenes.length, focusIndex + 1);
    const room = MAX_SCENES - (blank ? 0 : doc.scenes.length), list = added.slice(0, room);
    if (!list.length) return;
    update((d) => ({ ...d, scenes: blank ? list : [...d.scenes.slice(0, at), ...list, ...d.scenes.slice(at)] }));
    select({ kind: "scene", scene: at });
  };
  const addClipScene = (assetId: string) => {
    const base = doc?.scenes[focusIndex];
    insertScenes([newScene({ voice: base?.voice ?? null, background: base?.background ?? null, clip: { assetId, keep: null, clean: true } })]);
    setAdding(null); void reloadLibrary();
  };
  const addWritten = (written: WrittenScene[]) => {
    const base = doc?.scenes[focusIndex];
    insertScenes(written.map((w) => newScene({ title: w.title, script: w.script, voice: base?.voice ?? null, portrait: base?.portrait ?? null, background: base?.background ?? null })));
    setAdding(null);
  };
  const removeScene = (i: number) => {
    if (scenes.length < 2 || !confirm(`Да изтрием ли сцена ${i + 1}? Създадените записи остават в историята на проекта.`)) return;
    update((d) => ({ ...d, scenes: d.scenes.filter((_, n) => n !== i) }));
    select({ kind: "scene", scene: Math.max(0, i - 1) });
  };
  const moveScene = (i: number, by: -1 | 1) => {
    update((d) => { const next = [...d.scenes]; [next[i], next[i + by]] = [next[i + by], next[i]]; return { ...d, scenes: next }; });
    select({ kind: "scene", scene: i + by });
  };

  const generateAudio = async (index: number, credits: number) => {
    const scene = scenes[index];
    if (!scene) return;
    const keyName = `${scene.id}:${scriptFingerprint(scene.voice, scene.script)}:${credits}`;
    const key = keys.current.get(keyName) || crypto.randomUUID();
    keys.current.set(keyName, key);
    setSending({ scene: scene.id, what: "audio" }); setError("");
    try {
      // The server reads the scene's script from the saved project.
      await project.flush();
      const { id: jobId } = await post<{ id: string }>("/generate", { projectId, idempotencyKey: key, credits, sceneId: scene.id });
      const { job } = await api(`/jobs/${jobId}`);
      addJob(job);
      update((d) => ({
        ...d,
        scenes: d.scenes.map((s) => s.id !== scene.id ? s : {
          ...s, history: [jobId, ...s.history.filter((h) => h !== jobId)].slice(0, 20),
          audioFor: scriptFingerprint(scene.voice, scene.script), audioJobId: jobId, videoJobId: null,
        }),
      }));
      keys.current.delete(keyName); jobsChanged(); await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setSending(null); }
  };
  const portraitFile = async (portrait: ProjectPortrait): Promise<File | string> => {
    // Library avatars go by ID: the server reads the portrait (and its saved video avatar).
    if (portrait.type === "library") return `library:${portrait.id}`;
    if (portrait.type === "avatar") return `user:${portrait.id}`;
    if (portrait.type === "asset") {
      const asset = assets.find((a) => a.id === portrait.id);
      // Portraits and product avatars go by reference; other images are sent as a file.
      if (!asset || asset.kind === "portrait" || asset.kind === "variant") return portrait.id;
    }
    const response = await fetch(portraitUrl(portrait));
    if (!response.ok) throw new Error("Аватарът вече не е наличен. Изберете друг.");
    const blob = await response.blob();
    if (!["image/jpeg", "image/png"].includes(blob.type) || blob.size > MAX_IMAGE_BYTES)
      throw new Error("Това изображение не може да се използва за видео. Изберете JPG или PNG до 2 MB или портрет от библиотеката.");
    return new File([blob], `avatar.${blob.type === "image/png" ? "png" : "jpg"}`, { type: blob.type });
  };
  const createVideo = async (index: number, request: VideoRequest, credits: number) => {
    const scene = scenes[index], audio = media[index]?.audio;
    if (!scene?.portrait || audio?.status !== "completed") return;
    const keyName = `video:${audio.id}:${request.tier}:${JSON.stringify(scene.portrait)}`;
    const key = keys.current.get(keyName) || crypto.randomUUID();
    keys.current.set(keyName, key);
    setSending({ scene: scene.id, what: "video" }); setError("");
    try {
      const image = await portraitFile(scene.portrait);
      const body = new FormData();
      body.set("sourceId", audio.id); body.set("tier", request.tier); body.set("idempotencyKey", key);
      body.set("credits", String(credits)); body.set("consent", String(request.consent)); body.set("notifyEmail", String(request.notifyEmail));
      if (typeof image !== "string") body.set("image", image);
      else if (image.startsWith("library:")) body.set("libraryAvatarId", image.slice("library:".length));
      else if (image.startsWith("user:")) body.set("userAvatarId", image.slice("user:".length));
      else body.set("assetId", image);
      const result = await api<{ id: string }>("/videos", { method: "POST", body });
      const { job } = await api(`/jobs/${result.id}`);
      addJob(job);
      update((d) => ({ ...d, scenes: d.scenes.map((s) => s.id === scene.id && s.audioJobId === audio.id ? { ...s, videoJobId: job.id } : s) }));
      keys.current.delete(keyName); jobsChanged(); await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setSending(null); }
  };
  const selectAudio = (index: number, audioId: string) => {
    const videos = media[index].videos.filter((v) => v.source_job_id === audioId);
    changeScene(index, (s) => ({ ...s, audioJobId: audioId, videoJobId: videos.find((v) => v.status === "completed")?.id ?? null }));
  };
  const layerWindow = (index: number) => {
    const seg = sceneSegments.find((s) => s.index === index);
    const length = seg?.length || 3, local = seg ? player.time.current - seg.start : 0;
    const start = Math.round(Math.min(Math.max(0, local), Math.max(0, length - .5)) * 100) / 100;
    return { start, end: Math.round(Math.min(length, start + 3) * 100) / 100, length };
  };
  const addLayer = (index: number, layer: Layer) => { changeScene(index, (s) => ({ ...s, layers: [...s.layers, layer] })); select({ kind: "layer", scene: index, id: layer.id }); };
  const addTextOrLogo = (index: number, type: Layer["type"] | "logo") => {
    const { start, end, length } = layerWindow(index), kit = brand.kit;
    if (type === "logo" && kit?.logo) {
      const { assetId, position, width, opacity } = kit.logo;
      addLayer(index, { id: crypto.randomUUID(), type: "image", assetId, start: 0, end: Math.round(length * 100) / 100, position, width, opacity });
    } else if (type === "text") {
      const layer = newTextLayer(start, end);
      if (kit) { layer.color = kit.colors.text; layer.box = kit.colors.secondary; }
      addLayer(index, layer);
    }
  };
  const addMediaLayer = (index: number, type: "image" | "broll", assetId: string) => {
    const { start, end } = layerWindow(index), id = crypto.randomUUID();
    addLayer(index, type === "image"
      ? { id, type: "image", assetId, start, end, position: "top-right", width: .25, opacity: 1 }
      : { id, type: "broll", assetId, start, end, trim: 0 });
  };
  const addMusic = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_MUSIC_BYTES) { setError("Изберете аудиофайл до 50 MB."); return; }
    setError(""); setMusicUpload(0);
    try {
      const assetId = await uploadMedia(file, "music", setMusicUpload);
      update((d) => ({ ...d, music: { assetId, name: file.name.slice(0, 120), start: 0, volume: d.music?.volume ?? .35, duck: d.music?.duck ?? true, fade: d.music?.fade ?? true } }));
      select({ kind: "music" }); void reloadLibrary();
    } catch (e) { setError((e as Error).message); }
    finally { setMusicUpload(null); }
  };
  // The caption look is one for the whole video: every recording, and new ones through the project.
  const editLook = (change: Partial<CaptionDocument>) => {
    captions.editAll(change);
    update((d) => ({ ...d, captionLook: lookOf({ ...look, ...change }) }));
  };
  const saveAll = async () => { await captions.flush(); await project.flush(); };

  useEffect(() => {
    const pending = project.saveState !== "saved" || captions.saveState !== "saved" || sending !== null;
    if (!pending) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [project.saveState, captions.saveState, sending]);

  if (error && !row) return <div className="video-studio"><Notice error>{error}</Notice><p><Link to="/app/projects">Моите проекти</Link> · <Link to="/app/video-studio">Нов видео проект</Link></p></div>;
  if (!doc || !row) return <div className="video-studio">{project.error ? <Notice error>{project.error}</Notice> : <p role="status">Зареждане на студиото…</p>}</div>;

  // A portrait that video tiers needing a saved avatar accept: a linked library avatar or a ready own avatar.
  const savedAvatarReady = (p: ProjectPortrait | null) =>
    !!p && ((p.type === "library" && config.linkedAvatars.has(p.id)) || (p.type === "avatar" && myAvatars.ready.has(p.id)));
  const needsSavedAvatar = !!config.video && Object.values(config.video.needsAvatar).some(Boolean);
  const scene = doc.scenes[focusIndex], sceneSeg = sceneSegments.find((s) => s.index === focusIndex) || null;
  const remaining = Math.max(0, (user?.limit || 0) - (user?.used || 0));
  const saveLabel = project.saveState === "error" || captions.saveState === "error" ? "Не е запазено"
    : project.saveState !== "saved" || captions.saveState !== "saved" ? "Запазване…" : "Всичко е запазено";
  const readyScenes = scenes.filter((s, i) => s.clip ? !!readyClip(s, assets) : media[i].video?.status === "completed" && media[i].audio?.status === "completed").length;
  const captionScene = selection.kind === "caption" ? doc.scenes[selection.scene] : null;
  const captionKey = captionScene ? captionId(captionScene, media[selection.kind === "caption" ? selection.scene : 0]) : null;
  const elementCaptions = captionKey ? shown[captionKey] || null : null;
  /** Caption edits go to the recording's document, or to the clip's transcript (its words stay as transcribed). */
  const editSceneCaptions = (index: number, change: (d: CaptionDocument) => CaptionDocument) => {
    const s = doc.scenes[index];
    if (s?.clip) captions.edit(assetCaptionKey(s.clip.assetId), (d) => ({ ...change(d), words: d.words }));
    else { const id = media[index]?.audio?.id; if (id) captions.edit(id, change); }
  };

  return <div className="st-editor">
    <header className="st-top">
      <Link className="round" to="/app/projects" aria-label="Към проектите"><ArrowLeft size={18} /></Link>
      <label className="st-title"><span className="sr-only">Име на проекта</span><input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></label>
      <span className={`st-save${saveLabel === "Не е запазено" ? " error" : ""}`} role="status">{saveLabel}</span>
      <span className="st-credits">{number(remaining)} кредита</span>
      <Button className="btn primary" onClick={() => { player.pause(); setExportOpen(true); }}><Download size={16} /> Експорт{readyScenes < scenes.length ? ` · ${readyScenes}/${scenes.length}` : ""}</Button>
    </header>
    {!canCreateVideo(user?.plan) && <Notice>{VIDEO_PLAN_MESSAGE} Можете да подготвите сцените и гласа; видеото се отключва с по-висок план. <Link to="/app/billing">Вижте плановете</Link></Notice>}
    {error && <Notice error>{error} <button type="button" className="text-link" onClick={() => setError("")}>Скрий</button></Notice>}
    {pollingError && <Notice>{pollingError}</Notice>}
    {project.conflict && <Notice>{project.conflict}</Notice>}
    {project.error && <Notice error>{project.error}</Notice>}
    {config.error && <Notice>{config.error} <button type="button" className="text-link" onClick={() => void config.reloadVoices()}>Опитай отново</button></Notice>}

    <div className="st-main">
      <nav className="st-rail" aria-label="Сцени">
        <div className="st-rail-head"><strong>Сцени · {scenes.length}</strong><span>{Math.round(total)} сек.</span></div>
        <ol>{scenes.map((s, i) => {
          const m = media[i], thumb = portraitUrl(s.portrait), seg = sceneSegments.find((x) => x.index === i);
          const active = selection.kind !== "music" && selection.kind !== "project" && focusIndex === i;
          const status = s.clip ? readyClip(s, assets) ? ["ready", s.clip.keep ? "Заснето · монтаж" : "Заснето"] : ["working", "Проверка"]
            : m.video?.status === "completed" ? ["ready", "Видео"] : m.pendingVideo || isBusy(m.audio) ? ["working", "Създава се"]
            : m.audio?.status === "completed" ? [m.stale ? "stale" : "voice", m.stale ? "Променен" : "Глас"] : ["none", "Чернова"];
          return <li key={s.id} className={active ? "active" : ""}>
            <button type="button" className="st-rail-open" aria-current={active ? "true" : undefined} onClick={() => { select({ kind: "scene", scene: i }); if (seg) player.seek(seg.start); }}>
              <span className="st-thumb">{thumb ? <img src={thumb} alt="" /> : s.clip ? <Film size={18} aria-hidden="true" /> : <span>{i + 1}</span>}</span>
              <span className="st-rail-text"><strong>{i + 1}. {s.title || `Сцена ${i + 1}`}</strong>
                <small>{s.clip ? assets.find((a) => a.id === s.clip!.assetId)?.name || "Заснето видео" : s.script.replace(/\[[^\]]*\]/g, "").trim().slice(0, 48) || "Празен сценарий"}</small>
                <span className={`st-badge ${status[0]}`}>{status[1]}{seg && !seg.estimated ? ` · ${seg.length.toFixed(1)} с.` : ""}</span></span>
            </button>
            {active && <div className="st-rail-tools">
              <button type="button" className="round" aria-label="Премести сцената нагоре" disabled={i === 0} onClick={() => moveScene(i, -1)}><ArrowUp size={14} /></button>
              <button type="button" className="round" aria-label="Премести сцената надолу" disabled={i === scenes.length - 1} onClick={() => moveScene(i, 1)}><ArrowDown size={14} /></button>
              <button type="button" className="round" aria-label="Дублирай сцената" disabled={scenes.length >= MAX_SCENES} onClick={() => addScene(s)}><Copy size={14} /></button>
              <button type="button" className="round" aria-label="Изтрий сцената" disabled={scenes.length === 1} onClick={() => removeScene(i)}><Trash2 size={14} /></button>
            </div>}
          </li>;
        })}</ol>
        <button type="button" className="btn st-rail-add" disabled={scenes.length >= MAX_SCENES} onClick={() => addScene()}><Plus size={16} /> Сцена с аватар</button>
        <div className="st-add-menu">
          <button type="button" className="btn" disabled={scenes.length >= MAX_SCENES} onClick={() => { player.pause(); setAdding("clip"); }}><Film size={15} /> Заснето видео</button>
          <button type="button" className="btn" disabled={scenes.length >= MAX_SCENES} onClick={() => { player.pause(); setAdding("writer"); }}><Sparkles size={15} /> Сцени с ИИ</button>
        </div>
      </nav>

      <section className="st-stage" aria-label="Преглед">
        <div className="st-canvas"><canvas ref={player.canvas} onClick={player.toggle} aria-label="Преглед на видеото — щракнете за пускане и пауза" style={{ aspectRatio: look.format.replace(":", "/") }} /></div>
        <div className="st-transport">
          <button type="button" className="btn" aria-label="Към началото" onClick={() => player.seek(0)}><SkipBack size={16} /></button>
          <button type="button" className="btn dark st-play" onClick={player.toggle}>{player.playing ? <Pause size={16} /> : <Play size={16} />} {player.playing ? "Пауза" : "Пусни"}</button>
          <span ref={player.timecode} className="tl-timecode">0:00.0</span>
        </div>
        <p className="st-fine">Прегледът показва портрета, докато видеото на сцената се създава. Сцените без глас се показват с приблизителна дължина.</p>
      </section>

      <aside className="st-inspector" aria-label="Настройки">
        <div className="st-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "scene"} onClick={() => { setTab("scene"); if (sceneIndex < 0) setSelection({ kind: "scene", scene: focusIndex }); }}>Сцена {focusIndex + 1}</button>
          <button type="button" role="tab" aria-selected={tab === "element"} onClick={() => setTab("element")}>Избран клип</button>
          <button type="button" role="tab" aria-selected={tab === "project"} onClick={() => setTab("project")}>Проект</button>
        </div>
        {tab === "scene" && scene && <SceneInspector scene={scene} index={focusIndex} media={media[focusIndex]} voices={config.voices || []} studioEnabled={config.enabled}
          videoConfig={config.video} avatarReady={savedAvatarReady(scene.portrait)} avatarCredits={myAvatars.enabled ? myAvatars.credits : 0} fit={look.fit || "contain"} assets={assets} hasLogo={!!brand.kit?.logo}
          busy={sending?.scene === scene.id ? sending.what : null}
          onChange={(change) => changeScene(focusIndex, change)}
          onGenerateAudio={(credits) => void generateAudio(focusIndex, credits)}
          onCreateVideo={(request, credits) => void createVideo(focusIndex, request, credits)}
          onChooseAvatar={() => setAvatarFor(scene.id)}
          onSelectAudio={(audioId) => selectAudio(focusIndex, audioId)}
          onSelectVideo={(videoId) => changeScene(focusIndex, (s) => ({ ...s, videoJobId: videoId }))}
          onAddLayer={(type) => addTextOrLogo(focusIndex, type)}
          onAddMediaLayer={(type, assetId) => addMediaLayer(focusIndex, type, assetId)}
          clip={scene.clip ? <ClipSection scene={scene} clip={scene.clip} assets={assets} tasks={library?.tasks || []}
            source={captions.docs[assetCaptionKey(scene.clip.assetId)] || null}
            onChange={(change) => changeScene(focusIndex, change)} onChanged={() => void reloadLibrary()} /> : undefined} />}
        {tab === "element" && <ElementInspector selection={selection} doc={doc} segment={selection.kind === "layer" ? sceneSegments.find((s) => s.index === selection.scene) || null : sceneSeg}
          captions={elementCaptions} assets={assets} update={update} onSelect={select} onReplaceMusic={() => musicInput.current?.click()}
          editCaptions={(change) => { if (selection.kind === "caption") editSceneCaptions(selection.scene, change); }} />}
        {tab === "project" && <ProjectPanel projectId={projectId} doc={doc} look={look} update={update} editLook={editLook}
          brand={brand.kit} onSaveBrand={brand.save} captionSource={media[focusIndex]?.audio?.status === "completed" ? media[focusIndex].audio!.id : null}
          sceneLengths={sceneSegments.map((s) => s.length)} onCaptionsChanged={captions.reload} />}
      </aside>
    </div>

    <ProjectTimeline doc={doc} segments={segments} total={total} media={media} captions={shown} assets={assets}
      selection={selection} player={player} musicDuration={musicDuration} musicUpload={musicUpload}
      onSelect={select} update={update} editCaptions={captions.edit} onAddScene={() => addScene()} onAddMusic={() => musicInput.current?.click()} />
    <input ref={musicInput} type="file" hidden style={{ display: "none" }} accept="audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,audio/aac,audio/ogg,.mp3,.wav,.m4a,.ogg"
      onChange={(e) => { void addMusic(e.target.files?.[0]); e.target.value = ""; }} />
    {player.elements}

    <AvatarModal open={avatarFor !== null} linkedAvatars={needsSavedAvatar ? config.linkedAvatars : null} myAvatars={config.video?.avatarMode ? myAvatars : null} selected={doc.scenes.find((s) => s.id === avatarFor)?.portrait ?? null} onClose={() => setAvatarFor(null)}
      onSelect={(portrait) => { if (avatarFor) update((d) => ({ ...d, scenes: d.scenes.map((s) => s.id === avatarFor ? { ...s, portrait } : s) })); }} />
    <Modal open={exportOpen} title="Експорт на видеото" onClose={() => setExportOpen(false)}>
      <ExportPanel projectId={projectId} doc={doc} media={media} segments={sceneSegments} captions={shown} look={look} assets={assets} onSave={saveAll} />
    </Modal>
    <Modal open={adding === "clip"} title="Сцена от заснето видео" onClose={() => setAdding(null)}>
      <p className="st-fine">Качете видео, в което говорите пред камерата. Сцената използва вашия образ и звук — после изрежете паузите с „Мигновен монтаж“ и добавете субтитри, текст, лого и музика като във всяка сцена.</p>
      <ClipPicker assets={assets} onPick={addClipScene} />
    </Modal>
    <Modal open={adding === "writer"} title="Сцени от ИИ сценарист" onClose={() => setAdding(null)}>
      <ScriptWriter action="Добави сцените в проекта" onUse={addWritten} />
    </Modal>
  </div>;
}

