// Pembayaran LANGSUNG antarpengguna: info rekening/dompet kripto (brankas, E2EE) + "Sudah transfer".
// Prinsip: sesederhana mungkin — satu ketukan untuk mengirim info bayar, satu ketukan untuk menyalin.
import { useEffect, useState } from "react";
import { decodePayInfo, PAY_METHODS_MAX, validatePayMethod, type PayKind, type PayMethod } from "../../../shared/payinfo.ts";
import type { PaymentProofContent } from "../../../shared/protocol.ts";
import { compressImage } from "../lib/image.ts";
import { AttachmentImage } from "./Photo.tsx";
import type { Deal } from "../../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { copyText, Modal, useMessenger, useSealed } from "./common.tsx";
import { Icon } from "./icons.tsx";

const KIND_LABEL: Record<PayKind, string> = { crypto: "Dompet kripto", bank: "Rekening bank" };

function MethodLine({ m }: { m: PayMethod }) {
  return (
    <div className="grow" style={{ minWidth: 0 }}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <strong>{m.provider}</strong>
        {m.kind === "crypto" && <span className="badge ok">Disarankan</span>}
      </div>
      <div className="mono small" style={{ overflowWrap: "anywhere" }}>{m.number}</div>
      {m.holder && <div className="tiny muted">a.n. {m.holder}</div>}
    </div>
  );
}

