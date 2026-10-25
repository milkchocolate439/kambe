import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, startApp } from "./helpers.ts";
import {
  decryptPayload,
  deriveConversationKey,
  deriveSelfKey,
  encryptPayload,
  generateIdentity,
  type Envelope,
  type Identity,
  type MomentType,
} from "../shared/e2ee.ts";

interface Person {
  client: Client;
  id: string;
  key: Identity;
}

async function person(base: string, alias: string): Promise<Person> {
  const client = new Client(base);
  const { me } = await client.signup(alias);
  const key = await generateIdentity();
  await client.put("/api/me/key", { publicKey: key.publicKey });
  return { client, id: me.id, key };
}

async function befriend(a: Person, b: Person) {
  const pin = (await b.client.get("/api/me")).body.me.pin;
  await a.client.post("/api/contacts/invite", { pin });
  const inc = (await b.client.get("/api/contacts")).body.incoming;
  await b.client.post(`/api/contacts/requests/${inc[0].id}/accept`);
}

/** Enkripsi satu momen untuk setiap penerima + salinan diri sendiri — persis seperti klien. */
async function seal(author: Person, recipients: Person[], text: string, type: MomentType = "thought", id = crypto.randomUUID()) {
  const me = { id: author.id, publicKey: author.key.publicKey };
  const payload = { kind: "moment" as const, type, text };
  const copies = [];
  const selfEnv: Envelope = { id, from: me, to: me };
  copies.push({ to: author.id, toKey: me.publicKey, ...(await encryptPayload(await deriveSelfKey(author.key.privateKey, me), selfEnv, payload, "moment")) });
  for (const r of recipients) {
    const them = { id: r.id, publicKey: r.key.publicKey };
    const env: Envelope = { id, from: me, to: them };
    copies.push({ to: r.id, toKey: them.publicKey, ...(await encryptPayload(await deriveConversationKey(author.key.privateKey, me, them), env, payload, "moment")) });
  }
  return { id, fromKey: me.publicKey, copies };
}

async function open(viewer: Person, m: { id: string; authorId: string; authorKey: string; copy: { toKey: string; nonce: string; ciphertext: string } }, channel: "moment" | "msg" = "moment") {
  const author = { id: m.authorId, publicKey: m.authorKey };
  const me = { id: viewer.id, publicKey: m.copy.toKey };
  const isSelf = m.authorId === viewer.id;
  const key = isSelf ? await deriveSelfKey(viewer.key.privateKey, me) : await deriveConversationKey(viewer.key.privateKey, me, author);
  const env: Envelope = { id: m.id, from: author, to: isSelf ? author : me };
  return decryptPayload(key, env, m.copy.nonce, m.copy.ciphertext, channel);
}

test("momen terenkripsi per kontak: kontak & penulis bisa membaca, server tidak", async () => {
  const { app, base } = await startApp();
  const ayu = await person(base, "Ayu_Rotan");
  const bima = await person(base, "Bima_Kopi");
  await befriend(ayu, bima);
  const RAHASIA = "Lagi di gudang Sampit, stok rotan baru datang";
  assert.equal((await ayu.client.post("/api/moments", await seal(ayu, [bima], RAHASIA, "place"))).status, 200);

  const forBima = (await bima.client.get("/api/moments")).body.moments;
  assert.equal(forBima.length, 1);
  assert.equal(forBima[0].authorAlias, "Ayu_Rotan");
  assert.deepEqual(await open(bima, forBima[0]), { kind: "moment", type: "place", text: RAHASIA });
  const forAyu = (await ayu.client.get("/api/moments")).body.moments;
  assert.deepEqual(await open(ayu, forAyu[0]), { kind: "moment", type: "place", text: RAHASIA }, "penulis membaca salinan pribadinya");

  for (const t of ["moments", "moment_copies"]) {
    assert.ok(!JSON.stringify(app.db.prepare(`SELECT * FROM ${t}`).all()).includes("Sampit"), `plaintext bocor di ${t}`);
  }
  await app.close();
});

test("pemisahan saluran: salinan momen tidak bisa dibuka sebagai pesan chat", async () => {
  const { app, base } = await startApp();
  const ayu = await person(base, "Ayu_Rotan");
  const bima = await person(base, "Bima_Kopi");
  await befriend(ayu, bima);
  await ayu.client.post("/api/moments", await seal(ayu, [bima], "rahasia saluran"));
  const m = (await bima.client.get("/api/moments")).body.moments[0];
  await assert.rejects(open(bima, m, "msg"), { code: "decrypt_failed" });
  await app.close();
});

test("momen hanya untuk kontak: orang asing ditolak & tidak melihat apa pun", async () => {
  const { app, base } = await startApp();
  const ayu = await person(base, "Ayu_Rotan");
  const bima = await person(base, "Bima_Kopi");
  const asing = await person(base, "Orang_Asing");
  await befriend(ayu, bima);
  const r = await ayu.client.post("/api/moments", await seal(ayu, [bima, asing], "untuk semua?"));
  assert.equal(r.status, 403, "tidak bisa menyemprot momen ke bukan-kontak");
  await ayu.client.post("/api/moments", await seal(ayu, [bima], "untuk kontak saja"));
  assert.equal((await asing.client.get("/api/moments")).body.moments.length, 0);
  await app.close();
});

