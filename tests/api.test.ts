import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, startApp, TEST_PASSPHRASE, wsRejection } from "./helpers.ts";
import { decryptPayload, deriveConversationKey, encryptPayload, generateIdentity, type Envelope, type Identity } from "../shared/e2ee.ts";

/** Dua pengguna yang sudah saling terhubung + punya kunci perangkat. */
async function connectedPair() {
  const env = await startApp();
  const alice = new Client(env.base);
  const bob = new Client(env.base);
  const a = await alice.signup("alice");
  const b = await bob.signup("bob_99");
  const ka = await generateIdentity();
  const kb = await generateIdentity();
  await alice.put("/api/me/key", { publicKey: ka.publicKey });
  await bob.put("/api/me/key", { publicKey: kb.publicKey });
  assert.equal((await alice.post("/api/contacts/invite", { pin: b.me.pin })).body.status, "pending");
  const inc = (await bob.get("/api/contacts")).body.incoming;
  await bob.post(`/api/contacts/requests/${inc[0].id}/accept`);
  return { ...env, alice, bob, a: a.me, b: b.me, ka, kb };
}

async function sealed(me: { id: string }, myKey: Identity, peer: { id: string }, peerPub: string, text: string, ping = false) {
  const env: Envelope = { id: crypto.randomUUID(), from: { id: me.id, publicKey: myKey.publicKey }, to: { id: peer.id, publicKey: peerPub } };
  const key = await deriveConversationKey(myKey.privateKey, env.from, env.to);
  const box = await encryptPayload(key, env, ping ? { kind: "ping" } : { kind: "text", text });
  return { t: "send", id: env.id, to: peer.id, fromKey: env.from.publicKey, toKey: peerPub, ...box, ping };
}

test("pendaftaran: PIN valid, kode pemulihan, cookie aman, tanpa data pribadi", async () => {
  const { app, base } = await startApp();
  const c = new Client(base);
  const r = await c.post("/api/auth/signup", { alias: "Anon_Wolf99", passphrase: "kuda-terbang-di-malam-hari" });
  assert.equal(r.status, 200);
  assert.match(r.body.me.pin, /^[2-9A-HJ-NP-Z]{6}$/);
  assert.match(r.body.recoveryCode, /^([2-9A-HJ-NP-Z]{5}-){3}[2-9A-HJ-NP-Z]{5}$/);
  const cookie = r.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(r.headers.get("content-security-policy")!, /script-src 'self'/);
  // Passphrase & kode pemulihan hanya tersimpan sebagai hash scrypt.
  const row = app.db.prepare("SELECT * FROM users").get() as Record<string, string>;
  assert.ok(!JSON.stringify(row).includes("kuda-terbang"));
  assert.match(row.pass_hash, /^scrypt\$/);
  // Passphrase lemah ditolak.
  assert.equal((await new Client(base).post("/api/auth/signup", { alias: "x_user", passphrase: "pendek" })).status, 400);
  assert.equal((await new Client(base).post("/api/auth/signup", { alias: "anon_wolf99", passphrase: "apa-saja-panjang" })).status, 409);
  await app.close();
});

test("CSRF & CSWSH: permintaan tanpa/dengan Origin asing ditolak", async () => {
  const { app, base } = await startApp();
  const c = new Client(base);
  await c.signup("korban");
  const evil = new Client(base);
  evil.cookie = c.cookie;
  evil.origin = "https://situs-jahat.example";
  assert.equal((await evil.post("/api/me/pin/rotate")).status, 403);
  evil.origin = null;
  assert.equal((await evil.post("/api/me/pin/rotate")).status, 403);
  assert.equal(await wsRejection(base, { cookie: c.cookie, origin: "https://situs-jahat.example" }), 403);
  assert.equal(await wsRejection(base, { origin: base }), 401);
  assert.equal(await wsRejection(base, { cookie: c.cookie, origin: base }), 101);
  await app.close();
});

