import { useState } from "react";
import { useMessenger, Toasts, copyText } from "./common.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { Chat } from "./Chat.tsx";
import { Settings } from "./Settings.tsx";
import { StoreModal } from "./Commerce.tsx";
import { Icon } from "./icons.tsx";

export function Shell({ onSignedOut }: { onSignedOut: (reason: string) => void }) {
  const [s, m] = useMessenger();
  const [settings, setSettings] = useState(false);
  const [store, setStore] = useState(false);
  const [reclaiming, setReclaiming] = useState(false);
  const unreadTotal = s.contacts.reduce((n, c) => n + c.unread, 0) + s.incoming.length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo" aria-hidden="true">
          <Icon name="fingerprint" />
        </div>
        <span className="brand hide-mobile">PINPath</span>
        <button
          className="badge pin"
          style={{ fontSize: 13, padding: "4px 10px", cursor: "pointer" }}
          onClick={async () => (await copyText(s.me.pin)) && m.toast(`PIN ${s.me.pin} disalin`, "ok")}
          title="Salin PIN kamu"
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
      {s.conn === "offline" && s.device === "ok" && (
        <div className="banner warn">
          <Icon name="wifiOff" />
          <span className="small">Offline. Pesan yang kamu tulis akan terkirim otomatis saat tersambung lagi.</span>
        </div>
      )}

      <div className={`layout ${s.activePeer ? "chat-open" : ""}`}>
        <Sidebar />
        <Chat />
      </div>

      {settings && <Settings onClose={() => setSettings(false)} onSignedOut={onSignedOut} />}
      {store && <StoreModal onClose={() => setStore(false)} />}
      <Toasts toasts={s.toasts} />
    </div>
  );
}
