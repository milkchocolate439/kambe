import { useState, type FormEvent } from "react";
import { normalizePin, pinProblem } from "../../../shared/pin.ts";
import { NOTE_MAX, type LabelContent, type NoteContent, type PmContent } from "../../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { Avatar, copyText, Modal, SealedText, timeOf, useMessenger } from "./common.tsx";
import { Icon } from "./icons.tsx";
import { ShadowPinModal } from "./Discovery.tsx";

/** Minimalis: daftar obrolan (+ undangan masuk). Pengguna baru tanpa kontak: PIN & undang. */
export function Sidebar({ onAddContact }: { onAddContact: () => void }) {
  const [s] = useMessenger();
  return (
    <aside className="sidebar" aria-label="Kontak dan PIN Kambe">
      <Requests />
      {s.contacts.length > 0 ? (
        <Contacts onAddContact={onAddContact} />
      ) : (
        <>
          <MyPinCard />
          <InviteCard />
        </>
      )}
    </aside>
  );
}

/** Lembar "Tambah kontak": PIN sendiri untuk dibagikan + undang PIN orang lain. */
export function AddContactModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Tambah kontak" onClose={onClose}>
      <div className="stack">
        <MyPinCard compact />
        <InviteCard />
      </div>
    </Modal>
  );
}

