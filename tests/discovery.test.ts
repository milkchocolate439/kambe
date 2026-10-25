import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, startApp } from "./helpers.ts";
import { PIN_ALPHABET } from "../shared/pin.ts";

async function pair() {
  const env = await startApp();
  const owner = new Client(env.base);
  const stranger = new Client(env.base);
  const o = await owner.signup("Penjual_Rotan");
  const s = await stranger.signup("Orang_Asing");
  return { ...env, owner, stranger, o: o.me, s: s.me };
}

test("Shadow PIN: orang asing terhubung TANPA pernah melihat PIN utama", async () => {
  const { app, owner, stranger, o } = await pair();
  const shadow = (await owner.post("/api/shadow-pins", { label: "Pasar Sabtu" })).body;
  assert.match(shadow.pin, /^[2-9A-HJ-NP-Z]{6}$/);
  assert.notEqual(shadow.pin, o.pin);
  assert.ok(shadow.expiresAt - shadow.createdAt === 24 * 3600_000);

  assert.equal((await stranger.post("/api/contacts/invite", { pin: shadow.pin, note: "Mau beli rotan" })).body.status, "pending");
  const out = (await stranger.get("/api/contacts")).body;
  assert.equal(out.outgoing[0].pin, shadow.pin, "pengundang melihat PIN yang ia ketik");
  const inc = (await owner.get("/api/contacts")).body.incoming[0];
  assert.deepEqual(inc.via, { pin: shadow.pin, kind: "shadow", label: "Pasar Sabtu" });

  await owner.post(`/api/contacts/requests/${inc.id}/accept`);
  const after = (await stranger.get("/api/contacts")).body;
  assert.equal(after.contacts[0].pin, shadow.pin);
  assert.ok(!JSON.stringify(after).includes(o.pin), "PIN utama tidak pernah muncul di respons pengundang");
  await app.close();
});

test("Shadow PIN: maksimal 3 aktif, bisa dicabut, kedaluwarsa = mati, undangan tertunda ikut hangus", async () => {
  const { app, base, owner, stranger } = await pair();
  const pins = [];
  for (let i = 0; i < 3; i++) pins.push((await owner.post("/api/shadow-pins", {})).body.pin);
  assert.equal((await owner.post("/api/shadow-pins", {})).status, 409);
  assert.equal(new Set(pins).size, 3);

  await stranger.post("/api/contacts/invite", { pin: pins[0] });
  assert.equal((await owner.get("/api/contacts")).body.incoming.length, 1);
  assert.equal((await stranger.del(`/api/shadow-pins/${pins[1]}`)).status, 404, "tidak bisa mencabut milik orang lain");
  assert.equal((await owner.del(`/api/shadow-pins/${pins[0]}`)).status, 200);
  assert.equal((await owner.get("/api/contacts")).body.incoming.length, 0, "undangan lewat PIN yang dicabut ikut hangus");
  const late = new Client(base);
  await late.signup("Telat_Datang");
  assert.equal((await late.post("/api/contacts/invite", { pin: pins[0] })).status, 404);

  app.db.prepare("UPDATE shadow_pins SET expires_at = ? WHERE pin = ?").run(Date.now() - 1, pins[1]);
  assert.equal((await late.post("/api/contacts/invite", { pin: pins[1] })).status, 404, "Shadow PIN kedaluwarsa tidak bisa dipakai");
  assert.equal((await owner.get("/api/shadow-pins")).body.pins.length, 1);
  assert.equal((await owner.post("/api/shadow-pins", {})).status, 200, "slot kembali setelah ada yang kedaluwarsa");
  await app.close();
});

test("regresi audit Fase 3 #3: kontak via Shadow PIN tidak bisa memastikan tebakan PIN utama", async () => {
  const { app, owner, stranger, o } = await pair();
  const shadow = (await owner.post("/api/shadow-pins", {})).body;
  await stranger.post("/api/contacts/invite", { pin: shadow.pin });
  await owner.post(`/api/contacts/requests/${(await owner.get("/api/contacts")).body.incoming[0].id}/accept`);
  const wrong = await stranger.post("/api/contacts/invite", { pin: "ZZZZZZ" });
  const right = await stranger.post("/api/contacts/invite", { pin: o.pin });
  assert.equal(right.status, wrong.status, "tebakan benar & salah harus tak bisa dibedakan");
  assert.equal(right.body.message, wrong.body.message);
  assert.equal((await stranger.post("/api/contacts/invite", { pin: shadow.pin })).body.error, "already_contacts", "PIN yang memang ia pakai tetap dijawab jujur");
  await app.close();
});

