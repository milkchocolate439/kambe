// Etalase Hantu — katalog yang tinggal di HP penjual (terenkripsi, hangus 72 jam) dan dikirim
// langsung ke pembeli lewat jalur E2EE. Teks dari lawan dirender sebagai teks (React) — tanpa innerHTML.
import { useEffect, useState } from "react";
import { GHOST_DESC_MAX, GHOST_MAX_ITEMS, GHOST_TITLE_MAX } from "../../../shared/ctl.ts";
import { PRICE_MAX, PRICE_MIN } from "../../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { Modal, useMessenger } from "./common.tsx";
import { Icon } from "./icons.tsx";

const rupiah = (n: number) => "Rp" + n.toLocaleString("id-ID");

/** "hangus dalam 2 hari 3 jam" / "tinggal 5 jam" / "sudah hangus". */
export function expiryText(at: number, now = Date.now()): string {
  const ms = at - now;
  if (ms <= 0) return "sudah hangus";
  const h = Math.floor(ms / 3_600_000);
  if (h >= 24) return `hangus dalam ${Math.floor(h / 24)} hari ${h % 24} jam`;
  if (h >= 1) return `hangus dalam ${h} jam`;
  return `hangus dalam ${Math.max(1, Math.floor(ms / 60_000))} menit`;
}

export function GhostStoreModal({ peer, peerAlias, onClose }: { peer: string; peerAlias: string; onClose: () => void }) {
  const [, m] = useMessenger();
  const [tab, setTab] = useState<"peer" | "mine">("peer");

  // Etalase lawan diminta saat dibuka & dibuang dari memori saat ditutup.
  useEffect(() => {
    void m.requestGhostStore(peer);
    return () => m.clearGhostView(peer);
  }, [m, peer]);

  return (
    <Modal title="Etalase Hantu" onClose={onClose}>
      <div className="stack">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "peer"} onClick={() => setTab("peer")}>
            Etalase {peerAlias}
          </button>
          <button role="tab" aria-selected={tab === "mine"} onClick={() => setTab("mine")}>
            Etalase Saya (3 hari)
          </button>
        </div>
        {tab === "peer" ? <PeerView peer={peer} peerAlias={peerAlias} /> : <MyView />}
      </div>
    </Modal>
  );
}

