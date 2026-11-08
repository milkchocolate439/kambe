import { test } from "node:test";
import assert from "node:assert/strict";
import { createNotary } from "../server/notary.ts";
import { generateSeed, identityFromSeed, signIdentityFromSeed } from "../shared/vault.ts";
import { RECEIPT_KIND, receiptHash, type ReceiptBody, type SignedReceipt } from "../shared/receipt.ts";
import { comparePeerEntry, parseTxEntry, signTxEntry, TXLOG_KIND, txEntryHash, verifyTxEntry, verifyTxEvidence, type SignedTxEntry, type TxEntryBody, type TxEvidence } from "../shared/txlog.ts";
import { toB64 } from "../shared/e2ee.ts";

const DEAL = "deal-1";
const BUYER = "user-buyer";
const SELLER = "user-seller";

/** Rantai kuitansi notaris sungguhan: #0 dibuat, #1 dibayar (HELD). */
async function chainOf(notary = createNotary()) {
  const receipts: SignedReceipt[] = [];
  let prev = "";
  for (const [seq, status] of [[0, "AWAITING_PAYMENT"], [1, "HELD"]] as const) {
    const body: ReceiptBody = { v: 1, kind: RECEIPT_KIND, dealId: DEAL, seq, status, buyerId: BUYER, sellerId: SELLER, contentHash: "c", price: 200_000, fee: 0, sellerNet: 200_000, payRef: "PP-ABCDEFGHJK", at: 1000 + seq, prev };
    const text = JSON.stringify(body);
    const r = { body: text, sig: notary.signBody(text) };
    receipts.push(r);
    prev = await receiptHash(r);
  }
  return { notary, receipts };
}

async function entryFor(who: { id: string; sign: Awaited<ReturnType<typeof signIdentityFromSeed>> }, receipts: SignedReceipt[], seq: number, over: Partial<TxEntryBody> = {}): Promise<SignedTxEntry> {
  const rb = JSON.parse(receipts[seq].body) as ReceiptBody;
  const body: TxEntryBody = { v: 1, kind: TXLOG_KIND, dealId: DEAL, seq, status: rb.status, price: rb.price, fee: rb.fee, receiptHash: await receiptHash(receipts[seq]), signer: who.id, at: 5000, prev: "", ...over };
  return signTxEntry(who.sign.privateKey, who.sign.publicKey, body);
}

async function party(id: string) {
  const seed = generateSeed();
  return { id, seed, sign: await signIdentityFromSeed(seed) };
}

test("kunci tanda tangan: deterministik dari seed, terpisah dari kunci identitas, dan non-extractable", async () => {
  const seed = generateSeed();
  const a = await signIdentityFromSeed(seed);
  const b = await signIdentityFromSeed(seed);
  assert.equal(a.publicKey, b.publicKey, "seed sama → kunci tanda tangan sama di perangkat mana pun");
  assert.notEqual(a.publicKey, (await identityFromSeed(seed)).publicKey, "bukan kunci yang sama dengan identitas E2EE");
  assert.notEqual(a.publicKey, (await signIdentityFromSeed(generateSeed())).publicKey);
  assert.equal(a.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("pkcs8", a.privateKey));
});

test("entri bertanda tangan: sah diterima; diubah, ditukar kunci, atau rusak ditolak", async () => {
  const buyer = await party(BUYER);
  const { receipts } = await chainOf();
  const e = await entryFor(buyer, receipts, 1);
  assert.equal(await verifyTxEntry(e), true);
  assert.equal(parseTxEntry(e).signer, BUYER);
  assert.equal(await verifyTxEntry({ ...e, body: e.body.replace('"price":200000', '"price":1') }), false, "isi diubah");
  const other = await party(SELLER);
  assert.equal(await verifyTxEntry({ ...e, signKey: other.sign.publicKey }), false, "kunci penanda tangan ditukar");
  assert.equal(await verifyTxEntry({ ...e, sig: toB64(new Uint8Array(64)) }), false, "tanda tangan palsu");
  assert.equal(await verifyTxEntry({ ...e, signKey: "bukan-base64!!" }), false);
  assert.throws(() => parseTxEntry({ ...e, body: "{}" }));
  assert.throws(() => parseTxEntry({ ...e, body: JSON.stringify({ ...JSON.parse(e.body), price: 1.5 }) }), /isi entri/);
  assert.match(await txEntryHash(e), /^[0-9a-f]{64}$/);
});

