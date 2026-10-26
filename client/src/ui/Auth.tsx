import { useState, type FormEvent } from "react";
import { ALIAS_RE, PASSPHRASE_MIN, type Me } from "../../../shared/protocol.ts";
import { api, ApiError } from "../lib/api.ts";
import { copyText } from "./common.tsx";
import { Icon } from "./icons.tsx";

type Mode = "login" | "signup" | "recover";
export type AuthKind = Mode;

/** Passphrase ikut diteruskan (hanya di memori) untuk membuka/membuat brankas perangkat. */
export function Auth({ onAuthed, notice, initialAlias }: { onAuthed: (me: Me, passphrase: string, kind: AuthKind) => void; notice?: string | null; initialAlias?: string }) {
  const [mode, setMode] = useState<Mode>("login");
  const [alias, setAlias] = useState(initialAlias ?? "");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [code, setCode] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{ code: string; me: Me; kind: AuthKind } | null>(null);

  if (recovery) return <RecoveryCodeScreen code={recovery.code} onDone={() => onAuthed(recovery.me, pass, recovery.kind)} />;

  const aliasProblem = alias && !ALIAS_RE.test(alias) ? "3–24 karakter: huruf, angka, atau garis bawah (_)" : null;
  const passProblem =
    mode !== "login" && pass && pass.length < PASSPHRASE_MIN
      ? `Minimal ${PASSPHRASE_MIN} karakter. Tips: gabungkan 3–4 kata acak, misal "kopi-hujan-rotan-senja".`
      : null;
  const mismatch = mode !== "login" && pass2 && pass !== pass2 ? "Passphrase tidak sama" : null;
  const canSubmit =
    !busy &&
    alias.length > 0 &&
    pass.length > 0 &&
    (mode === "login" || (!aliasProblem && !passProblem && !mismatch && pass === pass2)) &&
    (mode !== "recover" || code.replace(/[^0-9a-z]/gi, "").length >= 20);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        const r = await api<{ me: Me }>("POST", "/api/auth/login", { alias, passphrase: pass });
        onAuthed(r.me, pass, "login");
      } else if (mode === "signup") {
        const r = await api<{ me: Me; recoveryCode: string }>("POST", "/api/auth/signup", { alias, passphrase: pass });
        setRecovery({ code: r.recoveryCode, me: r.me, kind: "signup" });
      } else {
        const r = await api<{ me: Me; recoveryCode: string }>("POST", "/api/auth/recover", { alias, recoveryCode: code, newPassphrase: pass });
        setRecovery({ code: r.recoveryCode, me: r.me, kind: "recover" });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Terjadi kesalahan. Coba lagi.");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(m: Mode) {
    setMode(m);
    setError(null);
    setPass("");
    setPass2("");
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="hero-mark">
          <Icon name="mask" size={44} strokeWidth={1.6} />
          <div className="hero-name">PINPath</div>
          <h1 className="hero-title">Mulai Obrolan Rahasia</h1>
          <div className="small muted">Messenger PIN terenkripsi end-to-end</div>
        </div>

        <div className="card">
          {notice && (
            <div className="banner info" style={{ margin: "-14px -14px 14px", borderRadius: "14px 14px 0 0" }}>
              <Icon name="shield" />
              <span>{notice}</span>
            </div>
          )}
          <div className="tabs" role="tablist">
            {(
              [
                ["login", "Masuk"],
                ["signup", "Daftar"],
                ["recover", "Pulihkan"],
              ] as const
            ).map(([m, label]) => (
              <button key={m} role="tab" aria-selected={mode === m} onClick={() => switchMode(m)} type="button">
                {label}
              </button>
            ))}
          </div>

          <form className="stack" onSubmit={submit} noValidate>
            <div className="field">
              <label htmlFor="alias">Alias (nama samaran)</label>
              <input
                id="alias"
                className="input"
                autoComplete="username"
                autoCapitalize="off"
                spellCheck={false}
                maxLength={24}
                value={alias}
                onChange={(e) => setAlias(e.target.value.trim())}
                placeholder="mis. Anon_Wolf99"
              />
              {mode === "signup" && (aliasProblem ? <span className="error">{aliasProblem}</span> : <span className="hint">Jangan pakai nama asli. Alias terlihat oleh kontak yang kamu terima.</span>)}
            </div>

            {mode === "recover" && (
              <div className="field">
                <label htmlFor="code">Kode pemulihan</label>
                <input id="code" className="input mono" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" />
              </div>
            )}

            <div className="field">
              <label htmlFor="pass">{mode === "recover" ? "Passphrase baru" : "Passphrase"}</label>
              <div className="row">
                <input
                  id="pass"
                  className="input"
                  type={show ? "text" : "password"}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  maxLength={256}
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                />
                <button type="button" className="btn ghost icon" onClick={() => setShow(!show)} aria-label={show ? "Sembunyikan passphrase" : "Tampilkan passphrase"}>
                  <Icon name={show ? "eyeOff" : "eye"} />
                </button>
              </div>
              {passProblem && <span className="hint">{passProblem}</span>}
            </div>

            {mode !== "login" && (
              <div className="field">
                <label htmlFor="pass2">Ulangi passphrase</label>
                <input id="pass2" className="input" type={show ? "text" : "password"} autoComplete="new-password" maxLength={256} value={pass2} onChange={(e) => setPass2(e.target.value)} />
                {mismatch && <span className="error">{mismatch}</span>}
              </div>
            )}

            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}

            <button className="btn primary block" disabled={!canSubmit}>
              {busy ? "Memproses…" : mode === "login" ? "Masuk" : mode === "signup" ? "Buat akun" : "Pulihkan akun"}
            </button>
          </form>

          {mode === "signup" && (
            <div className="features">
              <div><Icon name="check" size={16} /> Tanpa nomor HP, email, atau KTP.</div>
              <div><Icon name="check" size={16} /> Pesan dikunci di perangkatmu — server PINPath tidak bisa membacanya.</div>
              <div><Icon name="check" size={16} /> Orang asing harus kamu setujui dulu sebelum bisa mengirim pesan.</div>
            </div>
          )}
          {mode === "recover" && <p className="hint">Pemulihan mengganti passphrase dan mengeluarkan semua perangkat lain. Kunci enkripsi pesan dibuka terpisah dengan frasa kunci perangkat (atau passphrase lama).</p>}
        </div>
      </div>
    </div>
  );
}

