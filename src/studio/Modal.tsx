import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/** A native modal dialog: focus stays inside, Escape and the close button call `onClose`. */
export function Modal({ open, title, onClose, children, wide = false }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return <dialog ref={dialog} className={`st-modal${wide ? " wide" : ""}`} aria-label={title} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }}>
    {open && <>
      <header><h2>{title}</h2><button type="button" className="round" aria-label="Затвори" onClick={onClose}><X size={18} /></button></header>
      <div className="st-modal-body">{children}</div>
    </>}
  </dialog>;
}
