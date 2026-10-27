import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.ts";
import { Client } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;

async function boot() {
  const app = createApp({ dbPath: ":memory:" });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { app, base };
}

test("retensi 30 hari: pesan belum terkirim ditandai expired, pengirim diberi tahu sekali, lalu dihapus", async () => {
  const { app, base } = await boot();
  try {
    const alice = new Client(base);
    const bob = new Client(base);
    const a = await alice.signup("alice_r");
    const b = await bob.signup("bob_r");
    // Terhubung sebagai kontak, supaya GET /api/messages bisa dipakai untuk memeriksa hasilnya.
    await alice.post("/api/contacts/invite", { pin: b.me.pin });
    const inc = (await bob.get("/api/contacts")).body.incoming;
    await bob.post(`/api/contacts/requests/${inc[0].id}/accept`);

    const now = Date.now();
    const ins = app.db.prepare(
      "INSERT INTO messages (id, sender_id, recipient_id, sender_key, recipient_key, nonce, ciphertext, ping, created_at, delivered_at) VALUES (?, ?, ?, 'k', 'k', 'n', 'c', 0, ?, ?)",
    );
    const batas = crypto.randomUUID(); // tepat 30 hari → sudah lewat batas (<=)
    const segar = crypto.randomUUID(); // 29 hari → belum lewat
    const terkirim = crypto.randomUUID(); // 31 hari tapi sudah terkirim → hanya metadata, dihapus tanpa notifikasi
    ins.run(batas, a.me.id, b.me.id, now - 30 * DAY, null);
    ins.run(segar, a.me.id, b.me.id, now - 29 * DAY, null);
    ins.run(terkirim, a.me.id, b.me.id, now - 31 * DAY, now - 31 * DAY);

    const aliceSock = await alice.socket();

    // Sapuan pertama: hanya pesan belum terkirim yang lewat 30 hari yang ditandai.
    assert.deepEqual(app.runRetention(now), { removed: 0, expired: 1 });
    const ev = await aliceSock.next("expired");
    assert.deepEqual(ev.ids, [batas], "pengirim diberi tahu tepat satu pesan");

    const row = app.db.prepare("SELECT expired_at, ciphertext, nonce FROM messages WHERE id = ?").get(batas) as Record<string, unknown>;
    assert.equal(row.expired_at, now, "pesan ditandai expired");
    assert.equal(row.ciphertext, "", "isi terenkripsi dikosongkan saat ditandai");
    assert.equal(row.nonce, "");
    assert.equal(app.db.prepare("SELECT id FROM messages WHERE id = ?").get(terkirim), undefined, "metadata terkirim yang lewat 30 hari dihapus");
    assert.equal((app.db.prepare("SELECT expired_at FROM messages WHERE id = ?").get(segar) as Record<string, unknown>).expired_at, null, "29 hari belum kedaluwarsa");

    // Penerima tidak lagi menerima pesan expired lewat GET pending; pengirim melihat statusnya.
    const pendingBob = (await bob.get(`/api/messages/${a.me.id}`)).body.pending as { id: string }[];
    assert.deepEqual(pendingBob.map((m) => m.id), [segar]);
    const statuses = (await alice.get(`/api/messages/${b.me.id}`)).body.statuses as { id: string; expired: boolean }[];
    assert.equal(statuses.find((s) => s.id === batas)?.expired, true);
    assert.equal(statuses.find((s) => s.id === segar)?.expired, false);

    // Sapuan kedua: pesan expired dihapus permanen, dan pengirim TIDAK diberi tahu untuk kedua kalinya.
    assert.deepEqual(app.runRetention(now), { removed: 1, expired: 0 });
    await assert.rejects(aliceSock.next("expired", 300), /timeout/);
    assert.equal(app.db.prepare("SELECT id FROM messages WHERE id = ?").get(batas), undefined, "pesan expired sudah dihapus");
    assert.ok(app.db.prepare("SELECT id FROM messages WHERE id = ?").get(segar), "pesan 29 hari masih ada");
  } finally {
    await app.close();
  }
});