function PeerView({ peer, peerAlias }: { peer: string; peerAlias: string }) {
  const [s, m] = useMessenger();
  const view = s.ghostViews[peer];
  const orders = Object.values(s.ghostOrders).filter((o) => o.peer === peer);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!view || view.state === "loading") {
    return (
      <div className="empty" role="status">
        <div className="icon-wrap">
          <Icon name="clock" size={26} />
        </div>
        <div className="small">Menghubungi HP {peerAlias}… katalog dikirim langsung dari perangkatnya, lewat jalur terenkripsi.</div>
      </div>
    );
  }
  if (view.state === "offline") {
    return (
      <div className="empty">
        <div className="icon-wrap">
          <Icon name="wifiOff" size={26} />
        </div>
        <div className="small">HP {peerAlias} belum menjawab (mungkin sedang offline). Etalase hanya bisa dilihat saat perangkat penjual menyala.</div>
        <button className="btn" onClick={() => void m.requestGhostStore(peer)}>
          <Icon name="refresh" size={15} /> Coba lagi
        </button>
      </div>
    );
  }
  if (view.items.length === 0) {
    return (
      <div className="empty">
        <div className="icon-wrap">
          <Icon name="store" size={26} />
        </div>
        <div className="small">{peerAlias} belum memajang barang (atau semuanya sudah hangus).</div>
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="hint">
        <Icon name="lock" size={12} /> Katalog ini hanya ada di layarmu — tidak disimpan. Memesan membuat <strong>tawaran rekber</strong> di chat; uang baru bergerak saat kamu membayar.
      </div>
      <div className="list">
        {view.items.map((it) => {
          const order = orders.find((o) => o.itemId === it.id);
          return (
            <div key={it.id} className="item" style={{ alignItems: "flex-start", cursor: "default" }}>
              <div className="grow">
                <span className="name">{it.title}</span>
                {it.description && (
                  <div className="small" style={{ color: "var(--text-2)", marginTop: 4, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {it.description}
                  </div>
                )}
                <div className="tiny muted" style={{ marginTop: 4 }}>
                  {expiryText(it.expiresAt)}
                </div>
              </div>
              <div className="stack" style={{ alignItems: "flex-end", gap: 6 }}>
                <strong className="mono" style={{ color: "var(--ok)", whiteSpace: "nowrap" }}>{rupiah(it.price)}</strong>
                {order?.state === "sent" ? (
                  <span className="badge warn">Menunggu penjual…</span>
                ) : order?.state === "done" ? (
                  <span className="badge ok">Tawaran masuk di chat</span>
                ) : (
                  <button className="btn primary small" onClick={() => void m.orderGhostItem(peer, it.id)}>
                    <Icon name="handshake" size={15} /> {order?.state === "nack" ? "Pesan lagi" : "Pesan"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MyView() {
  const [s, m] = useMessenger();
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [price, setPrice] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const items = s.ghostStore?.items;

  useEffect(() => {
    void m.loadGhostStore();
  }, [m]);

  const problem = !title.trim() ? "Isi nama barang" : price < PRICE_MIN ? `Harga minimal ${rupiah(PRICE_MIN)}` : price > PRICE_MAX ? `Harga maksimal ${rupiah(PRICE_MAX)}` : null;

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await m.addGhostItem({ title, description: desc, price });
      setTitle("");
      setDesc("");
      setPrice(0);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Gagal menyimpan");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="hint">
        <Icon name="clock" size={12} /> Barangmu hangus otomatis 72 jam setelah dipajang. Katalog tersimpan terenkripsi di perangkat ini dan dikirim langsung ke kontak yang membukanya — server tidak menyimpannya. Memesan butuh akun PRO agar rekber bisa dibuat.
      </div>
      <div className="stack card">
        <div className="field">
          <label htmlFor="gs-title">Nama barang / jasa</label>
          <input id="gs-title" className="input" maxLength={GHOST_TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="mis. Arabica Gayo 1 Kg" />
        </div>
        <div className="field">
          <label htmlFor="gs-price">Harga</label>
          <input
            id="gs-price"
            className="input mono"
            inputMode="numeric"
            value={price ? price.toLocaleString("id-ID") : ""}
            onChange={(e) => setPrice(Math.min(PRICE_MAX * 10, Number(e.target.value.replace(/\D/g, "")) || 0))}
            placeholder="0"
          />
        </div>
        <div className="field">
          <label htmlFor="gs-desc">Deskripsi (opsional)</label>
          <textarea id="gs-desc" className="textarea" rows={2} maxLength={GHOST_DESC_MAX} value={desc} onChange={(e) => setDesc(e.target.value)} />
        </div>
        {error && <span className="error" role="alert">{error}</span>}
        <button className="btn primary block" disabled={busy || !!problem} onClick={() => void add()}>
          <Icon name="plus" size={15} /> {problem ?? "Pajang di Etalase Hantu"}
        </button>
      </div>
      <div className="row">
        <strong className="grow">
          Barangku ({items?.length ?? 0}/{GHOST_MAX_ITEMS})
        </strong>
        {!!items?.length && (
          <button className="btn small" onClick={() => void m.extendGhostItems()}>
            <Icon name="refresh" size={14} /> Perpanjang semua 72 jam
          </button>
        )}
      </div>
      {items && items.length === 0 && <div className="hint">Belum ada barang yang dipajang.</div>}
      <div className="list">
        {items?.map((it) => (
          <div key={it.id} className="item" style={{ alignItems: "flex-start", cursor: "default" }}>
            <div className="grow">
              <span className="name">{it.title}</span>
              <div className="tiny muted">
                {rupiah(it.price)} · {expiryText(it.expiresAt)}
              </div>
            </div>
            <button className="btn ghost icon" onClick={() => void m.extendGhostItems(it.id)} aria-label={`Perpanjang ${it.title}`} title="Perpanjang 72 jam">
              <Icon name="refresh" size={16} />
            </button>
            <button className="btn ghost icon" onClick={() => void m.removeGhostItem(it.id)} aria-label={`Hapus ${it.title}`} title="Hapus">
              <Icon name="trash" size={16} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
