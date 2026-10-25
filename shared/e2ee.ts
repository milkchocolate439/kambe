// Inti enkripsi end-to-end PINPath. Dipakai di browser dan di tes Node
// (keduanya punya Web Crypto API standar di globalThis.crypto).
//
// Skema (v1):
//   kunci identitas  : X25519 per perangkat; kunci privat NON-EXTRACTABLE
//   kunci percakapan : HKDF-SHA256( X25519(privA, pubB) ), salt mengikat
//                      kedua identitas (id + kunci publik)
//   isi pesan        : AES-256-GCM, nonce acak 96-bit per pesan, AAD mengikat
//                      id pesan + pengirim + penerima + kedua kunci publik
//                      (server tidak bisa menukar/memutar ulang ciphertext
//                      ke pesan atau percakapan lain tanpa ketahuan)
//   safety number    : 60 digit dari hash kedua identitas — dicocokkan
//                      langsung oleh kedua pengguna untuk menangkal MITM
//
// Fase 2 berencana menambah Double Ratchet (forward secrecy per pesan).

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PROTOCOL = "pinpath/v1";
export const PUBLIC_KEY_BYTES = 32;
export const NONCE_BYTES = 12;
/** Batas ukuran plaintext agar satu pesan tidak membebani server/klien. */
export const MAX_PLAINTEXT_BYTES = 16 * 1024;

// ---------------------------------------------------------------- base64 ---

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new E2EEError("bad_base64", "Data base64 tidak valid");
  }
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export class E2EEError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "E2EEError";
    this.code = code;
  }
}

// ------------------------------------------------------------ identitas ---

export interface Identity {
  privateKey: CryptoKey; // non-extractable: tidak bisa dibaca skrip, hanya dipakai
  publicKey: string; // base64 raw 32 byte, aman dibagikan
}

export async function generateIdentity(): Promise<Identity> {
  const pair = (await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toB64(raw) };
}

export function isValidPublicKey(b64: unknown): b64 is string {
  if (typeof b64 !== "string" || b64.length !== 44) return false;
  try {
    const bytes = fromB64(b64);
    return bytes.length === PUBLIC_KEY_BYTES && bytes.some((b) => b !== 0);
  } catch {
    return false;
  }
}

async function importPublicKey(b64: string): Promise<CryptoKey> {
  if (!isValidPublicKey(b64)) throw new E2EEError("bad_public_key", "Kunci publik tidak valid");
  return subtle.importKey("raw", fromB64(b64), { name: "X25519" }, true, []);
}

// --------------------------------------------------------- kunci sesi ---

export interface Party {
  id: string;
  publicKey: string;
}

/** Urutan kanonik dua pihak agar kedua sisi menurunkan kunci yang sama. */
function ordered(a: Party, b: Party): [Party, Party] {
  return a.id < b.id ? [a, b] : [b, a];
}

/**
 * Menurunkan kunci AES-GCM bersama. `me.publicKey` harus pasangan dari
 * `myPrivateKey`; kedua pihak mendapat kunci identik tanpa pernah mengirimnya.
 */
export async function deriveConversationKey(myPrivateKey: CryptoKey, me: Party, peer: Party): Promise<CryptoKey> {
  if (me.id === peer.id) throw new E2EEError("self_conversation", "Tidak bisa membuat percakapan dengan diri sendiri");
  const peerKey = await importPublicKey(peer.publicKey);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: peerKey }, myPrivateKey, 256));
  // Tolak titik berorde-rendah (hasil ECDH nol) — tanda kunci publik jahat.
  if (shared.every((b) => b === 0)) throw new E2EEError("weak_shared_secret", "Kunci lawan bicara tidak aman");

  const [x, y] = ordered(me, peer);
  const salt = new Uint8Array(await subtle.digest("SHA-256", enc.encode(`${PROTOCOL}|salt|${x.id}|${x.publicKey}|${y.id}|${y.publicKey}`)));
  const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(`${PROTOCOL}|message-key`) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ---------------------------------------------------------------- pesan ---

export const MOMENT_TYPES = ["thought", "music", "place", "awake", "sleep"] as const;
export type MomentType = (typeof MOMENT_TYPES)[number];

/** Isi pesan sebelum dienkripsi. Server tidak pernah melihat bentuk ini. */
export type Payload =
  | { kind: "text"; text: string }
  | { kind: "ping" }
  | { kind: "identity"; text: string } // identitas asli yang dibuka sukarela
  | { kind: "moment"; type: MomentType; text: string }; // Path Moment (hanya di saluran "moment")

