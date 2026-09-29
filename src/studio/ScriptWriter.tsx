import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { api, Button, Notice, useAuth } from "../lib";

export type WrittenScene = { title: string; script: string };
const lengths = [[30, "30 сек."], [60, "1 минута"], [90, "1,5 минути"], [180, "3 минути"]] as const;

/** "Сценарий с ИИ": a topic becomes scenes with titles and spoken text, reviewed before they are used. */
export function ScriptWriter({ action, onUse }: {
  /** Label of the button that uses the written scenes. */
  action: string;
  onUse: (scenes: WrittenScene[]) => Promise<void> | void;
}) {
  const { user } = useAuth();
  const [topic, setTopic] = useState(""), [tone, setTone] = useState("ad"), [length, setLength] = useState(60);
  const [writing, setWriting] = useState(false), [using, setUsing] = useState(false), [error, setError] = useState("");
  const [scenes, setScenes] = useState<WrittenScene[] | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const write = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setWriting(true); setError(""); setScenes(null);
    const timer = setTimeout(() => controller.abort(), 75000);
    try {
      const d = await api<{ scenes: WrittenScene[] }>("/video-studio/write", { method: "POST", body: JSON.stringify({ topic: topic.trim(), tone, seconds: length }), signal: controller.signal });
      if (request.current !== controller) return;
      if (!Array.isArray(d?.scenes) || !d.scenes.length) throw new Error("Не получихме сценарий. Опитайте отново.");
      setScenes(d.scenes);
    } catch (e) {
      if (request.current === controller) setError(controller.signal.aborted ? "Писането отне твърде дълго. Опитайте отново." : (e as Error).message);
    } finally {
      clearTimeout(timer);
      if (request.current === controller) { request.current = null; setWriting(false); }
    }
  };
  const use = async () => {
    if (!scenes) return;
    setUsing(true); setError("");
    try { await onUse(scenes); } catch (e) { setError((e as Error).message); } finally { setUsing(false); }
  };
  return <form className="st-writer" onSubmit={(e) => { e.preventDefault(); void write(); }}>
    <label>За какво е видеото?
      <textarea value={topic} maxLength={600} rows={4} placeholder="Напр. Нова пекарна в Пловдив: пресен хляб от 7 ч., закуски до 10 ч., 10% отстъпка първата седмица."
        onChange={(e) => setTopic(e.target.value)} /></label>
    <div className="st-writer-row">
      <label>Стил<select value={tone} onChange={(e) => setTone(e.target.value)}>
        <option value="ad">Уверена реклама</option><option value="story">Увлекателна история</option>
        <option value="calm">Спокоен разказ</option><option value="explainer">Обяснение стъпка по стъпка</option>
      </select></label>
      <label>Дължина<select value={length} onChange={(e) => setLength(Number(e.target.value))}>
        {lengths.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
    </div>
    <p className="st-fine">Посочете фактите, които трябва да прозвучат — цени, адреси, срокове. ИИ не измисля данни, които не сте дали. Без заплащане, до 10 сценария на ден.</p>
    {error && <Notice error>{error}</Notice>}
    <Button type="submit" className={`btn ${scenes ? "" : "primary"}`} busy={writing} disabled={topic.trim().length < 3 || !user?.verified}>
      {!writing && <Sparkles size={16} />} {writing ? "Пишем сценария…" : scenes ? "Напиши отново" : "Напиши сценарий"}</Button>
    {!user?.verified && <p className="st-fine">Потвърдете имейла си, за да използвате ИИ сценариста.</p>}
    {scenes && <div aria-live="polite">
      <ol className="st-written">{scenes.map((s, i) => <li key={i}><strong>{s.title}</strong><p>{s.script}</p></li>)}</ol>
      <Button type="button" className="btn primary st-wide" busy={using} onClick={use}>{action}</Button>
      <p className="st-fine">Сцените остават редактируеми — прочетете ги и ги поправете преди озвучаване.</p>
    </div>}
  </form>;
}