test("comparePeerEntry: cocok bila sidik kuitansi sama; beda sidik/harga/status = mismatch", async () => {
  const buyer = await party(BUYER);
  const { receipts } = await chainOf();
  const mine = { status: "HELD" as const, price: 200_000, fee: 0, receiptHash: await receiptHash(receipts[1]) };
  const peer = parseTxEntry(await entryFor(buyer, receipts, 1));
  assert.equal(comparePeerEntry(mine, peer), "ok");
  assert.equal(comparePeerEntry(mine, { ...peer, receiptHash: "0".repeat(64) }), "mismatch");
  assert.equal(comparePeerEntry(mine, { ...peer, price: 199_999 }), "mismatch");
  assert.equal(comparePeerEntry(mine, { ...peer, status: "SHIPPED" }), "mismatch");
});

test("berkas bukti: dua pihak menandatangani kuitansi notaris yang sama = tiga tanda tangan", async () => {
  const buyer = await party(BUYER);
  const seller = await party(SELLER);
  const { notary, receipts } = await chainOf();
  const ev: TxEvidence = { v: 1, dealId: DEAL, receipts, entries: [await entryFor(buyer, receipts, 1), await entryFor(seller, receipts, 1), await entryFor(buyer, receipts, 0)] };
  const r = await verifyTxEvidence(notary.publicKey, ev);
  assert.equal(r.chainOk, true);
  assert.deepEqual(r.tripleSeqs, [1], "seq 1 ditandatangani kedua pihak; seq 0 hanya satu pihak");
  assert.ok(r.entries.every((x) => x.signatureOk && x.matchesNotary));
});

test("berkas bukti: pihak yang melihat kuitansi LAIN (notaris curang) tidak dihitung tiga tanda tangan", async () => {
  const buyer = await party(BUYER);
  const seller = await party(SELLER);
  const { notary, receipts } = await chainOf();
  // Penjual menandatangani sidik kuitansi yang berbeda dari rantai yang diekspor.
  const forged = await entryFor(seller, receipts, 1, { receiptHash: "f".repeat(64) });
  const r = await verifyTxEvidence(notary.publicKey, { v: 1, dealId: DEAL, receipts, entries: [await entryFor(buyer, receipts, 1), forged] });
  assert.deepEqual(r.tripleSeqs, []);
  assert.equal(r.entries.find((x) => x.signer === SELLER)?.matchesNotary, false);
  assert.equal(r.entries.find((x) => x.signer === SELLER)?.signatureOk, true, "tanda tangannya sah — isinya yang berbeda");
});

test("berkas bukti: entri tanda tangan rusak, rantai notaris palsu, dan entri kesepakatan lain ditolak", async () => {
  const buyer = await party(BUYER);
  const seller = await party(SELLER);
  const { notary, receipts } = await chainOf();
  const good = await entryFor(buyer, receipts, 1);
  const bad = { ...(await entryFor(seller, receipts, 1)), sig: good.sig };
  let r = await verifyTxEvidence(notary.publicKey, { v: 1, dealId: DEAL, receipts, entries: [good, bad] });
  assert.deepEqual(r.tripleSeqs, [], "tanda tangan salah satu pihak tidak sah");
  assert.equal(r.entries[1].signatureOk, false);

  r = await verifyTxEvidence(createNotary().publicKey, { v: 1, dealId: DEAL, receipts, entries: [good, await entryFor(seller, receipts, 1)] });
  assert.equal(r.chainOk, false, "kunci notaris lain: rantai tidak sah");
  assert.deepEqual(r.tripleSeqs, []);

  const otherDeal = await entryFor(seller, receipts, 1, { dealId: "deal-2" });
  r = await verifyTxEvidence(notary.publicKey, { v: 1, dealId: DEAL, receipts, entries: [good, otherDeal] });
  assert.deepEqual(r.tripleSeqs, [], "entri kesepakatan lain tidak dihitung");

  r = await verifyTxEvidence(notary.publicKey, { v: 1, dealId: DEAL, receipts, entries: [{ body: "{}", sig: "x", signKey: "y" }] });
  assert.equal(r.entries[0].signatureOk, false);
});
