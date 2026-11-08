// Buku Jejak Transaksi — catatan transaksi yang ditandatangani TIGA pihak.
//
// Versi AMAN dari "Zero-Click Report Log" di konsep: hash saja bukan bukti (siapa pun bisa menghitungnya),
// jadi di sini setiap entri DITANDATANGANI kunci perangkat (Ed25519) dan terikat pada kuitansi notaris:
//
//   1. notaris : kuitansi kesepakatan (shared/receipt.ts) — satu-satunya sumber kebenaran status
//   2. saya    : entri ini, ditandatangani kunci perangkatku, memuat sidik (hash) kuitansi yang KULIHAT
//   3. lawan   : entri miliknya dengan sidik kuitansi yang IA lihat
//
// Bila sidik kedua pihak sama → "tiga tanda tangan". Bila beda → notaris (atau jalur ke salah satu pihak)
// menunjukkan kuitansi berbeda: kejadian serius, ditandai dan bisa diekspor sebagai bukti. TIDAK otomatis
// menjadi sengketa (data rusak dari orang iseng tidak boleh membuka sengketa palsu).

import { fromB64, toB64 } from "./e2ee.ts";
import type { DealStatus } from "./protocol.ts";
import { parseReceipt, receiptHash, verifyChain, type SignedReceipt } from "./receipt.ts";

export const TXLOG_KIND = "kambe.txlog";

export interface TxEntryBody {
  v: 1;
  kind: typeof TXLOG_KIND;
  dealId: string;
  /** Nomor urut kuitansi notaris yang dicatat. */
  seq: number;
  status: DealStatus;
  price: number;
  fee: number;
  /** sha256(hex) body+sig kuitansi notaris yang dilihat penanda tangan. */
  receiptHash: string;
  /** ID akun penanda tangan. */
  signer: string;
  at: number;
  /** Sidik entri sebelumnya milik penanda tangan untuk kesepakatan yang sama ("" untuk yang pertama). */
  prev: string;
}

/** Dikirim apa adanya: `body` = string JSON persis yang ditandatangani. */
export interface SignedTxEntry {
  body: string;
  sig: string;
  /** Kunci publik Ed25519 penanda tangan (raw 32 byte, base64). Pemverifikasi WAJIB mencocokkannya dengan kunci yang dipin. */
  signKey: string;
}

const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;

export async function signTxEntry(privateKey: CryptoKey, signKey: string, body: TxEntryBody): Promise<SignedTxEntry> {
  const text = JSON.stringify(body);
  const sig = new Uint8Array(await subtle.sign({ name: "Ed25519" }, privateKey, enc.encode(text)));
  return { body: text, sig: toB64(sig), signKey };
}

export function parseTxEntry(e: SignedTxEntry): TxEntryBody {
  if (typeof e?.body !== "string" || typeof e.sig !== "string" || typeof e.signKey !== "string" || e.body.length > 2048) throw new Error("bentuk entri tidak valid");
  const b = JSON.parse(e.body) as TxEntryBody;
  if (
    b.v !== 1 || b.kind !== TXLOG_KIND || typeof b.dealId !== "string" || typeof b.signer !== "string" || typeof b.status !== "string" ||
    typeof b.receiptHash !== "string" || typeof b.prev !== "string" ||
    !Number.isSafeInteger(b.seq) || b.seq < 0 || !Number.isSafeInteger(b.price) || !Number.isSafeInteger(b.fee) || !Number.isSafeInteger(b.at)
  ) {
    throw new Error("isi entri tidak dikenal");
  }
  return b;
}

/** true bila tanda tangan sah untuk `e.signKey`. (Kecocokan kunci dengan pin dicek pemanggil.) */
export async function verifyTxEntry(e: SignedTxEntry): Promise<boolean> {
  try {
    const key = await subtle.importKey("raw", fromB64(e.signKey), { name: "Ed25519" }, false, ["verify"]);
    return await subtle.verify({ name: "Ed25519" }, key, fromB64(e.sig), enc.encode(e.body));
  } catch {
    return false;
  }
}

export async function txEntryHash(e: SignedTxEntry): Promise<string> {
  const d = new Uint8Array(await subtle.digest("SHA-256", enc.encode(`${e.body}|${e.sig}`)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type PairState = "ok" | "mismatch";

/** Cocokkan entri lawan dengan kuitansi yang kulihat untuk (dealId, seq) yang sama. */
export function comparePeerEntry(mine: { status: DealStatus; price: number; fee: number; receiptHash: string }, peer: TxEntryBody): PairState {
  return peer.receiptHash === mine.receiptHash && peer.status === mine.status && peer.price === mine.price && peer.fee === mine.fee ? "ok" : "mismatch";
}

// ---------------------------------------------------------------- bukti ---

/** Berkas bukti yang bisa diberikan ke moderator / pihak ketiga. */
export interface TxEvidence {
  v: 1;
  dealId: string;
  /** Rantai kuitansi notaris seperti yang diterima si pengekspor. */
  receipts: SignedReceipt[];
  /** Entri ditandatangani perangkat milik kedua pihak (yang dimiliki pengekspor). */
  entries: SignedTxEntry[];
}

export interface EvidenceReport {
  /** Rantai kuitansi sah (semua tanda tangan notaris benar, berurutan, tersambung). */
  chainOk: boolean;
  reason?: string;
  /** Per entri: tanda tangan sah & isinya cocok dengan kuitansi notaris di seq yang sama. */
  entries: { signer: string; seq: number; signatureOk: boolean; matchesNotary: boolean }[];
  /** Pasangan seq yang kedua pihak tandatangani DAN cocok dengan notaris = "tiga tanda tangan". */
  tripleSeqs: number[];
}

/** Periksa berkas bukti dengan kunci publik notaris. Tidak butuh rahasia apa pun. */
export async function verifyTxEvidence(notaryPublicKey: string, ev: TxEvidence): Promise<EvidenceReport> {
  const chain = await verifyChain(notaryPublicKey, ev.receipts);
  const report: EvidenceReport = { chainOk: chain.ok, reason: chain.reason, entries: [], tripleSeqs: [] };
  const hashes: string[] = [];
  const bodies = ev.receipts.map((r) => parseReceipt(r));
  for (const r of ev.receipts) hashes.push(await receiptHash(r));
  const bySeq = new Map<number, Set<string>>();
  for (const e of ev.entries) {
    let body: TxEntryBody;
    try {
      body = parseTxEntry(e);
    } catch {
      report.entries.push({ signer: "?", seq: -1, signatureOk: false, matchesNotary: false });
      continue;
    }
    const signatureOk = await verifyTxEntry(e);
    const r = bodies[body.seq];
    const matchesNotary = !!r && body.dealId === ev.dealId && r.dealId === ev.dealId && hashes[body.seq] === body.receiptHash && r.status === body.status && r.price === body.price && r.fee === body.fee;
    report.entries.push({ signer: body.signer, seq: body.seq, signatureOk, matchesNotary });
    if (signatureOk && matchesNotary && chain.ok) {
      const set = bySeq.get(body.seq) ?? new Set<string>();
      set.add(body.signer);
      bySeq.set(body.seq, set);
    }
  }
  for (const [seq, signers] of bySeq) if (signers.size >= 2) report.tripleSeqs.push(seq);
  report.tripleSeqs.sort((a, b) => a - b);
  return report;
}