export function MyPinCard({ compact = false }: { compact?: boolean }) {
  const [s, m] = useMessenger();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [shadow, setShadow] = useState(false);
  const [busy, setBusy] = useState(false);

  async function copy() {
    if (await copyText(s.me.pin)) m.toast(`PIN Kambe ${s.me.pin} disalin. Bagikan tanpa perlu memberi nomor HP.`, "ok");
  }

  async function share() {
    try {
      await navigator.share({ title: "PIN Kambe saya", text: `Tambahkan saya di KAMBE dengan PIN Kambe: ${s.me.pin}` });
    } catch {
      /* pengguna membatalkan */
    }
  }

  async function rotate() {
    setBusy(true);
    try {
      const pin = await m.rotatePin();
      m.toast(`PIN Kambe baru: ${pin}. PIN lama tidak berlaku lagi.`, "ok");
      setConfirmRotate(false);
    } catch (e) {
      m.toast(e instanceof ApiError ? e.message : "Gagal mengganti PIN", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card hero-card">
      {!compact && <div className="row">
        <Avatar id={s.me.id} name={s.me.alias} size={46} />
        <div className="grow">
          <div className="name truncate" style={{ fontWeight: 800 }}>{s.me.alias}</div>
          <div className="small muted truncate">
            <SealedText<PmContent> view={s.me.pm} field="text" empty="" />
          </div>
        </div>
      </div>}
      <div className="id-card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="small">PIN Kambe</span>
          <div className="row" style={{ gap: 6 }}>
            {"share" in navigator && (
              <button className="btn ghost icon round" onClick={share} aria-label="Bagikan PIN Kambe" title="Bagikan PIN Kambe">
                <Icon name="share" />
              </button>
            )}
            <button className="btn soft small" onClick={copy} aria-label="Salin PIN Kambe" title="Salin PIN Kambe">
              <Icon name="copy" size={15} /> Salin
            </button>
          </div>
        </div>
        <button className="pin-big" onClick={copy} aria-label={`Salin PIN Kambe ${s.me.pin}`}>
          {s.me.pin}
        </button>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn small grow" onClick={() => setShadow(true)}>
          <Icon name="clock" size={15} /> PIN Bayang 24 jam
        </button>
        <button className="btn small" onClick={() => setConfirmRotate(true)} aria-label="Ganti PIN" title="Ganti PIN (kalau kena spam)">
          <Icon name="refresh" size={15} /> Ganti
        </button>
      </div>
      {shadow && <ShadowPinModal onClose={() => setShadow(false)} />}

      {confirmRotate && (
        <Modal title="Ganti PIN Kambe?" onClose={() => setConfirmRotate(false)}>
          <div className="stack">
            <p className="small" style={{ margin: 0, color: "var(--text-2)" }}>
              PIN lama langsung tidak berlaku, dan semua undangan yang belum kamu terima ikut terhapus. Kontak yang sudah terhubung <strong>tidak</strong> terputus. Berguna kalau PIN Kambe-mu tersebar dan kamu kena spam.
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
    <section className="card" id="invite-card">
      <form className="stack" onSubmit={submit}>
        <label className="contact-field">
          <span>PIN kontak</span>
          <input
            className="input pin"
            value={pin}
            onChange={(e) => {
              setPin(e.target.value.slice(0, 9));
              setError(null);
            }}
            placeholder="Ketik di sini"
            aria-label="PIN tujuan"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
          />
        </label>
        {normalized.length >= 6 && problem && <span className="error">{problem}</span>}
        <input
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
          placeholder="Catatan (opsional)"
          aria-label="Catatan undangan"
        />
        {error && <span className="error" role="alert">{error}</span>}
        <button className="btn primary block pill" disabled={busy || !normalized}>
          {busy ? "…" : "Undang"}
        </button>
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
                  </div>
                </div>
                {r.via && (
                  <div className="tiny" style={{ color: "var(--amber)" }}>
                    <Icon name={r.via.kind === "radar" ? "store" : "clock"} size={12} /> Lewat {r.via.kind === "radar" ? "Radar Arwah" : r.via.kind === "once" ? "PIN sekali pakai" : "PIN Bayang"} {r.via.pin}
                    {r.via.label && (
                      <>
                        {" ("}
                        <SealedText<LabelContent> view={r.via.label} field="text" locked="label terenkripsi" />
                        {")"}
                      </>
                    )}{" "}
                    — dia tidak melihat PIN utamamu
                  </div>
                )}
                {r.note && (
                  <div className="small" style={{ color: "var(--text-2)" }}>
                    <Icon name="lock" size={12} /> “<SealedText<NoteContent> view={r.note} field="text" max={120} locked="catatan tidak bisa dibuka" />”
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

type ChatFilter = "all" | "unread" | "verified" | "review";

function Contacts({ onAddContact }: { onAddContact: () => void }) {
  const [s, m] = useMessenger();
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const unread = s.contacts.filter((c) => c.unread > 0).length;
  const review = s.contacts.filter((c) => s.keyAlerts[c.id]).length;
  const needle = query.trim().toLowerCase();
  const shown = s.contacts.filter((c) => {
    if (needle && !c.alias.toLowerCase().includes(needle)) return false;
    if (filter === "unread") return c.unread > 0;
    if (filter === "verified") return !!s.pins[c.id]?.verified && !s.keyAlerts[c.id];
    if (filter === "review") return !!s.keyAlerts[c.id];
    return true;
  });
  const chips: [ChatFilter, string][] = [["all", "Semua"], ["unread", unread ? "Belum dibaca (" + unread + ")" : "Belum dibaca"], ["verified", "Terverifikasi"]];
  if (review) chips.push(["review", "Perlu ditinjau (" + review + ")"]);

  return (
    <section className="chats" aria-label="Obrolan terenkripsi">
      <div className="chats-head">
        <h2>Obrolan</h2>
        <span className="grow" />
        <button className={"btn round glass icon " + (searching ? "on" : "")} aria-label="Cari obrolan" aria-pressed={searching} onClick={() => { setSearching((v) => !v); setQuery(""); }}>
          <Icon name="search" size={18} />
        </button>
        <button
          className="btn round glass icon hide-mobile"
          aria-label="Tambah kontak"
          onClick={onAddContact}
        >
          <Icon name="userPlus" size={18} />
        </button>
      </div>
      {searching && <input className="input" autoFocus value={query} maxLength={40} onChange={(e) => setQuery(e.target.value)} placeholder="Cari nama kontak…" aria-label="Cari nama kontak" />}
      <div className="chips" role="group" aria-label="Saring obrolan">
        {chips.map(([k, label]) => (
          <button key={k} className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      {s.contacts.length === 0 ? (
        <div className="empty">
          <div className="icon-wrap">
            <Icon name="userPlus" size={26} />
          </div>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <div className="small">Tidak ada obrolan yang cocok.</div>
        </div>
      ) : (
        <div className="list">
          {shown.map((c) => {
            const pin = s.pins[c.id];
            const alert = !!s.keyAlerts[c.id];
            return (
              <button key={c.id} className={"item glass-item " + (s.activePeer === c.id ? "active " : "") + (c.unread > 0 ? "unread" : "")} onClick={() => void m.openThread(c.id)} aria-current={s.activePeer === c.id}>
                <Avatar id={c.id} name={c.alias} />
                <div className="grow">
                  <div className="row" style={{ gap: 6 }}>
                    <span className="name truncate">{c.alias}</span>
                    {alert ? (
                      <Icon name="alert" size={14} style={{ color: "var(--warn)" }} aria-label="Safety number berubah" />
                    ) : pin?.verified ? (
                      <Icon name="shieldCheck" size={14} className="verified" aria-label="Terverifikasi" />
                    ) : null}
                  </div>
                  <div className="tiny muted truncate">
                    <SealedText<PmContent> view={c.pm} field="text" empty={"PIN " + c.pin} locked={"PIN " + c.pin} max={80} />
                  </div>
                </div>
                <div className="stack" style={{ gap: 4, alignItems: "flex-end" }}>
                  {c.lastMessageAt && <span className="tiny muted">{timeOf(c.lastMessageAt)}</span>}
                  {c.unread > 0 && <span className="count" aria-label={c.unread + " pesan belum dibaca"}>{c.unread > 99 ? "99+" : c.unread}</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
