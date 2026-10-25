// Fase 2 — etalase, kesepakatan rekber, identitas terenkripsi, dompet. SEMUA SIMULASI.
import { useEffect, useMemo, useState } from "react";
import {
  PRICE_MAX,
  PRICE_MIN,
  PRODUCT_DESC_MAX,
  PRODUCT_TITLE_MAX,
  SECTORS,
  platformFee,
  type Deal,
  type DealAction,
  type DealStatus,
  type Product,
} from "../../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { Modal, timeOf, useMessenger } from "./common.tsx";
import { Icon } from "./icons.tsx";
import { DisputeModal, DisputeThread, ResolutionNote, ShipmentInfo, ShipModal } from "./Disputes.tsx";

export const rupiah = (n: number) => "Rp" + n.toLocaleString("id-ID");
const newKey = () => crypto.randomUUID().replace(/-/g, "");

export function SimBadge() {
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

const ACTIONS: Record<DealAction, { label: string; primary?: boolean; danger?: boolean; confirm?: (d: Deal) => string }> = {
  pay: {
    label: "Bayar ke rekber",
    primary: true,
    confirm: (d) =>
      `${rupiah(d.price)} akan DITAHAN rekber PINPath. Penjual wajib mengirim dalam 3 hari — kalau tidak, kamu bisa menarik dana kembali (otomatis kembali setelah 7 hari). Penjual baru menerima dana setelah kamu konfirmasi barang diterima, atau otomatis 7 hari setelah dikirim bila kamu tidak menanggapi. Jangan pernah transfer di luar fitur ini.`,
  },
  ship: {
    label: "Tandai sudah dikirim",
    primary: true,
    confirm: () => "Pembeli punya 7 hari untuk konfirmasi atau mengajukan sengketa. Setelah itu dana cair otomatis ke kamu.",
  },
  confirm: {
    label: "Barang diterima · cairkan",
    primary: true,
    confirm: (d) => `${rupiah(d.sellerNet)} diteruskan ke penjual (setelah fee 2,5%). Hanya konfirmasi kalau barang/jasa benar-benar sudah kamu terima. Tidak bisa dibatalkan.`,
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
  const [form, setForm] = useState<null | "ship" | "dispute">(null);
  const { busy, error, run } = useAction();
  const iAmBuyer = deal.buyerId === s.me.id;
  const st = STATUS[deal.status];
  const when = (ts: number) => `${new Date(ts).toLocaleDateString("id-ID", { day: "numeric", month: "short" })} ${timeOf(ts)}`;
  // Pembeli yang menarik dana sendiri (penjual lewat batas kirim) diberi label & penjelasan berbeda.
  const meta = (a: DealAction) =>
    a === "refund" && iAmBuyer
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
          <Icon name="handshake" size={14} /> KESEPAKATAN REKBER
        </span>
        <SimBadge />
      </div>
      <strong>{deal.title}</strong>
      <div className="deal-grid small">
        <span className="muted">{iAmBuyer ? "Kamu membeli dari" : "Kamu menjual ke"}</span>
        <span>{peerAlias}</span>
        <span className="muted">Harga</span>
        <span className="mono">{rupiah(deal.price)}</span>
        <span className="muted">Fee platform 2,5%</span>
        <span className="mono">−{rupiah(deal.fee)}</span>
        <span className="muted">Diterima penjual</span>
        <span className="mono">{rupiah(deal.sellerNet)}</span>
      </div>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <span className={`badge ${st.tone === "muted" ? "" : st.tone}`}>{st.label}</span>
        {deal.autoReleaseAt && <span className="tiny muted">Cair otomatis {when(deal.autoReleaseAt)}</span>}
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
      <ShipmentInfo deal={deal} />
      <ResolutionNote deal={deal} />
      <DisputeThread deal={deal} peer={peer} myRole={iAmBuyer ? "buyer" : "seller"} />
      {deal.status === "DISPUTED" && (
        <div className="tiny" style={{ color: "var(--danger)" }}>
          {iAmBuyer ? "Kamu mengajukan sengketa. Diskusikan dengan penjual; dana tetap ditahan." : "Pembeli mengajukan sengketa. Dana ditahan sampai kamu mengembalikan dana atau pembeli menerima barang."}
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
                onClick={() => (a === "ship" || a === "dispute" ? setForm(a) : x.confirm ? setPending(a) : void act(a))}
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
              <strong className="grow">{deal.title}</strong>
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
    </div>
  );
}

// --------------------------------------------------- etalase lawan chat ---

export function CatalogModal({ peer, peerAlias, onClose }: { peer: string; peerAlias: string; onClose: () => void }) {
  const [s, m] = useMessenger();
  const catalog = s.catalogs[peer];
  const [chosen, setChosen] = useState<Product | null>(null);
  const [idem, setIdem] = useState(newKey);
  const { busy, error, run, setError } = useAction();

  useEffect(() => {
    void m.loadCatalog(peer).catch(() => {});
  }, [m, peer]);

  async function buy() {
    if (!chosen) return;
    const deal = await run(() => m.createDeal(peer, chosen.id, idem), "Kesepakatan dibuat. Lanjutkan pembayaran di kartu kesepakatan.");
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
            <strong className="grow">{chosen.title}</strong>
            <SimBadge />
          </div>
          <div className="deal-grid small">
            <span className="muted">Harga (dikunci server)</span>
            <span className="mono">{rupiah(chosen.price)}</span>
            <span className="muted">Fee 2,5% ditanggung penjual</span>
            <span className="mono">{rupiah(platformFee(chosen.price))}</span>
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
            <button key={p.id} className="item" style={{ alignItems: "flex-start" }} onClick={() => setChosen(p)}>
              <div className="grow">
                <div className="row" style={{ gap: 6 }}>
                  <span className="name">{p.title}</span>
                </div>
                <div className="tiny muted">{p.sector}</div>
                {p.description && <div className="small" style={{ color: "var(--text-2)", marginTop: 4, whiteSpace: "pre-wrap" }}>{p.description}</div>}
              </div>
              <strong className="mono" style={{ color: "var(--ok)", whiteSpace: "nowrap" }}>{rupiah(p.price)}</strong>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------ tawaran kustom (PRO) ---

export function OfferModal({ peer, peerAlias, onClose }: { peer: string; peerAlias: string; onClose: () => void }) {
  const [, m] = useMessenger();
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
          {price > 0 && (problem ? <span className="error">{problem}</span> : <span className="hint">Kamu menerima {rupiah(price - platformFee(price))} setelah fee 2,5% ({rupiah(platformFee(price))}).</span>)}
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

const ID_STORE = (me: string) => `pinpath:identity:${me}`;

export function IdentityModal({ peer, peerAlias, onClose }: { peer: string; peerAlias: string; onClose: () => void }) {
  const [s, m] = useMessenger();
  const saved = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(ID_STORE(s.me.id)) ?? "null") as { name: string; address: string; contact: string } | null;
    } catch {
      return null;
    }
  }, [s.me.id]);
  const [name, setName] = useState(saved?.name ?? "");
  const [address, setAddress] = useState(saved?.address ?? "");
  const [contact, setContact] = useState(saved?.contact ?? "");
  const [note, setNote] = useState("");
  const [remember, setRemember] = useState(!!saved);
  const [sure, setSure] = useState(false);

  async function share() {
    const text = [`Nama: ${name.trim()}`, address.trim() && `Alamat: ${address.trim()}`, contact.trim() && `Kontak: ${contact.trim()}`, note.trim() && `Catatan: ${note.trim()}`]
      .filter(Boolean)
      .join("\n");
    try {
      if (remember) localStorage.setItem(ID_STORE(s.me.id), JSON.stringify({ name, address, contact }));
      else localStorage.removeItem(ID_STORE(s.me.id));
    } catch {
      /* penyimpanan diblokir — tidak apa-apa */
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
            Dikirim sebagai pesan <strong>terenkripsi end-to-end</strong> hanya ke {peerAlias}. Server PINPath tidak pernah melihat data ini.
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
  const [tab, setTab] = useState<StoreTab>(s.pro?.active && initial === "pro" ? "products" : initial);
  useEffect(() => {
    if (tab === "wallet") void m.loadWallet();
  }, [m, tab]);

  return (
    <Modal title="Toko & Dompet" onClose={onClose}>
      <div className="stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="small muted">Fitur dagang masih tahap uji — tidak ada uang sungguhan.</span>
          <SimBadge />
        </div>
        <div className="tabs" role="tablist">
          {(
            [
              ["pro", "PRO"],
              ["products", "Etalase"],
              ["wallet", "Dompet"],
            ] as const
          ).map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </div>
        {tab === "pro" && <ProTab />}
        {tab === "products" && (s.pro?.active ? <ProductsTab /> : <ProTab />)}
        {tab === "wallet" && <WalletTab />}
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
          <strong className="grow">PINPath PRO</strong>
          <strong className="mono">{rupiah(pro?.price ?? 49_000)}/bln</strong>
        </div>
        <ul className="small" style={{ margin: "10px 0 0", paddingLeft: 18, color: "var(--text-2)" }}>
          <li>Buka etalase produk/jasa untuk kontakmu</li>
          <li>Tawarkan kesepakatan rekber langsung dari chat</li>
          <li>Fee 2,5% hanya dipotong saat dana cair (tidak saat refund)</li>
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

function ProductsTab() {
  const [s, m] = useMessenger();
  const [editing, setEditing] = useState<Partial<Product> | null>(null);
  const { busy, error, run } = useAction();

  if (editing) return <ProductForm initial={editing} onDone={() => setEditing(null)} />;
  return (
    <div className="stack">
      <button className="btn primary block" onClick={() => setEditing({ sector: SECTORS[0], price: 0 })}>
        <Icon name="plus" /> Tambah produk / jasa
      </button>
      {s.myProducts.length === 0 ? (
        <div className="hint" style={{ textAlign: "center" }}>Etalase masih kosong. Hanya kontakmu yang bisa melihatnya.</div>
      ) : (
        <div className="list">
          {s.myProducts.map((p) => (
            <div key={p.id} className="row" style={{ padding: "8px 4px", borderBottom: "1px solid var(--line)" }}>
              <div className="grow">
                <div className="truncate" style={{ fontWeight: 700 }}>{p.title}</div>
                <div className="tiny muted">{p.sector} · <span className="mono">{rupiah(p.price)}</span></div>
              </div>
              <button className="btn ghost icon" aria-label={`Ubah ${p.title}`} onClick={() => setEditing(p)}>
                <Icon name="edit" />
              </button>
              <button className="btn ghost icon" aria-label={`Hapus ${p.title}`} disabled={busy} onClick={() => void run(() => m.deleteProduct(p.id), "Produk ditarik dari etalase")}>
                <Icon name="trash" />
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}

function ProductForm({ initial, onDone }: { initial: Partial<Product>; onDone: () => void }) {
  const [, m] = useMessenger();
  const [title, setTitle] = useState(initial.title ?? "");
  const [description, setDescription] = useState(initial.description ?? "");
  const [sector, setSector] = useState(initial.sector ?? SECTORS[0]);
  const [price, setPrice] = useState(initial.price ?? 0);
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
      <span className="hint">Penarikan saldo ke rekening baru tersedia setelah PINPath memakai payment gateway berizin.</span>
    </div>
  );
}
