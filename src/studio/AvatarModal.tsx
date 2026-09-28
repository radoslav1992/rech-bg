import { useEffect, useState } from "react";
import { Check, ImagePlus, Search } from "lucide-react";
import { api, Notice } from "../lib";
import { ProductAvatarPanel, uploadMedia, useMediaLibrary } from "../MediaTools";
import { avatarCategories, type LibraryAvatar } from "../../shared/avatars";
import type { ProjectPortrait } from "../../shared/project";
import type { MediaAsset } from "../../shared/media";
import { Modal } from "./Modal";
import "../avatar-library.css";

/** Images from the media library that can be a scene's presenter. */
export const isPortraitAsset = (a: MediaAsset) =>
  a.status === "ready" && ["portrait", "variant", "product"].includes(a.kind) && a.mime.startsWith("image/") && a.expires_at > Date.now() / 1000;
const MAX_PORTRAIT_BYTES = 8 * 1024 * 1024;

/**
 * Picks the presenter of a scene: every ready-made avatar, the user's own portraits and product
 * avatars, a new upload, or a new avatar holding a product. Choosing is free; the video is paid when created.
 */
export function AvatarModal({ open, selected, onClose, onSelect }: {
  open: boolean; selected: ProjectPortrait | null; onClose: () => void; onSelect: (portrait: ProjectPortrait) => void;
}) {
  const [tab, setTab] = useState<"library" | "mine" | "product">("library");
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
          </button>;
        })}
      </div>
      {avatars && !visible.length && <p>{avatars.length ? "Няма аватари с тези критерии." : "Готовите аватари предстоят. Качете свой портрет от „Моите портрети“."}</p>}
      <p className="vs-fine">Синтетичните аватари са безплатни за избор. Използвайте ги само за съдържание, за което имате права.</p>
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
      <p className="vs-fine">Качените файлове се пазят в медийната ви библиотека според плана ви. Използвайте само изображения, за които имате съгласието на изобразения човек.</p>
    </>}
    {tab === "product" && <ProductAvatarPanel onSelect={(id) => choose({ type: "asset", id })} />}
  </Modal>;
}