test("undangan PIN: wajib disetujui, alias tujuan tidak bocor sebelum diterima", async () => {
  const { app, base } = await startApp();
  const alice = new Client(base);
  const bob = new Client(base);
  await alice.signup("alice");
  const b = await bob.signup("bob_rahasia");
  assert.equal((await alice.post("/api/contacts/invite", { pin: b.me.pin.toLowerCase(), note: "Mau beli kopi" })).status, 200);
  const out = (await alice.get("/api/contacts")).body;
  assert.equal(out.contacts.length, 0);
  assert.deepEqual(Object.keys(out.outgoing[0]).sort(), ["createdAt", "id", "pin"]);
  assert.ok(!JSON.stringify(out).includes("bob_rahasia"));
  const inc = (await bob.get("/api/contacts")).body.incoming;
  assert.equal(inc[0].from.alias, "alice");
  assert.equal(inc[0].note, "Mau beli kopi");
  // Sebelum disetujui tidak bisa membaca/mengirim.
  assert.equal((await alice.get(`/api/messages/${b.me.id}`)).status, 404);
  await bob.post(`/api/contacts/requests/${inc[0].id}/accept`);
  assert.equal((await alice.get("/api/contacts")).body.contacts[0].alias, "bob_rahasia");
  // PIN salah / PIN sendiri.
  assert.equal((await alice.post("/api/contacts/invite", { pin: "ZZZZZZ" })).status, 404);
  assert.equal((await bob.post("/api/contacts/invite", { pin: b.me.pin })).status, 400);
  await app.close();
});

test("pemindaian PIN massal dihentikan rate limit", async () => {
  const { app, base } = await startApp();
  const scanner = new Client(base);
  await scanner.signup("pemindai");
  const statuses: number[] = [];
  const A = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (let i = 0; i < 35; i++) statuses.push((await scanner.post("/api/contacts/invite", { pin: "ZZZZ" + A[i >> 5] + A[i & 31] })).status);
  assert.ok(statuses.slice(0, 30).every((s) => s === 404));
  assert.ok(statuses.slice(30).every((s) => s === 429));
  await app.close();
});

test("E2EE ujung-ke-ujung: server & database hanya melihat ciphertext", async () => {
  const { app, alice, bob, a, b, ka, kb } = await connectedPair();
  const sa = await alice.socket();
  const sb = await bob.socket();
  const RAHASIA = "Harga deal Rp 850.000, kirim ke gudang Sampit";
  const out = await sealed(a, ka, b, kb.publicKey, RAHASIA);
  sa.send(out);
  const ack = await sa.next("ack");
  assert.equal(ack.status, "S");
  const got = (await sb.next("message")).message;
  const env: Envelope = { id: got.id, from: { id: got.from, publicKey: got.fromKey }, to: { id: got.to, publicKey: got.toKey } };
  const plain = await decryptPayload(await deriveConversationKey(kb.privateKey, env.to, env.from), env, got.nonce, got.ciphertext);
  assert.deepEqual(plain, { kind: "text", text: RAHASIA });

  // Pindai SELURUH database: plaintext tidak boleh ada di mana pun.
  for (const { name } of app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
    const dump = JSON.stringify(app.db.prepare(`SELECT * FROM ${name}`).all());
    assert.ok(!dump.includes("850.000") && !dump.includes("Sampit"), `plaintext bocor di tabel ${name}`);
  }
  sa.close();
  sb.close();
  await app.close();
});

test("pihak ketiga tidak bisa membaca atau menyisipkan pesan", async () => {
  const { app, base, alice, a, b, ka, kb } = await connectedPair();
  const eve = new Client(base);
  await eve.signup("eve_penyusup");
  const ke = await generateIdentity();
  await eve.put("/api/me/key", { publicKey: ke.publicKey });
  const sa = await alice.socket();
  sa.send(await sealed(a, ka, b, kb.publicKey, "rahasia"));
  await sa.next("ack");
  assert.equal((await eve.get(`/api/messages/${a.id}`)).status, 404);
  assert.equal((await eve.get(`/api/messages/${b.id}`)).status, 404);
  const se = await eve.socket();
  se.send(await sealed({ id: (await eve.get("/api/me")).body.me.id }, ke, b, kb.publicKey, "spam"));
  assert.equal((await se.next("rejected")).code, "not_contacts");
  // Eve mencoba memalsukan diri sebagai alice (fromKey milik alice) — tetap ditolak.
  const fake = await sealed(a, ka, b, kb.publicKey, "palsu");
  se.send(fake);
  assert.equal((await se.next("rejected")).code, "not_contacts");
  sa.close();
  se.close();
  await app.close();
});

