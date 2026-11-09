// Sealed object multi-penerima — dipakai untuk SEMUA isi selain chat/momen yang dulu masih terbaca
// server (catatan undangan, status pribadi, etalase, judul kesepakatan, bukti kirim, pernyataan
// sengketa, alasan putusan, label Shadow PIN).
//
//   isi      : AES-256-GCM dengan kunci konten acak K (sekali per objek)
//   bungkus  : K dienkripsi untuk tiap penerima dengan KEK = HKDF(X25519(priv pemilik, pub penerima))
//              → hanya pemilik & penerima itu yang bisa menghitung KEK. Server tidak bisa membaca
//              isi maupun MEMALSUKAN objek atas nama pemilik.
//   pemilik  : selalu menyimpan bungkus untuk dirinya sendiri agar bisa menambah penerima kelak
//              (kontak baru, moderator) tanpa mengubah isi.
//   AAD      : mengikat jenis objek, id objek, dan kunci publik pemilik/penerima — bungkus/isi tidak
//              bisa dipindah ke objek, jenis, atau penerima lain.

import { E2EEError, fromB64, isValidPublicKey, NONCE_BYTES, PROTOCOL, toB64 } from "./e2ee.ts";

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const SEALED_KINDS = ["note", "pm", "label", "product", "deal", "shipment", "statement", "resolution", "payment", "payinfo"] as const;
export type SealedKind = (typeof SEALED_KINDS)[number];
export const SEALED_CT_MAX_B64 = 8192;

export interface Wrap {
  to: string; // id penerima (dipakai server untuk mengantar; tidak ikut AAD)
  toKey: string; // kunci publik penerima saat dibungkus
  nonce: string;
  wrapped: string; // K terenkripsi (base64)
}

export interface SealedBlob {
  id: string; // UUID objek
  kind: SealedKind;
  ownerKey: string; // kunci publik pemilik saat menyegel
  nonce: string;
  ciphertext: string;
  wraps: Wrap[];
}

/** Yang dikirim server ke satu penerima: objek + HANYA bungkus miliknya. */
export interface SealedView {
  id: string;
  kind: SealedKind;
  ownerId: string;
  ownerKey: string;
  nonce: string;
  ciphertext: string;
  wrap: Wrap | null; // null = pemilik belum membagikan kunci ke kamu
}

export interface Recipient {
  id: string;
  publicKey: string;
}

const contentAad = (kind: SealedKind, id: string, ownerKey: string) => enc.encode(`${PROTOCOL}|sealed|${kind}|${id}|${ownerKey}`);
const wrapAad = (kind: SealedKind, id: string, ownerKey: string, toKey: string) => enc.encode(`${PROTOCOL}|wrap|${kind}|${id}|${ownerKey}|${toKey}`);

async function importPub(b64: string): Promise<CryptoKey> {
  if (!isValidPublicKey(b64)) throw new E2EEError("bad_public_key", "Kunci publik tidak valid");
  return subtle.importKey("raw", fromB64(b64), { name: "X25519" }, true, []);
}

/** KEK arah pemilik→penerima. Sama hasilnya bila dihitung penerima dengan kunci privatnya & kunci publik pemilik. */
async function kek(myPrivate: CryptoKey, otherPublic: string, ownerKey: string, recipientKey: string): Promise<CryptoKey> {
  const shared = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: await importPub(otherPublic) }, myPrivate, 256));
  if (shared.every((b) => b === 0)) throw new E2EEError("weak_shared_secret", "Kunci tidak aman");
  const salt = new Uint8Array(await subtle.digest("SHA-256", enc.encode(`${PROTOCOL}|wrap-salt|${ownerKey}|${recipientKey}`)));
  const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(`${PROTOCOL}|wrap-key`) }, ikm, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function wrapFor(ownerPrivate: CryptoKey, ownerKey: string, kind: SealedKind, id: string, k: Uint8Array<ArrayBuffer>, r: Recipient): Promise<Wrap> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const key = await kek(ownerPrivate, r.publicKey, ownerKey, r.publicKey);
  const wrapped = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: wrapAad(kind, id, ownerKey, r.publicKey) }, key, k));
  return { to: r.id, toKey: r.publicKey, nonce: toB64(nonce), wrapped: toB64(wrapped) };
}

/**
 * Segel `content` (objek JSON) untuk pemilik + daftar penerima. `owner` HARUS pasangan `ownerPrivate`.
 * Bungkus untuk pemilik selalu disertakan.
 */
