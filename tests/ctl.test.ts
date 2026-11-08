import { test } from "node:test";
import assert from "node:assert/strict";
import { activeItems, chunkItems, CtlError, GHOST_MAX_ITEMS, PartCollector, SlidingLimiter, validateCtl, type GhostItem } from "../shared/ctl.ts";
import { decryptPayload, deriveConversationKey, encryptPayload, generateIdentity, E2EEError } from "../shared/e2ee.ts";

const ID = "abcdefgh12345678";
const item = (n: number, over: Partial<GhostItem> = {}): GhostItem => ({ id: `item-${String(n).padStart(6, "0")}`, title: `Kopi ${n}`, description: "Panen terbaru", price: 50_000 + n, expiresAt: 10_000, ...over });

test("validateCtl: bentuk sah diterima, teks dibersihkan", () => {
  assert.deepEqual(validateCtl({ t: "store.req", reqId: ID }), { t: "store.req", reqId: ID });
  const res = validateCtl({ t: "store.res", reqId: ID, part: 0, parts: 1, storeExpiresAt: 5, items: [{ ...item(1), title: "Kopi‮evil" }] });
  assert.equal(res.t === "store.res" && res.items[0].title.includes("‮"), false, "karakter pembalik arah dibuang");
  assert.deepEqual(validateCtl({ t: "store.nack", orderId: ID, reason: "item_gone" }), { t: "store.nack", orderId: ID, reason: "item_gone" });
});

test("validateCtl: menolak bentuk jahat/rusak", () => {
  const bad: unknown[] = [
    null, "x", [], {}, { t: "nope" },
    { t: "store.req" }, { t: "store.req", reqId: "pendek" }, { t: "store.req", reqId: "a/b/../c/d/e/f/g" },
    { t: "store.res", reqId: ID, part: 1, parts: 1, items: [], storeExpiresAt: 1 },
    { t: "store.res", reqId: ID, part: 0, parts: 99, items: [], storeExpiresAt: 1 },
    { t: "store.res", reqId: ID, part: 0, parts: 1, items: "x", storeExpiresAt: 1 },
    { t: "store.res", reqId: ID, part: 0, parts: 1, items: Array.from({ length: GHOST_MAX_ITEMS + 1 }, (_, i) => item(i)), storeExpiresAt: 1 },
    { t: "store.res", reqId: ID, part: 0, parts: 1, items: [{ ...item(1), price: 1.5 }], storeExpiresAt: 1 },
    { t: "store.res", reqId: ID, part: 0, parts: 1, items: [{ ...item(1), price: 1 }], storeExpiresAt: 1 },
    { t: "store.res", reqId: ID, part: 0, parts: 1, items: [{ ...item(1), price: -5_000 }], storeExpiresAt: 1 },
    { t: "store.res", reqId: ID, part: 0, parts: 1, items: [{ ...item(1), title: "" }], storeExpiresAt: 1 },
    { t: "store.res", reqId: ID, part: 0, parts: 1, items: [{ ...item(1), title: 5 }], storeExpiresAt: 1 },
    { t: "store.order", orderId: ID }, { t: "store.nack", orderId: ID, reason: "<script>" },
  ];
  for (const b of bad) assert.throws(() => validateCtl(b), CtlError, JSON.stringify(b).slice(0, 80));
});

test("chunkItems: tiap bagian ≤ batas, tidak ada item hilang, minimal 1 bagian", () => {
  assert.equal(chunkItems([]).length, 1);
  const items = Array.from({ length: GHOST_MAX_ITEMS }, (_, i) => item(i, { description: "x".repeat(300) }));
  const parts = chunkItems(items, 2048);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(new TextEncoder().encode(JSON.stringify(p)).length <= 2048 + 2);
  assert.equal(parts.flat().length, items.length);
  assert.deepEqual(parts.flat().map((i) => i.id), items.map((i) => i.id));
});

test("activeItems: buang yang hangus, urut harga", () => {
  const out = activeItems([item(3), item(1, { expiresAt: 5 }), item(2, { price: 1_000 })], 6_000);
  assert.deepEqual(out.map((i) => i.id), [item(2).id, item(3).id]);
});

test("PartCollector: lengkap hanya bila semua bagian datang; reqId asing & jumlah bagian berubah diabaikan", () => {
  const c = new PartCollector(ID);
  const res = (part: number, parts: number, items: GhostItem[], reqId = ID) => validateCtl({ t: "store.res", reqId, part, parts, items, storeExpiresAt: 9 }) as Extract<ReturnType<typeof validateCtl>, { t: "store.res" }>;
  assert.equal(c.add(res(1, 2, [item(2)])), false);
  assert.equal(c.add(res(0, 2, [item(1)], "lain-lain-1234")), false, "reqId asing ditolak");
  assert.equal(c.add(res(0, 3, [item(9)])), false, "jumlah bagian berubah ditolak");
  assert.equal(c.add(res(0, 2, [item(1), item(1)])), true);
  assert.deepEqual(c.items().map((i) => i.id), [item(1).id, item(2).id], "duplikat id dibuang, urutan per bagian");
});

test("SlidingLimiter: batas per kunci dalam jendela", () => {
  const l = new SlidingLimiter(2, 1000);
  assert.ok(l.take("a", 0) && l.take("a", 10));
  assert.equal(l.take("a", 20), false);
  assert.ok(l.take("b", 20), "kunci lain tidak terpengaruh");
  assert.ok(l.take("a", 1200), "jendela bergeser");
});

test("payload ctl: lewat E2EE yang sama, ciphertext tidak membocorkan isi, dan tidak sah di saluran momen", async () => {
  const a = await generateIdentity();
  const b = await generateIdentity();
  const pa = { id: "user-a", publicKey: a.publicKey };
  const pb = { id: "user-b", publicKey: b.publicKey };
  const key = await deriveConversationKey(a.privateKey, pa, pb);
  const keyB = await deriveConversationKey(b.privateKey, pb, pa);
  const env = { id: crypto.randomUUID(), from: pa, to: pb };
  const ctl = { t: "store.req", reqId: ID };
  const box = await encryptPayload(key, env, { kind: "ctl", ctl });
  assert.ok(!atob(box.ciphertext).includes("store.req"), "ctl terenkripsi");
  const out = await decryptPayload(keyB, env, box.nonce, box.ciphertext);
  assert.deepEqual(out, { kind: "ctl", ctl });
  await assert.rejects(decryptPayload(keyB, env, box.nonce, box.ciphertext, "moment"), E2EEError);
});
