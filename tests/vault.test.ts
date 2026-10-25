import { test } from "node:test";
import assert from "node:assert/strict";
import { decryptPayload, deriveConversationKey, encryptPayload, generateIdentity, safetyNumber } from "../shared/e2ee.ts";
import {
  decodeSeed,
  decryptBackup,
  encodeSeed,
  encryptBackup,
  generateSeed,
  identityFromSeed,
  localKeysFromSeed,
  openRecord,
  sealRecord,
  unwrapSeed,
  wrapSeed,
} from "../shared/vault.ts";

const FAST = 100_000; // iterasi minimum yang diterima; tes tidak perlu 600k
const ME = "11111111-1111-4111-8111-111111111111";

test("frasa kunci: 14 grup, bolak-balik sempurna, toleran huruf kecil & O/I/L", async () => {
  for (let i = 0; i < 20; i++) {
    const seed = generateSeed();
    const code = await encodeSeed(seed);
    assert.match(code, /^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.deepEqual(await decodeSeed(code), seed);
    assert.deepEqual(await decodeSeed(code.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l")), seed);
  }
});

test("frasa kunci: salah ketik satu karakter langsung ditolak (checksum)", async () => {
  const code = await encodeSeed(generateSeed());
  let caught = 0;
  for (let i = 0; i < 52; i++) {
    const c = code.replace(/-/g, "");
    const swapped = c.slice(0, i) + (c[i] === "A" ? "B" : "A") + c.slice(i + 1);
    try {
      await decodeSeed(swapped);
    } catch (e) {
      assert.equal((e as { code: string }).code, "bad_seed");
      caught++;
    }
  }
  assert.ok(caught >= 51, `hampir semua salah ketik harus tertangkap (${caught}/52)`); // 20-bit checksum
  await assert.rejects(decodeSeed("ABCD-EFGH"), /56 karakter/);
  await assert.rejects(decodeSeed(code.replace(/^./, "U")), /56 karakter/, "huruf U bukan bagian alfabet");
});

test("identitas dari seed deterministik & bekerja dengan E2EE biasa", async () => {
  const seed = generateSeed();
  const a1 = await identityFromSeed(seed);
  const a2 = await identityFromSeed(new Uint8Array(seed));
  assert.equal(a1.publicKey, a2.publicKey, "seed sama → kunci publik sama (perangkat baru tidak memicu peringatan MITM)");
  assert.notEqual((await identityFromSeed(generateSeed())).publicKey, a1.publicKey);
  await assert.rejects(crypto.subtle.exportKey("pkcs8", a1.privateKey), "kunci privat non-extractable");

  const bob = await generateIdentity();
  const me = { id: ME, publicKey: a1.publicKey };
  const peer = { id: "22222222-2222-4222-8222-222222222222", publicKey: bob.publicKey };
  const env = { id: crypto.randomUUID(), from: me, to: peer };
  const box = await encryptPayload(await deriveConversationKey(a1.privateKey, me, peer), env, { kind: "text", text: "halo dari perangkat lama" });
  // Perangkat baru (seed dipulihkan) membuka pesan yang sama.
  const kNew = await deriveConversationKey(a2.privateKey, me, peer);
  assert.deepEqual(await decryptPayload(kNew, env, box.nonce, box.ciphertext), { kind: "text", text: "halo dari perangkat lama" });
  assert.equal(await safetyNumber(me, peer), await safetyNumber({ id: ME, publicKey: a2.publicKey }, peer));
});

test("brankas: passphrase benar membuka, salah/akun lain/diubah ditolak", async () => {
  const seed = generateSeed();
  const vault = await wrapSeed(seed, "kopi-hujan-rotan-senja", ME, FAST);
  assert.equal(vault.publicKey, (await identityFromSeed(seed)).publicKey);
  assert.ok(!JSON.stringify(vault).includes(Buffer.from(seed).toString("base64")), "seed tidak tersimpan polos");
  assert.deepEqual(await unwrapSeed(vault, "kopi-hujan-rotan-senja", ME), seed);
  await assert.rejects(unwrapSeed(vault, "kopi-hujan-rotan-senjA", ME), (e: { code: string }) => e.code === "bad_passphrase");
  await assert.rejects(unwrapSeed(vault, "kopi-hujan-rotan-senja", "33333333-3333-4333-8333-333333333333"), (e: { code: string }) => e.code === "bad_passphrase");
  const other = await identityFromSeed(generateSeed());
  await assert.rejects(unwrapSeed({ ...vault, publicKey: other.publicKey }, "kopi-hujan-rotan-senja", ME), "kunci publik terikat AAD");
  await assert.rejects(unwrapSeed({ ...vault, iterations: 1 }, "kopi-hujan-rotan-senja", ME), (e: { code: string }) => e.code === "bad_vault", "iterasi lemah ditolak");
});

test("rekaman lokal: terikat ke kuncinya & ke akun", async () => {
  const seed = generateSeed();
  const k = await localKeysFromSeed(seed, ME);
  const rec = await sealRecord(k.history, `${ME}:msg-1`, { text: "rahasia" });
  assert.ok(!JSON.stringify(rec).includes("rahasia"));
  assert.deepEqual(await openRecord(k.history, `${ME}:msg-1`, rec), { text: "rahasia" });
  await assert.rejects(openRecord(k.history, `${ME}:msg-2`, rec), "rekaman tidak bisa dipindah ke kunci lain");
  await assert.rejects(openRecord(k.backup, `${ME}:msg-1`, rec), "kunci cadangan ≠ kunci riwayat");
  const other = await localKeysFromSeed(seed, "44444444-4444-4444-8444-444444444444");
  await assert.rejects(openRecord(other.history, `${ME}:msg-1`, rec), "akun lain dengan seed sama tetap tidak bisa membuka");
});

test("cadangan: hanya seed yang sama & akun yang sama; perubahan sekecil apa pun ditolak", async () => {
  const seed = generateSeed();
  const k = await localKeysFromSeed(seed, ME);
  const file = await encryptBackup(k.backup, ME, { messages: [{ text: "riwayat lama" }] });
  assert.ok(!JSON.stringify(file).includes("riwayat lama"));
  const again = await localKeysFromSeed(new Uint8Array(seed), ME); // perangkat baru, seed dipulihkan
  assert.deepEqual((await decryptBackup(again.backup, ME, JSON.parse(JSON.stringify(file)))).data, { messages: [{ text: "riwayat lama" }] });
  await assert.rejects(decryptBackup((await localKeysFromSeed(generateSeed(), ME)).backup, ME, file), (e: { code: string }) => e.code === "backup_decrypt_failed");
  await assert.rejects(decryptBackup(k.backup, "55555555-5555-4555-8555-555555555555", file), (e: { code: string }) => e.code === "backup_other_account");
  await assert.rejects(decryptBackup(k.backup, ME, { ...file, createdAt: file.createdAt + 1 }), (e: { code: string }) => e.code === "backup_decrypt_failed");
  await assert.rejects(decryptBackup(k.backup, ME, { hello: 1 }), (e: { code: string }) => e.code === "bad_backup");
});
