// Brankas perangkat KAMBE (Tahap 2 "enkripsi mutlak").
//
//   frasa kunci   : seed acak 256-bit milik pengguna, TIDAK pernah dikirim ke server.
//                   Ditulis sebagai 14 grup × 4 karakter Crockford base32 (2 grup terakhir
//                   memuat checksum, jadi salah ketik langsung ketahuan).
//   identitas     : kunci X25519 diturunkan deterministik dari seed (HKDF) → memulihkan
//                   seed di perangkat baru = kunci publik yang SAMA (safety number tidak berubah).
//   kunci lokal   : kunci riwayat (IndexedDB) & kunci cadangan diturunkan dari seed + id akun.
//   brankas       : seed dibungkus passphrase (PBKDF2-SHA256 600k → AES-256-GCM, AAD = akun).
//                   Saat keluar, hanya brankas terbungkus ini yang tersisa di perangkat.

import { E2EEError, fromB64, PROTOCOL, toB64, type Identity } from "./e2ee.ts";

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const SEED_BYTES = 32;
export const VAULT_ITERATIONS = 600_000;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: tanpa I, L, O, U
const DATA_CHARS = 52; // ceil(256 / 5)
const CHECK_CHARS = 4; // 20 bit SHA-256

// ------------------------------------------------------------ frasa kunci ---

export function generateSeed(): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(SEED_BYTES));
}

function base32(bytes: Uint8Array, chars: number): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (out.length < chars && bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out.padEnd(chars, ALPHABET[0]);
}

async function checksum(seed: Uint8Array<ArrayBuffer>): Promise<string> {
  const h = new Uint8Array(await subtle.digest("SHA-256", seed));
  return base32(h, CHECK_CHARS);
}

/** Seed → "ABCD-EFGH-…" (14 grup). */
export async function encodeSeed(seed: Uint8Array<ArrayBuffer>): Promise<string> {
  if (seed.length !== SEED_BYTES) throw new E2EEError("bad_seed", "Seed tidak valid");
  const s = base32(seed, DATA_CHARS) + (await checksum(seed));
  return s.match(/.{4}/g)!.join("-");
}

/** Toleran: huruf kecil, spasi/strip, dan O→0, I/L→1 (salah baca umum). */
export function normalizeSeedCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

export async function decodeSeed(code: string): Promise<Uint8Array<ArrayBuffer>> {
  const s = normalizeSeedCode(code);
  if (s.length !== DATA_CHARS + CHECK_CHARS || [...s].some((c) => !ALPHABET.includes(c))) {
    throw new E2EEError("bad_seed", "Frasa kunci harus 56 karakter (14 grup × 4)");
  }
  const seed = new Uint8Array(SEED_BYTES);
  let acc = 0;
  let bits = 0;
  let i = 0;
  for (const c of s.slice(0, DATA_CHARS)) {
    acc = (acc << 5) | ALPHABET.indexOf(c);
    bits += 5;
    if (bits >= 8 && i < SEED_BYTES) {
      seed[i++] = (acc >>> (bits - 8)) & 255;
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  if (acc !== 0) throw new E2EEError("bad_seed", "Frasa kunci tidak valid — periksa lagi ketikanmu");
  if ((await checksum(seed)) !== s.slice(DATA_CHARS)) throw new E2EEError("bad_seed", "Frasa kunci tidak cocok (salah ketik?) — periksa lagi");
  return seed;
}

// ------------------------------------------------- turunan dari seed ---

async function hkdf(seed: Uint8Array<ArrayBuffer>, label: string, bytes = 32): Promise<Uint8Array<ArrayBuffer>> {
  const ikm = await subtle.importKey("raw", seed, "HKDF", false, ["deriveBits"]);
  const salt = new Uint8Array(await subtle.digest("SHA-256", enc.encode(`${PROTOCOL}|seed-salt`)));
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(`${PROTOCOL}|${label}`) }, ikm, bytes * 8));
}

// PKCS#8 untuk X25519: SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.110 }, OCTET STRING { OCTET STRING (32) } }
const PKCS8_X25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

/** Identitas X25519 deterministik. Seed yang sama → kunci publik yang sama di perangkat mana pun. */
export async function identityFromSeed(seed: Uint8Array<ArrayBuffer>): Promise<Identity> {
  const d = await hkdf(seed, "identity-x25519");
  const pkcs8 = new Uint8Array(PKCS8_X25519.length + 32);
  pkcs8.set(PKCS8_X25519);
  pkcs8.set(d, PKCS8_X25519.length);
  // Impor sekali sebagai extractable HANYA untuk membaca kunci publiknya, lalu impor ulang non-extractable.
  const tmp = await subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, true, ["deriveBits"]);
  const jwk = await subtle.exportKey("jwk", tmp);
  const publicKey = toB64(fromB64url(jwk.x!));
  const privateKey = await subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, ["deriveBits"]);
  pkcs8.fill(0);
  d.fill(0);
  return { privateKey, publicKey };
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return fromB64(b + "=".repeat((4 - (b.length % 4)) % 4));
}

export interface LocalKeys {
  /** Mengenkripsi riwayat & rahasia di IndexedDB. */
  history: CryptoKey;
  /** Mengenkripsi file cadangan. */
  backup: CryptoKey;
}

