import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Captions, Film, RotateCcw, Scissors, Upload, Wand2 } from "lucide-react";
import { Button, Notice, number, post, useAuth } from "../lib";
import { uploadMedia } from "../MediaTools";
import { isVideoAsset } from "../LayerTools";
import { autoCuts, defaultCutOptions, isFiller, keptDuration, type CutOptions } from "../../shared/cuts";
import { mediaCredits, mediaPhase, MB, type MediaAsset, type MediaTask } from "../../shared/media";
import type { CaptionDocument } from "../../shared/captions";
import type { ProjectScene, SceneClip } from "../../shared/project";

const MAX_CLIP_BYTES = 500 * MB;
const seconds = (n: number) => `${n.toFixed(1).replace(".0", "")} сек.`;

/** Picks one of the uploaded videos, or uploads a new one (it becomes usable after its automatic check). */
export function ClipPicker({ assets, value, onPick }: { assets: MediaAsset[]; value?: string; onPick: (assetId: string) => void }) {
  const [consent, setConsent] = useState(false), [progress, setProgress] = useState<number | null>(null), [error, setError] = useState("");
  const options = assets.filter((a) => isVideoAsset(a) && (a.status === "ready" || a.status === "checking"));
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_CLIP_BYTES) { setError("Изберете видео до 500 MB."); return; }
    setError(""); setProgress(0);
    try { onPick(await uploadMedia(file, "upload", setProgress)); }
    catch (e) { setError((e as Error).message); }
    finally { setProgress(null); }
  };
  return <div className="st-clip-picker">
    {error && <Notice error>{error}</Notice>}
    <label>Качено видео
      <select value={options.some((a) => a.id === value) ? value : ""} onChange={(e) => e.target.value && onPick(e.target.value)}>
        <option value="">Изберете от библиотеката…</option>
        {options.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.status === "ready" ? seconds(a.duration) : "проверка"}</option>)}
      </select>
    </label>
    <label className="checkbox-label"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Имам право да обработвам това видео и съдържанието му.</label>
    <label className={`btn tl-upload${!consent || progress !== null ? " disabled" : ""}`}><Upload size={15} /> {progress !== null ? `Качване · ${progress}%` : "Качи ново видео"}
      <input type="file" hidden style={{ display: "none" }} disabled={!consent || progress !== null} accept="video/mp4,video/quicktime,video/webm"
        onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
    </label>
    <small className="st-fine">MP4, MOV или WebM до 500 MB и 10 минути. Качените видеа се проверяват автоматично.</small>
  </div>;
}

/**
 * A filmed scene: the uploaded video with its own sound, its transcript (for captions and cuts),
 * "Мигновен монтаж" that removes long pauses and hesitation sounds, and voice cleanup.
 */
