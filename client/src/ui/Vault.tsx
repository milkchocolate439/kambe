import { useRef, useState, type FormEvent } from "react";
import type { Me } from "../../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { backupKeyFromCode, createFresh, restoreFromCode, revealSeed, rewrapWithOld } from "../lib/device.ts";
import type { UnlockedDevice } from "../lib/keystore.ts";
import { copyText, useMessenger } from "./common.tsx";
import { Icon } from "./icons.tsx";

const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : "Terjadi kesalahan. Coba lagi.");

function downloadText(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Frasa kunci ditampilkan SEKALI setelah dibuat. */
export function SeedCodeScreen({ code, onDone }: { code: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="auth">
      <div className="auth-card card stack">
        <div className="row">
          <Icon name="key" />
          <h2 style={{ margin: 0, fontSize: 18 }}>Simpan frasa kunci perangkat</h2>
        </div>
        <p className="small" style={{ margin: 0, color: "var(--text-2)" }}>
          Frasa ini <strong>membuka kunci enkripsimu</strong>. Dengan frasa ini kamu bisa pindah ke HP baru tanpa kontak melihat
          “safety number berubah”, dan membuka file cadangan riwayat. Frasa ini <strong>tidak pernah dikirim ke server</strong> —
          kalau hilang, tidak ada yang bisa memulihkannya.
        </p>
        <div className="recovery mono" aria-label="Frasa kunci perangkat" style={{ wordBreak: "break-word" }}>{code}</div>
        <div className="row">
          <button className="btn grow" type="button" onClick={async () => setCopied(await copyText(code))}>
            <Icon name="copy" /> {copied ? "Tersalin" : "Salin"}
          </button>
          <button className="btn grow" type="button" onClick={() => downloadText("pinpath-frasa-kunci.txt", `Frasa kunci perangkat PINPath\n\n${code}\n\nSimpan terpisah dari HP. Jangan kirim lewat chat.\n`)}>
            <Icon name="share" /> Unduh .txt
          </button>
        </div>
        <label className="row small" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          Saya sudah menyimpan frasa kunci ini di tempat aman (bukan di chat).
        </label>
        <button className="btn primary block" disabled={!saved} onClick={onDone}>
          Frasa kunci sudah kusimpan
        </button>
      </div>
    </div>
  );
}

const SETUP_TEXT: Record<"new_device" | "passphrase_changed" | "legacy", { title: string; body: string }> = {
  new_device: {
    title: "Perangkat baru",
    body: "Brankas enkripsimu belum ada di perangkat ini. Masukkan frasa kunci agar kuncimu sama seperti di perangkat lama — kontak tidak akan melihat safety number berubah.",
  },
  passphrase_changed: {
    title: "Passphrase berubah",
    body: "Brankas di perangkat ini dikunci dengan passphrase lama (mis. setelah pemulihan akun). Buka dengan passphrase lama atau frasa kunci — brankas lalu dikunci ulang dengan passphrase barumu.",
  },
  legacy: {
    title: "Tingkatkan keamanan perangkat",
    body: "PINPath sekarang mengunci riwayat di perangkat dengan frasa kunci. Kalau kamu belum pernah punya frasa kunci, pilih “Mulai dengan frasa kunci baru” — riwayat di perangkat ini tetap utuh dan ikut dienkripsi.",
  },
};

/** Muncul setelah masuk bila brankas perangkat belum bisa dibuka otomatis. */
export function DeviceSetup({
  me,
  passphrase,
  reason,
  onReady,
  onCancel,
}: {
  me: Me;
  passphrase: string;
  reason: "new_device" | "passphrase_changed" | "legacy";
  onReady: (device: UnlockedDevice, seedCode: string | null) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"code" | "old" | "fresh">(reason === "legacy" ? "fresh" : "code");
  const [code, setCode] = useState("");
  const [old, setOld] = useState("");
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = SETUP_TEXT[reason];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "code") onReady(await restoreFromCode(me, passphrase, code), null);
      else if (mode === "old") onReady(await rewrapWithOld(me, old, passphrase), null);
      else {
        const r = await createFresh(me, passphrase);
        onReady(r.device, r.seedCode);
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const options: [typeof mode, string][] = [
    ["code", "Pakai frasa kunci"],
    ...(reason === "passphrase_changed" ? ([["old", "Passphrase lama"]] as [typeof mode, string][]) : []),
    ["fresh", "Mulai baru"],
  ];

  return (
    <div className="auth">
      <div className="auth-card card stack">
        <div className="row">
          <Icon name="shield" />
          <h2 style={{ margin: 0, fontSize: 18 }}>{text.title}</h2>
        </div>
        <p className="small" style={{ margin: 0, color: "var(--text-2)" }}>{text.body}</p>
        <div className="tabs" role="tablist">
          {options.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={mode === k} onClick={() => { setMode(k); setError(null); }}>
              {label}
            </button>
          ))}
        </div>
        <form className="stack" onSubmit={submit} noValidate>
          {mode === "code" && (
            <div className="field">
              <label htmlFor="seed-code">Frasa kunci (14 grup)</label>
              <textarea id="seed-code" className="textarea mono" rows={3} autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-…" />
            </div>
          )}
          {mode === "old" && (
            <div className="field">
              <label htmlFor="old-pass">Passphrase lama</label>
              <input id="old-pass" className="input" type="password" autoComplete="off" value={old} onChange={(e) => setOld(e.target.value)} />
            </div>
          )}
          {mode === "fresh" && (
            <label className="row small" style={{ cursor: "pointer", alignItems: "flex-start" }}>
              <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
              <span>
                {reason === "legacy"
                  ? "Buat frasa kunci baru. Kontakmu akan melihat safety number baru sekali ini."
                  : "Saya tidak punya frasa kunci. Buat kunci baru: pesan lama tidak bisa dibuka di sini dan kontak melihat safety number baru."}
              </span>
            </label>
          )}
          {error && <div className="error" role="alert">{error}</div>}
          <button
            className="btn primary block"
            disabled={busy || (mode === "code" && code.replace(/[^0-9a-z]/gi, "").length < 56) || (mode === "old" && !old) || (mode === "fresh" && !sure)}
          >
            {busy ? "Membuka brankas…" : mode === "fresh" ? "Mulai dengan frasa kunci baru" : "Buka brankas"}
          </button>
          <button type="button" className="btn ghost block" onClick={onCancel} disabled={busy}>
            Batal & keluar
          </button>
        </form>
      </div>
    </div>
  );
}

