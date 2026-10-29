// Kuitansi kesepakatan bertanda tangan notaris (Ed25519).
//
// Versi yang BENAR dari "cryptographic proof" di dokumen konsep: tanda tangan dibuat dengan kunci
// PRIVAT notaris yang hanya ada di server; setiap ponsel memverifikasi dengan kunci PUBLIK notaris.
// Kuitansi dirantai (prev = hash kuitansi sebelumnya), jadi riwayat yang diubah/dipotong ketahuan.
// Dipakai di browser & Node (Web Crypto Ed25519).

import { fromB64 } from "./e2ee.ts";
import type { DealStatus } from "./protocol.ts";

export const RECEIPT_KIND = "pinpath.deal-receipt"; // label protokol, jangan diganti (lihat spec KAMBE)

export interface ReceiptBody {
  v: 1;
  kind: typeof RECEIPT_KIND;
  dealId: string;
  seq: number; // 0 = dibuat, lalu +1 setiap perubahan status
  status: DealStatus;
  buyerId: string;
  sellerId: string;
  /** Sidik isi terenkripsi kesepakatan (judul) — mengikat kuitansi ke isi tanpa membukanya. */
  contentHash: string;
  price: number;
  fee: number;
  sellerNet: number;
  payRef: string; // kode referensi bayar sekali pakai (tanpa identitas)
  at: number;
  prev: string; // sha256(hex) dari body+sig kuitansi sebelumnya; "" untuk seq 0
}

/** Kuitansi dikirim apa adanya: `body` adalah string JSON persis yang ditandatangani (tanpa kanonisasi ulang). */
export interface SignedReceipt {
  body: string;
  sig: string; // base64 tanda tangan Ed25519 atas UTF-8 `body`
}

const enc = new TextEncoder();

export async function receiptHash(r: SignedReceipt): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", enc.encode(`${r.body}|${r.sig}`)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseReceipt(r: SignedReceipt): ReceiptBody {
  const b = JSON.parse(r.body) as ReceiptBody;
  if (b.v !== 1 || b.kind !== RECEIPT_KIND || typeof b.dealId !== "string" || !Number.isSafeInteger(b.seq)) throw new Error("format kuitansi tidak dikenal");
  return b;
}

/** true bila tanda tangan sah untuk kunci publik notaris (raw 32 byte, base64). */
export async function verifyReceipt(notaryPublicKey: string, r: SignedReceipt): Promise<boolean> {
  try {
    const key = await globalThis.crypto.subtle.importKey("raw", fromB64(notaryPublicKey), { name: "Ed25519" }, false, ["verify"]);
    return await globalThis.crypto.subtle.verify({ name: "Ed25519" }, key, fromB64(r.sig), enc.encode(r.body));
  } catch {
    return false;
  }
}

/** Verifikasi seluruh rantai: setiap tanda tangan sah, seq berurutan, dan prev menunjuk kuitansi sebelumnya. */
export async function verifyChain(notaryPublicKey: string, chain: SignedReceipt[]): Promise<{ ok: boolean; reason?: string }> {
  let prevHash = "";
  for (let i = 0; i < chain.length; i++) {
    if (!(await verifyReceipt(notaryPublicKey, chain[i]))) return { ok: false, reason: `tanda tangan kuitansi #${i} tidak sah` };
    const b = parseReceipt(chain[i]);
    if (b.seq !== i) return { ok: false, reason: `urutan kuitansi rusak di #${i}` };
    if (b.prev !== prevHash) return { ok: false, reason: `rantai kuitansi terputus di #${i}` };
    prevHash = await receiptHash(chain[i]);
  }
  return { ok: true };
}
