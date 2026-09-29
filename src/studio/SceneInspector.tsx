import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Film, Image as ImageIcon, Mic, RefreshCw, Sparkles, UserRound } from "lucide-react";
import { api, Button, Notice, number, useAuth, type Job } from "../lib";
import { jobStatus } from "../JobActivity";
import { StudioVoicePicker } from "../StudioVoicePicker";
import { BackgroundControl, LayerAddBar, layerNames, MediaPicker } from "../LayerTools";
import { emotionTags, estimateSpeechSeconds, studioMaxChars, validateStudioScript, validateSuggestedDelivery, type StudioVoice } from "../../shared/studio";
import { MAX_VIDEO_SECONDS, MIN_VIDEO_SECONDS, videoCredits, videoTiers, type VideoTier } from "../../shared/video";
import { MAX_LEAD, MAX_TAIL } from "../../shared/timeline";
import { canCreateVideo, VIDEO_PLAN_MESSAGE } from "../../shared/catalog";
import type { MediaAsset } from "../../shared/media";
import type { Layer } from "../../shared/layers";
import type { ProjectScene } from "../../shared/project";
import { portraitUrl } from "../project-document";
import { isBusy, type SceneMedia } from "./model";

export type VideoConfig = { enabled: boolean; emailNotifications: boolean; mediumLibraryOnly: boolean; tiers: Record<VideoTier, boolean>;
  /** Longest recording per tier for the model it currently uses. */
  maxSeconds: Record<VideoTier, number> };
export type VideoRequest = { tier: VideoTier; consent: boolean; notifyEmail: boolean };

const when = (j: Job) => new Date(j.created_at * 1000).toLocaleString("bg");