export async function localKeysFromSeed(seed: Uint8Array<ArrayBuffer>, userId: string): Promise<LocalKeys> {
  const make = async (label: string) => {
    const raw = await hkdf(seed, `${label}|${userId}`);
    const k = await subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    raw.fill(0);
    return k;
  };
  return { history: await make("local-history"), backup: await make("backup") };
}

// ----------------------------------------------------------- brankas ---

export interface VaultBlob {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  nonce: string;
  ciphertext: string;
  publicKey: string; // kunci publik identitas — untuk mencocokkan dengan server tanpa membuka brankas
}

async function passKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await subtle.importKey("raw", enc.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const vaultAad = (userId: string, publicKey: string) => enc.encode(`${PROTOCOL}|vault|${userId}|${publicKey}`);

export async function wrapSeed(seed: Uint8Array<ArrayBuffer>, passphrase: string, userId: string, iterations = VAULT_ITERATIONS): Promise<VaultBlob> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const { publicKey } = await identityFromSeed(seed);
  const key = await passKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: vaultAad(userId, publicKey) }, key, seed));
  return { v: 1, kdf: "PBKDF2-SHA256", iterations, salt: toB64(salt), nonce: toB64(nonce), ciphertext: toB64(ct), publicKey };
}

/** Buka brankas. Passphrase salah / brankas diutak-atik / milik akun lain → E2EEError("bad_passphrase"). */
export async function unwrapSeed(vault: VaultBlob, passphrase: string, userId: string): Promise<Uint8Array<ArrayBuffer>> {
  if (vault?.v !== 1 || vault.kdf !== "PBKDF2-SHA256" || !(vault.iterations >= 100_000 && vault.iterations <= 10_000_000)) {
    throw new E2EEError("bad_vault", "Format brankas tidak dikenal");
  }
  const key = await passKey(passphrase, fromB64(vault.salt), vault.iterations);
  let seed: Uint8Array<ArrayBuffer>;
  try {
    seed = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: fromB64(vault.nonce), additionalData: vaultAad(userId, vault.publicKey) }, key, fromB64(vault.ciphertext)));
  } catch {
    throw new E2EEError("bad_passphrase", "Passphrase tidak cocok dengan brankas di perangkat ini");
  }
  if (seed.length !== SEED_BYTES || (await identityFromSeed(seed)).publicKey !== vault.publicKey) throw new E2EEError("bad_vault", "Brankas rusak");
  return seed;
}

// ------------------------------------------------- rekaman terenkripsi ---

export interface SealedRecord {
  nonce: string;
  ct: string;
}

/** Enkripsi satu rekaman lokal; `bind` (mis. kunci IndexedDB-nya) masuk AAD → rekaman tidak bisa ditukar. */
export async function sealRecord(key: CryptoKey, bind: string, value: unknown): Promise<SealedRecord> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: enc.encode(`${PROTOCOL}|local|${bind}`) }, key, enc.encode(JSON.stringify(value))));
  return { nonce: toB64(nonce), ct: toB64(ct) };
}

export async function openRecord<T>(key: CryptoKey, bind: string, rec: SealedRecord): Promise<T> {
  try {
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(rec.nonce), additionalData: enc.encode(`${PROTOCOL}|local|${bind}`) }, key, fromB64(rec.ct));
    return JSON.parse(dec.decode(plain)) as T;
  } catch {
    throw new E2EEError("local_decrypt_failed", "Data lokal tidak bisa dibuka (rusak atau dari brankas lain)");
  }
}

// ----------------------------------------------------------- cadangan ---

export const BACKUP_FORMAT = "pinpath-backup"; // label protokol, jangan diganti (lihat spec KAMBE)
export const BACKUP_MAX_BYTES = 64 * 1024 * 1024;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  v: 1;
  userId: string;
  createdAt: number;
  nonce: string;
  ct: string;
}

const backupAad = (userId: string, createdAt: number) => enc.encode(`${PROTOCOL}|backup|${userId}|${createdAt}`);

export async function encryptBackup(key: CryptoKey, userId: string, data: unknown, createdAt = Date.now()): Promise<BackupFile> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: backupAad(userId, createdAt) }, key, enc.encode(JSON.stringify(data))));
  return { format: BACKUP_FORMAT, v: 1, userId, createdAt, nonce: toB64(nonce), ct: toB64(ct) };
}

export async function decryptBackup<T>(key: CryptoKey, userId: string, raw: unknown): Promise<{ createdAt: number; data: T }> {
  const f = raw as BackupFile;
  if (typeof f !== "object" || f === null || f.format !== BACKUP_FORMAT || f.v !== 1 || typeof f.createdAt !== "number" || typeof f.nonce !== "string" || typeof f.ct !== "string") {
    throw new E2EEError("bad_backup", "Ini bukan file cadangan KAMBE");
  }
  if (f.userId !== userId) throw new E2EEError("backup_other_account", "File cadangan ini milik akun lain");
  try {
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(f.nonce), additionalData: backupAad(userId, f.createdAt) }, key, fromB64(f.ct));
    return { createdAt: f.createdAt, data: JSON.parse(dec.decode(plain)) as T };
  } catch {
    throw new E2EEError("backup_decrypt_failed", "Cadangan tidak bisa dibuka — frasa kunci berbeda atau file rusak");
  }
}
