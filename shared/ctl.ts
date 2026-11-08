// Pesan kendali (control message) E2EE antar-perangkat — dasar Etalase Hantu.
//
// Dikirim sebagai payload `{ kind: "ctl", ctl }` di saluran chat biasa (kunci & AAD sama), jadi server
// hanya melihat ciphertext. Semua isi berasal dari lawan bicara = TIDAK DIPERCAYA: validateCtl() menolak
// bentuk yang salah, membatasi panjang, membulatkan ke tipe yang benar, dan membersihkan teks tampilan.

import { cleanDisplayText } from "./sealed.ts";
import { PRICE_MAX, PRICE_MIN } from "./protocol.ts";

export const GHOST_TTL_MS = 72 * 60 * 60 * 1000;
export const GHOST_MAX_ITEMS = 30;
export const GHOST_TITLE_MAX = 80;
export const GHOST_DESC_MAX = 300;
/** Batas ukuran JSON satu bagian jawaban etalase (plaintext maksimum E2EE = 16 KB). */
export const GHOST_PART_BYTES = 8 * 1024;
export const GHOST_MAX_PARTS = 8;
/** Batas permintaan per kontak per jam, ditegakkan di perangkat PENJUAL. */
export const GHOST_REQ_PER_HOUR = 20;
export const GHOST_ORDER_PER_HOUR = 5;

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface GhostItem {
  id: string;
  title: string;
  description: string;
  price: number;
  expiresAt: number;
}

export type NackReason = "item_gone" | "seller_not_pro" | "failed";
const NACK_REASONS: readonly string[] = ["item_gone", "seller_not_pro", "failed"];

export type Ctl =
  | { t: "store.req"; reqId: string }
  | { t: "store.res"; reqId: string; part: number; parts: number; items: GhostItem[]; storeExpiresAt: number }
  | { t: "store.order"; orderId: string; itemId: string }
  | { t: "store.nack"; orderId: string; reason: NackReason };

export class CtlError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (m: string): never => {
  throw new CtlError(m);
};

function id(v: unknown, what: string): string {
  if (typeof v !== "string" || !ID_RE.test(v)) fail(`${what} tidak valid`);
  return v as string;
}

function int(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) fail(`${what} di luar batas`);
  return v as number;
}

export function validateItem(v: unknown): GhostItem {
  if (!isObj(v)) return fail("item bukan objek");
  if (typeof v.title !== "string" || typeof v.description !== "string") fail("teks item tidak valid");
  const title = cleanDisplayText(v.title as string, GHOST_TITLE_MAX);
  if (title.length < 1) fail("judul item kosong");
  return {
    id: id(v.id, "id item"),
    title,
    description: cleanDisplayText(v.description as string, GHOST_DESC_MAX),
    price: int(v.price, "harga", PRICE_MIN, PRICE_MAX),
    expiresAt: int(v.expiresAt, "kedaluwarsa", 0, 8_640_000_000_000_000),
  };
}

/** Validasi ketat pesan kendali dari lawan bicara. Melempar CtlError bila tidak sah. */
export function validateCtl(raw: unknown): Ctl {
  if (!isObj(raw) || typeof raw.t !== "string") return fail("pesan kendali tidak dikenal");
  switch (raw.t) {
    case "store.req":
      return { t: "store.req", reqId: id(raw.reqId, "reqId") };
    case "store.res": {
      const parts = int(raw.parts, "jumlah bagian", 1, GHOST_MAX_PARTS);
      const part = int(raw.part, "bagian", 0, parts - 1);
      if (!Array.isArray(raw.items) || raw.items.length > GHOST_MAX_ITEMS) return fail("daftar item tidak valid");
      return {
        t: "store.res",
        reqId: id(raw.reqId, "reqId"),
        part,
        parts,
        items: raw.items.map(validateItem),
        storeExpiresAt: int(raw.storeExpiresAt, "kedaluwarsa etalase", 0, 8_640_000_000_000_000),
      };
    }
    case "store.order":
      return { t: "store.order", orderId: id(raw.orderId, "orderId"), itemId: id(raw.itemId, "itemId") };
    case "store.nack":
      if (typeof raw.reason !== "string" || !NACK_REASONS.includes(raw.reason)) return fail("alasan tidak dikenal");
      return { t: "store.nack", orderId: id(raw.orderId, "orderId"), reason: raw.reason as NackReason };
    default:
      return fail("jenis pesan kendali tidak dikenal");
  }
}

/** Item yang masih berlaku, urut harga naik lalu judul. */
export function activeItems(items: GhostItem[], now: number): GhostItem[] {
  return items.filter((i) => i.expiresAt > now).sort((a, b) => a.price - b.price || a.title.localeCompare(b.title));
}

/** Pecah daftar item menjadi bagian-bagian ≤ `maxBytes` (JSON) agar tiap bagian muat di satu pesan E2EE. Minimal 1 bagian. */
export function chunkItems(items: GhostItem[], maxBytes = GHOST_PART_BYTES): GhostItem[][] {
  const enc = new TextEncoder();
  const out: GhostItem[][] = [];
  let cur: GhostItem[] = [];
  let size = 0;
  for (const it of items) {
    const n = enc.encode(JSON.stringify(it)).length + 1;
    if (cur.length && size + n > maxBytes) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += n;
  }
  out.push(cur);
  return out;
}

/** Penampung bagian jawaban di sisi pembeli. Hanya menerima reqId yang sedang ditunggu. */
export class PartCollector {
  private readonly got = new Map<number, GhostItem[]>();
  private parts = 0;
  storeExpiresAt = 0;
  readonly reqId: string;
  constructor(reqId: string) {
    this.reqId = reqId;
  }

  /** true bila semua bagian sudah lengkap. */
  add(res: Extract<Ctl, { t: "store.res" }>): boolean {
    if (res.reqId !== this.reqId) return false;
    if (this.parts && this.parts !== res.parts) return false; // jumlah bagian berubah di tengah jalan = abaikan
    this.parts = res.parts;
    this.storeExpiresAt = res.storeExpiresAt;
    this.got.set(res.part, res.items);
    return this.got.size === this.parts;
  }

  items(): GhostItem[] {
    const all: GhostItem[] = [];
    const seen = new Set<string>();
    for (let p = 0; p < this.parts; p++) for (const it of this.got.get(p) ?? []) if (!seen.has(it.id) && seen.size < GHOST_MAX_ITEMS) (seen.add(it.id), all.push(it));
    return all;
  }
}

/** Pembatas laju geser per kunci (di memori) — dipakai di perangkat penjual. */
export class SlidingLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  constructor(max: number, windowMs = 60 * 60 * 1000) {
    this.max = max;
    this.windowMs = windowMs;
  }
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
