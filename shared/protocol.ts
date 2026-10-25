// Kontrak data antara klien dan server. Server hanya pernah melihat
// metadata di bawah ini — isi pesan selalu berupa ciphertext.

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
}

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
  | { t: "products_changed"; owner: string }
  | { t: "session_ended"; reason: string };

// ------------------------------------------------------------- Fase 2 ---
// SIMULASI: tidak ada uang sungguhan yang berpindah. Semua nominal = rupiah utuh.

export const PRO_PRICE = 49_000;
export const PRO_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
export const FEE_PER_MILLE = 25; // 2,5%
export const PRICE_MIN = 1_000;
export const PRICE_MAX = 100_000_000;
export const PRODUCT_TITLE_MAX = 80;
export const PRODUCT_DESC_MAX = 500;
export const MAX_PRODUCTS = 50;
export const SECTORS = ["Komoditas & Pangan", "Jasa Digital & IT", "Desain & Kreatif", "Logistik & B2B", "Lainnya"] as const;

/** Fee platform 2,5% dibulatkan ke rupiah terdekat (setengah ke atas) — aritmetika bilangan bulat. */
export function platformFee(price: number): number {
  return Math.floor((price * FEE_PER_MILLE + 500) / 1000);
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
