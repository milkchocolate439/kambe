import { test } from "node:test";
import assert from "node:assert/strict";
import { addProduct, addStatement, Client, createDeal, disputeDeal, resolveDispute, shipDeal, startApp } from "./helpers.ts";
import { PRO_PRICE, type DealContent, type ResolutionContent, type ShipmentContent, type StatementContent } from "../shared/protocol.ts";
import { addRecipients } from "../shared/sealed.ts";
import { generateIdentity } from "../shared/e2ee.ts";

const key = () => crypto.randomUUID().replace(/-/g, "");
const SHIP = { courier: "J&T Express", tracking: "JP1234567890", note: "" };
const DISPUTE = { reason: "not_as_described", text: "Biji kopi yang datang robusta, bukan arabica seperti di etalase." };

/** Pasar kecil dengan satu moderator dan satu kesepakatan yang sudah dibayar (semua isi terenkripsi). */
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
  const prod = (await addProduct(seller, { title: "Arabica Gayo 5 Kg", sector: "Komoditas & Pangan", price: 850_000 })).body;
  let deal = (await createDeal(buyer, prod.id, key(), seller.party, "Arabica Gayo 5 Kg")).body;
  deal = (await buyer.post(`/api/deals/${deal.id}/pay`)).body;
  if (opts.shipped) deal = (await shipDeal(seller, deal.id, SHIP)).body;
  if (opts.disputed) deal = (await disputeDeal(buyer, deal.id, DISPUTE)).body;
  return { ...env, seller, buyer, mod, s: s.me, b: b.me, deal };
}

const dump = (app: { db: { prepare: (s: string) => { all: () => unknown[] } } }, tables: string[]) => tables.map((t) => JSON.stringify(app.db.prepare(`SELECT * FROM ${t}`).all())).join("|");

test("bukti kirim WAJIB & terenkripsi: terbaca pembeli/penjual/moderator, tidak oleh server", async () => {
  const { app, base, seller, buyer, mod, deal } = await disputedMarket({});
  assert.equal((await seller.post(`/api/deals/${deal.id}/ship`, {})).body.error, "bad_sealed", "tanpa bukti kirim ditolak");
  assert.equal((await seller.post(`/api/deals/${deal.id}/ship`, { courier: "JNE", tracking: "JNE123456789" })).body.error, "content_must_be_encrypted");
  assert.equal((await shipDeal(buyer, deal.id, SHIP)).status, 409, "pembeli tidak berhak 'kirim'");
  const shipped = (await shipDeal(seller, deal.id, { courier: "Diantar langsung", tracking: null, note: "Diserahkan di Pasar Besar Palangka Raya, 26 Okt 10.00" })).body;
  assert.equal(shipped.status, "SHIPPED");
  for (const who of [seller, buyer]) {
    const d = (await who.get(`/api/deals?peer=${who === seller ? deal.buyerId : deal.sellerId}`)).body.deals[0];
    assert.equal((await who.open<ShipmentContent>(d.shipment)).note, "Diserahkan di Pasar Besar Palangka Raya, 26 Okt 10.00");
  }
  // Moderator hanya bisa melihatnya lewat antrean sengketa; buka sengketa dulu.
  await disputeDeal(buyer, deal.id, DISPUTE);
  const item = (await mod.get("/api/mod/disputes")).body.open[0];
  assert.equal((await mod.open<ShipmentContent>(item.deal.shipment)).courier, "Diantar langsung");
  assert.ok(!dump(app, ["deals", "sealed_objects", "sealed_wraps", "deal_receipts"]).includes("Pasar Besar"), "bukti kirim tidak tersimpan sebagai teks");
  const eve = new Client(base);
  await eve.signup("eve_penyusup");
  assert.equal((await eve.get(`/api/deals/${deal.id}/keys`)).status, 404);
  await app.close();
});

test("sengketa & pernyataan terenkripsi; hanya pihak terkait; dibatasi 5 per pihak", async () => {
  const { app, base, seller, buyer, mod, deal: shipped } = await disputedMarket({ shipped: true });
  assert.equal((await buyer.post(`/api/deals/${shipped.id}/dispute`, DISPUTE)).body.error, "content_must_be_encrypted");
  assert.equal((await buyer.post(`/api/deals/${shipped.id}/dispute`, {})).body.error, "bad_sealed");
  const disputed = (await disputeDeal(buyer, shipped.id, DISPUTE)).body;
  assert.equal(disputed.status, "DISPUTED");
  assert.equal(disputed.statements.length, 1);
  assert.equal(disputed.statements[0].role, "buyer");
  assert.deepEqual(await mod.open<StatementContent>((await mod.get("/api/mod/disputes")).body.open[0].deal.statements[0].content), DISPUTE);

  assert.equal((await seller.post(`/api/deals/${shipped.id}/statements`, { text: "polos" })).body.error, "content_must_be_encrypted");
  const reply = await addStatement(seller, shipped.id, "Saya kirim arabica, ada foto timbang & resi.");
  assert.equal(reply.status, 200);
  const sellerStatement = (await buyer.get(`/api/deals?peer=${shipped.sellerId}`)).body.deals[0].statements[1].content;
  assert.equal((await buyer.open<StatementContent>(sellerStatement)).text, "Saya kirim arabica, ada foto timbang & resi.", "pembeli membaca pernyataan penjual");
  const eve = new Client(base);
  await eve.signup("eve_penyusup");
  const fake = await eve.seal("statement", { text: "Saya saksi palsu" }, []);
  assert.equal((await eve.post(`/api/deals/${shipped.id}/statements`, { sealed: fake })).status, 404);
  for (let i = 0; i < 4; i++) await addStatement(seller, shipped.id, `Bukti tambahan ${i}`);
  assert.equal((await addStatement(seller, shipped.id, "Satu lagi")).status, 429, "maks 5 pernyataan per pihak");
  assert.ok(!dump(app, ["deal_statements", "sealed_objects", "sealed_wraps"]).includes("robusta"), "pernyataan tidak tersimpan sebagai teks");
  await app.close();
});