/** Form tambah info pembayaran (kripto di depan: disarankan). */
function AddMethodForm({ onDone }: { onDone?: (m: PayMethod) => void }) {
  const [, m] = useMessenger();
  const [kind, setKind] = useState<PayKind>("crypto");
  const [provider, setProvider] = useState("");
  const [holder, setHolder] = useState("");
  const [number, setNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const saved = await m.savePayMethod({ kind, provider, holder, number });
      setProvider("");
      setHolder("");
      setNumber("");
      onDone?.(saved);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Gagal menyimpan");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack card">
      <div className="tabs" role="tablist" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 0 }}>
        {(["crypto", "bank"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {kind === "crypto" && (
        <span className="hint">
          <Icon name="alert" size={12} /> Jaringan harus sama.
        </span>
      )}
      <div className="field">
        <label htmlFor="pm-provider">{kind === "bank" ? "Nama bank" : "Aset & jaringan"}</label>
        <input id="pm-provider" className="input" maxLength={40} value={provider} onChange={(e) => setProvider(e.target.value)} placeholder={kind === "bank" ? "mis. BCA" : "mis. USDT · TRC20"} />
      </div>
      <div className="field">
        <label htmlFor="pm-number">{kind === "bank" ? "Nomor rekening" : "Alamat dompet"}</label>
        <input id="pm-number" className="input mono" inputMode={kind === "bank" ? "numeric" : "text"} maxLength={128} value={number} onChange={(e) => setNumber(e.target.value)} autoComplete="off" spellCheck={false} />
      </div>
      <div className="field">
        <label htmlFor="pm-holder">{kind === "bank" ? "Nama pemilik rekening" : "Nama (opsional)"}</label>
        <input id="pm-holder" className="input" maxLength={60} value={holder} onChange={(e) => setHolder(e.target.value)} />
      </div>
      {error && <span className="error" role="alert">{error}</span>}
      <button className="btn primary block" disabled={busy || !provider.trim() || !number.trim()} onClick={() => void save()}>
        <Icon name="plus" size={15} /> Simpan info pembayaran
      </button>
    </div>
  );
}

/** Kelola info pembayaran (tab Dompet). */
export function PayMethodsManager() {
  const [s, m] = useMessenger();
  useEffect(() => {
    void m.loadPayMethods();
  }, [m]);
  const list = s.payMethods;
  return (
    <div className="stack">
      {list === null ? (
        <div className="hint">Memuat…</div>
      ) : list.length === 0 ? (
        <div className="hint">Belum ada info pembayaran.</div>
      ) : (
        <div className="list">
          {list.map((x) => (
            <div key={x.id} className="item" style={{ alignItems: "flex-start", cursor: "default" }}>
              <MethodLine m={x} />
              <button className="btn ghost icon" aria-label={`Hapus ${x.provider}`} onClick={() => void m.removePayMethod(x.id)}>
                <Icon name="trash" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      {(list?.length ?? 0) < PAY_METHODS_MAX && <AddMethodForm />}
    </div>
  );
}

/** Penjual: kirim info pembayaran ke pembeli (satu ketukan). */
export function SendPayInfoModal({ peer, dealId, onClose }: { peer: string; dealId: string; onClose: () => void }) {
  const [s, m] = useMessenger();
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    void m.loadPayMethods().then((l) => setAdding(l.length === 0));
  }, [m]);
  const list = s.payMethods ?? [];

  async function send(id: string) {
    try {
      await m.sharePayInfo(peer, dealId, id);
      m.toast("Rekening terkirim", "ok");
      onClose();
    } catch (e) {
      m.toast(e instanceof ApiError ? e.message : "Gagal mengirim", "danger");
    }
  }

  return (
    <Modal title="Kirim rekening" onClose={onClose}>
      <div className="stack">
        {list.length > 0 && (
          <div className="list" aria-label="Rekening tersimpan">
            {list.map((x) => (
              <div key={x.id} className="item" style={{ alignItems: "center", cursor: "default" }}>
                <MethodLine m={x} />
                <button className="btn primary small" onClick={() => void send(x.id)} aria-label={`Kirim ${x.provider}`}>
                  <Icon name="send" size={14} /> Kirim
                </button>
              </div>
            ))}
          </div>
        )}
        {adding ? (
          <AddMethodForm onDone={() => setAdding(false)} />
        ) : (
          <button className="btn block" onClick={() => setAdding(true)}>
            <Icon name="plus" size={15} /> Tambah info pembayaran
          </button>
        )}
      </div>
    </Modal>
  );
}

/** Isi gelembung "payinfo" di chat: ringkas + tombol salin. */
export function PayInfoCard({ text, mine }: { text: string; mine: boolean }) {
  const [, m] = useMessenger();
  const info = decodePayInfo(text);
  if (!info) return <span className="small">Info pembayaran tidak valid — abaikan.</span>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="identity-head">
        <Icon name="wallet" size={13} /> INFO PEMBAYARAN · TERENKRIPSI
      </div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <strong>{info.provider}</strong>
        {info.kind === "crypto" && <span className="badge ok">Disarankan</span>}
        <span className="tiny muted">{KIND_LABEL[info.kind]}</span>
      </div>
      <div className="row" style={{ gap: 6, alignItems: "center" }}>
        <span className="mono grow" style={{ overflowWrap: "anywhere" }}>{info.number}</span>
        <button
          type="button"
          className="btn small"
          onClick={(e) => {
            e.stopPropagation();
            void copyText(info.number).then((ok) => m.toast(ok ? "Disalin" : "Gagal menyalin", ok ? "ok" : "danger"));
          }}
        >
          <Icon name="copy" size={14} /> Salin
        </button>
      </div>
      {info.holder && <div className="tiny">a.n. {info.holder}</div>}
      {!mine && (
        <div className="scam">
          <Icon name="alert" size={13} />
          {info.kind === "crypto"
            ? "Kirim lewat jaringan yang SAMA persis. Setelah transfer, tekan \"Sudah transfer\" di kartu kesepakatan."
            : "Cocokkan nama pemilik. Setelah transfer, tekan \"Sudah transfer\" di kartu kesepakatan. KAMBE tidak memegang dana."}
        </div>
      )}
    </div>
  );
}

/** Pembeli: form bukti pembayaran + foto bukti (WAJIB) → "Sudah bayar". */
export function PayProofModal({ deal, peer, onClose }: { deal: Deal; peer: string; onClose: () => void }) {
  const [, m] = useMessenger();
  const [method, setMethod] = useState("");
  const [sender, setSender] = useState("");
  const [amount, setAmount] = useState(deal.price);
  const [paidAt, setPaidAt] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  const [ref, setRef] = useState("");
  const [photos, setPhotos] = useState<{ bytes: Uint8Array; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = method.trim().length >= 2 && sender.trim().length >= 2 && amount > 0 && paidAt && ref.trim().length >= 3 && photos.length > 0;

  async function addFiles(files: FileList | null) {
    setError(null);
    for (const f of [...(files ?? [])].slice(0, 3 - photos.length)) {
      try {
        const bytes = await compressImage(f);
        setPhotos((p) => [...p, { bytes, url: URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" })) }].slice(0, 3));
      } catch {
        setError("Foto tidak bisa dibaca");
      }
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const form: Omit<PaymentProofContent, "photos"> = { method, sender, amount, paidAt: paidAt.replace("T", " "), ref, note: "" };
      await m.payWithProof(peer, deal.id, form, photos.map((p) => p.bytes));
      m.toast("Bukti pembayaran terkirim", "ok");
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Gagal mengirim bukti");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Bukti pembayaran" onClose={onClose}>
      <div className="stack">
        <div className="field">
          <label htmlFor="pp-method">Dari bank / dompet</label>
          <input id="pp-method" className="input" maxLength={60} value={method} onChange={(e) => setMethod(e.target.value)} placeholder="BCA · USDT TRC20" />
        </div>
        <div className="field">
          <label htmlFor="pp-sender">Nama pengirim</label>
          <input id="pp-sender" className="input" maxLength={60} value={sender} onChange={(e) => setSender(e.target.value)} />
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <div className="field grow">
            <label htmlFor="pp-amount">Nominal</label>
            <input id="pp-amount" className="input mono" inputMode="numeric" value={amount ? amount.toLocaleString("id-ID") : ""} onChange={(e) => setAmount(Number(e.target.value.replace(/\D/g, "")) || 0)} />
          </div>
          <div className="field grow">
            <label htmlFor="pp-at">Waktu transfer</label>
            <input id="pp-at" className="input" type="datetime-local" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="pp-ref">No. referensi / hash</label>
          <input id="pp-ref" className="input mono" maxLength={120} value={ref} onChange={(e) => setRef(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <div className="field">
          <label htmlFor="pp-photo">Foto bukti</label>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {photos.map((ph, i) => (
              <span key={i} className="photo-thumb" style={{ width: 64, height: 64 }}>
                <img src={ph.url} alt={`Bukti ${i + 1}`} />
              </span>
            ))}
            {photos.length < 3 && (
              <label className="photo-add" htmlFor="pp-photo" aria-label="Tambah foto bukti">
                <Icon name="plus" />
                <input id="pp-photo" type="file" accept="image/*" multiple className="sr-only" onChange={(e) => void addFiles(e.target.files)} />
              </label>
            )}
          </div>
        </div>
        {error && <span className="error" role="alert">{error}</span>}
        <div className="row">
          <button className="btn grow" onClick={onClose}>Batal</button>
          <button className="btn primary grow" disabled={busy || !ready} onClick={() => void submit()}>
            {busy ? "Mengirim…" : "Sudah bayar"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Rekening penerima yang dikirim penjual ke kesepakatan (tersegel). */
export function DealPayInfo({ deal }: { deal: Deal }) {
  const [, m] = useMessenger();
  const sealed = useSealed<unknown>(deal.payInfo);
  if (!deal.payInfo) return null;
  if (sealed.state !== "ok") return <div className="tiny muted">{sealed.state === "loading" ? "…" : "🔒"}</div>;
  let info: PayMethod;
  try {
    info = validatePayMethod(sealed.data);
  } catch {
    return null;
  }
  return (
    <div className="pay-box">
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Icon name="wallet" size={14} />
        <strong>{info.provider}</strong>
        {info.kind === "crypto" && <span className="badge ok">Disarankan</span>}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <span className="mono grow" style={{ overflowWrap: "anywhere" }}>{info.number}</span>
        <button className="btn small" onClick={() => void copyText(info.number).then((ok) => m.toast(ok ? "Disalin" : "Gagal menyalin", ok ? "ok" : "danger"))} aria-label="Salin nomor">
          <Icon name="copy" size={14} />
        </button>
      </div>
      {info.holder && <div className="tiny">a.n. {info.holder}</div>}
    </div>
  );
}

/** Bukti pembayaran dari pembeli: ringkasan form + foto (didekripsi di perangkat). */
export function DealProof({ deal }: { deal: Deal }) {
  const sealed = useSealed<PaymentProofContent>(deal.payment);
  if (!deal.payment) return null;
  if (sealed.state !== "ok") return <div className="tiny muted">{sealed.state === "loading" ? "…" : "🔒"}</div>;
  const p = sealed.data;
  const photos = Array.isArray(p.photos) ? p.photos.slice(0, 3) : [];
  return (
    <div className="pay-box">
      <div className="deal-grid small">
        {p.method && (<><span className="muted">Dari</span><span>{String(p.method).slice(0, 60)}</span></>)}
        {p.sender && (<><span className="muted">Pengirim</span><span>{String(p.sender).slice(0, 60)}</span></>)}
        {typeof p.amount === "number" && p.amount > 0 && (<><span className="muted">Nominal</span><span className="mono">Rp{p.amount.toLocaleString("id-ID")}</span></>)}
        {p.paidAt && (<><span className="muted">Waktu</span><span>{String(p.paidAt).slice(0, 40)}</span></>)}
        {p.ref && (<><span className="muted">Ref</span><span className="mono" style={{ overflowWrap: "anywhere" }}>{String(p.ref).slice(0, 120)}</span></>)}
        {p.note && !p.method && (<><span className="muted">Catatan</span><span>{String(p.note).slice(0, 300)}</span></>)}
      </div>
      {photos.length > 0 && (
        <div className="row" style={{ gap: 8 }}>
          {photos.map((ref, i) => (
            <AttachmentImage key={i} refRaw={ref} alt={`Bukti pembayaran ${i + 1}`} />
          ))}
        </div>
      )}
    </div>
  );
}
