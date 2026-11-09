import { useEffect, useState } from "react";
import { MomentsView } from "./Moments.tsx";
import { useMessenger, Toasts, copyText } from "./common.tsx";
import { AddContactModal, Sidebar } from "./Sidebar.tsx";
import { NotifyButton } from "./Notify.tsx";
import { Chat } from "./Chat.tsx";
import { Settings } from "./Settings.tsx";
import { StoreModal } from "./Commerce.tsx";
import { ModModal } from "./Disputes.tsx";
import { Icon } from "./icons.tsx";
import { Logo } from "./Logo.tsx";

export function Shell({ onSignedOut }: { onSignedOut: (reason: string) => void }) {
  const [s, m] = useMessenger();
  const [settings, setSettings] = useState(false);
  const [store, setStore] = useState(false);
  const [mod, setMod] = useState(false);
  const [reclaiming, setReclaiming] = useState(false);
  const [moments, setMoments] = useState(false);
  const [adding, setAdding] = useState(false);
  const unreadTotal = s.contacts.reduce((n, c) => n + c.unread, 0) + s.incoming.length;
  // Membuka obrolan dari daftar kontak otomatis keluar dari tampilan Jejak.
  useEffect(() => {
    if (s.activePeer) setMoments(false);
  }, [s.activePeer]);

  const proBadge = !!s.pro?.active && !s.config?.freePlatform;
  const openJejak = () => {
    void m.openThread(null);
    setMoments(true);
  };
  const goChats = () => {
    void m.openThread(null);
    setMoments(false);
  };
  const addContact = () => setAdding(true);

  return (
    <div className={"app" + (s.activePeer || moments ? " in-chat" : "")}>
      <header className="topbar">
        <Logo size={28} />
        <button
          className="badge pin"
          style={{ fontSize: 13, padding: "4px 10px", cursor: "pointer" }}
          onClick={async () => (await copyText(s.me.pin)) && m.toast(`PIN Kambe ${s.me.pin} disalin`, "ok")}
          title="Salin PIN Kambe kamu"
        >
          <Icon name="key" size={13} /> {s.me.pin}
        </button>
        <span className="grow" />
        {unreadTotal > 0 && <span className="count only-mobile">{unreadTotal}</span>}
        <span className="conn" aria-live="polite">
          <span className={`dot ${s.conn}`} />
          <span className="sr-only">{s.conn === "online" ? "Tersambung" : s.conn === "connecting" ? "Menyambung…" : "Offline"}</span>
        </span>
        <NotifyButton />
        {s.me.isModerator && (
          <button className="btn ghost icon tb-action" onClick={() => setMod(true)} aria-label="Moderasi sengketa" title="Moderasi sengketa" style={{ color: "var(--brand-2)" }}>
            <Icon name="shieldCheck" />
          </button>
        )}
        <button className="btn ghost icon tb-action" onClick={() => setStore(true)} aria-label="Toko & Dompet" title="Toko & Dompet" style={{ color: proBadge ? "var(--amber)" : undefined }}>
          <Icon name={proBadge ? "crown" : "store"} />
        </button>
        <button className="btn ghost icon tb-action" onClick={() => setSettings(true)} aria-label="Pengaturan">
          <Icon name="settings" />
        </button>
      </header>

      {s.device === "other_device" && (
        <div className="banner danger" role="alert">
          <Icon name="alert" />
          <div className="grow">
            <strong>Akunmu sekarang aktif di perangkat lain.</strong>
            <div className="small">Perangkat ini tidak bisa mengirim atau membaca pesan baru. Kalau itu bukan kamu, segera pakai perangkat ini lagi lalu ganti passphrase lewat "Pulihkan".</div>
            <div className="actions">
              <button
                className="btn small primary"
                disabled={reclaiming}
                onClick={async () => {
                  setReclaiming(true);
                  try {
                    await m.reclaimDevice();
                  } finally {
                    setReclaiming(false);
                  }
                }}
              >
                Gunakan perangkat ini
              </button>
            </div>
          </div>
        </div>
      )}
      {s.notaryAlert && (
        <div className="banner danger" role="alert">
          <Icon name="alert" />
          <span className="small">{s.notaryAlert}</span>
        </div>
      )}
      {s.conn === "offline" && s.device === "ok" && (
        <div className="banner warn">
          <Icon name="wifiOff" />
          <span className="small">Offline</span>
        </div>
      )}

      <div className={`layout ${s.activePeer || moments ? "chat-open" : ""}`}>
        <Sidebar onAddContact={addContact} />
        {moments ? <MomentsView onBack={() => setMoments(false)} /> : <Chat />}
      </div>

      {/* Dock HP: navigasi pil melayang + tombol tambah (hanya di layar daftar; saat chat terbuka, topbar yang dipakai). */}
      <nav className="dock only-mobile" aria-label="Navigasi utama">
        <div className="dock-pill">
          <button className="dock-btn on" aria-label="Obrolan" aria-current="page" onClick={goChats}>
            <Icon name="inbox" size={20} />
          </button>
          {s.me.isModerator && (
            <button className="dock-btn" aria-label="Moderasi sengketa" onClick={() => setMod(true)}>
              <Icon name="shieldCheck" size={20} />
            </button>
          )}
          <button className="dock-btn" aria-label="Toko & Dompet" onClick={() => setStore(true)}>
            <Icon name={proBadge ? "crown" : "store"} size={20} />
          </button>
          <button className="dock-btn" aria-label="Pengaturan" onClick={() => setSettings(true)}>
            <Icon name="settings" size={20} />
          </button>
        </div>
        <button className="dock-fab" aria-label="Tambah kontak" onClick={addContact}>
          <Icon name="plus" size={24} />
        </button>
      </nav>

      {settings && <Settings onClose={() => setSettings(false)} onSignedOut={onSignedOut} onOpenJejak={openJejak} />}
      {adding && <AddContactModal onClose={() => setAdding(false)} />}
      {store && <StoreModal onClose={() => setStore(false)} />}
      {mod && <ModModal onClose={() => setMod(false)} />}
      <Toasts toasts={s.toasts} />
    </div>
  );
}
