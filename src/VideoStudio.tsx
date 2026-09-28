import { ProductAvatarPanel, uploadMedia } from "./MediaTools";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Film, Mic, Sparkles, Save, Check, ArrowRight } from "lucide-react";
import { api, post, Button, Disclosure, Notice, number, useAuth, type Job } from "./lib";
import { jobsChanged, jobStatus, useJobs } from "./JobActivity";
import { emotionTags, estimateSpeechSeconds, studioMaxChars, validateStudioScript, validateSuggestedDelivery } from "../shared/studio";
import { MAX_VIDEO_SECONDS, MIN_VIDEO_SECONDS } from "../shared/video";
import { StudioVoicePicker } from "./StudioVoicePicker";
import type { StudioVoice } from "../shared/studio";
import { VideoPanel } from "./VideoPanel";
import { mergeJobs } from "./job-state";
import { TimelineEditor } from "./TimelineEditor";
import { readLocalFile, removeLocalFile, takeLocalTimeline } from "./timeline";
import { portraitUrl as referenceUrl, useProjectDocument } from "./project-document";
import { newScene, sceneTimeline, scriptFingerprint, withScene, withTimeline, type ProjectPortrait } from "../shared/project";
import { SceneStrip, type SceneStatus } from "./SceneStrip";
import { BrandPanel, TemplatePicker, useBrandKit } from "./BrandPanel";
import { defaultCaptions } from "../shared/captions";
import { BackgroundExport } from "./MediaTools";
import "./video-studio.css";

