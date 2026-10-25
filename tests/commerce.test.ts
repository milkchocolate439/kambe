import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, startApp, TEST_PASSPHRASE } from "./helpers.ts";
import { platformFee, PRO_PRICE } from "../shared/protocol.ts";
import type { DealTimers } from "../server/commerce.ts";

const key = () => crypto.randomUUID().replace(/-/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SHIP = { courier: "JNE", tracking: "jne1234567890" };
const DISPUTE = { reason: "not_received", text: "Paket belum sampai padahal status resi sudah terkirim." };

/** Penjual PRO dengan satu produk + pembeli yang sudah terhubung. */
async function market(opts: { dealTimers?: Partial<DealTimers> } = {}) {
  const env = await startApp(opts);
  const seller = new Client(env.base);
  const buyer = new Client(env.base);
  const s = await seller.signup("KopiGayo_Roaster");
  const b = await buyer.signup("Anon_Wolf99");
  await buyer.post("/api/contacts/invite", { pin: s.me.pin });
  const inc = (await seller.get("/api/contacts")).body.incoming;
  await seller.post(`/api/contacts/requests/${inc[0].id}/accept`);
  assert.equal((await seller.post("/api/pro/subscribe", { idempotencyKey: key() })).status, 200);
  const prod = (await seller.post("/api/products", { title: "Arabica Gayo Wine 5 Kg", description: "Panen terbaru", sector: "Komoditas & Pangan", price: 850_000 })).body;
  return { ...env, seller, buyer, s: s.me, b: b.me, prod };
}

test("fee default 5%: bilangan bulat, pembulatan setengah ke atas", () => {
  assert.equal(platformFee(1_000), 50);
  assert.equal(platformFee(1_009), 50); // 50,45 → 50
  assert.equal(platformFee(1_010), 51); // 50,5  → 51
  assert.equal(platformFee(850_000), 42_500);
  assert.equal(platformFee(100_000_000), 5_000_000);
});

test("tarif lain tetap bisa dipakai (mis. 2,5%) dengan pembulatan yang sama", () => {
  assert.equal(platformFee(1_000, 25), 25);
  assert.equal(platformFee(1_019, 25), 25); // 25,475 → 25
  assert.equal(platformFee(1_020, 25), 26); // 25,5 → 26
  assert.equal(platformFee(850_000, 25), 21_250);
});

test("PRO: etalase terkunci untuk pengguna gratis; langganan idempoten", async () => {
  const { app, base } = await startApp();
  const c = new Client(base);
  await c.signup("calon_pro");
  const blocked = await c.post("/api/products", { title: "Jasa desain", sector: "Desain & Kreatif", price: 100_000 });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, "pro_required");

  const k = key();
  const first = (await c.post("/api/pro/subscribe", { idempotencyKey: k })).body;
  const again = (await c.post("/api/pro/subscribe", { idempotencyKey: k })).body; // klik ganda / retry
  assert.equal(first.active, true);
  assert.equal(first.proUntil, again.proUntil);
  assert.equal(app.audit().platform, PRO_PRICE, "langganan hanya ditagih sekali");
  const extended = (await c.post("/api/pro/subscribe", { idempotencyKey: key() })).body;
  assert.ok(extended.proUntil - first.proUntil > 29 * 86_400_000, "perpanjangan menambah 30 hari dari masa aktif");
  assert.equal(app.audit().balanced, true);
  await app.close();
});

test("validasi produk: harga harus rupiah bulat & dalam batas, teks dibersihkan", async () => {
  const { app, seller } = await market();
  for (const price of [1000.5, 999, 100_000_001, "850000", -5, Number.MAX_SAFE_INTEGER + 2]) {
    const r = await seller.post("/api/products", { title: "Produk", sector: "Lainnya", price });
    assert.equal(r.status, 400, `harga ${price} seharusnya ditolak`);
  }
  assert.equal((await seller.post("/api/products", { title: "Produk", sector: "Sektor Palsu", price: 5000 })).status, 400);
  const p = (await seller.post("/api/products", { title: "Madu‮ hutan\u0000", sector: "Lainnya", price: 5000 })).body;
  assert.equal(p.title, "Madu hutan");
  await app.close();
});

test("etalase hanya terlihat oleh kontak, dan hilang saat PRO berakhir", async () => {
  const { app, base, buyer, s, prod } = await market();
  const view = (await buyer.get(`/api/users/${s.id}/products`)).body;
  assert.equal(view.pro, true);
  assert.equal(view.products[0].id, prod.id);
  const stranger = new Client(base);
  await stranger.signup("orang_asing");
  assert.equal((await stranger.get(`/api/users/${s.id}/products`)).status, 404);
  app.db.prepare("UPDATE users SET pro_until = 0 WHERE id = ?").run(s.id);
  const expired = (await buyer.get(`/api/users/${s.id}/products`)).body;
  assert.deepEqual(expired, { pro: false, products: [] });
  await app.close();
});

