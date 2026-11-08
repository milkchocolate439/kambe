// Info pembayaran untuk kesepakatan LANGSUNG: rekening bank atau alamat dompet kripto (disarankan).
// Disimpan terenkripsi di brankas perangkat pemilik dan hanya dikirim ke lawan transaksi lewat E2EE.
// E-wallet sengaja TIDAK didukung: nomor akunnya adalah nomor HP (bertentangan dengan larangan berbagi nomor HP).
// Semua isi dari lawan = tidak dipercaya → divalidasi ulang sebelum ditampilkan.

import { bankNumberProblem, findContactLeak } from "./contactguard.ts";
import { cleanDisplayText } from "./sealed.ts";

export type PayKind = "bank" | "crypto";

export interface PayMethod {
  id: string;
  kind: PayKind;
  /** Bank: nama bank. Kripto: aset & jaringan, mis. "USDT · TRC20". */
  provider: string;
  /** Nama pemilik rekening (wajib untuk bank; opsional untuk kripto). */
  holder: string;
  /** Bank: nomor rekening (angka saja). Kripto: alamat dompet. */
  number: string;
}

export const PAY_METHODS_MAX = 6;
const CRYPTO_ADDR_RE = /^[A-Za-z0-9:_-]{20,128}$/;

/** Validasi + normalisasi. Melempar Error dengan pesan yang bisa ditampilkan. */
export function validatePayMethod(raw: unknown): PayMethod {
  const o = raw as Record<string, unknown>;
  if (typeof o !== "object" || o === null) throw new Error("Info pembayaran tidak valid");
  const kind = o.kind;
  if (kind !== "bank" && kind !== "crypto") throw new Error("Jenis pembayaran harus rekening bank atau dompet kripto");
  const str = (v: unknown, max: number) => (typeof v === "string" ? cleanDisplayText(v, max).trim() : "");
  const provider = str(o.provider, 40);
  const holder = str(o.holder, 60);
  const rawNumber = typeof o.number === "string" ? o.number.trim() : "";
  const id = typeof o.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(o.id) ? o.id : "x";
  if (provider.length < 2) throw new Error(kind === "bank" ? "Isi nama bank" : "Isi aset & jaringan, mis. USDT · TRC20");
  for (const t of [provider, holder]) {
    if (findContactLeak(t)) throw new Error("Nama bank/pemilik tidak boleh berisi nomor HP atau kontak luar");
  }
  if (kind === "bank") {
    if (holder.length < 2) throw new Error("Isi nama pemilik rekening");
    const problem = bankNumberProblem(rawNumber);
    if (problem) throw new Error(problem);
    return { id, kind, provider, holder, number: rawNumber.replace(/[\s.-]/g, "") };
  }
  if (!CRYPTO_ADDR_RE.test(rawNumber)) throw new Error("Alamat dompet tidak valid (20–128 karakter, huruf/angka)");
  return { id, kind, provider, holder, number: rawNumber };
}

/** Isi pesan E2EE "payinfo" (tanpa id lokal). */
export function encodePayInfo(m: PayMethod): string {
  return JSON.stringify({ kind: m.kind, provider: m.provider, holder: m.holder, number: m.number });
}

/** Urai pesan "payinfo" dari lawan; null bila tidak sah. */
export function decodePayInfo(text: string): PayMethod | null {
  try {
    return validatePayMethod(JSON.parse(text));
  } catch {
    return null;
  }
}
