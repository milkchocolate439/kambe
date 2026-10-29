// Fase 3 — Jejak (dulu Path Moments): linimasa intim untuk kontak, terenkripsi end-to-end per penerima.
import { useEffect, useState } from "react";
import type { MomentType } from "../../../shared/e2ee.ts";
import { MOMENT_TEXT_MAX, type Reaction } from "../../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import type { MomentView } from "../lib/messenger.ts";
import { Avatar, dayOf, timeOf, useMessenger } from "./common.tsx";
import { Icon } from "./icons.tsx";
import { Logo } from "./Logo.tsx";

const TYPES: Record<MomentType, { emoji: string; label: string; placeholder: string; color: string }> = {
  thought: { emoji: "💭", label: "Pikiran", placeholder: "Apa yang sedang kamu pikirkan?", color: "#6366f1" },
  music: { emoji: "🎵", label: "Musik", placeholder: "Sedang mendengarkan apa?", color: "#e11d48" },
  place: { emoji: "📍", label: "Tempat", placeholder: "Di mana kamu sekarang? (nama tempat, bukan GPS)", color: "#059669" },
  awake: { emoji: "☀️", label: "Bangun", placeholder: "Selamat pagi! (opsional)", color: "#d97706" },
  sleep: { emoji: "🌙", label: "Tidur", placeholder: "Selamat malam! (opsional)", color: "#7c3aed" },
};
const REACTION_EMOJI: Record<Reaction, string> = { smile: "😊", gasp: "😮", love: "❤️" };

export function MomentsView({ onBack }: { onBack: () => void }) {
  const [s, m] = useMessenger();
  const [type, setType] = useState<MomentType>("thought");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recipients = s.contacts.filter((c) => c.publicKey && !s.keyAlerts[c.id]).length;
  const textRequired = type !== "awake" && type !== "sleep";

  useEffect(() => {
    void m.loadMoments().catch((e) => setError(e instanceof ApiError ? e.message : "Gagal memuat jejak"));
  }, [m]);

  async function share() {
    setBusy(true);
    setError(null);
    try {
      const body = text.trim() || (type === "awake" ? "Selamat pagi!" : type === "sleep" ? "Selamat malam!" : "");
      const n = await m.postMoment(type, body);
      setText("");
      m.toast(n ? `Jejak dibagikan terenkripsi ke ${n} kontak` : "Jejak disimpan (belum ada kontak yang menerima)", "ok");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Gagal membagikan jejak");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="main">
      <header className="chat-head">
        <button className="btn ghost icon only-mobile" onClick={onBack} aria-label="Kembali">
          <Icon name="back" />
        </button>
        <Logo size={38} />
        <div className="grow">
          <strong>Jejak</strong>
          <div className="tiny muted">Hanya untuk kontakmu · terenkripsi per kontak · hilang setelah 30 hari</div>
        </div>
      </header>

      <div className="messages" style={{ gap: 14 }}>
        <section className="card stack" style={{ gap: 10 }}>
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }} role="radiogroup" aria-label="Jenis jejak">
            {(Object.keys(TYPES) as MomentType[]).map((t) => (
              <button key={t} role="radio" aria-checked={type === t} className={`btn small ${type === t ? "primary" : ""}`} onClick={() => setType(t)}>
                {TYPES[t].emoji} {TYPES[t].label}
              </button>
            ))}
          </div>
          <textarea className="textarea" rows={2} maxLength={MOMENT_TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)} placeholder={TYPES[type].placeholder} aria-label="Isi jejak" />
          <div className="row">
            <span className="tiny muted grow">
              <Icon name="lock" size={12} /> Dikirim ke {recipients} kontak, dienkripsi satu per satu.
            </span>
            <button className="btn primary" disabled={busy || (textRequired && !text.trim())} onClick={() => void share()}>
              {busy ? "Mengenkripsi…" : "Bagikan"}
            </button>
          </div>
          {error && <span className="error" role="alert">{error}</span>}
        </section>

        {s.moments === null ? (
          <div className="hint" style={{ textAlign: "center" }}>Memuat & mendekripsi…</div>
        ) : s.moments.length === 0 ? (
          <div className="empty">
            <div className="icon-wrap">
              <Icon name="planet" size={26} />
            </div>
            <div className="small">Belum ada jejak. Tinggalkan yang pertama — hanya kontakmu yang bisa melihatnya.</div>
          </div>
        ) : (
          <div className="timeline">
            {s.moments.map((mo, i) => {
              const prev = s.moments![i - 1];
              return (
                <div key={mo.id}>
                  {(!prev || dayOf(prev.createdAt) !== dayOf(mo.createdAt)) && <div className="day" style={{ marginLeft: -6 }}>{dayOf(mo.createdAt)}</div>}
                  <MomentItem mo={mo} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function MomentItem({ mo }: { mo: MomentView }) {
  const [, m] = useMessenger();
  const t = TYPES[mo.type];
  const react = (r: Reaction) => void m.reactMoment(mo.id, mo.myReaction === r ? null : r).catch(() => m.toast("Gagal bereaksi", "danger"));

  return (
    <article className="moment">
      <span className="moment-dot" style={{ background: mo.state === "ok" ? t.color : "var(--line-2)" }} aria-hidden="true">
        {mo.state === "ok" ? t.emoji : "🔒"}
      </span>
      <div className="row" style={{ gap: 8 }}>
        <Avatar id={mo.authorId} name={mo.authorAlias} size={30} />
        <strong className="grow truncate">{mo.mine ? "Kamu" : mo.authorAlias}</strong>
        <span className="tiny muted">{timeOf(mo.createdAt)}</span>
      </div>
      {mo.state === "ok" ? (
        <p style={{ margin: "8px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          <span className="tiny muted" style={{ fontWeight: 700 }}>{t.label.toUpperCase()} · </span>
          {mo.text}
        </p>
      ) : (
        <p className="small muted" style={{ margin: "8px 0 0", fontStyle: "italic" }}>
          {mo.state === "locked" ? "Dienkripsi untuk perangkat lain — tidak bisa dibuka di sini." : "Jejak ini rusak atau diubah di jalan."}
        </p>
      )}
      {mo.untrusted && (
        <div className="scam">
          <Icon name="alert" size={13} /> Dikirim dengan kunci yang belum kamu akui. Verifikasi safety number.
        </div>
      )}
      <div className="row" style={{ marginTop: 8, gap: 6 }}>
        {(Object.keys(REACTION_EMOJI) as Reaction[]).map((r) => (
          <button
            key={r}
            className={`btn small ${mo.myReaction === r ? "primary" : "ghost"}`}
            style={{ minHeight: 30, padding: "0 8px" }}
            onClick={() => react(r)}
            aria-pressed={mo.myReaction === r}
            aria-label={`Reaksi ${REACTION_EMOJI[r]} (${mo.reactions[r]})`}
            disabled={mo.mine}
          >
            {REACTION_EMOJI[r]} <span className="tiny">{mo.reactions[r]}</span>
          </button>
        ))}
        <span className="grow" />
        {mo.mine && (
          <button className="btn ghost icon" style={{ width: 32, minHeight: 32 }} aria-label="Hapus jejak" onClick={() => void m.deleteMoment(mo.id).then(() => m.toast("Jejak dihapus", "ok"))}>
            <Icon name="trash" size={15} />
          </button>
        )}
      </div>
    </article>
  );
}
