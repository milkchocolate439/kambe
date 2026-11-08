// Kontrak data antara klien dan server. Server hanya pernah melihat
// metadata di bawah ini — isi pesan selalu berupa ciphertext.

import type { SignedReceipt } from "./receipt.ts";
import type { Recipient, SealedView } from "./sealed.ts";

// ---------------------------------------------------------------------------
// Bentuk ISI sealed object setelah didekripsi di perangkat (server tidak pernah melihatnya).
export interface PmContent { text: string }
export interface NoteContent { text: string }
export interface LabelContent { text: string }
export interface ProductContent { title: string; description: string; sector: string }
export interface DealContent { title: string }
export interface ShipmentContent { courier: string; tracking: string | null; note: string }
export interface StatementContent { reason?: DisputeReason; text: string }
export interface ResolutionContent { reason: string }

/** Kunci publik pihak-pihak sebuah kesepakatan, untuk menyegel isi terkait (bukti kirim, pernyataan, …). */
export interface DealKeys {
  buyer: Recipient | null;
  seller: Recipient | null;
  moderators: Recipient[];
}

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
  /** Status pribadi terenkripsi (PmContent); null = tidak ada / belum dibagikan ke kamu. */
  pm: SealedView | null;
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
  from: { id: string; alias: string; pin: string };
  /** Catatan undangan terenkripsi untukmu (NoteContent). */
  note: SealedView | null;
  createdAt: number;
  /** Undangan masuk lewat Shadow PIN / PIN sekali pakai / PIN radar (bukan PIN utama). */
  via: { pin: string; kind: ShadowKind; label: SealedView | null } | null;
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
  /** Label hanya untuk pemilik (LabelContent, terenkripsi). */
  label: SealedView | null;
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
  /** Pesan belum terkirim melewati 30 hari; dikirim sekali ke pengirim sebelum baris dihapus. */
  | { t: "expired"; ids: string[] }
  | { t: "contacts_changed" }
  | { t: "key_changed"; userId: string }
  | { t: "deals_changed"; peer: string }
  | { t: "mod_queue_changed" }
  /** Moderator ganti kunci perangkat: pihak sengketa perlu membagikan ulang isi ke kunci barunya. */
  | { t: "reshare_needed"; peer: string }
  | { t: "moments_changed" }
  | { t: "me_changed" }
  | { t: "products_changed"; owner: string }
  | { t: "session_ended"; reason: string };

// ------------------------------------------------------------- Fase 2 ---
// SIMULASI: tidak ada uang sungguhan yang berpindah. Semua nominal = rupiah utuh.

export const PRO_PRICE = 49_000;
export const PRO_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Fee platform per seribu. 0 = ESCROW GRATIS (keputusan pemilik produk, 9 Nov 2026; sebelumnya 5%).
 * Tetap bisa diubah lewat KAMBE_FEE_PER_MILLE (25 = 2,5%, 50 = 5%, maks. 200). Tarif tersimpan per
 * kesepakatan saat dibuat, jadi mengubahnya tidak memengaruhi kesepakatan lama.
 */
export const FEE_PER_MILLE = 0;
export const PRICE_MIN = 1_000;
export const PRICE_MAX = 100_000_000;
export const PRODUCT_TITLE_MAX = 80;
export const PRODUCT_DESC_MAX = 500;
export const MAX_PRODUCTS = 50;
export const SECTORS = ["Komoditas & Pangan", "Jasa Digital & IT", "Desain & Kreatif", "Logistik & B2B", "Lainnya"] as const;

/** Fee platform (default 0 = escrow gratis) dibulatkan ke rupiah terdekat (setengah ke atas) — aritmetika bilangan bulat. */
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
  /** Harga tetap terbaca server (dasar fee & rekber yang ditegakkan server). */
  price: number;
  /** Nama, deskripsi, sektor — terenkripsi untuk kontak (ProductContent). */
  content: SealedView | null;
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
  /** Judul kesepakatan terenkripsi untuk pembeli, penjual & moderator (DealContent). */
  content: SealedView | null;
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
  /** Bukti kirim wajib (ShipmentContent) — terenkripsi untuk pembeli, penjual & moderator. */
  shipment: SealedView | null;
  /** Pernyataan sengketa (StatementContent) — terenkripsi untuk pembeli, penjual & moderator. */
  statements: DisputeStatement[];
  /** Putusan: keputusan terbaca server (perlu untuk memindahkan dana); alasan terenkripsi. */
  resolution: { decision: "refund" | "release"; by: "moderator" | "system"; at: number; reason: SealedView | null } | null;
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

export interface DisputeStatement {
  role: "buyer" | "seller";
  createdAt: number;
  content: SealedView | null;
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
