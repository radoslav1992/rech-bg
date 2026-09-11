import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Clock3, Check, X } from "lucide-react";
import { api, useAuth, type Job } from "./lib";

const JobsContext = createContext<{ jobs: Job[]; error: string }>({ jobs: [], error: "" });
export const useJobs = () => useContext(JobsContext);
export const jobsChanged = () => window.dispatchEvent(new Event("rech:jobs-changed"));
export const jobLink = (j: Job) => `/app/studio/${j.project_id}?job=${j.id}`;
export function jobStatus(j: Job) {
  if (j.status === "completed") return "Готово";
  if (j.status === "failed") return "Неуспешно";
  if (j.status === "queued" || j.video_phase === "queued") return "На опашка";
  if (j.video_phase === "saving") return "Запазване на видеото";
  return "Създава се";
}
export function JobActivity({ children }: { children: ReactNode }) {
  const { user, refresh } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  const [finished, setFinished] = useState<Job | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    let stopped = false, running = false;
    let previous = new Map<string, string>();
    const load = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        const data = await api<{ jobs: Job[] }>("/jobs");
        if (stopped) return;
        const completed = data.jobs.find(j => ["queued", "running"].includes(previous.get(j.id) || "") && ["completed", "failed"].includes(j.status));
        if (completed) { setFinished(completed); void refreshRef.current(); }
        previous = new Map(data.jobs.map(j => [j.id, j.status]));
        setJobs(data.jobs); setError("");
      } catch { if (!stopped) setError("Не успяхме да обновим записите. Генерирането продължава във фонов режим."); }
      finally { running = false; }
    };
    void load();
    const timer = window.setInterval(load, 10000);
    window.addEventListener("focus", load);
    window.addEventListener("rech:jobs-changed", load);
    document.addEventListener("visibilitychange", load);
    return () => {
      stopped = true; clearInterval(timer);
      window.removeEventListener("focus", load);
      window.removeEventListener("rech:jobs-changed", load);
      document.removeEventListener("visibilitychange", load);
    };
  }, [user?.id]);
  const active = jobs.filter(j => ["queued", "running"].includes(j.status));
  return <JobsContext.Provider value={{ jobs, error }}>
    {!!active.length && <div className="job-activity" role="status"><Clock3 size={18} /><span>{active.length === 1 ? `„${active[0].title}“ — ${jobStatus(active[0]).toLowerCase()}.` : `${active.length} записа се подготвят.`} Можете да затворите страницата.</span><Link to="/app#activity">Проследете записа</Link></div>}
    {finished && <div className="job-activity finished" role="status">{finished.status === "completed" ? <Check size={18} /> : <X size={18} />}<span>„{finished.title}“ — {jobStatus(finished).toLowerCase()}.</span><Link to={jobLink(finished)}>Отворете записа</Link><button className="round" onClick={() => setFinished(null)} aria-label="Затвори известието"><X size={16} /></button></div>}
    {children}
  </JobsContext.Provider>;
}