/** Bagian Pengaturan: frasa kunci, cadangan terenkripsi, pemulihan cadangan. */
export function VaultPanel() {
  const [s, m] = useMessenger();
  const [pass, setPass] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [restoreCode, setRestoreCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    const blob = await m.exportBackup();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pinpath-cadangan-${s.me.alias}-${new Date().toISOString().slice(0, 10)}.pinpath`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    m.toast("Cadangan terenkripsi diunduh. Hanya bisa dibuka dengan frasa kuncimu.", "ok");
  }

  async function restore(file: File) {
    const key = restoreCode.trim() ? await backupKeyFromCode(s.me, restoreCode) : undefined;
    const r = await m.importBackup(file, key);
    m.toast(`Cadangan ${new Date(r.createdAt).toLocaleDateString("id-ID")} dipulihkan: ${r.messages} pesan baru`, "ok");
    setRestoreCode("");
  }

  return (
    <div className="stack">
      <div style={{ fontWeight: 600 }}>Brankas & cadangan</div>
      <span className="hint">
        <Icon name="lock" size={12} /> Riwayat chat, pin kunci, dan alamat yang diingat dienkripsi di perangkat ini. Saat kamu keluar, kunci dihapus dari
        perangkat — data hanya terbuka lagi dengan passphrase.
      </span>

      {shown ? (
        <div className="stack">
          <div className="recovery mono" aria-label="Frasa kunci perangkat" style={{ wordBreak: "break-word" }}>{shown}</div>
          <button className="btn block" onClick={() => setShown(null)}>Sembunyikan frasa kunci</button>
        </div>
      ) : (
        <div className="row">
          <input className="input grow" type="password" autoComplete="current-password" placeholder="Passphrase" aria-label="Passphrase untuk melihat frasa kunci" value={pass} onChange={(e) => setPass(e.target.value)} />
          <button
            className="btn"
            disabled={busy || !pass}
            onClick={() =>
              void run(async () => {
                setShown(await revealSeed(s.me, pass));
                setPass("");
              })
            }
          >
            <Icon name="key" /> Lihat frasa kunci
          </button>
        </div>
      )}

      <button className="btn block" disabled={busy} onClick={() => void run(download)}>
        <Icon name="share" /> Unduh cadangan terenkripsi
      </button>

      <div className="field">
        <label htmlFor="restore-code" className="small">Frasa kunci lain (opsional — untuk cadangan dari kunci lama)</label>
        <input id="restore-code" className="input mono" autoComplete="off" spellCheck={false} value={restoreCode} onChange={(e) => setRestoreCode(e.target.value)} placeholder="Kosongkan bila cadangan dari frasa kunci yang sama" />
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".pinpath,application/json"
        aria-label="File cadangan"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void run(() => restore(f));
        }}
      />
      <button className="btn block" disabled={busy} onClick={() => fileRef.current?.click()}>
        <Icon name="check" /> Pulihkan dari file cadangan
      </button>
      {error && <div className="error" role="alert">{error}</div>}
    </div>
  );
}
