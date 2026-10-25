// Kontrak data antara klien dan server. Server hanya pernah melihat
// metadata di bawah ini — isi pesan selalu berupa ciphertext.

import type { SignedReceipt } from "./receipt.ts";

export const ALIAS_RE = /^[A-Za-z0-9_]{3,24}$/;
export const PASSPHRASE_MIN = 10;
export const PASSPHRASE_MAX = 256;
export const PM_MAX = 80; // "personal message" ala BBM
export const NOTE_MAX = 120; // catatan undangan (TIDAK terenkripsi — diberi label di UI)
export const CIPHERTEXT_MAX_B64 = 24 * 1024;
export const PING_COOLDOWN_MS = 30_000;

export type DeliveryStatus = "S" | "D" | "R"; // Sent (di server) / Delivered / Read

export interface PublicUser {
  id: string;
  alias: string;
  pin: string;
  publicKey: string | null;
  pm: string;
}

export interface Me extends PublicUser {
  readReceipts: boolean;
  createdAt: number;
  isModerator: boolean;
  /** Rotasi PIN utama otomatis (hari); 0 = mati. */
  pinRotateDays: PinRotateDays;
  pinRotatedAt: number;
}

export const PIN_ROTATE_OPTIONS = [0, 1, 7, 30] as const;
export type PinRotateDays = (typeof PIN_ROTATE_OPTIONS)[number];

export interface Contact extends PublicUser {
  since: number;
  unread: number;
  lastMessageAt: number | null;
}

export interface IncomingRequest {
  id: string;
  from: { id: string; alias: string; pin: string; pm: string };
  note: string;
  createdAt: number;
  /** Undangan masuk lewat Shadow PIN / PIN sekali pakai / PIN radar (bukan PIN utama). */
  via: { pin: string; kind: ShadowKind; label: string } | null;
}

export type ShadowKind = "shadow" | "once" | "radar";
export const MAX_ACTIVE_ONCE = 5;

// ------------------------------------------------ Fase 3: penemuan aman ---

export const SHADOW_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ACTIVE_SHADOW = 3;
export const RADAR_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RADAR_HEADLINE_MAX = 120;

export interface ShadowPin {
  pin: string;
  kind: ShadowKind;
  label: string;
  createdAt: number;
  expiresAt: number;
}

export interface RadarEntry {
  alias: string;
  pin: string; // PIN radar khusus, BUKAN PIN utama
  sector: string;
  headline: string;
  pro: boolean;
  since: number;
}

// ------------------------------------------------- Fase 3: Path Moments ---
// Setiap momen dienkripsi TERPISAH untuk tiap kontak (+ salinan diri sendiri).
// Server hanya menyimpan ciphertext; reaksi (😊😮❤️) adalah metadata yang terlihat server.

export const MOMENT_TEXT_MAX = 500;
export const MOMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_MOMENT_COPIES = 500;
export const REACTIONS = ["smile", "gasp", "love"] as const;
export type Reaction = (typeof REACTIONS)[number];

export interface MomentCopy {
  to: string;
  toKey: string;
  nonce: string;
  ciphertext: string;
}

export interface StoredMoment {
  id: string;
  authorId: string;
  authorAlias: string;
  authorKey: string;
  createdAt: number;
  expiresAt: number;
  copy: { toKey: string; nonce: string; ciphertext: string };
  reactions: Record<Reaction, number>;
  myReaction: Reaction | null;
}

export interface MyRadar {
  sector: string;
  headline: string;
  pin: string;
  expiresAt: number;
}

export interface OutgoingRequest {
  id: string;
  pin: string; // alias tujuan sengaja TIDAK ditampilkan sebelum disetujui (anti-pemindaian)
  createdAt: number;
}

export interface ContactsResponse {
  contacts: Contact[];
  incoming: IncomingRequest[];
  outgoing: OutgoingRequest[];
}

export interface StoredMessage {
  id: string;
  from: string;
  to: string;
  fromKey: string;
  toKey: string;
  nonce: string;
  ciphertext: string;
  ping: boolean;
  createdAt: number;
  status: DeliveryStatus;
}

// ------------------------------------------------------------ WebSocket ---

export type ClientEvent =
  | {
      t: "send";
      id: string;
      to: string;
      fromKey: string;
      toKey: string;
      nonce: string;
      ciphertext: string;
      ping: boolean;
    }
  | { t: "read"; peer: string; ids: string[] }
  | { t: "delivered"; ids: string[] };

export type ServerEvent =
  | { t: "hello"; userId: string }
  | { t: "message"; message: StoredMessage }
  | { t: "ack"; id: string; createdAt: number; status: DeliveryStatus }
  | { t: "rejected"; id: string; code: string; message: string }
  | { t: "status"; ids: string[]; status: DeliveryStatus }
  | { t: "contacts_changed" }
  | { t: "key_changed"; userId: string }
  | { t: "deals_changed"; peer: string }
  | { t: "mod_queue_changed" }
  | { t: "moments_changed" }
  | { t: "me_changed" }
  | { t: "products_changed"; owner: string }
  | { t: "session_ended"; reason: string };

// ------------------------------------------------------------- Fase 2 ---
// SIMULASI: tidak ada uang sungguhan yang berpindah. Semua nominal = rupiah utuh.

