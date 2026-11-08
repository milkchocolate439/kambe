// Pembayaran LANGSUNG antarpengguna: info rekening/dompet kripto (brankas, E2EE) + "Sudah transfer".
// Prinsip: sesederhana mungkin — satu ketukan untuk mengirim info bayar, satu ketukan untuk menyalin.
import { useEffect, useState } from "react";
import { decodePayInfo, PAY_METHODS_MAX, type PayKind, type PayMethod } from "../../../shared/payinfo.ts";
import { STATEMENT_MAX, type Deal } from "../../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { copyText, Modal, useMessenger } from "./common.tsx";
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
          <Icon name="shieldCheck" size={12} /> Disarankan. Pastikan pembeli memakai <strong>jaringan yang sama</strong> — kiriman ke jaringan yang salah tidak bisa dikembalikan.
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
      <span className="hint">
        <Icon name="lock" size={12} /> Disimpan terenkripsi di perangkat ini saja, bukan di server. E-wallet tidak didukung karena nomornya adalah nomor HP.
      </span>
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
      <div className="hint">
        KAMBE gratis dan <strong>tidak memegang dana</strong>. Pembeli mentransfer langsung ke info pembayaranmu, lalu menekan "Sudah transfer". Setiap langkah dicatat notaris & Buku Jejak.
      </div>
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
export function SendPayInfoModal({ peer, peerAlias, onClose }: { peer: string; peerAlias: string; onClose: () => void }) {
  const [s, m] = useMessenger();
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    void m.loadPayMethods().then((l) => setAdding(l.length === 0));
  }, [m]);
  const list = s.payMethods ?? [];

  async function send(id: string) {
    try {
      if (await m.sendPayInfo(peer, id)) {
        m.toast(`Info pembayaran terkirim ke ${peerAlias} (terenkripsi)`, "ok");
        onClose();
      }
    } catch (e) {
      m.toast(e instanceof ApiError ? e.message : "Gagal mengirim", "danger");
    }
  }

  return (
    <Modal title="Kirim info pembayaran" onClose={onClose}>
      <div className="stack">
        {list.length > 0 && (
          <div className="list">
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
        <span className="hint">
          <Icon name="lock" size={12} /> Hanya {peerAlias} yang bisa membacanya (end-to-end). Nomor rekening tidak boleh ditulis di chat bebas.
        </span>
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

/** Pembeli: "Sudah transfer" + catatan/bukti opsional (tersegel untuk penjual & moderator). */
export function PayProofModal({ deal, peer, onClose }: { deal: Deal; peer: string; onClose: () => void }) {
  const [, m] = useMessenger();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await m.dealAction(peer, deal.id, "pay", { note: note.trim() });
      m.toast("Tercatat: kamu sudah transfer. Tunggu penjual mengonfirmasi.", "ok");
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Gagal");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Sudah transfer" onClose={onClose}>
      <div className="stack">
        <p className="small" style={{ margin: 0, color: "var(--text-2)" }}>
          Tekan ini hanya setelah kamu benar-benar mentransfer ke info pembayaran yang dikirim penjual di chat. KAMBE tidak memegang dana — catatan ini menjadi bukti bila ada sengketa.
        </p>
        <div className="field">
          <label htmlFor="pay-note">Catatan transfer (opsional)</label>
          <textarea id="pay-note" className="textarea" rows={2} maxLength={STATEMENT_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder="mis. BCA 12 Nov 14.05, ref 7781 · atau hash transaksi kripto" />
          <span className="hint">
            <Icon name="lock" size={12} /> Terenkripsi untuk kamu, penjual, dan moderator.
          </span>
        </div>
        {error && <span className="error" role="alert">{error}</span>}
        <div className="row">
          <button className="btn grow" onClick={onClose}>Batal</button>
          <button className="btn primary grow" disabled={busy} onClick={() => void submit()}>
            {busy ? "Mencatat…" : "Ya, sudah transfer"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
