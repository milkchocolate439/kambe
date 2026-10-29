import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

// ------------------------------------------------------------- password ---

// scrypt N=2^15 (≈32 MiB RAM per tebakan) — mahal untuk penyerang GPU/ASIC.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(secret.normalize("NFKC"), salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, keyB64] = stored.split("$");
  if (algo !== "scrypt") return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(secret.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(key, expected);
}

/** Hash dummy agar login dengan alias tak terdaftar butuh waktu yang sama (anti-enumerasi). */
let dummyHash: Promise<string> | null = null;
export async function burnTime(secret: string): Promise<void> {
  dummyHash ??= hashSecret("pinpath-dummy-secret"); // label tetap, jangan diganti (lihat spec KAMBE)
  await verifySecret(secret, await dummyHash);
}

// --------------------------------------------------------- kode pemulihan ---

const RECOVERY_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** 20 karakter × 5 bit = 100 bit entropi, ditampilkan sebagai XXXXX-XXXXX-XXXXX-XXXXX. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(20);
  const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b & 31]).join("");
  return chars.match(/.{5}/g)!.join("-");
}

export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

// ---------------------------------------------------------------- sesi ---

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ----------------------------------------------------------- rate limit ---

/**
 * Sliding window sederhana di memori. Cukup untuk satu instance server;
 * kalau nanti diskalakan ke banyak instance, pindahkan ke Redis.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  /** true = boleh lanjut; false = kena batas. */
  take(key: string, max: number, windowMs: number, now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  /** Detik sampai slot berikutnya terbuka (untuk header Retry-After). */
  retryAfter(key: string, windowMs: number, now = Date.now()): number {
    const list = this.hits.get(key) ?? [];
    if (list.length === 0) return 0;
    return Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000));
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Jumlah kejadian dalam jendela waktu, tanpa mencatat kejadian baru. */
  count(key: string, windowMs: number, now = Date.now()): number {
    return (this.hits.get(key) ?? []).filter((t) => now - t < windowMs).length;
  }

  /** Catat satu kejadian tanpa memeriksa batas (mis. kegagalan masuk). */
  record(key: string, now = Date.now()): void {
    const list = this.hits.get(key) ?? [];
    list.push(now);
    this.hits.set(key, list);
  }

  /** Buang entri kedaluwarsa agar memori tidak terus tumbuh. */
  sweep(maxWindowMs: number, now = Date.now()): void {
    for (const [k, list] of this.hits) {
      const kept = list.filter((t) => now - t < maxWindowMs);
      if (kept.length === 0) this.hits.delete(k);
      else this.hits.set(k, kept);
    }
  }
}

/**
 * Jeda bertahap (backoff) untuk kegagalan per kunci (mis. alias). Kegagalan ke-1..freeFails
 * bebas; sesudahnya jeda 2x lipat tiap kegagalan (baseMs, 2×baseMs, …) hingga maxMs.
 * Tidak pernah permanen: jeda berakhir sendiri, dan hitungan di-reset setelah forgetMs
 * tanpa kegagalan baru atau saat login berhasil.
 */
export class FailureBackoff {
  private state = new Map<string, { fails: number; last: number }>();
  private readonly opts: { freeFails: number; baseMs: number; maxMs: number; forgetMs: number };

  constructor(opts: { freeFails: number; baseMs: number; maxMs: number; forgetMs: number }) {
    this.opts = opts;
  }

  /** Berapa ms lagi harus menunggu sebelum boleh mencoba (0 = boleh sekarang). */
  waitMs(key: string, now = Date.now()): number {
    const s = this.state.get(key);
    if (!s) return 0;
    const over = s.fails - this.opts.freeFails;
    if (over <= 0) return 0;
    const delay = Math.min(this.opts.baseMs * 2 ** (over - 1), this.opts.maxMs);
    return Math.max(0, s.last + delay - now);
  }

  fail(key: string, now = Date.now()): void {
    const s = this.state.get(key);
    const fresh = !!s && now - s.last < this.opts.forgetMs;
    this.state.set(key, { fails: (fresh ? s!.fails : 0) + 1, last: now });
  }

  success(key: string): void {
    this.state.delete(key);
  }

  sweep(now = Date.now()): void {
    for (const [k, s] of this.state) if (now - s.last >= this.opts.forgetMs) this.state.delete(k);
  }
}

// ------------------------------------------------------------- relay ---

/** Ambang antrean kirim per koneksi (byte). Di atas ini penerima dianggap terlalu lambat. */
export const RELAY_BUFFER_LIMIT = 1024 * 1024;

export interface RelaySocket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  terminate(): void;
}

/**
 * Kirim pesan relay tanpa menumpuk memori. Bila `bufferedAmount` melewati ambang, koneksi
 * penerima diputus ("slow") dan pesan TIDAK dikirim: pesan sudah tersimpan di antrean server
 * (belum berstatus delivered), jadi penerima mengambilnya lagi lewat GET /api/messages/:peer
 * saat tersambung ulang.
 */
export function relaySend(ws: RelaySocket, data: string, limit = RELAY_BUFFER_LIMIT): "sent" | "closed" | "slow" {
  const OPEN = 1; // WebSocket.OPEN
  if (ws.readyState !== OPEN) return "closed";
  if (ws.bufferedAmount > limit) {
    ws.terminate();
    return "slow";
  }
  ws.send(data);
  return "sent";
}
