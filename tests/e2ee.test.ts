import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decryptPayload,
  deriveConversationKey,
  encryptPayload,
  fromB64,
  generateIdentity,
  isValidPublicKey,
  safetyNumber,
  toB64,
  type Envelope,
} from "../shared/e2ee.ts";
import { generatePin, isValidPin, normalizePin, pinProblem, PIN_ALPHABET } from "../shared/pin.ts";

async function pair() {
  const a = await generateIdentity();
  const b = await generateIdentity();
  const A = { id: "aaaa", publicKey: a.publicKey };
  const B = { id: "bbbb", publicKey: b.publicKey };
  return { a, b, A, B };
}

test("kedua pihak menurunkan kunci yang sama dan pesan bolak-balik", async () => {
  const { a, b, A, B } = await pair();
  const kA = await deriveConversationKey(a.privateKey, A, B);
  const kB = await deriveConversationKey(b.privateKey, B, A);
  const env: Envelope = { id: crypto.randomUUID(), from: A, to: B };
  const box = await encryptPayload(kA, env, { kind: "text", text: "Halo, ini rahasia 🔐" });
  assert.deepEqual(await decryptPayload(kB, env, box.nonce, box.ciphertext), { kind: "text", text: "Halo, ini rahasia 🔐" });
  // Pengirim juga bisa membaca ulang pesannya sendiri.
  assert.deepEqual(await decryptPayload(kA, env, box.nonce, box.ciphertext), { kind: "text", text: "Halo, ini rahasia 🔐" });
});

test("pihak ketiga tidak bisa membuka pesan", async () => {
  const { a, A, B } = await pair();
  const eve = await generateIdentity();
  const E = { id: "eeee", publicKey: eve.publicKey };
  const env: Envelope = { id: crypto.randomUUID(), from: A, to: B };
  const box = await encryptPayload(await deriveConversationKey(a.privateKey, A, B), env, { kind: "text", text: "x" });
  const kEve = await deriveConversationKey(eve.privateKey, E, A);
  await assert.rejects(decryptPayload(kEve, env, box.nonce, box.ciphertext), { code: "decrypt_failed" });
});

test("ciphertext yang diubah satu bit ditolak", async () => {
  const { a, b, A, B } = await pair();
  const env: Envelope = { id: crypto.randomUUID(), from: A, to: B };
  const box = await encryptPayload(await deriveConversationKey(a.privateKey, A, B), env, { kind: "text", text: "transfer 100rb" });
  const bytes = fromB64(box.ciphertext);
  bytes[3] ^= 1;
  const kB = await deriveConversationKey(b.privateKey, B, A);
  await assert.rejects(decryptPayload(kB, env, box.nonce, toB64(bytes)), { code: "decrypt_failed" });
});

test("ciphertext tidak bisa dipindah ke pesan/arah lain (AAD mengikat)", async () => {
  const { a, b, A, B } = await pair();
  const env: Envelope = { id: crypto.randomUUID(), from: A, to: B };
  const box = await encryptPayload(await deriveConversationKey(a.privateKey, A, B), env, { kind: "text", text: "ok" });
  const kB = await deriveConversationKey(b.privateKey, B, A);
  await assert.rejects(decryptPayload(kB, { ...env, id: crypto.randomUUID() }, box.nonce, box.ciphertext), { code: "decrypt_failed" });
  await assert.rejects(decryptPayload(kB, { id: env.id, from: B, to: A }, box.nonce, box.ciphertext), { code: "decrypt_failed" });
});

test("nonce selalu berbeda untuk pesan yang sama", async () => {
  const { a, A, B } = await pair();
  const k = await deriveConversationKey(a.privateKey, A, B);
  const env: Envelope = { id: crypto.randomUUID(), from: A, to: B };
  const nonces = new Set<string>();
  for (let i = 0; i < 200; i++) nonces.add((await encryptPayload(k, env, { kind: "ping" })).nonce);
  assert.equal(nonces.size, 200);
});

test("kunci privat tidak bisa diekspor oleh skrip", async () => {
  const { a } = await pair();
  assert.equal(a.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("pkcs8", a.privateKey));
});

test("kunci publik jahat (nol / ukuran salah) ditolak", async () => {
  const { a, A } = await pair();
  assert.equal(isValidPublicKey(toB64(new Uint8Array(32))), false);
  assert.equal(isValidPublicKey(toB64(new Uint8Array(31).fill(7))), false);
  assert.equal(isValidPublicKey("bukan base64!!"), false);
  await assert.rejects(deriveConversationKey(a.privateKey, A, { id: "zz", publicKey: toB64(new Uint8Array(32)) }));
});

test("safety number simetris dan berubah bila kunci berganti", async () => {
  const { A, B } = await pair();
  const s1 = await safetyNumber(A, B);
  assert.equal(s1, await safetyNumber(B, A));
  assert.match(s1, /^(\d{5} ){11}\d{5}$/);
  const fresh = await generateIdentity();
  assert.notEqual(s1, await safetyNumber(A, { ...B, publicKey: fresh.publicKey }));
});

test("payload tak dikenal ditolak (tidak dirender sembarangan)", async () => {
  const { a, b, A, B } = await pair();
  const env: Envelope = { id: crypto.randomUUID(), from: A, to: B };
  const k = await deriveConversationKey(a.privateKey, A, B);
  const box = await encryptPayload(k, env, { kind: "html", html: "<script>" } as never);
  await assert.rejects(decryptPayload(await deriveConversationKey(b.privateKey, B, A), env, box.nonce, box.ciphertext), { code: "bad_payload" });
});

test("PIN: alfabet anti-ambigu, acak, dan tanpa bias besar", () => {
  assert.equal(PIN_ALPHABET.length, 32);
  for (const c of "01IO") assert.equal(PIN_ALPHABET.includes(c), false);
  const counts = new Map<string, number>();
  const pins = new Set<string>();
  for (let i = 0; i < 20000; i++) {
    const p = generatePin();
    assert.ok(isValidPin(p));
    pins.add(p);
    for (const c of p) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  assert.ok(pins.size > 19990, "tabrakan PIN terlalu banyak");
  const expected = (20000 * 6) / 32;
  for (const n of counts.values()) assert.ok(Math.abs(n - expected) < expected * 0.1, "distribusi karakter bias");
});

test("PIN: input ramah pengguna dan pesan salah ketik jelas", () => {
  assert.equal(normalizePin(" 7k9-p2x "), "7K9P2X");
  assert.equal(pinProblem("7K9P2X"), null);
  assert.match(pinProblem("7K9P0X")!, /0\/1/);
  assert.match(pinProblem("7K9")!, /6 karakter/);
});
