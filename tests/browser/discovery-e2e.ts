// Uji browser Fase 3: PIN Bayang (Shadow PIN), Radar Arwah opt-in, dan Jejak (Moments) E2EE (3 pengguna).
// Jalankan: pnpm build && pnpm test:browser
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const PORT = 3313;
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
  return (await page.locator(".pin-big").first().textContent()) ?? "";
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), "pinpath-disc-"));
  const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    // Mode produksi butuh penyedia xendit; skenario ini tidak membayar, jadi kunci palsu aman (sama seperti e2e.ts).
    env: { ...process.env, NODE_ENV: "production", PINPATH_PAYMENT_PROVIDER: "xendit", XENDIT_SECRET_KEY: "xnd_development_verify_only", XENDIT_CALLBACK_TOKEN: "verify-only", PINPATH_PUBLIC_URL: BASE, PORT: String(PORT), PINPATH_DB: join(dataDir, "d.db") },
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
    const ayu = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" })).newPage();
    const bima = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    const citra = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    for (const [p, n] of [[ayu, "ayu"], [bima, "bima"], [citra, "citra"]] as const) {
      p.on("console", (msg) => msg.type() === "error" && problems.push(`[${n}] ${msg.text()}`));
      p.on("pageerror", (e) => problems.push(`[${n}] ${e.message}`));
    }

    const ayuPin = await signup(ayu, "Ayu_Rotan");
    await signup(bima, "Bima_Kopi");
    await signup(citra, "Citra_Desain");

    // --- PIN Bayang: bima terhubung tanpa pernah tahu PIN utama ayu ---
    await ayu.getByRole("button", { name: /PIN Bayang 24 jam/ }).click();
    await ayu.getByLabel("Label PIN Bayang").fill("Grup FB Rotan");
    await ayu.getByRole("button", { name: "Buat" }).click();
    const shadowBtn = ayu.getByRole("button", { name: /^Salin PIN Bayang/ });
    await shadowBtn.waitFor();
    const shadow = ((await shadowBtn.textContent()) ?? "").trim();
    check(/^[2-9A-HJ-NP-Z]{6}$/.test(shadow) && shadow !== ayuPin, `PIN Bayang ${shadow} dibuat (berbeda dari PIN utama)`);
    await ayu.screenshot({ path: join(OUT, "d1-shadow-modal.png") });
    await ayu.keyboard.press("Escape");

    await bima.getByLabel("PIN tujuan").fill(shadow);
    await bima.getByRole("button", { name: "Undang" }).click();
    await ayu.getByText(new RegExp(`Lewat PIN Bayang ${shadow} \\(Grup FB Rotan\\)`)).waitFor();
    check(true, "ayu melihat undangan datang lewat PIN Bayang beserta labelnya");
    await ayu.getByRole("button", { name: "Terima" }).click();
    await bima.getByRole("button", { name: /Ayu_Rotan/ }).waitFor();
    check(!(await bima.content()).includes(ayuPin), "PIN utama ayu TIDAK pernah muncul di layar bima");

    // --- Radar Arwah: hanya peserta yang saling melihat, memakai PIN radar ---
    await ayu.getByRole("button", { name: "Pengaturan" }).click(); // Radar Arwah ada di Profil (UI minimalis)
    await ayu.getByRole("button", { name: /^Radar Arwah/ }).click();
    await ayu.getByLabel("Kebutuhan atau tawaran").fill("Jual rotan mentah Katingan 2 ton");
    await ayu.getByRole("button", { name: "Ikut Radar Arwah 7 hari" }).click();
    await ayu.getByText(/PIN radar/).waitFor();
    check(true, "ayu ikut radar (opt-in) dan mendapat PIN radar");
    await ayu.keyboard.press("Escape");

    await citra.getByRole("button", { name: "Pengaturan" }).click();
    await citra.getByRole("button", { name: /^Radar Arwah/ }).click();
    await citra.getByText(/Hanya sesama peserta Radar Arwah/).waitFor();
    check(true, "radar menjelaskan aturan privasi sebelum ikut");
    await citra.getByLabel("Sektor radar").selectOption("Desain & Kreatif");
    await citra.getByLabel("Kebutuhan atau tawaran").fill("Jasa desain label kemasan produk");
    await citra.getByRole("button", { name: "Ikut Radar Arwah 7 hari" }).click();
    const entry = citra.locator(".stack", { hasText: "Jual rotan mentah Katingan 2 ton" }).last();
    await entry.waitFor();
    check(!(await citra.content()).includes(ayuPin), "radar citra tidak menampilkan PIN utama ayu");
    await citra.screenshot({ path: join(OUT, "d2-radar.png") });
    await entry.getByRole("button", { name: "Undang" }).click();
    await citra.keyboard.press("Escape");
    await ayu.getByText(/Lewat Radar Arwah/).waitFor();
    check(true, "undangan dari radar ditandai 'lewat radar' untuk ayu");
    await ayu.getByRole("button", { name: "Terima" }).click();
    await citra.getByRole("button", { name: /Ayu_Rotan/ }).waitFor();

    // --- Jejak: dienkripsi per kontak, reaksi real-time ---
    await ayu.getByRole("button", { name: "Pengaturan" }).click(); // Jejak ada di Profil
    await ayu.getByRole("button", { name: "Jejak" }).click();
    await ayu.getByRole("radio", { name: /Tempat/ }).click();
    await ayu.getByLabel("Isi jejak").fill("Di gudang Sampit, stok rotan baru datang");
    check(await ayu.getByText("Dikirim ke 2 kontak, dienkripsi satu per satu.").isVisible(), "penulis tahu jejak dikirim ke 2 kontak");
    await ayu.getByRole("button", { name: "Bagikan" }).click();
    await ayu.locator(".moment", { hasText: "Di gudang Sampit" }).waitFor();

    await bima.getByRole("button", { name: "Pengaturan" }).click();
    await bima.getByRole("button", { name: "Jejak" }).click();
    const bimaMoment = bima.locator(".moment", { hasText: "Di gudang Sampit" });
    await bimaMoment.waitFor();
    check(true, "bima membaca jejak ayu (didekripsi di perangkatnya)");
    const api = await bima.evaluate(async () => JSON.stringify(await (await fetch("/api/moments")).json()));
    check(!api.includes("Sampit"), "respons server untuk jejak hanya berisi ciphertext");
    await bimaMoment.getByRole("button", { name: /Reaksi ❤️/ }).click();
    await ayu.locator(".moment", { hasText: "Di gudang Sampit" }).getByRole("button", { name: "Reaksi ❤️ (1)" }).waitFor();
    check(true, "reaksi ❤️ bima muncul real-time di jejak ayu");
    const ov = await bima.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
    check(ov.sw <= ov.vw, `linimasa Jejak muat di layar HP (${ov.sw}/${ov.vw})`);
    await bima.screenshot({ path: join(OUT, "d3-bima-moments-mobile.png") });
    await ayu.screenshot({ path: join(OUT, "d4-ayu-moments.png") });

    // Kembali ke chat dari Jejak di HP.
    await bima.getByRole("button", { name: "Kembali" }).click();
    await bima.getByRole("button", { name: /Ayu_Rotan/ }).click();
    await bima.locator(".chat-head").waitFor();
    check(true, "navigasi Jejak ⇄ chat di HP berjalan");
  } catch (e) {
    failures++;
    console.error("✖ skenario terhenti:", e);
  } finally {
    const real = problems.filter((p) => !/status of (401|403|404)/.test(p));
    check(real.length === 0, `tidak ada error console${real.length ? ":\n  " + real.join("\n  ") : ""}`);
    await browser?.close();
    server.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} pemeriksaan GAGAL` : "\nSemua pemeriksaan Fase 3 LULUS");
    process.exit(failures ? 1 : 0);
  }
}

void main();
