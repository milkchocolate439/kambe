import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ChatMessage } from "../lib/messenger.ts";
import { ApiError } from "../lib/api.ts";
import { Avatar, dayOf, Modal, timeOf, useMessenger } from "./common.tsx";
import { CatalogModal, DealCard, OfferModal, StoreModal } from "./Commerce.tsx";
import { Icon } from "./icons.tsx";
import type { Deal } from "../../../shared/protocol.ts";

type TimelineItem = { t: "msg"; at: number; msg: ChatMessage } | { t: "deal"; at: number; deal: Deal };

const MAX_CHARS = 4000;

// Panel emoji tema "The Mask" — daftar favorit statis, tanpa pustaka emoji eksternal.
const EMOJI_FAVORITES = ["😍", "💕", "😊", "🎉", "🎇", "😜", "👏", "🎶", "😎", "🤢", "👀", "✔️", "🎁", "💖", "🙌", "😂", "🙏", "👍", "❤️", "🔥", "😭", "🤝", "🔒", "🤫"];

// Deteksi pola penipuan umum — berjalan HANYA di perangkat, setelah pesan didekripsi.
const SCAM_PATTERNS: [RegExp, string][] = [
  [/\b(otp|kode\s*(verifikasi|otp|aktivasi)|pin\s*atm|cvv)\b/i, "Jangan pernah membagikan OTP, PIN ATM, atau kode verifikasi kepada siapa pun."],
  [/\b(transfer|tf)\b.{0,40}\b(dulu|langsung|di\s*luar|rekening\s*pribadi)\b|\brekening\s*pribadi\b/i, "Hati-hati diminta transfer langsung ke rekening pribadi. Penipu sering memakai cara ini."],
  [/\b(bit\.ly|tinyurl\.com|s\.id|wa\.me|t\.me)\//i, "Pesan ini berisi tautan pendek/eksternal. Periksa dulu sebelum membukanya."],
  [/\.(apk|exe|scr|bat)\b/i, "Jangan pasang file aplikasi (.apk/.exe) dari orang yang belum kamu kenal."],
];

function scamWarning(text: string): string | null {
  for (const [re, msg] of SCAM_PATTERNS) if (re.test(text)) return msg;
  return null;
}

export function Chat() {
  const [s, m] = useMessenger();
  const peer = s.activePeer;
  const contact = peer ? s.contacts.find((c) => c.id === peer) : undefined;
  const thread = peer ? s.threads[peer] : undefined;
  const [text, setText] = useState("");
  const [safety, setSafety] = useState(false);
  const [menu, setMenu] = useState<null | "menu" | "remove" | "block">(null);
  const [shop, setShop] = useState<null | "catalog" | "offer" | "upgrade">(null);
  const [shake, setShake] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    setText("");
    setEmoji(false);
  }, [peer]);

  // PING!!! dari kontak yang sedang dibuka → layar bergetar.
  useEffect(() => {
    if (!s.ping || s.ping.peer !== peer || Date.now() - s.ping.at > 2000) return;
    setShake(true);
    const t = setTimeout(() => setShake(false), 550);
    return () => clearTimeout(t);
  }, [s.ping, peer]);

  // Gulir otomatis ke bawah hanya kalau pengguna memang sedang di bawah.
  const deals = peer ? s.deals[peer] : undefined;
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [thread?.messages.length, deals?.length, peer]);

  if (!peer || !contact) {
    return (
      <div className="main">
        <div className="empty" style={{ margin: "auto" }}>
          <div className="icon-wrap">
            <Icon name="shieldCheck" size={28} />
          </div>
          <h2 style={{ margin: "0 0 6px", fontSize: 18, color: "var(--text)" }}>Pilih obrolan</h2>
          <div className="small" style={{ maxWidth: 360 }}>
            Setiap pesan dikunci di perangkatmu dengan enkripsi end-to-end. Server PINPath hanya meneruskan data acak yang tidak bisa dibaca siapa pun.
          </div>
        </div>
      </div>
    );
  }

  const pin = s.pins[peer];
  const keyAlert = s.keyAlerts[peer];
  const blocker = m.sendBlocker(peer);
  // Pesan E2EE dan kartu kesepakatan digabung menjadi satu linimasa berdasarkan waktu.
  const timeline: TimelineItem[] = [
    ...(thread?.messages ?? []).map((msg): TimelineItem => ({ t: "msg", at: msg.createdAt, msg })),
    ...(deals ?? []).map((deal): TimelineItem => ({ t: "deal", at: deal.createdAt, deal })),
  ].sort((a, b) => a.at - b.at);

  async function send() {
    const body = text.trim();
    if (!body || body.length > MAX_CHARS || !peer) return;
    stick.current = true;
    if (await m.send(peer, { kind: "text", text: body })) {
      setText("");
      if (inputRef.current) inputRef.current.style.height = "auto";
    }
    inputRef.current?.focus();
  }

  // Sisipkan emoji di posisi kursor (bukan selalu di akhir), lalu kembalikan fokus ke kotak ketik
  function insertEmoji(e: string) {
    const el = inputRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText((text.slice(0, start) + e + text.slice(end)).slice(0, MAX_CHARS + 200));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + e.length, start + e.length);
    });
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && emoji) {
      setEmoji(false);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && matchMedia("(pointer: fine)").matches) {
      e.preventDefault();
      void send();
    }
  }

  async function confirmAction(kind: "remove" | "block") {
    try {
      if (kind === "remove") await m.removeContact(peer!);
      else await m.block(peer!);
      m.toast(kind === "remove" ? `${contact!.alias} dihapus dari kontak` : `${contact!.alias} diblokir`, "ok");
    } catch (e) {
      m.toast(e instanceof ApiError ? e.message : "Gagal", "danger");
    }
    setMenu(null);
  }

  return (
    <div className={`main ${shake ? "shake" : ""}`}>
      <header className="chat-head">
        <button className="btn ghost icon only-mobile" onClick={() => void m.openThread(null)} aria-label="Kembali ke daftar">
          <Icon name="back" />
        </button>
        <Avatar id={contact.id} name={contact.alias} />
        <div className="grow">
          <div className="row" style={{ gap: 6 }}>
            <strong className="truncate">{contact.alias}</strong>
            <span className="badge pin hide-mobile">{contact.pin}</span>
          </div>
          <button className="verify-link" style={{ color: keyAlert ? "var(--warn)" : pin?.verified ? "var(--ok)" : "var(--muted)" }} onClick={() => setSafety(true)}>
            <Icon name={keyAlert ? "alert" : pin?.verified ? "shieldCheck" : "lock"} size={13} style={{ flexShrink: 0 }} />
            <span>{keyAlert ? "Safety number berubah — tinjau" : pin?.verified ? "Terenkripsi · terverifikasi" : "Terenkripsi · ketuk untuk verifikasi"}</span>
          </button>
        </div>
        <button className="btn ghost icon" onClick={() => setShop("catalog")} aria-label={`Etalase ${contact.alias}`} title="Lihat etalase">
          <Icon name="store" />
        </button>
        <button className="btn ping small" onClick={() => void m.send(peer, { kind: "ping" })} disabled={!!blocker} title="Getarkan layar lawan bicara (maks. 30 detik sekali)">
          <Icon name="vibrate" size={15} /> PING!!!
        </button>
        <button className="btn ghost icon" onClick={() => setMenu("menu")} aria-label="Menu kontak">
          <Icon name="more" />
        </button>
      </header>

      {keyAlert && (
        <div className="banner warn" role="alert">
          <Icon name="alert" />
          <div className="grow">
            <strong>Safety number dengan {contact.alias} berubah.</strong>
            <div className="small">Biasanya karena dia ganti/instal ulang perangkat. Tapi bisa juga tanda ada pihak yang menyusup. Kalau ragu, cocokkan safety number lewat jalur lain (tatap muka/telepon) sebelum lanjut.</div>
            <div className="actions">
              <button className="btn small" onClick={() => setSafety(true)}>Lihat safety number</button>
              <button className="btn small primary" onClick={() => void m.acknowledgeKeyChange(peer)}>Saya mengerti, lanjutkan</button>
            </div>
          </div>
        </div>
      )}

      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        aria-live="polite"
        aria-label={`Percakapan dengan ${contact.alias}`}
      >
        {thread?.loading && !thread.loaded && <div className="day">Memuat & mendekripsi…</div>}
        {thread?.loaded && timeline.length === 0 && (
          <div className="empty" style={{ margin: "auto" }}>
            <div className="icon-wrap">
              <Icon name="lock" size={26} />
            </div>
            <div className="small" style={{ maxWidth: 340 }}>
              Kamu terhubung dengan <strong>{contact.alias}</strong>. Pesan di sini terenkripsi end-to-end.
              <br />
              <br />
              <Icon name="alert" size={13} /> Untuk transaksi dengan orang asing, jangan transfer di luar sistem dan jangan bagikan OTP.
            </div>
          </div>
        )}
        {timeline.map((item, i) => {
          const prev = timeline[i - 1];
          const newDay = !prev || dayOf(prev.at) !== dayOf(item.at);
          return (
            <Fragment key={item.t === "msg" ? item.msg.id : `deal-${item.deal.id}`}>
              {newDay && <div className="day">{dayOf(item.at)}</div>}
              {item.t === "msg" ? (
                <Bubble msg={item.msg} peerAlias={contact.alias} onRetry={() => m.retry(peer, item.msg.id)} />
              ) : (
                <DealCard deal={item.deal} peer={peer} peerAlias={contact.alias} />
              )}
            </Fragment>
          );
        })}
      </div>

      {blocker && !keyAlert ? (
        <div className="banner info">
          <Icon name="lock" />
          <span className="small">{blocker}</span>
        </div>
      ) : null}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <button
          type="button"
          className="btn icon"
          style={{ color: "var(--amber)" }}
          onClick={() => setShop(s.pro?.active ? "offer" : "upgrade")}
          disabled={!!blocker}
          aria-label="Tawarkan kesepakatan rekber"
          title="Tawarkan kesepakatan rekber (PRO)"
        >
          <Icon name="handshake" />
        </button>
        <button
          type="button"
          className={`btn icon ${emoji ? "on" : ""}`}
          onClick={() => setEmoji((v) => !v)}
          disabled={!!blocker}
          aria-label="Emoji"
          aria-expanded={emoji}
          aria-controls="emoji-panel"
          title="Emoji"
        >
          <Icon name="smile" />
        </button>
        {emoji && !blocker && (
          <div className="emoji-panel" id="emoji-panel" role="group" aria-label="Emoji favorit">
            <div className="emoji-head">Favorit</div>
            <div className="emoji-grid">
              {EMOJI_FAVORITES.map((e) => (
                <button key={e} type="button" className="emoji-btn" onClick={() => insertEmoji(e)} aria-label={`Sisipkan ${e}`}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="grow stack" style={{ gap: 4 }}>
          <textarea
            ref={inputRef}
            className="textarea"
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(160, e.target.scrollHeight)}px`;
            }}
            onKeyDown={onKey}
            placeholder={blocker ? "Belum bisa mengirim" : "Tulis pesan terenkripsi…"}
            aria-label="Tulis pesan"
            disabled={!!blocker}
            maxLength={MAX_CHARS + 200}
          />
          {text.length > MAX_CHARS - 300 && (
            <span className={text.length > MAX_CHARS ? "error" : "hint"}>
              {text.length}/{MAX_CHARS}
            </span>
          )}
        </div>
        <button className="btn primary icon" disabled={!!blocker || !text.trim() || text.length > MAX_CHARS} aria-label="Kirim">
          <Icon name="send" />
        </button>
      </form>

      {safety && <SafetyModal peer={peer} onClose={() => setSafety(false)} />}
      {shop === "catalog" && <CatalogModal peer={peer} peerAlias={contact.alias} onClose={() => setShop(null)} />}
      {shop === "offer" && <OfferModal peer={peer} peerAlias={contact.alias} onClose={() => setShop(null)} />}
      {shop === "upgrade" && <StoreModal initial="pro" onClose={() => setShop(null)} />}

      {menu === "menu" && (
        <Modal title={contact.alias} onClose={() => setMenu(null)}>
          <div className="stack">
            <div className="row small muted">
              PIN <span className="badge pin">{contact.pin}</span>
            </div>
            <button className="btn block" onClick={() => { setMenu(null); setSafety(true); }}>
              <Icon name="shieldCheck" /> Verifikasi safety number
            </button>
            <button className="btn block" onClick={() => setMenu("remove")}>
              <Icon name="trash" /> Hapus kontak
            </button>
            <button className="btn danger block" onClick={() => setMenu("block")}>
              <Icon name="ban" /> Blokir {contact.alias}
            </button>
          </div>
        </Modal>
      )}
      {(menu === "remove" || menu === "block") && (
        <Modal title={menu === "block" ? `Blokir ${contact.alias}?` : `Hapus ${contact.alias}?`} onClose={() => setMenu(null)}>
          <div className="stack">
            <p className="small" style={{ margin: 0, color: "var(--text-2)" }}>
              {menu === "block"
                ? "Kontak diputus dan dia tidak bisa mengirim pesan atau undangan lagi. Dia tidak diberi tahu bahwa kamu memblokirnya. Bisa dibuka lagi di Pengaturan."
                : "Kontak diputus dari kedua sisi. Kalian bisa terhubung lagi lewat undangan PIN."}
            </p>
            <div className="row">
              <button className="btn grow" onClick={() => setMenu(null)}>Batal</button>
              <button className="btn danger grow" onClick={() => void confirmAction(menu)}>
                {menu === "block" ? "Blokir" : "Hapus"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Bubble({ msg, peerAlias, onRetry }: { msg: ChatMessage; peerAlias: string; onRetry: () => void }) {
  if (msg.kind === "ping") {
    return (
      <div className="ping-pill">
        <Icon name="vibrate" size={14} /> {msg.mine ? "KAMU MENGIRIM PING!!!" : `${peerAlias.toUpperCase()} MENGIRIM PING!!!`}
        <span className="tiny" style={{ fontWeight: 500, letterSpacing: 0 }}>{timeOf(msg.createdAt)}</span>
      </div>
    );
  }
  const special = msg.kind === "locked" || msg.kind === "broken";
  const warn = !msg.mine && msg.kind === "text" ? scamWarning(msg.text) : null;
  return (
    <div className={`bubble-row ${msg.mine ? "mine" : ""}`}>
      <div className={`bubble ${special ? "special" : ""} ${msg.kind === "identity" ? "identity" : ""} ${msg.status === "failed" ? "failed" : ""}`}>
        {msg.kind === "identity" && (
          <div className="identity-head">
            <Icon name="idcard" size={13} /> IDENTITAS · TERENKRIPSI E2EE
          </div>
        )}
        {msg.kind === "locked" && (
          <span className="row" style={{ gap: 6 }}>
            <Icon name="lock" size={14} /> Dienkripsi untuk perangkat lain — tidak bisa dibuka di sini.
          </span>
        )}
        {msg.kind === "broken" && (
          <span className="row" style={{ gap: 6, color: "var(--danger)" }}>
            <Icon name="alert" size={14} /> {msg.error ?? "Pesan rusak atau diubah di jalan."}
          </span>
        )}
        {(msg.kind === "text" || msg.kind === "identity") && msg.text}
        {msg.kind === "identity" && !msg.mine && (
          <div className="scam">
            <Icon name="shield" size={13} /> Data pribadi {peerAlias}. Gunakan hanya untuk transaksi ini dan jangan disebarkan.
          </div>
        )}
        {msg.untrusted && (
          <div className="scam">
            <Icon name="alert" size={13} /> Dikirim dengan kunci yang belum kamu akui. Verifikasi safety number.
          </div>
        )}
        {warn && (
          <div className="scam">
            <Icon name="alert" size={13} /> {warn}
          </div>
        )}
        <div className="meta">
          <span>{timeOf(msg.createdAt)}</span>
          {msg.mine && <StatusMark msg={msg} onRetry={onRetry} />}
        </div>
      </div>
    </div>
  );
}

function StatusMark({ msg, onRetry }: { msg: ChatMessage; onRetry: () => void }) {
  if (msg.status === "pending") return <Icon name="clock" size={12} aria-label="Mengirim" />;
  if (msg.status === "failed") {
    return (
      <button className="status failed" style={{ border: 0 }} onClick={onRetry} title={msg.error ?? "Gagal terkirim"}>
        ! Ulangi
      </button>
    );
  }
  const label = { S: "Terkirim ke server", D: "Diterima perangkat lawan (Delivered)", R: "Sudah dibaca (Read)", X: "Kedaluwarsa: tidak terkirim dalam 30 hari" }[msg.status];
  return (
    <span className={`status ${msg.status}`} title={label} aria-label={label}>
      {msg.status === "S" ? "✓" : msg.status === "X" ? "⌛" : msg.status}
    </span>
  );
}

function SafetyModal({ peer, onClose }: { peer: string; onClose: () => void }) {
  const [s, m] = useMessenger();
  const [number, setNumber] = useState<string | null>(null);
  const contact = s.contacts.find((c) => c.id === peer);
  const pin = s.pins[peer];
  const keyAlert = s.keyAlerts[peer];

  useEffect(() => {
    void m.safetyNumberFor(peer).then(setNumber);
  }, [m, peer, contact?.publicKey]);

  if (!contact) return null;
  return (
    <Modal title="Safety number" onClose={onClose}>
      <div className="stack">
        <p className="small" style={{ margin: 0, color: "var(--text-2)" }}>
          Bandingkan 60 angka ini dengan yang tampil di HP <strong>{contact.alias}</strong> — sebaiknya tatap muka atau lewat telepon. Kalau sama persis, tidak ada pihak ketiga yang menyusup di antara kalian.
        </p>
        {number ? (
          <div className="safety-grid" aria-label="Angka safety number">
            {number.split(" ").map((g, i) => (
              <span key={i}>{g}</span>
            ))}
          </div>
        ) : (
          <div className="hint">Menghitung…</div>
        )}
        {keyAlert && <div className="badge warn" style={{ alignSelf: "flex-start" }}>Angka ini baru — kunci {contact.alias} berubah</div>}
        {pin?.verified && !keyAlert ? (
          <>
            <div className="badge ok" style={{ alignSelf: "flex-start" }}>
              <Icon name="shieldCheck" size={13} /> Sudah kamu verifikasi
            </div>
            <button className="btn block" onClick={() => void m.setVerified(peer, false)}>Hapus tanda verifikasi</button>
          </>
        ) : (
          <button
            className="btn primary block"
            disabled={!number}
            onClick={async () => {
              if (keyAlert) await m.acknowledgeKeyChange(peer);
              await m.setVerified(peer, true);
              m.toast(`${contact.alias} ditandai terverifikasi`, "ok");
              onClose();
            }}
          >
            <Icon name="check" /> Angka cocok — tandai terverifikasi
          </button>
        )}
      </div>
    </Modal>
  );
}
