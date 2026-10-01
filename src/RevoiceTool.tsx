import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Captions, Download, Mic } from "lucide-react";
import { api, Button, Notice, number, post, useAuth } from "./lib";
import { canCreateVideo, VIDEO_PLAN_MESSAGE } from "../shared/catalog";
import { mediaCredits, type MediaAsset } from "../shared/media";
import {
  CLONE_VOICE, REVOICE_MAX_CHARS, REVOICE_MAX_SECONDS, revoiceCredits, revoiceModes, speechSeconds, type AiTask, type RevoiceMode,
} from "../shared/tools";
import type { StudioVoice } from "../shared/studio";
import { VideoSource } from "./VideoSource";

// Filmed videos (uploads, studio exports, avatar videos) of 3 seconds to 3 minutes.
const revoiceable = (a: MediaAsset) => ["upload", "export", "video"].includes(a.kind) && a.status === "ready" && a.mime.startsWith("video/")
  && a.duration >= 3 && a.duration <= REVOICE_MAX_SECONDS;
const phases: Record<string, string> = { queued: "На опашка", voice: "Нов глас", processing: "Движение на устните", saving: "Запазване", completed: "Готово" };

/**
 * "Преозвучаване": new words for a filmed video. The new text is spoken by the speaker's own voice (cloned from
 * the video for this task only) or a studio voice, and the lips follow it. The result is a new video in the library.
 */
