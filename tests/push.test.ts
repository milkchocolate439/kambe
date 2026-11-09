import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.ts";
import { vapidFromSeed, type PushSender } from "../server/push.ts";
import { Client } from "./helpers.ts";
import { deriveConversationKey, encryptPayload, type Envelope, type Identity } from "../shared/e2ee.ts";

const ENDPOINT = "https://push.example.test/sub/abc123456789";

async function world() {
  const sent: { endpoint: string; payload: Record<string, string> }[] = [];
  let failWith: number | null = null;
  const sender: PushSender = async (sub, payload) => {
    if (failWith) throw Object.assign(new Error("gone"), { statusCode: failWith });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  };
  const app = createApp({ dbPath: ":memory:", pushSender: sender, vapid: vapidFromSeed("seed-uji-push-yang-panjang-sekali-1234567890") });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const alice = new Client(base);
  const bob = new Client(base);
  const a = await alice.signup("Alice_Push");
  const b = await bob.signup("Bob_Push");
  await alice.post("/api/contacts/invite", { pin: b.me.pin });
  await bob.post(`/api/contacts/requests/${(await bob.get("/api/contacts")).body.incoming[0].id}/accept`);
  return { app, base, alice, bob, a: a.me, b: b.me, sent, fail: (c: number | null) => (failWith = c) };
}

async function msg(me: { id: string }, key: Identity, peer: { id: string }, peerPub: string, extra: Record<string, unknown> = {}) {
  const env: Envelope = { id: crypto.randomUUID(), from: { id: me.id, publicKey: key.publicKey }, to: { id: peer.id, publicKey: peerPub } };
  const box = await encryptPayload(await deriveConversationKey(key.privateKey, env.from, env.to), env, { kind: "text", text: "rahasia" });
  return { t: "send", id: env.id, to: peer.id, fromKey: key.publicKey, toKey: peerPub, ...box, ping: false, ...extra };
}

test("VAPID dari seed: deterministik & kunci publik P-256 sah (65 byte)", () => {
  const a = vapidFromSeed("seed-uji-push-yang-panjang-sekali-1234567890");
  const b = vapidFromSeed("seed-uji-push-yang-panjang-sekali-1234567890");
  assert.deepEqual(a, b);
  assert.equal(Buffer.from(a.publicKey, "base64url").length, 65);
  assert.equal(Buffer.from(a.privateKey, "base64url").length, 32);
  assert.notEqual(vapidFromSeed("seed-lain-yang-juga-panjang-1234567890").publicKey, a.publicKey);
});

test("langganan push: kunci publik tersedia, validasi endpoint, hapus langganan", async () => {
  const { app, base, bob } = await world();
  const key = await fetch(base + "/api/push/key").then((r) => r.json());
  assert.equal(Buffer.from(key.publicKey, "base64url").length, 65);
  assert.equal((await bob.post("/api/push/subscribe", { endpoint: "http://tidak-aman.example/x", keys: { p256dh: "a", auth: "b" } })).status, 400, "endpoint harus https");
  assert.equal((await bob.post("/api/push/subscribe", { endpoint: ENDPOINT })).status, 400, "kunci wajib");
  assert.equal((await bob.post("/api/push/subscribe", { endpoint: ENDPOINT, keys: { p256dh: "BPk", auth: "x" } })).status, 200);
  assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM push_subs").get() as { n: number }).n, 1);
  assert.equal((await bob.req("DELETE", "/api/push/subscribe", { endpoint: ENDPOINT })).status, 200);
  assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM push_subs").get() as { n: number }).n, 0);
  assert.equal((await new Client(base).post("/api/push/subscribe", { endpoint: ENDPOINT, keys: { p256dh: "a", auth: "b" } })).status, 401);
  await app.close();
});

test("pesan ke penerima OFFLINE → popup 'SSSSSTTT!! Pesan baru dari {alias}' tanpa isi; online / pesan kendali / beruntun → tidak", async () => {
  const { app, alice, bob, a, b, sent, fail } = await world();
  await bob.post("/api/push/subscribe", { endpoint: ENDPOINT, keys: { p256dh: "BPk", auth: "x" } });
  const sa = await alice.socket();
  const bobPub = (await alice.get("/api/contacts")).body.contacts[0].publicKey as string;
  const wait = () => new Promise((r) => setTimeout(r, 150));

  // Pesan kendali (etalase/Buku Jejak) TIDAK memicu notifikasi — diuji sebelum ada push apa pun.
  sa.send(await msg(a, alice.key, b, bobPub, { quiet: true }));
  await sa.next("ack");
  await wait();
  assert.equal(sent.length, 0, "quiet = tanpa popup");

  sa.send(await msg(a, alice.key, b, bobPub));
  await sa.next("ack");
  await wait();
  assert.equal(sent.length, 1, "bob offline → satu popup");
  assert.equal(sent[0].payload.title, "SSSSSTTT!!");
  assert.equal(sent[0].payload.body, "Pesan baru dari Alice_Push");
  assert.ok(!JSON.stringify(sent[0].payload).includes("rahasia"), "isi pesan tidak pernah ikut");

  sa.send(await msg(a, alice.key, b, bobPub));
  await sa.next("ack");
  await wait();
  assert.equal(sent.length, 1, "pesan beruntun dalam 15 detik digabung (tidak spam)");

  // Bob online → aplikasi sendiri yang berbunyi; server tidak mengirim push.
  const sb = await bob.socket();
  const online = sent.length;
  await new Promise((r) => setTimeout(r, 15_100));
  sa.send(await msg(a, alice.key, b, bobPub));
  await sa.next("ack");
  await sb.next("message");
  await wait();
  assert.equal(sent.length, online, "penerima online → tanpa push");
  sb.ws.close();

  // Langganan mati (410) → dihapus otomatis.
  await new Promise((r) => setTimeout(r, 300));
  fail(410);
  await app.push.notify(b.id, { title: "t", body: "b", tag: "t", url: "/" }, "dead");
  assert.equal((app.db.prepare("SELECT COUNT(*) AS n FROM push_subs").get() as { n: number }).n, 0);
  sa.ws.close();
  await app.close();
});
