import { useEffect, useRef, useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { captionLook, captionPresets, defaultCaptions, type CaptionDocument, type CaptionLook, type CaptionStyle } from "../shared/captions";
import { drawCaptions } from "./caption-render";
import { useAuth } from "./lib";

type Template = { id: string; name: string; look: CaptionLook };
function readTemplates(key: string): Template[] {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved.filter(t => t && typeof t.id === "string" && typeof t.name === "string" && t.name.length <= 32 && t.look &&
      captionPresets.some(p => p.id === t.look.style) && ["9:16", "1:1", "16:9", "4:5"].includes(t.look.format) &&
      ["bottom", "middle", "top"].includes(t.look.position) && typeof t.look.enabled === "boolean" &&
      [t.look.accent, t.look.textColor].every(c => c === undefined || /^#[0-9a-f]{6}$/i.test(c)) &&
      (t.look.size === undefined || typeof t.look.size === "number" && t.look.size >= .7 && t.look.size <= 1.4) &&
      (t.look.uppercase === undefined || typeof t.look.uppercase === "boolean") &&
      (t.look.resolution === undefined || ["720p", "1080p"].includes(t.look.resolution)) &&
      (t.look.fit === undefined || ["contain", "cover"].includes(t.look.fit))).slice(0, 8).map(t => ({ ...t, look: captionLook(t.look) }));
  } catch { return []; }
}
function PresetThumbnail({ style, look }: { style: CaptionStyle; look?: CaptionLook }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current!, ctx = c.getContext("2d")!;
    ctx.fillStyle = "#282d29"; ctx.fillRect(0, 0, c.width, c.height);
    const preset = captionPresets.find(p => p.id === style)!;
    drawCaptions(ctx, 480, 300, .85, { ...defaultCaptions, ...preset, style, ...look, words: [{ text: "Твоята", start: 0, end: .65 }, { text: "история.", start: .65, end: 1.5 }], size: 2.2, enabled: true, position: "middle" });
  }, [style, look]);
  return <canvas ref={canvas} width={480} height={300} aria-hidden="true" />;
}
export function CaptionStyles({ document, edit, disabled }: { document: CaptionDocument; edit: (look: Partial<CaptionDocument>) => void; disabled: boolean }) {
  const { user } = useAuth();
  const key = `rech:caption-looks:v1:${user!.id}`;
  const [templates, setTemplates] = useState<Template[]>(() => readTemplates(key));
  const [tab, setTab] = useState("presets"), [name, setName] = useState(""), [message, setMessage] = useState("");
  useEffect(() => { setTemplates(readTemplates(key)); }, [key]);
  const persist = (next: Template[]) => {
    try { localStorage.setItem(key, JSON.stringify(next)); setTemplates(next); setMessage(""); return true; }
    catch { setMessage("Браузърът не разрешава запазване на шаблони."); return false; }
  };
  return <fieldset className="caption-design" disabled={disabled}>
    <div className="caption-tabs" role="group" aria-label="Библиотека с визии">
      <button type="button" aria-pressed={tab === "presets"} onClick={() => setTab("presets")}>Готови визии <span>{captionPresets.length}</span></button>
      <button type="button" aria-pressed={tab === "saved"} onClick={() => setTab("saved")}>Моите шаблони <span>{templates.length}</span></button>
    </div>
    {tab === "presets" ? <div className="caption-presets" role="group" aria-label="Стил на субтитрите">
      <button type="button" className="caption-preset" aria-pressed={!document.enabled} onClick={() => edit({ enabled: false })}><div className="caption-none">Aa<span>Без субтитри</span></div><strong>Само картина</strong>{!document.enabled && <Check size={16} />}</button>
      {captionPresets.map(p => <button type="button" key={p.id} title={p.description} className="caption-preset" aria-pressed={document.enabled && document.style === p.id} onClick={() => edit({ style: p.id, accent: p.accent, uppercase: p.uppercase, textColor: "#ffffff", size: 1, enabled: true })}>
        <PresetThumbnail style={p.id} look={document.enabled && document.style === p.id ? captionLook(document) : undefined} /><strong>{p.name}</strong>{document.enabled && document.style === p.id && <Check size={16} />}
      </button>)}
    </div> : <div className="caption-template-library">
      <p>Запазете любимата си комбинация от стил, цвят и формат. Шаблоните са достъпни за този профил в този браузър.</p>
      <div className="caption-save-look"><label>Име на шаблона<input value={name} onChange={e => setName(e.target.value)} maxLength={32} placeholder="Моят стил за истории" /></label><button type="button" className="btn" disabled={!name.trim() || templates.length >= 8} onClick={() => { if (persist([...templates, { id: crypto.randomUUID(), name: name.trim(), look: captionLook(document) }])) { setName(""); setMessage("Шаблонът е запазен."); } }}><Plus size={16} /> Запази визията</button></div>
      {templates.length >= 8 && <p>Имате 8 шаблона. Изтрийте един, за да добавите нов.</p>}
      <div className="caption-presets">{templates.map(t => <div className="caption-template" key={t.id}><button type="button" className="caption-preset" onClick={() => edit(t.look)}><PresetThumbnail style={t.look.style} look={t.look} /><strong>{t.name}</strong></button><button type="button" className="caption-delete" aria-label={`Изтрий шаблон ${t.name}`} onClick={() => persist(templates.filter(s => s.id !== t.id))}><Trash2 size={14} /></button></div>)}</div>
    </div>}
    {message && <p role="status">{message}</p>}
    <div className="caption-customize">
      <label>Цвят на акцента<input type="color" value={document.accent || "#c8f560"} disabled={!document.enabled} onChange={e => edit({ accent: e.target.value })} /></label>
      <label>Цвят на текста<input type="color" value={document.textColor || "#ffffff"} disabled={!document.enabled} onChange={e => edit({ textColor: e.target.value })} /></label>
      <label>Размер · {Math.round((document.size || 1) * 100)}%<input type="range" min=".7" max="1.4" step=".05" value={document.size || 1} disabled={!document.enabled} onChange={e => edit({ size: Number(e.target.value) })} /></label>
      <label className="caption-uppercase"><input type="checkbox" checked={document.uppercase || false} disabled={!document.enabled} onChange={e => edit({ uppercase: e.target.checked })} /> Главни букви</label>
    </div>
  </fieldset>;
}