export function RevoiceTool({ assets, onDone }: { assets: MediaAsset[]; onDone: () => void }) {
  const { user, refresh } = useAuth();
  const [config, setConfig] = useState<{ enabled: boolean; voices: StudioVoice[] } | null>(null);
  const [tasks, setTasks] = useState<AiTask[]>([]);
  const [assetId, setAssetId] = useState(""), [text, setText] = useState(""), [original, setOriginal] = useState("");
  const [voice, setVoice] = useState(CLONE_VOICE), [mode, setMode] = useState<RevoiceMode>("speed");
  const [consent, setConsent] = useState(false), [voiceConsent, setVoiceConsent] = useState(false);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [done, setDone] = useState("");
  const key = useRef(crypto.randomUUID()), transcribeKey = useRef(crypto.randomUUID());
  const loadTasks = useCallback(() => api<{ tasks: AiTask[] }>("/tools/tasks").then((d) => setTasks(d.tasks.filter((t) => t.kind === "lipsync"))).catch(() => {}), []);
  useEffect(() => {
    api<{ revoice?: { enabled: boolean; voices: StudioVoice[] } }>("/tools/config")
      .then((d) => { setConfig(d.revoice || { enabled: false, voices: [] }); if (d.revoice?.enabled) void loadTasks(); })
      .catch(() => setConfig({ enabled: false, voices: [] }));
  }, [loadTasks]);
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

  const source = assets.find((a) => a.id === assetId && revoiceable(a));
  // The current words of the video are the starting point for the new text.
  const transcribed = !!source?.hasCaptions;
  useEffect(() => {
    if (!source || !transcribed) return;
    let live = true;
    api<{ words?: { text: string }[] }>(`/media/assets/${source.id}/captions`).then((d) => {
      const words = (d.words || []).map((w) => w.text).join(" ").trim();
      if (!live || !words) return;
      setOriginal(words);
      setText((current) => current.trim() ? current : words.slice(0, REVOICE_MAX_CHARS));
    }).catch(() => {});
    return () => { live = false; };
  }, [source?.id, transcribed]);
  const choose = (id: string) => { setAssetId(id); setText(""); setOriginal(""); setError(""); setDone(""); };

  if (config && !config.enabled) return <Notice>Преозвучаването ще бъде достъпно скоро.</Notice>;
  let cost = 0, costError = "";
  if (source && text.trim()) { try { cost = revoiceCredits(source.duration, text, mode); } catch (e) { costError = (e as Error).message; } }
  const remaining = Math.max(0, (user?.limit || 0) - (user?.used || 0));
  const allowed = canCreateVideo(user?.plan);
  const clone = voice === CLONE_VOICE;
  const transcribeCost = source ? mediaCredits("transcribe", source.duration) : 0;
  const transcribe = async () => {
    if (!source) return;
    setBusy("transcribe"); setError("");
    try {
      await post("/media/transcribe", { assetId: source.id, idempotencyKey: transcribeKey.current, credits: transcribeCost });
      transcribeKey.current = crypto.randomUUID();
      onDone(); await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  };
  const start = async () => {
    if (!source || !cost) return;
    setBusy("start"); setError(""); setDone("");
    try {
      await post("/tools/revoice", { assetId: source.id, text: text.trim(), voice, mode, idempotencyKey: key.current, credits: cost, consent, voiceConsent: clone ? voiceConsent : undefined });
      key.current = crypto.randomUUID();
      setDone("Преозвучаването започна. Обикновено отнема няколко минути; готовото видео се появява във „Вашите файлове“.");
      setConsent(false); setVoiceConsent(false);
      await Promise.all([loadTasks(), refresh(), onDone()]);
    } catch (e) {
      if (!(e instanceof TypeError)) key.current = crypto.randomUUID();
      setError((e as Error).message);
    } finally { setBusy(""); }
  };
  const seconds = speechSeconds(text);
  return <div className="dubbing-tool revoice-tool">
    <p>Сменете думите в заснето видео, без да снимате отново: новият текст се изговаря с вашия глас (или студиен глас), а устните следват думите. Резултатът е ново видео във „Вашите файлове“.</p>
    {!allowed && <Notice>{VIDEO_PLAN_MESSAGE} <Link to="/app/billing">Вижте плановете</Link></Notice>}
    {error && <Notice error>{error}</Notice>}
    {done && <Notice good>{done}</Notice>}
    <VideoSource assets={assets} eligible={revoiceable} value={assetId} onChange={choose} onUploaded={onDone}
      describe={(a) => `${a.name} · ${Math.ceil(a.duration)} сек.`} requirement="е по-дълго от 3 минути. Изрежете го или изберете по-кратко видео." />
    {source && !transcribed && source.kind === "upload" && <div className="shorts-step">
      <p><Captions size={16} /> По желание: разпознайте речта, за да започнете от думите във видеото и само да ги поправите.</p>
      <Button className="btn" busy={busy === "transcribe"} disabled={!!busy || transcribeCost > remaining || !user?.verified} onClick={transcribe}>
        Разпознай речта · {number(transcribeCost)} кредита</Button>
    </div>}
    {source && <label>Нов текст
      <textarea value={text} maxLength={REVOICE_MAX_CHARS} rows={6} onChange={(e) => setText(e.target.value)}
        placeholder="Напишете какво да казва човекът във видеото." />
      <small className="vs-fine">{number(text.trim().length)} / {number(REVOICE_MAX_CHARS)} символа · около {seconds} сек. реч, видеото е {Math.ceil(source.duration)} сек.
        {original && text.trim() !== original && <> · <button type="button" className="link-button" onClick={() => setText(original.slice(0, REVOICE_MAX_CHARS))}>Върни оригиналния текст</button></>}</small>
    </label>}
    {source && <label>Глас
      <select value={voice} onChange={(e) => setVoice(e.target.value)}>
        <option value={CLONE_VOICE}>Гласът от видеото (клониран само за тази задача)</option>
        {(config?.voices || []).map((v) => <option key={v.id} value={v.id}>{v.name} — {v.description}</option>)}
      </select>
    </label>}
    {source && clone && <label className="checkbox-label"><input type="checkbox" checked={voiceConsent} onChange={(e) => setVoiceConsent(e.target.checked)} />
      Гласът във видеото е моят или имам изричното съгласие на човека той да бъде клониран. Клонингът се използва само за тази задача и се изтрива веднага след нея.</label>}
    <div className="dubbing-modes" role="radiogroup" aria-label="Качество на движението на устните">
      {(Object.keys(revoiceModes) as RevoiceMode[]).map((m) => <label key={m} className={`dubbing-mode${mode === m ? " selected" : ""}`}>
        <input type="radio" name="revoice-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
        <strong>{revoiceModes[m].name}</strong>
        <small>{revoiceModes[m].description}</small>
        <small>{number(revoiceModes[m].creditsPerSecond)} кр. / сек.</small>
      </label>)}
    </div>
    {costError && <Notice error>{costError}</Notice>}
    <label className="checkbox-label"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
      Имам право да променям видеото и думите на хората в него. Ще обознача резултата като създаден с ИИ, когато го публикувам.</label>
    <Button className="btn primary" busy={busy === "start"} onClick={start}
      disabled={!allowed || !source || !cost || !consent || (clone && !voiceConsent) || cost > remaining || !user?.verified || !!busy}>
      <Mic size={16} /> Преозвучи{cost ? ` · ${number(cost)} кредита` : ""}
    </Button>
    {cost > remaining && <p className="vs-fine">Нужни са още {number(cost - remaining)} кредита. <Link to="/app/billing">Вижте плановете</Link></p>}
    <p className="vs-fine">Цената е за всяка започната секунда (на видеото или на новата реч, ако е по-дълга) плюс 3 кредита на символ за гласа. Ако не успее, кредитите се връщат автоматично.</p>
    {tasks.length > 0 && <div className="dubbing-tasks" aria-live="polite">
      <h3>Последни преозвучавания</h3>
      {tasks.slice(0, 6).map((t) => <div key={t.id} className="dubbing-task">
        <span><strong>{t.sourceName}</strong> · {t.voice === CLONE_VOICE ? "собствен глас" : config?.voices.find((v) => v.id === t.voice)?.name || "студиен глас"}</span>
        <span className={`dubbing-status ${t.status}`}>{t.status === "failed" ? "Неуспешно" : phases[t.status === "completed" ? "completed" : t.phase] || "Обработва се"}</span>
        {t.status === "completed" && <a className="btn" href={`/api/media/assets/${t.outputAssetId}/file`} download aria-label={`Изтегли преозвученото видео на ${t.sourceName}`}><Download size={15} /></a>}
        {t.status === "failed" && t.error && <small>{t.error}</small>}
      </div>)}
    </div>}
  </div>;
}