test("alur rekber lengkap: harga dari server, dana ditahan, cair setelah konfirmasi", async () => {
  const { app, seller, buyer, prod } = await market();
  // Klien jahat mencoba mengirim harga sendiri — diabaikan, server memakai harga produk.
  const deal = (await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: key(), price: 1, fee: 0 })).body;
  assert.equal(deal.price, 850_000);
  assert.equal(deal.fee, 42_500); // 5%
  assert.equal(deal.sellerNet, 807_500);
  assert.deepEqual(deal.actions.sort(), ["cancel", "pay"]);

  const paid = (await buyer.post(`/api/deals/${deal.id}/pay`)).body;
  assert.equal(paid.status, "HELD");
  assert.equal((await buyer.get("/api/wallet")).body.outgoingHeld, 850_000);
  assert.equal((await seller.get("/api/wallet")).body.incomingHeld, 807_500);
  assert.equal((await seller.get("/api/wallet")).body.balance, 0, "dana belum cair sebelum dikonfirmasi");

  assert.equal((await seller.post(`/api/deals/${deal.id}/ship`, SHIP)).body.status, "SHIPPED");
  const done = (await buyer.post(`/api/deals/${deal.id}/confirm`)).body;
  assert.equal(done.status, "COMPLETED");
  assert.deepEqual(done.actions, []);
  assert.equal((await seller.get("/api/wallet")).body.balance, 807_500);
  const audit = app.audit();
  assert.equal(audit.balanced, true);
  assert.equal(audit.escrow, 0);
  assert.equal(audit.platform, PRO_PRICE + 42_500);
  await app.close();
});

test("klik ganda / request paralel tidak mencairkan dana dua kali", async () => {
  const { app, buyer, prod } = await market();
  const k = key();
  const [d1, d2] = await Promise.all([1, 2].map(() => buyer.post("/api/deals", { productId: prod.id, idempotencyKey: k })));
  assert.equal(d1.body.id, d2.body.id, "kunci idempoten sama → kesepakatan sama");
  assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM deals").get() as { n: number }).n, 1);

  const pays = await Promise.all(Array.from({ length: 5 }, () => buyer.post(`/api/deals/${d1.body.id}/pay`)));
  assert.equal(pays.filter((r) => r.status === 200).length, 1);
  assert.ok(pays.filter((r) => r.status !== 200).every((r) => r.status === 409));
  const confirms = await Promise.all(Array.from({ length: 5 }, () => buyer.post(`/api/deals/${d1.body.id}/confirm`)));
  assert.equal(confirms.filter((r) => r.status === 200).length, 1);
  const releases = app.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'deal_release'").get() as { n: number };
  assert.equal(releases.n, 3, "satu posting pencairan = 3 baris (escrow, penjual, platform)");
  assert.equal(app.audit().balanced, true);
  await app.close();
});

test("peran ditegakkan: pembeli tak bisa 'kirim', penjual tak bisa 'konfirmasi', orang luar 404", async () => {
  const { app, base, seller, buyer, prod } = await market();
  const deal = (await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: key() })).body;
  assert.equal((await seller.post(`/api/deals/${deal.id}/pay`)).status, 409);
  await buyer.post(`/api/deals/${deal.id}/pay`);
  assert.equal((await buyer.post(`/api/deals/${deal.id}/ship`, SHIP)).status, 409);
  assert.equal((await seller.post(`/api/deals/${deal.id}/confirm`)).status, 409);
  assert.equal((await buyer.post(`/api/deals/${deal.id}/hack`)).status, 404);
  const eve = new Client(base);
  await eve.signup("eve_pencuri");
  for (const a of ["confirm", "refund", "ship", "cancel"]) assert.equal((await eve.post(`/api/deals/${deal.id}/${a}`)).status, 404);
  assert.equal((await eve.get("/api/deals")).body.deals.length, 0);
  assert.equal((await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: key() })).status, 200);
  assert.equal((await seller.post("/api/deals", { productId: prod.id, idempotencyKey: key() })).status, 400, "beli produk sendiri ditolak");
  await app.close();
});