test("validasi: salinan pribadi wajib, kunci perangkat harus terbaru, kunci kontak basi ditolak", async () => {
  const { app, base } = await startApp();
  const ayu = await person(base, "Ayu_Rotan");
  const bima = await person(base, "Bima_Kopi");
  await befriend(ayu, bima);
  const sealed = await seal(ayu, [bima], "tes");
  assert.equal((await ayu.client.post("/api/moments", { ...sealed, copies: sealed.copies.slice(1) })).body.error, "self_copy_required");
  assert.equal((await ayu.client.post("/api/moments", { ...sealed, id: "bukan-uuid" })).status, 400);
  const fresh = await generateIdentity();
  await bima.client.put("/api/me/key", { publicKey: fresh.publicKey }); // bima ganti perangkat
  const stale = await ayu.client.post("/api/moments", await seal(ayu, [bima], "ke kunci lama"));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "key_changed");
  const dup = await seal(ayu, [], "sekali");
  await ayu.client.post("/api/moments", dup);
  assert.equal((await ayu.client.post("/api/moments", dup)).status, 409, "ID momen tidak bisa dipakai ulang");
  await app.close();
});

test("hapus kontak / blokir menyembunyikan momen lama penulis", async () => {
  const { app, base } = await startApp();
  const ayu = await person(base, "Ayu_Rotan");
  const bima = await person(base, "Bima_Kopi");
  const citra = await person(base, "Citra_Desain");
  await befriend(ayu, bima);
  await befriend(ayu, citra);
  await ayu.client.post("/api/moments", await seal(ayu, [bima, citra], "momen lama"));
  await bima.client.del(`/api/contacts/${ayu.id}`);
  assert.equal((await bima.client.get("/api/moments")).body.moments.length, 0);
  await ayu.client.post("/api/blocks", { userId: citra.id });
  assert.equal((await citra.client.get("/api/moments")).body.moments.length, 0);
  await app.close();
});

test("reaksi ala Path: kontak bereaksi, ganti, batal; orang asing & emoji aneh ditolak", async () => {
  const { app, base } = await startApp();
  const ayu = await person(base, "Ayu_Rotan");
  const bima = await person(base, "Bima_Kopi");
  const asing = await person(base, "Orang_Asing");
  await befriend(ayu, bima);
  const { id } = await seal(ayu, [bima], "rilis produk baru");
  await ayu.client.post("/api/moments", await seal(ayu, [bima], "rilis produk baru", "thought", id));
  assert.equal((await bima.client.post(`/api/moments/${id}/react`, { emoji: "love" })).status, 200);
  let m = (await ayu.client.get("/api/moments")).body.moments[0];
  assert.deepEqual(m.reactions, { smile: 0, gasp: 0, love: 1 });
  await bima.client.post(`/api/moments/${id}/react`, { emoji: "gasp" });
  m = (await ayu.client.get("/api/moments")).body.moments[0];
  assert.deepEqual(m.reactions, { smile: 0, gasp: 1, love: 0 }, "satu orang satu reaksi");
  assert.equal((await bima.client.get("/api/moments")).body.moments[0].myReaction, "gasp");
  await bima.client.post(`/api/moments/${id}/react`, { emoji: null });
  assert.deepEqual((await ayu.client.get("/api/moments")).body.moments[0].reactions, { smile: 0, gasp: 0, love: 0 });
  assert.equal((await asing.client.post(`/api/moments/${id}/react`, { emoji: "love" })).status, 404);
  assert.equal((await bima.client.post(`/api/moments/${id}/react`, { emoji: "<script>" })).status, 400);
  await app.close();
});

test("regresi audit Fase 3 #2: momen untuk banyak kontak tidak terpental batas ukuran", async () => {
  const { app, base } = await startApp();
  const ayu = await person(base, "Ayu_Ramai");
  // 120 penerima dengan teks panjang ber-emoji (body > 32 KB). Penerima palsu dipakai agar tes tidak
  // perlu 120 pendaftaran: yang dibuktikan adalah body DITERIMA dan divalidasi (403 bukan-kontak), bukan 413.
  const fakes: Person[] = [];
  for (let i = 0; i < 120; i++) fakes.push({ client: ayu.client, id: crypto.randomUUID(), key: await generateIdentity() });
  const big = await seal(ayu, fakes, "🌿".repeat(250) + " stok rotan baru");
  assert.ok(JSON.stringify(big).length > 100 * 1024, "body uji memang besar");
  const r = await ayu.client.post("/api/moments", big);
  assert.equal(r.status, 403, `body besar harus sampai ke validasi, bukan ditolak ukuran (dapat ${r.status} ${r.body?.error})`);
  assert.equal(r.body.error, "not_contacts");
  await app.close();
});

test("hanya penulis yang bisa menghapus; momen kedaluwarsa hilang", async () => {
  const { app, base } = await startApp();
  const ayu = await person(base, "Ayu_Rotan");
  const bima = await person(base, "Bima_Kopi");
  await befriend(ayu, bima);
  const a = await seal(ayu, [bima], "akan dihapus");
  const b = await seal(ayu, [bima], "akan kedaluwarsa");
  await ayu.client.post("/api/moments", a);
  await ayu.client.post("/api/moments", b);
  assert.equal((await bima.client.del(`/api/moments/${a.id}`)).status, 404);
  assert.equal((await ayu.client.del(`/api/moments/${a.id}`)).status, 200);
  app.db.prepare("UPDATE moments SET expires_at = ? WHERE id = ?").run(Date.now() - 1, b.id);
  assert.equal((await bima.client.get("/api/moments")).body.moments.length, 0);
  assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM moment_copies WHERE moment_id = ?").get(a.id) as { n: number }).n, 0, "salinan ikut terhapus");
  await app.close();
});
