import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Film, Sparkles, ImagePlus } from "lucide-react";
import { videoTiers, videoCredits, type VideoTier } from "../shared/video";
import { api, Button, Notice, number, useAuth, type Job } from "./lib";
import { jobLink, jobStatus } from "./JobActivity";
export function VideoPanel({ jobs, approved, activeJob, submissionBlocked, onCreated }: { jobs: Job[]; approved: boolean; activeJob: Job | null; submissionBlocked: boolean; onCreated: (job: Job) => void }) {
  const { user, refresh } = useAuth();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [tier, setTier] = useState<VideoTier>("medium");
  const [available, setAvailable] = useState<Record<VideoTier, boolean>>({ low: false, medium: false, high: false });
  const [image, setImage] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [consent, setConsent] = useState(false);
  const [emailAvailable, setEmailAvailable] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());
  const submitting = useRef(false);
  const [configAttempt, setConfigAttempt] = useState(0);
  const sources = jobs.filter(j => j.kind !== "video" && j.status === "completed" && j.mode !== "podcast");
  const source = sources[0];
  let cost = 0, durationError = "";
  if (source) {
    try { cost = videoCredits(source.duration, tier); } catch (e) { durationError = (e as Error).message; }
  }
  const remaining = Math.max(0, (user?.limit || 0) - (user?.used || 0));
  useEffect(() => {
    let live = true;
    setEnabled(null);
    api("/videos/config").then(d => {
      if (!live) return;
      setEnabled(d.enabled); setEmailAvailable(d.emailNotifications);
      const enabledTiers = { low: !!d.tiers.low?.enabled, medium: !!d.tiers.medium?.enabled, high: !!d.tiers.high?.enabled };
      setAvailable(enabledTiers);
      setTier(current => enabledTiers[current] ? current : enabledTiers.medium ? "medium" : enabledTiers.low ? "low" : "high");
    }).catch(() => { if (live) setEnabled(false); });
    return () => { live = false; };
  }, [configAttempt]);
  useEffect(() => { key.current = crypto.randomUUID(); }, [source?.id]);
  useEffect(() => {
    if (!image) { setImageUrl(""); return; }
    const url = URL.createObjectURL(image); setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);
  const edit = (fn: () => void) => { setError(""); fn(); key.current = crypto.randomUUID(); };
  const generate = async () => {
    if (submitting.current || !source || !cost || !approved || submissionBlocked || activeJob || !enabled || !available[tier] || !image || !consent || !user?.verified || cost > remaining) return;
    submitting.current = true;
    setBusy(true); setError("");
    try {
      const body = new FormData();
      body.set("sourceId", source.id); body.set("tier", tier);
      body.set("idempotencyKey", key.current); body.set("credits", String(cost));
      body.set("consent", String(consent));
      body.set("notifyEmail", String(emailAvailable && notifyEmail));
      if (image) body.set("image", image);
      const result = await api("/videos", { method: "POST", body });
      const { job } = await api("/jobs/" + result.id);
      onCreated(job); key.current = crypto.randomUUID(); await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <section className="output-panel avatar-panel">
    <div className="sub-heading"><h2><Film size={22} /> Дайте лице на гласа</h2><span>ВИДЕО АВАТАР</span></div>
    <p>Превърнете готовия си аудиозапис в говорещо видео. Качете портрет и изберете едно от трите нива на качество.</p>
    <div aria-live="polite">
      {activeJob && <Notice>„{activeJob.title}“ — {jobStatus(activeJob).toLowerCase()}. Можете да подготвите следващото видео. Генерирането ще се отключи след завършване на текущата заявка. <Link to={jobLink(activeJob)}>Проследете заявката</Link></Notice>}
      {enabled === null && <p>Проверка на наличните нива на качество…</p>}
      {enabled === false && <Notice>Не успяхме да заредим налично видео качество. <button className="btn" type="button" onClick={() => setConfigAttempt(n => n + 1)}>Провери отново</button></Notice>}
      {!source && <p>Създайте и прослушайте аудиозапис от 5 до 60 секунди. Можете да подготвите портрета и качеството още сега.</p>}
      {source && !approved && <Notice>Одобрете избраната версия на гласа по-горе, за да създадете видео. Настройките ви се запазват, докато редактирате сценария.</Notice>}
    </div>
      <fieldset disabled={busy} className="avatar-fields">
        {source && <div className="video-source-summary"><strong>Избрана версия на гласа</strong><p>{source.title} · {Math.ceil(source.duration)} сек. · {new Date(source.created_at * 1000).toLocaleString("bg")}</p><small>За друга версия използвайте избора на глас в секцията за прослушване.</small></div>}
        <div className="avatar-tiers" role="group" aria-label="Качество на видеото">
          {(Object.keys(videoTiers) as VideoTier[]).map(id => <button type="button" key={id} disabled={!available[id]} aria-pressed={tier === id} className={tier === id ? "selected" : ""} onClick={() => edit(() => setTier(id))}>
            <strong>{videoTiers[id].name}</strong><span>{number(videoTiers[id].creditsPerSecond)} кредита / сек.</span>
            <small>{available[id] ? videoTiers[id].description : "Временно недостъпно"}</small>
          </button>)}
        </div>
        <div className="avatar-portrait">
          <label><ImagePlus size={18} /> Вашият портрет<input type="file" accept="image/jpeg,image/png" onChange={e => edit(() => {
            const file = e.target.files?.[0] || null;
            if (file && file.size > 2 * 1024 * 1024) { setImage(null); e.target.value = ""; setError("Изберете изображение до 2 MB."); return; }
            setImage(file); setConsent(false);
          })} /></label>
          <p className="small-note">JPG или PNG до 2 MB, с ясно видимо лице. За вертикално видео използвайте вертикален портрет.</p>
          {imageUrl && <img src={imageUrl} alt="Вашият портрет за видеото" />}
          <label className="checkbox-label"><input type="checkbox" checked={consent} onChange={e => edit(() => setConsent(e.target.checked))} /> Имам право да използвам изображението и съгласието на изобразения човек.</label>
        </div>
        {emailAvailable && <label className="checkbox-label"><input type="checkbox" checked={notifyEmail} onChange={e => edit(() => setNotifyEmail(e.target.checked))} /> Уведоми ме по имейл, когато видеото е готово или ако възникне грешка.</label>}
      </fieldset>
      {durationError && <Notice>{durationError}</Notice>}
      {error && <Notice>{error}</Notice>}
      <div className="generate-bar">
        <div><strong>{number(cost)} кредита за видеото</strong><small>Налични: {number(remaining)} кредита</small></div>
        <Button className="btn dark" busy={busy} disabled={submissionBlocked || !!activeJob || !source || !approved || !enabled || !available[tier] || !user?.verified || !cost || cost > remaining || !image || !consent} onClick={generate}>
          <Sparkles size={18} /> Създай видео · {number(cost)} кредита
        </Button>
      </div>
      {cost > remaining && <p className="small-note">Нямате достатъчно кредити. <Link to="/app/billing">Вижте плановете</Link></p>}
      <p className="small-note">Цената е допълнителна към вече създаденото аудио. Всяка започната секунда се брои за цяла. При неуспешно видео кредитите за него се връщат. Можете да затворите страницата — резултатът ще ви очаква в проекта.</p>
  </section>;
}
