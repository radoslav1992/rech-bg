import { useEffect, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  ArrowLeft,
  AudioLines,
  Check,
  Download,
  FileText,
  Headphones,
  Plus,
  Podcast,
  Save,
  Sparkles,
  Upload,
  Video,
} from "lucide-react";
import { VideoPanel } from "./VideoPanel";
import { voiceList } from "../shared/catalog";
import { segments } from "../shared/text";
import {
  api,
  post,
  number,
  Notice,
  Button,
  VoiceCard,
  useAuth,
  type Voice,
  type Job,
} from "./lib";
const examples: Record<string, string> = {
  tts: "Всяка добра история започва с една идея. Днес ще дадем глас на вашата — ясно, уверено и на български.",
  podcast:
    "1: Здравейте и добре дошли! Днес говорим за силата на добрите идеи.\n2: И за това как да им дадем глас. Понякога всичко започва с едно изречение.\n1: Точно така. Коя е историята, която искате да разкажете?",
  voiceover:
    "Представете си съдържание, което не просто се вижда, а се запомня. Дайте глас на следващата си идея.",
};
export function Studio() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { user, refresh } = useAuth();
  const [title, setTitle] = useState("Моят нов запис");
  const [mode, setMode] = useState(
    ["tts", "podcast", "voiceover"].includes(params.get("mode") || "")
      ? params.get("mode")!
      : "tts",
  );
  const [script, setScript] = useState("");
  const [voice, setVoice] = useState(
    voiceList.some((v) => v.id === params.get("voice"))
      ? params.get("voice")!
      : "mila",
  );
  const [second, setSecond] = useState("boris");
  const [pause, setPause] = useState(400);
  const [voices, setVoices] = useState<Voice[]>(voiceList);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!!id);
  const [job, setJob] = useState<Job | null>(null);
  const [history, setHistory] = useState<Job[]>([]);
  const [dirty, setDirty] = useState(false);
  const projectId = useRef<string | undefined>(id);
  const requestKey = useRef<string>(crypto.randomUUID());
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api("/voices")
      .then((d) => setVoices(d.voices))
      .catch(() => {});
  }, []);
  useEffect(() => {
    projectId.current = id;
    setJob(null);
    setHistory([]);
    if (id) {
      setLoading(true);
      api("/projects/" + id)
        .then(({ project: p }) => {
          setTitle(p.title);
          setMode(p.mode);
          setScript(p.script);
          setVoice(p.voice);
          setSecond(p.second_voice);
          setPause(p.pause_ms);
          setDirty(false);
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
      api("/jobs")
        .then((d) => {
          const list = d.jobs.filter((j: Job) => j.project_id === id);
          setHistory(list);
          setJob(list[0] || null);
        })
        .catch(() => {});
    } else {
      setTitle("Моят нов запис");
      setScript("");
      setMode(
        ["tts", "podcast", "voiceover"].includes(params.get("mode") || "")
          ? params.get("mode")!
          : "tts",
      );
      setVoice(
        voiceList.some((v) => v.id === params.get("voice"))
          ? params.get("voice")!
          : "mila",
      );
      setSecond("boris");
      setDirty(false);
    }
  }, [id, params.toString()]);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    const timer = setInterval(
      () =>
        api("/jobs/" + job.id)
          .then(({ job: j }) => {
            setJob(j);
            if (["completed", "failed"].includes(j.status)) {
              requestKey.current = crypto.randomUUID();
              void refresh();
              api("/jobs")
                .then((d) =>
                  setHistory(
                    d.jobs.filter(
                      (x: Job) => x.project_id === projectId.current,
                    ),
                  ),
                )
                .catch(() => {});
            }
          })
          .catch((e) => setError(e.message)),
      3500,
    );
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);
  useEffect(() => {
    if (!dirty) return;
    const f = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    const onLink = (event: MouseEvent) => {
      const anchor = (event.target as Element)?.closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (
        anchor &&
        anchor.origin === location.origin &&
        anchor.pathname !== location.pathname &&
        !confirm("Имате незапазени промени. Да напуснем ли проекта?")
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", f);
    document.addEventListener("click", onLink, true);
    return () => {
      window.removeEventListener("beforeunload", f);
      document.removeEventListener("click", onLink, true);
    };
  }, [dirty]);
  const edit = (fn: () => void) => {
    fn();
    setDirty(true);
    setNotice("");
    requestKey.current = crypto.randomUUID();
  };
  const save = async () => {
    const payload = {
      title,
      mode,
      script,
      voice,
      second_voice: second,
      pause_ms: pause,
    };
    if (projectId.current)
      await api("/projects/" + projectId.current, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    else {
      const r = await post("/projects", payload);
      projectId.current = r.id;
      navigate("/app/studio/" + r.id, { replace: true });
    }
    setDirty(false);
    return projectId.current!;
  };
  const generate = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const pid = await save();
      const r = await post("/generate", {
        projectId: pid,
        idempotencyKey: requestKey.current,
      });
      const d = await api("/jobs/" + r.id);
      setJob(d.job);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  let chars = script.trim().length;
  try {
    chars = segments(script, mode, voice, second).reduce(
      (sum, s) => sum + s.text.length,
      0,
    );
  } catch {
    /* Invalid dialogue is rejected by the server on generation. */
  }
  const active = !!job && ["queued", "running"].includes(job.status);
  const selected = voices.find((v) => v.id === voice)!;
  return (
    <div className="studio-page">
      <div className="studio-heading">
        <div>
          <Link to="/app/projects" className="breadcrumb">
            <ArrowLeft size={15} />
            Моите проекти
          </Link>
          <input
            className="project-title-input"
            aria-label="Име на проекта"
            value={title}
            maxLength={120}
            onChange={(e) => edit(() => setTitle(e.target.value))}
          />
          <span className="save-state">
            {dirty
              ? "Незапазени промени"
              : projectId.current
                ? "Всички промени са запазени"
                : "Нов проект"}
          </span>
        </div>
        <Button
          className="btn outline"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await save();
              setNotice("Проектът е запазен.");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Save size={17} />
          Запазете
        </Button>
      </div>
      {error && <Notice>{error}</Notice>}
      {notice && <Notice good>{notice}</Notice>}
      {loading ? (
        <div className="empty-state">Зареждане на проекта…</div>
      ) : (
        <>
          <div className="studio-layout">
            <section className="editor-panel">
              <div className="studio-mode-tabs">
                {[
                  ["tts", "Текст в реч", FileText],
                  ["podcast", "Подкаст", Podcast],
                  ["voiceover", "Озвучаване", Video],
                ].map(([m, label, I]) => {
                  const Icon = I as typeof FileText;
                  return (
                    <button
                      key={m as string}
                      className={mode === m ? "active" : ""}
                      onClick={() => edit(() => setMode(m as string))}
                    >
                      <Icon size={17} />
                      {label as string}
                    </button>
                  );
                })}
              </div>
              <div className="editor-toolbar">
                <span>
                  {mode === "podcast" ? "СЦЕНАРИЙ НА ПОДКАСТА" : "ВАШИЯТ ТЕКСТ"}
                </span>
                <div>
                  <button onClick={() => fileRef.current?.click()}>
                    <Upload size={15} />
                    Качете .txt
                  </button>
                  <input
                    hidden
                    ref={fileRef}
                    type="file"
                    accept=".txt,text/plain"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      if (f.size > 60000) {
                        setError("Текстовият файл трябва да е до 60 KB.");
                        return;
                      }
                      const t = await f.text();
                      if (t.length > 14000) {
                        setError(
                          "Текстът е твърде дълъг. Максимум 14 000 знака за чернова.",
                        );
                        return;
                      }
                      edit(() => setScript(t));
                      e.target.value = "";
                    }}
                  />
                </div>
              </div>
              {mode === "podcast" && (
                <div className="podcast-help">
                  <Podcast size={19} />
                  <p>
                    Започнете всяка реплика с <strong>1:</strong> или{" "}
                    <strong>2:</strong>. Всеки водещ използва своя избран глас.
                  </p>
                </div>
              )}
              <textarea
                className="script-editor"
                aria-label="Текст за озвучаване"
                value={script}
                maxLength={14000}
                onChange={(e) => edit(() => setScript(e.target.value))}
                placeholder={
                  mode === "podcast"
                    ? "1: Здравейте и добре дошли…\n2: Радвам се да бъда тук."
                    : mode === "voiceover"
                      ? "Следващата ви реклама, урок или видео започва с тези думи…"
                      : "Поставете вашия текст тук.\nИли започнете с едно изречение…"
                }
              />
              {!script && (
                <button
                  className="example-button"
                  onClick={() => edit(() => setScript(examples[mode]))}
                >
                  <Sparkles size={15} />
                  Опитайте с примерен текст
                </button>
              )}
              <div className="editor-footer">
                <span>{number(chars)} / 10 000 символа</span>
                <span>
                  ≈ {Math.max(1, Math.round(chars / 850))} мин. · ориентировъчно
                </span>
              </div>
              {mode === "podcast" && (
                <div className="podcast-actions">
                  <button
                    className="btn outline small-btn"
                    onClick={() => edit(() => setScript(script + "\n1: "))}
                  >
                    <Plus size={15} />
                    Водещ 1
                  </button>
                  <button
                    className="btn outline small-btn"
                    onClick={() => edit(() => setScript(script + "\n2: "))}
                  >
                    <Plus size={15} />
                    Водещ 2
                  </button>
                </div>
              )}
              <div className="generate-bar">
                <div>
                  <span className="generation-cost">
                    <AudioLines size={17} />
                    {number(chars)} кредита
                  </span>
                  <small>
                    Налични:{" "}
                    {number(
                      Math.max(0, (user?.limit || 0) - (user?.used || 0)),
                    )}
                  </small>
                </div>
                <Button
                  className="btn primary"
                  busy={busy || active}
                  disabled={
                    !script.trim() ||
                    !user?.verified ||
                    chars > 10000 ||
                    loading
                  }
                  onClick={generate}
                >
                  <Sparkles size={18} />
                  {active ? "Създава се…" : "Създайте аудио"}
                </Button>
              </div>
            </section>
            <aside className="voice-panel">
              <div className="panel-heading">
                <h2>
                  <Headphones size={19} />
                  Глас и звучене
                </h2>
                <span>30 гласа</span>
              </div>
              {mode === "podcast" && (
                <label className="speaker-label">
                  Водещ 2
                  <select
                    value={second}
                    onChange={(e) => edit(() => setSecond(e.target.value))}
                  >
                    {voices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} · {v.tone}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="speaker-label">
                {mode === "podcast" ? "Водещ 1" : "Избран глас"}
              </label>
              <VoiceCard voice={selected} selected />
              <label className="voice-search-label">
                <span>Сменете гласа</span>
                <input
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Търсете глас…"
                  aria-label="Търсене на глас"
                />
              </label>
              <div className="voice-options">
                {voices
                  .filter((v) =>
                    (v.name + " " + v.tone)
                      .toLowerCase()
                      .includes(filter.toLowerCase()),
                  )
                  .map((v) => (
                    <button
                      key={v.id}
                      className={v.id === voice ? "active" : ""}
                      onClick={() => edit(() => setVoice(v.id))}
                    >
                      <span className={"voice-avatar " + v.color}>
                        {v.name[0]}
                      </span>
                      <span>
                        <strong>{v.name}</strong>
                        <small>{v.tone}</small>
                      </span>
                      {voice === v.id && <Check size={16} />}
                    </button>
                  ))}
              </div>
              <label className="pause-control">
                Пауза между части{" "}
                <strong>{(pause / 1000).toFixed(1)} сек.</strong>
                <input
                  type="range"
                  min="0"
                  max="1500"
                  step="100"
                  value={pause}
                  onChange={(e) => edit(() => setPause(Number(e.target.value)))}
                />
              </label>
              <p className="small-note">
                Преслушайте имената, съкращенията и ударенията преди
                публикуване.
              </p>
            </aside>
          </div>
          <section className="output-panel">
            <div className="sub-heading">
              <h2>
                <AudioLines size={20} />
                Вашият запис
              </h2>
              <button
                className="text-link"
                disabled={!script}
                onClick={() => {
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(
                    new Blob([script], { type: "text/plain;charset=utf-8" }),
                  );
                  a.download = "scenario.txt";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
                }}
              >
                <Download size={15} />
                Сценарий
              </button>
            </div>
            {!job ? (
              <div className="output-empty">
                <Headphones size={24} />
                <p>Готовото аудио ще се появи тук.</p>
              </div>
            ) : job.status === "completed" ? (
              <div className="audio-result">
                <div>
                  <strong>{job.title}</strong>
                  <span>
                    {Math.floor(job.duration / 60)}:
                    {String(Math.round(job.duration % 60)).padStart(2, "0")} ·
                    {job.kind === "video" ? "MP4" : "WAV"}
                  </span>
                </div>
                {job.kind === "video" ? <video className="avatar-result" key={job.id} controls preload="metadata" src={"/api/jobs/" + job.id + "/video"} /> : <audio
                  key={job.id}
                  controls
                  preload="metadata"
                  src={"/api/jobs/" + job.id + "/audio"}
                />}
                <a
                  className="btn dark"
                  href={"/api/jobs/" + job.id + (job.kind === "video" ? "/video" : "/audio") + "?download=1"}
                >
                  <Download size={17} />
                  {job.kind === "video" ? "Изтеглете MP4" : "Изтеглете WAV"}
                </a>
              </div>
            ) : job.status === "failed" ? (
              <Notice>{job.error}</Notice>
            ) : (
              <div className="output-empty">
                <AudioLines className="pulse" size={32} />
                <p>
                  Създаваме вашия запис. Можете да продължите работа — ще го
                  намерите в проекта.
                </p>
              </div>
            )}
            {history.length > 1 && (
              <details className="version-history">
                <summary>Предишни записи ({history.length})</summary>
                {history.map((j) => (
                  <div key={j.id}>
                    <span>
                      {new Date(j.created_at * 1000).toLocaleString("bg")}
                    </span>
                    <span>
                      {j.status === "completed"
                        ? "Готов"
                        : j.status === "failed"
                          ? "Неуспешен"
                          : "Създава се"}
                    </span>
                    {j.status === "completed" && (
                      <button className="text-link" disabled={active} onClick={() => setJob(j)}>
                        {j.kind === "video" ? "Гледайте видеото" : "Преслушайте"}
                      </button>
                    )}
                  </div>
                ))}
              </details>
            )}
          </section>
          <VideoPanel key={id || "new"} jobs={[...(job ? [job] : []), ...history.filter(j => j.id !== job?.id)]} disabled={busy || active} onCreated={j => { setJob(j); setHistory(h => [j, ...h.filter(x => x.id !== j.id)]); }} />
        </>
      )}
    </div>
  );
}
