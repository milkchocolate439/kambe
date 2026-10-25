import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, startApp } from "./helpers.ts";
import { PRO_PRICE } from "../shared/protocol.ts";

const key = () => crypto.randomUUID().replace(/-/g, "");
const SHIP = { courier: "J&T Express", tracking: "jp1234567890" };
const DISPUTE = { reason: "not_as_described", text: "Biji kopi yang datang robusta, bukan arabica seperti di etalase." };

/** Pasar kecil dengan satu moderator ("Moderator_Satu") dan satu kesepakatan yang sudah dibayar. */
async function disputedMarket(opts: { shipped?: boolean; disputed?: boolean } = { shipped: true, disputed: true }) {
  const env = await startApp();
  const seller = new Client(env.base);
  const buyer = new Client(env.base);
  const mod = new Client(env.base);
  const s = await seller.signup("KopiGayo_Roaster");
  const b = await buyer.signup("Anon_Wolf99");
  const m = await mod.signup("Moderator_Satu");
  env.app.setModerators([m.me.id]); // moderator ditunjuk lewat ID akun, bukan alias
  await buyer.post("/api/contacts/invite", { pin: s.me.pin });
  await seller.post(`/api/contacts/requests/${(await seller.get("/api/contacts")).body.incoming[0].id}/accept`);
  await seller.post("/api/pro/subscribe", { idempotencyKey: key() });
  const prod = (await seller.post("/api/products", { title: "Arabica Gayo 5 Kg", sector: "Komoditas & Pangan", price: 850_000 })).body;
  let deal = (await buyer.post("/api/deals", { productId: prod.id, idempotencyKey: key() })).body;
  deal = (await buyer.post(`/api/deals/${deal.id}/pay`)).body;
  if (opts.shipped) deal = (await seller.post(`/api/deals/${deal.id}/ship`, SHIP)).body;
  if (opts.disputed) deal = (await buyer.post(`/api/deals/${deal.id}/dispute`, DISPUTE)).body;
  return { ...env, seller, buyer, mod, s: s.me, b: b.me, deal };
}

test("kirim WAJIB bukti: kurir dari daftar + resi valid, atau keterangan serah terima", async () => {
  const { app, seller, buyer, deal } = await disputedMarket({});
  const ship = (body: unknown) => seller.post(`/api/deals/${deal.id}/ship`, body);
  assert.equal((await ship({})).status, 400);
  assert.equal((await ship({ courier: "Kurir Abal", tracking: "ABC123456" })).body.error, "bad_courier");
  assert.equal((await ship({ courier: "JNE" })).body.error, "bad_tracking");
  assert.equal((await ship({ courier: "JNE", tracking: "12" })).body.error, "bad_tracking");
  assert.equal((await ship({ courier: "JNE", tracking: "<script>1234" })).body.error, "bad_tracking");
  assert.equal((await ship({ courier: "Diantar langsung", note: "ok" })).body.error, "note_required");
  assert.equal((await buyer.post(`/api/deals/${deal.id}/ship`, SHIP)).status, 409, "pembeli tidak berhak 'kirim'");
  const shipped = (await ship({ courier: "Diantar langsung", note: "Diserahkan di Pasar Besar Palangka Raya, 26 Okt 10.00" })).body;
  assert.equal(shipped.status, "SHIPPED");
  assert.deepEqual(shipped.shipment, { courier: "Diantar langsung", tracking: null, note: "Diserahkan di Pasar Besar Palangka Raya, 26 Okt 10.00" });
  const seen = (await buyer.get(`/api/deals?peer=${shipped.sellerId}`)).body.deals[0];
  assert.equal(seen.shipment.courier, "Diantar langsung", "pembeli melihat bukti kirim");
  await app.close();
});

test("resi dinormalisasi & terlihat oleh pembeli", async () => {
  const { app, buyer, deal } = await disputedMarket({ shipped: true });
  assert.deepEqual(deal.shipment, { courier: "J&T Express", tracking: "JP1234567890", note: "" });
  const seen = (await buyer.get(`/api/deals?peer=${deal.sellerId}`)).body.deals[0];
  assert.equal(seen.shipment.tracking, "JP1234567890");
  await app.close();
});