test("status D/R ala BBM nyata, dan R bisa dimatikan", async () => {
  const { app, alice, bob, a, b, ka, kb } = await connectedPair();
  const sa = await alice.socket();
  const sb = await bob.socket();
  sa.send(await sealed(a, ka, b, kb.publicKey, "satu"));
  const { id } = await sa.next("ack");
  await sb.next("message");
  sb.send({ t: "delivered", ids: [id] });
  assert.deepEqual(await sa.next("status"), { t: "status", ids: [id], status: "D" });
  sb.send({ t: "read", peer: a.id, ids: [id] });
  assert.deepEqual(await sa.next("status"), { t: "status", ids: [id], status: "R" });

  await bob.patch("/api/me/settings", { readReceipts: false });
  sa.send(await sealed(a, ka, b, kb.publicKey, "dua"));
  const second = await sa.next("ack");
  await sb.next("message");
  sb.send({ t: "read", peer: a.id, ids: [second.id] });
  assert.equal((await sa.next("status")).status, "D");
  const hist = (await alice.get(`/api/messages/${b.id}`)).body.messages;
  assert.equal(hist.find((m: { id: string }) => m.id === second.id).status, "D");
  sa.close();
  sb.close();
  await app.close();
});

test("kunci lawan berganti: pesan ke kunci lama ditolak & ada peringatan", async () => {
  const { app, alice, bob, a, b, ka, kb } = await connectedPair();
  const sa = await alice.socket();
  const fresh = await generateIdentity();
  await bob.put("/api/me/key", { publicKey: fresh.publicKey });
  assert.equal((await sa.next("key_changed")).userId, b.id);
  sa.send(await sealed(a, ka, b, kb.publicKey, "ke kunci lama"));
  assert.equal((await sa.next("rejected")).code, "key_changed");
  sa.close();
  await app.close();
});

test("PING!!! dibatasi 30 detik dan pesan ulang (retry) idempoten", async () => {
  const { app, alice, a, b, ka, kb } = await connectedPair();
  const sa = await alice.socket();
  sa.send(await sealed(a, ka, b, kb.publicKey, "", true));
  await sa.next("ack");
  sa.send(await sealed(a, ka, b, kb.publicKey, "", true));
  assert.equal((await sa.next("rejected")).code, "ping_cooldown");
  const msg = await sealed(a, ka, b, kb.publicKey, "sekali saja");
  sa.send(msg);
  const first = await sa.next("ack");
  sa.send(msg);
  const again = await sa.next("ack");
  assert.equal(first.createdAt, again.createdAt);
  assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = ?").get(msg.id) as { n: number }).n, 1);
  sa.close();
  await app.close();
});

test("blokir: memutus kontak, menolak pesan, undangan ulang tak sampai", async () => {
  const { app, alice, bob, a, b, ka, kb } = await connectedPair();
  await bob.post("/api/blocks", { userId: a.id });
  const sa = await alice.socket();
  sa.send(await sealed(a, ka, b, kb.publicKey, "halo?"));
  assert.equal((await sa.next("rejected")).code, "not_contacts");
  assert.equal((await alice.post("/api/contacts/invite", { pin: b.pin })).body.status, "pending");
  assert.equal((await bob.get("/api/contacts")).body.incoming.length, 0);
  assert.equal((await bob.get("/api/blocks")).body.blocked[0].alias, "alice");
  sa.close();
  await app.close();
});

