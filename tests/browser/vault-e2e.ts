// Uji browser Tahap 2: brankas perangkat & frasa kunci.
//  - riwayat, pin & alamat di IndexedDB terenkripsi (tidak ada teks polos di disk)
//  - keluar = kunci dihapus; masuk lagi dengan passphrase = riwayat terbuka kembali
//  - perangkat baru + frasa kunci = kunci publik SAMA (kontak tidak diperingatkan)
//  - cadangan terenkripsi: tanpa teks polos, bisa dipulihkan di perangkat baru
// Jalankan: pnpm build && pnpm test:browser
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const PORT = 3314;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(import.meta.dirname, "out");
const PASS = "kopi-hujan-rotan-senja";
const SECRET_MSG = "Kode brankas gudang: MERAPI-7781";
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
  const seed = (await page.getByLabel("Frasa kunci perangkat").textContent()) ?? "";
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Frasa kunci sudah kusimpan" }).click();
  await page.locator(".dot.online").waitFor();
  return { seed, pin: (await page.locator(".pin-big").first().textContent()) ?? "" };
}

async function login(page: Page, alias: string) {
  await page.getByLabel("Alias (nama samaran)").fill(alias);
  await page.locator("#pass").fill(PASS);
  await page.getByRole("button", { name: "Masuk" }).click();
}

