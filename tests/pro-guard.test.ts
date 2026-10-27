import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.ts";
import { xenditProvider } from "../server/payments.ts";
import { Client } from "./helpers.ts";

const key = () => crypto.randomUUID().replace(/-/g, "");

test("PRO: gateway sungguhan menolak aktivasi tanpa pembayaran (402)", async () => {
  const app = createApp({
    dbPath: ":memory:",
    payments: xenditProvider({
      secretKey: "xnd_development_X",
      callbackToken: "t",
      splitRuleId: "r",
      successUrl: "https://pinpath.example/ok",
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    }),
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  try {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const c = new Client(base);
    await c.signup("Calon_PRO");
    const res = await c.post("/api/pro/subscribe", { idempotencyKey: key() });
    assert.equal(res.status, 402);
    const pro = (await c.get("/api/pro")).body;
    assert.ok(!pro.active && !pro.proUntil, "tidak boleh ada PRO aktif");
  } finally {
    await new Promise<void>((r) => app.server.close(() => r()));
  }
});
