// Profil kontak (gaya halaman profil di referensi UI): avatar besar, PIN Kambe sebagai pengganti
// nomor HP, kartu statistik, dan daftar aksi. Semua angka dihitung di perangkat ini.
import { Avatar, Modal, SealedText, useMessenger } from "./common.tsx";
import { Icon, type IconName } from "./icons.tsx";
import type { PmContent } from "../../../shared/protocol.ts";

export interface ProfileActions {
  onSafety: () => void;
  onGhost: () => void;
  onSearch: () => void;
  onRemove: () => void;
  onBlock: () => void;
}

export function ContactProfile({ peer, onClose, actions }: { peer: string; onClose: () => void; actions: ProfileActions }) {
  const [s] = useMessenger();
  const c = s.contacts.find((x) => x.id === peer);
  if (!c) return null;
  const pin = s.pins[peer];
  const alert = !!s.keyAlerts[peer];
  const messages = s.threads[peer]?.messages.filter((m) => m.kind === "text" || m.kind === "identity").length ?? 0;
  const deals = s.deals[peer]?.length ?? 0;
  const jejak = (s.moments ?? []).filter((m) => m.authorId === peer).length;
  const trust = alert ? { text: "Safety number berubah — tinjau", color: "var(--warn)", icon: "alert" as const } : pin?.verified ? { text: "Terverifikasi", color: "var(--arwah)", icon: "shieldCheck" as const } : { text: "Belum diverifikasi", color: "var(--muted)", icon: "lock" as const };

  const rows: { icon: IconName; label: string; run: () => void; danger?: boolean }[] = [
    { icon: "fingerprint", label: "Nomor keamanan", run: actions.onSafety },
    { icon: "mask", label: "Etalase Hantu (72 jam)", run: actions.onGhost },
    { icon: "search", label: "Cari pesan dalam chat", run: actions.onSearch },
    { icon: "trash", label: "Hapus kontak", run: actions.onRemove },
    { icon: "ban", label: "Blokir " + c.alias, run: actions.onBlock, danger: true },
  ];

  return (
    <Modal title={c.alias} onClose={onClose}>
      <div className="profile">
        <Avatar id={c.id} name={c.alias} size={96} />
        <div className="profile-name">{c.alias}</div>
        <div className="row" style={{ gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
          <span className="badge pin">PIN {c.pin}</span>
          <span className="badge" style={{ color: trust.color }}>
            <Icon name={trust.icon} size={12} /> {trust.text}
          </span>
        </div>
        <div className="small muted profile-pm">
          <SealedText<PmContent> view={c.pm} field="text" empty="Belum ada status" locked="Status terenkripsi" max={80} />
        </div>
      </div>
      <div className="stats" role="list">
        <div className="stat" role="listitem">
          <span className="stat-label">Pesan</span>
          <strong className="stat-value">{messages.toLocaleString("id-ID")}</strong>
        </div>
        <div className="stat" role="listitem">
          <span className="stat-label">Kesepakatan</span>
          <strong className="stat-value">{deals.toLocaleString("id-ID")}</strong>
        </div>
        <div className="stat" role="listitem">
          <span className="stat-label">Jejak</span>
          <strong className="stat-value">{jejak.toLocaleString("id-ID")}</strong>
        </div>
      </div>
      <div className="profile-list">
        {rows.map((r) => (
          <button
            key={r.label}
            className={"profile-row" + (r.danger ? " danger" : "")}
            onClick={() => {
              onClose();
              r.run();
            }}
          >
            <Icon name={r.icon} size={18} />
            <span className="grow">{r.label}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
