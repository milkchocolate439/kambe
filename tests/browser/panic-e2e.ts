// Uji browser: Panic Wipe.
//  - lepas sebelum 2 detik = tidak terjadi apa-apa
//  - tahan 2 detik = IndexedDB, localStorage, cache terhapus; sesi server dicabut; layar masuk + pemberitahuan
//  - setelah wipe, data lama tidak bisa dibuka (tanpa frasa kunci)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const PORT = 3315;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(import.meta.dirname, "out");
const PASS = "kopi-hujan-rotan-senja";
let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "✔" : "✖"} ${label}`);
  if (!cond) failures++;
};

async function signup(page: Page, alias: string) {
  await page.goto(BASE);
  await page.getByRole("tab", { name: "Daftar" }).click();
  await page.getByLabel("Alias (nama samaran)").fill(alias);
  await page.locator("#pass").fill(PASS);
  await page.locator("#pass2").fill(PASS);
  await page.getByRole("button", { name: "Buat akun" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Lanjut ke KAMBE" }).click();
  await page.getByText("Simpan frasa kunci perangkat").waitFor();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Frasa kunci sudah kusimpan" }).click();
  await page.locator(".dot.online").waitFor();
}

const idbNames = (page: Page) =>
  page.evaluate(async () => ((indexedDB as unknown as { databases?: () => Promise<{ name?: string }[]> }).databases?.() ?? Promise.resolve([])).then((d) => d.map((x) => x.name)));

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), "kambe-panic-"));
  const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, NODE_ENV: "production", PINPATH_PAYMENT_PROVIDER: "xendit", XENDIT_SECRET_KEY: "xnd_development_verify_only", XENDIT_CALLBACK_TOKEN: "verify-only", PINPATH_PUBLIC_URL: BASE, PORT: String(PORT), PINPATH_DB: join(dataDir, "p.db") },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let browser: Browser | null = null;
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(BASE)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    await signup(page, "Panik_Ayu");
    await page.evaluate(() => localStorage.setItem("jejak-uji", "ada"));
    check((await idbNames(page)).includes("pinpath"), "IndexedDB brankas ada sebelum wipe");

    await page.getByRole("button", { name: "Pengaturan" }).click();
    const btn = page.getByRole("button", { name: /Panic Wipe/ });
    await btn.scrollIntoViewIfNeeded();
    const box = (await btn.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Lepas lebih cepat dari 2 detik → tidak terjadi apa-apa.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await page.waitForTimeout(1600);
    check((await idbNames(page)).includes("pinpath") && (await page.evaluate(() => localStorage.getItem("jejak-uji"))) === "ada", "lepas sebelum 2 detik: tidak ada yang dihapus");
    check((await page.locator(".dot.online").count()) > 0, "lepas sebelum 2 detik: tetap masuk");

    // Tahan penuh → wipe.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.getByText("Semua jejak KAMBE di perangkat ini sudah dihapus.").waitFor({ timeout: 8000 });
    await page.mouse.up();
    check(true, "tahan 2 detik: layar masuk dengan pemberitahuan wipe");
    // Setelah reload aplikasi membuka ulang database KOSONG (skema baru); yang penting tidak ada satu rekaman pun.
    const rows = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res) => { const r = indexedDB.open("pinpath"); r.onsuccess = () => res(r.result); });
      let n = 0;
      for (const name of [...db.objectStoreNames]) n += await new Promise<number>((res) => { const r = db.transaction(name).objectStore(name).count(); r.onsuccess = () => res(r.result); });
      db.close();
      return n;
    });
    check(rows === 0, `IndexedDB 'pinpath' tanpa satu rekaman pun (${rows})`);
    check((await page.evaluate(() => localStorage.length)) === 0, "localStorage kosong");
    // Service worker boleh mendaftar ulang cache cangkang setelah reload; yang tidak boleh: data API/pengguna.
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) urls.push(new URL(r.url).pathname);
      return urls;
    });
    check(!cached.some((u) => u.startsWith("/api/")), `cache tanpa data API (${cached.length} berkas cangkang)`);
    check(!page.url().includes("#"), "penanda wipe dibersihkan dari URL");
    const me = await page.evaluate(() => fetch("/api/me").then((r) => r.status));
    check(me === 401, "sesi server dicabut (/api/me = 401)");
    await page.screenshot({ path: join(OUT, "p1-wiped.png") });
  } catch (e) {
    failures++;
    console.error("✖ skenario terhenti:", e);
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} pemeriksaan GAGAL` : "\nSemua pemeriksaan Panic Wipe LULUS");
    process.exit(failures ? 1 : 0);
  }
}

void main();