/** Isi mentah IndexedDB "pinpath" (apa yang bisa dibaca orang yang memegang disk HP). */
function dumpIdb(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("pinpath");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const out: Record<string, unknown[]> = {};
    for (const name of [...db.objectStoreNames]) {
      out[name] = await new Promise<unknown[]>((res) => {
        const r = db.transaction(name).objectStore(name).getAll();
        r.onsuccess = () => res(r.result.map((v) => (v && typeof v === "object" && "privateKey" in v ? { ...v, privateKey: "[CryptoKey]" } : v)));
      });
    }
    db.close();
    return { stores: out, json: JSON.stringify(out), local: JSON.stringify({ ...localStorage }) };
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), "pinpath-vault-"));
  const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    // Mode produksi butuh penyedia xendit; skenario ini tidak membayar, jadi kunci palsu aman (sama seperti e2e.ts).
    env: { ...process.env, NODE_ENV: "production", PINPATH_PAYMENT_PROVIDER: "xendit", XENDIT_SECRET_KEY: "xnd_development_verify_only", XENDIT_CALLBACK_TOKEN: "verify-only", PINPATH_PUBLIC_URL: BASE, PORT: String(PORT), PINPATH_DB: join(dataDir, "v.db") },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let browser: Browser | null = null;
  const problems: string[] = [];
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(BASE)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
    const alice = await ctxA.newPage();
    const bob = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    const watch = (p: Page, n: string) => {
      p.on("console", (m) => m.type() === "error" && problems.push(`[${n}] ${m.text()}`));
      p.on("pageerror", (e) => problems.push(`[${n}] ${e.message}`));
    };
    watch(alice, "alice");
    watch(bob, "bob");

    const a = await signup(alice, "Brankas_Ayu");
    check(/^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/.test(a.seed), "frasa kunci 14 grup tampil saat daftar");
    await signup(bob, "Brankas_Bima");
    await bob.getByLabel("PIN tujuan").fill(a.pin);
    await bob.getByRole("button", { name: "Undang" }).click();
    await alice.getByRole("button", { name: "Terima" }).click();
    await bob.getByRole("button", { name: /Brankas_Ayu/ }).click();
    await bob.getByLabel("Tulis pesan").fill(SECRET_MSG);
    await bob.getByRole("button", { name: "Kirim" }).click();
    await alice.getByRole("button", { name: /Brankas_Bima/ }).click();
    await alice.getByText(SECRET_MSG).waitFor();

    const before = await dumpIdb(alice);
    check(!before.json.includes(SECRET_MSG) && !before.json.includes("MERAPI"), "riwayat chat di IndexedDB terenkripsi (tanpa teks polos)");
    const msgs = before.stores.messages as { ct?: string; text?: string }[];
    check(msgs.length > 0 && msgs.every((m) => typeof m.ct === "string" && m.text === undefined), `semua ${msgs.length} rekaman pesan berbentuk ciphertext`);
    const pins = before.stores.pins as { ct?: string; publicKey?: string }[];
    check(pins.length > 0 && pins.every((p) => typeof p.ct === "string" && p.publicKey === undefined), "pin kunci kontak terenkripsi");
    check(!before.json.includes(a.seed.replace(/-/g, "")) && !before.json.includes(a.seed), "frasa kunci tidak tersimpan polos di perangkat");
    check(!before.local.includes("pinpath:identity"), "tidak ada data rahasia di localStorage");
    check((before.stores.vault ?? []).length === 1 && (before.stores.unlocked ?? []).length === 1, "brankas berpassphrase + kunci terbuka ada saat masuk");

    // Cadangan terenkripsi.
    await alice.getByRole("button", { name: "Pengaturan" }).click();
    const [dl] = await Promise.all([alice.waitForEvent("download"), alice.getByRole("button", { name: "Unduh cadangan terenkripsi" }).click()]);
    check(/^kambe-cadangan-Brankas_Ayu-\d{4}-\d{2}-\d{2}\.kambe$/.test(dl.suggestedFilename()), `nama file cadangan bermerek KAMBE (${dl.suggestedFilename()})`);
    const backupPath = join(dataDir, "cadangan.kambe");
    await dl.saveAs(backupPath);
    const backupText = readFileSync(backupPath, "utf8");
    check(/"format":"pinpath-backup"/.test(backupText) && !backupText.includes("MERAPI") && !backupText.includes("Brankas_Bima"), "file cadangan hanya berisi ciphertext");

    // Lihat frasa kunci lagi: wajib passphrase.
    await alice.getByLabel("Passphrase untuk melihat frasa kunci").fill("passphrase-salah-sekali");
    await alice.getByRole("button", { name: "Lihat frasa kunci" }).click();
    await alice.getByText("Passphrase tidak cocok dengan brankas").waitFor();
    check(true, "passphrase salah tidak membuka frasa kunci");
    await alice.getByLabel("Passphrase untuk melihat frasa kunci").fill(PASS);
    await alice.getByRole("button", { name: "Lihat frasa kunci" }).click();
    check((await alice.getByLabel("Frasa kunci perangkat").textContent()) === a.seed, "frasa kunci bisa dilihat lagi dengan passphrase");

    // Keluar → kunci dihapus, data tetap terkunci di disk.
    await alice.getByRole("button", { name: "Keluar dari perangkat ini" }).click();
    await alice.getByText("Brankas di perangkat ini terkunci").waitFor();
    const locked = await dumpIdb(alice);
    check((locked.stores.unlocked ?? []).length === 0, "setelah keluar: tidak ada kunci terbuka di perangkat");
    check((locked.stores.messages ?? []).length === msgs.length && !locked.json.includes("MERAPI"), "setelah keluar: riwayat tetap ada, tetap terenkripsi");

    // Masuk lagi di perangkat yang sama → riwayat terbuka dengan passphrase saja.
    await login(alice, "Brankas_Ayu");
    await alice.getByRole("button", { name: /Brankas_Bima/ }).click();
    await alice.getByText(SECRET_MSG).waitFor();
    check(true, "masuk lagi dengan passphrase membuka riwayat lama");

    // HP baru + frasa kunci → kunci publik sama, kontak TIDAK diperingatkan.
    const alice2 = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    watch(alice2, "alice2");
    await alice2.goto(BASE);
    await login(alice2, "Brankas_Ayu");
    await alice2.getByText("Perangkat baru").waitFor();
    await alice2.getByLabel("Frasa kunci (14 grup)").fill("SALAH-" + a.seed.slice(6));
    await alice2.getByRole("button", { name: "Buka brankas" }).click();
    await alice2.getByText(/Frasa kunci (tidak cocok|tidak valid)/).waitFor();
    check(true, "frasa kunci salah ketik ditolak dengan pesan jelas");
    await alice2.getByLabel("Frasa kunci (14 grup)").fill(a.seed.toLowerCase().replace(/-/g, " "));
    await alice2.getByRole("button", { name: "Buka brankas" }).click();
    await alice2.locator(".dot.online").waitFor();
    await bob.waitForTimeout(1500);
    check(!(await bob.getByText(/Safety number dengan Brankas_Ayu berubah/).count()), "pulih dengan frasa kunci: kontak tidak melihat safety number berubah");
    check(!(await alice.getByText("Akunmu sekarang aktif di perangkat lain").count()), "kunci sama → perangkat lama tidak dianggap kalah");

    // Pulihkan cadangan di HP baru → riwayat lama muncul.
    await alice2.getByRole("button", { name: "Pengaturan" }).click();
    await alice2.getByLabel("File cadangan").setInputFiles(backupPath);
    await alice2.getByText(/Cadangan .* dipulihkan: \d+ pesan baru/).waitFor();
    await alice2.keyboard.press("Escape");
    await alice2.getByRole("button", { name: /Brankas_Bima/ }).click();
    await alice2.getByText(SECRET_MSG).waitFor();
    check(true, "cadangan terenkripsi dipulihkan di perangkat baru (riwayat lama terbaca)");
    // Cadangan gaya lama (*.pinpath, sebelum rebrand KAMBE) tetap bisa dipulihkan.
    // Isinya sama dengan cadangan tadi, jadi pesan sudah ada → "0 pesan baru" (sekaligus membedakan dari toast pertama).
    await alice2.getByRole("button", { name: "Pengaturan" }).click();
    check((await alice2.getByLabel("File cadangan").getAttribute("accept"))?.split(",").includes(".pinpath") === true, "input cadangan tetap menerima ekstensi .pinpath");
    await alice2.getByLabel("File cadangan").setInputFiles({ name: "lama.pinpath", mimeType: "application/octet-stream", buffer: readFileSync(backupPath) });
    await alice2.getByText(/Cadangan .* dipulihkan: 0 pesan baru/).waitFor();
    check(!(await alice2.getByText(/bukan file cadangan/).count()), "file cadangan lama.pinpath (nama gaya lama) berhasil dipulihkan");
    await alice2.keyboard.press("Escape");
    // Bob masih bisa mengirim pesan yang terbaca di perangkat baru (kunci sama).
    await bob.getByLabel("Tulis pesan").fill("Masih aman di HP baru?");
    await bob.getByRole("button", { name: "Kirim" }).click();
    await alice2.getByText("Masih aman di HP baru?").waitFor();
    check(true, "pesan baru terbaca di perangkat hasil pemulihan");
    await alice2.screenshot({ path: join(OUT, "v1-restored.png") });
  } catch (e) {
    failures++;
    console.error("✖ skenario terhenti:", e);
  } finally {
    const real = problems.filter((p) => !/Failed to load resource: the server responded with a status of (401|404)/.test(p));
    check(real.length === 0, `tidak ada error console${real.length ? ":\n  " + real.join("\n  ") : ""}`);
    await browser?.close();
    server.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} pemeriksaan GAGAL` : "\nSemua pemeriksaan brankas LULUS");
    process.exit(failures ? 1 : 0);
  }
}

void main();
