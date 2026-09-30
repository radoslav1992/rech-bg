import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, ImagePlus, Search, Sparkles, Trash2 } from "lucide-react";
import { api, Button, Notice, number, useAuth } from "../lib";
import { ProductAvatarPanel, uploadMedia, useMediaLibrary } from "../MediaTools";
import { avatarCategories, type LibraryAvatar } from "../../shared/avatars";
import type { ProjectPortrait } from "../../shared/project";
import type { MediaAsset } from "../../shared/media";
import { canCreateVideo, VIDEO_PLAN_MESSAGE } from "../../shared/catalog";
import { Modal } from "./Modal";
import type { MyAvatars } from "./useStudioData";
import "../avatar-library.css";

/** Images from the media library that can be a scene's presenter. */
export const isPortraitAsset = (a: MediaAsset) =>
  a.status === "ready" && ["portrait", "variant", "product"].includes(a.kind) && a.mime.startsWith("image/") && a.expires_at > Date.now() / 1000;
const MAX_PORTRAIT_BYTES = 8 * 1024 * 1024;

/**
 * Picks the presenter of a scene: every ready-made avatar, the user's own portraits and product
 * avatars, a new upload, or a new avatar holding a product. Choosing is free; the video is paid when created.
 */
export function AvatarModal({ open, selected, onClose, onSelect, linkedAvatars = null, myAvatars = null }: {
  open: boolean; selected: ProjectPortrait | null; onClose: () => void; onSelect: (portrait: ProjectPortrait) => void;
  /** Library avatars ready for video (linked to a saved avatar); they get a badge when tiers need one. */
  linkedAvatars?: Set<string> | null;
  /** The user's own saved avatars, when videos use saved avatars. */
  myAvatars?: MyAvatars | null;
}) {
  const saved = !!myAvatars?.enabled;
  const [tab, setTab] = useState<"saved" | "library" | "mine" | "product">(saved ? "saved" : "library");
  // Opening the picker starts on "Моите аватари" once the account can create them.
  const startedSaved = useRef(false);
  useEffect(() => { if (open && saved && !startedSaved.current) { startedSaved.current = true; setTab("saved"); } }, [open, saved]);
  const [avatars, setAvatars] = useState<LibraryAvatar[] | null>(null), [error, setError] = useState("");
  const [search, setSearch] = useState(""), [category, setCategory] = useState("");
  const [upload, setUpload] = useState<number | null>(null);
  const { data, reload } = useMediaLibrary();
  const mine = (data?.assets || []).filter(isPortraitAsset);
  useEffect(() => {
    if (!open || avatars) return;
    const controller = new AbortController();
    api<{ avatars: LibraryAvatar[] }>("/avatars", { signal: controller.signal })
      .then((d) => setAvatars(d.avatars))
      .catch((e) => { if (!controller.signal.aborted) setError((e as Error).message); });
    return () => controller.abort();
  }, [open, avatars]);
  const choose = (portrait: ProjectPortrait) => { onSelect(portrait); onClose(); };
  const uploadPortrait = async (file: File | undefined) => {
    if (!file) return;
    if (!["image/jpeg", "image/png"].includes(file.type) || file.size > MAX_PORTRAIT_BYTES) { setError("Изберете JPG или PNG изображение до 8 MB."); return; }
    setError(""); setUpload(0);
    try {
      const id = await uploadMedia(file, "portrait", setUpload);
      await reload();
      choose({ type: "asset", id });
    } catch (e) { setError((e as Error).message); }
    finally { setUpload(null); }
  };
  const isSelected = (p: ProjectPortrait) => selected?.type === p.type && selected.id === p.id;
  const visible = (avatars || []).filter((a) => (!category || a.category === category) &&
    `${a.name} ${a.description}`.toLocaleLowerCase("bg").includes(search.toLocaleLowerCase("bg")));
  return <Modal open={open} title="Изберете аватар за сцената" onClose={onClose} wide>
    <div className="st-tabs" role="tablist" aria-label="Източник на аватара">
      {saved && <button type="button" role="tab" aria-selected={tab === "saved"} onClick={() => setTab("saved")}>Моите аватари{myAvatars!.ready.size ? ` (${myAvatars!.ready.size})` : ""}</button>}
      <button type="button" role="tab" aria-selected={tab === "library"} onClick={() => setTab("library")}>Готови аватари</button>
      <button type="button" role="tab" aria-selected={tab === "mine"} onClick={() => setTab("mine")}>Моите портрети{mine.length ? ` (${mine.length})` : ""}</button>
      <button type="button" role="tab" aria-selected={tab === "product"} onClick={() => setTab("product")}>Аватар с продукт</button>
    </div>
    {error && <Notice error>{error}</Notice>}
    {tab === "library" && <>
      <div className="avatar-library-filters">
        <label><Search size={16} /><input aria-label="Търсете аватар" placeholder="Име или описание…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <select aria-label="Стил на аватара" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Всички стилове</option>
          {Object.entries(avatarCategories).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
        </select>
      </div>
      {!avatars && !error && <p role="status">Зареждаме аватарите…</p>}
      <div className="st-avatar-grid">
        {visible.map((a) => {
          const p: ProjectPortrait = { type: "library", id: a.id };
          return <button type="button" key={a.id} className={`st-avatar${isSelected(p) ? " selected" : ""}`} aria-pressed={isSelected(p)} onClick={() => choose(p)}>
            <span className="st-avatar-photo"><img src={a.imageUrl} alt="" loading="lazy" width="300" height="400" />{isSelected(p) && <span className="avatar-library-check"><Check size={16} /></span>}</span>
            <strong>{a.name}</strong><small>{a.description}</small>
            {linkedAvatars?.has(a.id) && <span className="st-avatar-tag">Готов за видео</span>}
          </button>;
        })}
      </div>
      {avatars && !visible.length && <p>{avatars.length ? "Няма аватари с тези критерии." : "Готовите аватари предстоят. Качете свой портрет от „Моите портрети“."}</p>}
      <p className="vs-fine">Синтетичните аватари са безплатни за избор. Използвайте ги само за съдържание, за което имате права.{linkedAvatars && (saved
        ? " За видео използвайте аватарите, отбелязани „Готов за видео“, или свой аватар от „Моите аватари“."
        : " Средно качество е достъпно само с аватарите, отбелязани „Готов за видео“; с останалите и със свой портрет изберете друго качество.")}</p>
    </>}
    {tab === "mine" && <>
      <div className="st-avatar-grid">
        <label className={`st-avatar st-avatar-upload${upload !== null ? " busy" : ""}`}>
          <span className="st-avatar-photo"><ImagePlus size={30} /></span>
          <strong>{upload !== null ? `Качване · ${upload}%` : "Качете портрет"}</strong><small>JPG или PNG до 8 MB, с ясно видимо лице</small>
          <input type="file" hidden accept="image/jpeg,image/png" disabled={upload !== null} onChange={(e) => { void uploadPortrait(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        {mine.map((a) => {
          const p: ProjectPortrait = { type: "asset", id: a.id };
          return <button type="button" key={a.id} className={`st-avatar${isSelected(p) ? " selected" : ""}`} aria-pressed={isSelected(p)} onClick={() => choose(p)}>
            <span className="st-avatar-photo"><img src={`/api/media/assets/${a.id}/file`} alt="" loading="lazy" />{isSelected(p) && <span className="avatar-library-check"><Check size={16} /></span>}</span>
            <strong>{a.name}</strong><small>{a.kind === "variant" ? "Аватар с продукт" : a.kind === "product" ? "Изображение на продукт" : "Портрет"}</small>
          </button>;
        })}
      </div>
      <p className="vs-fine">Качените файлове се пазят в медийната ви библиотека според плана ви. Използвайте само изображения, за които имате съгласието на изобразения човек.{saved && " За видео превърнете снимката в аватар от „Моите аватари“."}</p>
    </>}
    {tab === "saved" && myAvatars && <SavedAvatars my={myAvatars} portraits={mine} isSelected={isSelected} choose={choose} onPortraitUploaded={reload} />}
    {tab === "product" && <ProductAvatarPanel onSelect={(id) => choose({ type: "asset", id })} />}
  </Modal>;
}

/**
 * "Моите аватари": photos turned once into reusable video avatars. Creating one costs credits once;
 * every later video only references it.
 */
function SavedAvatars({ my, portraits, isSelected, choose, onPortraitUploaded }: {
  my: MyAvatars; portraits: MediaAsset[];
  isSelected: (p: ProjectPortrait) => boolean; choose: (p: ProjectPortrait) => void; onPortraitUploaded: () => Promise<void> | void;
}) {
  const { user, refresh } = useAuth();
  const [source, setSource] = useState<string>(""), [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState("");
  const [name, setName] = useState(""), [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [done, setDone] = useState("");
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    if (!file) { setPreview(source ? `/api/media/assets/${source}/file` : ""); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, source]);
  const remaining = Math.max(0, (user?.limit || 0) - (user?.used || 0));
  const allowed = canCreateVideo(user?.plan);
  const active = my.avatars.filter((a) => a.status !== "failed").length;
  const create = async () => {
    setBusy("create"); setError(""); setDone("");
    try {
      const body = new FormData();
      body.set("name", name.trim()); body.set("idempotencyKey", key.current); body.set("credits", String(my.credits)); body.set("consent", String(consent));
      if (file) body.set("image", file); else body.set("assetId", source);
      await api("/my-avatars", { method: "POST", body });
      key.current = crypto.randomUUID();
      setDone("Аватарът се създава — обикновено 1–2 минути. Ще можете да го изберете, щом е готов.");
      setName(""); setFile(null); setSource(""); setConsent(false);
      await Promise.all([my.reload(), refresh(), onPortraitUploaded()]);
    } catch (e) { setError((e as Error).message); await my.reload(); }
    finally { setBusy(""); }
  };
  const remove = async (id: string, label: string) => {
    if (!confirm(`Да изтрием ли аватара „${label}“? Видеата, създадени с него, остават.`)) return;
    setBusy(id); setError("");
    try { await api(`/my-avatars/${id}`, { method: "DELETE" }); await my.reload(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  };
  return <>
    {(error || my.error) && <Notice error>{error || my.error}</Notice>}
    {done && <Notice good>{done}</Notice>}
    {!my.loaded && <p role="status">Зареждаме аватарите ви…</p>}
    {my.avatars.length > 0 && <div className="st-avatar-grid">{my.avatars.map((a) => {
      const p: ProjectPortrait = { type: "avatar", id: a.id };
      return <div key={a.id} className="st-my-avatar">
        <button type="button" className={`st-avatar${isSelected(p) ? " selected" : ""}`} aria-pressed={isSelected(p)} disabled={a.status !== "ready"} onClick={() => choose(p)}>
          <span className="st-avatar-photo"><img src={a.imageUrl} alt="" loading="lazy" />{isSelected(p) && <span className="avatar-library-check"><Check size={16} /></span>}</span>
          <strong>{a.name}</strong>
          <span className={`st-avatar-status ${a.status}`}>{a.status === "ready" ? "Готов за видео" : a.status === "processing" ? "Създава се…" : "Неуспешен"}</span>
          {a.status === "failed" && a.error && <small>{a.error}</small>}
        </button>
        {a.status !== "processing" && <button type="button" className="st-my-avatar-remove" aria-label={`Изтрий аватара ${a.name}`} disabled={!!busy} onClick={() => remove(a.id, a.name)}><Trash2 size={14} /></button>}
      </div>;
    })}</div>}
    {my.loaded && !my.avatars.length && <p>Още нямате свои аватари. Създайте един от ваша снимка и го използвайте във всяко следващо видео.</p>}
    <form className="st-create-avatar" onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <h3><Sparkles size={17} /> Нов аватар от снимка</h3>
      <p className="vs-fine">Създава се веднъж за {number(my.credits)} кредита. След това всяко видео с него струва само секундите видео — без нова снимка всеки път.</p>
      {!allowed && <Notice>{VIDEO_PLAN_MESSAGE} <Link to="/app/billing">Вижте плановете</Link></Notice>}
      <div className="st-create-avatar-photo">
        {preview ? <img src={preview} alt="Избраната снимка" /> : <span className="st-avatar-empty"><ImagePlus size={24} /></span>}
        <div>
          <label>Снимка от библиотеката
            <select value={file ? "" : source} onChange={(e) => { setSource(e.target.value); setFile(null); }}>
              <option value="">Изберете…</option>
              {portraits.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label className="btn tl-upload"><ImagePlus size={15} /> {file ? file.name : "Или качете снимка"}
            <input type="file" hidden style={{ display: "none" }} accept="image/jpeg,image/png" onChange={(e) => {
              const f = e.target.files?.[0]; e.target.value = "";
              if (!f) return;
              if (!["image/jpeg", "image/png"].includes(f.type) || f.size > 5 * 1024 * 1024) { setError("Изберете JPG или PNG снимка до 5 MB."); return; }
              setError(""); setFile(f); setSource("");
            }} />
          </label>
        </div>
      </div>
      <small className="vs-fine">Най-добре: едно лице, гледащо към камерата, добре осветено, без слънчеви очила.</small>
      <label>Име на аватара<input value={name} maxLength={50} placeholder="Напр. Аз в офиса" onChange={(e) => setName(e.target.value)} /></label>
      <label className="checkbox-label"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        Аз съм човекът на снимката или имам изричното му съгласие да бъде създаден видео аватар с образа му. Ще обознача видеата като създадени с ИИ, когато ги публикувам.</label>
      <Button type="submit" className="btn primary" busy={busy === "create"}
        disabled={!allowed || !consent || !name.trim() || (!file && !source) || !!busy || my.credits > remaining || active >= my.max || !user?.verified}>
        <Sparkles size={16} /> Създай аватар · {number(my.credits)} кредита</Button>
      {my.credits > remaining && allowed && <p className="vs-fine">Нужни са още {number(my.credits - remaining)} кредита. <Link to="/app/billing">Вижте плановете</Link></p>}
      {active >= my.max && my.max > 0 && <p className="vs-fine">Имате максималния брой аватари ({my.max}). Изтрийте някой, за да създадете нов.</p>}
      <p className="vs-fine">Ако създаването не успее, кредитите се връщат автоматично.</p>
    </form>
  </>;
}
