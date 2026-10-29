// Jangkar kompatibilitas rebrand KAMBE: data yang dibuat di era PINPath (tests/fixtures/pre-kambe.json,
// direkam dari kode sebelum rebrand) harus tetap identik dan tetap terbuka.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROTOCOL, fromB64, safetyNumber } from "../shared/e2ee.ts";
import { RECEIPT_KIND } from "../shared/receipt.ts";
import { openSealed, type SealedBlob } from "../shared/sealed.ts";
import { BACKUP_FORMAT, decryptBackup, identityFromSeed, localKeysFromSeed } from "../shared/vault.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/pre-kambe.json", import.meta.url), "utf8"));

test("kambe-compat: identitas dari seed lama tetap sama", async () => {
  assert.equal((await identityFromSeed(fromB64(fx.seedA))).publicKey, fx.publicKeyA);
  assert.equal((await identityFromSeed(fromB64(fx.seedB))).publicKey, fx.publicKeyB);
});

test("kambe-compat: nomor keamanan lama tetap sama", async () => {
  const a = await identityFromSeed(fromB64(fx.seedA));
  const b = await identityFromSeed(fromB64(fx.seedB));
  assert.equal(await safetyNumber({ id: fx.userA, publicKey: a.publicKey }, { id: fx.userB, publicKey: b.publicKey }), fx.safetyNumberAB);
});

test("kambe-compat: cadangan pinpath-backup lama tetap terbuka", async () => {
  const keys = await localKeysFromSeed(fromB64(fx.seedA), fx.userA);
  const out = await decryptBackup<{ hello: string }>(keys.backup, fx.userA, fx.backup);
  assert.deepEqual(out.data, { hello: "kambe" });
  assert.equal(out.createdAt, 1730000000000);
});

test("kambe-compat: objek tersegel lama tetap terbuka untuk penerima", async () => {
  const b = await identityFromSeed(fromB64(fx.seedB));
  assert.deepEqual(await openSealed(b.privateKey, b.publicKey, fx.sealed as SealedBlob), { teks: "pesan dari era PINPath" });
});

test("kambe-compat: label protokol beku", () => {
  assert.equal(PROTOCOL, "pinpath/v1");
  assert.equal(BACKUP_FORMAT, "pinpath-backup");
  assert.equal(RECEIPT_KIND, "pinpath.deal-receipt");
});