test("panel moderator tersembunyi dari pengguna biasa", async () => {
  const { app, seller, buyer, mod, deal } = await disputedMarket();
  assert.equal((await buyer.get("/api/mod/disputes")).status, 404);
  assert.equal((await resolveDispute(seller, deal.id, "release", "Saya sendiri yang menang")).status, 404);
  assert.equal((await buyer.get("/api/me")).body.me.isModerator, false);
  assert.equal((await mod.get("/api/me")).body.me.isModerator, true);
  await app.close();
});

test("moderator membuka isi terenkripsi (tanpa chat), memutus refund; alasan terenkripsi untuk kedua pihak", async () => {
  const { app, seller, buyer, mod, deal } = await disputedMarket();
  await addStatement(seller, deal.id, "Barang sesuai, resi valid.");
  const queue = (await mod.get("/api/mod/disputes")).body;
  assert.equal(queue.open.length, 1);
  const item = queue.open[0];
  assert.equal(item.buyer.alias, "Anon_Wolf99");
  assert.equal(item.seller.alias, "KopiGayo_Roaster");
  assert.equal((await mod.open<DealContent>(item.deal.content)).title, "Arabica Gayo 5 Kg");
  assert.equal((await mod.open<ShipmentContent>(item.deal.shipment)).tracking, "JP1234567890");
  assert.equal(item.deal.statements.length, 2);
  assert.deepEqual(item.deal.actions.sort(), ["confirm", "refund"]);
  assert.ok(!JSON.stringify(queue).includes('"to":"' + buyer.id), "moderator hanya menerima bungkus kunci miliknya sendiri");

  assert.equal((await mod.post(`/api/mod/disputes/${deal.id}/resolve`, { decision: "refund" })).body.error, "reason_required");
  assert.equal((await mod.post(`/api/mod/disputes/${deal.id}/resolve`, { decision: "refund", reason: "Alasan polos panjang" })).body.error, "content_must_be_encrypted");
  assert.equal((await resolveDispute(mod, deal.id, "hapus", "Alasan cukup panjang")).body.error, "bad_decision");
  const out = (await resolveDispute(mod, deal.id, "refund", "Foto pembeli menunjukkan biji robusta; resi tidak membuktikan isi.")).body;
  assert.equal(out.deal.status, "REFUNDED");
  const seenByBuyer = (await buyer.get(`/api/deals?peer=${deal.sellerId}`)).body.deals[0];
  assert.equal(seenByBuyer.resolution.decision, "refund");
  assert.equal(seenByBuyer.resolution.by, "moderator");
  assert.match((await buyer.open<ResolutionContent>(seenByBuyer.resolution.reason)).reason, /robusta/);
  assert.match((await seller.open<ResolutionContent>((await seller.get(`/api/deals?peer=${deal.buyerId}`)).body.deals[0].resolution.reason)).reason, /robusta/);
  assert.equal((await buyer.get("/api/wallet")).body.outgoingHeld, 0);
  assert.equal((await seller.get("/api/wallet")).body.balance, 0);
  const log = app.db.prepare("SELECT decision, reason, reason_object FROM moderation_log").all() as { decision: string; reason: string; reason_object: string }[];
  assert.equal(log.length, 1);
  assert.equal(log[0].decision, "refund");
  assert.equal(log[0].reason, "", "log audit tidak memuat alasan sebagai teks");
  assert.ok(log[0].reason_object);
  assert.ok(!dump(app, ["moderation_log", "deals", "sealed_objects"]).includes("robusta"));
  assert.equal(app.audit().balanced, true);
  assert.equal(app.audit().platform, PRO_PRICE, "refund putusan moderator tanpa fee");
  // Putusan final: tidak bisa diputus ulang, dan percobaan gagal tidak meninggalkan jejak.
  assert.equal((await resolveDispute(mod, deal.id, "release", "Coba balik putusan")).status, 409);
  assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM moderation_log").get() as { n: number }).n, 1, "putusan gagal tidak tercatat (rollback atomik)");
  assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM sealed_objects WHERE kind = 'resolution'").get() as { n: number }).n, 1, "objek alasan dari putusan gagal ikut dibatalkan");
  await app.close();
});