test("PIN dinamis: PIN sekali pakai hangus setelah satu undangan", async () => {
  const { app, base, owner, stranger, o } = await pair();
  const once = (await owner.post("/api/shadow-pins", { once: true, label: "Pembeli COD" })).body;
  assert.equal(once.kind, "once");
  assert.equal((await stranger.post("/api/contacts/invite", { pin: once.pin })).body.status, "pending");
  const inc = (await owner.get("/api/contacts")).body.incoming[0];
  assert.equal(inc.via.kind, "once", "jenis PIN tetap tercatat walau PIN-nya sudah hangus");
  const second = new Client(base);
  await second.signup("Penumpang_Gelap");
  assert.equal((await second.post("/api/contacts/invite", { pin: once.pin })).status, 404, "PIN sekali pakai tidak bisa dipakai orang kedua");
  assert.equal((await owner.get("/api/shadow-pins")).body.pins.filter((p: { kind: string }) => p.kind === "once").length, 0);
  await owner.post(`/api/contacts/requests/${inc.id}/accept`);
  const seen = (await stranger.get("/api/contacts")).body;
  assert.equal(seen.contacts[0].pin, once.pin);
  assert.ok(!JSON.stringify(seen).includes(o.pin), "PIN utama tidak terlihat");
  for (let i = 0; i < 5; i++) await owner.post("/api/shadow-pins", { once: true });
  assert.equal((await owner.post("/api/shadow-pins", { once: true })).status, 409, "maks 5 PIN sekali pakai aktif");
  await app.close();
});

test("PIN dinamis: PIN yang pernah dipakai terhubung tidak didaur ulang ke orang lain", async () => {
  const { app, owner, stranger } = await pair();
  const once = (await owner.post("/api/shadow-pins", { once: true })).body;
  await stranger.post("/api/contacts/invite", { pin: once.pin });
  assert.equal(app.db.prepare("SELECT 1 FROM shadow_pins WHERE pin = ?").get(once.pin), undefined, "PIN sudah hangus");

  // Paksa generator acak mengeluarkan PIN yang sudah hangus itu lebih dulu: server WAJIB menolaknya
  // (masih dirujuk undangan) dan memilih PIN lain.
  const forced = [...once.pin].map((c) => PIN_ALPHABET.indexOf(c));
  const original = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  let served = false;
  globalThis.crypto.getRandomValues = (<T extends ArrayBufferView | null>(arr: T): T => {
    if (!served && arr instanceof Uint8Array && arr.length === forced.length) {
      served = true;
      arr.set(forced);
      return arr;
    }
    return original(arr as never) as T;
  }) as typeof globalThis.crypto.getRandomValues;
  try {
    const fresh = (await owner.post("/api/shadow-pins", {})).body.pin;
    assert.equal(served, true, "generator benar-benar mencoba PIN lama dulu");
    assert.notEqual(fresh, once.pin, "PIN yang pernah dipakai terhubung tidak diberikan lagi");
  } finally {
    globalThis.crypto.getRandomValues = original;
  }
  await app.close();
});

test("PIN dinamis: rotasi PIN utama otomatis tanpa memutus kontak", async () => {
  const { app, owner, stranger, o } = await pair();
  await stranger.post("/api/contacts/invite", { pin: o.pin });
  await owner.post(`/api/contacts/requests/${(await owner.get("/api/contacts")).body.incoming[0].id}/accept`);
  assert.equal((await owner.patch("/api/me/settings", { pinRotateDays: 3 })).status, 400);
  const me = (await owner.patch("/api/me/settings", { pinRotateDays: 7 })).body.me;
  assert.equal(me.pinRotateDays, 7);
  assert.equal(app.runPinRotation(me.pinRotatedAt + 6 * 86_400_000), 0, "belum waktunya");
  assert.equal(app.runPinRotation(me.pinRotatedAt + 7 * 86_400_000 + 1), 1);
  const after = (await owner.get("/api/me")).body.me;
  assert.notEqual(after.pin, o.pin);
  assert.equal((await stranger.get("/api/contacts")).body.contacts.length, 1, "kontak tetap terhubung");
  const late = new Client(owner.base);
  await late.signup("Penyimpan_PIN_Lama");
  assert.equal((await late.post("/api/contacts/invite", { pin: o.pin })).status, 404, "PIN lama sudah tidak berlaku");
  await owner.patch("/api/me/settings", { pinRotateDays: 0 });
  assert.equal(app.runPinRotation(Date.now() + 365 * 86_400_000), 0, "rotasi mati = PIN tetap");
  await app.close();
});

