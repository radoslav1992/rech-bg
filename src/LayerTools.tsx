import { useState } from "react";
import { Film, Image as ImageIcon, Palette, Trash2, Type, Upload } from "lucide-react";
import { Button } from "./lib";
import { uploadMedia } from "./MediaTools";
import { formatTime } from "./timeline";
import { imageAssetKinds, layerPositions, videoAssetKinds, type Layer, type LayerPosition, type SceneBackground } from "../shared/layers";
import type { MediaAsset } from "../shared/media";

const positionNames: Record<LayerPosition, string> = {
  "top-left": "Горе вляво", top: "Горе", "top-right": "Горе вдясно", left: "Вляво", center: "В центъра",
  right: "Вдясно", "bottom-left": "Долу вляво", bottom: "Долу", "bottom-right": "Долу вдясно",
};
export const layerNames = { text: "Текст", image: "Изображение", broll: "B-roll" } as const;
export const isImageAsset = (a: MediaAsset) => (imageAssetKinds as readonly string[]).includes(a.kind) && a.mime.startsWith("image/");
export const isVideoAsset = (a: MediaAsset) => (videoAssetKinds as readonly string[]).includes(a.kind) && a.mime.startsWith("video/");

/** Pick a ready image (or video) from the media library, or upload a new one. */
export function MediaPicker({ assets, video = false, value, onPick, disabled }: {
  assets: MediaAsset[]; video?: boolean; value?: string; onPick: (assetId: string) => void; disabled?: boolean;
}) {
  const [progress, setProgress] = useState<number | null>(null), [error, setError] = useState("");
  const options = assets.filter((a) => a.status === "ready" && (isImageAsset(a) || (video && isVideoAsset(a))));
  const upload = async (file: File | undefined) => {
    if (!file) return;
    const isVideo = file.type.startsWith("video/");
    if (!isVideo && file.size > 2 * 1024 * 1024) { setError("Изберете изображение до 2 MB."); return; }
    setError(""); setProgress(0);
    try { onPick(await uploadMedia(file, isVideo ? "upload" : "product", setProgress)); }
    catch (e) { setError((e as Error).message); }
    finally { setProgress(null); }
  };
  return <div className="tl-media-picker">
    <label>{video ? "Изображение или видео" : "Изображение"}
      <select value={options.some((a) => a.id === value) ? value : ""} disabled={disabled} onChange={(e) => e.target.value && onPick(e.target.value)}>
        <option value="">Изберете от библиотеката…</option>
        {options.map((a) => <option key={a.id} value={a.id}>{a.name}{isVideoAsset(a) ? ` · видео ${Math.round(a.duration)} сек.` : ""}</option>)}
      </select>
    </label>
    <label className="btn tl-upload"><Upload size={15} /> {progress !== null ? `Качване · ${progress}%` : "Качи файл"}
      <input type="file" hidden disabled={disabled || progress !== null} accept={video ? "image/jpeg,image/png,video/mp4,video/quicktime,video/webm" : "image/jpeg,image/png"}
        onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
    </label>
    {video && <small>Качените видеа се проверяват автоматично; клипът става наличен след проверката.</small>}
    {error && <small role="alert">{error}</small>}
  </div>;
}

export function LayerAddBar({ onAdd, onLogo, disabled }: { onAdd: (type: Layer["type"]) => void; onLogo?: () => void; disabled?: boolean }) {
  return <div className="tl-inline-actions tl-layer-add" role="group" aria-label="Добави слой">
    {onLogo && <button type="button" className="btn" disabled={disabled} onClick={onLogo}><Palette size={15} /> Лого на бранда</button>}
    <button type="button" className="btn" disabled={disabled} onClick={() => onAdd("text")}><Type size={15} /> Текст</button>
    <button type="button" className="btn" disabled={disabled} onClick={() => onAdd("image")}><ImageIcon size={15} /> Изображение</button>
    <button type="button" className="btn" disabled={disabled} onClick={() => onAdd("broll")}><Film size={15} /> B-roll</button>
  </div>;
}