test("refund & sengketa: dana kembali utuh tanpa fee; sengketa bisa diselesaikan kedua pihak", async () => {
  const { app, seller, buyer, prod } = await market();
  const d1 = (await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: key() })).body;
  await buyer.post(`/api/deals/${d1.id}/pay`);
  assert.equal((await seller.post(`/api/deals/${d1.id}/refund`)).body.status, "REFUNDED");
  assert.equal((await buyer.get("/api/wallet")).body.outgoingHeld, 0);

  const d2 = (await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: key() })).body;
  await buyer.post(`/api/deals/${d2.id}/pay`);
  await seller.post(`/api/deals/${d2.id}/ship`, SHIP);
  const disputed = (await buyer.post(`/api/deals/${d2.id}/dispute`, DISPUTE)).body;
  assert.equal(disputed.status, "DISPUTED");
  assert.deepEqual(disputed.actions, ["confirm"]);
  assert.equal(disputed.autoReleaseAt, null, "sengketa menghentikan pencairan otomatis");
  assert.deepEqual((await seller.get(`/api/deals?peer=${disputed.buyerId}`)).body.deals.find((d: { id: string }) => d.id === d2.id).actions, ["refund"]);
  assert.equal((await buyer.post(`/api/deals/${d2.id}/confirm`)).body.status, "COMPLETED");

  const audit = app.audit();
  assert.equal(audit.balanced, true);
  assert.equal(audit.platform, PRO_PRICE + 42_500, "refund tidak memotong fee");
  await app.close();
});

test("pencairan otomatis setelah dikirim bila pembeli diam (penjual tidak tersandera)", async () => {
  const { app, seller, buyer, prod } = await market({ dealTimers: { autoReleaseMs: 50 } });
  const deal = (await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: key() })).body;
  await buyer.post(`/api/deals/${deal.id}/pay`);
  const shipped = (await seller.post(`/api/deals/${deal.id}/ship`, SHIP)).body;
  assert.ok(shipped.autoReleaseAt >= shipped.shippedAt + 50);
  assert.equal(shipped.autoRefundAt, null, "setelah dikirim tidak ada refund otomatis");
  assert.equal(app.runTimers(shipped.shippedAt + 10).released, 0, "belum waktunya");
  assert.equal(app.runTimers(shipped.shippedAt + 60).released, 1);
  assert.equal((await seller.get("/api/wallet")).body.balance, 807_500);
  assert.equal(app.runTimers(shipped.shippedAt + 120).released, 0, "tidak dicairkan dua kali");
  assert.equal(app.audit().balanced, true);
  await app.close();
});

test("regresi red-team F1: penjual tak mengirim → pembeli bisa tarik dana setelah batas kirim", async () => {
  const { app, seller, buyer, prod } = await market({ dealTimers: { shipWindowMs: 80 } });
  const deal = (await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: key() })).body;
  const held = (await buyer.post(`/api/deals/${deal.id}/pay`)).body;
  assert.ok(held.shipBy >= held.paidAt + 80);
  assert.ok(!held.actions.includes("refund"), "belum boleh tarik dana selama penjual masih dalam batas kirim");
  const early = await buyer.post(`/api/deals/${deal.id}/refund`);
  assert.equal(early.status, 409);
  assert.match(early.body.message, /batas waktu pengiriman/);
  await sleep(120);
  const list = (await buyer.get(`/api/deals?peer=${held.sellerId}`)).body.deals;
  assert.ok(list[0].actions.includes("refund"), "setelah lewat batas, tombol tarik dana tersedia");
  assert.equal((await buyer.post(`/api/deals/${deal.id}/refund`)).body.status, "REFUNDED");
  assert.equal((await buyer.get("/api/wallet")).body.outgoingHeld, 0);
  assert.equal((await seller.post(`/api/deals/${deal.id}/ship`, SHIP)).status, 409, "penjual tak bisa 'kirim' setelah dana ditarik");
  assert.equal(app.audit().balanced, true);
  await app.close();
});

test("regresi red-team F1: dana HELD kembali otomatis bila penjual menghilang", async () => {
  const { app, buyer, prod } = await market();
  const deal = (await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: key() })).body;
  const held = (await buyer.post(`/api/deals/${deal.id}/pay`)).body;
  assert.equal(held.autoRefundAt, held.paidAt + 7 * 86_400_000);
  assert.equal(app.runTimers(held.autoRefundAt - 1).refunded, 0);
  assert.equal(app.runTimers(held.autoRefundAt + 1).refunded, 1);
  const after = (await buyer.get(`/api/deals?peer=${held.sellerId}`)).body.deals[0];
  assert.equal(after.status, "REFUNDED");
  assert.equal(app.audit().balanced, true);
  assert.equal(app.audit().platform, PRO_PRICE, "refund otomatis tanpa fee");
  await app.close();
});

test("regresi red-team F1: sengketa buntu berakhir — dana kembali ke pembeli", async () => {
  const { app, seller, buyer, prod } = await market();
  const deal = (await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: key() })).body;
  await buyer.post(`/api/deals/${deal.id}/pay`);
  await seller.post(`/api/deals/${deal.id}/ship`, SHIP);
  const disputed = (await buyer.post(`/api/deals/${deal.id}/dispute`, DISPUTE)).body;
  assert.equal(disputed.autoReleaseAt, null);
  assert.ok(disputed.autoRefundAt > Date.now() + 13 * 86_400_000, "sengketa punya batas 14 hari");
  assert.deepEqual(app.runTimers(disputed.autoRefundAt - 1), { released: 0, refunded: 0 });
  assert.deepEqual(app.runTimers(disputed.autoRefundAt + 1), { released: 0, refunded: 1 });
  assert.equal((await seller.get("/api/wallet")).body.balance, 0);
  assert.equal(app.audit().balanced, true);
  await app.close();
});