export function ClipSection({ scene, clip, assets, tasks, source, onChange, onChanged }: {
  scene: ProjectScene; clip: SceneClip; assets: MediaAsset[]; tasks: MediaTask[];
  /** The clip's transcript (uncut), once it exists. */
  source: CaptionDocument | null;
  onChange: (change: (s: ProjectScene) => ProjectScene) => void;
  /** The media library changed (a new upload or transcription). */
  onChanged: () => void;
}) {
  const { user, refresh } = useAuth();
  const [options, setOptions] = useState<CutOptions>(defaultCutOptions), [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());
  useEffect(() => { setReplacing(false); setError(""); key.current = crypto.randomUUID(); }, [scene.id, clip.assetId]);
  const asset = assets.find((a) => a.id === clip.assetId);
  const setClip = (change: Partial<SceneClip>) => onChange((s) => s.clip ? { ...s, clip: { ...s.clip, ...change } } : s);
  const pick = (assetId: string) => { onChange((s) => ({ ...s, clip: { assetId, keep: null, clean: s.clip?.clean ?? true } })); setReplacing(false); onChanged(); };

  if (!asset) return <section className="st-block">
    <h3><Film size={17} /> Заснето видео</h3>
    <Notice>Видеото на сцената вече не е в библиотеката (изтрито или с изтекъл срок). Изберете друго.</Notice>
    <ClipPicker assets={assets} onPick={pick} />
  </section>;

  const ready = asset.status === "ready" && asset.duration > 0;
  const transcribing = tasks.find((t) => t.kind === "transcribe" && t.source_id === asset.id && (t.status === "queued" || t.status === "running"));
  const failed = !transcribing && tasks.find((t) => t.kind === "transcribe" && t.source_id === asset.id && t.status === "failed");
  let cost = 0;
  try { if (ready) cost = mediaCredits("transcribe", asset.duration); } catch { /* Longer than the media tools accept. */ }
  const remaining = Math.max(0, (user?.limit || 0) - (user?.used || 0));
  const words = source?.words || [];
  const kept = ready ? keptDuration(clip.keep, asset.duration) : 0;
  const fillers = words.filter((w) => isFiller(w.text)).length;

  const transcribe = async () => {
    setBusy(true); setError("");
    try {
      await post("/media/transcribe", { assetId: asset.id, idempotencyKey: key.current, credits: cost });
      key.current = crypto.randomUUID(); onChanged(); await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return <>
    <section className="st-block" aria-labelledby="st-clip-h">
      <h3 id="st-clip-h"><Film size={17} /> Заснето видео</h3>
      <p><strong>{asset.name}</strong> · {ready ? seconds(asset.duration) : "проверява се…"}</p>
      {!ready && <Notice>Видеото се проверява автоматично. Прегледът и монтажът се появяват, щом проверката приключи.</Notice>}
      {replacing ? <>
        <ClipPicker assets={assets} value={asset.id} onPick={pick} />
        <button type="button" className="btn" onClick={() => setReplacing(false)}>Отказ</button>
      </> : <button type="button" className="btn" onClick={() => setReplacing(true)}><Film size={15} /> Смени видеото</button>}
      <label className="checkbox-label"><input type="checkbox" checked={clip.clean} onChange={(e) => setClip({ clean: e.target.checked })} />
        <span><Wand2 size={14} /> Изчисти звука — по-малко шум и бучене, равномерна сила на гласа (в експорта)</span></label>
    </section>

    <section className="st-block" aria-labelledby="st-cut-h">
      <h3 id="st-cut-h"><Scissors size={17} /> Мигновен монтаж</h3>
      {error && <Notice error>{error}</Notice>}
      {ready && !asset.hasCaptions && !transcribing && <>
        <p className="st-fine">Разпознаваме речта във видеото: получавате субтитри и монтажът знае къде са паузите и „ъъ“-тата.</p>
        {asset.kind === "upload" && cost > 0 ? <Button className="btn primary st-wide" busy={busy} disabled={cost > remaining || !user?.verified} onClick={transcribe}>
          <Captions size={16} /> Разпознай речта · {number(cost)} кредита</Button>
          : <p className="st-fine">Разпознаване на реч е достъпно за качени видеа до 10 минути.</p>}
        {cost > remaining && <p className="st-fine">Нужни са още {number(cost - remaining)} кредита. <Link to="/app/billing">Вижте плановете</Link></p>}
        {failed && <Notice error>{failed.error || "Разпознаването не успя."} Кредитите са върнати.</Notice>}
        <p className="st-fine">Разпознаването включва и първия експорт на проекта без допълнително заплащане.</p>
      </>}
      {transcribing && <Notice>{mediaPhase[transcribing.phase] || "Разпознаване на речта"}… Субтитрите и монтажът се появяват автоматично.</Notice>}
      {ready && asset.hasCaptions && !source && <p role="status" className="st-fine">Зареждане на субтитрите…</p>}
      {ready && source && <>
        <label>Най-дълга пауза · {seconds(options.maxPause)}
          <input type="range" min=".2" max="1.5" step=".1" value={options.maxPause} onChange={(e) => setOptions((o) => ({ ...o, maxPause: Number(e.target.value) }))} /></label>
        <label className="checkbox-label"><input type="checkbox" checked={options.fillers} onChange={(e) => setOptions((o) => ({ ...o, fillers: e.target.checked }))} />
          Махни „ъъ“, „ммм“ и други звуци на колебание{fillers ? ` (${fillers})` : ""}</label>
        <Button className="btn primary st-wide" disabled={!words.length} onClick={() => setClip({ keep: autoCuts(words, asset.duration, options) })}>
          <Scissors size={16} /> {clip.keep ? "Изрежи отново" : "Изрежи паузите"}</Button>
        {!words.length && <p className="st-fine">Във видеото не открихме реч, затова няма какво да изрежем.</p>}
        {clip.keep ? <div className="st-cut-summary" role="status">
          <strong>Премахнати {seconds(Math.max(0, asset.duration - kept))}</strong>
          <span>Остават {seconds(kept)} от {seconds(asset.duration)} · {clip.keep.length} {clip.keep.length === 1 ? "част" : "части"}</span>
          <button type="button" className="btn" onClick={() => setClip({ keep: null })}><RotateCcw size={15} /> Върни целия клип</button>
        </div> : <p className="st-fine">Целият клип е в сцената. Прегледът показва монтажа веднага, без изчакване.</p>}
        <p className="st-fine">Субтитрите следват монтажа. Думите се поправят в <Link to={`/app/media?asset=${asset.id}`}>Медия → Субтитри</Link>.</p>
      </>}
    </section>
  </>;
}