test("ganti PIN: PIN lama mati & undangan spam ke PIN lama terhapus", async () => {
  const { app, base } = await startApp();
  const owner = new Client(base);
  const spammer = new Client(base);
  const o = await owner.signup("pemilik");
  await spammer.signup("spammer");
  await spammer.post("/api/contacts/invite", { pin: o.me.pin });
  const rotated = (await owner.post("/api/me/pin/rotate")).body.me.pin;
  assert.notEqual(rotated, o.me.pin);
  assert.equal((await owner.get("/api/contacts")).body.incoming.length, 0);
  assert.equal((await spammer.post("/api/contacts/invite", { pin: o.me.pin })).status, 404);
  await app.close();
});

test("login: pesan salah seragam & brute force dihentikan", async () => {
  const { app, base } = await startApp();
  await new Client(base).signup("target");
  const c = new Client(base);
  const wrongAlias = await c.post("/api/auth/login", { alias: "tidak_ada", passphrase: "apa-saja-panjang" });
  const wrongPass = await c.post("/api/auth/login", { alias: "target", passphrase: "salah-salah-salah" });
  assert.equal(wrongAlias.status, 401);
  assert.equal(wrongAlias.body.message, wrongPass.body.message);
  let last = 0;
  for (let i = 0; i < 8; i++) last = (await c.post("/api/auth/login", { alias: "target", passphrase: "tebak-" + i + "-xxxxx" })).status;
  assert.equal(last, 429);
  await app.close();
});

test("pemulihan akun: kode sekali pakai & semua sesi lama dicabut", async () => {
  const { app, base } = await startApp();
  const dev1 = new Client(base);
  const { recoveryCode } = await dev1.signup("lupa_pass");
  const dev2 = new Client(base);
  const r = await dev2.post("/api/auth/recover", { alias: "lupa_pass", recoveryCode: recoveryCode.toLowerCase(), newPassphrase: "passphrase-baru-yang-kuat" });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.recoveryCode, recoveryCode);
  assert.equal((await dev1.get("/api/me")).status, 401);
  assert.equal((await dev2.get("/api/me")).status, 200);
  const reuse = await new Client(base).post("/api/auth/recover", { alias: "lupa_pass", recoveryCode, newPassphrase: "coba-pakai-lagi-kode" });
  assert.equal(reuse.status, 401);
  assert.equal((await new Client(base).post("/api/auth/login", { alias: "lupa_pass", passphrase: "passphrase-baru-yang-kuat" })).status, 200);
  await app.close();
});

test("logout memutus WebSocket; hapus akun menghapus semua data", async () => {
  const { app, alice, bob, a, b, ka, kb } = await connectedPair();
  const sa = await alice.socket();
  sa.send(await sealed(a, ka, b, kb.publicKey, "pesan terakhir"));
  await sa.next("ack");
  const closed = new Promise<number>((r) => sa.ws.on("close", (code) => r(code)));
  await alice.post("/api/auth/logout");
  assert.equal(await closed, 4001);
  assert.equal((await alice.get("/api/me")).status, 401);

  assert.equal((await bob.post("/api/me/delete", { passphrase: "salah" })).status, 401);
  assert.equal((await bob.post("/api/me/delete", { passphrase: TEST_PASSPHRASE })).status, 200);
  for (const t of ["users", "messages", "contacts", "sessions"]) {
    const dump = JSON.stringify(app.db.prepare(`SELECT * FROM ${t}`).all());
    assert.ok(!dump.includes(b.id), `sisa data bob di ${t}`);
  }
  await app.close();
});

test("teks profil dibersihkan dari karakter kontrol & pembalik arah", async () => {
  const { app, base } = await startApp();
  const c = new Client(base);
  await c.signup("rapi");
  const r = await c.patch("/api/me/settings", { pm: "Jual‮gpj.exe\u0007 kopi" });
  assert.equal(r.body.me.pm, "Jualgpj.exe kopi");
  await app.close();
});

