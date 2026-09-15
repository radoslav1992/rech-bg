import { useEffect, useState } from "react";
import { Mic, Plus, Save, Sparkles, Trash2, Upload } from "lucide-react";
import { sampleSentence } from "../shared/catalog";
import type { StudioVoice } from "../shared/studio";
import { api, Button, Notice } from "./lib";

type AdminVoice = StudioVoice & { providerVoiceId: string; revision: string; source: "admin" | "environment" | "default" };
export function StudioVoiceAdmin() {
  const [voices, setVoices] = useState<AdminVoice[]>([]), [selected, setSelected] = useState("");
  const [creating, setCreating] = useState(false);
  const [fields, setFields] = useState({ name: "", description: "", providerVoiceId: "" });
  const [enabled, setEnabled] = useState(false), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(""), [draft, setDraft] = useState<{ audio: Blob; revision: string; voice: string } | null>(null), [preview, setPreview] = useState("");
  const voice = voices.find(v => v.id === selected);
  const dirty = creating ? !!(fields.name || fields.description || fields.providerVoiceId) : !!voice && (fields.name !== voice.name || fields.description !== voice.description || fields.providerVoiceId !== voice.providerVoiceId);
  const populate = (v?: AdminVoice) => setFields({ name: v?.name || "", description: v?.description || "", providerVoiceId: v?.providerVoiceId || "" });
  const load = async (preferred = selected) => {
    const d = await api<{ enabled: boolean; voices: AdminVoice[] }>("/admin/studio-voices");
    const target = d.voices.find(v => v.id === preferred) || d.voices[0];
    setEnabled(d.enabled); setVoices(d.voices); setSelected(target?.id || ""); populate(target); setCreating(!target); setLoaded(true);
  };
  useEffect(() => { void load().catch(e => setMessage(e.message)); }, []);
  useEffect(() => { if (!dirty) return; const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [dirty]);
  const choose = (id: string | null) => {
    if (dirty && !confirm("Имате незапазени промени. Да ги отхвърлим ли?")) return;
    setCreating(id === null); setSelected(id || ""); populate(voices.find(v => v.id === id)); setDraft(null); setMessage("");
  };
  const changed = () => window.dispatchEvent(new Event("rech:studio-voices-changed"));
  useEffect(() => { if (!draft) { setPreview(""); return; } const url = URL.createObjectURL(draft.audio); setPreview(url); return () => URL.revokeObjectURL(url); }, [draft]);
  const act = async (fn: () => Promise<void>) => { setBusy(true); setMessage(""); try { await fn(); } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); } };
  const update = (v: AdminVoice) => { setVoices(list => list.some(old => old.id === v.id) ? list.map(old => old.id === v.id ? v : old) : [...list, v]); setSelected(v.id); setCreating(false); populate(v); setDraft(null); changed(); };
  const publish = async (audio: Blob, revision: string) => {
    const form = new FormData(); form.set("file", audio, audio.type === "audio/mpeg" ? "sample.mp3" : "sample.wav"); form.set("voiceRevision", revision);
    await api(`/admin/voices/${selected}/sample`, { method: "POST", body: form });
    setDraft(null); await load(); changed(); setMessage("Примерът е публикуван във видео студиото.");
  };
  return <section className="settings-card studio-voice-admin">
    <h2><Mic size={21} /> Гласове за видео студиото</h2>
    <p>Добавяйте гласове с ElevenLabs Voice ID и ги управлявайте от тази обща библиотека. Името и описанието се показват на потребителите; Voice ID е видим само тук. Настройките в този панел имат предимство пред ELEVENLABS_VOICES.</p>
    {message && <Notice>{message}</Notice>}
    {!loaded ? <Button className="btn" busy={busy} onClick={() => act(() => load())}>Зареди настройките</Button> : <>
      {!enabled && <Notice>Добавете ELEVENLABS_API_KEY в Cloudflare, за да генерирате примери и студийно аудио.</Notice>}
      <fieldset disabled={busy}>
        <div className="studio-admin-toolbar">
          <label>Студиен глас<select value={selected} onChange={e => choose(e.target.value)}>
            {creating && <option value="">Нов глас</option>}
            {voices.map(v => <option key={v.id} value={v.id}>{v.name}{v.sampleUrl ? " — има пример" : " — без пример"}</option>)}
          </select></label>
          <Button className="btn dark" type="button" onClick={() => choose(null)}><Plus size={16} /> Добави глас</Button>
        </div>
        <p>{voices.length} {voices.length === 1 ? "активен глас" : "активни гласа"} във видео студиото.</p>
        {creating && <h3>Нов глас</h3>}
        <form onSubmit={e => { e.preventDefault(); void act(async () => { const d = await api<{ voice: AdminVoice }>(creating ? "/admin/studio-voices" : `/admin/studio-voices/${selected}`, { method: creating ? "POST" : "PUT", body: JSON.stringify(fields) }); update(d.voice); setMessage("Гласът е запазен. Създайте пример, за да проверите звученето."); }); }}>
          <label>Име в студиото<input value={fields.name} maxLength={40} required onChange={e => setFields(f => ({ ...f, name: e.target.value }))} /></label>
          <label>Описание на гласа<input value={fields.description} maxLength={120} required onChange={e => setFields(f => ({ ...f, description: e.target.value }))} /></label>
          <label>ElevenLabs Voice ID<input value={fields.providerVoiceId} maxLength={128} required pattern="[a-zA-Z0-9_-]+" autoComplete="off" spellCheck={false} onChange={e => { setFields(f => ({ ...f, providerVoiceId: e.target.value })); setDraft(null); }} /></label>
          <p>Копирайте Voice ID от избрания глас във вашия ElevenLabs акаунт. След смяна на ID старият пример се скрива, докато публикувате нов.</p>
          <Button className="btn dark" type="submit" disabled={!dirty}><Save size={16} /> {creating ? "Добави и запази гласа" : "Запази гласа"}</Button>
          {voice && !creating && <Button className="btn danger" type="button" onClick={() => {
            if (!confirm(`Да премахнем ли „${voice.name}“ от списъка? Създадените записи ще останат достъпни.`)) return;
            void act(async () => { await api(`/admin/studio-voices/${selected}`, { method: "DELETE" }); setDraft(null); await load(""); changed(); setMessage("Гласът е премахнат от видео студиото."); });
          }}><Trash2 size={16} /> Премахни гласа</Button>}
          {creating && voices.length > 0 && <Button className="btn" type="button" onClick={() => choose(voices[0].id)}>Отказ</Button>}
        </form>
        {voice && !creating && <div className="studio-sample-admin">
          <h3>Аудио пример</h3><blockquote>{sampleSentence}</blockquote>
          <p>Създаването използва платеното потребление на ElevenLabs, без да отнема кредити от личния ви план. Прослушайте примера преди публикуване.</p>
          {dirty && <Notice>Първо запазете промените по гласа.</Notice>}
          <Button className="btn dark" disabled={!enabled || dirty} onClick={() => act(async () => {
            setMessage("Създаваме примера. Това може да отнеме около минута.");
            const response = await fetch(`/api/admin/voices/${selected}/sample/generate`, { method: "POST" });
            if (!response.ok) { const d = await response.json().catch(() => ({})) as { error?: string }; throw new Error(d.error || "Примерът не беше създаден."); }
            const revision = response.headers.get("X-Voice-Revision");
            if (!revision) throw new Error("Обновете страницата и опитайте отново.");
            setDraft({ voice: selected, revision, audio: await response.blob() }); setMessage("Примерът е готов за прослушване. Все още не е публикуван.");
          })}><Sparkles size={16} /> Създай студиен пример</Button>
          {draft?.voice === selected && preview && <div className="sample-admin-player"><span>Нов пример — още не е публикуван</span><audio controls src={preview} /><Button className="btn dark" disabled={dirty} onClick={() => act(() => publish(draft.audio, draft.revision))}>{voice.sampleUrl ? "Замени студийния пример" : "Публикувай студийния пример"}</Button></div>}
          <form onSubmit={e => { e.preventDefault(); const form = e.currentTarget, file = new FormData(form).get("file"); if (!(file instanceof File)) return; void act(async () => { await publish(file, voice.revision); form.reset(); }); }}>
            <label>Или качете WAV / MP3 до 2 MB<input type="file" name="file" accept="audio/wav,audio/mpeg,.wav,.mp3" required disabled={dirty} /></label>
            <Button className="btn" type="submit" disabled={dirty}><Upload size={16} /> Качи студиен пример</Button>
          </form>
          {voice.sampleUrl && <div className="sample-admin-player"><span>Публикуван пример</span><audio controls src={voice.sampleUrl} /><Button className="text-link" onClick={() => act(async () => { await api(`/admin/voices/${selected}/sample`, { method: "DELETE" }); await load(); changed(); setMessage("Студийният пример е премахнат."); })}>Премахни студийния пример</Button></div>}
        </div>}
      </fieldset>
    </>}
  </section>;
}
