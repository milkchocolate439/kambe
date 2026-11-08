import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, startApp } from "./helpers.ts";
import { generateSeed, signIdentityFromSeed } from "../shared/vault.ts";
import { toB64 } from "../shared/e2ee.ts";

test("kunci tanda tangan: hanya kunci Ed25519 sah yang diterima, dan terlihat oleh kontak", async () => {
  const { app, base } = await startApp();
  const a = new Client(base);
  const b = new Client(base);
  const ma = (await a.signup("Penanda_A")).me;
  await b.signup("Penanda_B");
  await b.post("/api/contacts/invite", { pin: ma.pin });
  await a.post(`/api/contacts/requests/${(await a.get("/api/contacts")).body.incoming[0].id}/accept`);

  assert.equal((await a.get("/api/me")).body.me.signKey, null, "awalnya belum ada");
  for (const bad of [undefined, "", "abc", toB64(new Uint8Array(32)), toB64(new Uint8Array(31).fill(7)), 12345]) {
    assert.equal((await a.put("/api/me/sign-key", { signKey: bad })).status, 400, `ditolak: ${String(bad).slice(0, 12)}`);
  }
  const { publicKey } = await signIdentityFromSeed(generateSeed());
  const ok = await a.put("/api/me/sign-key", { signKey: publicKey });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.me.signKey, publicKey);

  const seenByB = (await b.get("/api/contacts")).body.contacts.find((c: { alias: string }) => c.alias === "Penanda_A");
  assert.equal(seenByB.signKey, publicKey, "kontak melihat kunci publik tanda tangan");

  // Tanpa login ditolak.
  assert.equal((await new Client(base).put("/api/me/sign-key", { signKey: publicKey })).status, 401);
  await app.close();
});