/** Edits the selected layer. Times are on the scene's clock, like the timeline. */
export function LayerInspector({ layer, length, assets, onChange, onRemove }: {
  layer: Layer; length: number; assets: MediaAsset[]; onChange: (layer: Layer) => void; onRemove: () => void;
}) {
  const set = (fields: Partial<Layer>) => onChange({ ...layer, ...fields } as Layer);
  const asset = layer.type !== "text" ? assets.find((a) => a.id === layer.assetId) : undefined;
  return <>
    <h3>{layer.type === "text" ? <Type size={17} /> : layer.type === "image" ? <ImageIcon size={17} /> : <Film size={17} />} {layerNames[layer.type]}</h3>
    <p>{formatTime(layer.start)} – {formatTime(layer.end)} · плъзнете клипа по линията „Слоеве“, за да го преместите.</p>
    <div className="tl-layer-times">
      <label>Начало (сек.)<input type="number" min={0} max={length} step={0.1} value={layer.start}
        onChange={(e) => { const start = Math.min(Math.max(0, Number(e.target.value)), layer.end - 0.1); set({ start }); }} /></label>
      <label>Край (сек.)<input type="number" min={0} max={length} step={0.1} value={layer.end}
        onChange={(e) => { const end = Math.max(Math.min(length, Number(e.target.value)), layer.start + 0.1); set({ end }); }} /></label>
    </div>
    {layer.type === "text" && <>
      <label>Текст<textarea rows={2} maxLength={200} value={layer.text} onChange={(e) => set({ text: e.target.value })} /></label>
      <label>Размер · {Math.round(layer.size * 100)}%<input type="range" min={0.02} max={0.15} step={0.005} value={layer.size} onChange={(e) => set({ size: Number(e.target.value) })} /></label>
      <div className="tl-layer-colors">
        <label>Цвят<input type="color" value={layer.color} onChange={(e) => set({ color: e.target.value })} /></label>
        <label className="checkbox-label"><input type="checkbox" checked={!!layer.box} onChange={(e) => set({ box: e.target.checked ? "#111111" : null })} /> Фон зад текста</label>
        {layer.box && <label>Цвят на фона<input type="color" value={layer.box} onChange={(e) => set({ box: e.target.value })} /></label>}
        <label className="checkbox-label"><input type="checkbox" checked={layer.bold} onChange={(e) => set({ bold: e.target.checked })} /> Удебелен</label>
      </div>
    </>}
    {layer.type !== "text" && <MediaPicker assets={assets} video={layer.type === "broll"} value={layer.assetId} onPick={(assetId) => set({ assetId })} />}
    {layer.type !== "broll" && <label>Позиция<select value={layer.position} onChange={(e) => set({ position: e.target.value as LayerPosition })}>
      {layerPositions.map((p) => <option key={p} value={p}>{positionNames[p]}</option>)}
    </select></label>}
    {layer.type === "image" && <>
      <label>Ширина · {Math.round(layer.width * 100)}%<input type="range" min={0.05} max={1} step={0.01} value={layer.width} onChange={(e) => set({ width: Number(e.target.value) })} /></label>
      <label>Плътност · {Math.round(layer.opacity * 100)}%<input type="range" min={0.1} max={1} step={0.05} value={layer.opacity} onChange={(e) => set({ opacity: Number(e.target.value) })} /></label>
    </>}
    {layer.type === "broll" && asset && isVideoAsset(asset) && <label>Начало на клипа · {layer.trim.toFixed(1)} сек.
      <input type="range" min={0} max={Math.max(0, asset.duration - 0.5)} step={0.1} value={layer.trim} onChange={(e) => set({ trim: Number(e.target.value) })} /></label>}
    {layer.type === "broll" && <p className="vs-fine">B-roll покрива целия кадър, докато гласът продължава. Звукът на клипа не се използва.</p>}
    <Button className="btn" onClick={onRemove}><Trash2 size={15} /> Премахни слоя</Button>
  </>;
}

/** The scene background, shown where "contain" framing leaves space around the avatar. */
export function BackgroundControl({ background, assets, fit, onChange }: {
  background: SceneBackground | null; assets: MediaAsset[]; fit: string; onChange: (background: SceneBackground | null) => void;
}) {
  // "Изображение" shows the picker before a file is chosen; the document changes once one is picked.
  const [choosingImage, setChoosingImage] = useState(false);
  const mode = background?.type || (choosingImage ? "image" : "none");
  return <fieldset className="tl-background">
    <legend>Фон на сцената</legend>
    {fit === "cover" && <small>При „Запълни · с изрязване“ фонът не се вижда — аватарът изпълва кадъра.</small>}
    <label>Вид<select value={mode} onChange={(e) => {
      const next = e.target.value;
      setChoosingImage(next === "image");
      if (next === "color") onChange({ type: "color", color: "#1f2433" });
      else if (next === "none") onChange(null);
    }}>
      <option value="none">Черен</option><option value="color">Цвят</option><option value="image">Изображение</option>
    </select></label>
    {background?.type === "color" && <label>Цвят<input type="color" value={background.color} onChange={(e) => onChange({ type: "color", color: e.target.value })} /></label>}
    {mode === "image" && <MediaPicker assets={assets} value={background?.type === "image" ? background.assetId : undefined}
      onPick={(assetId) => onChange({ type: "image", assetId })} />}
  </fieldset>;
}
