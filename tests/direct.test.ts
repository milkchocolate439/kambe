// Platform gratis + kesepakatan LANGSUNG (pembeli mentransfer sendiri; KAMBE tidak memegang dana).
import { test } from "node:test";
import assert from "node:assert/strict";
import { addProduct, Client, offerDeal, payWithProof, resolveDispute, sendPayInfo, shipDeal, startApp, uploadAttachment } from "./helpers.ts";
import { directProvider } from "../server/payments.ts";
import { parseReceipt, verifyChain, type SignedReceipt } from "../shared/receipt.ts";

const key = () => crypto.randomUUID().replace(/-/g, "");

/** Dua kontak di server produk (langsung + gratis), TANPA langganan PRO. */
async function freeMarket(dealTimers?: NonNullable<Parameters<typeof startApp>[0]>["dealTimers"]) {
  const env = await startApp({ payments: directProvider, freePlatform: true, dealTimers });
  const seller = new Client(env.base);
  const buyer = new Client(env.base);
  const s = await seller.signup("Penjual_Langsung");
  await buyer.signup("Pembeli_Langsung");
  await buyer.post("/api/contacts/invite", { pin: s.me.pin });
  await seller.post(`/api/contacts/requests/${(await seller.get("/api/contacts")).body.incoming[0].id}/accept`);
  const offer = () => offerDeal(seller, buyer.party, "Arabica 1 Kg", 200_000, key());
  return { ...env, seller, buyer, offer };
}

/** Alur tegas: penjual kirim rekening → pembeli isi form + foto bukti. */
async function payDirect(seller: Client, buyer: Client, dealId: string, note = "") {
  await sendPayInfo(seller, dealId);
  return payWithProof(buyer, dealId, { note });
}

test("platform gratis: tanpa PRO bisa memajang etalase & menawarkan kesepakatan; langganan dimatikan", async () => {
  const { app, base, seller, buyer, offer } = await freeMarket();
  const cfg = await fetch(base + "/api/config").then((r) => r.json());
  assert.equal(cfg.freePlatform, true);
  assert.equal(cfg.paymentProvider, "langsung");
  assert.equal((await addProduct(seller, { title: "Jasa desain", price: 100_000 })).status, 200, "etalase tanpa PRO");
  assert.equal((await buyer.get(`/api/users/${seller.party.id}/products`)).body.products.length, 1, "etalase terlihat oleh kontak");
  const o = await offer();
  assert.equal(o.status, 200, "tawaran tanpa PRO");
  assert.equal(o.body.direct, true);
  assert.equal(o.body.fee, 0);
  const sub = await seller.post("/api/pro/subscribe", { idempotencyKey: key() });
  assert.equal(sub.status, 409);
  assert.equal(sub.body.error, "platform_free");
  assert.equal(app.audit().platform, 0, "platform tidak menerima uang apa pun");
  await app.close();
});

test("kesepakatan langsung: sudah transfer (+bukti tersegel) → uang diterima · kirim → selesai, tanpa buku besar", async () => {
  const { app, seller, buyer, offer } = await freeMarket();
  const deal = (await offer()).body;
  assert.deepEqual(deal.actions, ["cancel"], "penjual (pembuat tawaran) hanya bisa membatalkan");
  assert.deepEqual((await buyer.get(`/api/deals?peer=${seller.party.id}`)).body.deals[0].actions, ["cancel"], "sebelum ada rekening: pembeli belum bisa 'sudah bayar'");

  const paid = await payDirect(seller, buyer, deal.id, "Transfer BCA 12 Nov 14.05, ref 7781");
  assert.equal(paid.status, 200);
  assert.equal(paid.body.status, "HELD");
  assert.equal(paid.body.shipBy, null, "tidak ada batas tarik dana — KAMBE tidak memegang dana");
  assert.equal(paid.body.autoRefundAt, null);
  assert.ok(paid.body.payment?.wrap, "bukti transfer tersegel untuk pembeli");
  assert.equal(((await buyer.open(paid.body.payment)) as { note: string }).note, "Transfer BCA 12 Nov 14.05, ref 7781");
  const sellerView = (await seller.get(`/api/deals?peer=${buyer.party.id}`)).body.deals[0];
  assert.equal(((await seller.open(sellerView.payment)) as { ref: string }).ref, "REF7781", "penjual bisa membaca form bukti");
  const buyerView = (await buyer.get(`/api/deals?peer=${seller.party.id}`)).body.deals[0];
  assert.equal(((await buyer.open(buyerView.payInfo)) as { number: string }).number, "1234567890", "pembeli bisa membaca rekening penerima");
  assert.deepEqual(sellerView.actions.sort(), ["dispute", "refund", "ship"], "penjual: kirim / kembalikan / uang belum masuk");
  assert.ok(!(await buyer.get(`/api/deals?peer=${seller.party.id}`)).body.deals[0].actions.includes("refund"), "pembeli tidak bisa 'tarik dana' — tidak ada dana di KAMBE");

  assert.equal((await shipDeal(seller, deal.id)).body.status, "SHIPPED");
  const done = (await buyer.post(`/api/deals/${deal.id}/confirm`)).body;
  assert.equal(done.status, "COMPLETED");

  const a = app.audit();
  assert.equal(a.total, 0);
  assert.equal(a.escrow, 0, "tidak ada escrow");
  assert.equal(a.balanced, true);
  assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM ledger").get() as { n: number }).n, 0, "buku besar kosong: uang tidak lewat KAMBE");
  const w = (await seller.get("/api/wallet")).body;
  assert.equal(w.balance + w.incomingHeld + w.outgoingHeld, 0);

  // Notaris tetap mencatat setiap langkah.
  const chain = (await buyer.get(`/api/deals/${deal.id}/receipts`)).body.receipts as SignedReceipt[];
  assert.deepEqual(chain.map((c) => parseReceipt(c).status), ["AWAITING_PAYMENT", "HELD", "SHIPPED", "COMPLETED"]);
  assert.deepEqual(await verifyChain(app.notaryPublicKey, chain), { ok: true });
  await app.close();
});

