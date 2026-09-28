import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Palette, Save, Sparkles, Trash2 } from "lucide-react";
import { api, Button, Notice, post } from "./lib";
import { useMediaLibrary } from "./MediaTools";
import { MediaPicker } from "./LayerTools";
import { brandKitSchema, lookOf, MAX_BUMPER_SECONDS, type BrandKit, type Bumper } from "../shared/brand";
import { layerPositions, type Layer, type LayerPosition } from "../shared/layers";
import type { CaptionDocument } from "../shared/captions";
import type { ProjectDoc } from "../shared/project";

const positionNames: Record<LayerPosition, string> = {
  "top-left": "Горе вляво", top: "Горе", "top-right": "Горе вдясно", left: "Вляво", center: "В центъра",
  right: "Вдясно", "bottom-left": "Долу вляво", bottom: "Долу", "bottom-right": "Долу вдясно",
};

/** Loads the account's brand kit; `save` stores a new version. */
export function useBrandKit() {
  const [kit, setKit] = useState<BrandKit | null>(null);
  useEffect(() => {
    let live = true;
    api<{ kit: BrandKit }>("/video-studio/brand").then((d) => live && setKit(brandKitSchema.parse(d.kit))).catch(() => {});
    return () => { live = false; };
  }, []);
  const save = async (next: BrandKit) => {
    const d = await api<{ kit: BrandKit }>("/video-studio/brand", { method: "PUT", body: JSON.stringify(next) });
    setKit(d.kit);
  };
  return { kit, save };
}

function BumperControl({ label, value, assets, onChange }: { label: string; value: Bumper | null; assets: any[]; onChange: (b: Bumper | null) => void }) {
  return <fieldset className="tl-background">
    <legend>{label}</legend>
    <MediaPicker assets={assets} video value={value?.assetId} onPick={(assetId) => onChange({ assetId, seconds: value?.seconds ?? 3 })} />
    {value && <>
      <label>Продължителност · {value.seconds} сек.<input type="range" min={1} max={MAX_BUMPER_SECONDS} step={0.5} value={value.seconds} onChange={(e) => onChange({ ...value, seconds: Number(e.target.value) })} /></label>
      <small>Видео се съкращава до тази дължина и запазва звука си; изображение се показва през цялото време.</small>
      <button type="button" className="btn" onClick={() => onChange(null)}><Trash2 size={15} /> Без {label.toLowerCase()}</button>
    </>}
  </fieldset>;
}

/**
 * Brand kit editor plus project actions: apply the brand (caption look, intro/outro, logo on every scene),
 * set this project's intro/outro, and save the project as a template.
 */
