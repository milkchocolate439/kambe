// Lampiran terenkripsi (foto bukti bayar, foto etalase).
// Foto dienkripsi DI PERANGKAT dengan kunci acak AES-256-GCM; server hanya menyimpan blob acak.
// Kuncinya ikut di dalam isi tersegel (sealed object) untuk pihak yang berhak — server tidak bisa membuka foto.

import { fromB64, toB64 } from "./e2ee.ts";

export const ATTACH_MAX_BYTES = 450 * 1024; // ukuran blob terenkripsi maksimum
export const ATTACH_MIMES = ["image/jpeg", "image/webp", "image/png"] as const;
export type AttachMime = (typeof ATTACH_MIMES)[number];

/** Rujukan lampiran di dalam isi tersegel. */
export interface AttachmentRef {
  id: string;
  key: string; // base64 kunci AES 32 byte
  sha256: string; // sidik blob terenkripsi (hex) — server tidak bisa menukar blob
  mime: AttachMime;
}

const subtle = globalThis.crypto.subtle;
const AAD = new TextEncoder().encode("kambe-attach|v1");

async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Enkripsi foto. Hasil: blob (iv|ciphertext), kunci, dan sidik blob. */
export async function encryptAttachment(bytes: Uint8Array): Promise<{ blob: Uint8Array<ArrayBuffer>; key: string; sha256: string }> {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const key = await subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, bytes as Uint8Array<ArrayBuffer>));
  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv);
  blob.set(ct, iv.length);
  if (blob.length > ATTACH_MAX_BYTES) throw new Error("Foto terlalu besar");
  return { blob, key: toB64(raw), sha256: await sha256Hex(blob) };
}

/** Buka foto: sidik harus cocok (blob tidak ditukar), lalu dekripsi (blob tidak diubah). */
export async function decryptAttachment(blob: Uint8Array, ref: Pick<AttachmentRef, "key" | "sha256">): Promise<Uint8Array> {
  if ((await sha256Hex(blob)) !== ref.sha256) throw new Error("Lampiran tidak cocok dengan sidiknya");
  const key = await subtle.importKey("raw", fromB64(ref.key), "AES-GCM", false, ["decrypt"]);
  const iv = blob.subarray(0, 12) as Uint8Array<ArrayBuffer>;
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, blob.subarray(12) as Uint8Array<ArrayBuffer>));
}

/** Validasi rujukan dari isi tersegel (data dari pihak lain = tidak dipercaya). */
export function validateRef(raw: unknown): AttachmentRef {
  const o = raw as Record<string, unknown>;
  if (
    typeof o !== "object" || o === null ||
    typeof o.id !== "string" || !/^[0-9a-f-]{36}$/.test(o.id) ||
    typeof o.key !== "string" || o.key.length !== 44 ||
    typeof o.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.sha256) ||
    !(ATTACH_MIMES as readonly unknown[]).includes(o.mime)
  ) {
    throw new Error("Rujukan lampiran tidak valid");
  }
  return { id: o.id, key: o.key, sha256: o.sha256, mime: o.mime as AttachMime };
}
