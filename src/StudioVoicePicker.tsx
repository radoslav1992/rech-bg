import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { StudioVoice } from "../shared/studio";
export function StudioVoicePicker({ voices, selected, onSelect }: { voices: readonly StudioVoice[]; selected: string; onSelect: (id: string) => void }) {
  const voice = voices.find(v => v.id === selected);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(""), [error, setError] = useState("");
  useEffect(() => { audio.current?.pause(); audio.current = null; setPlaying(""); setError(""); }, [selected, voice?.sampleUrl]);
  useEffect(() => () => { audio.current?.pause(); }, []);
  const play = async (voice: StudioVoice) => {
    const wasPlaying = playing === voice.id;
    audio.current?.pause(); audio.current = null; setPlaying(""); setError("");
    if (wasPlaying || !voice.sampleUrl) return;
    const player = new Audio(voice.sampleUrl); audio.current = player;
    player.onended = player.onpause = () => { if (audio.current === player) setPlaying(""); };
    player.onerror = () => { if (audio.current === player) { setPlaying(""); setError("Примерът не се зареди. Опитайте отново."); } };
    try { await player.play(); if (audio.current === player) setPlaying(voice.id); }
    catch { if (audio.current === player) setError("Примерът не се зареди. Опитайте отново."); }
  };
  return <div className="studio-voice-picker">
    <label htmlFor="studio-voice-select">Глас за видеото <span>({voices.length})</span></label>
    <div className="studio-voice-select-row">
      <select id="studio-voice-select" value={voice ? selected : ""} onChange={e => onSelect(e.target.value)} disabled={!voices.length}>
        {!voice && <option value="" disabled>{voices.length ? "Изберете глас" : "Няма налични гласове"}</option>}
        {voices.map(v => <option key={v.id} value={v.id}>{v.name} — {v.description}</option>)}
      </select>
      <button type="button" className="btn studio-voice-preview-button" disabled={!voice?.sampleUrl} aria-label={`${playing === selected ? "Пауза" : "Чуйте пример"} — ${voice?.name || "глас"}`} onClick={() => voice && void play(voice)}>{playing === selected ? <Pause size={16} /> : <Play size={16} />}{voice?.sampleUrl ? playing === selected ? "Пауза" : "Чуйте пример" : "Без пример"}</button>
    </div>
    {voice && <p>{voice.description}</p>}
    {!voice && selected && <p role="status">Гласът от този проект вече не е наличен. Изберете друг за новото озвучаване. Създадените записи остават достъпни.</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
