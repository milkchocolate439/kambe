import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.ts";
import { openSnapshot, restoreSnapshot, sealSnapshot, snapshotKey, Snapshotter, type SnapshotStore } from "../server/snapshot.ts";
import { Client } from "./helpers.ts";

const SECRET = "rahasia-snapshot-yang-panjang-sekali-1234567890";

function memoryStore() {
  const saved: Buffer[] = [];
  const store: SnapshotStore = {
    load: async () => saved.at(-1) ?? null,
    save: async (blob) => void saved.push(blob),
  };
  return { store, saved };
}

async function startOn(dbPath: string) {
  const app = createApp({ dbPath });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  return { app, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

test("segel snapshot: bolak-balik utuh; kunci salah / blob diubah / bukan snapshot ditolak; kunci pendek ditolak", () => {
  const key = snapshotKey(SECRET);
  const raw = Buffer.from("isi database contoh ".repeat(100));
  const blob = sealSnapshot(key, raw);
  assert.deepEqual(openSnapshot(key, blob), raw);
  assert.ok(!blob.includes(Buffer.from("isi database")), "blob tidak memuat teks polos");
  assert.throws(() => openSnapshot(snapshotKey(SECRET + "x"), blob));
  const bad = Buffer.from(blob);
  bad[bad.length - 1] ^= 1;
  assert.throws(() => openSnapshot(key, bad));
  assert.throws(() => openSnapshot(key, Buffer.from("bukan apa-apa")), /bukan snapshot/);
  assert.throws(() => snapshotKey("pendek"), /minimal 32/);
});

test("snapshot → pulihkan ke server baru (disk kosong): akun tetap ada & bisa masuk; hanya dikirim bila berubah", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kambe-snap-"));
  const key = snapshotKey(SECRET);
  const { store, saved } = memoryStore();
  try {
    const a = await startOn(join(dir, "a.db"));
    const snap = new Snapshotter({ db: a.app.db, store, key });
    const c = new Client(a.base);
    await c.signup("Arwah_Snapshot");
    assert.equal(await snap.snapshotNow(), "saved");
    assert.equal(await snap.snapshotNow(), "unchanged", "tanpa perubahan = tidak dikirim lagi");
    await c.post("/api/me/pin/rotate");
    assert.equal(await snap.snapshotNow(), "saved", "ada perubahan = dikirim");
    assert.equal(saved.length, 2);
    assert.ok(!saved.at(-1)!.includes(Buffer.from("Arwah_Snapshot")), "alias tidak terlihat di penyimpanan luar");
    await a.app.close();

    // Server baru di "disk kosong" (meniru hosting gratis setelah restart).
    const freshPath = join(dir, "fresh", "kambe.db");
    assert.equal(await restoreSnapshot(store, key, freshPath), "restored");
    const b = await startOn(freshPath);
    const again = new Client(b.base);
    const login = await again.post("/api/auth/login", { alias: "Arwah_Snapshot", passphrase: "kunci-uji-yang-panjang-sekali" });
    assert.equal(login.status, 200, "akun hasil pemulihan bisa masuk");
    await b.app.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pemulihan tidak menimpa database lokal yang sudah ada; penyimpanan kosong = mulai baru", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kambe-snap-"));
  const key = snapshotKey(SECRET);
  try {
    const { store } = memoryStore();
    assert.equal(await restoreSnapshot(store, key, join(dir, "baru.db")), "empty");
    const local = join(dir, "lokal.db");
    writeFileSync(local, "data lokal");
    await store.save(sealSnapshot(key, Buffer.from("snapshot lama")), { sha256: "x", size: 1, at: 1 });
    assert.equal(await restoreSnapshot(store, key, local), "local_exists");
    assert.ok(existsSync(local));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot bersamaan digabung jadi satu; galat penyimpanan tidak menandai sebagai terkirim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kambe-snap-"));
  const key = snapshotKey(SECRET);
  let calls = 0;
  let fail = true;
  const store: SnapshotStore = {
    load: async () => null,
    save: async () => {
      calls++;
      if (fail) throw new Error("jaringan putus");
    },
  };
  try {
    const a = await startOn(join(dir, "c.db"));
    const snap = new Snapshotter({ db: a.app.db, store, key });
    await assert.rejects(snap.snapshotNow(), /jaringan putus/);
    fail = false;
    const [x, y] = await Promise.all([snap.snapshotNow(), snap.snapshotNow()]);
    assert.equal(x, "saved");
    assert.equal(y, "saved", "panggilan kedua menunggu hasil yang sama");
    assert.equal(calls, 2, "gagal sekali + satu kirim gabungan");
    await a.app.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
