import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Captions, Clapperboard, Scissors, Sparkles } from "lucide-react";
import { api, Button, Notice, number, post, useAuth } from "./lib";
import { mediaCredits, type MediaAsset } from "../shared/media";

type Clip = { title: string; hook: string; start: number; end: number; text: string };
type Made = { projectId: string; credits?: number; state: "quoted" | "rendering" | "error"; error?: string };
const time = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * "Кратки клипове": AI finds the strongest self-contained moments of a transcribed video; each becomes a vertical
 * video with captions (rendered like any studio export) or a studio project to fine-tune first.
 */
export function ShortsTool({ assets, onChange }: { assets: MediaAsset[]; onChange: () => void }) {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [assetId, setAssetId] = useState(""), [clips, setClips] = useState<Clip[] | null>(null);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [made, setMade] = useState<Record<number, Made>>({});
  const keys = useRef(new Map<string, string>());
  const videos = assets.filter((a) => ["upload", "export"].includes(a.kind) && a.status === "ready" && a.mime.startsWith("video/") && a.duration >= 20);
  const source = videos.find((a) => a.id === assetId);
  const remaining = Math.max(0, (user?.limit || 0) - (user?.used || 0));
  const key = (name: string) => { const k = keys.current.get(name) || crypto.randomUUID(); keys.current.set(name, k); return k; };
  const choose = (id: string) => { setAssetId(id); setClips(null); setMade({}); setError(""); };

  const transcribe = async () => {
    if (!source) return;
    setBusy("transcribe"); setError("");
    try {
      await post("/media/transcribe", { assetId: source.id, idempotencyKey: key(`transcribe:${source.id}`), credits: mediaCredits("transcribe", source.duration) });
      keys.current.delete(`transcribe:${source.id}`);
      onChange(); await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  };
  const find = async () => {
    if (!source) return;
    setBusy("find"); setError(""); setClips(null); setMade({});
    try { setClips((await post<{ clips: Clip[] }>("/tools/shorts/suggest", { assetId: source.id })).clips); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  };
  const project = async (i: number) => {
    const existing = made[i]?.projectId;
    if (existing) return existing;
    const c = clips![i];
    const { id } = await post<{ id: string }>("/tools/shorts/project", { assetId: source!.id, start: c.start, end: c.end, title: c.title });
    return id;
  };
  const quote = async (i: number) => {
    setBusy(`make:${i}`); setError("");
    try {
      const projectId = await project(i);
      const q = await api<{ credits: number }>(`/video-studio/projects/${projectId}/render/quote`);
      setMade((m) => ({ ...m, [i]: { projectId, credits: q.credits, state: "quoted" } }));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  };
  const render = async (i: number) => {
    const m = made[i];
    if (!m) return;
    setBusy(`render:${i}`); setError("");
    try {
      await post(`/video-studio/projects/${m.projectId}/render`, { idempotencyKey: key(`render:${m.projectId}`), credits: m.credits });
      setMade((all) => ({ ...all, [i]: { ...m, state: "rendering" } }));
      onChange(); await refresh();
    } catch (e) { setMade((all) => ({ ...all, [i]: { ...m, state: "error", error: (e as Error).message } })); }
    finally { setBusy(""); }
  };
  const openInStudio = async (i: number) => {
    setBusy(`studio:${i}`); setError("");
    try { navigate(`/app/video-studio/${await project(i)}`); }
    catch (e) { setError((e as Error).message); setBusy(""); }
  };

  const transcribeCost = source ? mediaCredits("transcribe", source.duration) : 0;
  return <div className="shorts-tool">
    <p>Изберете дълго видео с реч — ИИ предлага най-силните самостоятелни моменти от 15 до 60 секунди. Всеки става вертикално видео 9:16 със субтитри и изчистен звук, или проект във видео студиото за довършване.</p>
    {error && <Notice error>{error}</Notice>}
    <label>Видео
      <select value={assetId} onChange={(e) => choose(e.target.value)}>
        <option value="">Изберете видео от библиотеката</option>
        {videos.map((a) => <option key={a.id} value={a.id}>{a.name} · {time(a.duration)}{a.hasCaptions ? "" : " · без субтитри"}</option>)}
      </select>
    </label>
    {!videos.length && <p className="vs-fine">Нужно е качено видео с реч, поне 20 секунди. Качете такова в „Субтитри“.</p>}
    {source && !source.hasCaptions && <div className="shorts-step">
      <p><Captions size={16} /> Първо разпознаваме речта във видеото — по нея ИИ намира моментите, а клиповете получават субтитри.</p>
      {source.kind === "upload"
        ? <Button className="btn primary" busy={busy === "transcribe"} disabled={!!busy || transcribeCost > remaining || !user?.verified} onClick={transcribe}>
            Разпознай речта · {number(transcribeCost)} кредита</Button>
        : <p className="vs-fine">Разпознаване на реч е достъпно за качени видеа.</p>}
      <p className="vs-fine">Отнема около минута на 10 минути видео. Списъкът се обновява сам.</p>
    </div>}
    {source?.hasCaptions && <Button className="btn primary" busy={busy === "find"} disabled={!!busy || !user?.verified} onClick={find}>
      <Sparkles size={16} /> {clips ? "Потърси отново" : "Намери силните моменти"}</Button>}
    {source?.hasCaptions && <p className="vs-fine">Търсенето е безплатно (до 20 на ден). Създаването на клип се таксува като експорт на видео: 500 кредита за започната минута; първият клип от платено разпознаване е включен.</p>}
    {clips && <ol className="shorts-list">
      {clips.map((c, i) => {
        const m = made[i];
        return <li key={`${c.start}-${c.end}`} className="shorts-clip">
          <video src={`/api/media/assets/${source!.id}/file#t=${c.start},${c.end}`} controls preload="metadata" playsInline aria-label={`Преглед на „${c.title}“`} />
          <div>
            <strong>{c.title}</strong>
            <small>{time(c.start)} – {time(c.end)} · {Math.round(c.end - c.start)} сек.</small>
            {c.hook && <p className="shorts-hook">{c.hook}</p>}
            <p className="shorts-text">{c.text}</p>
            <div className="shorts-actions">
              {!m && <Button className="btn primary" busy={busy === `make:${i}`} disabled={!!busy} onClick={() => quote(i)}><Scissors size={15} /> Създай вертикален клип</Button>}
              {m?.state === "quoted" && <Button className="btn primary" busy={busy === `render:${i}`} disabled={!!busy || (m.credits || 0) > remaining} onClick={() => render(i)}>
                Потвърди · {m.credits ? `${number(m.credits)} кредита` : "без заплащане"}</Button>}
              {m?.state === "rendering" && <span className="shorts-status" role="status">Създава се — ще се появи във „Вашите файлове“.</span>}
              <Button className="btn" busy={busy === `studio:${i}`} disabled={!!busy} onClick={() => openInStudio(i)}><Clapperboard size={15} /> Отвори в студиото</Button>
            </div>
            {m?.state === "error" && <Notice error>{m.error}</Notice>}
            {m?.state === "quoted" && (m.credits || 0) > remaining && <p className="vs-fine">Нямате достатъчно кредити. <Link to="/app/billing">Вижте плановете</Link></p>}
          </div>
        </li>;
      })}
    </ol>}
    {clips && <p className="vs-fine">Сървърът създава по един клип наведнъж — следващият може да започне, щом предишният е готов. В студиото можете да промените началото и края, стила на субтитрите, да добавите лого и музика.</p>}
  </div>;
}
