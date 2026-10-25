// Fase 2 — etalase PRO, kesepakatan rekber (escrow) SIMULASI, dan buku besar double-entry.
//
// Prinsip keamanan:
//  - Harga & fee SELALU dihitung server dari data server (klien hanya mengirim id produk).
//  - Setiap perubahan status = UPDATE bersyarat (WHERE status = <yang diharapkan>) di dalam
//    transaksi, jadi klik ganda / request paralel tidak bisa mencairkan dana dua kali.
//  - Pembuatan kesepakatan & langganan idempoten lewat idempotencyKey.
//  - Setiap posting buku besar dijumlah = 0; saldo escrow selalu = total dana yang ditahan.
//  - Data identitas asli TIDAK pernah lewat sini — dibagikan sebagai pesan E2EE di chat.

import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { tx, type DB } from "./db.ts";
import { HttpError, type AuthHandler, type Handler, type Row, type UserRow } from "./http.ts";
import {
  COURIERS,
  DISPUTE_REASONS,
  NO_TRACKING_COURIERS,
  RESOLUTION_REASON_MIN,
  SHIP_NOTE_MAX,
  STATEMENT_MAX,
  STATEMENTS_PER_PARTY,
  TRACKING_RE,
  type DisputeReason,
  type ModDispute,
  MAX_PRODUCTS,
  PRICE_MAX,
  PRICE_MIN,
  PRO_PERIOD_MS,
  PRO_PRICE,
  PRODUCT_DESC_MAX,
  PRODUCT_TITLE_MAX,
  SECTORS,
  platformFee,
  type Deal,
  type DealAction,
  type DealStatus,
  type Product,
  type ProStatus,
  type ServerEvent,
  type Wallet,
} from "../shared/protocol.ts";

export interface CommerceDeps {
  db: DB;
  route: (method: string, path: string, handler: Handler) => void;
  authed: (h: AuthHandler) => Handler;
  readJson: (req: IncomingMessage) => Promise<Row>;
  str: (body: Row, key: string, opts?: { min?: number; max?: number; optional?: boolean }) => string;
  cleanText: (s: string) => string;
  emit: (userId: string, ev: ServerEvent) => void;
  limit: (key: string, max: number, windowMs: number, message: string) => void;
  areContacts: (a: string, b: string) => boolean;
  getUser: (id: string) => UserRow | undefined;
  contactIds: (userId: string) => string[];
  timers: DealTimers;
  isModerator: (u: UserRow) => boolean;
  moderatorIds: () => string[];
}

/**
 * Tenggat yang menjamin dana TIDAK PERNAH tersandera oleh pihak mana pun (temuan red-team F1):
 *  - autoReleaseMs  : SHIPPED tanpa tanggapan pembeli → dana cair ke penjual
 *  - shipWindowMs   : HELD lewat batas kirim → pembeli boleh menarik dana sendiri
 *  - heldRefundMs   : HELD tetap tak dikirim → dana kembali otomatis ke pembeli
 *  - disputeTimeoutMs: sengketa tak selesai → dana kembali ke pembeli (dana belum pernah cair,
 *                     pengiriman tak terbukti). Perlindungan penjual penuh menunggu moderator + bukti kirim.
 */
export interface DealTimers {
  autoReleaseMs: number;
  shipWindowMs: number;
  heldRefundMs: number;
  disputeTimeoutMs: number;
}

const HOUR = 60 * 60 * 1000;
const OPEN_STATUSES: DealStatus[] = ["AWAITING_PAYMENT", "HELD", "SHIPPED", "DISPUTED"];
const HELD_STATUSES: DealStatus[] = ["HELD", "SHIPPED", "DISPUTED"];

type Actor = "buyer" | "seller" | "system" | "moderator";
type Table = Partial<Record<DealStatus, Partial<Record<DealAction, DealStatus>>>>;

/** Tabel transisi: (pelaku, status sekarang, aksi) → status baru. Satu-satunya sumber kebenaran. */
const TRANSITIONS: Record<Actor, Table> = {
  buyer: {
    AWAITING_PAYMENT: { pay: "HELD", cancel: "CANCELLED" },
    HELD: { confirm: "COMPLETED", dispute: "DISPUTED", refund: "REFUNDED" }, // refund: hanya setelah lewat batas kirim
    SHIPPED: { confirm: "COMPLETED", dispute: "DISPUTED" },
    DISPUTED: { confirm: "COMPLETED" }, // pembeli menarik sengketa = menerima barang
  },
  seller: {
    AWAITING_PAYMENT: { cancel: "CANCELLED" },
    HELD: { ship: "SHIPPED", refund: "REFUNDED" },
    SHIPPED: { refund: "REFUNDED" },
    DISPUTED: { refund: "REFUNDED" }, // penjual mengalah = dana kembali ke pembeli
  },
  system: {
    SHIPPED: { confirm: "COMPLETED" }, // pencairan otomatis
    HELD: { refund: "REFUNDED" }, // penjual tak pernah mengirim
    DISPUTED: { refund: "REFUNDED" }, // sengketa kedaluwarsa
  },
  // Moderator HANYA bisa memutus sengketa — tidak bisa menyentuh kesepakatan lain.
  moderator: {
    DISPUTED: { refund: "REFUNDED", confirm: "COMPLETED" },
  },
};