test("sengketa WAJIB alasan + cerita; pernyataan dibatasi & hanya untuk pihak terkait", async () => {
  const { app, base, seller, buyer, deal: shipped } = await disputedMarket({ shipped: true });
  const dispute = (body: unknown) => buyer.post(`/api/deals/${shipped.id}/dispute`, body);
  assert.equal((await dispute({ text: "Tidak sesuai sama sekali" })).body.error, "bad_field");
  assert.equal((await dispute({ reason: "ngawur", text: "Tidak sesuai sama sekali" })).body.error, "bad_reason");
  assert.equal((await dispute({ reason: "damaged", text: "rusak" })).body.error, "bad_statement");
  const disputed = (await dispute(DISPUTE)).body;
  assert.equal(disputed.status, "DISPUTED");
  assert.equal(disputed.disputeReason, "not_as_described");
  assert.equal(disputed.statements.length, 1);
  assert.equal(disputed.statements[0].role, "buyer");

  const reply = await seller.post(`/api/deals/${shipped.id}/statements`, { text: "Saya kirim arabica, ada foto timbang & resi.​" });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.statements[1].text, "Saya kirim arabica, ada foto timbang & resi.", "teks dibersihkan");
  const eve = new Client(base);
  await eve.signup("eve_penyusup");
  assert.equal((await eve.post(`/api/deals/${shipped.id}/statements`, { text: "Saya saksi palsu" })).status, 404);
  for (let i = 0; i < 4; i++) await seller.post(`/api/deals/${shipped.id}/statements`, { text: `Bukti tambahan ${i}` });
  assert.equal((await seller.post(`/api/deals/${shipped.id}/statements`, { text: "Satu lagi" })).status, 429, "maks 5 pernyataan per pihak");
  await app.close();
});

test("panel moderator tersembunyi dari pengguna biasa", async () => {
  const { app, seller, buyer, mod, deal } = await disputedMarket();
  assert.equal((await buyer.get("/api/mod/disputes")).status, 404);
  assert.equal((await seller.post(`/api/mod/disputes/${deal.id}/resolve`, { decision: "release", reason: "Saya sendiri yang menang" })).status, 404);
  assert.equal((await buyer.get("/api/me")).body.me.isModerator, false);
  assert.equal((await mod.get("/api/me")).body.me.isModerator, true);
  await app.close();
});

test("moderator melihat konteks secukupnya (tanpa chat) lalu memutus refund", async () => {
  const { app, seller, buyer, mod, deal } = await disputedMarket();
  await seller.post(`/api/deals/${deal.id}/statements`, { text: "Barang sesuai, resi valid." });
  const queue = (await mod.get("/api/mod/disputes")).body;
  assert.equal(queue.open.length, 1);
  const item = queue.open[0];
  assert.equal(item.buyer.alias, "Anon_Wolf99");
  assert.equal(item.seller.alias, "KopiGayo_Roaster");
  assert.equal(item.deal.shipment.tracking, "JP1234567890");
  assert.equal(item.deal.statements.length, 2);
  assert.deepEqual(item.deal.actions.sort(), ["confirm", "refund"]);
  assert.ok(!("ciphertext" in item.deal) && !JSON.stringify(queue).includes("nonce"), "tidak ada isi chat di antrean moderator");

  assert.equal((await mod.post(`/api/mod/disputes/${deal.id}/resolve`, { decision: "refund", reason: "singkat" })).body.error, "reason_required");
  assert.equal((await mod.post(`/api/mod/disputes/${deal.id}/resolve`, { decision: "hapus", reason: "Alasan cukup panjang" })).body.error, "bad_decision");
  const out = (await mod.post(`/api/mod/disputes/${deal.id}/resolve`, { decision: "refund", reason: "Foto pembeli menunjukkan biji robusta; resi tidak membuktikan isi." })).body;
  assert.equal(out.deal.status, "REFUNDED");
  const seenByBuyer = (await buyer.get(`/api/deals?peer=${deal.sellerId}`)).body.deals[0];
  assert.equal(seenByBuyer.resolution.decision, "refund");
  assert.match(seenByBuyer.resolution.reason, /robusta/);
  assert.equal((await buyer.get("/api/wallet")).body.outgoingHeld, 0);
  assert.equal((await seller.get("/api/wallet")).body.balance, 0);
  const log = app.db.prepare("SELECT decision, reason FROM moderation_log").all() as { decision: string; reason: string }[];
  assert.equal(log.length, 1);
  assert.equal(log[0].decision, "refund");
  assert.equal(app.audit().balanced, true);
  assert.equal(app.audit().platform, PRO_PRICE, "refund putusan moderator tanpa fee");
  // Putusan final: tidak bisa diputus ulang.
  assert.equal((await mod.post(`/api/mod/disputes/${deal.id}/resolve`, { decision: "release", reason: "Coba balik putusan" })).status, 409);
  assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM moderation_log").get() as { n: number }).n, 1, "putusan gagal tidak tercatat (rollback atomik)");
  await app.close();
});