/**
 * Pemisahan domain: ciphertext untuk satu saluran tidak akan pernah bisa dibuka di saluran lain
 * (server tidak bisa menyulap salinan momen menjadi pesan chat, atau sebaliknya).
 */
export type Channel = "msg" | "moment";

export interface Envelope {
  id: string; // UUID pesan/momen, dibuat pengirim
  from: Party;
  to: Party;
}

function aad(env: Envelope, channel: Channel): Uint8Array<ArrayBuffer> {
  return enc.encode(`${PROTOCOL}|${channel}|${env.id}|${env.from.id}|${env.from.publicKey}|${env.to.id}|${env.to.publicKey}`);
}

export async function encryptPayload(key: CryptoKey, env: Envelope, payload: Payload, channel: Channel = "msg"): Promise<{ nonce: string; ciphertext: string }> {
  const plain = enc.encode(JSON.stringify(payload));
  if (plain.length > MAX_PLAINTEXT_BYTES) throw new E2EEError("too_large", "Pesan terlalu panjang");
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(env, channel) }, key, plain));
  return { nonce: toB64(nonce), ciphertext: toB64(ct) };
}

export async function decryptPayload(key: CryptoKey, env: Envelope, nonce: string, ciphertext: string, channel: Channel = "msg"): Promise<Payload> {
  const iv = fromB64(nonce);
  if (iv.length !== NONCE_BYTES) throw new E2EEError("bad_nonce", "Nonce tidak valid");
  let plain: ArrayBuffer;
  try {
    plain = await subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(env, channel) }, key, fromB64(ciphertext));
  } catch {
    // GCM gagal = kunci salah ATAU data diubah di jalan. Jangan pernah tampilkan sebagian.
    throw new E2EEError("decrypt_failed", "Pesan tidak bisa dibuka (rusak atau bukan untuk perangkat ini)");
  }
  const parsed: unknown = JSON.parse(dec.decode(plain));
  return validatePayload(parsed, channel);
}

function validatePayload(p: unknown, channel: Channel): Payload {
  if (typeof p === "object" && p !== null && "kind" in p) {
    const o = p as Record<string, unknown>;
    if (channel === "moment") {
      if (o.kind === "moment" && typeof o.text === "string" && (MOMENT_TYPES as readonly unknown[]).includes(o.type)) {
        return { kind: "moment", type: o.type as MomentType, text: o.text };
      }
    } else {
      if (o.kind === "ping") return { kind: "ping" };
      if ((o.kind === "text" || o.kind === "identity") && typeof o.text === "string") return { kind: o.kind, text: o.text };
    }
  }
  throw new E2EEError("bad_payload", "Format pesan tidak dikenal");
}

/**
 * Kunci untuk salinan milik sendiri (mis. momen yang kita tulis): X25519 dengan kunci publik
 * sendiri + label HKDF terpisah, jadi tidak pernah sama dengan kunci percakapan mana pun.
 */
export async function deriveSelfKey(myPrivateKey: CryptoKey, me: Party): Promise<CryptoKey> {
  const own = await importPublicKey(me.publicKey);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: own }, myPrivateKey, 256));
  const salt = new Uint8Array(await subtle.digest("SHA-256", enc.encode(`${PROTOCOL}|self-salt|${me.id}|${me.publicKey}`)));
  const ikm = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(`${PROTOCOL}|self-key`) }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// -------------------------------------------------------- safety number ---

async function fingerprintDigits(p: Party): Promise<string> {
  // Iterasi hash memperlambat pencarian kunci tandingan dengan safety number mirip.
  let data: Uint8Array<ArrayBuffer> = enc.encode(`${PROTOCOL}|fp|${p.id}|${p.publicKey}`);
  for (let i = 0; i < 1024; i++) data = new Uint8Array(await subtle.digest("SHA-256", data));
  let out = "";
  for (let i = 0; i < 6; i++) {
    const chunk = data.subarray(i * 5, i * 5 + 5);
    let n = 0;
    for (const b of chunk) n = n * 256 + b; // 40 bit, masih aman di Number
    out += String(n % 100000).padStart(5, "0");
  }
  return out;
}

/** 60 digit (12 grup × 5), identik di kedua sisi percakapan. */
export async function safetyNumber(a: Party, b: Party): Promise<string> {
  const [x, y] = ordered(a, b);
  const digits = (await fingerprintDigits(x)) + (await fingerprintDigits(y));
  return digits.match(/.{5}/g)!.join(" ");
}
