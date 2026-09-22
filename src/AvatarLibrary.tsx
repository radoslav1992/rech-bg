import { useEffect, useRef, useState } from "react";
import { Check, ImagePlus, Search, Users } from "lucide-react";
import { avatarCategories, type LibraryAvatar } from "../shared/avatars";
import { api, Button, Notice } from "./lib";
import "./avatar-library.css";

export function AvatarLibraryPicker({ selectedId = "", disabled = false, onSelect, onBusyChange }: {
  selectedId?: string; disabled?: boolean; onBusyChange?: (busy: boolean) => void;
  onSelect: (avatar: LibraryAvatar, file: File) => Promise<void> | void;
}) {
  const [avatars, setAvatars] = useState<LibraryAvatar[]>([]);
  const [loaded, setLoaded] = useState(false), [error, setError] = useState("");
  const [search, setSearch] = useState(""), [category, setCategory] = useState("");
  const [pending, setPending] = useState(""), [attempt, setAttempt] = useState(0);
  const selecting = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false); setError("");
    api<{ avatars: LibraryAvatar[] }>("/avatars", { signal: controller.signal })
      .then(d => { if (!controller.signal.aborted) { setAvatars(d.avatars); setLoaded(true); } })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    const reload = () => setAttempt(n => n + 1);
    window.addEventListener("rech:avatars-changed", reload);
    return () => window.removeEventListener("rech:avatars-changed", reload);
  }, []);
  const choose = async (avatar: LibraryAvatar) => {
    if (selecting.current || disabled || selectedId === avatar.id) return;
    selecting.current = true; onBusyChange?.(true); setPending(avatar.id); setError("");
    try {
      // Fetch the authenticated library endpoint, never a caller-supplied image URL.
      const response = await fetch(`/api/avatars/${encodeURIComponent(avatar.id)}/image`);
      if (!response.ok) throw new Error("Аватарът вече не е наличен. Обновете библиотеката и изберете отново.");
      const blob = await response.blob();
      if (!["image/jpeg", "image/png"].includes(blob.type) || blob.size > 2 * 1024 * 1024) throw new Error("Изображението не може да бъде използвано.");
      await onSelect(avatar, new File([blob], `${avatar.name}.${blob.type === "image/png" ? "png" : "jpg"}`, { type: blob.type }));
    } catch (e) { setError((e as Error).message); }
    finally { selecting.current = false; onBusyChange?.(false); setPending(""); }
  };
  const visible = avatars.filter(a => (!category || a.category === category) && `${a.name} ${a.description}`.toLocaleLowerCase("bg").includes(search.toLocaleLowerCase("bg")));
  return <div className="avatar-library-picker">
    <div className="avatar-library-heading"><h3><Users size={19}/> Готови аватари</h3><span>{avatars.length} лица</span></div>
    <p>Изберете синтетичен аватар за вашата история. Изборът е безплатен; аудиото, видеото и продуктовите варианти използват обичайните кредити. Гласът се избира отделно.</p>
    {error && <Notice>{error} <button type="button" className="text-link" disabled={!!pending} onClick={() => setAttempt(n => n + 1)}>Обнови библиотеката</button></Notice>}
    {!loaded && !error && <p role="status">Зареждаме аватарите…</p>}
    {loaded && <>
      <div className="avatar-library-filters"><label><Search size={16}/><input aria-label="Търсете аватар" placeholder="Име или описание…" value={search} onChange={e => setSearch(e.target.value)}/></label><select aria-label="Стил на аватара" value={category} onChange={e => setCategory(e.target.value)}><option value="">Всички стилове</option>{Object.entries(avatarCategories).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></div>
      <div className="avatar-library-grid" role="group" aria-label="Изберете готов аватар">{visible.map(a => <button type="button" key={a.id} className={`avatar-library-card ${selectedId === a.id ? "selected" : ""}`} aria-pressed={selectedId === a.id} disabled={disabled || !!pending} onClick={() => void choose(a)}>
        <span className="avatar-library-photo"><img src={a.imageUrl} alt={`Синтетичен аватар ${a.name}`} loading="lazy" width="300" height="400"/>{selectedId === a.id && <span className="avatar-library-check"><Check size={17}/></span>}</span>
        <strong>{a.name}</strong><small>{a.description}</small><span className="avatar-library-action">{pending === a.id ? "Подготвяме…" : selectedId === a.id ? "Избран аватар" : "Изберете аватара"}</span>
      </button>)}</div>
      {!visible.length && <p>{avatars.length ? "Няма аватари с тези критерии." : "Готовите аватари предстоят. Можете да качите свой портрет."}</p>}
    </>}
  </div>;
}