function RecoveryCodeScreen({ code, onDone }: { code: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  function download() {
    const blob = new Blob([`Kode pemulihan PINPath\n\n${code}\n\nSimpan di tempat aman. Siapa pun yang memegang kode ini + alias kamu bisa mengambil alih akun.\n`], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pinpath-kode-pemulihan.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <div className="auth">
      <div className="auth-card card stack">
        <div className="row">
          <Icon name="key" />
          <h2 style={{ margin: 0, fontSize: 18 }}>Simpan kode pemulihan</h2>
        </div>
        <p className="small" style={{ margin: 0, color: "var(--text-2)" }}>
          PINPath tidak menyimpan nomor HP atau email, jadi <strong>kode ini satu-satunya cara</strong> masuk lagi kalau kamu lupa passphrase. Kode hanya ditampilkan sekali.
        </p>
        <div className="recovery" aria-label="Kode pemulihan">{code}</div>
        <div className="row">
          <button className="btn grow" type="button" onClick={async () => setCopied(await copyText(code))}>
            <Icon name="copy" /> {copied ? "Tersalin" : "Salin"}
          </button>
          <button className="btn grow" type="button" onClick={download}>
            <Icon name="share" /> Unduh .txt
          </button>
        </div>
        <label className="row small" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          Saya sudah menyimpan kode ini di tempat aman (bukan di chat).
        </label>
        <button className="btn primary block" disabled={!saved} onClick={onDone}>
          Lanjut ke PINPath
        </button>
      </div>
    </div>
  );
}
