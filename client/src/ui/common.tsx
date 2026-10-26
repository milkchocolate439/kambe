import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Messenger, State, Toast } from "../lib/messenger.ts";
import { cleanDisplayText, type SealedView } from "../../../shared/sealed.ts";
import { Icon } from "./icons.tsx";

export type SealedState<T> = { state: "none" } | { state: "loading" } | { state: "locked" } | { state: "ok"; data: T };

/**
 * Buka isi terenkripsi di perangkat ini. "locked" = pemilik belum membagikan kunci ke kamu
 * (mis. kontak baru — dibagikan otomatis saat pemilik online) atau isi tidak sah.
 */
export function useSealed<T>(view: SealedView | null | undefined): SealedState<T> {
  const [, m] = useMessenger();
  const key = view ? `${view.id}:${view.wrap?.wrapped ?? "-"}` : "none";
  const [res, setRes] = useState<{ key: string; data: T | null } | null>(null);
  useEffect(() => {
    if (!view) return;
    let alive = true;
    void m.open<T>(view).then((data) => alive && setRes({ key, data }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, m]);
  if (!view) return { state: "none" };
  if (!res || res.key !== key) return { state: "loading" };
  return res.data ? { state: "ok", data: res.data } : { state: "locked" };
}

/** Tampilkan field teks dari isi terenkripsi (sudah dibersihkan dari trik tampilan). */
export function SealedText<T extends object>({
  view,
  field,
  empty = "",
  locked = "🔒 Terenkripsi — menunggu dibagikan",
  max = 1000,
}: {
  view: SealedView | null | undefined;
  field: keyof T & string;
  empty?: string;
  locked?: string;
  max?: number;
}) {
  const s = useSealed<T>(view);
  if (s.state === "none") return <>{empty}</>;
  if (s.state === "loading") return <span className="muted">…</span>;
  if (s.state === "locked") return <span className="muted">{locked}</span>;
  return <>{cleanDisplayText((s.data as Record<string, unknown>)[field], max) || empty}</>;
}

export const MessengerContext = createContext<Messenger | null>(null);

export function useMessenger(): [State, Messenger] {
  const m = useContext(MessengerContext);
  if (!m) throw new Error("MessengerContext belum disediakan");
  return [useSyncExternalStore(m.subscribe, m.getState), m];
}

// Tema "The Mask": semua avatar berbentuk lencana bulat hijau; pembedanya inisial dan sudut kilau.
export function Avatar({ id, name, size = 42 }: { id: string; name: string; size?: number }) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const initials = name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  return (
    <div className="avatar" style={{ width: size, height: size, ["--glint" as string]: `${h % 360}deg` }} aria-hidden="true">
      {initials}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Tutup">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span />
    </label>
  );
}

export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <Icon name={t.tone === "ok" ? "check" : t.tone === "info" ? "shield" : "alert"} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function formatPin(pin: string) {
  return pin; // 6 karakter sudah mudah dibaca; spasi justru membingungkan saat disalin
}

export function timeOf(ts: number) {
  return new Date(ts).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

export function dayOf(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Hari ini";
  if (d.toDateString() === yest.toDateString()) return "Kemarin";
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