test("alur tegas: 'sudah bayar' DITOLAK sebelum penjual mengirim rekening, tanpa form, atau tanpa foto bukti", async () => {
  const { app, base, seller, buyer, offer } = await freeMarket();
  const d1 = (await offer()).body;
  // 1) Belum ada rekening penerima.
  const early = await payWithProof(buyer, d1.id).catch(() => null);
  assert.equal(early, null, "foto bukti bahkan tidak bisa diunggah? (lihat di bawah)");
  const noInfo = await buyer.post(`/api/deals/${d1.id}/pay`, { sealed: await buyer.seal("payment", { note: "x" }, await buyer.dealParties(d1.id)) });
  assert.equal(noInfo.status, 409);
  assert.equal(noInfo.body.error, "payinfo_missing");
  // Hanya penjual yang bisa mengirim rekening.
  assert.equal((await sendPayInfo(buyer, d1.id)).status, 404);
  assert.equal((await sendPayInfo(seller, d1.id)).status, 200);
  assert.ok((await buyer.get(`/api/deals?peer=${seller.party.id}`)).body.deals[0].actions.includes("pay"), "setelah rekening ada: tombol sudah bayar aktif");
  // 2) Tanpa form bukti.
  const noForm = await buyer.post(`/api/deals/${d1.id}/pay`, {});
  assert.equal(noForm.status, 400);
  assert.equal(noForm.body.error, "proof_required");
  // 3) Form tanpa foto.
  const noPhoto = await buyer.post(`/api/deals/${d1.id}/pay`, { sealed: await buyer.seal("payment", { note: "x" }, await buyer.dealParties(d1.id)) });
  assert.equal(noPhoto.status, 400);
  assert.equal(noPhoto.body.error, "attachment_required");
  // Foto milik orang lain / untuk kesepakatan lain tidak bisa dipakai.
  const d2 = (await offer()).body;
  await sendPayInfo(seller, d2.id);
  const other = await uploadAttachment(buyer, "proof", d2.id);
  const wrong = await buyer.post(`/api/deals/${d1.id}/pay`, { sealed: await buyer.seal("payment", { note: "x" }, await buyer.dealParties(d1.id)), attachments: [other] });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, "bad_attachment");
  assert.equal((await buyer.get(`/api/deals?peer=${seller.party.id}`)).body.deals.find((x: { id: string }) => x.id === d1.id).status, "AWAITING_PAYMENT", "gagal = status tidak berubah");
  // 4) Lengkap → berhasil.
  assert.equal((await payWithProof(buyer, d1.id)).body.status, "HELD");
  // Foto bukti: pembeli & penjual bisa unduh, orang lain tidak.
  const proofId = (app.db.prepare("SELECT id FROM attachments WHERE context = ? AND linked = 1").get(d1.id) as { id: string }).id;
  assert.equal((await buyer.get(`/api/attachments/${proofId}`)).status, 200);
  assert.equal((await seller.get(`/api/attachments/${proofId}`)).status, 200);
  const eve = new Client(base);
  await eve.signup("Eve_Intip_Bukti");
  assert.equal((await eve.get(`/api/attachments/${proofId}`)).status, 404, "orang luar tidak bisa melihat bukti");
  await app.close();
});