test("regresi red-team #1: frame WebSocket raksasa tidak mematikan server", async () => {
  const { app, alice, bob, a, b, ka, kb } = await connectedPair();
  const victim = await bob.socket();
  const attacker = await alice.socket();
  const closed = new Promise<void>((r) => attacker.ws.on("close", () => r()));
  attacker.ws.on("error", () => {});
  attacker.ws.send("x".repeat(70_000)); // > maxPayload 64 KB
  await closed;
  // Server tetap hidup untuk semua orang: HTTP jalan, socket korban masih menerima pesan.
  assert.equal((await bob.get("/api/me")).status, 200);
  const again = await alice.socket();
  again.send(await sealed(a, ka, b, kb.publicKey, "masih hidup?"));
  await again.next("ack");
  assert.equal((await victim.next("message")).message.from, a.id);
  victim.close();
  again.close();
  await app.close();
});

test("regresi red-team #2: hapus 'kontak' acak tidak memicu event ke korban", async () => {
  const { app, base } = await startApp();
  const attacker = new Client(base);
  const victim = new Client(base);
  await attacker.signup("pengusik");
  const v = await victim.signup("korban_x");
  const sv = await victim.socket();
  assert.equal((await attacker.del(`/api/contacts/${v.me.id}`)).status, 200);
  await assert.rejects(sv.next("contacts_changed", 500), /timeout/);
  sv.close();
  await app.close();
});

test("regresi red-team #3: ID pesan orang lain tidak bisa diintip", async () => {
  const { app, base, alice, a, b, ka, kb } = await connectedPair();
  const sa = await alice.socket();
  const real = await sealed(a, ka, b, kb.publicKey, "rahasia");
  sa.send(real);
  await sa.next("ack");
  const eve = new Client(base);
  await eve.signup("eve_pengintip");
  const ke = await generateIdentity();
  await eve.put("/api/me/key", { publicKey: ke.publicKey });
  const se = await eve.socket();
  const eveId = (await eve.get("/api/me")).body.me.id;
  se.send({ ...(await sealed({ id: eveId }, ke, b, kb.publicKey, "x")), id: real.id }); // ID yang ADA
  const existing = await se.next("rejected");
  se.send(await sealed({ id: eveId }, ke, b, kb.publicKey, "y")); // ID acak
  const random = await se.next("rejected");
  assert.equal(existing.code, random.code);
  assert.equal(existing.code, "not_contacts");
  sa.close();
  se.close();
  await app.close();
});

test("hardening: kunci publik low-order ditolak server", async () => {
  const { app, base } = await startApp();
  const c = new Client(base);
  await c.signup("kunci_jahat");
  const lowOrder = new Uint8Array(32);
  lowOrder[0] = 1; // u = 1 → titik berorde 4, rahasia bersama selalu nol
  const r = await c.put("/api/me/key", { publicKey: Buffer.from(lowOrder).toString("base64") });
  assert.equal(r.status, 400);
  assert.equal((await c.put("/api/me/key", { publicKey: (await generateIdentity()).publicKey })).status, 200);
  await app.close();
});

test("input rusak tidak menjatuhkan server", async () => {
  const { app, base, alice } = await connectedPair();
  assert.equal((await alice.req("POST", "/api/contacts/invite", undefined, { "content-type": "application/json" })).status, 400);
  const raw = await fetch(base + "/api/auth/login", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: "{bukan json" });
  assert.equal(raw.status, 400);
  const huge = await fetch(base + "/api/auth/login", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: "x".repeat(40_000) });
  assert.equal(huge.status, 413);
  const sa = await alice.socket();
  sa.send({ t: "send", id: "bukan-uuid" });
  assert.equal((await sa.next("rejected")).code, "bad_id");
  sa.send({ t: "send", id: crypto.randomUUID(), to: "x", fromKey: 1, toKey: null, nonce: "", ciphertext: "<script>", ping: "ya" });
  assert.equal((await sa.next("rejected")).code, "bad_message");
  sa.send({ t: "apa-ini" });
  assert.equal((await alice.get("/api/me")).status, 200);
  sa.close();
  await app.close();
});
