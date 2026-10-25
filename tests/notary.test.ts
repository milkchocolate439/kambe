import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, startApp } from "./helpers.ts";
import { parseReceipt, verifyChain, verifyReceipt, type SignedReceipt } from "../shared/receipt.ts";
import { createNotary, loadNotaryKey } from "../server/notary.ts";
import { createApp } from "../server/app.ts";

const key = () => crypto.randomUUID().replace(/-/g, "");
const SHIP = { courier: "JNE", tracking: "JNE1234567890" };

async function dealFlow() {
  const env = await startApp();
  const seller = new Client(env.base);
  const buyer = new Client(env.base);
  const s = await seller.signup("Penjual_Kopi");
  await buyer.signup("Pembeli_Kopi");
  await buyer.post("/api/contacts/invite", { pin: s.me.pin });
  await seller.post(`/api/contacts/requests/${(await seller.get("/api/contacts")).body.incoming[0].id}/accept`);
  await seller.post("/api/pro/subscribe", { idempotencyKey: key() });
  const prod = (await seller.post("/api/products", { title: "Arabica 1 Kg", sector: "Komoditas & Pangan", price: 200_000 })).body;
  const deal = (await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: key() })).body;
  return { ...env, seller, buyer, deal };
}

test("setiap perubahan status menerbitkan kuitansi notaris yang sah & berantai", async () => {
  const { app, base, seller, buyer, deal } = await dealFlow();
  const cfg = (await fetch(base + "/api/config").then((r) => r.json())) as { notaryPublicKey: string; feePerMille: number };
  assert.equal(cfg.notaryPublicKey, app.notaryPublicKey);
  assert.equal(cfg.feePerMille, 25);

  assert.equal(parseReceipt(deal.receipt).seq, 0);
  assert.equal(parseReceipt(deal.receipt).status, "AWAITING_PAYMENT");
  assert.equal(await verifyReceipt(cfg.notaryPublicKey, deal.receipt), true);

  await buyer.post(`/api/deals/${deal.id}/pay`);
  await seller.post(`/api/deals/${deal.id}/ship`, SHIP);
  const done = (await buyer.post(`/api/deals/${deal.id}/confirm`)).body;
  const last = parseReceipt(done.receipt);
  assert.equal(last.seq, 3);
  assert.equal(last.status, "COMPLETED");
  assert.equal(last.price, 200_000);
  assert.equal(last.fee, 5_000);
  assert.equal(last.sellerNet, 195_000);
  assert.equal(last.payRef, done.payRef);

  const chain = (await buyer.get(`/api/deals/${deal.id}/receipts`)).body.receipts as SignedReceipt[];
  assert.equal(chain.length, 4);
  assert.deepEqual(await verifyChain(cfg.notaryPublicKey, chain), { ok: true });
  assert.deepEqual(chain.map((c) => parseReceipt(c).status), ["AWAITING_PAYMENT", "HELD", "SHIPPED", "COMPLETED"]);
  await app.close();
});

test("kuitansi palsu / diubah / rantai dipotong terdeteksi klien", async () => {
  const { app, buyer, deal } = await dealFlow();
  await buyer.post(`/api/deals/${deal.id}/pay`);
  const chain = (await buyer.get(`/api/deals/${deal.id}/receipts`)).body.receipts as SignedReceipt[];
  const pub = app.notaryPublicKey;

  // Ubah harga di body tanpa tanda tangan baru.
  const tampered = { ...chain[1], body: chain[1].body.replace('"price":200000', '"price":1') };
  assert.equal(await verifyReceipt(pub, tampered), false);
  // Ditandatangani notaris PALSU (mis. server tiruan).
  const fake = createNotary();
  assert.equal(await verifyReceipt(pub, { body: chain[1].body, sig: fake.signBody(chain[1].body) }), false);
  // Riwayat dipotong (kuitansi #0 dibuang) atau ditukar urutannya.
  assert.equal((await verifyChain(pub, chain.slice(1))).ok, false);
  assert.equal((await verifyChain(pub, [chain[1], chain[0]])).ok, false);
  await app.close();
});

test("kuitansi hanya untuk pihak terkait; kode bayar sekali pakai tanpa identitas", async () => {
  const { app, base, buyer, deal } = await dealFlow();
  const eve = new Client(base);
  await eve.signup("Eve_Pengintip");
  assert.equal((await eve.get(`/api/deals/${deal.id}/receipts`)).status, 404);
  assert.match(deal.payRef, /^PP-[2-9A-HJ-NP-Z]{10}$/);
  const me = (await buyer.get("/api/me")).body.me;
  assert.ok(!deal.payRef.includes(me.pin) && !deal.payRef.includes(me.alias), "kode bayar tidak memuat PIN/alias");
  const d2 = (await buyer.post("/api/deals", { productId: deal.productId, idempotencyKey: key() })).body;
  assert.notEqual(d2.payRef, deal.payRef, "setiap kesepakatan punya kode bayar berbeda");
  await app.close();
});

test("fee dapat diatur lewat konfigurasi; tarif tidak masuk akal ditolak saat start", async () => {
  const app = createApp({ dbPath: ":memory:", feePerMille: 50 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const seller = new Client(base);
  const buyer = new Client(base);
  const s = await seller.signup("Penjual_5persen");
  await buyer.signup("Pembeli_5persen");
  await buyer.post("/api/contacts/invite", { pin: s.me.pin });
  await seller.post(`/api/contacts/requests/${(await seller.get("/api/contacts")).body.incoming[0].id}/accept`);
  await seller.post("/api/pro/subscribe", { idempotencyKey: key() });
  const prod = (await seller.post("/api/products", { title: "Jasa desain", sector: "Desain & Kreatif", price: 100_000 })).body;
  const deal = (await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: key() })).body;
  assert.equal(deal.fee, 5_000, "5% sesuai konfigurasi");
  assert.equal((await fetch(base + "/api/config").then((r) => r.json()) as { feePerMille: number }).feePerMille, 50);
  await app.close();
  assert.throws(() => createApp({ dbPath: ":memory:", feePerMille: 500 }), /0–200/);
});

test("kunci notaris permanen: dibuat sekali dengan izin 0600 dan dimuat ulang identik", () => {
  const dir = mkdtempSync(join(tmpdir(), "notary-"));
  const path = join(dir, "notary.key");
  const k1 = loadNotaryKey(undefined, path);
  assert.equal(statSync(path).mode & 0o777, 0o600, "berkas kunci hanya bisa dibaca pemilik");
  const k2 = loadNotaryKey(undefined, path);
  assert.equal(createNotary(k1).publicKey, createNotary(k2).publicKey);
  const fromEnv = generateKeyPairSync("ed25519").privateKey;
  const envB64 = fromEnv.export({ format: "der", type: "pkcs8" }).toString("base64");
  assert.equal(createNotary(loadNotaryKey(envB64, path)).publicKey, createNotary(fromEnv).publicKey);
  rmSync(dir, { recursive: true, force: true });
});