export const PRO_PRICE = 49_000;
export const PRO_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
export const FEE_PER_MILLE = 50; // 5% — keputusan pemilik produk (bisa diubah: PINPATH_FEE_PER_MILLE)
export const PRICE_MIN = 1_000;
export const PRICE_MAX = 100_000_000;
export const PRODUCT_TITLE_MAX = 80;
export const PRODUCT_DESC_MAX = 500;
export const MAX_PRODUCTS = 50;
export const SECTORS = ["Komoditas & Pangan", "Jasa Digital & IT", "Desain & Kreatif", "Logistik & B2B", "Lainnya"] as const;

/** Fee platform (default 5%) dibulatkan ke rupiah terdekat (setengah ke atas) — aritmetika bilangan bulat. */
export function platformFee(price: number, perMille: number = FEE_PER_MILLE): number {
  return Math.floor((price * perMille + 500) / 1000);
}

/** Konfigurasi publik server — dibaca klien agar pratinjau fee & verifikasi kuitansi sama dengan server. */
export interface PublicConfig {
  feePerMille: number;
  notaryPublicKey: string;
  paymentProvider: "simulasi" | "xendit";
}

export interface ProStatus {
  active: boolean;
  proUntil: number;
  price: number;
}

export interface Product {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  sector: string;
  price: number;
  createdAt: number;
}

/**
 * AWAITING_PAYMENT → HELD (dana ditahan rekber) → SHIPPED → COMPLETED (dana cair, fee dipotong)
 * AWAITING_PAYMENT → CANCELLED ; HELD/SHIPPED → REFUNDED (oleh penjual) ; HELD/SHIPPED → DISPUTED (oleh pembeli)
 */
export type DealStatus = "AWAITING_PAYMENT" | "HELD" | "SHIPPED" | "COMPLETED" | "CANCELLED" | "REFUNDED" | "DISPUTED";
export type DealAction = "pay" | "ship" | "confirm" | "cancel" | "refund" | "dispute";

export interface Deal {
  id: string;
  buyerId: string;
  sellerId: string;
  createdBy: string;
  productId: string | null;
  title: string;
  price: number;
  fee: number;
  sellerNet: number;
  status: DealStatus;
  createdAt: number;
  updatedAt: number;
  paidAt: number | null;
  shippedAt: number | null;
  closedAt: number | null;
  /** SHIPPED: dana cair otomatis ke penjual pada waktu ini bila pembeli diam. */
  autoReleaseAt: number | null;
  /** HELD: batas penjual mengirim; setelahnya pembeli boleh menarik dana sendiri. */
  shipBy: number | null;
  /** HELD/DISPUTED: dana kembali otomatis ke pembeli pada waktu ini bila tak ada tindakan. */
  autoRefundAt: number | null;
  /** Aksi yang boleh dilakukan pengguna yang meminta data ini. */
  actions: DealAction[];
  /** Bukti kirim yang wajib diisi penjual saat "kirim" (terlihat pembeli & moderator). */
  shipment: Shipment | null;
  disputeReason: DisputeReason | null;
  /** Pernyataan sengketa — sengaja dikirim ke moderator, TIDAK terenkripsi end-to-end. */
  statements: DisputeStatement[];
  resolution: { decision: "refund" | "release"; reason: string; at: number } | null;
  /** Kode referensi bayar sekali pakai (tanpa identitas) — dipakai di gateway & kuitansi. */
  payRef: string;
  /** Kuitansi notaris terbaru (Ed25519). Klien memverifikasi sebelum mempercayai status. */
  receipt: SignedReceipt | null;
  /** Halaman bayar gateway (mode gateway); null pada mode simulasi. */
  paymentUrl: string | null;
}

// ---------------------------------------------------- Fase 3: sengketa ---

export const COURIERS = [
  "JNE",
  "J&T Express",
  "SiCepat",
  "Pos Indonesia",
  "AnterAja",
  "Ninja Xpress",
  "Lion Parcel",
  "GoSend",
  "GrabExpress",
  "Diantar langsung",
  "Jasa digital (tanpa kirim fisik)",
] as const;
/** Kurir tanpa nomor resi → wajib keterangan yang cukup jelas. */
export const NO_TRACKING_COURIERS: readonly string[] = ["Diantar langsung", "Jasa digital (tanpa kirim fisik)"];
export const TRACKING_RE = /^[A-Za-z0-9-]{6,40}$/;
export const SHIP_NOTE_MAX = 300;
export const STATEMENT_MAX = 1000;
export const STATEMENTS_PER_PARTY = 5;
export const RESOLUTION_REASON_MIN = 10;

export const DISPUTE_REASONS = {
  not_received: "Barang/jasa tidak diterima",
  not_as_described: "Tidak sesuai deskripsi",
  damaged: "Rusak atau cacat",
  other: "Lainnya",
} as const;
export type DisputeReason = keyof typeof DISPUTE_REASONS;

export interface Shipment {
  courier: string;
  tracking: string | null;
  note: string;
}

export interface DisputeStatement {
  role: "buyer" | "seller";
  text: string;
  createdAt: number;
}

/** Tampilan antrean moderator: konteks secukupnya untuk memutus, tanpa isi chat E2EE. */
export interface ModDispute {
  deal: Deal;
  buyer: { id: string; alias: string };
  seller: { id: string; alias: string };
}

export interface LedgerEntry {
  id: number;
  amount: number;
  kind: string;
  dealId: string | null;
  createdAt: number;
}

export interface Wallet {
  balance: number; // saldo simulasi yang sudah cair
  incomingHeld: number; // dana pembeli yang masih ditahan untukmu (sebagai penjual)
  outgoingHeld: number; // dana kamu yang masih ditahan (sebagai pembeli)
  entries: LedgerEntry[];
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