test("ganti PIN utama tidak menghapus undangan yang datang lewat Shadow PIN", async () => {
  const { app, owner, stranger } = await pair();
  const shadow = (await owner.post("/api/shadow-pins", {})).body;
  await stranger.post("/api/contacts/invite", { pin: shadow.pin });
  await owner.post("/api/me/pin/rotate");
  assert.equal((await owner.get("/api/contacts")).body.incoming.length, 1);
  await app.close();
});

test("radar: default mati, resiprokal, dan memakai PIN radar khusus (bukan PIN utama)", async () => {
  const { app, base, owner, stranger, o, s } = await pair();
  assert.equal((await owner.get("/api/radar")).status, 403, "belum ikut radar → tidak bisa mengintip");
  assert.equal((await owner.get("/api/radar/me")).body.radar, null);
  assert.equal((await owner.put("/api/radar", { sector: "Sektor Palsu", headline: "Jual rotan mentah 2 ton" })).status, 400);
  assert.equal((await owner.put("/api/radar", { sector: "Komoditas & Pangan", headline: "pendek" })).status, 400);

  const mine = (await owner.put("/api/radar", { sector: "Komoditas & Pangan", headline: "Jual rotan mentah Katingan 2 ton" })).body.radar;
  assert.notEqual(mine.pin, o.pin);
  await stranger.put("/api/radar", { sector: "Logistik & B2B", headline: "Cari muatan balik Palangka Raya" });

  const view = (await stranger.get("/api/radar")).body;
  assert.equal(view.entries.length, 1);
  assert.equal(view.entries[0].alias, "Penjual_Rotan");
  assert.equal(view.entries[0].pin, mine.pin);
  const raw = JSON.stringify(view);
  assert.ok(!raw.includes(o.pin) && !raw.includes(o.id), "radar tidak membocorkan PIN utama maupun id internal");
  assert.equal((await stranger.get("/api/radar?sector=Logistik%20%26%20B2B")).body.entries.length, 0, "filter sektor bekerja");

  // Terhubung lewat radar → terlihat sebagai undangan via radar; pengundang hanya kenal PIN radar.
  await stranger.post("/api/contacts/invite", { pin: mine.pin });
  const inc = (await owner.get("/api/contacts")).body.incoming[0];
  assert.equal(inc.via.kind, "radar");
  await owner.post(`/api/contacts/requests/${inc.id}/accept`);
  assert.equal((await stranger.get("/api/contacts")).body.contacts[0].pin, mine.pin);
  assert.equal((await stranger.get("/api/radar")).body.entries.length, 0, "yang sudah jadi kontak tidak tampil lagi di radar");

  // Perpanjang radar memakai PIN radar yang sama.
  const renewed = (await owner.put("/api/radar", { sector: "Komoditas & Pangan", headline: "Rotan Katingan, stok baru 3 ton" })).body.radar;
  assert.equal(renewed.pin, mine.pin);
  void s;
  void base;
  await app.close();
});

test("radar: pengguna yang diblokir tidak saling melihat; keluar radar mematikan PIN radar", async () => {
  const { app, base, owner, stranger, s } = await pair();
  const mine = (await owner.put("/api/radar", { sector: "Lainnya", headline: "Jasa angkut sungai Kahayan" })).body.radar;
  await stranger.put("/api/radar", { sector: "Lainnya", headline: "Butuh angkutan sungai mingguan" });
  await owner.post("/api/blocks", { userId: s.id });
  assert.equal((await stranger.get("/api/radar")).body.entries.length, 0);
  assert.equal((await owner.get("/api/radar")).body.entries.length, 0);

  await owner.del("/api/radar");
  const third = new Client(base);
  await third.signup("Pihak_Ketiga");
  assert.equal((await third.post("/api/contacts/invite", { pin: mine.pin })).status, 404, "PIN radar mati setelah keluar radar");
  await app.close();
});

test("radar kedaluwarsa otomatis hilang dari daftar", async () => {
  const { app, owner, stranger } = await pair();
  await owner.put("/api/radar", { sector: "Lainnya", headline: "Jasa angkut sungai Kahayan" });
  await stranger.put("/api/radar", { sector: "Lainnya", headline: "Butuh angkutan sungai mingguan" });
  app.db.prepare("UPDATE radar_entries SET expires_at = ? WHERE headline LIKE 'Jasa%'").run(Date.now() - 1);
  assert.equal((await stranger.get("/api/radar")).body.entries.length, 0);
  assert.equal((await owner.get("/api/radar")).status, 403, "peserta yang kedaluwarsa harus ikut lagi");
  await app.close();
});
