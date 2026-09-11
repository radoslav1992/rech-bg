import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Film, Sparkles, ImagePlus } from "lucide-react";
import { avatars, videoTiers, videoCredits, type VideoTier } from "../shared/video";
import { api, Button, Notice, number, useAuth, type Job } from "./lib";
export function VideoPanel({ jobs, currentJob, disabled, onCreated }: { jobs: Job[]; currentJob: Job | null; disabled: boolean; onCreated: (job: Job) => void }) {
  const { user, refresh } = useAuth();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [tier, setTier] = useState<VideoTier>("standard");
  const [sourceId, setSourceId] = useState("");
  const [avatar, setAvatar] = useState<string>(avatars[0].id);
  const [image, setImage] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());
  const sources = jobs.filter(j => j.kind !== "video" && j.status === "completed" && j.mode !== "podcast");
  const source = sources.find(j => j.id === sourceId) || sources[0];
  let cost = 0, durationError = "";
  if (source) {
    try { cost = videoCredits(source.duration, tier); } catch (e) { durationError = (e as Error).message; }
  }
  const remaining = Math.max(0, (user?.limit || 0) - (user?.used || 0));
  useEffect(() => { api("/videos/config").then(d => setEnabled(d.enabled)).catch(() => setEnabled(false)); }, []);
  useEffect(() => {
    if (!image) { setImageUrl(""); return; }
    const url = URL.createObjectURL(image); setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);
  const edit = (fn: () => void) => { setError(""); fn(); key.current = crypto.randomUUID(); };
  const generate = async () => {
    if (!source || !cost) return;
    setBusy(true); setError("");
    try {
      const body = new FormData();
      body.set("sourceId", source.id); body.set("tier", tier);
      body.set("idempotencyKey", key.current); body.set("credits", String(cost));
      body.set("avatar", avatar); body.set("consent", String(consent));
      if (tier === "quality" && image) body.set("image", image);
      const result = await api("/videos", { method: "POST", body });
      const { job } = await api("/jobs/" + result.id);
      onCreated(job); key.current = crypto.randomUUID(); await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="output-panel avatar-panel">
    <div className="sub-heading"><h2><Film size={22} /> Дайте лице на гласа</h2><span>ВИДЕО АВАТАР</span></div>
    <p>Превърнете готовия си аудиозапис в говорещо видео. Изберете водещ или оживете свой портрет.</p>
    <div aria-live="polite">
      {currentJob?.kind === "video" && currentJob.status === "failed" && <Notice>{currentJob.error} Номер на заявката: {currentJob.id}</Notice>}
      {currentJob?.kind === "video" && ["queued", "running"].includes(currentJob.status) && <p>Видеото се създава. Това може да отнеме няколко минути.</p>}
      {currentJob?.kind === "video" && currentJob.status === "completed" && <p>Видеото е готово. Можете да го гледате и изтеглите от „Вашият запис“ по-горе.</p>}
    </div>
    {enabled === false && <Notice>Създаването на видео ще бъде достъпно скоро.</Notice>}
    {!sources.length ? <div className="output-empty"><Film size={30} /><p>Първо създайте аудио с един глас, с продължителност от 5 до 60 секунди.</p></div> : <>
      <fieldset disabled={busy || disabled || !enabled} className="avatar-fields">
        <label>Аудиозапис<select value={source?.id || ""} onChange={e => edit(() => setSourceId(e.target.value))}>
          {sources.map(j => <option key={j.id} value={j.id}>{j.title} · {Math.ceil(j.duration)} сек. · {new Date(j.created_at * 1000).toLocaleString("bg")}</option>)}
        </select></label>
        <div className="avatar-tiers" role="group" aria-label="Качество на видеото">
          {(Object.keys(videoTiers) as VideoTier[]).map(id => <button type="button" key={id} aria-pressed={tier === id} className={tier === id ? "selected" : ""} onClick={() => edit(() => setTier(id))}>
            <strong>{videoTiers[id].name}</strong><span>{number(videoTiers[id].creditsPerSecond)} кредита / сек.</span>
            <small>{id === "standard" ? "Готови водещи за вашите истории" : "Ваш портрет с изразително движение"}</small>
          </button>)}
        </div>
        {tier === "standard" ? <label>Изберете водещ<select value={avatar} onChange={e => edit(() => setAvatar(e.target.value))}>
          {avatars.map(a => <option key={a.id} value={a.id}>{a.name} · {a.scene}</option>)}
        </select></label> : <div className="avatar-portrait">
          <label><ImagePlus size={18} /> Вашият портрет<input type="file" accept="image/jpeg,image/png" onChange={e => edit(() => {
            const file = e.target.files?.[0] || null;
            if (file && file.size > 2 * 1024 * 1024) { setImage(null); e.target.value = ""; setError("Изберете изображение до 2 MB."); return; }
            setImage(file); setConsent(false);
          })} /></label>
          <p className="small-note">JPG или PNG до 2 MB, с ясно видимо лице. За вертикално видео използвайте вертикален портрет.</p>
          {imageUrl && <img src={imageUrl} alt="Вашият портрет за видеото" />}
          <label className="checkbox-label"><input type="checkbox" checked={consent} onChange={e => edit(() => setConsent(e.target.checked))} /> Имам право да използвам изображението и съгласието на изобразения човек.</label>
        </div>}
      </fieldset>
      {durationError && <Notice>{durationError}</Notice>}
      {error && <Notice>{error}</Notice>}
      <div className="generate-bar">
        <div><strong>{number(cost)} кредита за видеото</strong><small>Налични: {number(remaining)} кредита</small></div>
        <Button className="btn dark" busy={busy} disabled={disabled || !enabled || !user?.verified || !cost || cost > remaining || (tier === "quality" && (!image || !consent))} onClick={generate}>
          <Sparkles size={18} /> Създай видео · {number(cost)} кредита
        </Button>
      </div>
      {cost > remaining && <p className="small-note">Нямате достатъчно кредити. <Link to="/app/billing">Вижте плановете</Link></p>}
      <p className="small-note">Цената е допълнителна към вече създаденото аудио. Всяка започната секунда се брои за цяла. При неуспешно видео кредитите за него се връщат. Можете да затворите страницата — резултатът ще ви очаква в проекта.</p>
    </>}
  </section>;
}
