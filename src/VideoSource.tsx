import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import { Notice } from "./lib";
import { uploadMedia } from "./MediaTools";
import { MB, type MediaAsset } from "../shared/media";

const MAX_BYTES = 500 * MB;

/**
 * The video a media tool works on: one from the library, or a new upload right here. An upload is checked
 * automatically first (duration, streams); once ready it is selected, or the tool says why it does not fit.
 */
export function VideoSource({ assets, eligible, value, onChange, onUploaded, describe, requirement }: {
  assets: MediaAsset[];
  /** Videos this tool accepts. */
  eligible: (a: MediaAsset) => boolean;
  value: string;
  onChange: (id: string) => void;
  /** Reload the media library (the new upload and its check). */
  onUploaded: () => void;
  describe: (a: MediaAsset) => string;
  /** Shown when an uploaded video is ready but does not fit (e.g. too short). */
  requirement: string;
}) {
  const [consent, setConsent] = useState(false), [progress, setProgress] = useState<number | null>(null);
  const [pending, setPending] = useState(""), [error, setError] = useState(""), [note, setNote] = useState("");
  const videos = assets.filter(eligible);
  // Select the upload once its check is done.
  useEffect(() => {
    if (!pending) return;
    const asset = assets.find((a) => a.id === pending);
    if (!asset) return;
    if (asset.status === "ready") {
      setPending("");
      if (eligible(asset)) { onChange(asset.id); setNote(""); }
      else setNote(`„${asset.name}“ е качено, но ${requirement}`);
    } else if (asset.status === "deleting") { setPending(""); setError("Видеото не премина автоматичната проверка. Опитайте с друг файл (MP4, MOV или WebM до 10 минути)."); }
  }, [assets, pending, eligible, onChange, requirement]);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) { setError("Изберете видео до 500 MB."); return; }
    setError(""); setNote(""); setProgress(0);
    try {
      const id = await uploadMedia(file, "upload", setProgress);
      setPending(id);
      onUploaded();
    } catch (e) { setError((e as Error).message); }
    finally { setProgress(null); }
  };
  const checking = !!pending && assets.find((a) => a.id === pending)?.status !== "ready";
  return <div className="video-source">
    <label>Видео
      <select value={videos.some((a) => a.id === value) ? value : ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">{videos.length ? "Изберете видео от библиотеката" : "Още няма подходящо видео — качете ново"}</option>
        {videos.map((a) => <option key={a.id} value={a.id}>{describe(a)}</option>)}
      </select>
    </label>
    <div className="video-source-upload">
      <label className="checkbox-label"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Имам право да обработвам видеото, което качвам, и съдържанието му.</label>
      <label className={`btn${!consent || progress !== null || checking ? " disabled" : ""}`}>
        <Upload size={15} /> {progress !== null ? `Качване · ${progress}%` : "Качете ново видео"}
        <input type="file" className="file-input" accept="video/mp4,video/quicktime,video/webm"
          disabled={!consent || progress !== null || checking} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
      </label>
      <small className="vs-fine">MP4, MOV или WebM до 500 MB и 10 минути. Качването е без заплащане; видеото се пази в „Вашите файлове“.</small>
    </div>
    {progress !== null && <p role="status" className="vs-fine">Не затваряйте страницата, докато файлът се качва.</p>}
    {checking && <p role="status" className="video-source-status">Проверяваме видеото… обикновено под минута. Ще бъде избрано автоматично.</p>}
    {note && <Notice>{note}</Notice>}
    {error && <Notice error>{error}</Notice>}
  </div>;
}
