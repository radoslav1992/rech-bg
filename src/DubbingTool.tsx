import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Download, Languages } from "lucide-react";
import { api, Button, Notice, number, useAuth } from "./lib";
import { canCreateVideo, VIDEO_PLAN_MESSAGE } from "../shared/catalog";
import { translateCredits, translateModes, type AiTask, type TranslateMode } from "../shared/tools";
import type { MediaAsset } from "../shared/media";
import { VideoSource } from "./VideoSource";

// Uploads, studio exports and avatar videos made in the studio, up to 10 minutes.
const dubbable = (a: MediaAsset) => ["upload", "export", "video"].includes(a.kind) && a.status === "ready" && a.mime.startsWith("video/") && a.duration > 0 && a.duration <= 600;
const phases: Record<string, string> = { queued: "На опашка", processing: "Превежда се", saving: "Запазване", completed: "Готово" };

/**
 * "Превод с дублаж": a video from the library in another language, with the speakers' voices and (optionally)
 * their lips matched. The result is a new video in the library.
 */
export function DubbingTool({ assets, onDone, initialAsset = "" }: { assets: MediaAsset[]; onDone: () => void; initialAsset?: string }) {
  const { user, refresh } = useAuth();
  const [enabled, setEnabled] = useState<boolean | null>(null), [languages, setLanguages] = useState<string[]>([]), [popular, setPopular] = useState<string[]>([]);
  const [tasks, setTasks] = useState<AiTask[]>([]);
  const [assetId, setAssetId] = useState(initialAsset), [language, setLanguage] = useState("English"), [mode, setMode] = useState<TranslateMode>("speed");
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [done, setDone] = useState("");
  const key = useRef(crypto.randomUUID());
  const loadTasks = useCallback(() => api<{ tasks: AiTask[] }>("/tools/tasks").then((d) => setTasks(d.tasks.filter((t) => t.kind === "translate"))).catch(() => {}), []);
  useEffect(() => {
    api<{ translate: { enabled: boolean } }>("/tools/config").then((d) => {
      setEnabled(d.translate.enabled);
      if (d.translate.enabled) {
        void loadTasks();
        api<{ languages: string[]; popular: string[] }>("/tools/languages").then((l) => { setLanguages(l.languages); setPopular(l.popular || []); }).catch(() => {});
      }
    }).catch(() => setEnabled(false));
  }, [loadTasks]);
  // Follow running tasks; the library refreshes when one finishes.
  const running = tasks.some((t) => t.status === "queued" || t.status === "running");
  const finished = useRef(new Set<string>());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { if (!document.hidden) void loadTasks(); }, 10000);
    return () => window.clearInterval(timer);
  }, [running, loadTasks]);
  useEffect(() => {
    const fresh = tasks.filter((t) => t.status !== "queued" && t.status !== "running" && !finished.current.has(t.id));
    const first = finished.current.size === 0;
    fresh.forEach((t) => finished.current.add(t.id));
    if (!first && fresh.length) { onDone(); void refresh(); }
  }, [tasks, onDone, refresh]);

  if (enabled === false) return <Notice>Преводът на видео ще бъде достъпен скоро.</Notice>;
  const source = assets.find((a) => a.id === assetId && dubbable(a));
  let cost = 0, costError = "";
  if (source) { try { cost = translateCredits(source.duration, mode); } catch (e) { costError = (e as Error).message; } }
  const remaining = Math.max(0, (user?.limit || 0) - (user?.used || 0));
  const allowed = canCreateVideo(user?.plan);
  const start = async () => {
    if (!source) return;
    setBusy(true); setError(""); setDone("");
    try {
      await api("/tools/translate", { method: "POST", body: JSON.stringify({ assetId: source.id, language, mode, idempotencyKey: key.current, credits: cost, consent }) });
      key.current = crypto.randomUUID();
      setDone("Преводът започна. Обикновено отнема няколко минути; готовото видео се появява във „Вашите файлове“.");
      setConsent(false);
      await Promise.all([loadTasks(), refresh(), onDone()]);
    } catch (e) {
      if (!(e instanceof TypeError)) key.current = crypto.randomUUID();
      setError((e as Error).message);
    } finally { setBusy(false); }
  };
  const others = languages.filter((l) => !popular.includes(l));
  return <div className="dubbing-tool">
    <p>Преведете видео на друг език — със същите гласове и, по избор, с движение на устните по новия текст. Резултатът е ново видео във „Вашите файлове“.</p>
    {!allowed && <Notice>{VIDEO_PLAN_MESSAGE} <Link to="/app/billing">Вижте плановете</Link></Notice>}
    {error && <Notice error>{error}</Notice>}
    {done && <Notice good>{done}</Notice>}
    <VideoSource assets={assets} eligible={dubbable} value={assetId} onChange={setAssetId} onUploaded={onDone}
      describe={(a) => `${a.name} · ${Math.ceil(a.duration)} сек.`} requirement="е по-дълго от 10 минути." />
    <label>Език на превода
      <select value={language} onChange={(e) => setLanguage(e.target.value)}>
        {!languages.length && <option value="English">English</option>}
        {popular.length > 0 && <optgroup label="Често използвани">{popular.map((l) => <option key={l} value={l}>{l}</option>)}</optgroup>}
        {others.length > 0 && <optgroup label="Всички езици">{others.map((l) => <option key={l} value={l}>{l}</option>)}</optgroup>}
      </select>
    </label>
    <div className="dubbing-modes" role="radiogroup" aria-label="Вид на превода">
      {(Object.keys(translateModes) as TranslateMode[]).map((m) => <label key={m} className={`dubbing-mode${mode === m ? " selected" : ""}`}>
        <input type="radio" name="dubbing-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
        <strong>{translateModes[m].name}</strong>
        <small>{translateModes[m].description}</small>
        <small>{number(translateModes[m].creditsPerSecond)} кр. / сек.</small>
      </label>)}
    </div>
    {costError && <Notice error>{costError}</Notice>}
    <label className="checkbox-label"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
      Имам право да обработвам видеото и гласовете в него, включително да бъдат пресъздадени на друг език. Ще обознача превода като създаден с ИИ, когато го публикувам.</label>
    <Button className="btn primary" busy={busy} disabled={!allowed || !source || !cost || !consent || cost > remaining || !user?.verified || busy} onClick={start}>
      <Languages size={16} /> Преведи{cost ? ` · ${number(cost)} кредита` : ""}
    </Button>
    {cost > remaining && <p className="vs-fine">Нужни са още {number(cost - remaining)} кредита. <Link to="/app/billing">Вижте плановете</Link></p>}
    <p className="vs-fine">Цената е за всяка започната секунда от видеото. Ако преводът не успее, кредитите се връщат автоматично.</p>
    {tasks.length > 0 && <div className="dubbing-tasks" aria-live="polite">
      <h3>Последни преводи</h3>
      {tasks.slice(0, 6).map((t) => <div key={t.id} className="dubbing-task">
        <span><strong>{t.sourceName}</strong> → {t.language} · {t.mode && t.mode in translateModes ? translateModes[t.mode as TranslateMode].name : ""}</span>
        <span className={`dubbing-status ${t.status}`}>{t.status === "failed" ? "Неуспешен" : phases[t.status === "completed" ? "completed" : t.phase] || "Обработва се"}</span>
        {t.status === "completed" && <a className="btn" href={`/api/media/assets/${t.outputAssetId}/file`} download aria-label={`Изтегли превода на ${t.sourceName}`}><Download size={15} /></a>}
        {t.status === "failed" && t.error && <small>{t.error}</small>}
      </div>)}
    </div>}
  </div>;
}
