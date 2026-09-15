import { useEffect, useRef, useState } from "react";
import { Check, Pause, Play } from "lucide-react";
import type { StudioVoice } from "../shared/studio";
export function StudioVoicePicker({ voices, selected, onSelect }: { voices: readonly StudioVoice[]; selected: string; onSelect: (id: string) => void }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(""), [error, setError] = useState("");
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
  return <><div className="vs-voices" role="group" aria-label="Избор на глас">{voices.map(v => <div className="vs-voice-option" key={v.id}>
    <button type="button" className={selected === v.id ? "selected" : ""} aria-pressed={selected === v.id} onClick={() => onSelect(v.id)}><span className="vs-initial">{v.name[0]}</span><strong>{v.name}</strong><small>{v.description}</small>{selected === v.id && <Check size={16} />}</button>
    <button type="button" className="vs-voice-sample" disabled={!v.sampleUrl} aria-label={`${playing === v.id ? "Пауза" : "Чуйте пример"} — ${v.name}`} onClick={() => void play(v)}>{playing === v.id ? <Pause size={14} /> : <Play size={14} />}{v.sampleUrl ? playing === v.id ? "Пауза" : "Чуйте пример" : "Примерът предстои"}</button>
  </div>)}</div>{error && <p role="alert">{error}</p>}</>;
}
