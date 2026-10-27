import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.ts";
import { xenditProvider } from "../server/payments.ts";
import { addProduct, Client, createDeal } from "./helpers.ts";

const key = () => crypto.randomUUID().replace(/-/g, "");
const SECRET = "xnd_development_RAHASIA_JANGAN_BOCOR";
const TOKEN = "token-verifikasi-webhook-123";

/** Gateway tiruan: mencatat request & mengembalikan invoice. */
function fakeGateway() {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify({ id: "inv_" + calls.length, invoice_url: "https://checkout.xendit.co/web/inv_" + calls.length }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function gatewayMarket() {
  const gw = fakeGateway();
  const app = createApp({
    dbPath: ":memory:",
    payments: xenditProvider({ secretKey: SECRET, callbackToken: TOKEN, splitRuleId: "splitru_fee25", successUrl: "https://pinpath.example/bayar-selesai", fetchImpl: gw.fetchImpl }),
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const seller = new Client(base);
  const buyer = new Client(base);
  const s = await seller.signup("Penjual_Gateway");
  await buyer.signup("Pembeli_Gateway");
  await buyer.post("/api/contacts/invite", { pin: s.me.pin });
  await seller.post(`/api/contacts/requests/${(await seller.get("/api/contacts")).body.incoming[0].id}/accept`);
  // PRO disiapkan langsung di DB: endpoint langganan tidak aktif saat gateway sungguhan dipakai.
  app.db.prepare("UPDATE users SET pro_until = ? WHERE id = ?").run(Date.now() + 30 * 24 * 3600 * 1000, s.me.id);
  const prod = (await addProduct(seller, { title: "Rotan 1 ton", sector: "Komoditas & Pangan", price: 4_000_000 })).body;
  const deal = (await createDeal(buyer, prod.id, key(), seller.party, "Rotan 1 ton")).body;
  return { app, base, gw, seller, buyer, sellerId: s.me.id, deal };
}

/** Kirim webhook seperti server gateway: tanpa cookie & tanpa Origin. */
function webhook(base: string, body: unknown, token = TOKEN) {
  return fetch(base + "/api/payments/webhook/xendit", {
    method: "POST",
    headers: { "content-type": "application/json", "x-callback-token": token },
    body: JSON.stringify(body),
  });
}

test("gateway: invoice dibuat DI SERVER dengan split ke sub-akun penjual; ponsel hanya menerima URL", async () => {
  const { app, gw, buyer, sellerId, deal } = await gatewayMarket();
  assert.equal((await buyer.post(`/api/deals/${deal.id}/pay`)).body.error, "seller_not_onboarded", "penjual tanpa rekening gateway tidak bisa dibayar");
  app.db.prepare("UPDATE users SET gateway_account = ? WHERE id = ?").run("acc_penjual_01", sellerId);

  const r = (await buyer.post(`/api/deals/${deal.id}/pay`)).body;
  assert.equal(r.status, "AWAITING_PAYMENT", "status belum berubah sebelum webhook lunas");
  assert.match(r.paymentUrl, /^https:\/\/checkout\.xendit\.co\//);
  const call = gw.calls[0];
  assert.equal(call.url, "https://api.xendit.co/v2/invoices");
  assert.equal(call.headers["for-user-id"], "acc_penjual_01");
  assert.equal(call.headers["with-split-rule"], "splitru_fee25");
  assert.equal(call.headers.authorization, "Basic " + Buffer.from(`${SECRET}:`).toString("base64"));
  assert.equal(call.body.external_id, deal.payRef);
  assert.equal(call.body.amount, 4_000_000);
  assert.ok(!String(call.body.description).includes("Rotan"), "nama barang/identitas tidak dikirim ke gateway");

  // Klik ganda tidak membuat invoice kedua.
  await buyer.post(`/api/deals/${deal.id}/pay`);
  assert.equal(gw.calls.length, 1);
  await app.close();
});

test("gateway: webhook palsu ditolak; webhook asli menandai lunas tepat sekali", async () => {
  const { app, base, buyer, sellerId, deal } = await gatewayMarket();
  app.db.prepare("UPDATE users SET gateway_account = 'acc_1' WHERE id = ?").run(sellerId);
  await buyer.post(`/api/deals/${deal.id}/pay`);

  assert.equal((await webhook(base, { external_id: deal.payRef, status: "PAID", amount: 4_000_000 }, "token-salah")).status, 403);
  assert.equal((await webhook(base, { external_id: deal.payRef, status: "PAID", amount: 4_000_000 }, "")).status, 403);
  assert.equal((await buyer.get(`/api/deals?peer=${deal.sellerId}`)).body.deals[0].status, "AWAITING_PAYMENT");

  // Nominal dimanipulasi → tidak dianggap lunas.
  assert.equal((await webhook(base, { external_id: deal.payRef, status: "PAID", amount: 1_000 })).status, 409);
  assert.equal((await buyer.get(`/api/deals?peer=${deal.sellerId}`)).body.deals[0].status, "AWAITING_PAYMENT");

  assert.equal((await webhook(base, { external_id: deal.payRef, status: "PAID", amount: 4_000_000 })).status, 200);
  assert.equal((await webhook(base, { external_id: deal.payRef, status: "PAID", amount: 4_000_000 })).status, 200, "webhook ulang (retry gateway) aman");
  const after = (await buyer.get(`/api/deals?peer=${deal.sellerId}`)).body.deals[0];
  assert.equal(after.status, "HELD");
  assert.equal(after.paymentUrl, null);
  const payments = app.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'deal_payment'").get() as { n: number };
  assert.equal(payments.n, 2, "satu posting pembayaran (2 baris) meski webhook dikirim dua kali");
  assert.equal(app.audit().balanced, true);
  await app.close();
});

test("gateway: kunci rahasia tidak pernah keluar dari server", async () => {
  const { app, base, buyer, sellerId, deal } = await gatewayMarket();
  app.db.prepare("UPDATE users SET gateway_account = 'acc_1' WHERE id = ?").run(sellerId);
  const responses = [
    JSON.stringify(await fetch(base + "/api/config").then((r) => r.json())),
    JSON.stringify((await buyer.post(`/api/deals/${deal.id}/pay`)).body),
    JSON.stringify((await buyer.get(`/api/deals?peer=${deal.sellerId}`)).body),
  ];
  for (const r of responses) {
    assert.ok(!r.includes(SECRET) && !r.includes(TOKEN), "kunci/token gateway bocor di respons API");
  }
  assert.equal(JSON.parse(responses[0]).paymentProvider, "xendit");
  await app.close();
});

test("gateway: invoice kedaluwarsa bisa dibuat ulang; webhook untuk kode tak dikenal diabaikan", async () => {
  const { app, base, gw, buyer, sellerId, deal } = await gatewayMarket();
  app.db.prepare("UPDATE users SET gateway_account = 'acc_1' WHERE id = ?").run(sellerId);
  await buyer.post(`/api/deals/${deal.id}/pay`);
  assert.equal((await webhook(base, { external_id: deal.payRef, status: "EXPIRED", amount: 4_000_000 })).status, 200);
  assert.equal((await buyer.get(`/api/deals?peer=${deal.sellerId}`)).body.deals[0].paymentUrl, null);
  await buyer.post(`/api/deals/${deal.id}/pay`);
  assert.equal(gw.calls.length, 2, "invoice baru dibuat setelah yang lama kedaluwarsa");
  assert.equal((await webhook(base, { external_id: "PP-TIDAKADA0", status: "PAID", amount: 1 })).status, 200);
  await app.close();
});

test("mode simulasi: endpoint webhook tidak ada", async () => {
  const app = createApp({ dbPath: ":memory:" });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  assert.equal((await webhook(base, { external_id: "x", status: "PAID", amount: 1 })).status, 404);
  await app.close();
});