test("regresi red-team F2: kunci idempoten tidak bisa dipakai ulang untuk permintaan lain", async () => {
  const { app, seller, buyer, b, prod } = await market();
  const other = (await seller.post("/api/products", { title: "Mesin roasting", sector: "Lainnya", price: 20_000_000 })).body;
  const k = key();
  const first = await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: k });
  assert.equal((await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: k })).body.id, first.body.id, "retry yang sama tetap idempoten");
  const reuse = await buyer.post("/api/deals", { productId: other.id, idempotencyKey: k });
  assert.equal(reuse.status, 409);
  assert.equal(reuse.body.error, "idem_conflict");
  const ok = key();
  await seller.post("/api/deals/offer", { buyerId: b.id, title: "Paket A", price: 50_000, idempotencyKey: ok });
  assert.equal((await seller.post("/api/deals/offer", { buyerId: b.id, title: "Paket B", price: 90_000, idempotencyKey: ok })).status, 409);
  await app.close();
});

test("regresi red-team F3: karakter tak terlihat & huruf tiruan dibersihkan", async () => {
  const { app, seller } = await market();
  const dirty = "Ko​pi‍ G­ayo﻿‎‏ ＰＲＯ"; // zero-width, soft hyphen, BOM, LRM/RLM, "ＰＲＯ" lebar penuh
  const p = (await seller.post("/api/products", { title: dirty, sector: "Lainnya", price: 5000 })).body;
  assert.equal(p.title, "Kopi Gayo PRO");
  await app.close();
});

test("ubah harga produk tidak mengubah kesepakatan yang sudah dibuat", async () => {
  const { app, seller, buyer, prod } = await market();
  const deal = (await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: key() })).body;
  await seller.patch(`/api/products/${prod.id}`, { price: 9_999_000 });
  const paid = (await buyer.post(`/api/deals/${deal.id}/pay`)).body;
  assert.equal(paid.price, 850_000);
  await app.close();
});

test("diblokir: tidak bisa bayar, tapi dana yang sudah ditahan tetap bisa dikembalikan", async () => {
  const { app, seller, buyer, b, prod } = await market();
  const unpaid = (await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: key() })).body;
  const held = (await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: key() })).body;
  await buyer.post(`/api/deals/${held.id}/pay`);
  await seller.post("/api/blocks", { userId: b.id });
  assert.equal((await buyer.post(`/api/deals/${unpaid.id}/pay`)).status, 409);
  assert.equal((await seller.post(`/api/deals/${held.id}/refund`)).body.status, "REFUNDED");
  assert.equal(app.audit().balanced, true);
  await app.close();
});

test("tawaran kustom dari chat: hanya penjual PRO, ke kontak sendiri", async () => {
  const { app, base, seller, buyer, s, b } = await market();
  const offer = (await seller.post("/api/deals/offer", { buyerId: b.id, title: "Roasting kustom 2 Kg", price: 320_000, idempotencyKey: key() })).body;
  assert.equal(offer.buyerId, b.id);
  assert.equal(offer.fee, 16_000); // 5% dari 320.000
  assert.deepEqual((await buyer.get(`/api/deals?peer=${s.id}`)).body.deals[0].actions.sort(), ["cancel", "pay"]);
  assert.equal((await buyer.post("/api/deals/offer", { buyerId: s.id, title: "Balik menawar", price: 1000, idempotencyKey: key() })).status, 403, "pembeli non-PRO tak bisa menawarkan");
  const stranger = new Client(base);
  const st = await stranger.signup("orang_lain");
  assert.equal((await seller.post("/api/deals/offer", { buyerId: st.me.id, title: "Spam tawaran", price: 5000, idempotencyKey: key() })).status, 404);
  await app.close();
});

test("hapus akun ditolak selama masih ada kesepakatan terbuka", async () => {
  const { app, seller, buyer, prod } = await market();
  const deal = (await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: key() })).body;
  await buyer.post(`/api/deals/${deal.id}/pay`);
  const r = await seller.post("/api/me/delete", { passphrase: TEST_PASSPHRASE });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "open_deals");
  await seller.post(`/api/deals/${deal.id}/refund`);
  assert.equal((await seller.post("/api/me/delete", { passphrase: TEST_PASSPHRASE })).status, 200);
  await app.close();
});