/** Kolom tambahan yang boleh ditulis bersama transisi (daftar putih — tidak ada nama kolom dari input). */
const EXTRA_COLUMNS = ["courier", "tracking", "ship_note", "dispute_reason", "resolution", "resolution_reason", "resolved_by"] as const;
type Extra = Partial<Record<(typeof EXTRA_COLUMNS)[number], string | null>>;

export function registerCommerce(d: CommerceDeps) {
  const { db, route, authed } = d;

  // ------------------------------------------------------------ helpers ---

  const isPro = (u: UserRow | undefined, now = Date.now()) => !!u && u.pro_until > now;
  const proStatus = (u: UserRow): ProStatus => ({ active: isPro(u), proUntil: u.pro_until, price: PRO_PRICE });

  function requirePro(u: UserRow) {
    if (!isPro(u)) throw new HttpError(403, "pro_required", "Fitur ini khusus PRO. Aktifkan langganan PRO dulu.");
  }

  function idemKey(body: Row): string {
    const k = d.str(body, "idempotencyKey", { min: 8, max: 64 });
    if (!/^[A-Za-z0-9_-]+$/.test(k)) throw new HttpError(400, "bad_field", "idempotencyKey tidak valid");
    return k;
  }

  function price(body: Row): number {
    const p = body.price;
    if (typeof p !== "number" || !Number.isSafeInteger(p) || p < PRICE_MIN || p > PRICE_MAX) {
      throw new HttpError(400, "bad_price", `Harga harus bilangan bulat Rp${PRICE_MIN.toLocaleString("id-ID")}–Rp${PRICE_MAX.toLocaleString("id-ID")}`);
    }
    return p;
  }

  function title(body: Row): string {
    const t = d.cleanText(d.str(body, "title", { min: 1, max: PRODUCT_TITLE_MAX * 2 })).slice(0, PRODUCT_TITLE_MAX);
    if (t.length < 3) throw new HttpError(400, "bad_title", "Nama minimal 3 karakter");
    return t;
  }

  /** Posting buku besar; menolak keras bila tidak seimbang (bug = berhenti, bukan uang hilang). */
  function post(ref: string, kind: string, dealId: string | null, entries: [account: string, amount: number][], now: number) {
    const sum = entries.reduce((s, [, a]) => s + a, 0);
    if (sum !== 0 || entries.some(([, a]) => !Number.isSafeInteger(a))) throw new Error(`ledger tidak seimbang: ${ref}`);
    const ins = db.prepare("INSERT INTO ledger (ref, account, amount, kind, deal_id, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (const [account, amount] of entries) ins.run(ref, account, amount, kind, dealId, now);
  }

  function toProduct(r: Row): Product {
    return {
      id: r.id as string,
      ownerId: r.owner_id as string,
      title: r.title as string,
      description: r.description as string,
      sector: r.sector as string,
      price: r.price as number,
      createdAt: r.created_at as number,
    };
  }

  const t = d.timers;

  /** Aksi yang sah untuk pelaku pada saat ini (tabel + aturan waktu). */
  function availableActions(actor: Actor, r: Row, now = Date.now()): DealAction[] {
    const status = r.status as DealStatus;
    return (Object.keys(TRANSITIONS[actor][status] ?? {}) as DealAction[]).filter((a) => {
      // Pembeli baru boleh menarik dana sendiri bila penjual melewati batas kirim.
      if (actor === "buyer" && status === "HELD" && a === "refund") return now >= (r.paid_at as number) + t.shipWindowMs;
      return true;
    });
  }

  function toDeal(r: Row, viewer: string, now = Date.now(), asModerator = false): Deal {
    const status = r.status as DealStatus;
    const role: Actor = asModerator ? "moderator" : r.buyer_id === viewer ? "buyer" : "seller";
    const statements = (
      db.prepare("SELECT role, text, created_at FROM deal_statements WHERE deal_id = ? ORDER BY created_at ASC, id ASC").all(r.id as string) as Row[]
    ).map((s) => ({ role: s.role as "buyer" | "seller", text: s.text as string, createdAt: s.created_at as number }));
    const shippedAt = (r.shipped_at as number | null) ?? null;
    const paidAt = (r.paid_at as number | null) ?? null;
    const disputedAt = (r.disputed_at as number | null) ?? null;
    return {
      id: r.id as string,
      buyerId: r.buyer_id as string,
      sellerId: r.seller_id as string,
      createdBy: r.created_by as string,
      productId: (r.product_id as string | null) ?? null,
      title: r.title as string,
      price: r.price as number,
      fee: r.fee as number,
      sellerNet: (r.price as number) - (r.fee as number),
      status,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      paidAt,
      shippedAt,
      closedAt: (r.closed_at as number | null) ?? null,
      autoReleaseAt: status === "SHIPPED" && shippedAt ? shippedAt + t.autoReleaseMs : null,
      shipBy: status === "HELD" && paidAt ? paidAt + t.shipWindowMs : null,
      autoRefundAt:
        status === "HELD" && paidAt ? paidAt + t.heldRefundMs : status === "DISPUTED" && disputedAt ? disputedAt + t.disputeTimeoutMs : null,
      actions: availableActions(role, r, now),
      shipment: r.courier ? { courier: r.courier as string, tracking: (r.tracking as string | null) ?? null, note: (r.ship_note as string | null) ?? "" } : null,
      disputeReason: (r.dispute_reason as DisputeReason | null) ?? null,
      statements,
      resolution: r.resolution
        ? { decision: r.resolution as "refund" | "release", reason: (r.resolution_reason as string) ?? "", at: (r.closed_at as number) ?? (r.updated_at as number) }
        : null,
    };
  }

  function notifyDeal(r: Row) {
    d.emit(r.buyer_id as string, { t: "deals_changed", peer: r.seller_id as string });
    d.emit(r.seller_id as string, { t: "deals_changed", peer: r.buyer_id as string });
  }

  function notifyContactsProducts(ownerId: string) {
    for (const id of [ownerId, ...d.contactIds(ownerId)]) d.emit(id, { t: "products_changed", owner: ownerId });
  }

  const getDeal = (id: string) => db.prepare("SELECT * FROM deals WHERE id = ?").get(id) as Row | undefined;

  /**
   * Jalankan satu transisi status secara atomik. Mengembalikan baris terbaru,
   * atau melempar 409 bila status sudah berubah (klik ganda / request paralel).
   */
  function transition(dealId: string, actor: Actor, action: DealAction, now = Date.now(), extra: Extra = {}): Row {
    return tx(db, () => {
      const r = getDeal(dealId);
      if (!r) throw new HttpError(404, "not_found", "Kesepakatan tidak ditemukan");
      const from = r.status as DealStatus;
      const to = TRANSITIONS[actor][from]?.[action];
      if (!to || !availableActions(actor, r, now).includes(action)) {
        const early = actor === "buyer" && from === "HELD" && action === "refund";
        throw new HttpError(409, "bad_transition", early ? "Penjual masih dalam batas waktu pengiriman. Tarik dana bisa dilakukan setelah batas itu lewat." : "Aksi ini tidak bisa dilakukan pada status kesepakatan sekarang");
      }

      const stamp =
        action === "pay" ? "paid_at" : action === "ship" ? "shipped_at" : action === "dispute" ? "disputed_at" : ["confirm", "refund", "cancel"].includes(action) ? "closed_at" : null;
      const extraCols = EXTRA_COLUMNS.filter((c) => c in extra);
      const sets = ["status = ?", "updated_at = ?", ...(stamp ? [`${stamp} = ?`] : []), ...extraCols.map((c) => `${c} = ?`)];
      const { changes } = db
        .prepare(`UPDATE deals SET ${sets.join(", ")} WHERE id = ? AND status = ?`)
        .run(...([to, now, ...(stamp ? [now] : []), ...extraCols.map((c) => extra[c] ?? null), dealId, from] as (string | number | null)[]));
      if (Number(changes) !== 1) throw new HttpError(409, "conflict", "Status kesepakatan sudah berubah. Muat ulang.");

      const p = r.price as number;
      const fee = r.fee as number;
      const ref = `${action}:${dealId}`;
      if (action === "pay") post(ref, "deal_payment", dealId, [[`external:${r.buyer_id}`, -p], ["escrow", p]], now);
      if (action === "confirm") post(ref, "deal_release", dealId, [["escrow", -p], [`user:${r.seller_id}`, p - fee], ["platform", fee]], now);
      if (action === "refund") post(ref, "deal_refund", dealId, [["escrow", -p], [`external:${r.buyer_id}`, p]], now);
      return getDeal(dealId)!;
    });
  }

  // ------------------------------------------------------------- PRO ---

  route("GET", "/api/pro", authed(({ user }) => proStatus(user)));

  route("POST", "/api/pro/subscribe", authed(async ({ req, user }) => {
    const key = idemKey(await d.readJson(req));
    d.limit(`pro:${user.id}`, 10, HOUR, "Terlalu banyak percobaan langganan.");
    const now = Date.now();
    tx(db, () => {
      if (db.prepare("SELECT 1 FROM subscriptions WHERE user_id = ? AND idem_key = ?").get(user.id, key)) return; // sudah diproses
      const fresh = d.getUser(user.id)!;
      const periodEnd = Math.max(now, fresh.pro_until) + PRO_PERIOD_MS;
      const ref = `sub:${randomUUID()}`;
      db.prepare("INSERT INTO subscriptions (ref, user_id, idem_key, amount, period_end, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(ref, user.id, key, PRO_PRICE, periodEnd, now);
      post(ref, "subscription", null, [[`external:${user.id}`, -PRO_PRICE], ["platform", PRO_PRICE]], now);
      db.prepare("UPDATE users SET pro_until = ? WHERE id = ?").run(periodEnd, user.id);
    });
    notifyContactsProducts(user.id);
    return proStatus(d.getUser(user.id)!);
  }));

  // -------------------------------------------------------- etalase ---

  route("GET", "/api/products/mine", authed(({ user }) => ({
    pro: proStatus(user),
    products: (db.prepare("SELECT * FROM products WHERE owner_id = ? AND active = 1 ORDER BY created_at DESC").all(user.id) as Row[]).map(toProduct),
  })));

  route("GET", "/api/users/:id/products", authed(({ user, params }) => {
    const owner = d.getUser(params.id);
    // Etalase hanya untuk kontak yang sudah disetujui (bukan publik) — mengurangi penipu yang menyebar katalog.
    if (!owner || (owner.id !== user.id && !d.areContacts(user.id, owner.id))) throw new HttpError(404, "not_found", "Etalase tidak ditemukan");
    if (!isPro(owner)) return { pro: false, products: [] };
    const rows = db.prepare("SELECT * FROM products WHERE owner_id = ? AND active = 1 ORDER BY created_at DESC").all(owner.id) as Row[];
    return { pro: true, products: rows.map(toProduct) };
  }));

  route("POST", "/api/products", authed(async ({ req, user }) => {
    requirePro(user);
    d.limit(`product-write:${user.id}`, 60, HOUR, "Terlalu banyak perubahan etalase dalam satu jam.");
    const body = await d.readJson(req);
    const sector = d.str(body, "sector", { min: 1, max: 40 });
    if (!(SECTORS as readonly string[]).includes(sector)) throw new HttpError(400, "bad_sector", "Sektor tidak dikenal");
    const description = d.cleanText(d.str(body, "description", { max: PRODUCT_DESC_MAX * 2, optional: true })).slice(0, PRODUCT_DESC_MAX);
    const t = title(body);
    const p = price(body);
    const count = db.prepare("SELECT COUNT(*) AS n FROM products WHERE owner_id = ? AND active = 1").get(user.id) as { n: number };
    if (count.n >= MAX_PRODUCTS) throw new HttpError(409, "too_many_products", `Maksimal ${MAX_PRODUCTS} produk aktif`);
    const id = randomUUID();
    const now = Date.now();
    db.prepare("INSERT INTO products (id, owner_id, title, description, sector, price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, user.id, t, description, sector, p, now, now);
    notifyContactsProducts(user.id);
    return toProduct(db.prepare("SELECT * FROM products WHERE id = ?").get(id) as Row);
  }));

  route("PATCH", "/api/products/:id", authed(async ({ req, user, params }) => {
    requirePro(user);
    d.limit(`product-write:${user.id}`, 60, HOUR, "Terlalu banyak perubahan etalase dalam satu jam.");
    const row = db.prepare("SELECT * FROM products WHERE id = ? AND owner_id = ? AND active = 1").get(params.id, user.id) as Row | undefined;
    if (!row) throw new HttpError(404, "not_found", "Produk tidak ditemukan");
    const body = await d.readJson(req);
    const next = {
      title: body.title !== undefined ? title(body) : (row.title as string),
      description: body.description !== undefined ? d.cleanText(d.str(body, "description", { max: PRODUCT_DESC_MAX * 2 })).slice(0, PRODUCT_DESC_MAX) : (row.description as string),
      sector: row.sector as string,
      price: body.price !== undefined ? price(body) : (row.price as number),
    };
    if (body.sector !== undefined) {
      const s = d.str(body, "sector", { min: 1, max: 40 });
      if (!(SECTORS as readonly string[]).includes(s)) throw new HttpError(400, "bad_sector", "Sektor tidak dikenal");
      next.sector = s;
    }
    // Kesepakatan yang sudah dibuat memakai harga snapshot — ubah harga tidak memengaruhinya.
    db.prepare("UPDATE products SET title = ?, description = ?, sector = ?, price = ?, updated_at = ? WHERE id = ?").run(next.title, next.description, next.sector, next.price, Date.now(), params.id);
    notifyContactsProducts(user.id);
    return toProduct(db.prepare("SELECT * FROM products WHERE id = ?").get(params.id) as Row);
  }));

  route("DELETE", "/api/products/:id", authed(({ user, params }) => {
    const { changes } = db.prepare("UPDATE products SET active = 0, updated_at = ? WHERE id = ? AND owner_id = ? AND active = 1").run(Date.now(), params.id, user.id);
    if (Number(changes) === 0) throw new HttpError(404, "not_found", "Produk tidak ditemukan");
    notifyContactsProducts(user.id);
    return { ok: true };
  }));

  // ------------------------------------------------------ kesepakatan ---

  function insertDeal(fields: { buyer: string; seller: string; createdBy: string; productId: string | null; title: string; price: number; key: string }) {
    const now = Date.now();
    return tx(db, () => {
      const existing = db.prepare("SELECT * FROM deals WHERE created_by = ? AND idem_key = ?").get(fields.createdBy, fields.key) as Row | undefined;
      if (existing) {
        // Kunci yang sama hanya sah untuk permintaan yang SAMA; dipakai untuk hal lain → tolak,
        // jangan diam-diam mengembalikan kesepakatan lama (temuan red-team F2).
        const same =
          existing.buyer_id === fields.buyer &&
          existing.seller_id === fields.seller &&
          (existing.product_id ?? null) === fields.productId &&
          (fields.productId !== null || (existing.title === fields.title && existing.price === fields.price));
        if (!same) throw new HttpError(409, "idem_conflict", "Kunci permintaan sudah dipakai untuk kesepakatan lain. Muat ulang lalu coba lagi.");
        return { row: existing, created: false };
      }
      const open = db.prepare("SELECT COUNT(*) AS n FROM deals WHERE (buyer_id = ? OR seller_id = ?) AND status = 'AWAITING_PAYMENT'").get(fields.createdBy, fields.createdBy) as { n: number };
      if (open.n >= 30) throw new HttpError(429, "too_many_open", "Terlalu banyak kesepakatan menunggu pembayaran. Selesaikan/batalkan sebagian dulu.");
      const id = randomUUID();
      db.prepare(
        `INSERT INTO deals (id, buyer_id, seller_id, created_by, product_id, title, price, fee, status, idem_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AWAITING_PAYMENT', ?, ?, ?)`,
      ).run(id, fields.buyer, fields.seller, fields.createdBy, fields.productId, fields.title, fields.price, platformFee(fields.price), fields.key, now, now);
      return { row: getDeal(id)!, created: true };
    });
  }

  // Pembeli membuat kesepakatan dari produk etalase.
  route("POST", "/api/deals", authed(async ({ req, user }) => {
    const body = await d.readJson(req);
    const key = idemKey(body);
    const productId = d.str(body, "productId", { min: 1, max: 64 });
    d.limit(`deal-create:${user.id}`, 20, HOUR, "Terlalu banyak kesepakatan dibuat dalam satu jam.");
    const prod = db.prepare("SELECT * FROM products WHERE id = ? AND active = 1").get(productId) as Row | undefined;
    if (!prod) throw new HttpError(404, "not_found", "Produk tidak ditemukan atau sudah ditarik");
    const seller = d.getUser(prod.owner_id as string);
    if (!seller || seller.id === user.id) throw new HttpError(400, "own_product", "Tidak bisa membeli produk sendiri");
    if (!d.areContacts(user.id, seller.id)) throw new HttpError(404, "not_found", "Produk tidak ditemukan atau sudah ditarik");
    if (!isPro(seller)) throw new HttpError(409, "seller_not_pro", "Etalase penjual sedang tidak aktif");
    const { row, created } = insertDeal({ buyer: user.id, seller: seller.id, createdBy: user.id, productId, title: prod.title as string, price: prod.price as number, key });
    if (created) notifyDeal(row);
    return toDeal(row, user.id);
  }));

  // Penjual PRO menawarkan kesepakatan kustom dari chat (tombol jabat tangan).
  route("POST", "/api/deals/offer", authed(async ({ req, user }) => {
    requirePro(user);
    const body = await d.readJson(req);
    const key = idemKey(body);
    const buyerId = d.str(body, "buyerId", { min: 1, max: 64 });
    const t = title(body);
    const p = price(body);
    d.limit(`deal-create:${user.id}`, 20, HOUR, "Terlalu banyak kesepakatan dibuat dalam satu jam.");
    if (buyerId === user.id || !d.areContacts(user.id, buyerId)) throw new HttpError(404, "not_found", "Kontak tidak ditemukan");
    const { row, created } = insertDeal({ buyer: buyerId, seller: user.id, createdBy: user.id, productId: null, title: t, price: p, key });
    if (created) notifyDeal(row);
    return toDeal(row, user.id);
  }));

  route("GET", "/api/deals", authed(({ user, url }) => {
    const peer = url.searchParams.get("peer");
    const rows = peer
      ? (db
          .prepare("SELECT * FROM deals WHERE (buyer_id = ? AND seller_id = ?) OR (buyer_id = ? AND seller_id = ?) ORDER BY created_at ASC LIMIT 200")
          .all(user.id, peer, peer, user.id) as Row[])
      : (db.prepare("SELECT * FROM deals WHERE buyer_id = ? OR seller_id = ? ORDER BY updated_at DESC LIMIT 100").all(user.id, user.id) as Row[]);
    return { deals: rows.map((r) => toDeal(r, user.id)) };
  }));

  // Pernyataan sengketa untuk moderator (didaftarkan SEBELUM /:id/:action agar tidak tertangkap pola itu).
  route("POST", "/api/deals/:id/statements", authed(async ({ req, user, params }) => {
    const r = getDeal(params.id);
    if (!r || (r.buyer_id !== user.id && r.seller_id !== user.id)) throw new HttpError(404, "not_found", "Kesepakatan tidak ditemukan");
    if (r.status !== "DISPUTED") throw new HttpError(409, "not_disputed", "Pernyataan hanya bisa dikirim saat sengketa berjalan");
    const text = d.cleanText(d.str(await d.readJson(req), "text", { min: 1, max: STATEMENT_MAX * 2 })).slice(0, STATEMENT_MAX);
    if (text.length < 5) throw new HttpError(400, "bad_statement", "Pernyataan terlalu pendek");
    const role = r.buyer_id === user.id ? "buyer" : "seller";
    const count = db.prepare("SELECT COUNT(*) AS n FROM deal_statements WHERE deal_id = ? AND author_id = ?").get(r.id as string, user.id) as { n: number };
    if (count.n >= STATEMENTS_PER_PARTY) throw new HttpError(429, "too_many_statements", `Maksimal ${STATEMENTS_PER_PARTY} pernyataan per pihak`);
    db.prepare("INSERT INTO deal_statements (deal_id, author_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)").run(r.id as string, user.id, role, text, Date.now());
    notifyDeal(r);
    notifyModerators();
    return toDeal(getDeal(params.id)!, user.id);
  }));

  route("POST", "/api/deals/:id/:action", authed(async ({ req, user, params }) => {
    const action = params.action as DealAction;
    if (!["pay", "ship", "confirm", "cancel", "refund", "dispute"].includes(action)) throw new HttpError(404, "not_found", "Aksi tidak dikenal");
    d.limit(`deal-action:${user.id}`, 120, HOUR, "Terlalu banyak aksi kesepakatan.");
    const r = getDeal(params.id);
    if (!r || (r.buyer_id !== user.id && r.seller_id !== user.id)) throw new HttpError(404, "not_found", "Kesepakatan tidak ditemukan");
    const role = r.buyer_id === user.id ? "buyer" : "seller";
    // Membayar butuh hubungan yang masih aktif; aksi penyelesaian (refund/konfirmasi) tetap boleh
    // walau sudah diblokir — supaya dana tidak pernah tersandera.
    if (action === "pay" && !d.areContacts(r.buyer_id as string, r.seller_id as string)) {
      throw new HttpError(409, "not_contacts", "Kalian tidak lagi terhubung — pembayaran dibatalkan demi keamanan");
    }
    // Periksa hak lebih dulu (pesan jelas), baru validasi isi. transition() memeriksa ulang secara atomik.
    if (!availableActions(role, r).includes(action)) {
      const early = role === "buyer" && r.status === "HELD" && action === "refund";
      throw new HttpError(409, "bad_transition", early ? "Penjual masih dalam batas waktu pengiriman. Tarik dana bisa dilakukan setelah batas itu lewat." : "Aksi ini tidak bisa dilakukan pada status kesepakatan sekarang");
    }

    let extra: Extra = {};
    let statement: string | null = null;
    if (action === "ship") {
      // Bukti kirim WAJIB: dasar moderator memutus sengketa dan perlindungan penjual jujur.
      const body = await d.readJson(req);
      const courier = d.str(body, "courier", { min: 1, max: 60 });
      if (!(COURIERS as readonly string[]).includes(courier)) throw new HttpError(400, "bad_courier", "Pilih kurir dari daftar");
      const note = d.cleanText(d.str(body, "note", { max: SHIP_NOTE_MAX * 2, optional: true })).slice(0, SHIP_NOTE_MAX);
      const rawTracking = d.str(body, "tracking", { max: 60, optional: true }).trim().toUpperCase();
      if (NO_TRACKING_COURIERS.includes(courier)) {
        if (note.length < 10) throw new HttpError(400, "note_required", "Jelaskan cara penyerahan (min. 10 karakter), mis. waktu & tempat serah terima");
      } else if (!TRACKING_RE.test(rawTracking)) {
        throw new HttpError(400, "bad_tracking", "Nomor resi wajib diisi (6–40 huruf/angka)");
      }
      extra = { courier, tracking: rawTracking || null, ship_note: note };
    }
    if (action === "dispute") {
      const body = await d.readJson(req);
      const reason = d.str(body, "reason", { min: 1, max: 40 });
      if (!(reason in DISPUTE_REASONS)) throw new HttpError(400, "bad_reason", "Pilih alasan sengketa");
      statement = d.cleanText(d.str(body, "text", { min: 1, max: STATEMENT_MAX * 2 })).slice(0, STATEMENT_MAX);
      if (statement.length < 10) throw new HttpError(400, "bad_statement", "Ceritakan masalahnya (min. 10 karakter) agar moderator bisa menilai");
      extra = { dispute_reason: reason };
    }

    const now = Date.now();
    const updated = transition(params.id, role, action, now, extra);
    if (statement) {
      db.prepare("INSERT INTO deal_statements (deal_id, author_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)").run(params.id, user.id, role, statement, now);
      notifyModerators();
    }
    notifyDeal(updated);
    return toDeal(updated, user.id);
  }));

  // -------------------------------------------------------- moderator ---

  function notifyModerators() {
    for (const id of d.moderatorIds()) d.emit(id, { t: "mod_queue_changed" });
  }

  function requireModerator(u: UserRow) {
    if (!d.isModerator(u)) throw new HttpError(404, "not_found", "Endpoint tidak ditemukan"); // jangan bocorkan keberadaan panel moderator
  }

  function toModDispute(r: Row, mod: UserRow): ModDispute {
    const buyer = d.getUser(r.buyer_id as string);
    const seller = d.getUser(r.seller_id as string);
    return {
      deal: toDeal(r, mod.id, Date.now(), true),
      buyer: { id: r.buyer_id as string, alias: buyer?.alias ?? "(akun dihapus)" },
      seller: { id: r.seller_id as string, alias: seller?.alias ?? "(akun dihapus)" },
    };
  }

  route("GET", "/api/mod/disputes", authed(({ user }) => {
    requireModerator(user);
    const open = db.prepare("SELECT * FROM deals WHERE status = 'DISPUTED' ORDER BY disputed_at ASC LIMIT 100").all() as Row[];
    const recent = db
      .prepare("SELECT * FROM deals WHERE resolution IS NOT NULL ORDER BY closed_at DESC LIMIT 20")
      .all() as Row[];
    return { open: open.map((r) => toModDispute(r, user)), resolved: recent.map((r) => toModDispute(r, user)) };
  }));

  route("POST", "/api/mod/disputes/:id/resolve", authed(async ({ req, user, params }) => {
    requireModerator(user);
    d.limit(`mod-resolve:${user.id}`, 60, HOUR, "Terlalu banyak keputusan dalam satu jam.");
    const body = await d.readJson(req);
    const decision = d.str(body, "decision", { min: 1, max: 10 });
    if (decision !== "refund" && decision !== "release") throw new HttpError(400, "bad_decision", "Keputusan harus refund atau release");
    const reason = d.cleanText(d.str(body, "reason", { min: 1, max: 1000 })).slice(0, 500);
    if (reason.length < RESOLUTION_REASON_MIN) throw new HttpError(400, "reason_required", `Alasan keputusan wajib (min. ${RESOLUTION_REASON_MIN} karakter) — akan dibaca kedua pihak`);
    const r = getDeal(params.id);
    if (!r) throw new HttpError(404, "not_found", "Kesepakatan tidak ditemukan");
    // Konflik kepentingan: moderator tidak boleh memutus kesepakatannya sendiri.
    if (r.buyer_id === user.id || r.seller_id === user.id) throw new HttpError(403, "conflict_of_interest", "Kamu terlibat dalam kesepakatan ini");
    const now = Date.now();
    const updated = tx(db, () => {
      const out = transition(params.id, "moderator", decision === "refund" ? "refund" : "confirm", now, {
        resolution: decision,
        resolution_reason: reason,
        resolved_by: user.id,
      });
      db.prepare("INSERT INTO moderation_log (deal_id, moderator_id, decision, reason, created_at) VALUES (?, ?, ?, ?, ?)").run(params.id, user.id, decision, reason, now);
      return out;
    });
    notifyDeal(updated);
    notifyModerators();
    return toModDispute(updated, user);
  }));

  // ---------------------------------------------------------- dompet ---

  route("GET", "/api/wallet", authed(({ user }): Wallet => {
    const sum = (sql: string, ...args: (string | number)[]) => ((db.prepare(sql).get(...args) as { s: number | null }).s ?? 0);
    const held = HELD_STATUSES.map(() => "?").join(",");
    return {
      balance: sum("SELECT SUM(amount) AS s FROM ledger WHERE account = ?", `user:${user.id}`),
      incomingHeld: sum(`SELECT SUM(price - fee) AS s FROM deals WHERE seller_id = ? AND status IN (${held})`, user.id, ...HELD_STATUSES),
      outgoingHeld: sum(`SELECT SUM(price) AS s FROM deals WHERE buyer_id = ? AND status IN (${held})`, user.id, ...HELD_STATUSES),
      entries: (
        db
          .prepare("SELECT id, amount, kind, deal_id, created_at FROM ledger WHERE account IN (?, ?) ORDER BY id DESC LIMIT 50")
          .all(`user:${user.id}`, `external:${user.id}`) as Row[]
      ).map((r) => ({ id: r.id as number, amount: r.amount as number, kind: r.kind as string, dealId: (r.deal_id as string | null) ?? null, createdAt: r.created_at as number })),
    };
  }));

  // ---------------------------------------------------- perawatan ---

  /**
   * Jalankan semua tenggat: cair otomatis (SHIPPED), refund otomatis bila penjual tak pernah
   * mengirim (HELD), dan refund otomatis bila sengketa kedaluwarsa (DISPUTED).
   */
  function runTimers(now = Date.now()): { released: number; refunded: number } {
    const due: [string, DealAction][] = [
      ...(db.prepare("SELECT id FROM deals WHERE status = 'SHIPPED' AND shipped_at <= ?").all(now - t.autoReleaseMs) as { id: string }[]).map(
        (r): [string, DealAction] => [r.id, "confirm"],
      ),
      ...(db.prepare("SELECT id FROM deals WHERE status = 'HELD' AND paid_at <= ?").all(now - t.heldRefundMs) as { id: string }[]).map(
        (r): [string, DealAction] => [r.id, "refund"],
      ),
    ];
    const expiredDisputes = db.prepare("SELECT id FROM deals WHERE status = 'DISPUTED' AND disputed_at <= ?").all(now - t.disputeTimeoutMs) as { id: string }[];
    const out = { released: 0, refunded: 0 };
    for (const { id } of expiredDisputes) {
      try {
        // Dicatat sebagai putusan sistem agar kedua pihak tahu alasannya.
        notifyDeal(
          transition(id, "system", "refund", now, {
            resolution: "refund",
            resolution_reason: "Sengketa tidak terselesaikan dalam batas waktu — dana yang belum pernah cair dikembalikan ke pembeli.",
            resolved_by: "system",
          }),
        );
        out.refunded++;
      } catch {
        /* status berubah bersamaan — abaikan */
      }
    }
    if (expiredDisputes.length) notifyModerators();
    for (const [id, action] of due) {
      try {
        notifyDeal(transition(id, "system", action, now));
        if (action === "confirm") out.released++;
        else out.refunded++;
      } catch {
        /* status berubah bersamaan — abaikan */
      }
    }
    return out;
  }

  /** Untuk audit & tes: total ledger harus 0, dan saldo escrow = dana yang sedang ditahan. */
  function audit() {
    const total = (db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM ledger").get() as { s: number }).s;
    const escrow = (db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM ledger WHERE account = 'escrow'").get() as { s: number }).s;
    const held = (db.prepare(`SELECT COALESCE(SUM(price), 0) AS s FROM deals WHERE status IN ('HELD','SHIPPED','DISPUTED')`).get() as { s: number }).s;
    const platform = (db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM ledger WHERE account = 'platform'").get() as { s: number }).s;
    return { total, escrow, held, platform, balanced: total === 0 && escrow === held };
  }

  function hasOpenDeals(userId: string): boolean {
    const placeholders = OPEN_STATUSES.map(() => "?").join(",");
    return !!db.prepare(`SELECT 1 FROM deals WHERE (buyer_id = ? OR seller_id = ?) AND status IN (${placeholders}) LIMIT 1`).get(userId, userId, ...OPEN_STATUSES);
  }

  return { runTimers, audit, hasOpenDeals };
}
