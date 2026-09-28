import { ArrowLeft, ArrowRight, Plus, Trash2 } from "lucide-react";
import { MAX_SCENES, type ProjectScene } from "../shared/project";

export type SceneStatus = {
  voice: "none" | "working" | "ready" | "stale";
  video: "none" | "working" | "ready";
  seconds: number;
};
const voiceLabel = { none: "Без глас", working: "Гласът се създава", ready: "Глас ✓", stale: "Сценарият е променен" };
const videoLabel = { none: "Без видео", working: "Видеото се създава", ready: "Видео ✓" };

/** Scenes of a project in order. The editor below always works on the selected scene. */
export function SceneStrip({ scenes, statuses, selected, disabled, onSelect, onAdd, onRemove, onMove, onRename }: {
  scenes: ProjectScene[]; statuses: SceneStatus[]; selected: number; disabled?: boolean;
  onSelect: (index: number) => void; onAdd: () => void; onRemove: (index: number) => void;
  onMove: (index: number, by: -1 | 1) => void; onRename: (index: number, title: string) => void;
}) {
  const total = statuses.reduce((sum, s) => sum + s.seconds, 0);
  return <section className="vs-card vs-scenes" aria-label="Сцени">
    <div className="vs-scenes-head">
      <h2>Сцени</h2>
      <span>{scenes.length} {scenes.length === 1 ? "сцена" : "сцени"}{total > 0 && ` · около ${Math.round(total)} сек.`}</span>
      <button type="button" className="btn" disabled={disabled || scenes.length >= MAX_SCENES} onClick={onAdd}><Plus size={16} /> Добави сцена</button>
    </div>
    <ol className="vs-scene-list">
      {scenes.map((scene, i) => {
        const status = statuses[i];
        const preview = scene.script.replace(/\[[^\]]*\]/g, "").trim();
        return <li key={scene.id} className={i === selected ? "selected" : ""}>
          <button type="button" className="vs-scene-open" aria-pressed={i === selected} disabled={disabled} onClick={() => onSelect(i)}>
            <strong>{i + 1}. {scene.title || `Сцена ${i + 1}`}</strong>
            <small>{preview ? preview.slice(0, 70) + (preview.length > 70 ? "…" : "") : "Празен сценарий"}</small>
            <span className="vs-scene-badges">
              <span className={`badge ${status.voice}`}>{voiceLabel[status.voice]}</span>
              <span className={`badge ${status.video}`}>{videoLabel[status.video]}</span>
            </span>
          </button>
          {i === selected && <div className="vs-scene-tools">
            <label>Име<input value={scene.title} maxLength={80} placeholder={`Сцена ${i + 1}`} disabled={disabled} onChange={e => onRename(i, e.target.value)} /></label>
            <button type="button" className="round" aria-label="Премести сцената по-рано" disabled={disabled || i === 0} onClick={() => onMove(i, -1)}><ArrowLeft size={16} /></button>
            <button type="button" className="round" aria-label="Премести сцената по-късно" disabled={disabled || i === scenes.length - 1} onClick={() => onMove(i, 1)}><ArrowRight size={16} /></button>
            <button type="button" className="round" aria-label="Изтрий сцената" disabled={disabled || scenes.length === 1} onClick={() => onRemove(i)}><Trash2 size={16} /></button>
          </div>}
        </li>;
      })}
    </ol>
    <p className="vs-fine">Всяка сцена има свой сценарий, глас и аватар. Промяната на една сцена не изисква ново създаване на другите. Финалното видео свързва сцените по ред.</p>
  </section>;
}
