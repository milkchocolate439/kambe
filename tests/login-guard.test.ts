import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.ts";
import { FailureBackoff } from "../server/security.ts";
import { Client, TEST_PASSPHRASE } from "./helpers.ts";

/** App dengan jeda per alias yang kecil agar tes cepat. trustProxy=true supaya tiap tes bisa memakai "IP" sendiri. */
async function boot(loginBackoff = { baseMs: 400, maxMs: 1000 }) {
  const app = createApp({ dbPath: ":memory:", trustProxy: true, loginBackoff });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { app, base };
}

function login(c: Client, alias: string, passphrase: string, ip: string) {
  return c.req("POST", "/api/auth/login", { alias, passphrase }, { "x-forwarded-for": ip });
}

test("9 percobaan gagal dari IP yang sama tetap diblokir (meski alias-nya berbeda-beda)", async () => {
  const { app, base } = await boot();
  try {
    await new Client(base).signup("korban_satu");
    const penyerang = new Client(base);
    for (let i = 0; i < 8; i++) {
      const r = await login(penyerang, `tebak_${i}`, "salah-salah-salah", "10.0.0.1");
      assert.equal(r.status, 401, `percobaan ${i + 1} harus gagal biasa`);
    }
    const blocked = await login(penyerang, "tebak_8", "salah-salah-salah", "10.0.0.1");
    assert.equal(blocked.status, 429, "percobaan ke-9 dari IP yang sama harus diblokir");
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1, "Retry-After harus ada");
    // Sandi yang benar pun ditolak dari IP yang sedang diblokir.
    assert.equal((await login(penyerang, "korban_satu", TEST_PASSPHRASE, "10.0.0.1")).status, 429);
    // IP lain tidak ikut terblokir oleh batas IP ini.
    assert.equal((await login(new Client(base), "korban_satu", TEST_PASSPHRASE, "10.0.0.2")).status, 200);
  } finally {
    await app.close();
  }
});

test("respons gagal identik untuk alias yang ada dan yang tidak ada (tidak membocorkan keberadaan akun)", async () => {
  const { app, base } = await boot();
  try {
    await new Client(base).signup("korban_dua");
    const adaAkun = await login(new Client(base), "korban_dua", "salah-salah-salah", "10.0.1.1");
    const tanpaAkun = await login(new Client(base), "tidak_ada_xx", "salah-salah-salah", "10.0.1.2");
    assert.equal(adaAkun.status, 401);
    assert.equal(tanpaAkun.status, 401);
    assert.deepEqual(adaAkun.body, tanpaAkun.body);
  } finally {
    await app.close();
  }
});

test("akun tidak terkunci permanen: jeda per alias berakhir, sandi benar diterima lagi", async () => {
  const { app, base } = await boot({ baseMs: 400, maxMs: 1000 });
  try {
    await new Client(base).signup("korban_tiga");
    // Penebakan terdistribusi: tiap percobaan dari IP berbeda, sehingga batas per IP tidak relevan.
    for (let i = 0; i < 5; i++) {
      assert.equal((await login(new Client(base), "korban_tiga", "salah-salah-salah", `10.0.2.${i + 1}`)).status, 401);
    }
    // Selama jeda, sandi benar pun menunggu (jeda ini per alias, dan memang menahan penebakan).
    assert.equal((await login(new Client(base), "korban_tiga", TEST_PASSPHRASE, "10.0.3.1")).status, 429);
    // Setelah jeda singkat, login benar berhasil lagi.
    await new Promise((r) => setTimeout(r, 450));
    const benar = await login(new Client(base), "korban_tiga", TEST_PASSPHRASE, "10.0.3.2");
    assert.equal(benar.status, 200);
    // Login berhasil mengatur ulang hitungan: satu kegagalan berikutnya tidak lagi memicu jeda.
    assert.equal((await login(new Client(base), "korban_tiga", "salah-salah-salah", "10.0.3.3")).status, 401);
  } finally {
    await app.close();
  }
});

test("FailureBackoff: 4 kegagalan pertama bebas, jeda naik 2x lipat sampai batas, lalu reset", () => {
  const b = new FailureBackoff({ freeFails: 4, baseMs: 1000, maxMs: 4000, forgetMs: 60_000 });
  const k = "alias";
  const t = 0;
  for (let i = 0; i < 4; i++) {
    b.fail(k, t);
    assert.equal(b.waitMs(k, t), 0);
  }
  b.fail(k, t);
  assert.equal(b.waitMs(k, t), 1000, "kegagalan ke-5: jeda 1 dtk");
  b.fail(k, t);
  assert.equal(b.waitMs(k, t), 2000, "ke-6: 2 dtk");
  b.fail(k, t);
  assert.equal(b.waitMs(k, t), 4000, "ke-7: 4 dtk");
  b.fail(k, t);
  assert.equal(b.waitMs(k, t), 4000, "ke-8: tetap dibatasi maxMs");
  assert.equal(b.waitMs(k, t + 3999), 1);
  assert.equal(b.waitMs(k, t + 4000), 0, "jeda habis: boleh mencoba lagi (bukan kunci permanen)");
  b.success(k);
  assert.equal(b.waitMs(k, t), 0, "login berhasil mereset hitungan");
  b.fail(k, t);
  b.fail(k, t + 61_000); // lewat forgetMs tanpa kegagalan → hitungan mulai dari awal
  assert.equal(b.waitMs(k, t + 61_000), 0);
});
