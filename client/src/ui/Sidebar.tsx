import { useState, type FormEvent } from "react";
import { normalizePin, pinProblem } from "../../../shared/pin.ts";
import { NOTE_MAX } from "../../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { Avatar, copyText, Modal, timeOf, useMessenger } from "./common.tsx";
import { Icon } from "./icons.tsx";
import { RadarCard, ShadowPinModal } from "./Discovery.tsx";

export function Sidebar() {
  return (
    <aside className="sidebar" aria-label="Kontak dan PIN">
      <MyPinCard />
      <InviteCard />
      <RadarCard />
      <Requests />
      <Contacts />
    </aside>
  );
}

function MyPinCard() {
  const [s, m] = useMessenger();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [shadow, setShadow] = useState(false);
  const [busy, setBusy] = useState(false);

  async function copy() {
    if (await copyText(s.me.pin)) m.toast(`PIN ${s.me.pin} disalin. Bagikan tanpa perlu memberi nomor HP.`, "ok");
  }

  async function share() {
    try {
      await navigator.share({ title: "PIN PINPath saya", text: `Tambahkan saya di PINPath dengan PIN: ${s.me.pin}` });
    } catch {
      /* pengguna membatalkan */
    }
  }

  async function rotate() {
    setBusy(true);
    try {
      const pin = await m.rotatePin();
      m.toast(`PIN baru: ${pin}. PIN lama tidak berlaku lagi.`, "ok");
      setConfirmRotate(false);
    } catch (e) {
      m.toast(e instanceof ApiError ? e.message : "Gagal mengganti PIN", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="row">
        <Avatar id={s.me.id} name={s.me.alias} size={46} />
        <div className="grow">
          <div className="name truncate" style={{ fontWeight: 800 }}>{s.me.alias}</div>
          <div className="small muted truncate">{s.me.pm || "Belum ada status"}</div>
        </div>
      </div>
      <div className="divider" style={{ margin: "12px 0" }} />
      <div className="tiny muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>PIN kamu</div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <button className="pin-big" style={{ background: "none", border: 0, padding: 0 }} onClick={copy} aria-label={`Salin PIN ${s.me.pin}`}>
          {s.me.pin}
        </button>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn ghost icon" onClick={copy} aria-label="Salin PIN" title="Salin PIN">
            <Icon name="copy" />
          </button>
          {"share" in navigator && (
            <button className="btn ghost icon" onClick={share} aria-label="Bagikan PIN" title="Bagikan PIN">
              <Icon name="share" />
            </button>
          )}
          <button className="btn ghost icon" onClick={() => setConfirmRotate(true)} aria-label="Ganti PIN" title="Ganti PIN (kalau kena spam)">
            <Icon name="refresh" />
          </button>
        </div>
      </div>
      <div className="hint">PIN hanya untuk berbagi kontak — bukan kata sandi. Orang lain harus kamu setujui dulu.</div>
      <button className="btn small block" style={{ marginTop: 10 }} onClick={() => setShadow(true)}>
        <Icon name="clock" size={15} /> Shadow PIN sementara (24 jam)
      </button>
      {shadow && <ShadowPinModal onClose={() => setShadow(false)} />}

      {confirmRotate && (
        <Modal title="Ganti PIN?" onClose={() => setConfirmRotate(false)}>
          <div className="stack">
            <p className="small" style={{ margin: 0, color: "var(--text-2)" }}>
              PIN lama langsung tidak berlaku, dan semua undangan yang belum kamu terima ikut terhapus. Kontak yang sudah terhubung <strong>tidak</strong> terputus. Berguna kalau PIN-mu tersebar dan kamu kena spam.
            </p>
            <div className="row">
              <button className="btn grow" onClick={() => setConfirmRotate(false)}>Batal</button>
              <button className="btn primary grow" onClick={rotate} disabled={busy}>
                {busy ? "Mengganti…" : "Ganti PIN"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function InviteCard() {
  const [, m] = useMessenger();
  const [pin, setPin] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalized = normalizePin(pin);
  const problem = normalized ? pinProblem(normalized) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (problem || !normalized) return setError(problem ?? "Ketik PIN dulu");
    setBusy(true);
    setError(null);
    try {
      const status = await m.invite(normalized, note.trim());
      m.toast(status === "connected" ? "Terhubung! Kalian saling mengundang." : `Undangan terkirim ke PIN ${normalized}. Tunggu disetujui.`, "ok");
      setPin("");
      setNote("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Gagal mengirim undangan");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h3>
        <Icon name="userPlus" size={14} /> Hubungkan via PIN
      </h3>
      <form className="stack" onSubmit={submit}>
        <div className="row">
          <input
            className="input pin grow"
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.slice(0, 9));
              setError(null);
            }}
            placeholder="PIN 6 karakter"
            aria-label="PIN tujuan"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
          />
          <button className="btn primary" disabled={busy || !normalized}>
            {busy ? "…" : "Undang"}
          </button>
        </div>
        {normalized.length >= 6 && problem && <span className="error">{problem}</span>}
        <input
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
          placeholder="Catatan singkat (opsional), mis. mau tanya stok kopi"
          aria-label="Catatan undangan"
        />
        <span className="hint">
          <Icon name="alert" size={12} /> Catatan undangan <strong>tidak terenkripsi</strong> — jangan tulis data pribadi.
        </span>
        {error && <span className="error" role="alert">{error}</span>}
      </form>
    </section>
  );
}

function Requests() {
  const [s, m] = useMessenger();
  const [busy, setBusy] = useState<string | null>(null);
  if (!s.incoming.length && !s.outgoing.length) return null;

  async function act(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(id);
    try {
      await fn();
      m.toast(ok, "ok");
    } catch (e) {
      m.toast(e instanceof ApiError ? e.message : "Gagal", "danger");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      {s.incoming.length > 0 && (
        <>
          <h3>
            <Icon name="inbox" size={14} /> Undangan masuk <span className="count">{s.incoming.length}</span>
          </h3>
          <div className="list">
            {s.incoming.map((r) => (
              <div key={r.id} className="stack" style={{ gap: 8, padding: 10, borderRadius: 12, background: "var(--panel-2)" }}>
                <div className="row">
                  <Avatar id={r.from.id} name={r.from.alias} size={36} />
                  <div className="grow">
                    <div className="row" style={{ gap: 6 }}>
                      <strong className="truncate">{r.from.alias}</strong>
                      <span className="badge pin">{r.from.pin}</span>
                    </div>
                    {r.from.pm && <div className="tiny muted truncate">{r.from.pm}</div>}
                  </div>
                </div>
                {r.via && (
                  <div className="tiny" style={{ color: "var(--amber)" }}>
                    <Icon name={r.via.kind === "radar" ? "store" : "clock"} size={12} /> Lewat {r.via.kind === "radar" ? "radar" : "Shadow PIN"} {r.via.pin}
                    {r.via.label && r.via.kind === "shadow" ? ` (${r.via.label})` : ""} — dia tidak melihat PIN utamamu
                  </div>
                )}
                {r.note && (
                  <div className="small" style={{ color: "var(--text-2)" }}>
                    “{r.note}”
                  </div>
                )}
                <div className="tiny muted">Orang asing? Jangan terima kalau tidak yakin. Kamu bisa memblokirnya.</div>
                <div className="row">
                  <button className="btn primary small grow" disabled={busy === r.id} onClick={() => act(r.id, () => m.respond(r.id, true), `Terhubung dengan ${r.from.alias}`)}>
                    <Icon name="check" size={15} /> Terima
                  </button>
                  <button className="btn small grow" disabled={busy === r.id} onClick={() => act(r.id, () => m.respond(r.id, false), "Undangan ditolak")}>
                    Tolak
                  </button>
                  <button className="btn danger small" disabled={busy === r.id} onClick={() => act(r.id, () => m.block(r.from.id), `${r.from.alias} diblokir`)} aria-label={`Blokir ${r.from.alias}`} title="Blokir">
                    <Icon name="ban" size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {s.outgoing.length > 0 && (
        <>
          <h3 style={{ marginTop: s.incoming.length ? 14 : 0 }}>
            <Icon name="clock" size={14} /> Menunggu persetujuan
          </h3>
          <div className="list">
            {s.outgoing.map((r) => (
              <div key={r.id} className="row" style={{ padding: "6px 4px" }}>
                <span className="badge pin">{r.pin}</span>
                <span className="tiny muted grow">sejak {timeOf(r.createdAt)}</span>
                <button className="btn ghost small" disabled={busy === r.id} onClick={() => act(r.id, () => m.cancelRequest(r.id), "Undangan dibatalkan")}>
                  Batalkan
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function Contacts() {
  const [s, m] = useMessenger();
  return (
    <section className="card grow" style={{ flex: "1 0 auto" }}>
      <h3>
        <Icon name="lock" size={14} /> Obrolan terenkripsi <span className="muted" style={{ marginLeft: "auto", textTransform: "none", letterSpacing: 0 }}>{s.contacts.length} kontak</span>
      </h3>
      {s.contacts.length === 0 ? (
        <div className="empty">
          <div className="icon-wrap">
            <Icon name="userPlus" size={26} />
          </div>
          <div className="small">Belum ada kontak. Bagikan PIN-mu atau undang PIN orang lain.</div>
        </div>
      ) : (
        <div className="list">
          {s.contacts.map((c) => {
            const pin = s.pins[c.id];
            const alert = !!s.keyAlerts[c.id];
            return (
              <button key={c.id} className={`item ${s.activePeer === c.id ? "active" : ""}`} onClick={() => void m.openThread(c.id)} aria-current={s.activePeer === c.id}>
                <Avatar id={c.id} name={c.alias} />
                <div className="grow">
                  <div className="row" style={{ gap: 6 }}>
                    <span className="name truncate">{c.alias}</span>
                    {alert ? (
                      <Icon name="alert" size={14} style={{ color: "var(--warn)" }} aria-label="Safety number berubah" />
                    ) : pin?.verified ? (
                      <Icon name="shieldCheck" size={14} style={{ color: "var(--ok)" }} aria-label="Terverifikasi" />
                    ) : null}
                  </div>
                  <div className="tiny muted truncate">{c.pm || `PIN ${c.pin}`}</div>
                </div>
                <div className="stack" style={{ gap: 4, alignItems: "flex-end" }}>
                  {c.lastMessageAt && <span className="tiny muted">{timeOf(c.lastMessageAt)}</span>}
                  {c.unread > 0 && <span className="count" aria-label={`${c.unread} pesan belum dibaca`}>{c.unread > 99 ? "99+" : c.unread}</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
