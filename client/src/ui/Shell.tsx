import { useEffect, useState } from "react";
import { MomentsView } from "./Moments.tsx";
import { useMessenger, Toasts, copyText } from "./common.tsx";
import { Sidebar } from "./Sidebar.tsx";
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
  const unreadTotal = s.contacts.reduce((n, c) => n + c.unread, 0) + s.incoming.length;
  // Membuka obrolan dari daftar kontak otomatis keluar dari tampilan Jejak.
  useEffect(() => {
    if (s.activePeer) setMoments(false);
  }, [s.activePeer]);

  return (
    <div className="app">
      <header className="topbar">
        <Logo size={28} />
        <span className="brand hide-mobile">KAMBE</span>
        <button
          className="badge pin"
          style={{ fontSize: 13, padding: "4px 10px", cursor: "pointer" }}
          onClick={async () => (await copyText(s.me.pin)) && m.toast(`PIN Kambe ${s.me.pin} disalin`, "ok")}
          title="Salin PIN Kambe kamu"
        >
          <Icon name="key" size={13} /> {s.me.pin}
        </button>
        <span className="badge ok hide-mobile" title="End-to-end encrypted">
          <Icon name="shieldCheck" size={13} /> E2EE
        </span>
        <span className="grow" />
        {unreadTotal > 0 && <span className="count only-mobile">{unreadTotal}</span>}
        <span className="conn" aria-live="polite">
          <span className={`dot ${s.conn}`} />
          <span className="hide-mobile">{s.conn === "online" ? "Tersambung" : s.conn === "connecting" ? "Menyambung…" : "Offline"}</span>
        </span>
        <button
          className={`btn ${moments ? "primary" : "ghost"} icon`}
          onClick={() => {
            void m.openThread(null);
            setMoments(!moments);
          }}
          aria-label="Jejak"
          aria-pressed={moments}
          title="Jejak"
        >
          <Icon name="planet" />
        </button>
        {s.me.isModerator && (
          <button className="btn ghost icon" onClick={() => setMod(true)} aria-label="Moderasi sengketa" title="Moderasi sengketa" style={{ color: "var(--brand-2)" }}>
            <Icon name="shieldCheck" />
          </button>
        )}
        <button className="btn ghost icon" onClick={() => setStore(true)} aria-label="Toko & Dompet" title="Toko & Dompet (simulasi)" style={{ color: s.pro?.active ? "var(--amber)" : undefined }}>
          <Icon name={s.pro?.active ? "crown" : "store"} />
        </button>
        <button className="btn ghost icon" onClick={() => setSettings(true)} aria-label="Pengaturan">
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
          <span className="small">Offline. Pesan yang kamu tulis akan terkirim otomatis saat tersambung lagi.</span>
        </div>
      )}

      <div className={`layout ${s.activePeer || moments ? "chat-open" : ""}`}>
        <Sidebar />
        {moments ? <MomentsView onBack={() => setMoments(false)} /> : <Chat />}
      </div>

      {settings && <Settings onClose={() => setSettings(false)} onSignedOut={onSignedOut} />}
      {store && <StoreModal onClose={() => setStore(false)} />}
      {mod && <ModModal onClose={() => setMod(false)} />}
      <Toasts toasts={s.toasts} />
    </div>
  );
}