test("moderator memutus release: penjual dibayar dengan fee normal", async () => {
  const { app, seller, mod, deal } = await disputedMarket();
  const out = (await resolveDispute(mod, deal.id, "release", "Resi valid dan foto timbang cocok dengan deskripsi.")).body;
  assert.equal(out.deal.status, "COMPLETED");
  assert.equal((await seller.get("/api/wallet")).body.balance, 807_500);
  assert.equal(app.audit().balanced, true);
  await app.close();
});

test("moderator baru tidak otomatis bisa membaca isi lama — pihak harus membagikan kuncinya", async () => {
  const { app, base, buyer, deal } = await disputedMarket();
  const late = new Client(base);
  const l = await late.signup("Moderator_Baru");
  app.setModerators([l.me.id]);
  const item = (await late.get("/api/mod/disputes")).body.open[0];
  assert.equal(item.deal.statements[0].content.wrap, null, "belum ada bungkus kunci untuk moderator baru");
  await assert.rejects(late.open(item.deal.statements[0].content));
  // Pembeli (pemilik pernyataan) membagikan kunci ke moderator baru.
  const mine = (await buyer.get(`/api/deals?peer=${deal.sellerId}`)).body.deals[0].statements[0].content;
  const wraps = await addRecipients(buyer.key.privateKey, buyer.party, mine, [late.party]);
  assert.equal((await buyer.post(`/api/sealed/${mine.id}/wraps`, { wraps })).status, 200);
  const again = (await late.get("/api/mod/disputes")).body.open[0];
  assert.deepEqual(await late.open<StatementContent>(again.deal.statements[0].content), DISPUTE);
  // Orang luar tidak bisa dibagikan kunci isi kesepakatan.
  const eve = new Client(base);
  await eve.signup("eve_luar");
  const bad = await addRecipients(buyer.key.privateKey, buyer.party, mine, [eve.party]);
  assert.equal((await buyer.post(`/api/sealed/${mine.id}/wraps`, { wraps: bad })).status, 403);
  await app.close();
});

test("moderator ganti perangkat: pihak sengketa diberi sinyal untuk membagikan ulang, lalu moderator bisa membaca lagi", async () => {
  const { app, buyer, seller, mod, deal } = await disputedMarket();
  const sb = await buyer.socket();
  const ss = await seller.socket();
  await mod.useKey(await generateIdentity()); // login di perangkat baru
  assert.equal((await sb.next("reshare_needed")).peer, deal.sellerId);
  assert.equal((await ss.next("reshare_needed")).peer, deal.buyerId);
  const stale = (await mod.get("/api/mod/disputes")).body.open[0];
  await assert.rejects(mod.open(stale.deal.content), "bungkus lama tidak bisa dibuka kunci baru");
  // Pembeli (pemilik judul & pernyataan) membagikan ulang ke kunci baru moderator.
  const mine = (await buyer.get(`/api/deals?peer=${deal.sellerId}`)).body.deals[0];
  for (const v of [mine.content, mine.statements[0].content]) {
    const wraps = await addRecipients(buyer.key.privateKey, buyer.party, v, [mod.party]);
    assert.equal((await buyer.post(`/api/sealed/${v.id}/wraps`, { wraps })).status, 200);
  }
  const fresh = (await mod.get("/api/mod/disputes")).body.open[0];
  assert.equal((await mod.open<DealContent>(fresh.deal.content)).title, "Arabica Gayo 5 Kg");
  assert.deepEqual(await mod.open<StatementContent>(fresh.deal.statements[0].content), DISPUTE);
  await app.close();
});

test("moderator tidak bisa memutus kesepakatan non-sengketa atau yang melibatkan dirinya", async () => {
  const { app, mod, deal } = await disputedMarket({ shipped: true });
  assert.equal((await resolveDispute(mod, deal.id, "release", "Belum sengketa sebenarnya")).status, 409);

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
  const p = (await addProduct(modSeller, { title: "Jasa audit", sector: "Jasa Digital & IT", price: 100_000 })).body;
  const d = (await createDeal(buyer, p.id, key(), modSeller.party)).body;
  await buyer.post(`/api/deals/${d.id}/pay`);
  await disputeDeal(buyer, d.id, DISPUTE);
  const r = await resolveDispute(modSeller, d.id, "release", "Saya memenangkan diri sendiri");
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "conflict_of_interest");
  await env2.app.close();
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

test("sengketa kedaluwarsa dicatat sebagai putusan sistem (alasan tetap, tanpa teks di server)", async () => {
  const { app, buyer, deal } = await disputedMarket();
  assert.deepEqual(app.runTimers(deal.autoRefundAt + 1), { released: 0, refunded: 1 });
  const seen = (await buyer.get(`/api/deals?peer=${deal.sellerId}`)).body.deals[0];
  assert.equal(seen.status, "REFUNDED");
  assert.equal(seen.resolution.decision, "refund");
  assert.equal(seen.resolution.by, "system");
  assert.equal(seen.resolution.reason, null, "putusan sistem tidak punya alasan terenkripsi; klien menampilkan teks tetap");
  await app.close();
});
