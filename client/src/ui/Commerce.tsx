// Fase 2 — etalase, kesepakatan rekber, identitas terenkripsi, dompet. SEMUA SIMULASI.
import { useEffect, useState } from "react";
import {
  FEE_PER_MILLE,
  PRICE_MAX,
  PRICE_MIN,
  PRODUCT_DESC_MAX,
  PRODUCT_TITLE_MAX,
  SECTORS,
  platformFee,
  type Deal,
  type DealAction,
  type DealStatus,
  type DealContent,
  type PaymentProofContent,
  type Product,
  type ProductContent,
} from "../../../shared/protocol.ts";
import { cleanDisplayText } from "../../../shared/sealed.ts";
import { ApiError } from "../lib/api.ts";
import { Modal, SealedText, timeOf, useMessenger, useSealed } from "./common.tsx";
import { Icon } from "./icons.tsx";
import { DisputeModal, DisputeThread, ResolutionNote, ShipmentInfo, ShipModal } from "./Disputes.tsx";
import { PayMethodsManager, PayProofModal, SendPayInfoModal } from "./Payments.tsx";

export const rupiah = (n: number) => "Rp" + n.toLocaleString("id-ID");
/** Pratinjau fee dengan tarif dari server (0 = escrow gratis). Server tetap yang menghitung fee sebenarnya. */
const feeOf = (price: number, perMille: number | undefined) => platformFee(price, perMille ?? FEE_PER_MILLE);
const newKey = () => crypto.randomUUID().replace(/-/g, "");

export function SimBadge() {
  const [s] = useMessenger();
  if (s.config && s.config.paymentProvider !== "simulasi") return null;
  return (
    <span className="badge warn" title="Tidak ada uang sungguhan yang berpindah">
      SIMULASI
    </span>
  );
}