export function VideoStudio() {
  const { id } = useParams(), navigate = useNavigate(), [params] = useSearchParams();
  const [productAvatar,setProductAvatar] = useState(params.get("avatar") || "");
  const { user, refresh } = useAuth(), { jobs: allJobs, error: pollingError } = useJobs();
  const [title, setTitle] = useState("Моята видео история"), [script, setScript] = useState(""), [voice, setVoice] = useState<string>("");
  const [voices, setVoices] = useState<readonly StudioVoice[]>([]);
  const [voiceError, setVoiceError] = useState(""), [voicesLoaded, setVoicesLoaded] = useState(false);
  const catalogRequest = useRef(0);
  const [enabled, setEnabled] = useState(false), [loading, setLoading] = useState(!!id), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [dirty, setDirty] = useState(false), [tone, setTone] = useState("ad"), [suggestion, setSuggestion] = useState(""), [undo, setUndo] = useState<string | null>(null);
  const [assisting, setAssisting] = useState(false), [assistError, setAssistError] = useState("");
  const assistRequest = useRef<AbortController | null>(null);
  const locked = busy || assisting;
  const [selectedAudio, setSelectedAudio] = useState(""), [approved, setApproved] = useState(""), [selectedVideo, setSelectedVideo] = useState("");
  const [localJobs, setLocalJobs] = useState<Job[]>([]);
  const [videoFormKey, setVideoFormKey] = useState(() => crypto.randomUUID());
  const projectId = useRef(id), key = useRef(crypto.randomUUID()), editor = useRef<HTMLTextAreaElement>(null), skipLoad = useRef("");
  // The project (scenes, timeline, portrait and music references) is saved on the server.
  const project = useProjectDocument(id);
  const brand = useBrandKit();
  // Bumped when captions of existing recordings change outside the editor (e.g. applying the brand).
  const [captionsVersion, setCaptionsVersion] = useState(0);
  const [sceneIndex, setSceneIndex] = useState(0);
  const scenes = project.doc?.scenes || [];
  const sceneAt = Math.min(sceneIndex, Math.max(0, scenes.length - 1));
  const scene = scenes[sceneAt] || null;
  const multi = scenes.length > 1;
  // Recordings belong to the scene whose history lists them; older recordings belong to the first scene.
  const projectJobs = mergeJobs(localJobs, allJobs).filter(j => j.project_id === id).sort((a, b) => b.created_at - a.created_at);
  const audioOwner = (jobId: string) => {
    const i = scenes.findIndex(s => s.history.includes(jobId) || s.audioJobId === jobId);
    return i < 0 ? 0 : i;
  };
  const sceneOf = (j: Job) => audioOwner(j.kind === "video" ? j.source_job_id || "" : j.id);
  const jobs = projectJobs.filter(j => sceneOf(j) === sceneAt);
  const audioJobs = jobs.filter(j => j.kind !== "video"), videoJobs = jobs.filter(j => j.kind === "video");
  const audio = audioJobs.find(j => j.id === selectedAudio) || audioJobs[0] || null;
  // Approval is page state; a voice that already has a video was approved before, so it stays approved after reload.
  const audioApproved = !!audio && (audio.id === approved || videoJobs.some(v => v.source_job_id === audio.id));
  const video = videoJobs.find(j => j.id === selectedVideo) || videoJobs[0] || null;
  const activeJob = mergeJobs(localJobs.filter(j => j.project_id === id), allJobs).find(j => ["queued", "running"].includes(j.status)) || null;
  const active = !!activeJob;
  // The timeline edits one voice version; its completed avatar video replaces the portrait preview.
  const explicitVideo = videoJobs.find(j => j.id === selectedVideo && j.status === "completed");
  const timelineAudio = (explicitVideo && audioJobs.find(j => j.id === explicitVideo.source_job_id && j.status === "completed")) || (audio?.status === "completed" ? audio : null);
  const timelineVideo = timelineAudio ? (explicitVideo?.source_job_id === timelineAudio.id ? explicitVideo : videoJobs.find(j => j.source_job_id === timelineAudio.id && j.status === "completed")) || null : null;
  const timelinePending = timelineAudio ? videoJobs.find(j => j.source_job_id === timelineAudio.id && ["queued", "running"].includes(j.status)) || null : null;
  const [portrait, setPortrait] = useState<Blob | string | null>(null), [portraitUrl, setPortraitUrl] = useState("");
  const remaining = Math.max(0, (user?.limit || 0) - (user?.used || 0));
  let cost = script.length * 3, scriptError = "";
  try { cost = validateStudioScript(script); } catch (e) { scriptError = (e as Error).message; }
  const estimate = estimateSpeechSeconds(script);
  const loadVoices = async () => {
    const request = ++catalogRequest.current;
    try {
      const d = await api<{ enabled: boolean; voices: StudioVoice[] }>("/video-studio/config");
      if (!Array.isArray(d.voices)) throw new Error("Списъкът с гласове не се зареди. Опитайте отново.");
      if (request !== catalogRequest.current) return;
      setEnabled(d.enabled); setVoices(d.voices); setVoicesLoaded(true); setVoiceError("");
    } catch (e) { if (request === catalogRequest.current) setVoiceError((e as Error).message); }
  };
  useEffect(() => {
    void loadVoices();
    const refreshVoices = () => { void loadVoices(); };
    window.addEventListener("focus", refreshVoices); window.addEventListener("rech:studio-voices-changed", refreshVoices);
    return () => { catalogRequest.current++; window.removeEventListener("focus", refreshVoices); window.removeEventListener("rech:studio-voices-changed", refreshVoices); };
  }, []);
  useEffect(() => { if (!id && !voice && voices.length) setVoice(voices[0].id); }, [id, voice, voices]);
  useEffect(() => {
    setAssisting(false); setAssistError(""); setUndo(null);
    return () => { assistRequest.current?.abort(); assistRequest.current = null; };
  }, [id]);
  // A portrait picked before the first save, or an own file still uploading, previews locally.
  const [pendingPortrait, setPendingPortrait] = useState<{ file: Blob | null; ref: ProjectPortrait | null } | null>(null);
  const portraitProject = useRef(id);
  useEffect(() => {
    if (portraitProject.current && portraitProject.current !== id) { setPortrait(null); setPendingPortrait(null); }
    portraitProject.current = id;
  }, [id]);
  const savePortrait = async (file: Blob | null, ref: ProjectPortrait | null, index = sceneAt) => {
    let reference = ref;
    if (!reference && file) {
      try {
        const name = file instanceof File ? file.name : "portrait.jpg";
        reference = { type: "asset", id: await uploadMedia(new File([file], name, { type: file.type }), "portrait", () => {}) };
      } catch { return; /* Stays a local preview; the video itself still uses the chosen file. */ }
    }
    if (reference) project.update(d => withScene(d, index, s => ({ ...s, portrait: reference })));
  };
  useEffect(() => {
    if (!project.doc || !pendingPortrait) return;
    const { file, ref } = pendingPortrait;
    setPendingPortrait(null);
    void savePortrait(file, ref);
  }, [!!project.doc, pendingPortrait]);
  useEffect(() => {
    if (!portrait) { setPortraitUrl(referenceUrl(scene?.portrait || null)); return; }
    if (typeof portrait === "string") { setPortraitUrl(portrait); return; }
    const url = URL.createObjectURL(portrait); setPortraitUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [portrait, scene?.portrait]);
  const choosePortrait = (p: Blob | string | null, ref: ProjectPortrait | null) => {
    setPortrait(p);
    setPendingPortrait({ file: typeof p === "string" ? null : p, ref });
  };
  // The scene follows the voice version (and its video) shown in the timeline.
  useEffect(() => {
    if (!project.doc || !scene || !timelineAudio) return;
    const videoId = timelineVideo?.id ?? null;
    if (scene.audioJobId !== timelineAudio.id || scene.videoJobId !== videoId)
      project.update(d => withScene(d, sceneAt, s => ({ ...s, audioJobId: timelineAudio.id, videoJobId: videoId })));
  }, [!!project.doc, sceneAt, timelineAudio?.id, timelineVideo?.id]);
  // One-time import of data that older versions kept only in this browser.
  useEffect(() => {
    if (!project.doc || !user || !id) return;
    const pristine = !project.doc.music && project.doc.scenes[0].speechStart === 0 && project.doc.scenes[0].tail === 0 && project.doc.scenes[0].voiceVolume === 1;
    const local = sceneAt === 0 && timelineAudio && takeLocalTimeline(user.id, timelineAudio.id);
    if (local && pristine) {
      const musicKey = `music:${user.id}:${timelineAudio!.id}`;
      project.update(d => withTimeline(d, { ...local, music: null }));
      if (local.music) {
        const music = local.music;
        readLocalFile(musicKey).then(async file => {
          if (!(file instanceof Blob)) return;
          const assetId = await uploadMedia(new File([file], music.name, { type: file.type }), "music", () => {});
          project.update(d => withTimeline(d, { ...sceneTimeline(d.scenes[0], d.music), music }, assetId));
          void removeLocalFile(musicKey);
        }).catch(() => { /* Keep the local file; the user can add the music again. */ });
      }
    }
    if (!project.doc.scenes[0].portrait) {
      readLocalFile(`portrait:${user.id}:${id}`).then(p => {
        if (!p) return;
        const asset = typeof p === "string" ? /^\/api\/media\/assets\/([0-9a-f-]{36})\/file$/.exec(p)?.[1] : undefined;
        void savePortrait(typeof p === "string" ? null : p, asset ? { type: "asset", id: asset } : null, 0)
          .then(() => removeLocalFile(`portrait:${user.id}:${id}`));
      });
    }
  }, [!!project.doc, timelineAudio?.id]);
  useEffect(() => {
    let live = true;
    if (projectId.current !== id) setVideoFormKey(crypto.randomUUID());
    projectId.current = id; setApproved(""); setSuggestion("");
    if (!id) { setTitle("Моята видео история"); setScript(""); setVoice(""); setDirty(false); setLoading(false); return; }
    if (skipLoad.current === id) { skipLoad.current = ""; return; }
    setLoading(true);
    api("/projects/" + id).then(({ project }) => {
      if (!live) return;
      if (project.mode !== "studio") { navigate("/app/studio/" + id, { replace: true }); return; }
      setTitle(project.title); setScript(project.script); setVoice(project.voice); setDirty(false);
    }).catch(e => live && setError(e.message)).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [id]);
  useEffect(() => {
    const jobId = params.get("job"); if (!jobId || !id) return;
    api<{ job: Job }>("/jobs/" + encodeURIComponent(jobId)).then(({ job }) => {
      if (job.project_id !== id) return;
      setLocalJobs(j => [job, ...j.filter(x => x.id !== job.id)]);
      if (job.kind === "video") { setSelectedVideo(job.id); setSelectedAudio(job.source_job_id || ""); } else setSelectedAudio(job.id);
    }).catch(e => setError(e.message));
  }, [id, params.get("job")]);
  useEffect(() => { if (!dirty) return; const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [dirty]);
  const edit = (fn: () => void) => { fn(); setDirty(true); setSuggestion(""); setAssistError(""); setApproved(""); key.current = crypto.randomUUID(); };
  // The editor shows the selected scene; its script and voice save with the project document.
  useEffect(() => {
    if (!project.doc || !scene) return;
    if (scene.script !== script || scene.voice !== (voice || null))
      project.update(d => withScene(d, sceneAt, s => ({ ...s, script, voice: voice || null })));
  }, [script, voice]);
  const sceneLoaded = useRef("");
  useEffect(() => {
    if (!project.doc || !scene || sceneLoaded.current === scene.id) return;
    const first = sceneLoaded.current === "";
    sceneLoaded.current = scene.id;
    // The first scene of older projects keeps its script in the project itself.
    if (first && sceneAt === 0 && !scene.script) return;
    setScript(scene.script); if (scene.voice) setVoice(scene.voice);
    setSelectedAudio(""); setSelectedVideo(""); setApproved(""); setSuggestion(""); setUndo(null);
    setPortrait(null); setVideoFormKey(crypto.randomUUID()); key.current = crypto.randomUUID();
  }, [!!project.doc, scene?.id]);
  useEffect(() => { sceneLoaded.current = ""; setSceneIndex(0); }, [id]);
  const addScene = () => {
    project.update(d => ({ ...d, scenes: [...d.scenes, newScene({ voice: voice || null })] }));
    setSceneIndex(scenes.length);
  };
  const removeScene = (i: number) => {
    if (scenes.length < 2 || !confirm(`Да изтрием ли сцена ${i + 1}? Създадените записи остават в историята на проекта.`)) return;
    project.update(d => ({ ...d, scenes: d.scenes.filter((_, n) => n !== i) }));
    setSceneIndex(Math.max(0, i - 1));
  };
  const moveScene = (i: number, by: -1 | 1) => {
    project.update(d => {
      const next = [...d.scenes];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return { ...d, scenes: next };
    });
    setSceneIndex(i + by);
  };
  const sceneStatuses: SceneStatus[] = scenes.map((s, i) => {
    const mine = projectJobs.filter(j => sceneOf(j) === i);
    const audios = mine.filter(j => j.kind !== "video"), videos = mine.filter(j => j.kind === "video");
    const current = audios.find(j => j.id === s.audioJobId) || audios[0];
    const video = videos.find(j => j.id === s.videoJobId) || videos.find(j => j.source_job_id === current?.id);
    const stale = !!current && !!s.audioFor && !!s.script && s.audioFor !== scriptFingerprint(s.voice, s.script);
    return {
      voice: !current ? "none" : ["queued", "running"].includes(current.status) ? "working" : current.status === "completed" ? (stale ? "stale" : "ready") : "none",
      video: !video ? "none" : ["queued", "running"].includes(video.status) ? "working" : video.status === "completed" ? "ready" : "none",
      seconds: current?.status === "completed" ? s.speechStart + current.duration + s.tail : 0,
    };
  });
  const save = async () => {
    // The project row mirrors the first scene (older screens and the project list read it).
    const first = sceneAt === 0 || !project.doc ? { script, voice } : { script: scenes[0].script || script, voice: scenes[0].voice || voice };
    const body = { title, mode: "studio", script: first.script, voice: first.voice, second_voice: "boris", pause_ms: 0 };
    let savedId = projectId.current;
    if (savedId) await api("/projects/" + savedId, { method: "PUT", body: JSON.stringify(body) });
    else { const result = await post("/projects", body); savedId = result.id; projectId.current = savedId; skipLoad.current = savedId!; navigate("/app/video-studio/" + savedId, { replace: true }); }
    setDirty(false); return savedId!;
  };
  const generate = async () => {
    setBusy(true); setError(""); setApproved("");
    try {
      const savedId = await save();
      // Scenes generate from the saved document, so make sure the latest script is on the server.
      if (project.doc && scene) await project.flush();
      const { id: jobId } = await post("/generate", { projectId: savedId, idempotencyKey: key.current, credits: cost, ...(project.doc && scene ? { sceneId: scene.id } : {}) });
      if (project.doc && scene) project.update(d => withScene(d, sceneAt, s => ({ ...s, history: [jobId, ...s.history.filter(h => h !== jobId)].slice(0, 20), audioFor: scriptFingerprint(voice || null, script) })));
      const { job } = await api("/jobs/" + jobId);
      setLocalJobs(j => [job, ...j.filter(x => x.id !== job.id)]); setSelectedAudio(jobId); setSelectedVideo("");
      key.current = crypto.randomUUID(); jobsChanged(); await refresh();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const assist = async () => {
    if (assistRequest.current || busy) return;
    const controller = new AbortController(); assistRequest.current = controller;
    setAssisting(true); setAssistError(""); setSuggestion("");
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const d = await api<{ text: string }>("/video-studio/delivery", {
        method: "POST", body: JSON.stringify({ text: script, tone }), signal: controller.signal,
      });
      if (assistRequest.current !== controller) return;
      if (typeof d?.text !== "string" || !d.text.trim()) throw new Error("Не получихме предложение за емоции. Опитайте отново.");
      setSuggestion(validateSuggestedDelivery(script, d.text));
    } catch (e) {
      if (assistRequest.current === controller) setAssistError(controller.signal.aborted
        ? "Предложението за емоции отне твърде дълго. Опитайте отново или добавете тагове ръчно."
        : e instanceof Error ? e.message : "Предложението не се зареди. Опитайте отново.");
    } finally {
      clearTimeout(timer);
      if (assistRequest.current === controller) { assistRequest.current = null; setAssisting(false); }
    }
  };
  const insertTag = (tag: string) => {
    const start = editor.current?.selectionStart ?? script.length;
    edit(() => setScript(script.slice(0, start) + `[${tag}]` + script.slice(start)));
    requestAnimationFrame(() => { editor.current?.focus(); editor.current?.setSelectionRange(start + tag.length + 2, start + tag.length + 2); });
  };
  if (loading) return <p>Зареждане на видео студиото…</p>;
  return <div className="video-studio">
    <header className="vs-heading"><div><span className="eyebrow">ОТ СЦЕНАРИЙ ДО ПУБЛИКУВАНЕ</span><h1>Вашето видео студио.</h1><p>Глас с характер. Лице за историята. Думи, които се виждат.</p></div><Link className="btn" to="/app/studio"><Mic size={17} /> Само аудио</Link></header>
    <div className="vs-steps"><span><b>01</b> Сценарий и глас</span><ArrowRight size={18} /><span><b>02</b> Одобрение и видео</span><ArrowRight size={18} /><span><b>03</b> Монтаж и експорт</span></div>
    {error && <Notice error>{error}</Notice>}{pollingError && <Notice>{pollingError}</Notice>}
    {!id && <TemplatePicker />}
    {id && project.doc && <SceneStrip scenes={scenes} statuses={sceneStatuses} selected={sceneAt} disabled={locked}
      onSelect={setSceneIndex} onAdd={addScene} onRemove={removeScene} onMove={moveScene}
      onRename={(i, title) => project.update(d => withScene(d, i, s => ({ ...s, title })))} />}
    {multi && <p className="vs-fine" role="status">Редактирате сцена {sceneAt + 1}{scene?.title ? ` · ${scene.title}` : ""}. Сценарият, гласът, аватарът и монтажът по-долу се отнасят за нея.</p>}
    {!enabled && <Notice>Видео студиото е подготвено. Премиум озвучаването ще бъде достъпно след активиране.</Notice>}
    <div className="vs-layout"><section className="vs-card vs-script"><div className="sub-heading"><h2><Film size={23} /> Дайте начало на историята</h2><span>01 / СЦЕНАРИЙ</span></div>
      <fieldset disabled={locked}><label>Име на проекта<input value={title} maxLength={120} onChange={e => edit(() => setTitle(e.target.value))} /></label>
      {voiceError && <Notice>{voiceError} <button type="button" className="text-link" onClick={() => void loadVoices()}>Зареди гласовете отново</button></Notice>}
      {!voicesLoaded && !voiceError && <p>Зареждане на гласовете…</p>}
      {voicesLoaded && !voices.length && <Notice>В момента няма активни гласове за видео. Администраторът може да добави глас от настройките.</Notice>}
      <StudioVoicePicker voices={voices} selected={voice} onSelect={id => edit(() => setVoice(id))} />
      <label htmlFor="video-script">Вашият сценарий</label><div className="vs-tags">{emotionTags.map(([tag, label]) => <button key={tag} onClick={() => insertTag(tag)} title={`[${tag}]`}>{label}</button>)}</div>
      <textarea ref={editor} id="video-script" value={script} maxLength={studioMaxChars} rows={10} placeholder="[curious]Понякога е нужен само един глас, за да оживее една история…" onChange={e => edit(() => setScript(e.target.value))} />
      <div className="vs-counter"><span>Таговете в [скоби] насочват гласа. Изразителността зависи от избрания глас.</span><strong>{number(script.length)} / {number(studioMaxChars)}</strong></div>
      <div className="vs-assistant"><label>Настроение<select value={tone} onChange={e => { setTone(e.target.value); setSuggestion(""); setAssistError(""); }}><option value="ad">Уверена реклама</option><option value="story">Увлекателна история</option><option value="calm">Спокоен разказ</option></select></label><Button type="button" className="btn" busy={assisting} aria-busy={assisting} aria-describedby="delivery-feedback" disabled={!!scriptError || !user?.verified} onClick={assist}>{!assisting && <Sparkles size={17} />} {assisting ? "Подготвяме емоциите…" : "Предложи емоции"}</Button></div><small>До 5 предложения дневно са включени. Прегледайте предложението и натиснете „Приложи“, за да го добавите към сценария.</small>
      <div id="delivery-feedback" aria-live="polite" aria-atomic="true">
        <p role="status" className={assisting ? undefined : "sr-only"}>{assisting ? "Подбираме емоции за вашия сценарий. Това може да отнеме няколко секунди." : suggestion ? "Предложението е готово — прегледайте преди да приложите." : ""}</p>
        {assistError && <Notice>{assistError}</Notice>}
        {!assisting && !assistError && (!user?.verified ? <p>Потвърдете имейла си, за да получите предложение за емоции.</p> : scriptError ? <p>{script.length ? scriptError : "Напишете сценарий, за да получите предложение за емоции."}</p> : null)}
      </div>
      {suggestion && <div className="vs-suggestion"><strong>Предложението е готово — прегледайте преди да приложите</strong><p>{suggestion}</p><button type="button" className="btn dark" onClick={() => { setUndo(script); edit(() => setScript(suggestion)); }}>Приложи</button><button type="button" className="btn" onClick={() => setSuggestion("")}>Отхвърли</button></div>}
      {undo !== null && <button className="btn" onClick={() => { edit(() => setScript(undo)); setUndo(null); }}>Върни предишния сценарий</button>}
      </fieldset>
      <div className="vs-actions"><Button className="btn" busy={busy} disabled={assisting || !title.trim() || !voices.some(v => v.id === voice)} onClick={async () => { setBusy(true); try { await save(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><Save size={17} /> {dirty || !id ? "Запази проекта" : "Запазен"}</Button><Button className="btn primary" busy={busy} disabled={assisting || !enabled || !voices.some(v => v.id === voice) || active || !!scriptError || !title.trim() || cost > remaining || !user?.verified} onClick={generate}><Mic size={17} /> Създай глас · {number(cost)} кредита</Button></div>
      {script.length > 0 && scriptError && <Notice error>{scriptError}</Notice>}
      {!scriptError && estimate > MAX_VIDEO_SECONDS && <Notice>Около {estimate} секунди реч. Видеото приема запис от {MIN_VIDEO_SECONDS} до {MAX_VIDEO_SECONDS} секунди — съкратете сценария, ако ще създавате видео от този глас.</Notice>}
      {!scriptError && script.trim() && estimate < MIN_VIDEO_SECONDS && <Notice>Около {estimate} секунди реч. За видео са нужни поне {MIN_VIDEO_SECONDS} секунди.</Notice>}
      {cost > remaining && <p>Нужни са още {number(cost - remaining)} кредита. <Link to="/app/billing">Вижте плановете</Link></p>}
      <p className="vs-fine">3 кредита за символ, включително таговете. Всяко ново озвучаване се заплаща. Видеото се таксува отделно след одобрението ви. За видео целете 5–60 секунди — обикновено около 50–120 думи.</p>
    </section><aside className="vs-card vs-review"><span className="eyebrow">02 / ПРОСЛУШАЙТЕ</span><h2>Първо чуйте. После покажете.</h2><p>Проверете произношението и емоцията, преди да създадете видео.</p>
      {audioJobs.length > 0 && <label>Версия на гласа<select value={audio?.id || ""} onChange={e => { setSelectedAudio(e.target.value); setSelectedVideo(""); setApproved(""); }}>{audioJobs.map(j => <option key={j.id} value={j.id}>{new Date(j.created_at * 1000).toLocaleString("bg")} · {jobStatus(j)}</option>)}</select></label>}
      {!audio && <div className="vs-audio-empty"><Mic size={35} /><p>Вашият глас ще се появи тук.</p></div>}
      {audio?.status === "failed" && <Notice error>{audio.error}</Notice>}
      {audio && ["queued", "running"].includes(audio.status) && <Notice>Гласът се създава във фонов режим. Можете да напуснете страницата и да се върнете в проекта.</Notice>}
      {audio?.status === "completed" && <><audio key={audio.id} controls src={`/api/jobs/${audio.id}/audio`} /><a href={`/api/jobs/${audio.id}/audio`} download className="btn">Изтегли WAV</a><p>{audio.duration.toFixed(1)} секунди · {number(audio.chars)} кредита за тази версия</p><Button className={audioApproved ? "btn dark" : "btn primary"} onClick={() => setApproved(audio.id)}><Check size={17} /> {audioApproved ? "Гласът е одобрен" : "Одобрявам този глас"}</Button></>}
      <p className="vs-fine">Редакциите в сценария не променят вече създадените записи.</p>
    </aside></div>
    <Disclosure className="vs-card" summary="Създайте аватар с ваш продукт"><ProductAvatarPanel onSelect={id => {setProductAvatar(id); document.getElementById("video-avatar")?.scrollIntoView({behavior:"smooth"});}} /></Disclosure>
    <div id="video-avatar" />
    <VideoPanel onPortraitChange={choosePortrait} selectedAsset={productAvatar} onClearAsset={() => setProductAvatar("")} key={videoFormKey} jobs={audio ? [audio] : []} approved={audioApproved} activeJob={activeJob} submissionBlocked={locked} onCreated={j => { setLocalJobs(list => mergeJobs(list, [j])); setSelectedVideo(j.id); jobsChanged(); }} />
    {videoJobs.length > 0 && <section className="vs-card"><h2>Вашите видеа</h2><select aria-label="Версия на видеото" value={video?.id || ""} onChange={e => { const next = videoJobs.find(j => j.id === e.target.value); setSelectedVideo(e.target.value); if (next?.source_job_id) setSelectedAudio(next.source_job_id); }}>{videoJobs.map(j => <option key={j.id} value={j.id}>{new Date(j.created_at * 1000).toLocaleString("bg")} · {jobStatus(j)}</option>)}</select>{video?.status === "failed" && <Notice error>{video.error}</Notice>}{video && ["queued", "running"].includes(video.status) && <Notice>{jobStatus(video)}. Продължаваме във фонов режим. Готовото видео ще се появи в този проект.</Notice>}</section>}
    {project.conflict && <Notice>{project.conflict}</Notice>}
    {project.error && <Notice error>{project.error}</Notice>}
    {timelineAudio && id && project.doc && scene && <TimelineEditor key={`${timelineAudio.id}:${captionsVersion}`} brand={brand.kit} audio={timelineAudio} video={timelineVideo} pendingVideo={timelinePending} portraitUrl={portraitUrl}
      projectId={id} timeline={sceneTimeline(scene, project.doc.music)} musicAssetId={project.doc.music?.assetId ?? null}
      onTimeline={(change, musicAssetId) => project.update(d => withTimeline(d, change(sceneTimeline(d.scenes[sceneAt], d.music)), musicAssetId, sceneAt))}
      onFlush={project.flush} serverExport={!multi} sceneLabel={multi ? `сцена ${sceneAt + 1}` : ""}
      layers={scene.layers} background={scene.background}
      onLayers={change => project.update(d => withScene(d, sceneAt, s => ({ ...s, layers: change(s.layers) })))}
      onBackground={background => project.update(d => withScene(d, sceneAt, s => ({ ...s, background })))} />}
    {multi && id && <section className="vs-card"><h2>Цялото видео</h2>
      <p>Сървърът свързва {scenes.length} сцени по ред — всяка със своето начало, задържане, глас и стил на субтитрите — и добавя музиката под цялото видео. {sceneStatuses.some(s => s.video !== "ready") && "Експортът се отключва, когато всяка сцена има готово видео."}</p>
      <BackgroundExport sourceId={id} projectId={id} document={defaultCaptions} onSave={project.flush} />
    </section>}
    {brand.kit && <Disclosure className="vs-card" summary="Бранд, интро и шаблони">
      <BrandPanel kit={brand.kit} onSaveKit={brand.save} projectId={id} doc={project.doc} update={project.update}
        captionSource={timelineAudio?.id || null} sceneLengths={sceneStatuses.map(s => s.seconds)} onCaptionsChanged={() => setCaptionsVersion(v => v + 1)} />
    </Disclosure>}
  </div>;
}