test("etalase: maksimal 3 barang, foto wajib, foto hanya untuk kontak", async () => {
  const { app, base, seller, buyer } = await freeMarket();
  const noPhoto = await seller.post("/api/products", { price: 10_000, sealed: await seller.seal("product", { title: "x", description: "", sector: "Lainnya" }, await seller.contactParties()) });
  assert.equal(noPhoto.status, 400);
  assert.equal(noPhoto.body.error, "attachment_required");
  for (let i = 1; i <= 3; i++) assert.equal((await addProduct(seller, { title: `Barang ${i}`, price: 10_000 * i })).status, 200);
  const fourth = await addProduct(seller, { title: "Barang 4", price: 40_000 });
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error, "too_many_products");
  const photoId = (app.db.prepare("SELECT photo_attachment AS p FROM products WHERE owner_id = ? AND active = 1 LIMIT 1").get(seller.party.id) as { p: string }).p;
  assert.equal((await buyer.get(`/api/attachments/${photoId}`)).status, 200, "kontak bisa melihat foto etalase");
  const stranger = new Client(base);
  await stranger.signup("Orang_Asing_Foto");
  assert.equal((await stranger.get(`/api/attachments/${photoId}`)).status, 404, "orang asing tidak bisa");
  // Hapus barang → fotonya ikut terhapus.
  const prodId = (app.db.prepare("SELECT id FROM products WHERE photo_attachment = ?").get(photoId) as { id: string }).id;
  await seller.del(`/api/products/${prodId}`);
  assert.equal(app.db.prepare("SELECT 1 FROM attachments WHERE id = ?").get(photoId), undefined);
  await app.close();
});

test("kesepakatan langsung: penjual 'uang belum masuk' → sengketa tidak kedaluwarsa jadi refund; moderator hanya mencatat putusan", async () => {
  const { app, base, seller, buyer, offer } = await freeMarket({ autoReleaseMs: 50, heldRefundMs: 50, disputeTimeoutMs: 50, shipWindowMs: 50 });
  const deal = (await offer()).body;
  await payDirect(seller, buyer, deal.id);
  await new Promise((r) => setTimeout(r, 80));
  app.runTimers();
  assert.equal((await buyer.get(`/api/deals?peer=${seller.party.id}`)).body.deals[0].status, "HELD", "HELD tidak di-refund otomatis");

  const disputed = await seller.post(`/api/deals/${deal.id}/dispute`, { sealed: await seller.seal("statement", { reason: "payment_missing", text: "Mutasi rekening tidak menunjukkan transfer." }, await seller.dealParties(deal.id)) });
  assert.equal(disputed.status, 200);
  assert.equal(disputed.body.status, "DISPUTED");
  assert.equal(disputed.body.statements[0].role, "seller");
  await new Promise((r) => setTimeout(r, 80));
  app.runTimers();
  assert.equal((await buyer.get(`/api/deals?peer=${seller.party.id}`)).body.deals[0].status, "DISPUTED", "sengketa langsung menunggu moderator");

  const mod = new Client(base);
  const m = await mod.signup("Moderator_Langsung");
  app.setModerators([m.me.id]);
  const out = await resolveDispute(mod, deal.id, "refund", "Bukti transfer tidak ada; kesepakatan dibatalkan.");
  assert.equal(out.status, 200);
  assert.equal(out.body.deal.status, "REFUNDED");
  assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM ledger").get() as { n: number }).n, 0, "putusan tidak memindahkan uang");
  assert.equal(app.audit().balanced, true);
  await app.close();
});

test("kesepakatan lama tetap pada modenya: mode dibekukan per kesepakatan", async () => {
  const { app, seller, buyer, offer } = await freeMarket();
  const deal = (await offer()).body;
  assert.equal(deal.direct, true);
  // Kolom direct tersimpan per baris; transisi memakai tabel sesuai mode kesepakatan itu.
  assert.equal((app.db.prepare("SELECT direct FROM deals WHERE id = ?").get(deal.id) as { direct: number }).direct, 1);
  await payDirect(seller, buyer, deal.id);
  assert.equal((await shipDeal(seller, deal.id)).status, 200);
  await app.close();
});

test("Radar Arwah (teks publik): nomor HP & kontak luar ditolak SERVER", async () => {
  const { app, seller } = await freeMarket();
  for (const headline of ["Jual rotan, WA 081234567890", "Cari kopi, hubungi t.me/kopigayo", "Jual beras, email beras@contoh.id"]) {
    const r = await seller.put("/api/radar", { sector: "Komoditas & Pangan", headline });
    assert.equal(r.status, 400, headline);
    assert.equal(r.body.error, "contact_blocked");
  }
  assert.equal((await seller.put("/api/radar", { sector: "Komoditas & Pangan", headline: "Jual rotan mentah 2 ton, harga Rp 12.000.000" })).status, 200, "teks dagang biasa lolos");
  await app.close();
});
