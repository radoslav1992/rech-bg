import { ProductAvatarPanel } from "./MediaTools";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Film, Mic, Sparkles, Save, Check, ArrowRight } from "lucide-react";
import { api, post, Button, Notice, number, useAuth, type Job } from "./lib";
import { jobsChanged, jobStatus, useJobs } from "./JobActivity";
import { emotionTags, studioMaxChars, validateStudioScript, validateSuggestedDelivery } from "../shared/studio";
import { StudioVoicePicker } from "./StudioVoicePicker";
import type { StudioVoice } from "../shared/studio";
import { VideoPanel } from "./VideoPanel";
import { mergeJobs } from "./job-state";
import { TimelineEditor } from "./TimelineEditor";
import { readLocalFile, writeLocalFile } from "./timeline";
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
  const jobs = mergeJobs(localJobs, allJobs).filter(j => j.project_id === id).sort((a, b) => b.created_at - a.created_at);
  const audioJobs = jobs.filter(j => j.kind !== "video"), videoJobs = jobs.filter(j => j.kind === "video");
  const audio = audioJobs.find(j => j.id === selectedAudio) || audioJobs[0] || null;
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
  // The chosen portrait is remembered in this browser so the timeline can show it after a reload.
  const portraitProject = useRef(id);
  useEffect(() => {
    let live = true;
    const previous = portraitProject.current; portraitProject.current = id;
    if (previous && previous !== id) setPortrait(null);
    // A new project keeps the portrait picked before its first save.
    else if (!previous && id && user && portrait) void writeLocalFile(`portrait:${user.id}:${id}`, portrait);
    if (id && user) readLocalFile(`portrait:${user.id}:${id}`).then(p => { if (live && p) setPortrait(current => current ?? p); });
    return () => { live = false; };
  }, [id, user?.id]);
  useEffect(() => {
    if (!portrait) { setPortraitUrl(""); return; }
    if (typeof portrait === "string") { setPortraitUrl(portrait); return; }
    const url = URL.createObjectURL(portrait); setPortraitUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [portrait]);
  const choosePortrait = (p: Blob | string | null) => {
    setPortrait(p);
    if (p && projectId.current && user) void writeLocalFile(`portrait:${user.id}:${projectId.current}`, p);
  };
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
  const save = async () => {
    const body = { title, mode: "studio", script, voice, second_voice: "boris", pause_ms: 0 };
    let savedId = projectId.current;
    if (savedId) await api("/projects/" + savedId, { method: "PUT", body: JSON.stringify(body) });
    else { const result = await post("/projects", body); savedId = result.id; projectId.current = savedId; skipLoad.current = savedId!; navigate("/app/video-studio/" + savedId, { replace: true }); }
    setDirty(false); return savedId!;
  };
  const generate = async () => {
    setBusy(true); setError(""); setApproved("");
    try {
      const savedId = await save();
      const { id: jobId } = await post("/generate", { projectId: savedId, idempotencyKey: key.current, credits: cost });
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
    {error && <Notice>{error}</Notice>}{pollingError && <Notice>{pollingError}</Notice>}
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
        {assisting && <p role="status">Подбираме емоции за вашия сценарий. Това може да отнеме няколко секунди.</p>}
        {assistError && <Notice>{assistError}</Notice>}
        {!assisting && !assistError && (!user?.verified ? <p>Потвърдете имейла си, за да получите предложение за емоции.</p> : scriptError ? <p>{script.length ? scriptError : "Напишете сценарий, за да получите предложение за емоции."}</p> : null)}
      </div>
      {suggestion && <div className="vs-suggestion" role="status"><strong>Предложението е готово — прегледайте преди да приложите</strong><p>{suggestion}</p><button type="button" className="btn dark" onClick={() => { setUndo(script); edit(() => setScript(suggestion)); }}>Приложи</button><button type="button" className="btn" onClick={() => setSuggestion("")}>Отхвърли</button></div>}
      {undo !== null && <button className="btn" onClick={() => { edit(() => setScript(undo)); setUndo(null); }}>Върни предишния сценарий</button>}
      </fieldset>
      <div className="vs-actions"><Button className="btn" busy={busy} disabled={assisting || !title.trim() || !voices.some(v => v.id === voice)} onClick={async () => { setBusy(true); try { await save(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><Save size={17} /> {dirty || !id ? "Запази проекта" : "Запазен"}</Button><Button className="btn primary" busy={busy} disabled={assisting || !enabled || !voices.some(v => v.id === voice) || active || !!scriptError || !title.trim() || cost > remaining || !user?.verified} onClick={generate}><Mic size={17} /> Създай глас · {number(cost)} кредита</Button></div>
      {script.length > 0 && scriptError && <Notice>{scriptError}</Notice>}
      {cost > remaining && <p>Нужни са още {number(cost - remaining)} кредита. <Link to="/app/billing">Вижте плановете</Link></p>}
      <p className="vs-fine">3 кредита за символ, включително таговете. Всяко ново озвучаване се заплаща. Видеото се таксува отделно след одобрението ви. За видео целете 5–60 секунди — обикновено около 50–120 думи.</p>
    </section><aside className="vs-card vs-review"><span className="eyebrow">02 / ПРОСЛУШАЙТЕ</span><h2>Първо чуйте. После покажете.</h2><p>Проверете произношението и емоцията, преди да създадете видео.</p>
      {audioJobs.length > 0 && <label>Версия на гласа<select value={audio?.id || ""} onChange={e => { setSelectedAudio(e.target.value); setSelectedVideo(""); setApproved(""); }}>{audioJobs.map(j => <option key={j.id} value={j.id}>{new Date(j.created_at * 1000).toLocaleString("bg")} · {jobStatus(j)}</option>)}</select></label>}
      {!audio && <div className="vs-audio-empty"><Mic size={35} /><p>Вашият глас ще се появи тук.</p></div>}
      {audio?.status === "failed" && <Notice>{audio.error}</Notice>}
      {audio && ["queued", "running"].includes(audio.status) && <Notice>Гласът се създава във фонов режим. Можете да напуснете страницата и да се върнете в проекта.</Notice>}
      {audio?.status === "completed" && <><audio key={audio.id} controls src={`/api/jobs/${audio.id}/audio`} /><a href={`/api/jobs/${audio.id}/audio`} download className="btn">Изтегли WAV</a><p>{audio.duration.toFixed(1)} секунди · {number(audio.chars)} кредита за тази версия</p><Button className={approved === audio.id ? "btn dark" : "btn primary"} onClick={() => setApproved(audio.id)}><Check size={17} /> {approved === audio.id ? "Гласът е одобрен" : "Одобрявам този глас"}</Button></>}
      <p className="vs-fine">Редакциите в сценария не променят вече създадените записи.</p>
    </aside></div>
    <details className="vs-card"><summary>Създайте аватар с ваш продукт</summary><ProductAvatarPanel onSelect={id => {setProductAvatar(id); document.getElementById("video-avatar")?.scrollIntoView({behavior:"smooth"});}} /></details>
    <div id="video-avatar" />
    <VideoPanel onPortraitChange={choosePortrait} selectedAsset={productAvatar} onClearAsset={() => setProductAvatar("")} key={videoFormKey} jobs={audio ? [audio] : []} approved={!!audio && audio.id === approved} activeJob={activeJob} submissionBlocked={locked} onCreated={j => { setLocalJobs(list => mergeJobs(list, [j])); setSelectedVideo(j.id); jobsChanged(); }} />
    {videoJobs.length > 0 && <section className="vs-card"><h2>Вашите видеа</h2><select aria-label="Версия на видеото" value={video?.id || ""} onChange={e => { const next = videoJobs.find(j => j.id === e.target.value); setSelectedVideo(e.target.value); if (next?.source_job_id) setSelectedAudio(next.source_job_id); }}>{videoJobs.map(j => <option key={j.id} value={j.id}>{new Date(j.created_at * 1000).toLocaleString("bg")} · {jobStatus(j)}</option>)}</select>{video?.status === "failed" && <Notice>{video.error}</Notice>}{video && ["queued", "running"].includes(video.status) && <Notice>{jobStatus(video)}. Продължаваме във фонов режим. Готовото видео ще се появи в този проект.</Notice>}</section>}
    {timelineAudio && <TimelineEditor key={timelineAudio.id} audio={timelineAudio} video={timelineVideo} pendingVideo={timelinePending} portraitUrl={portraitUrl} />}
  </div>;
}
