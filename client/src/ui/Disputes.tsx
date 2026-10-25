// Fase 3 — bukti kirim, sengketa, pernyataan untuk moderator, dan panel moderator.
import { useEffect, useState } from "react";
import {
  COURIERS,
  DISPUTE_REASONS,
  NO_TRACKING_COURIERS,
  RESOLUTION_REASON_MIN,
  SHIP_NOTE_MAX,
  STATEMENT_MAX,
  STATEMENTS_PER_PARTY,
  TRACKING_RE,
  type Deal,
  type DisputeReason,
  type ModDispute,
} from "../../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { copyText, Modal, timeOf, useMessenger } from "./common.tsx";
import { Icon } from "./icons.tsx";

const rupiah = (n: number) => "Rp" + n.toLocaleString("id-ID");
const when = (ts: number) => `${new Date(ts).toLocaleDateString("id-ID", { day: "numeric", month: "short" })} ${timeOf(ts)}`;

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Gagal. Coba lagi.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

// ------------------------------------------------------------ bukti kirim ---

export function ShipModal({ deal, peer, onClose }: { deal: Deal; peer: string; onClose: () => void }) {
  const [, m] = useMessenger();
  const [courier, setCourier] = useState<string>(COURIERS[0]);
  const [tracking, setTracking] = useState("");
  const [note, setNote] = useState("");
  const { busy, error, run } = useBusy();
  const noTracking = NO_TRACKING_COURIERS.includes(courier);
  const problem = noTracking
    ? note.trim().length < 10
      ? "Jelaskan cara penyerahan (min. 10 karakter)"
      : null
    : !TRACKING_RE.test(tracking.trim())
      ? "Nomor resi 6–40 huruf/angka"
      : null;

  async function submit() {
    if (await run(() => m.dealAction(peer, deal.id, "ship", { courier, tracking: tracking.trim(), note: note.trim() }))) {
      m.toast("Ditandai dikirim. Bukti kirim tersimpan untuk pembeli & moderator.", "ok");
      onClose();
    }
  }

  return (
    <Modal title="Tandai sudah dikirim" onClose={onClose}>
      <div className="stack">
        <p className="small" style={{ margin: 0, color: "var(--text-2)" }}>
          Bukti kirim melindungimu bila pembeli mengajukan sengketa. Pembeli punya 7 hari untuk konfirmasi atau sengketa; setelah itu dana cair otomatis.
        </p>
        <div className="field">
          <label htmlFor="ship-courier">Kurir / cara penyerahan</label>
          <select id="ship-courier" className="input" value={courier} onChange={(e) => setCourier(e.target.value)}>
            {COURIERS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        {!noTracking && (
          <div className="field">
            <label htmlFor="ship-tracking">Nomor resi</label>
            <input id="ship-tracking" className="input mono" autoCapitalize="characters" spellCheck={false} maxLength={40} value={tracking} onChange={(e) => setTracking(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="ship-note">{noTracking ? "Keterangan serah terima" : "Catatan (opsional)"}</label>
          <textarea
            id="ship-note"
            className="textarea"
            rows={2}
            maxLength={SHIP_NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={noTracking ? "mis. diserahkan langsung di Pasar Besar, 26 Okt 10.00" : "mis. dikemas kayu, 2 koli"}
          />
        </div>
        {problem && (tracking || note) && <span className="hint">{problem}</span>}
        {error && <span className="error" role="alert">{error}</span>}
        <div className="row">
          <button className="btn grow" onClick={onClose}>Batal</button>
          <button className="btn primary grow" disabled={busy || !!problem} onClick={() => void submit()}>
            {busy ? "Menyimpan…" : "Tandai dikirim"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function ShipmentInfo({ deal }: { deal: Deal }) {
  const [, m] = useMessenger();
  if (!deal.shipment) return null;
  const s = deal.shipment;
  return (
    <div className="tiny" style={{ color: "var(--text-2)" }}>
      <Icon name="send" size={12} /> {s.courier}
      {s.tracking && (
        <>
          {" · Resi "}
          <button className="mono" style={{ background: "none", border: 0, padding: 0, color: "var(--brand-2)", fontWeight: 700 }} onClick={async () => (await copyText(s.tracking!)) && m.toast("Nomor resi disalin", "ok")} title="Salin resi">
            {s.tracking}
          </button>
        </>
      )}
      {s.note && <div style={{ whiteSpace: "pre-wrap" }}>“{s.note}”</div>}
    </div>
  );
}

// -------------------------------------------------------------- sengketa ---

export function DisputeModal({ deal, peer, onClose }: { deal: Deal; peer: string; onClose: () => void }) {
  const [, m] = useMessenger();
  const [reason, setReason] = useState<DisputeReason>("not_received");
  const [text, setText] = useState("");
  const { busy, error, run } = useBusy();

  async function submit() {
    if (await run(() => m.dealAction(peer, deal.id, "dispute", { reason, text: text.trim() }))) {
      m.toast("Sengketa diajukan. Dana tetap ditahan sampai ada penyelesaian.", "ok");
      onClose();
    }
  }

  return (
    <Modal title="Ajukan sengketa" onClose={onClose}>
      <div className="stack">
        <p className="small" style={{ margin: 0, color: "var(--text-2)" }}>
          Pencairan otomatis dihentikan. Penjual bisa mengembalikan dana, kamu bisa menerima barang, atau moderator memutus. Bila tidak selesai dalam 14 hari, dana kembali kepadamu.
        </p>
        <div className="field">
          <label htmlFor="dispute-reason">Alasan</label>
          <select id="dispute-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value as DisputeReason)}>
            {Object.entries(DISPUTE_REASONS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="dispute-text">Ceritakan masalahnya</label>
          <textarea id="dispute-text" className="textarea" rows={4} maxLength={STATEMENT_MAX} value={text} onChange={(e) => setText(e.target.value)} placeholder="Apa yang terjadi? Sebutkan bukti yang kamu punya (foto, resi, waktu)." />
          <span className="hint">
            <Icon name="alert" size={12} /> Cerita ini dibaca <strong>moderator</strong> dan penjual — tidak terenkripsi end-to-end. Jangan tulis data pribadi yang tidak perlu.
          </span>
        </div>
        {error && <span className="error" role="alert">{error}</span>}
        <div className="row">
          <button className="btn grow" onClick={onClose}>Batal</button>
          <button className="btn danger grow" disabled={busy || text.trim().length < 10} onClick={() => void submit()}>
            {busy ? "Mengajukan…" : "Ajukan sengketa"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Pernyataan kedua pihak + kolom menambah pernyataan (selama sengketa berjalan). */
export function DisputeThread({ deal, peer, myRole }: { deal: Deal; peer: string; myRole: "buyer" | "seller" }) {
  const [, m] = useMessenger();
  const [text, setText] = useState("");
  const { busy, error, run } = useBusy();
  const mine = deal.statements.filter((s) => s.role === myRole).length;
  if (!deal.statements.length && deal.status !== "DISPUTED") return null;

  return (
    <div className="stack" style={{ gap: 6 }}>
      {deal.disputeReason && (
        <div className="tiny" style={{ fontWeight: 700 }}>
          Alasan sengketa: {DISPUTE_REASONS[deal.disputeReason]}
        </div>
      )}
      {deal.statements.map((s, i) => (
        <div key={i} className="tiny" style={{ padding: "6px 8px", borderRadius: 8, background: "var(--bg-2)", whiteSpace: "pre-wrap" }}>
          <strong>{s.role === myRole ? "Kamu" : s.role === "buyer" ? "Pembeli" : "Penjual"}</strong> · {when(s.createdAt)}
          <div>{s.text}</div>
        </div>
      ))}
      {deal.status === "DISPUTED" && mine < STATEMENTS_PER_PARTY && (
        <div className="row" style={{ alignItems: "flex-end" }}>
          <textarea className="textarea grow" rows={1} maxLength={STATEMENT_MAX} value={text} onChange={(e) => setText(e.target.value)} placeholder="Tambah pernyataan untuk moderator…" aria-label="Pernyataan untuk moderator" />
          <button
            className="btn small"
            disabled={busy || text.trim().length < 5}
            onClick={async () => {
              if (await run(() => m.addStatement(peer, deal.id, text.trim()))) setText("");
            }}
          >
            Kirim
          </button>
        </div>
      )}
      {deal.status === "DISPUTED" && <span className="tiny muted">Pernyataan dibaca moderator (tidak terenkripsi end-to-end). Sisa {STATEMENTS_PER_PARTY - mine} pernyataan.</span>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

export function ResolutionNote({ deal }: { deal: Deal }) {
  if (!deal.resolution) return null;
  return (
    <div className="tiny" style={{ padding: "8px 10px", borderRadius: 10, background: "color-mix(in srgb, var(--brand) 12%, transparent)" }}>
      <strong>
        <Icon name="shieldCheck" size={12} /> Putusan: {deal.resolution.decision === "refund" ? "dana dikembalikan ke pembeli" : "dana dicairkan ke penjual"}
      </strong>
      <div style={{ whiteSpace: "pre-wrap" }}>{deal.resolution.reason}</div>
    </div>
  );
}

// ------------------------------------------------------- panel moderator ---

export function ModModal({ onClose }: { onClose: () => void }) {
  const [s, m] = useMessenger();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    m.loadModQueue().catch((e) => setError(e instanceof ApiError ? e.message : "Gagal memuat antrean"));
  }, [m]);
  const q = s.modQueue;

  return (
    <Modal title="Moderasi sengketa" onClose={onClose}>
      <div className="stack">
        <p className="small" style={{ margin: 0, color: "var(--text-2)" }}>
          Kamu hanya melihat data kesepakatan, bukti kirim, dan pernyataan yang sengaja dikirim para pihak — <strong>bukan isi chat</strong> (terenkripsi end-to-end). Setiap putusan tercatat dan alasannya dibaca kedua pihak.
        </p>
        {error && <span className="error">{error}</span>}
        {!q ? (
          <div className="hint">Memuat…</div>
        ) : q.open.length === 0 ? (
          <div className="empty">
            <div className="icon-wrap">
              <Icon name="shieldCheck" size={26} />
            </div>
            <div className="small">Tidak ada sengketa terbuka.</div>
          </div>
        ) : (
          q.open.map((item) => <ModCase key={item.deal.id} item={item} />)
        )}
        {q && q.resolved.length > 0 && (
          <>
            <div className="divider" />
            <div className="tiny muted" style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>Putusan terakhir</div>
            {q.resolved.slice(0, 8).map((item) => (
              <div key={item.deal.id} className="row tiny">
                <span className="grow truncate">{item.deal.title}</span>
                <span className={`badge ${item.deal.resolution?.decision === "refund" ? "warn" : "ok"}`}>{item.deal.resolution?.decision === "refund" ? "Refund" : "Cair"}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}

function ModCase({ item }: { item: ModDispute }) {
  const [, m] = useMessenger();
  const [decision, setDecision] = useState<"refund" | "release" | null>(null);
  const [reason, setReason] = useState("");
  const { busy, error, run } = useBusy();
  const d = item.deal;

  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="row">
        <strong className="grow">{d.title}</strong>
        <span className="mono">{rupiah(d.price)}</span>
      </div>
      <div className="tiny muted">
        Pembeli <strong>{item.buyer.alias}</strong> · Penjual <strong>{item.seller.alias}</strong>
        <br />
        Dibayar {d.paidAt ? when(d.paidAt) : "—"} · Dikirim {d.shippedAt ? when(d.shippedAt) : "belum"}
        {d.autoRefundAt && ` · refund otomatis ${when(d.autoRefundAt)}`}
      </div>
      <ShipmentInfo deal={d} />
      {d.disputeReason && <div className="tiny" style={{ fontWeight: 700 }}>Alasan: {DISPUTE_REASONS[d.disputeReason]}</div>}
      {d.statements.map((s, i) => (
        <div key={i} className="tiny" style={{ padding: "6px 8px", borderRadius: 8, background: "var(--bg-2)", whiteSpace: "pre-wrap" }}>
          <strong>{s.role === "buyer" ? `Pembeli (${item.buyer.alias})` : `Penjual (${item.seller.alias})`}</strong> · {when(s.createdAt)}
          <div>{s.text}</div>
        </div>
      ))}
      {decision ? (
        <div className="stack" style={{ gap: 6 }}>
          <label className="small" htmlFor={`reason-${d.id}`} style={{ fontWeight: 700 }}>
            {decision === "refund" ? "Kembalikan dana ke pembeli" : "Cairkan dana ke penjual"} — alasan (dibaca kedua pihak)
          </label>
          <textarea id={`reason-${d.id}`} className="textarea" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          {error && <span className="error">{error}</span>}
          <div className="row">
            <button className="btn grow" onClick={() => setDecision(null)}>Batal</button>
            <button
              className={`btn grow ${decision === "refund" ? "danger" : "primary"}`}
              disabled={busy || reason.trim().length < RESOLUTION_REASON_MIN}
              onClick={async () => {
                if (await run(() => m.resolveDispute(d.id, decision, reason.trim()))) m.toast("Putusan tersimpan", "ok");
              }}
            >
              {busy ? "Menyimpan…" : "Putuskan (final)"}
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button className="btn small danger grow" onClick={() => setDecision("refund")}>Refund ke pembeli</button>
          <button className="btn small primary grow" onClick={() => setDecision("release")}>Cairkan ke penjual</button>
        </div>
      )}
    </div>
  );
}
