// Fase 2 — etalase PRO, kesepakatan rekber (escrow) SIMULASI, dan buku besar double-entry.
//
// Prinsip keamanan:
//  - Harga & fee SELALU dihitung server dari data server (klien hanya mengirim id produk).
//  - Setiap perubahan status = UPDATE bersyarat (WHERE status = <yang diharapkan>) di dalam
//    transaksi, jadi klik ganda / request paralel tidak bisa mencairkan dana dua kali.
//  - Pembuatan kesepakatan & langganan idempoten lewat idempotencyKey.
//  - Setiap posting buku besar dijumlah = 0; saldo escrow selalu = total dana yang ditahan.
//  - Data identitas asli TIDAK pernah lewat sini — dibagikan sebagai pesan E2EE di chat.
//  - SEMUA isi (nama/deskripsi/sektor produk, judul kesepakatan, bukti kirim, pernyataan sengketa,
//    alasan putusan) adalah sealed object terenkripsi. Server hanya tahu nominal (wajib untuk fee &
//    rekber), status, pihak, dan waktu.

import type { IncomingMessage } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Notary } from "./notary.ts";
import type { PaymentProvider } from "./payments.ts";
import { RECEIPT_KIND, type ReceiptBody, type SignedReceipt } from "../shared/receipt.ts";
import { tx, type DB } from "./db.ts";
import { HttpError, type AuthHandler, type Handler, type Row, type UserRow } from "./http.ts";
import type { SealedStore } from "./sealed.ts";
import {
  STATEMENTS_PER_PARTY,
  type DealKeys,
  type ModDispute,
  type PublicConfig,
  MAX_PRODUCTS,
  PRICE_MAX,
  PRICE_MIN,
  PRO_PERIOD_MS,
  PRO_PRICE,
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
  readJson: (req: IncomingMessage, maxBytes?: number) => Promise<Row>;
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
  notary: Notary;
  /** Fee platform per seribu (50 = 5%). Disalin ke setiap kesepakatan saat dibuat. */
  feePerMille: number;
  payments: PaymentProvider;
  /** Platform gratis sepenuhnya: semua fitur PRO terbuka untuk semua orang; langganan dimatikan. */
  freePlatform: boolean;
  readRaw: (req: IncomingMessage, maxBytes?: number) => Promise<string>;
  log: (msg: string) => void;
  sealed: SealedStore;
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
    AWAITING_PAYMENT: { pay: "HELD" }, // konfirmasi lunas dari webhook gateway
    SHIPPED: { confirm: "COMPLETED" }, // pencairan otomatis
    HELD: { refund: "REFUNDED" }, // penjual tak pernah mengirim
    DISPUTED: { refund: "REFUNDED" }, // sengketa kedaluwarsa
  },
  // Moderator HANYA bisa memutus sengketa — tidak bisa menyentuh kesepakatan lain.
  moderator: {
    DISPUTED: { refund: "REFUNDED", confirm: "COMPLETED" },
  },
};

/**
 * Kesepakatan LANGSUNG: KAMBE tidak memegang dana, jadi tidak ada "tarik dana" pembeli, refund otomatis,
 * maupun sengketa yang kedaluwarsa menjadi refund. Status hanya mencatat apa yang dinyatakan para pihak.
 *  - pay  (pembeli) = "Sudah transfer"            - ship (penjual) = "Uang diterima · kirim"
 *  - dispute (penjual, HELD) = "Uang belum masuk" - refund (penjual) = "Dana sudah kukembalikan"
 */
const DIRECT_TRANSITIONS: Record<Actor, Table> = {
  buyer: {
    AWAITING_PAYMENT: { pay: "HELD", cancel: "CANCELLED" },
    HELD: { confirm: "COMPLETED", dispute: "DISPUTED" },
    SHIPPED: { confirm: "COMPLETED", dispute: "DISPUTED" },
    DISPUTED: { confirm: "COMPLETED" },
  },
  seller: {
    AWAITING_PAYMENT: { cancel: "CANCELLED" },
    HELD: { ship: "SHIPPED", refund: "REFUNDED", dispute: "DISPUTED" },
    SHIPPED: { refund: "REFUNDED" },
    DISPUTED: { refund: "REFUNDED" },
  },
  system: {
    SHIPPED: { confirm: "COMPLETED" }, // selesai otomatis bila pembeli diam setelah barang dikirim
  },
  moderator: {
    DISPUTED: { refund: "REFUNDED", confirm: "COMPLETED" }, // hanya mencatat putusan; tidak ada uang yang dipindah
  },
};

