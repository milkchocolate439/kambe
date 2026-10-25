import { useEffect, useState } from "react";
import { PM_MAX, type PmContent } from "../../../shared/protocol.ts";
import { api, ApiError } from "../lib/api.ts";
import { keystore } from "../lib/keystore.ts";
import { Modal, Switch, useMessenger, useSealed } from "./common.tsx";
import { Icon } from "./icons.tsx";

type Run = (fn: () => Promise<unknown>, ok?: string) => Promise<void>;

/** Status pribadi: dibuka (didekripsi) dulu di perangkat, lalu disegel ulang untuk kontak saat disimpan. */
function PmEditor({ run, busy }: { run: Run; busy: boolean }) {
  const [s] = useMessenger();
  const cur = useSealed<PmContent>(s.me.pm);
  if (cur.state === "loading") return <div className="hint">Membuka status terenkripsi…</div>;
  return <PmForm key={s.me.pm?.id ?? "kosong"} initial={cur.state === "ok" ? cur.data.text : ""} run={run} busy={busy} />;
}

function PmForm({ initial, run, busy }: { initial: string; run: Run; busy: boolean }) {
  const [, m] = useMessenger();
  const [pm, setPm] = useState(initial);
  return (
    <div className="field">
      <label htmlFor="pm">Status pribadi (ala BBM)</label>
      <div className="row">
        <input id="pm" className="input grow" maxLength={PM_MAX} value={pm} onChange={(e) => setPm(e.target.value)} placeholder="mis. Cari supplier kopi" />
        <button className="btn" disabled={busy || pm === initial} onClick={() => void run(() => m.updateStatus(pm), pm.trim() ? "Status disimpan (terenkripsi)" : "Status dihapus")}>
          Simpan
        </button>
      </div>
      <span className="hint">
        <Icon name="lock" size={12} /> Terenkripsi end-to-end — hanya kontakmu yang bisa membacanya.
      </span>
    </div>
  );
}

export function Settings({ onClose, onSignedOut }: { onClose: () => void; onSignedOut: (reason: string) => void }) {
  const [s, m] = useMessenger();
  const [blocked, setBlocked] = useState<{ id: string; alias: string }[] | null>(null);
  const [danger, setDanger] = useState<null | "delete">(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ blocked: { id: string; alias: string }[] }>("GET", "/api/blocks").then((r) => setBlocked(r.blocked)).catch(() => setBlocked([]));
  }, []);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (ok) m.toast(ok, "ok");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Gagal");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Pengaturan & privasi" onClose={onClose}>
      <div className="stack" style={{ gap: 16 }}>
        <PmEditor run={run} busy={busy} />

        <div className="row">
          <div className="grow">
            <div style={{ fontWeight: 600 }}>Kirim tanda dibaca (R)</div>
            <div className="hint">Kalau dimatikan, kontak hanya melihat "D" (diterima) untuk pesan mereka.</div>
          </div>
          <Switch checked={s.me.readReceipts} label="Kirim tanda dibaca" onChange={(v) => void run(() => m.updateSettings({ readReceipts: v }))} />
        </div>

        <div className="row">
          <div className="grow">
            <label htmlFor="pin-rotate" style={{ fontWeight: 600 }}>Ganti PIN utama otomatis</label>
            <div className="hint">PIN lama berhenti berlaku; kontak yang sudah terhubung tidak terputus.</div>
          </div>
          <select
            id="pin-rotate"
            className="input"
            style={{ width: "auto" }}
            value={s.me.pinRotateDays}
            onChange={(e) => void run(() => m.updateSettings({ pinRotateDays: Number(e.target.value) }), "Pengaturan rotasi PIN disimpan")}
          >
            <option value={0}>Mati</option>
            <option value={1}>Setiap hari</option>
            <option value={7}>Setiap minggu</option>
            <option value={30}>Setiap bulan</option>
          </select>
        </div>

        <div className="divider" />

        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Diblokir</div>
          {blocked === null ? (
            <div className="hint">Memuat…</div>
          ) : blocked.length === 0 ? (
            <div className="hint">Tidak ada yang kamu blokir.</div>
          ) : (
            <div className="list">
              {blocked.map((b) => (
                <div key={b.id} className="row">
                  <span className="grow truncate">{b.alias}</span>
                  <button
                    className="btn small"
                    onClick={() =>
                      void run(async () => {
                        await api("DELETE", `/api/blocks/${b.id}`);
                        setBlocked(blocked.filter((x) => x.id !== b.id));
                      }, `${b.alias} tidak diblokir lagi`)
                    }
                  >
                    Buka blokir
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="divider" />

        <div className="stack">
          <button className="btn block" disabled={busy} onClick={() => void run(async () => { await api("POST", "/api/auth/logout"); onSignedOut("logout"); })}>
            <Icon name="logout" /> Keluar dari perangkat ini
          </button>
          <button className="btn block" disabled={busy} onClick={() => void run(async () => { await api("POST", "/api/auth/logout-all"); onSignedOut("logout_all"); })}>
            <Icon name="logout" /> Keluar dari semua perangkat
          </button>
          <span className="hint">Kunci enkripsi tetap tersimpan di perangkat ini, jadi pesan lama masih bisa dibuka saat kamu masuk lagi.</span>
          <button className="btn danger block" onClick={() => setDanger("delete")}>
            <Icon name="trash" /> Hapus akun permanen
          </button>
        </div>

        {danger === "delete" && (
          <div className="stack card" style={{ borderColor: "var(--danger)" }}>
            <strong>Hapus akun {s.me.alias}?</strong>
            <span className="small" style={{ color: "var(--text-2)" }}>Semua kontak, pesan terenkripsi, dan PIN-mu dihapus dari server, beserta kunci di perangkat ini. Tidak bisa dibatalkan.</span>
            <input className="input" type="password" autoComplete="current-password" placeholder="Ketik passphrase untuk konfirmasi" value={pass} onChange={(e) => setPass(e.target.value)} />
            <div className="row">
              <button className="btn grow" onClick={() => setDanger(null)}>Batal</button>
              <button
                className="btn danger grow"
                disabled={busy || !pass}
                onClick={() =>
                  void run(async () => {
                    await api("POST", "/api/me/delete", { passphrase: pass });
                    await keystore.wipe();
                    onSignedOut("deleted");
                  })
                }
              >
                Hapus permanen
              </button>
            </div>
          </div>
        )}

        {error && <div className="error" role="alert">{error}</div>}

        <div className="hint" style={{ lineHeight: 1.5 }}>
          <Icon name="shield" size={12} /> PINPath v0.1 · Enkripsi X25519 + AES-256-GCM di perangkat. Server hanya menyimpan ciphertext, alias, PIN, dan waktu kirim — tanpa nomor HP, email, atau identitas asli.
        </div>
      </div>
    </Modal>
  );
}