/** Everything about one scene: what is said, by whom, who presents it, and its timing and look. */
export function SceneInspector({ scene, index, media, voices, studioEnabled, videoConfig, mediumAllowed = true, fit, assets, hasLogo, busy,
  onChange, onGenerateAudio, onCreateVideo, onChooseAvatar, onSelectAudio, onSelectVideo, onAddLayer, onAddMediaLayer }: {
  scene: ProjectScene; index: number; media: SceneMedia; voices: readonly StudioVoice[]; studioEnabled: boolean;
  videoConfig: VideoConfig | null;
  /** False when Medium takes only linked library avatars and this scene's presenter is not one. */
  mediumAllowed?: boolean;
  fit: string; assets: MediaAsset[]; hasLogo: boolean;
  /** "audio" or "video" while that request for this scene is being sent. */
  busy: "audio" | "video" | null;
  onChange: (change: (s: ProjectScene) => ProjectScene) => void;
  onGenerateAudio: (credits: number) => void;
  onCreateVideo: (request: VideoRequest, credits: number) => void;
  onChooseAvatar: () => void;
  onSelectAudio: (id: string) => void;
  onSelectVideo: (id: string) => void;
  onAddLayer: (type: Layer["type"] | "logo") => void;
  onAddMediaLayer: (type: "image" | "broll", assetId: string) => void;
}) {
  const { user } = useAuth();
  const remaining = Math.max(0, (user?.limit || 0) - (user?.used || 0));
  const editor = useRef<HTMLTextAreaElement>(null);
  const [tone, setTone] = useState("ad"), [suggestion, setSuggestion] = useState(""), [undo, setUndo] = useState<string | null>(null);
  const [assisting, setAssisting] = useState(false), [assistError, setAssistError] = useState("");
  const [tier, setTier] = useState<VideoTier>("medium"), [consent, setConsent] = useState(false), [notifyEmail, setNotifyEmail] = useState(true);
  const [adding, setAdding] = useState<"image" | "broll" | null>(null);
  const assistRequest = useRef<AbortController | null>(null);
  // Suggestions and consent belong to one scene and one presenter.
  useEffect(() => {
    setSuggestion(""); setUndo(null); setAssistError(""); setAdding(null); setAssisting(false);
    // Cleared first, so the aborted request of the previous scene reports nothing.
    const pending = assistRequest.current; assistRequest.current = null; pending?.abort();
  }, [scene.id]);
  useEffect(() => { setConsent(false); }, [scene.id, scene.portrait?.type, scene.portrait?.id]);
  // The tier the user picked in this scene; otherwise the default follows the configuration as it loads.
  const picked = useRef<{ scene: string; tier: VideoTier } | null>(null);
  const tierOpen = (t: VideoTier) => !!videoConfig?.tiers[t] && (t !== "medium" || mediumAllowed);
  useEffect(() => {
    if (!videoConfig) return;
    const open = (t: VideoTier) => videoConfig.tiers[t] && (t !== "medium" || mediumAllowed);
    const preferred = open("medium") ? "medium" : open("low") ? "low" : "high";
    // Each scene starts from the default quality; within a scene the choice stays while it is available.
    const choice = picked.current?.scene === scene.id ? picked.current.tier : null;
    setTier(choice && open(choice) ? choice : preferred);
  }, [videoConfig, mediumAllowed, scene.id]);
  useEffect(() => () => assistRequest.current?.abort(), []);

  // The most any available tier accepts (a scene longer than this cannot become a video).
  const longestVideo = Math.max(MIN_VIDEO_SECONDS, ...(Object.keys(videoTiers) as VideoTier[]).filter((t) => videoConfig?.tiers[t]).map((t) => videoConfig!.maxSeconds[t]), videoConfig ? 0 : MAX_VIDEO_SECONDS);
  let cost = scene.script.length * 3, scriptError = "";
  try { cost = validateStudioScript(scene.script); } catch (e) { scriptError = (e as Error).message; }
  const estimate = estimateSpeechSeconds(scene.script);
  const voiceOk = voices.some((v) => v.id === scene.voice);
  const setScript = (script: string) => { onChange((s) => ({ ...s, script })); setSuggestion(""); setAssistError(""); };
  const insertTag = (tag: string) => {
    const start = editor.current?.selectionStart ?? scene.script.length;
    setScript(scene.script.slice(0, start) + `[${tag}]` + scene.script.slice(start));
    requestAnimationFrame(() => { editor.current?.focus(); editor.current?.setSelectionRange(start + tag.length + 2, start + tag.length + 2); });
  };
  const assist = async () => {
    if (assistRequest.current) return;
    const controller = new AbortController(); assistRequest.current = controller;
    setAssisting(true); setAssistError(""); setSuggestion("");
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const d = await api<{ text: string }>("/video-studio/delivery", { method: "POST", body: JSON.stringify({ text: scene.script, tone }), signal: controller.signal });
      if (assistRequest.current !== controller) return;
      if (typeof d?.text !== "string" || !d.text.trim()) throw new Error("Не получихме предложение за емоции. Опитайте отново.");
      setSuggestion(validateSuggestedDelivery(scene.script, d.text));
    } catch (e) {
      if (assistRequest.current === controller) setAssistError(controller.signal.aborted
        ? "Предложението за емоции отне твърде дълго. Опитайте отново или добавете тагове ръчно."
        : e instanceof Error ? e.message : "Предложението не се зареди. Опитайте отново.");
    } finally {
      clearTimeout(timer);
      if (assistRequest.current === controller) { assistRequest.current = null; setAssisting(false); }
    }
  };

  const audio = media.audio, ready = audio?.status === "completed" ? audio : null;
  let videoCost = 0, durationError = "";
  const maxSeconds = videoConfig?.maxSeconds[tier] ?? MAX_VIDEO_SECONDS;
  if (ready) { try { videoCost = videoCredits(ready.duration, tier, maxSeconds); } catch (e) { durationError = (e as Error).message; } }
  const planAllowsVideo = canCreateVideo(user?.plan);
  const videoBlocked = !planAllowsVideo ? VIDEO_PLAN_MESSAGE : !ready ? "Първо създайте гласа на сцената." : !scene.portrait ? "Изберете аватар за сцената."
    : !videoConfig?.enabled ? "Създаването на видео в момента не е достъпно." : durationError || (media.pendingVideo ? "Видеото на сцената се създава." : "");
  const avatarUrl = portraitUrl(scene.portrait);

  return <div className="st-inspector-body">
    <label>Име на сцената<input value={scene.title} maxLength={80} placeholder={`Сцена ${index + 1}`} onChange={(e) => onChange((s) => ({ ...s, title: e.target.value }))} /></label>

    <section className="st-block" aria-labelledby="st-avatar-h">
      <h3 id="st-avatar-h"><UserRound size={17} /> Аватар</h3>
      <div className="st-avatar-current">
        {avatarUrl ? <img src={avatarUrl} alt="Избраният аватар" /> : <span className="st-avatar-empty"><UserRound size={28} /></span>}
        <div>
          <p>{scene.portrait ? scene.portrait.type === "library" ? "Готов аватар" : "Ваш портрет" : "Още няма избран аватар."}</p>
          <button type="button" className="btn dark" onClick={onChooseAvatar}><UserRound size={15} /> {scene.portrait ? "Смени аватара" : "Избери аватар"}</button>
        </div>
      </div>
    </section>

    <section className="st-block" aria-labelledby="st-script-h">
      <h3 id="st-script-h"><Film size={17} /> Сценарий и глас</h3>
      {voices.length > 0 && <StudioVoicePicker voices={voices} selected={scene.voice || ""} onSelect={(voice) => onChange((s) => ({ ...s, voice }))} />}
      <div className="vs-tags">{emotionTags.map(([tag, label]) => <button type="button" key={tag} onClick={() => insertTag(tag)} title={`[${tag}]`}>{label}</button>)}</div>
      <label htmlFor={`st-script-${scene.id}`} className="sr-only">Сценарий на сцената</label>
      <textarea ref={editor} id={`st-script-${scene.id}`} value={scene.script} maxLength={studioMaxChars} rows={7}
        placeholder="[curious]Понякога е нужен само един глас, за да оживее една история…" onChange={(e) => setScript(e.target.value)} />
      <div className="vs-counter"><span>Около {estimate} сек. реч</span><strong>{number(scene.script.length)} / {number(studioMaxChars)}</strong></div>
      <div className="vs-assistant">
        <label>Настроение<select value={tone} onChange={(e) => { setTone(e.target.value); setSuggestion(""); }}>
          <option value="ad">Уверена реклама</option><option value="story">Увлекателна история</option><option value="calm">Спокоен разказ</option>
        </select></label>
        <Button type="button" className="btn" busy={assisting} disabled={!!scriptError || !user?.verified} onClick={assist}>{!assisting && <Sparkles size={16} />} {assisting ? "Подбираме…" : "Предложи емоции"}</Button>
      </div>
      <div aria-live="polite">
        {assistError && <Notice>{assistError}</Notice>}
        {suggestion && <div className="vs-suggestion"><strong>Прегледайте предложението</strong><p>{suggestion}</p>
          <button type="button" className="btn dark" onClick={() => { setUndo(scene.script); setScript(suggestion); }}>Приложи</button>
          <button type="button" className="btn" onClick={() => setSuggestion("")}>Отхвърли</button></div>}
      </div>
      {undo !== null && <button type="button" className="btn" onClick={() => { setScript(undo); setUndo(null); }}>Върни предишния сценарий</button>}
      {scene.script.length > 0 && scriptError && <Notice error>{scriptError}</Notice>}
      {!scriptError && estimate > longestVideo && <Notice>Около {estimate} сек. реч — едно видео приема до {longestVideo} сек. Разделете текста на няколко сцени.</Notice>}
      {!scriptError && scene.script.trim() && estimate < MIN_VIDEO_SECONDS && <Notice>Около {estimate} сек. реч. За видео са нужни поне {MIN_VIDEO_SECONDS} сек.</Notice>}
      {media.stale && <Notice>Сценарият или гласът са променени след последния запис. Създайте гласа отново, за да ги чуете във видеото.</Notice>}
      <Button className="btn primary st-wide" busy={busy === "audio"} disabled={!studioEnabled || !voiceOk || !!scriptError || isBusy(audio) || cost > remaining || !user?.verified || busy !== null}
        onClick={() => onGenerateAudio(cost)}>
        {ready ? <RefreshCw size={16} /> : <Mic size={16} />} {ready ? "Създай гласа отново" : "Създай глас"} · {number(cost)} кредита
      </Button>
      {!studioEnabled && <p className="st-fine">Премиум озвучаването ще бъде достъпно след активиране.</p>}
      {!user?.verified && <p className="st-fine">Потвърдете имейла си, за да създавате глас и видео.</p>}
      {cost > remaining && <p className="st-fine">Нужни са още {number(cost - remaining)} кредита. <Link to="/app/billing">Вижте плановете</Link></p>}
      {isBusy(audio) && <Notice>{jobStatus(audio!)} — гласът се създава във фонов режим. Можете да продължите с другите сцени.</Notice>}
      {audio?.status === "failed" && <Notice error>{audio.error || "Гласът не беше създаден."} Кредитите са върнати.</Notice>}
      {media.audios.length > 1 && <label>Версия на гласа<select value={audio?.id || ""} onChange={(e) => onSelectAudio(e.target.value)}>
        {media.audios.map((j) => <option key={j.id} value={j.id}>{when(j)} · {jobStatus(j)}{j.status === "completed" ? ` · ${j.duration.toFixed(1)} сек.` : ""}</option>)}
      </select></label>}
      {ready && <audio key={ready.id} controls src={`/api/jobs/${ready.id}/audio`} className="st-audio" />}
    </section>

    <section className="st-block" aria-labelledby="st-video-h">
      <h3 id="st-video-h"><Film size={17} /> Видео аватар</h3>
      {!planAllowsVideo && <Notice>{VIDEO_PLAN_MESSAGE} С текущия план можете да подготвите сцените и гласа. <Link to="/app/billing">Вижте плановете</Link></Notice>}
      {media.video?.status === "completed" && <p className="st-ok">Видеото е готово · {when(media.video)}</p>}
      {media.pendingVideo && <Notice>{jobStatus(media.pendingVideo)}. Видеото се появява в прегледа, щом е готово — можете да затворите страницата.</Notice>}
      {media.video?.status === "failed" && <Notice error>{media.video.error || "Видеото не беше създадено."} Кредитите за него са върнати.</Notice>}
      {media.videos.filter((v) => v.source_job_id === audio?.id).length > 1 && <label>Версия на видеото<select value={media.video?.id || ""} onChange={(e) => onSelectVideo(e.target.value)}>
        {media.videos.filter((v) => v.source_job_id === audio?.id).map((v) => <option key={v.id} value={v.id}>{when(v)} · {jobStatus(v)}</option>)}
      </select></label>}
      <div className="st-tiers" role="group" aria-label="Качество на видеото">
        {(Object.keys(videoTiers) as VideoTier[]).map((id) => <button type="button" key={id} aria-pressed={tier === id} disabled={!tierOpen(id)} onClick={() => { picked.current = { scene: scene.id, tier: id }; setTier(id); }}>
          <strong>{videoTiers[id].name}</strong><small>{number(videoTiers[id].creditsPerSecond)} кр. / сек.</small>
          <small>{videoConfig?.tiers[id] ? `до ${videoConfig.maxSeconds[id] >= 120 ? "2 мин." : `${videoConfig.maxSeconds[id]} сек.`}` : "Недостъпно"}</small>
        </button>)}
      </div>
      {videoConfig?.tiers.medium && !mediumAllowed && <p className="st-fine">Средно качество е достъпно с отбелязаните готови аватари. Изберете такъв от „Смени аватара“ или друго качество.</p>}
      <label className="checkbox-label"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        {scene.portrait?.type === "library" ? "Ще използвам синтетичния аватар за съдържание, за което имам необходимите права, и ще го обознача като създадено с ИИ, когато може да бъде възприето като истинско." : "Аз съм изобразеният човек или имам неговото изрично съгласие да бъде създадено видео с образа му и синтетичен глас. Ще обознача видеото като създадено с ИИ, когато го публикувам."}</label>
      {videoConfig?.emailNotifications && <label className="checkbox-label"><input type="checkbox" checked={notifyEmail} onChange={(e) => setNotifyEmail(e.target.checked)} /> Уведоми ме по имейл, когато е готово</label>}
      <Button className="btn dark st-wide" busy={busy === "video"} disabled={!!videoBlocked || !consent || !tierOpen(tier) || !videoCost || videoCost > remaining || !user?.verified || busy !== null}
        onClick={() => onCreateVideo({ tier, consent, notifyEmail: !!videoConfig?.emailNotifications && notifyEmail }, videoCost)}>
        <Sparkles size={16} /> {media.video?.status === "completed" ? "Създай видеото отново" : "Създай видео"}{videoCost ? ` · ${number(videoCost)} кредита` : ""}
      </Button>
      {videoBlocked && planAllowsVideo && <p className="st-fine">{videoBlocked}</p>}
      {videoCost > remaining && <p className="st-fine">Нямате достатъчно кредити. <Link to="/app/billing">Вижте плановете</Link></p>}
      <p className="st-fine">Видеото се таксува отделно от гласа, за всяка започната секунда. При неуспех кредитите се връщат.</p>
    </section>

    <section className="st-block" aria-labelledby="st-timing-h">
      <h3 id="st-timing-h"><ImageIcon size={17} /> Време и фон</h3>
      <label>Сила на гласа · {Math.round(scene.voiceVolume * 100)}%<input type="range" min="0" max="1" step=".05" value={scene.voiceVolume} onChange={(e) => onChange((s) => ({ ...s, voiceVolume: Number(e.target.value) }))} /></label>
      <label>Пауза преди гласа · {scene.speechStart.toFixed(1)} сек.<input type="range" min="0" max={MAX_LEAD} step=".1" value={scene.speechStart} onChange={(e) => onChange((s) => ({ ...s, speechStart: Number(e.target.value) }))} /></label>
      <label>Задържане в края · {scene.tail.toFixed(1)} сек.<input type="range" min="0" max={MAX_TAIL} step=".1" value={scene.tail} onChange={(e) => onChange((s) => ({ ...s, tail: Number(e.target.value) }))} /></label>
      <BackgroundControl background={scene.background} assets={assets} fit={fit} onChange={(background) => onChange((s) => ({ ...s, background }))} />
    </section>

    <section className="st-block" aria-labelledby="st-layers-h">
      <h3 id="st-layers-h">Слоеве на сцената</h3>
      <p className="st-fine">Новият слой започва от позицията на плейхеда. Изберете го на времевата линия, за да го редактирате.</p>
      <LayerAddBar onAdd={(type) => type === "text" ? onAddLayer("text") : setAdding(type)} onLogo={hasLogo ? () => onAddLayer("logo") : undefined} />
      {adding && <div className="st-adding">
        <strong>Нов слой · {layerNames[adding]}</strong>
        <MediaPicker assets={assets} video={adding === "broll"} onPick={(assetId) => { onAddMediaLayer(adding, assetId); setAdding(null); }} />
        <button type="button" className="btn" onClick={() => setAdding(null)}>Отказ</button>
      </div>}
    </section>
  </div>;
}