const tableFor = (r: Row) => (r.direct ? DIRECT_TRANSITIONS : TRANSITIONS);

/** Kolom tambahan yang boleh ditulis bersama transisi (daftar putih — tidak ada nama kolom dari input). */
const EXTRA_COLUMNS = ["resolution", "resolved_by", "shipment_object", "resolution_object", "payment_object"] as const;
type Extra = Partial<Record<(typeof EXTRA_COLUMNS)[number], string | null>>;

export function registerCommerce(d: CommerceDeps) {
  const { db, route, authed } = d;

  // ------------------------------------------------------------ helpers ---

  // Platform gratis: semua orang dianggap PRO (alur langganan disimpan, tidak dihapus).
  const isPro = (u: UserRow | undefined, now = Date.now()) => !!u && (d.freePlatform || u.pro_until > now);
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

  /** Isi teks harus terenkripsi: tolak klien lama yang masih mengirim teks biasa. */
  function rejectPlaintext(body: Row, ...keys: string[]) {
    for (const k of keys) {
      if (body[k] !== undefined && body[k] !== null && body[k] !== "") throw new HttpError(400, "content_must_be_encrypted", `Kolom ${k} wajib dikirim terenkripsi (perbarui aplikasi)`);
    }
  }

  /** Posting buku besar; menolak keras bila tidak seimbang (bug = berhenti, bukan uang hilang). */
  function post(ref: string, kind: string, dealId: string | null, entries: [account: string, amount: number][], now: number) {
    const sum = entries.reduce((s, [, a]) => s + a, 0);
    if (sum !== 0 || entries.some(([, a]) => !Number.isSafeInteger(a))) throw new Error(`ledger tidak seimbang: ${ref}`);
    const ins = db.prepare("INSERT INTO ledger (ref, account, amount, kind, deal_id, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (const [account, amount] of entries) ins.run(ref, account, amount, kind, dealId, now);
  }

  function toProduct(r: Row, viewer: string): Product {
    return {
      id: r.id as string,
      ownerId: r.owner_id as string,
      price: r.price as number,
      content: d.sealed.view(r.content_object as string | null, viewer),
      createdAt: r.created_at as number,
    };
  }

  const t = d.timers;

  /** Aksi yang sah untuk pelaku pada saat ini (tabel + aturan waktu). */
  function availableActions(actor: Actor, r: Row, now = Date.now()): DealAction[] {
    const status = r.status as DealStatus;
    return (Object.keys(tableFor(r)[actor][status] ?? {}) as DealAction[]).filter((a) => {
      // Pembeli baru boleh menarik dana sendiri bila penjual melewati batas kirim.
      if (!r.direct && actor === "buyer" && status === "HELD" && a === "refund") return now >= (r.paid_at as number) + t.shipWindowMs;
      return true;
    });
  }

  function toDeal(r: Row, viewer: string, now = Date.now(), asModerator = false): Deal {
    const status = r.status as DealStatus;
    const role: Actor = asModerator ? "moderator" : r.buyer_id === viewer ? "buyer" : "seller";
    const statements = (
      db.prepare("SELECT role, object_id, created_at FROM deal_statements WHERE deal_id = ? ORDER BY created_at ASC, id ASC").all(r.id as string) as Row[]
    ).map((s) => ({ role: s.role as "buyer" | "seller", createdAt: s.created_at as number, content: d.sealed.view(s.object_id as string | null, viewer) }));
    const shippedAt = (r.shipped_at as number | null) ?? null;
    const paidAt = (r.paid_at as number | null) ?? null;
    const disputedAt = (r.disputed_at as number | null) ?? null;
    const direct = !!r.direct;
    return {
      id: r.id as string,
      buyerId: r.buyer_id as string,
      sellerId: r.seller_id as string,
      createdBy: r.created_by as string,
      productId: (r.product_id as string | null) ?? null,
      content: d.sealed.view(r.content_object as string | null, viewer),
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
      shipBy: !direct && status === "HELD" && paidAt ? paidAt + t.shipWindowMs : null,
      autoRefundAt: direct
        ? null
        : status === "HELD" && paidAt
          ? paidAt + t.heldRefundMs
          : status === "DISPUTED" && disputedAt
            ? disputedAt + t.disputeTimeoutMs
            : null,
      actions: availableActions(role, r, now),
      shipment: d.sealed.view(r.shipment_object as string | null, viewer),
      statements,
      resolution: r.resolution
        ? {
            decision: r.resolution as "refund" | "release",
            by: r.resolved_by === "system" ? "system" : "moderator",
            at: (r.closed_at as number) ?? (r.updated_at as number),
            reason: d.sealed.view(r.resolution_object as string | null, viewer),
          }
        : null,
      payRef: (r.pay_ref as string | null) ?? "",
      paymentUrl: status === "AWAITING_PAYMENT" ? ((r.payment_url as string | null) ?? null) : null,
      direct,
      payment: d.sealed.view(r.payment_object as string | null, viewer),
      receipt: (() => {
        const l = latestReceipt(r.id as string);
        return l ? ({ body: l.body, sig: l.sig } satisfies SignedReceipt) : null;
      })(),
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

  // ---------------------------------------------------- notaris kuitansi ---

  const PAYREF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  /** Kode bayar sekali pakai: acak, tanpa id/alias/PIN — tak bisa dikaitkan ke identitas (versi realistis "stealth"). */
  function newPayRef(): string {
    return "PP-" + [...randomBytes(10)].map((b) => PAYREF_ALPHABET[b & 31]).join("");
  }

  const latestReceipt = (dealId: string) =>
    db.prepare("SELECT seq, body, sig FROM deal_receipts WHERE deal_id = ? ORDER BY seq DESC LIMIT 1").get(dealId) as
      | { seq: number; body: string; sig: string }
      | undefined;

  /** Terbitkan kuitansi untuk keadaan kesepakatan SAAT INI (dipanggil di dalam transaksi yang sama). */
  function issueReceipt(dealId: string, now: number) {
    const r = getDeal(dealId)!;
    const last = latestReceipt(dealId);
    const body: ReceiptBody = {
      v: 1,
      kind: RECEIPT_KIND,
      dealId,
      seq: last ? last.seq + 1 : 0,
      status: r.status as DealStatus,
      buyerId: r.buyer_id as string,
      sellerId: r.seller_id as string,
      contentHash: r.content_object ? (d.sealed.hashOf(r.content_object as string) ?? "") : "",
      price: r.price as number,
      fee: r.fee as number,
      sellerNet: (r.price as number) - (r.fee as number),
      payRef: r.pay_ref as string,
      at: now,
      prev: last ? createHash("sha256").update(`${last.body}|${last.sig}`).digest("hex") : "",
    };
    const text = JSON.stringify(body);
    db.prepare("INSERT INTO deal_receipts (deal_id, seq, body, sig, created_at) VALUES (?, ?, ?, ?, ?)").run(dealId, body.seq, text, d.notary.signBody(text), now);
  }

  /**
   * Jalankan satu transisi status secara atomik. Mengembalikan baris terbaru,
   * atau melempar 409 bila status sudah berubah (klik ganda / request paralel).
   */
  function transition(dealId: string, actor: Actor, action: DealAction, now = Date.now(), extra: Extra = {}): Row {
    return tx(db, () => {
      const r = getDeal(dealId);
      if (!r) throw new HttpError(404, "not_found", "Kesepakatan tidak ditemukan");
      const from = r.status as DealStatus;
      const to = tableFor(r)[actor][from]?.[action];
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
      // Kesepakatan langsung: uang tidak pernah lewat KAMBE → tidak ada posting buku besar sama sekali.
      if (!r.direct) {
        if (action === "pay") post(ref, "deal_payment", dealId, [[`external:${r.buyer_id}`, -p], ["escrow", p]], now);
        if (action === "confirm") post(ref, "deal_release", dealId, [["escrow", -p], [`user:${r.seller_id}`, p - fee], ["platform", fee]], now);
        if (action === "refund") post(ref, "deal_refund", dealId, [["escrow", -p], [`external:${r.buyer_id}`, p]], now);
      }
      issueReceipt(dealId, now);
      return getDeal(dealId)!;
    });
  }

  // ---------------------------------------------- konfigurasi & kuitansi ---

  route("GET", "/api/config", () => ({ feePerMille: d.feePerMille, notaryPublicKey: d.notary.publicKey, paymentProvider: d.payments.name, freePlatform: d.freePlatform } satisfies PublicConfig));

  // Webhook gateway: TANPA sesi & tanpa Origin (dikirim server gateway) — keasliannya dibuktikan token.
  route("POST", "/api/payments/webhook/:provider", async ({ req, params }) => {
    if (params.provider !== d.payments.name || d.payments.name === "simulasi" || d.payments.name === "langsung") throw new HttpError(404, "not_found", "Endpoint tidak ditemukan");
    const ev = d.payments.parseWebhook(req.headers, await d.readRaw(req, 64 * 1024));
    if (!ev) throw new HttpError(403, "bad_webhook", "Webhook tidak sah");
    const r = db.prepare("SELECT * FROM deals WHERE pay_ref = ?").get(ev.payRef) as Row | undefined;
    if (!r) return { ok: true }; // bukan milik kita — jawab 200 agar gateway tidak mengulang terus
    if (ev.status === "EXPIRED") {
      db.prepare("UPDATE deals SET payment_url = NULL, provider_ref = NULL WHERE id = ? AND status = 'AWAITING_PAYMENT'").run(r.id as string);
      notifyDeal(r);
      return { ok: true };
    }
    // Nominal harus PERSIS harga kesepakatan; selisih = tanda manipulasi → jangan tandai lunas.
    if (ev.amount !== r.price) {
      d.log(`[pembayaran] nominal tidak cocok untuk ${r.id}: ${ev.amount} ≠ ${r.price as number}`);
      throw new HttpError(409, "amount_mismatch", "Nominal tidak cocok");
    }
    if (r.status !== "AWAITING_PAYMENT") return { ok: true }; // webhook ulang → idempoten
    notifyDeal(transition(r.id as string, "system", "pay"));
    return { ok: true };
  });

  route("GET", "/api/deals/:id/receipts", authed(({ user, params }) => {
    const r = getDeal(params.id);
    if (!r || (r.buyer_id !== user.id && r.seller_id !== user.id && !d.isModerator(user))) throw new HttpError(404, "not_found", "Kesepakatan tidak ditemukan");
    const chain = db.prepare("SELECT body, sig FROM deal_receipts WHERE deal_id = ? ORDER BY seq ASC").all(params.id) as unknown as SignedReceipt[];
    return { receipts: chain.map((x) => ({ body: x.body, sig: x.sig })) };
  }));

  // ------------------------------------------------------------- PRO ---

  route("GET", "/api/pro", authed(({ user }) => proStatus(user)));

  route("POST", "/api/pro/subscribe", authed(async ({ req, user }) => {
    if (d.freePlatform) throw new HttpError(409, "platform_free", "KAMBE gratis sepenuhnya — tidak perlu berlangganan.");
    // Langganan belum punya alur pembayaran nyata: aktivasi hanya boleh di simulasi lokal.
    // Di produksi atau dengan gateway sungguhan, tanpa pembayaran terkonfirmasi tidak ada PRO.
    if (process.env.NODE_ENV === "production" || d.payments.name !== "simulasi") {
      throw new HttpError(402, "pro_unavailable", "Langganan PRO belum tersedia: pembayaran belum dihubungkan.");
    }
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
    products: (db.prepare("SELECT * FROM products WHERE owner_id = ? AND active = 1 ORDER BY created_at DESC").all(user.id) as Row[]).map((r) => toProduct(r, user.id)),
  })));

  route("GET", "/api/users/:id/products", authed(({ user, params }) => {
    const owner = d.getUser(params.id);
    // Etalase hanya untuk kontak yang sudah disetujui (bukan publik) — mengurangi penipu yang menyebar katalog.
    if (!owner || (owner.id !== user.id && !d.areContacts(user.id, owner.id))) throw new HttpError(404, "not_found", "Etalase tidak ditemukan");
    if (!isPro(owner)) return { pro: false, products: [] };
    const rows = db.prepare("SELECT * FROM products WHERE owner_id = ? AND active = 1 ORDER BY created_at DESC").all(owner.id) as Row[];
    return { pro: true, products: rows.map((r) => toProduct(r, user.id)) };
  }));

  // Produk: harga terbaca (fee & rekber ditegakkan server); nama/deskripsi/sektor = sealed object
  // untuk kontak penjual. Validasi panjang teks & sektor dilakukan di perangkat sebelum disegel.
  route("POST", "/api/products", authed(async ({ req, user }) => {
    requirePro(user);
    d.limit(`product-write:${user.id}`, 60, HOUR, "Terlalu banyak perubahan etalase dalam satu jam.");
    const body = await d.readJson(req, 256 * 1024);
    rejectPlaintext(body, "title", "description", "sector");
    const p = price(body);
    const count = db.prepare("SELECT COUNT(*) AS n FROM products WHERE owner_id = ? AND active = 1").get(user.id) as { n: number };
    if (count.n >= MAX_PRODUCTS) throw new HttpError(409, "too_many_products", `Maksimal ${MAX_PRODUCTS} produk aktif`);
    const id = randomUUID();
    const now = Date.now();
    tx(db, () => {
      const contentId = d.sealed.store(body.sealed, "product", user);
      db.prepare("INSERT INTO products (id, owner_id, title, description, sector, price, created_at, updated_at, content_object) VALUES (?, ?, '', '', '', ?, ?, ?, ?)").run(
        id,
        user.id,
        p,
        now,
        now,
        contentId,
      );
    });
    notifyContactsProducts(user.id);
    return toProduct(db.prepare("SELECT * FROM products WHERE id = ?").get(id) as Row, user.id);
  }));

  route("PATCH", "/api/products/:id", authed(async ({ req, user, params }) => {
    requirePro(user);
    d.limit(`product-write:${user.id}`, 60, HOUR, "Terlalu banyak perubahan etalase dalam satu jam.");
    const row = db.prepare("SELECT * FROM products WHERE id = ? AND owner_id = ? AND active = 1").get(params.id, user.id) as Row | undefined;
    if (!row) throw new HttpError(404, "not_found", "Produk tidak ditemukan");
    const body = await d.readJson(req, 256 * 1024);
    rejectPlaintext(body, "title", "description", "sector");
    const nextPrice = body.price !== undefined ? price(body) : (row.price as number);
    // Kesepakatan yang sudah dibuat memakai harga & judul snapshot — perubahan produk tidak memengaruhinya.
    tx(db, () => {
      let contentId = row.content_object as string | null;
      if (body.sealed !== undefined) {
        contentId = d.sealed.store(body.sealed, "product", user);
        d.sealed.remove(row.content_object as string | null);
      }
      db.prepare("UPDATE products SET price = ?, content_object = ?, updated_at = ? WHERE id = ?").run(nextPrice, contentId, Date.now(), params.id);
    });
    notifyContactsProducts(user.id);
    return toProduct(db.prepare("SELECT * FROM products WHERE id = ?").get(params.id) as Row, user.id);
  }));

  route("DELETE", "/api/products/:id", authed(({ user, params }) => {
    const row = db.prepare("SELECT content_object FROM products WHERE id = ? AND owner_id = ? AND active = 1").get(params.id, user.id) as { content_object: string | null } | undefined;
    if (!row) throw new HttpError(404, "not_found", "Produk tidak ditemukan");
    tx(db, () => {
      db.prepare("UPDATE products SET active = 0, content_object = NULL, updated_at = ? WHERE id = ?").run(Date.now(), params.id);
      d.sealed.remove(row.content_object);
    });
    notifyContactsProducts(user.id);
    return { ok: true };
  }));

  // ------------------------------------------------------ kesepakatan ---

  function insertDeal(fields: { buyer: string; seller: string; creator: UserRow; productId: string | null; price: number; key: string; content: unknown }) {
    const now = Date.now();
    const createdBy = fields.creator.id;
    return tx(db, () => {
      const existing = db.prepare("SELECT * FROM deals WHERE created_by = ? AND idem_key = ?").get(createdBy, fields.key) as Row | undefined;
      if (existing) {
        // Kunci yang sama hanya sah untuk permintaan yang SAMA; dipakai untuk hal lain → tolak,
        // jangan diam-diam mengembalikan kesepakatan lama (temuan red-team F2).
        const same =
          existing.buyer_id === fields.buyer &&
          existing.seller_id === fields.seller &&
          (existing.product_id ?? null) === fields.productId &&
          (fields.productId !== null || existing.price === fields.price);
        if (!same) throw new HttpError(409, "idem_conflict", "Kunci permintaan sudah dipakai untuk kesepakatan lain. Muat ulang lalu coba lagi.");
        return { row: existing, created: false };
      }
      const open = db.prepare("SELECT COUNT(*) AS n FROM deals WHERE (buyer_id = ? OR seller_id = ?) AND status = 'AWAITING_PAYMENT'").get(createdBy, createdBy) as { n: number };
      if (open.n >= 30) throw new HttpError(429, "too_many_open", "Terlalu banyak kesepakatan menunggu pembayaran. Selesaikan/batalkan sebagian dulu.");
      const id = randomUUID();
      // Mode dibekukan per kesepakatan saat dibuat: mengganti penyedia tidak mengubah kesepakatan lama.
      const direct = d.payments.name === "langsung";
      db.prepare(
        `INSERT INTO deals (id, buyer_id, seller_id, created_by, product_id, title, price, fee, status, idem_key, created_at, updated_at, pay_ref, direct)
         VALUES (?, ?, ?, ?, ?, '', ?, ?, 'AWAITING_PAYMENT', ?, ?, ?, ?, ?)`,
      ).run(id, fields.buyer, fields.seller, createdBy, fields.productId, fields.price, direct ? 0 : platformFee(fields.price, d.feePerMille), fields.key, now, now, newPayRef(), direct ? 1 : 0);
      // Judul kesepakatan: sealed object untuk pembeli, penjual & moderator (konteks = kesepakatan ini).
      const contentId = d.sealed.store(fields.content, "deal", fields.creator, id);
      db.prepare("UPDATE deals SET content_object = ? WHERE id = ?").run(contentId, id);
      issueReceipt(id, now); // kuitansi #0: kesepakatan dibuat (mengikat sidik isi terenkripsi)
      return { row: getDeal(id)!, created: true };
    });
  }

  // Kunci publik pihak-pihak kesepakatan → untuk menyegel bukti kirim, pernyataan, alasan putusan.
  route("GET", "/api/deals/:id/keys", authed(({ user, params }) => {
    const r = getDeal(params.id);
    if (!r || (r.buyer_id !== user.id && r.seller_id !== user.id && !d.isModerator(user))) throw new HttpError(404, "not_found", "Kesepakatan tidak ditemukan");
    const keyOf = (id: string) => {
      const u = d.getUser(id);
      return u?.public_key ? { id: u.id, publicKey: u.public_key } : null;
    };
    const keys: DealKeys = {
      buyer: keyOf(r.buyer_id as string),
      seller: keyOf(r.seller_id as string),
      moderators: d.moderatorIds().map(keyOf).filter((k): k is { id: string; publicKey: string } => !!k),
    };
    return keys;
  }));

  // Pembeli membuat kesepakatan dari produk etalase.
  route("POST", "/api/deals", authed(async ({ req, user }) => {
    const body = await d.readJson(req, 256 * 1024);
    rejectPlaintext(body, "title");
    const key = idemKey(body);
    const productId = d.str(body, "productId", { min: 1, max: 64 });
    d.limit(`deal-create:${user.id}`, 20, HOUR, "Terlalu banyak kesepakatan dibuat dalam satu jam.");
    const prod = db.prepare("SELECT * FROM products WHERE id = ? AND active = 1").get(productId) as Row | undefined;
    if (!prod) throw new HttpError(404, "not_found", "Produk tidak ditemukan atau sudah ditarik");
    const seller = d.getUser(prod.owner_id as string);
    if (!seller || seller.id === user.id) throw new HttpError(400, "own_product", "Tidak bisa membeli produk sendiri");
    if (!d.areContacts(user.id, seller.id)) throw new HttpError(404, "not_found", "Produk tidak ditemukan atau sudah ditarik");
    if (!isPro(seller)) throw new HttpError(409, "seller_not_pro", "Etalase penjual sedang tidak aktif");
    const { row, created } = insertDeal({ buyer: user.id, seller: seller.id, creator: user, productId, price: prod.price as number, key, content: body.sealed });
    if (created) notifyDeal(row);
    return toDeal(row, user.id);
  }));

  // Penjual PRO menawarkan kesepakatan kustom dari chat (tombol jabat tangan).
  route("POST", "/api/deals/offer", authed(async ({ req, user }) => {
    requirePro(user);
    const body = await d.readJson(req, 256 * 1024);
    rejectPlaintext(body, "title");
    const key = idemKey(body);
    const buyerId = d.str(body, "buyerId", { min: 1, max: 64 });
    const p = price(body);
    d.limit(`deal-create:${user.id}`, 20, HOUR, "Terlalu banyak kesepakatan dibuat dalam satu jam.");
    if (buyerId === user.id || !d.areContacts(user.id, buyerId)) throw new HttpError(404, "not_found", "Kontak tidak ditemukan");
    const { row, created } = insertDeal({ buyer: buyerId, seller: user.id, creator: user, productId: null, price: p, key, content: body.sealed });
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
    const body = await d.readJson(req, 256 * 1024);
    rejectPlaintext(body, "text");
    const role = r.buyer_id === user.id ? "buyer" : "seller";
    const count = db.prepare("SELECT COUNT(*) AS n FROM deal_statements WHERE deal_id = ? AND author_id = ?").get(r.id as string, user.id) as { n: number };
    if (count.n >= STATEMENTS_PER_PARTY) throw new HttpError(429, "too_many_statements", `Maksimal ${STATEMENTS_PER_PARTY} pernyataan per pihak`);
    // Pernyataan = sealed object untuk pembeli, penjual & moderator — server tidak bisa membacanya.
    tx(db, () => {
      const objectId = d.sealed.store(body.sealed, "statement", user, r.id as string);
      db.prepare("INSERT INTO deal_statements (deal_id, author_id, role, text, created_at, object_id) VALUES (?, ?, ?, '', ?, ?)").run(r.id as string, user.id, role, Date.now(), objectId);
    });
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

    // Mode gateway: "bayar" = buat invoice di server (kunci rahasia tetap di server) lalu kirim URL bayar.
    // Status baru berubah menjadi HELD saat webhook lunas diterima & diverifikasi.
    if (action === "pay" && !r.direct && d.payments.name === "xendit") {
      if (r.payment_url) return toDeal(r, user.id); // invoice masih berlaku → jangan buat ganda
      const seller = d.getUser(r.seller_id as string);
      let started;
      try {
        started = await d.payments.start({
          dealId: r.id as string,
          payRef: r.pay_ref as string,
          amount: r.price as number,
          fee: r.fee as number,
          description: `KAMBE ${r.pay_ref as string}`, // tanpa nama barang/identitas di gateway
          sellerAccount: (seller as (UserRow & { gateway_account?: string | null }) | undefined)?.gateway_account ?? null,
        });
      } catch (e) {
        if ((e as Error).message === "seller_account_missing") throw new HttpError(409, "seller_not_onboarded", "Penjual belum menghubungkan rekening pembayaran. Belum bisa dibayar.");
        d.log(`[pembayaran] gagal membuat invoice ${r.id as string}: ${(e as Error).message}`);
        throw new HttpError(502, "gateway_error", "Gateway pembayaran sedang bermasalah. Coba lagi sebentar.");
      }
      if (started.mode === "redirect") {
        db.prepare("UPDATE deals SET payment_url = ?, provider_ref = ?, updated_at = ? WHERE id = ? AND status = 'AWAITING_PAYMENT'").run(
          started.url,
          started.providerRef,
          Date.now(),
          r.id as string,
        );
        const fresh = getDeal(r.id as string)!;
        notifyDeal(fresh);
        return toDeal(fresh, user.id);
      }
    }

    // Bukti kirim ("ship") & cerita sengketa ("dispute") WAJIB, sebagai sealed object untuk pembeli,
    // penjual & moderator. Isi (kurir, resi, alasan, cerita) divalidasi di perangkat; server hanya
    // memastikan objeknya ada, sah, dan ditujukan ke pihak yang berhak.
    const directPay = action === "pay" && !!r.direct;
    const body = action === "ship" || action === "dispute" || directPay ? await d.readJson(req, 256 * 1024) : null;
    if (body) rejectPlaintext(body, "courier", "tracking", "note", "reason", "text");
    const now = Date.now();
    const updated = tx(db, () => {
      if (action === "ship") {
        const shipmentId = d.sealed.store(body!.sealed, "shipment", user, r.id as string);
        return transition(params.id, role, action, now, { shipment_object: shipmentId });
      }
      if (directPay) {
        // Bukti/catatan transfer OPSIONAL (biar praktis), tapi bila ada wajib tersegel untuk pihak terkait.
        const paymentId = body?.sealed ? d.sealed.store(body.sealed, "payment", user, r.id as string) : null;
        return transition(params.id, role, action, now, paymentId ? { payment_object: paymentId } : {});
      }
      if (action === "dispute") {
        const objectId = d.sealed.store(body!.sealed, "statement", user, r.id as string);
        const out = transition(params.id, role, action, now);
        db.prepare("INSERT INTO deal_statements (deal_id, author_id, role, text, created_at, object_id) VALUES (?, ?, ?, '', ?, ?)").run(params.id, user.id, role, now, objectId);
        return out;
      }
      return transition(params.id, role, action, now);
    });
    if (action === "dispute") notifyModerators();
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
    const body = await d.readJson(req, 256 * 1024);
    rejectPlaintext(body, "reason");
    const decision = d.str(body, "decision", { min: 1, max: 10 });
    if (decision !== "refund" && decision !== "release") throw new HttpError(400, "bad_decision", "Keputusan harus refund atau release");
    if (!body.sealed) throw new HttpError(400, "reason_required", "Alasan keputusan wajib (terenkripsi untuk kedua pihak)");
    const r = getDeal(params.id);
    if (!r) throw new HttpError(404, "not_found", "Kesepakatan tidak ditemukan");
    // Konflik kepentingan: moderator tidak boleh memutus kesepakatannya sendiri.
    if (r.buyer_id === user.id || r.seller_id === user.id) throw new HttpError(403, "conflict_of_interest", "Kamu terlibat dalam kesepakatan ini");
    const now = Date.now();
    const updated = tx(db, () => {
      // Keputusan (refund/release) harus terbaca server untuk memindahkan dana; ALASANNYA terenkripsi.
      const reasonId = d.sealed.store(body.sealed, "resolution", user, r.id as string);
      const out = transition(params.id, "moderator", decision === "refund" ? "refund" : "confirm", now, {
        resolution: decision,
        resolved_by: user.id,
        resolution_object: reasonId,
      });
      db.prepare("INSERT INTO moderation_log (deal_id, moderator_id, decision, reason, created_at, reason_object) VALUES (?, ?, ?, '', ?, ?)").run(params.id, user.id, decision, now, reasonId);
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
      incomingHeld: sum(`SELECT SUM(price - fee) AS s FROM deals WHERE seller_id = ? AND direct = 0 AND status IN (${held})`, user.id, ...HELD_STATUSES),
      outgoingHeld: sum(`SELECT SUM(price) AS s FROM deals WHERE buyer_id = ? AND direct = 0 AND status IN (${held})`, user.id, ...HELD_STATUSES),
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
      ...(db.prepare("SELECT id FROM deals WHERE status = 'HELD' AND direct = 0 AND paid_at <= ?").all(now - t.heldRefundMs) as { id: string }[]).map(
        (r): [string, DealAction] => [r.id, "refund"],
      ),
    ];
    // Sengketa kesepakatan langsung tidak kedaluwarsa jadi "refund" (tidak ada dana yang ditahan) — menunggu moderator.
    const expiredDisputes = db.prepare("SELECT id FROM deals WHERE status = 'DISPUTED' AND direct = 0 AND disputed_at <= ?").all(now - t.disputeTimeoutMs) as { id: string }[];
    const out = { released: 0, refunded: 0 };
    for (const { id } of expiredDisputes) {
      try {
        // Dicatat sebagai putusan sistem agar kedua pihak tahu alasannya.
        notifyDeal(
          // Sistem tak punya kunci untuk menyegel alasan: klien menampilkan teks tetap untuk by="system".
          transition(id, "system", "refund", now, { resolution: "refund", resolved_by: "system" }),
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
    const held = (db.prepare(`SELECT COALESCE(SUM(price), 0) AS s FROM deals WHERE direct = 0 AND status IN ('HELD','SHIPPED','DISPUTED')`).get() as { s: number }).s;
    const platform = (db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM ledger WHERE account = 'platform'").get() as { s: number }).s;
    return { total, escrow, held, platform, balanced: total === 0 && escrow === held };
  }

  function hasOpenDeals(userId: string): boolean {
    const placeholders = OPEN_STATUSES.map(() => "?").join(",");
    return !!db.prepare(`SELECT 1 FROM deals WHERE (buyer_id = ? OR seller_id = ?) AND status IN (${placeholders}) LIMIT 1`).get(userId, userId, ...OPEN_STATUSES);
  }

  return { runTimers, audit, hasOpenDeals };
}