export function AvatarLibraryAdmin() {
  const [avatars, setAvatars] = useState<LibraryAvatar[]>([]), [selected, setSelected] = useState<LibraryAvatar | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const lock = useRef(false);
  const load = async () => { const d = await api<{avatars: LibraryAvatar[]}>("/admin/avatars"); setAvatars(d.avatars); setLoaded(true); };
  useEffect(() => { void load().catch(e => setError(e.message)); }, []);
  const act = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await fn(); await load(); window.dispatchEvent(new Event("rech:avatars-changed")); }
    catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };
  return <section className="settings-card avatar-library-admin">
    <h2><Users size={21}/> Библиотека с аватари</h2>
    <p>Добавяйте синтетични лица, които всички потребители могат да използват във видео и с продукти. Скритите аватари могат да бъдат възстановени. Промените не засягат вече избрани копия и готови видеа.</p>
    {error && <Notice>{error}</Notice>}
    {!loaded && <Button className="btn" busy={busy} onClick={() => void act(load)}>Зареди библиотеката</Button>}
    <fieldset disabled={busy}>
      <div className="avatar-admin-list">{avatars.map(a => <div key={a.id} className={a.active ? "" : "is-hidden"}>
        {a.active ? <img src={a.imageUrl} alt={a.name} width="55" height="70"/> : <Users size={30}/>}
        <span><strong>{a.name}</strong><small>{a.active ? avatarCategories[a.category] : "Скрит от потребителите"}</small></span>
        <button type="button" className="btn outline small-btn" onClick={() => setSelected(a)}>Редактирай</button>
        <button type="button" className="text-link" onClick={() => void act(async () => {
          if (a.active) await api(`/admin/avatars/${a.id}`, { method: "DELETE" });
          else await api(`/admin/avatars/${a.id}`, { method: "PUT", body: JSON.stringify({ ...a, active: true }) });
          if (selected?.id === a.id) setSelected(null);
        })}>{a.active ? "Скрий" : "Възстанови"}</button>
      </div>)}</div>
      <h3>{selected ? `Редактирайте ${selected.name}` : "Нов аватар"}</h3>
      <form key={selected?.id || "new"} onSubmit={e => {
        e.preventDefault(); const form = e.currentTarget, body = new FormData(form);
        void act(async () => {
          if (selected) await api(`/admin/avatars/${selected.id}`, { method: "PUT", body: JSON.stringify({ ...Object.fromEntries(body), active: selected.active }) });
          else await api("/admin/avatars", { method: "POST", body });
          form.reset(); setSelected(null);
        });
      }}>
        <div className="avatar-admin-fields"><label>Име<input name="name" required maxLength={50} defaultValue={selected?.name || ""}/></label><label>Стил<select name="category" defaultValue={selected?.category || "business"}>{Object.entries(avatarCategories).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label>Образ<select name="presentation" defaultValue={selected?.presentation || "female"}><option value="female">Жена</option><option value="male">Мъж</option></select></label></div>
        <label>Кратко описание<input name="description" required maxLength={180} defaultValue={selected?.description || ""}/></label>
        {!selected && <><label><ImagePlus size={18}/> Портрет · JPG или PNG до 2 MB<input name="file" type="file" accept="image/jpeg,image/png" required/></label><label className="checkbox-label"><input name="rightsConfirmed" type="checkbox" value="true" required/> Аватарът е AI-генериран, не представя реален човек и имам право да го предоставям на потребителите за създаване на съдържание.</label></>}
        <div className="avatar-admin-actions"><Button type="submit" className="btn primary" busy={busy}>{selected ? "Запази промените" : "Добави в библиотеката"}</Button>{selected && <button type="button" className="btn outline" onClick={() => setSelected(null)}>Нов аватар / Отказ</button>}</div>
      </form>
    </fieldset>
  </section>;
}