test("moderator memutus release: penjual dibayar dengan fee normal", async () => {
  const { app, seller, mod, deal } = await disputedMarket();
  const out = (await mod.post(`/api/mod/disputes/${deal.id}/resolve`, { decision: "release", reason: "Resi valid dan foto timbang cocok dengan deskripsi." })).body;
  assert.equal(out.deal.status, "COMPLETED");
  assert.equal((await seller.get("/api/wallet")).body.balance, 807_500);
  assert.equal(app.audit().balanced, true);
  await app.close();
});

test("moderator tidak bisa memutus kesepakatan non-sengketa atau yang melibatkan dirinya", async () => {
  const { app, base, mod, deal } = await disputedMarket({ shipped: true });
  assert.equal((await mod.post(`/api/mod/disputes/${deal.id}/resolve`, { decision: "release", reason: "Belum sengketa sebenarnya" })).status, 409);

  // Moderator yang juga berdagang: tidak boleh memutus sengketanya sendiri.
  const env2 = await startApp();
  const modSeller = new Client(env2.base);
  const buyer = new Client(env2.base);
  const ms = await modSeller.signup("Moderator_Dagang");
  env2.app.setModerators([ms.me.id]);
  await buyer.signup("pembeli_x");
  await buyer.post("/api/contacts/invite", { pin: ms.me.pin });
  await modSeller.post(`/api/contacts/requests/${(await modSeller.get("/api/contacts")).body.incoming[0].id}/accept`);
  await modSeller.post("/api/pro/subscribe", { idempotencyKey: key() });
  const p = (await modSeller.post("/api/products", { title: "Jasa audit", sector: "Jasa Digital & IT", price: 100_000 })).body;
  const d = (await buyer.post("/api/deals", { productId: p.id, idempotencyKey: key() })).body;
  await buyer.post(`/api/deals/${d.id}/pay`);
  await buyer.post(`/api/deals/${d.id}/dispute`, DISPUTE);
  const r = await modSeller.post(`/api/mod/disputes/${d.id}/resolve`, { decision: "release", reason: "Saya memenangkan diri sendiri" });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "conflict_of_interest");
  await env2.app.close();
  void base;
  await app.close();
});

test("regresi audit Fase 3 #1: alias moderator tidak bisa diserobot lewat pendaftaran", async () => {
  // Konfigurasi lama memakai alias — kini diabaikan (bukan UUID), jadi alias apa pun tak memberi akses.
  const logs: string[] = [];
  const { createApp } = await import("../server/app.ts");
  const app = createApp({ dbPath: ":memory:", moderators: ["Mod_Resmi"], log: (msg) => logs.push(msg) });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const attacker = new Client(base);
  await attacker.signup("mod_resmi");
  assert.equal((await attacker.get("/api/me")).body.me.isModerator, false);
  assert.equal((await attacker.get("/api/mod/disputes")).status, 404);
  assert.ok(logs.some((l) => /bukan ID akun/.test(l)), "admin diperingatkan bahwa entri alias diabaikan");
  await app.close();
});

test("sengketa kedaluwarsa dicatat sebagai putusan sistem yang bisa dibaca kedua pihak", async () => {
  const { app, buyer, deal } = await disputedMarket();
  assert.deepEqual(app.runTimers(deal.autoRefundAt + 1), { released: 0, refunded: 1 });
  const seen = (await buyer.get(`/api/deals?peer=${deal.sellerId}`)).body.deals[0];
  assert.equal(seen.status, "REFUNDED");
  assert.equal(seen.resolution.decision, "refund");
  assert.match(seen.resolution.reason, /batas waktu/);
  await app.close();
});