export function BrandPanel({ kit, onSaveKit, projectId, doc, update, captionSource, sceneLengths, onCaptionsChanged }: {
  kit: BrandKit; onSaveKit: (kit: BrandKit) => Promise<void>;
  projectId?: string; doc: ProjectDoc | null; update: (change: (d: ProjectDoc) => ProjectDoc) => void;
  /** Recording of the selected scene, whose caption look can be captured. */
  captionSource: string | null;
  sceneLengths: number[];
  /** Called after captions of existing recordings were rewritten, so editors reload them. */
  onCaptionsChanged: () => void;
}) {
  const { data } = useMediaLibrary();
  const assets = data?.assets || [];
  const [draft, setDraft] = useState(kit);
  const [message, setMessage] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [templateName, setTemplateName] = useState("");
  useEffect(() => setDraft(kit), [kit]);
  const run = async (work: () => Promise<void>, done: string) => {
    setBusy(true); setError(""); setMessage("");
    try { await work(); setMessage(done); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const applyToProject = () => run(async () => {
    if (!doc) return;
    update((d) => ({ ...d, intro: kit.intro, outro: kit.outro, captionLook: kit.captionLook }));
    // Existing recordings take the brand caption look too; their words and timing stay.
    if (kit.captionLook) {
      for (const scene of doc.scenes) {
        if (!scene.audioJobId) continue;
        // A recording still being created gets the project look when it finishes.
        const current = await api<CaptionDocument>(`/video-studio/captions/${scene.audioJobId}`).catch(() => null);
        if (current) await api(`/video-studio/captions/${scene.audioJobId}`, { method: "PUT", body: JSON.stringify({ ...current, ...kit.captionLook }) });
      }
      onCaptionsChanged();
    }
  }, "Брандът е приложен към проекта.");
  const addLogoEverywhere = () => {
    const logo = kit.logo;
    if (!logo) return;
    update((d) => ({
      ...d,
      scenes: d.scenes.map((s, i) => ({
        ...s,
        layers: [...s.layers, {
          id: crypto.randomUUID(), type: "image", assetId: logo.assetId, start: 0, end: Math.max(0.5, Math.round((sceneLengths[i] || 60) * 100) / 100),
          position: logo.position, width: logo.width, opacity: logo.opacity,
        } as Layer].slice(0, 30),
      })),
    }));
    setMessage("Логото е добавено към всяка сцена.");
  };
  return <section className="vs-card vs-brand">
    <div className="sub-heading"><h2><Palette size={22} /> Бранд и шаблони</h2><span>ВАШИЯТ СТИЛ</span></div>
    {message && <Notice good>{message}</Notice>}
    {error && <Notice error>{error}</Notice>}
    <div className="vs-brand-grid">
      <fieldset disabled={busy}>
        <legend>Бранд комплект</legend>
        <label>Име на бранда<input value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
        <div className="tl-layer-colors">
          <label>Основен<input type="color" value={draft.colors.primary} onChange={(e) => setDraft({ ...draft, colors: { ...draft.colors, primary: e.target.value } })} /></label>
          <label>Фон на текст<input type="color" value={draft.colors.secondary} onChange={(e) => setDraft({ ...draft, colors: { ...draft.colors, secondary: e.target.value } })} /></label>
          <label>Текст<input type="color" value={draft.colors.text} onChange={(e) => setDraft({ ...draft, colors: { ...draft.colors, text: e.target.value } })} /></label>
        </div>
        <fieldset className="tl-background">
          <legend>Лого</legend>
          <MediaPicker assets={assets} value={draft.logo?.assetId} onPick={(assetId) => setDraft({ ...draft, logo: { position: "top-right", width: 0.18, opacity: 1, ...draft.logo, assetId } })} />
          {draft.logo && <>
            <label>Позиция<select value={draft.logo.position} onChange={(e) => setDraft({ ...draft, logo: { ...draft.logo!, position: e.target.value as LayerPosition } })}>
              {layerPositions.map((p) => <option key={p} value={p}>{positionNames[p]}</option>)}
            </select></label>
            <label>Ширина · {Math.round(draft.logo.width * 100)}%<input type="range" min={0.05} max={0.5} step={0.01} value={draft.logo.width} onChange={(e) => setDraft({ ...draft, logo: { ...draft.logo!, width: Number(e.target.value) } })} /></label>
            <label>Плътност · {Math.round(draft.logo.opacity * 100)}%<input type="range" min={0.1} max={1} step={0.05} value={draft.logo.opacity} onChange={(e) => setDraft({ ...draft, logo: { ...draft.logo!, opacity: Number(e.target.value) } })} /></label>
            <button type="button" className="btn" onClick={() => setDraft({ ...draft, logo: null })}><Trash2 size={15} /> Без лого</button>
          </>}
        </fieldset>
        <fieldset className="tl-background">
          <legend>Визия на субтитрите</legend>
          <p className="vs-fine">{draft.captionLook ? `Стил „${draft.captionLook.style}“, ${draft.captionLook.format}, позиция ${draft.captionLook.position}.` : "Не е зададена."}</p>
          <button type="button" className="btn" disabled={!captionSource || busy} onClick={() => run(async () => {
            const captions = await api<CaptionDocument>(`/video-studio/captions/${captionSource}`);
            setDraft((d) => ({ ...d, captionLook: lookOf(captions) }));
          }, "Визията е взета. Запазете бранда, за да я използвате.")}>Вземи визията от избраната сцена</button>
        </fieldset>
        <BumperControl label="Интро" value={draft.intro} assets={assets} onChange={(intro) => setDraft({ ...draft, intro })} />
        <BumperControl label="Финал" value={draft.outro} assets={assets} onChange={(outro) => setDraft({ ...draft, outro })} />
        <Button className="btn primary" busy={busy} onClick={() => run(() => onSaveKit(draft), "Брандът е запазен.")}><Save size={16} /> Запази бранда</Button>
      </fieldset>
      {projectId && doc && <fieldset disabled={busy}>
        <legend>Този проект</legend>
        <Button className="btn" busy={busy} onClick={applyToProject}><Sparkles size={16} /> Приложи бранда</Button>
        <small>Задава интрото, финала и визията на субтитрите на проекта, включително на вече създадените записи.</small>
        <button type="button" className="btn" disabled={!kit.logo} onClick={addLogoEverywhere}>Добави логото към всички сцени</button>
        <BumperControl label="Интро" value={doc.intro} assets={assets} onChange={(intro) => update((d) => ({ ...d, intro }))} />
        <BumperControl label="Финал" value={doc.outro} assets={assets} onChange={(outro) => update((d) => ({ ...d, outro }))} />
        <small>Интрото и финалът се добавят при експорта на сървъра; прегледът и експортът в браузъра показват само сцените.</small>
        <label>Име на шаблона<input value={templateName} maxLength={80} placeholder="Напр. Седмична реклама" onChange={(e) => setTemplateName(e.target.value)} /></label>
        <Button className="btn" busy={busy} disabled={!templateName.trim()} onClick={() => run(async () => { await post("/video-studio/templates", { projectId, name: templateName.trim() }); setTemplateName(""); }, "Шаблонът е запазен. Ще го намерите при нов видео проект.")}>
          <Save size={16} /> Запази като шаблон
        </Button>
        <small>Шаблонът пази сцените, сценариите, гласовете, слоевете, фона, музиката, интрото и финала — без платените записи и видеа.</small>
      </fieldset>}
    </div>
  </section>;
}

type TemplateSummary = { id: string; name: string; created_at: number; scenes: number; intro: boolean; outro: boolean; music: boolean };
/** Shown on a new video project: start from one of the saved templates. */
export function TemplatePicker() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState("");
  const load = () => api<{ templates: TemplateSummary[] }>("/video-studio/templates").then((d) => setTemplates(d.templates)).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);
  if (!templates?.length) return error ? <Notice error>{error}</Notice> : null;
  const use = async (t: TemplateSummary) => {
    setBusy(t.id); setError("");
    try { const { id } = await post<{ id: string }>(`/video-studio/templates/${t.id}/use`, { title: t.name }); navigate(`/app/video-studio/${id}`); }
    catch (e) { setError((e as Error).message); setBusy(""); }
  };
  const remove = async (t: TemplateSummary) => {
    if (!confirm(`Да изтрием ли шаблона „${t.name}“? Проектите, създадени от него, остават.`)) return;
    await api(`/video-studio/templates/${t.id}`, { method: "DELETE" }).catch(() => {});
    void load();
  };
  return <section className="vs-card vs-templates">
    <h2>Започнете от шаблон</h2>
    {error && <Notice error>{error}</Notice>}
    <ul>{templates.map((t) => <li key={t.id}>
      <div><strong>{t.name}</strong><small>{t.scenes} {t.scenes === 1 ? "сцена" : "сцени"}{t.intro ? " · интро" : ""}{t.outro ? " · финал" : ""}{t.music ? " · музика" : ""}</small></div>
      <Button className="btn primary" busy={busy === t.id} disabled={!!busy} onClick={() => use(t)}>Използвай</Button>
      <button type="button" className="round" aria-label={`Изтрий шаблона ${t.name}`} onClick={() => remove(t)}><Trash2 size={15} /></button>
    </li>)}</ul>
  </section>;
}