export async function seal(ownerPrivate: CryptoKey, owner: Recipient, kind: SealedKind, content: unknown, recipients: Recipient[], id: string = globalThis.crypto.randomUUID()): Promise<SealedBlob> {
  const k = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ck = await subtle.importKey("raw", k, "AES-GCM", false, ["encrypt"]);
  const plain = enc.encode(JSON.stringify(content));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: contentAad(kind, id, owner.publicKey) }, ck, plain));
  const ciphertext = toB64(ct);
  if (ciphertext.length > SEALED_CT_MAX_B64) throw new E2EEError("too_large", "Isi terlalu panjang");
  const all = [owner, ...recipients.filter((r) => r.id !== owner.id)];
  const unique = [...new Map(all.map((r) => [r.id, r])).values()];
  const wraps = await Promise.all(unique.map((r) => wrapFor(ownerPrivate, owner.publicKey, kind, id, k, r)));
  return { id, kind, ownerKey: owner.publicKey, nonce: toB64(nonce), ciphertext, wraps };
}

async function unwrapKey(myPrivate: CryptoKey, myKey: string, view: { kind: SealedKind; id: string; ownerKey: string; wrap: Wrap }): Promise<Uint8Array<ArrayBuffer>> {
  // Pemilik membuka bungkusnya sendiri: X25519(priv pemilik, pub pemilik); penerima: X25519(priv penerima, pub pemilik).
  const key = await kek(myPrivate, view.ownerKey, view.ownerKey, myKey);
  try {
    return new Uint8Array(
      await subtle.decrypt({ name: "AES-GCM", iv: fromB64(view.wrap.nonce), additionalData: wrapAad(view.kind, view.id, view.ownerKey, myKey) }, key, fromB64(view.wrap.wrapped)),
    );
  } catch {
    throw new E2EEError("unwrap_failed", "Kunci isi tidak bisa dibuka (bukan untuk perangkat ini atau dipalsukan)");
  }
}

/** Buka objek dengan kunci perangkat ini. `myKey` = kunci publik perangkat ini (harus sama dengan wrap.toKey). */
export async function openSealed<T = unknown>(myPrivate: CryptoKey, myKey: string, view: SealedView | (SealedBlob & { wrap?: Wrap | null })): Promise<T> {
  const wrap = "wrap" in view && view.wrap ? view.wrap : (view as SealedBlob).wraps?.find((w) => w.toKey === myKey);
  if (!wrap) throw new E2EEError("no_wrap", "Isi ini belum dibagikan ke perangkatmu");
  if (wrap.toKey !== myKey) throw new E2EEError("no_wrap", "Isi ini dibagikan ke perangkat lain");
  const k = await unwrapKey(myPrivate, myKey, { kind: view.kind, id: view.id, ownerKey: view.ownerKey, wrap });
  const ck = await subtle.importKey("raw", k, "AES-GCM", false, ["decrypt"]);
  try {
    const plain = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(view.nonce), additionalData: contentAad(view.kind, view.id, view.ownerKey) }, ck, fromB64(view.ciphertext));
    return JSON.parse(dec.decode(plain)) as T;
  } catch {
    throw new E2EEError("decrypt_failed", "Isi rusak atau diubah di jalan");
  }
}

/** Pemilik menambah penerima baru: buka bungkus miliknya untuk mendapat K, lalu bungkus ulang untuk penerima baru. */
export async function addRecipients(ownerPrivate: CryptoKey, owner: Recipient, view: SealedView, recipients: Recipient[]): Promise<Wrap[]> {
  if (!view.wrap) throw new E2EEError("no_wrap", "Bungkus milik pemilik tidak ada");
  const k = await unwrapKey(ownerPrivate, owner.publicKey, { kind: view.kind, id: view.id, ownerKey: view.ownerKey, wrap: view.wrap });
  return Promise.all(recipients.map((r) => wrapFor(ownerPrivate, owner.publicKey, view.kind, view.id, k, r)));
}

/** Sidik isi untuk diikat ke kuitansi notaris (tanpa membuka isinya). */
export async function sealedHash(blob: { id: string; ownerKey: string; nonce: string; ciphertext: string }): Promise<string> {
  const d = new Uint8Array(await subtle.digest("SHA-256", enc.encode(`${blob.id}|${blob.ownerKey}|${blob.nonce}|${blob.ciphertext}`)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Bersihkan teks hasil dekripsi sebelum ditampilkan (server tak bisa lagi melakukannya karena isinya terenkripsi). */
export function cleanDisplayText(s: unknown, max = 1000): string {
  if (typeof s !== "string") return "";
  return s
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "")
    .trim()
    .slice(0, max);
}
