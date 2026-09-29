import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  AudioLines,
  Clock3,
  FileText,
  Film,
  Mic,
  Folder,
  Plus,
  Podcast,
  Trash2,
} from "lucide-react";
import { api, number, Notice, useAuth, type Project } from "./lib";
import { canCreateVideo } from "../shared/catalog";
import { useJobs, jobLink, jobStatus } from "./JobActivity";
const icons = { tts: FileText, podcast: Podcast, voiceover: Mic, studio: Film };
const statusNames: Record<string, string> = {
  completed: "Готов",
  running: "Създава се",
  queued: "На опашка",
  failed: "Неуспешен",
};
export function Dashboard() {
  const { user, refresh } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const { jobs, error: jobsError } = useJobs();
  const [error, setError] = useState("");
  useEffect(() => {
    api("/projects")
      .then((p) => {
        setProjects(p.projects);
      })
      .catch((e) => setError(e.message));
    void refresh();
  }, []);
  const done = jobs.filter((j) => j.status === "completed");
  return (
    <div className="app-page">
      <div className="workspace-topline">
        <span>Вашето пространство</span>
        <span>
          {new Date().toLocaleDateString("bg-BG", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
        </span>
      </div>
      <div className="page-heading with-action">
        <div>
          <h1>
            Здравейте, {user?.name.split(" ")[0]}
            <span className="greeting-dot">.</span>
          </h1>
          <p>Какво ще създадем днес?</p>
        </div>
        <div className="heading-actions">
          <Link to="/app/studio" className="btn dark">
            <Plus size={18} />
            Нов аудиозапис
          </Link>
          <Link to="/app/video-studio" className="btn outline">
            <Film size={18} />
            Нов видео проект
          </Link>
        </div>
      </div>
      {error && <Notice error>{error}</Notice>}
      <section id="activity" className="background-recordings">
        <div className="sub-heading"><h2>Вашите записи</h2><span>Обновяват се автоматично</span></div>
        <p>Не е нужно да чакате тук. Записите се създават и когато затворите приложението.</p>
        {jobsError && <Notice error>{jobsError}</Notice>}
        {jobs.length ? [...jobs.filter(j => ["queued", "running"].includes(j.status)), ...jobs.filter(j => !["queued", "running"].includes(j.status)).slice(0, 5)].map(j => <article className="background-recording" key={j.id}>
          <div><strong>{j.title}</strong><small>{j.kind === "video" ? "Видео" : "Аудио"} · {new Date(j.created_at * 1000).toLocaleString("bg-BG")}</small></div>
          <span className={"status " + j.status}>{jobStatus(j)}</span>
          <div className="recording-actions"><Link className="btn outline small-btn" to={jobLink(j)}>{j.status === "completed" ? "Отворете" : "Подробности"}</Link>
            {j.status === "completed" && <a className="btn dark small-btn" href={`/api/jobs/${j.id}/${j.kind === "video" ? "video" : "audio"}?download=1`}>Изтеглете {j.kind === "video" ? "MP4" : "WAV"}</a>}</div>
          {j.notify_email && <small className="recording-email">{j.email_status === "sent" ? "Изпратено е известие по имейл." : j.email_status === "failed" ? "Имейлът не беше потвърден. Резултатът остава достъпен тук." : j.email_status === "sending" ? "Известието по имейл се обработва." : "Ще ви уведомим по имейл, когато обработката приключи."}</small>}
        </article>) : <p className="small-note">Тук ще намирате готовите записи и тези, които се създават.</p>}
      </section>
      <div className="dashboard-banner">
        <div>
          <span className="eyebrow">ОТ ДУМИ КЪМ ЗВУК</span>
          <h2>
            Добрата идея
            <br />
            вече има глас.
          </h2>
          <p>Създайте аудиозапис и го превърнете в говорещо видео{canCreateVideo(user?.plan) ? "." : " (видео — от план Създател)."}</p>
          <Link className="btn dark" to="/app/studio">
            Към студиото <ArrowUpRight size={18} />
          </Link>
        </div>
        <div className="dashboard-portraits" aria-hidden="true"><img src="/images/avatars/boris.webp" alt="" /><img src="/images/avatars/mila.webp" alt="" /></div>
      </div>
      <div className="stat-grid">
        <div>
          <span>
            <AudioLines size={18} />
            Налични кредити
          </span>
          <strong>
            {number(Math.max(0, (user?.limit || 0) - (user?.used || 0)))}
          </strong>
          <small>от {number(user?.limit || 1000)} в текущия период</small>
        </div>
        <div>
          <span>
            <Folder size={18} />
            Моите проекти
          </span>
          <strong>{projects.length}</strong>
          <small>Запазени идеи и сценарии</small>
        </div>
        <div>
          <span>
            <Clock3 size={18} />
            Създадени аудио и видео
          </span>
          <strong>
            {Math.round(done.reduce((s, j) => s + j.duration, 0) / 60)}{" "}
            <em>мин.</em>
          </strong>
          <small>{done.length} завършени записа в последните 100</small>
        </div>
      </div>
      <div className="sub-heading">
        <h2>Започнете с формат</h2>
        <span>Едно студио. Различни възможности.</span>
      </div>
      <div className="mode-grid">
        {[
          ["tts", "Текст в реч", "Статии, истории и учебни материали."],
          ["podcast", "Подкаст", "Разговор с два различни гласа."],
          ["voiceover", "Озвучаване", "За видеа, реклами и презентации."],
          ["studio", "Видео студио", "Изразителен глас, аватар и субтитри."],
        ].map(([id, t, d]) => {
          const Icon = icons[id as keyof typeof icons] || FileText;
          return (
            <Link
              key={id}
              to={id === "studio" ? "/app/video-studio" : "/app/studio?mode=" + id}
              className={"mode-card " + id}
            >
              <Icon size={24} />
              <h3>{t}</h3>
              <p>{d}</p>
              {id === "studio" && !canCreateVideo(user?.plan) && <small className="plan-chip">Видео от план Създател</small>}
              <ArrowUpRight size={18} />
            </Link>
          );
        })}
      </div>
      <div className="sub-heading">
        <h2>Последни проекти</h2>
        <Link to="/app/projects">
          Вижте всички <ArrowUpRight size={16} />
        </Link>
      </div>
      <ProjectList projects={projects.slice(0, 4).map(p => {
        const latest = jobs.find(j => j.project_id === p.id);
        return latest ? { ...p, status: latest.status, latest_job: latest.id } : p;
      })} />
    </div>
  );
}
export function ProjectList({
  projects,
  onDelete,
  filtered = false,
  onClearFilter,
}: {
  projects: Project[];
  onDelete?: (id: string) => void;
  /** Projects exist, but none matches the current filter or search. */
  filtered?: boolean;
  onClearFilter?: () => void;
}) {
  if (!projects.length && filtered)
    return (
      <div className="empty-state">
        <h3>Няма проекти с тези критерии.</h3>
        <button type="button" className="btn outline" onClick={onClearFilter}>Изчисти филтъра</button>
      </div>
    );
  if (!projects.length)
    return (
      <div className="empty-state">
        <span className="empty-icon">
          <AudioLines size={28} />
        </span>
        <h3>Първата ви история започва тук.</h3>
        <p>Създайте запис или видео и ще го намерите на това място.</p>
        <div className="heading-actions">
          <Link className="btn outline" to="/app/studio">
            <Plus size={17} />
            Аудиозапис
          </Link>
          <Link className="btn outline" to="/app/video-studio">
            <Film size={17} />
            Видео проект
          </Link>
        </div>
      </div>
    );
  return (
    <div className="project-list">
      {projects.map((p) => {
        const Icon = icons[p.mode as keyof typeof icons] || FileText;
        return (
          <div className="project-row" key={p.id}>
            <span className={"project-icon " + p.mode}>
              <Icon size={20} />
            </span>
            <Link to={"/app/" + (p.mode === "studio" ? "video-studio/" : "studio/") + p.id}>
              <strong>{p.title}</strong>
              <small>
                {new Date(p.updated_at * 1000).toLocaleDateString("bg-BG")} ·{" "}
                {p.mode === "studio" ? "Видео студио" : p.mode === "podcast"
                  ? "Подкаст"
                  : p.mode === "voiceover"
                    ? "Озвучаване"
                    : "Текст в реч"}
              </small>
            </Link>
            <span className={"status " + p.status}>
              {statusNames[p.status || ""] || "Чернова"}
            </span>
            {onDelete ? (
              <button
                className="round"
                onClick={() => onDelete(p.id)}
                aria-label={"Изтрий " + p.title}
              >
                <Trash2 size={17} />
              </button>
            ) : (
              <Link
                className="round"
                to={"/app/" + (p.mode === "studio" ? "video-studio/" : "studio/") + p.id}
                aria-label={"Отвори " + p.title}
              >
                <ArrowUpRight size={18} />
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}
export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("all");
  const load = () =>
    api("/projects")
      .then((d) => setProjects(d.projects))
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="app-page">
      <div className="page-heading with-action">
        <div>
          <h1>Моите проекти</h1>
          <p>Всички ваши идеи. Готови да бъдат чути.</p>
        </div>
        <div className="heading-actions">
          <Link className="btn dark" to="/app/studio">
            <Plus size={18} />
            Нов аудиозапис
          </Link>
          <Link className="btn outline" to="/app/video-studio">
            <Film size={18} />
            Нов видео проект
          </Link>
        </div>
      </div>
      {error && <Notice error>{error}</Notice>}
      <div className="filter-bar">
        <div className="segmented">
          {[
            ["all", "Всички"],
            ["tts", "Текст в реч"],
            ["podcast", "Подкасти"],
            ["voiceover", "Озвучаване"],
            ["studio", "Видео студио"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={mode === id ? "active" : ""}
              aria-pressed={mode === id}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          aria-label="Търсене на проект"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Търсете проект…"
        />
      </div>
      <ProjectList
        projects={projects.filter(
          (p) =>
            (mode === "all" || p.mode === mode) &&
            p.title.toLowerCase().includes(query.toLowerCase()),
        )}
        filtered={projects.length > 0}
        onClearFilter={() => { setMode("all"); setQuery(""); }}
        onDelete={async (id) => {
          if (
            !confirm(
              "Да изтрием ли проекта и всички негови записи? Това действие е необратимо.",
            )
          )
            return;
          try {
            await api("/projects/" + id, { method: "DELETE" });
            await load();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
      <p className="small-note">
        До 100 запазени проекта. Изтриването на проект премахва и записите към
        него.
      </p>
    </div>
  );
}