function useAction() {
  const [, m] = useMessenger();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      const out = await fn();
      if (ok) m.toast(ok, "ok");
      return out;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Gagal. Coba lagi.");
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

/** Input rupiah ramah HP: hanya angka, tampil berformat, nilai bilangan bulat. */
function RupiahInput({ value, onChange, id }: { value: number; onChange: (n: number) => void; id?: string }) {
  return (
    <input
      id={id}
      className="input mono"
      inputMode="numeric"
      value={value ? value.toLocaleString("id-ID") : ""}
      onChange={(e) => onChange(Math.min(PRICE_MAX * 10, Number(e.target.value.replace(/\D/g, "")) || 0))}
      placeholder="0"
    />
  );
}

function priceProblem(p: number) {
  if (!p) return "Isi harga";
  if (p < PRICE_MIN) return `Minimal ${rupiah(PRICE_MIN)}`;
  if (p > PRICE_MAX) return `Maksimal ${rupiah(PRICE_MAX)}`;
  return null;
}

// --------------------------------------------------------- kartu deal ---

const STATUS: Record<DealStatus, { label: string; tone: "ok" | "warn" | "danger" | "muted" }> = {
  AWAITING_PAYMENT: { label: "Menunggu pembayaran", tone: "warn" },
  HELD: { label: "Dana ditahan rekber", tone: "ok" },
  SHIPPED: { label: "Sudah dikirim", tone: "ok" },
  COMPLETED: { label: "Selesai · dana cair", tone: "ok" },
  CANCELLED: { label: "Dibatalkan", tone: "muted" },
  REFUNDED: { label: "Dana dikembalikan", tone: "muted" },
  DISPUTED: { label: "Sengketa", tone: "danger" },
};

/** Kesepakatan LANGSUNG: KAMBE tidak memegang dana, jadi label menggambarkan apa yang dinyatakan para pihak. */
const DIRECT_STATUS: Record<DealStatus, { label: string; tone: "ok" | "warn" | "danger" | "muted" }> = {
  AWAITING_PAYMENT: { label: "Menunggu transfer", tone: "warn" },
  HELD: { label: "Pembeli sudah transfer · cek mutasi", tone: "warn" },
  SHIPPED: { label: "Uang diterima · dikirim", tone: "ok" },
  COMPLETED: { label: "Selesai", tone: "ok" },
  CANCELLED: { label: "Dibatalkan", tone: "muted" },
  REFUNDED: { label: "Dana dikembalikan penjual", tone: "muted" },
  DISPUTED: { label: "Sengketa", tone: "danger" },
};

type ActionMeta = { label: string; primary?: boolean; danger?: boolean; confirm?: (d: Deal) => string };

function directMeta(a: DealAction, buyer: boolean): ActionMeta {
  switch (a) {
    case "pay":
      return { label: "Sudah transfer", primary: true };
    case "ship":
      return { label: "Uang diterima · kirim", primary: true };
    case "confirm":
      return { label: "Barang diterima · selesai", primary: true, confirm: () => "Kesepakatan ditandai selesai. Lakukan hanya bila barang/jasa benar-benar sudah kamu terima." };
    case "refund":
      return { label: "Dana sudah kukembalikan", danger: true, confirm: (d) => `Tandai bahwa kamu sudah mengembalikan ${rupiah(d.price)} ke pembeli. Kesepakatan ditutup.` };
    case "dispute":
      return { label: buyer ? "Ajukan sengketa" : "Uang belum masuk", danger: true };
    default:
      return { label: "Batalkan" };
  }
}

const ACTIONS: Record<DealAction, ActionMeta> = {
  pay: {
    label: "Bayar ke rekber",
    primary: true,
    confirm: (d) =>
      `${rupiah(d.price)} akan DITAHAN rekber KAMBE. Penjual wajib mengirim dalam 3 hari — kalau tidak, kamu bisa menarik dana kembali (otomatis kembali setelah 7 hari). Penjual baru menerima dana setelah kamu konfirmasi barang diterima, atau otomatis 7 hari setelah dikirim bila kamu tidak menanggapi. Jangan pernah transfer di luar fitur ini.`,
  },
  ship: {
    label: "Tandai sudah dikirim",
    primary: true,
    confirm: () => "Pembeli punya 7 hari untuk konfirmasi atau mengajukan sengketa. Setelah itu dana cair otomatis ke kamu.",
  },
  confirm: {
    label: "Barang diterima · cairkan",
    primary: true,
    confirm: (d) => `${rupiah(d.sellerNet)} diteruskan ke penjual${d.fee > 0 ? " (setelah fee platform)" : " (escrow gratis, tanpa potongan)"}. Hanya konfirmasi kalau barang/jasa benar-benar sudah kamu terima. Tidak bisa dibatalkan.`,
  },
  cancel: { label: "Batalkan" },
  refund: {
    label: "Kembalikan dana",
    danger: true,
    confirm: (d) => `${rupiah(d.price)} dikembalikan penuh ke pembeli tanpa potongan. Tidak bisa dibatalkan.`,
  },
  dispute: {
    label: "Ajukan sengketa",
    danger: true,
    confirm: () => "Pencairan otomatis dihentikan. Selesaikan lewat chat: penjual bisa mengembalikan dana, atau kamu bisa menyatakan barang diterima.",
  },
};

export function DealCard({ deal, peer, peerAlias }: { deal: Deal; peer: string; peerAlias: string }) {
  const [s, m] = useMessenger();
  const [pending, setPending] = useState<DealAction | null>(null);
  const [identity, setIdentity] = useState(false);
  const [form, setForm] = useState<null | "ship" | "dispute" | "pay">(null);
  const [payInfo, setPayInfo] = useState(false);
  const { busy, error, run } = useAction();
  const iAmBuyer = deal.buyerId === s.me.id;
  const direct = deal.direct;
  const st = (direct ? DIRECT_STATUS : STATUS)[deal.status];
  const when = (ts: number) => `${new Date(ts).toLocaleDateString("id-ID", { day: "numeric", month: "short" })} ${timeOf(ts)}`;
  // Pembeli yang menarik dana sendiri (penjual lewat batas kirim) diberi label & penjelasan berbeda.
  const meta = (a: DealAction): ActionMeta =>
    direct
      ? directMeta(a, iAmBuyer)
      : a === "refund" && iAmBuyer
      ? { label: "Tarik dana kembali", danger: true, confirm: (x: Deal) => `Penjual tidak mengirim sebelum batas waktu. ${rupiah(x.price)} dikembalikan penuh kepadamu dan kesepakatan dibatalkan.` }
      : ACTIONS[a];
  const canShareIdentity = ["HELD", "SHIPPED", "COMPLETED", "DISPUTED"].includes(deal.status);

  async function act(a: DealAction) {
    const out = await run(() => m.dealAction(peer, deal.id, a));
    if (out) setPending(null);
  }

  return (
    <div className="deal-card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="row tiny" style={{ gap: 6, fontWeight: 800, letterSpacing: "0.06em" }}>
          <Icon name="handshake" size={14} /> {direct ? "KESEPAKATAN LANGSUNG" : "KESEPAKATAN REKBER"}
        </span>
        <SimBadge />
      </div>
      <strong>
        <SealedText<DealContent> view={deal.content} field="title" locked="🔒 Judul terenkripsi (menunggu dibagikan)" max={PRODUCT_TITLE_MAX} />
      </strong>
      <div className="deal-grid small">
        <span className="muted">{iAmBuyer ? "Kamu membeli dari" : "Kamu menjual ke"}</span>
        <span>{peerAlias}</span>
        <span className="muted">Harga</span>
        <span className="mono">{rupiah(deal.price)}</span>
        {direct ? (
          <>
            <span className="muted">Pembayaran</span>
            <span>Langsung ke penjual</span>
            <span className="muted">Biaya KAMBE</span>
            <span>Gratis</span>
          </>
        ) : (
          <>
            <span className="muted">{deal.fee > 0 ? `Fee platform (${((deal.fee / deal.price) * 100).toLocaleString("id-ID", { maximumFractionDigits: 1 })}%)` : "Biaya escrow KAMBE"}</span>
            <span className="mono">{deal.fee > 0 ? `−${rupiah(deal.fee)}` : "Gratis"}</span>
            <span className="muted">Diterima penjual</span>
            <span className="mono">{rupiah(deal.sellerNet)}</span>
          </>
        )}
      </div>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <span className={`badge ${st.tone === "muted" ? "" : st.tone}`}>{st.label}</span>
        {deal.autoReleaseAt && <span className="tiny muted">{direct ? "Selesai otomatis" : "Cair otomatis"} {when(deal.autoReleaseAt)}</span>}
      </div>
      {deal.status === "HELD" && deal.shipBy && (
        <div className="tiny muted">
          {deal.shipBy > Date.now()
            ? iAmBuyer
              ? `Penjual wajib mengirim sebelum ${when(deal.shipBy)}. Lewat dari itu kamu bisa menarik dana sendiri.`
              : `Kirim sebelum ${when(deal.shipBy)}. Lewat dari itu pembeli boleh menarik dananya.`
            : iAmBuyer
              ? "Penjual melewati batas kirim — kamu boleh menarik dana kembali."
              : "Batas kirim sudah lewat — pembeli boleh menarik dananya kapan saja."}
          {deal.autoRefundAt && ` Dana kembali otomatis ke pembeli ${when(deal.autoRefundAt)} bila belum dikirim.`}
        </div>
      )}
      <ReceiptLine deal={deal} />
      <TxLine deal={deal} peerAlias={peerAlias} />
      {direct && iAmBuyer && deal.status === "AWAITING_PAYMENT" && (
        <div className="tiny muted">Transfer ke info pembayaran yang dikirim {peerAlias} di chat, lalu tekan "Sudah transfer". KAMBE tidak memegang dana.</div>
      )}
      {direct && !iAmBuyer && deal.status === "HELD" && (
        <div className="tiny muted">Cek mutasi rekening/dompetmu. Kalau uang sudah masuk, tekan "Uang diterima · kirim". Kalau belum, tekan "Uang belum masuk".</div>
      )}
      {direct && deal.payment && (
        <div className="tiny">
          <Icon name="wallet" size={12} /> Catatan transfer: <SealedText<PaymentProofContent> view={deal.payment} field="note" max={300} locked="🔒 terenkripsi" />
        </div>
      )}
      {direct && !iAmBuyer && (deal.status === "AWAITING_PAYMENT" || deal.status === "HELD") && (
        <button className="btn small" onClick={() => setPayInfo(true)}>
          <Icon name="wallet" size={14} /> Kirim info pembayaran
        </button>
      )}
      {deal.paymentUrl?.startsWith("https://") && iAmBuyer && (
        <a className="btn primary small" href={deal.paymentUrl} target="_blank" rel="noopener noreferrer">
          Lanjutkan ke halaman bayar resmi
        </a>
      )}
      <ShipmentInfo deal={deal} />
      <ResolutionNote deal={deal} />
      <DisputeThread deal={deal} peer={peer} myRole={iAmBuyer ? "buyer" : "seller"} />
      {deal.status === "DISPUTED" && (
        <div className="tiny" style={{ color: "var(--danger)" }}>
          {direct
            ? "Sengketa berjalan. KAMBE tidak memegang dana — moderator menilai bukti kedua pihak (catatan transfer, resi, pernyataan)."
            : iAmBuyer
              ? "Kamu mengajukan sengketa. Diskusikan dengan penjual; dana tetap ditahan."
              : "Pembeli mengajukan sengketa. Dana ditahan sampai kamu mengembalikan dana atau pembeli menerima barang."}
          {deal.autoRefundAt && ` Bila belum selesai sampai ${when(deal.autoRefundAt)}, dana kembali ke pembeli.`}
        </div>
      )}
      {(deal.actions.length > 0 || canShareIdentity) && (
        <div className="row" style={{ flexWrap: "wrap" }}>
          {deal.actions.map((a) => {
            const x = meta(a);
            return (
              <button
                key={a}
                className={`btn small ${"primary" in x && x.primary ? "primary" : ""} ${x.danger ? "danger" : ""}`}
                disabled={busy}
                onClick={() => (direct && a === "pay" ? setForm("pay") : a === "ship" || a === "dispute" ? setForm(a) : x.confirm ? setPending(a) : void act(a))}
              >
                {x.label}
              </button>
            );
          })}
          {canShareIdentity && (
            <button className="btn small ghost" onClick={() => setIdentity(true)}>
              <Icon name="idcard" size={14} /> Bagikan identitas
            </button>
          )}
        </div>
      )}
      {error && !pending && <span className="error">{error}</span>}

      {pending && (
        <Modal title={meta(pending).label} onClose={() => setPending(null)}>
          <div className="stack">
            <div className="row">
              <strong className="grow">
                <SealedText<DealContent> view={deal.content} field="title" max={PRODUCT_TITLE_MAX} />
              </strong>
              <SimBadge />
            </div>
            <p className="small" style={{ margin: 0, color: "var(--text-2)" }}>{meta(pending).confirm!(deal)}</p>
            {error && <span className="error" role="alert">{error}</span>}
            <div className="row">
              <button className="btn grow" onClick={() => setPending(null)}>Batal</button>
              <button className={`btn grow ${meta(pending).danger ? "danger" : "primary"}`} disabled={busy} onClick={() => void act(pending)}>
                {busy ? "Memproses…" : "Ya, lanjutkan"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {identity && <IdentityModal peer={peer} peerAlias={peerAlias} onClose={() => setIdentity(false)} />}
      {form === "ship" && <ShipModal deal={deal} peer={peer} onClose={() => setForm(null)} />}
      {form === "dispute" && <DisputeModal deal={deal} peer={peer} onClose={() => setForm(null)} />}
      {form === "pay" && <PayProofModal deal={deal} peer={peer} onClose={() => setForm(null)} />}
      {payInfo && <SendPayInfoModal peer={peer} peerAlias={peerAlias} onClose={() => setPayInfo(false)} />}
    </div>
  );
}

/** Status kuitansi notaris: bukti bertanda tangan yang diverifikasi di perangkat ini. */
function ReceiptLine({ deal }: { deal: Deal }) {
  const [s] = useMessenger();
  const r = s.receipts[deal.id];
  if (!r) return <span className="tiny muted">Memeriksa kuitansi…</span>;
  if (r.state === "ok") {
    return (
      <span className="tiny" style={{ color: "var(--ok)" }} title={`Kode bayar ${deal.payRef}`}>
        <Icon name="shieldCheck" size={12} /> Kuitansi #{r.seq} sah (ditandatangani notaris) · {deal.payRef}
      </span>
    );
  }
  const text = {
    invalid: "Kuitansi TIDAK SAH — tanda tangan notaris tidak cocok.",
    mismatch: "Isi kuitansi tidak cocok dengan data kesepakatan.",
    rollback: "Server mengembalikan riwayat lama (kuitansi mundur).",
    missing: "Kuitansi belum bisa diverifikasi.",
  }[r.state];
  return (
    <span className="tiny" style={{ color: r.state === "missing" ? "var(--muted)" : "var(--danger)", fontWeight: 700 }}>
      <Icon name="alert" size={12} /> {text}
      {r.state !== "missing" && " Jangan lanjutkan pembayaran."}
    </span>
  );
}

/** Buku Jejak Transaksi: status tanda tangan (notaris + perangkat + lawan) & ekspor bukti. */
function TxLine({ deal, peerAlias }: { deal: Deal; peerAlias: string }) {
  const [s, m] = useMessenger();
  const t = s.txlog[deal.id];
  if (!t) return null;
  async function save() {
    try {
      const blob = await m.exportTxEvidence(deal.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kambe-bukti-${deal.id.slice(0, 8)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      m.toast(e instanceof ApiError ? e.message : "Gagal mengekspor bukti", "danger");
    }
  }
  if (t.peer === "mismatch" || t.peer === "badkey") {
    return (
      <div className="banner danger" role="alert" style={{ borderRadius: 10 }}>
        <Icon name="alert" />
        <div className="grow small">
          <strong>{t.peer === "mismatch" ? "Catatan tidak cocok dengan lawan." : `Kunci tanda tangan ${peerAlias} berubah.`}</strong>{" "}
          {t.peer === "mismatch" ? "Kuitansi yang kalian lihat berbeda — jangan lanjutkan pembayaran dan simpan bukti untuk moderator." : "Catatannya tidak dihitung sampai kamu menerima perubahan kunci di chat."}
          <div className="actions">
            <button className="btn small" onClick={() => void save()}>
              Ekspor bukti
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <span className="tiny row" style={{ gap: 6, color: t.peer === "ok" ? "var(--arwah)" : "var(--muted)", flexWrap: "wrap" }} title="Buku Jejak Transaksi: setiap perubahan status dicatat & ditandatangani perangkat kedua pihak">
      <span>
        <Icon name={t.peer === "ok" ? "shieldCheck" : "clock"} size={12} /> {t.peer === "ok" ? `Buku Jejak: 3 tanda tangan cocok (notaris + kamu + ${peerAlias})` : `Buku Jejak: notaris + kamu · menunggu ${peerAlias}`}
      </span>
      <button className="btn ghost small" onClick={() => void save()} aria-label="Ekspor bukti transaksi">
        Ekspor bukti
      </button>
    </span>
  );
}

// --------------------------------------------------- etalase lawan chat ---

export function CatalogModal({ peer, peerAlias, onClose }: { peer: string; peerAlias: string; onClose: () => void }) {
  const [s, m] = useMessenger();
  const catalog = s.catalogs[peer];
  const [chosen, setChosen] = useState<{ product: Product; content: ProductContent } | null>(null);
  const [idem, setIdem] = useState(newKey);
  const { busy, error, run, setError } = useAction();

  useEffect(() => {
    void m.loadCatalog(peer).catch(() => {});
  }, [m, peer]);

  async function buy() {
    if (!chosen) return;
    // Judul diambil dari isi produk yang sudah didekripsi, lalu disegel ulang untuk penjual & moderator.
    const deal = await run(() => m.createDeal(peer, chosen.product.id, idem, chosen.content.title), "Kesepakatan dibuat. Lanjutkan pembayaran di kartu kesepakatan.");
    if (deal) onClose();
  }

  return (
    <Modal title={`Etalase ${peerAlias}`} onClose={onClose}>
      {!catalog ? (
        <div className="hint">Memuat…</div>
      ) : !catalog.pro || catalog.products.length === 0 ? (
        <div className="empty">
          <div className="icon-wrap">
            <Icon name="store" size={26} />
          </div>
          <div className="small">{catalog.pro ? `${peerAlias} belum memajang produk.` : `${peerAlias} belum membuka etalase PRO.`}</div>
        </div>
      ) : chosen ? (
        <div className="stack">
          <div className="row">
            <strong className="grow">{cleanDisplayText(chosen.content.title, PRODUCT_TITLE_MAX)}</strong>
            <SimBadge />
          </div>
          <div className="deal-grid small">
            <span className="muted">Harga (dikunci server)</span>
            <span className="mono">{rupiah(chosen.product.price)}</span>
            <span className="muted">{feeOf(chosen.product.price, s.config?.feePerMille) > 0 ? "Fee platform ditanggung penjual" : "Biaya escrow KAMBE"}</span>
            <span className="mono">{feeOf(chosen.product.price, s.config?.feePerMille) > 0 ? rupiah(feeOf(chosen.product.price, s.config?.feePerMille)) : "Gratis"}</span>
          </div>
          <div className="banner info" style={{ borderRadius: 12, border: 0 }}>
            <Icon name="shieldCheck" />
            <span className="small">
              Dana yang kamu bayar <strong>ditahan rekber</strong> dan baru diteruskan setelah kamu konfirmasi barang diterima. Jangan mau diminta transfer langsung.
            </span>
          </div>
          {error && <span className="error" role="alert">{error}</span>}
          <div className="row">
            <button className="btn grow" onClick={() => { setChosen(null); setError(null); setIdem(newKey()); }}>Kembali</button>
            <button className="btn primary grow" disabled={busy} onClick={() => void buy()}>
              <Icon name="handshake" /> {busy ? "Membuat…" : "Buat kesepakatan"}
            </button>
          </div>
        </div>
      ) : (
        <div className="list">
          {catalog.products.map((p) => (
            <CatalogItem key={p.id} product={p} onChoose={(content) => setChosen({ product: p, content })} />
          ))}
        </div>
      )}
    </Modal>
  );
}

/** Satu produk etalase: isi didekripsi di perangkat; bila kunci belum dibagikan, tidak bisa dibeli dulu. */
function CatalogItem({ product, onChoose }: { product: Product; onChoose: (c: ProductContent) => void }) {
  const s = useSealed<ProductContent>(product.content);
  const content = s.state === "ok" ? s.data : null;
  return (
    <button className="item" style={{ alignItems: "flex-start" }} disabled={!content} onClick={() => content && onChoose(content)}>
      <div className="grow">
        {content ? (
          <>
            <span className="name">{cleanDisplayText(content.title, PRODUCT_TITLE_MAX)}</span>
            <div className="tiny muted">{cleanDisplayText(content.sector, 40)}</div>
            {content.description && (
              <div className="small" style={{ color: "var(--text-2)", marginTop: 4, whiteSpace: "pre-wrap" }}>
                {cleanDisplayText(content.description, PRODUCT_DESC_MAX)}
              </div>
            )}
          </>
        ) : (
          <span className="small muted">{s.state === "loading" ? "Membuka…" : "🔒 Menunggu penjual online untuk membagikan kunci etalase"}</span>
        )}
      </div>
      <strong className="mono" style={{ color: "var(--ok)", whiteSpace: "nowrap" }}>{rupiah(product.price)}</strong>
    </button>
  );
}

// ------------------------------------------------ tawaran kustom (PRO) ---

export function OfferModal({ peer, peerAlias, onClose }: { peer: string; peerAlias: string; onClose: () => void }) {
  const [s, m] = useMessenger();
  const perMille = s.config?.feePerMille;
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState(0);
  const [idem] = useState(newKey);
  const { busy, error, run } = useAction();
  const problem = priceProblem(price);

  async function submit() {
    const deal = await run(() => m.offerDeal(peer, title.trim(), price, idem), `Tawaran terkirim ke ${peerAlias}`);
    if (deal) onClose();
  }

  return (
    <Modal title={`Tawarkan kesepakatan ke ${peerAlias}`} onClose={onClose}>
      <div className="stack">
        <div className="field">
          <label htmlFor="offer-title">Barang / jasa</label>
          <input id="offer-title" className="input" maxLength={PRODUCT_TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="mis. Roasting kustom 2 Kg" />
        </div>
        <div className="field">
          <label htmlFor="offer-price">Harga</label>
          <RupiahInput id="offer-price" value={price} onChange={setPrice} />
          {price > 0 &&
            (problem ? (
              <span className="error">{problem}</span>
            ) : (
              <span className="hint">
                {s.config?.paymentProvider === "langsung"
                  ? `Pembeli mentransfer ${rupiah(price)} langsung ke info pembayaranmu — KAMBE gratis & tidak memegang dana.`
                  : feeOf(price, perMille) > 0
                  ? `Kamu menerima ${rupiah(price - feeOf(price, perMille))} setelah fee platform (${rupiah(feeOf(price, perMille))}).`
                  : `Kamu menerima ${rupiah(price)} utuh — escrow KAMBE gratis.`}
              </span>
            ))}
        </div>
        {error && <span className="error" role="alert">{error}</span>}
        <div className="row">
          <SimBadge />
          <span className="grow" />
          <button className="btn" onClick={onClose}>Batal</button>
          <button className="btn primary" disabled={busy || !!problem || title.trim().length < 3} onClick={() => void submit()}>
            {busy ? "Mengirim…" : "Kirim tawaran"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------- identitas terenkripsi E2EE ---

export function IdentityModal({ peer, peerAlias, onClose }: { peer: string; peerAlias: string; onClose: () => void }) {
  const [, m] = useMessenger();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [contact, setContact] = useState("");
  const [note, setNote] = useState("");
  const [remember, setRemember] = useState(false);
  const [sure, setSure] = useState(false);

  // Alamat yang diingat ada di brankas terenkripsi perangkat (bukan localStorage polos).
  useEffect(() => {
    let alive = true;
    void m.getSavedShipping().then((saved) => {
      if (!alive || !saved) return;
      setName((v) => v || saved.name);
      setAddress((v) => v || saved.address);
      setContact((v) => v || saved.contact);
      setRemember(true);
    });
    return () => {
      alive = false;
    };
  }, [m]);

  async function share() {
    const text = [`Nama: ${name.trim()}`, address.trim() && `Alamat: ${address.trim()}`, contact.trim() && `Kontak: ${contact.trim()}`, note.trim() && `Catatan: ${note.trim()}`]
      .filter(Boolean)
      .join("\n");
    try {
      await m.setSavedShipping(remember ? { name, address, contact } : null);
    } catch {
      m.toast("Gagal menyimpan alamat di brankas perangkat — identitas tetap bisa dikirim.", "warn");
    }
    if (await m.shareIdentity(peer, text)) {
      m.toast(`Identitas dikirim terenkripsi ke ${peerAlias}`, "ok");
      onClose();
    }
  }

  return (
    <Modal title="Bagikan identitas untuk pengiriman" onClose={onClose}>
      <div className="stack">
        <div className="banner info" style={{ borderRadius: 12, border: 0 }}>
          <Icon name="lock" />
          <span className="small">
            Dikirim sebagai pesan <strong>terenkripsi end-to-end</strong> hanya ke {peerAlias}. Server KAMBE tidak pernah melihat data ini.
          </span>
        </div>
        <div className="field">
          <label htmlFor="id-name">Nama penerima</label>
          <input id="id-name" className="input" autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="id-address">Alamat pengiriman</label>
          <textarea id="id-address" className="textarea" rows={3} autoComplete="street-address" maxLength={400} value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="id-contact">No. HP/WA (opsional)</label>
          <input id="id-contact" className="input" inputMode="tel" autoComplete="tel" maxLength={40} value={contact} onChange={(e) => setContact(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="id-note">Catatan (opsional)</label>
          <input id="id-note" className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="mis. titip di pos satpam" />
        </div>
        <label className="row small" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Ingat di perangkat ini (tidak dikirim ke server)
        </label>
        <label className="row small" style={{ cursor: "pointer", alignItems: "flex-start" }}>
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} style={{ marginTop: 3 }} />
          <span>Saya paham identitas yang sudah terkirim <strong>tidak bisa ditarik kembali</strong>, dan hanya saya bagikan untuk transaksi ini.</span>
        </label>
        <div className="row">
          <button className="btn grow" onClick={onClose}>Batal</button>
          <button className="btn primary grow" disabled={!sure || name.trim().length < 2} onClick={() => void share()}>
            <Icon name="send" /> Kirim terenkripsi
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------- toko & dompet ---

type StoreTab = "pro" | "products" | "wallet";

const LEDGER_LABEL: Record<string, string> = {
  subscription: "Langganan PRO",
  deal_payment: "Bayar ke rekber",
  deal_release: "Dana cair dari penjualan",
  deal_refund: "Refund diterima",
};

export function StoreModal({ onClose, initial = "pro" }: { onClose: () => void; initial?: StoreTab }) {
  const [s, m] = useMessenger();
  const free = !!s.config?.freePlatform;
  const direct = s.config?.paymentProvider === "langsung";
  const [tab, setTab] = useState<StoreTab>((s.pro?.active || free) && initial === "pro" ? "products" : initial);
  useEffect(() => {
    if (tab === "wallet" && !direct) void m.loadWallet();
  }, [m, tab, direct]);
  const tabs: [StoreTab, string][] = free ? [["products", "Etalase"], ["wallet", "Dompet"]] : [["pro", "PRO"], ["products", "Etalase"], ["wallet", "Dompet"]];

  return (
    <Modal title="Toko & Dompet" onClose={onClose}>
      <div className="stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="small muted">{direct ? "KAMBE gratis. Pembayaran langsung antarpengguna — KAMBE tidak memegang dana." : "Fitur dagang masih tahap uji — tidak ada uang sungguhan."}</span>
          <SimBadge />
        </div>
        <div className="tabs" role="tablist" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
          {tabs.map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </div>
        {tab === "pro" && <ProTab />}
        {tab === "products" && (s.pro?.active || free ? <ProductsTab /> : <ProTab />)}
        {tab === "wallet" && (direct ? <PayMethodsManager /> : <WalletTab />)}
      </div>
    </Modal>
  );
}

function ProTab() {
  const [s, m] = useMessenger();
  const [idem, setIdem] = useState(newKey);
  const { busy, error, run } = useAction();
  const pro = s.pro;
  return (
    <div className="stack">
      <div className="card" style={{ background: "var(--amber-bg)", borderColor: "transparent" }}>
        <div className="row">
          <Icon name="crown" />
          <strong className="grow">KAMBE PRO</strong>
          <strong className="mono">{rupiah(pro?.price ?? 49_000)}/bln</strong>
        </div>
        <ul className="small" style={{ margin: "10px 0 0", paddingLeft: 18, color: "var(--text-2)" }}>
          <li>Buka etalase produk/jasa untuk kontakmu</li>
          <li>Tawarkan kesepakatan rekber langsung dari chat</li>
          {(s.config?.feePerMille ?? FEE_PER_MILLE) > 0 ? (
            <li>Fee {((s.config?.feePerMille ?? FEE_PER_MILLE) / 10).toLocaleString("id-ID")}% hanya dipotong saat dana cair (tidak saat refund)</li>
          ) : (
            <li>Escrow (rekber) gratis — KAMBE tidak memotong dana penjual</li>
          )}
        </ul>
      </div>
      {pro?.active ? (
        <div className="badge ok" style={{ alignSelf: "flex-start" }}>
          <Icon name="check" size={13} /> Aktif sampai {new Date(pro.proUntil).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}
        </div>
      ) : (
        <div className="hint">Status: belum berlangganan.</div>
      )}
      {error && <span className="error" role="alert">{error}</span>}
      <button
        className="btn primary block"
        disabled={busy}
        onClick={async () => {
          const out = await run(() => m.subscribePro(idem), "PRO aktif (simulasi)");
          if (out) setIdem(newKey());
        }}
      >
        {busy ? "Memproses…" : pro?.active ? "Perpanjang 30 hari (simulasi)" : "Aktifkan PRO (simulasi)"}
      </button>
    </div>
  );
}

type ProductDraft = { id?: string; price: number } & ProductContent;

function ProductsTab() {
  const [s] = useMessenger();
  const [editing, setEditing] = useState<ProductDraft | null>(null);
  const { busy, error, run } = useAction();

  if (editing) return <ProductForm initial={editing} onDone={() => setEditing(null)} />;
  return (
    <div className="stack">
      <button className="btn primary block" onClick={() => setEditing({ title: "", description: "", sector: SECTORS[0], price: 0 })}>
        <Icon name="plus" /> Tambah produk / jasa
      </button>
      {s.myProducts.length === 0 ? (
        <div className="hint" style={{ textAlign: "center" }}>Etalase masih kosong. Hanya kontakmu yang bisa melihatnya (terenkripsi).</div>
      ) : (
        <div className="list">
          {s.myProducts.map((p) => (
            <MyProductRow key={p.id} product={p} busy={busy} run={run} onEdit={setEditing} />
          ))}
        </div>
      )}
      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}

function MyProductRow({ product: p, busy, run, onEdit }: { product: Product; busy: boolean; run: ReturnType<typeof useAction>["run"]; onEdit: (d: ProductDraft) => void }) {
  const [, m] = useMessenger();
  const s = useSealed<ProductContent>(p.content);
  const c = s.state === "ok" ? s.data : null;
  const title = c ? cleanDisplayText(c.title, PRODUCT_TITLE_MAX) : "🔒";
  return (
    <div className="row" style={{ padding: "8px 4px", borderBottom: "1px solid var(--line)" }}>
      <div className="grow">
        <div className="truncate" style={{ fontWeight: 700 }}>{title}</div>
        <div className="tiny muted">
          {c ? cleanDisplayText(c.sector, 40) : "—"} · <span className="mono">{rupiah(p.price)}</span>
        </div>
      </div>
      <button className="btn ghost icon" aria-label={`Ubah ${title}`} disabled={!c} onClick={() => c && onEdit({ id: p.id, price: p.price, ...c })}>
        <Icon name="edit" />
      </button>
      <button className="btn ghost icon" aria-label={`Hapus ${title}`} disabled={busy} onClick={() => void run(() => m.deleteProduct(p.id), "Produk ditarik dari etalase")}>
        <Icon name="trash" />
      </button>
    </div>
  );
}

function ProductForm({ initial, onDone }: { initial: ProductDraft; onDone: () => void }) {
  const [, m] = useMessenger();
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [sector, setSector] = useState(initial.sector || SECTORS[0]);
  const [price, setPrice] = useState(initial.price);
  const { busy, error, run } = useAction();
  const problem = priceProblem(price);

  async function save() {
    const ok = await run(() => m.saveProduct({ id: initial.id, title: title.trim(), description: description.trim(), sector, price }), initial.id ? "Produk diperbarui" : "Produk dipajang di etalase");
    if (ok !== undefined) onDone();
  }

  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="p-title">Nama produk / jasa</label>
        <input id="p-title" className="input" maxLength={PRODUCT_TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="p-sector">Sektor</label>
        <select id="p-sector" className="input" value={sector} onChange={(e) => setSector(e.target.value)}>
          {SECTORS.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="p-price">Harga</label>
        <RupiahInput id="p-price" value={price} onChange={setPrice} />
        {price > 0 && problem && <span className="error">{problem}</span>}
      </div>
      <div className="field">
        <label htmlFor="p-desc">Deskripsi (opsional)</label>
        <textarea id="p-desc" className="textarea" rows={3} maxLength={PRODUCT_DESC_MAX} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {error && <span className="error" role="alert">{error}</span>}
      <div className="row">
        <button className="btn grow" onClick={onDone}>Batal</button>
        <button className="btn primary grow" disabled={busy || !!problem || title.trim().length < 3} onClick={() => void save()}>
          {busy ? "Menyimpan…" : "Simpan"}
        </button>
      </div>
    </div>
  );
}

function WalletTab() {
  const [s] = useMessenger();
  const w = s.wallet;
  if (!w) return <div className="hint">Memuat…</div>;
  return (
    <div className="stack">
      <div className="card" style={{ textAlign: "center" }}>
        <div className="tiny muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Saldo cair (simulasi)</div>
        <div className="mono" style={{ fontSize: 26, fontWeight: 800, color: "var(--ok)" }}>{rupiah(w.balance)}</div>
      </div>
      <div className="deal-grid small">
        <span className="muted">Masuk, masih ditahan rekber</span>
        <span className="mono">{rupiah(w.incomingHeld)}</span>
        <span className="muted">Pembayaranmu yang ditahan</span>
        <span className="mono">{rupiah(w.outgoingHeld)}</span>
      </div>
      <div className="divider" />
      {w.entries.length === 0 ? (
        <div className="hint">Belum ada mutasi.</div>
      ) : (
        <div className="list">
          {w.entries.map((e) => (
            <div key={e.id} className="row small">
              <span className="grow">{LEDGER_LABEL[e.kind] ?? e.kind}</span>
              <span className="tiny muted">{timeOf(e.createdAt)}</span>
              <span className="mono" style={{ color: e.amount >= 0 ? "var(--ok)" : "var(--text-2)", minWidth: 110, textAlign: "right" }}>
                {e.amount >= 0 ? "+" : "−"}
                {rupiah(Math.abs(e.amount))}
              </span>
            </div>
          ))}
        </div>
      )}
      <span className="hint">Penarikan saldo ke rekening baru tersedia setelah KAMBE memakai payment gateway berizin.</span>
    </div>
  );
}
