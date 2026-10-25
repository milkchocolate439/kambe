// Uji browser Fase 3: Shadow PIN, radar opt-in, dan Path Moments E2EE (3 pengguna).
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
  await page.getByRole("button", { name: "Lanjut ke PINPath" }).click();
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
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), PINPATH_DB: join(dataDir, "d.db") },
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

    // --- Shadow PIN: bima terhubung tanpa pernah tahu PIN utama ayu ---
    await ayu.getByRole("button", { name: /Shadow PIN sementara/ }).click();
    await ayu.getByLabel("Label Shadow PIN").fill("Grup FB Rotan");
    await ayu.getByRole("button", { name: "Buat" }).click();
    const shadowBtn = ayu.getByRole("button", { name: /^Salin Shadow PIN/ });
    await shadowBtn.waitFor();
    const shadow = ((await shadowBtn.textContent()) ?? "").trim();
    check(/^[2-9A-HJ-NP-Z]{6}$/.test(shadow) && shadow !== ayuPin, `Shadow PIN ${shadow} dibuat (berbeda dari PIN utama)`);
    await ayu.screenshot({ path: join(OUT, "d1-shadow-modal.png") });
    await ayu.keyboard.press("Escape");

    await bima.getByLabel("PIN tujuan").fill(shadow);
    await bima.getByRole("button", { name: "Undang" }).click();
    await ayu.getByText(new RegExp(`Lewat Shadow PIN ${shadow} \\(Grup FB Rotan\\)`)).waitFor();
    check(true, "ayu melihat undangan datang lewat Shadow PIN beserta labelnya");
    await ayu.getByRole("button", { name: "Terima" }).click();
    await bima.getByRole("button", { name: /Ayu_Rotan/ }).waitFor();
    check(!(await bima.content()).includes(ayuPin), "PIN utama ayu TIDAK pernah muncul di layar bima");

    // --- Radar: hanya peserta yang saling melihat, memakai PIN radar ---
    await ayu.getByRole("button", { name: /Radar ekonomi/ }).click();
    await ayu.getByLabel("Kebutuhan atau tawaran").fill("Jual rotan mentah Katingan 2 ton");
    await ayu.getByRole("button", { name: "Ikut radar 7 hari" }).click();
    await ayu.getByText(/PIN radar/).waitFor();
    check(true, "ayu ikut radar (opt-in) dan mendapat PIN radar");

    await citra.getByRole("button", { name: /Radar ekonomi/ }).click();
    await citra.getByText(/Hanya sesama peserta radar/).waitFor();
    check(true, "radar menjelaskan aturan privasi sebelum ikut");
    await citra.getByLabel("Sektor radar").selectOption("Desain & Kreatif");
    await citra.getByLabel("Kebutuhan atau tawaran").fill("Jasa desain label kemasan produk");
    await citra.getByRole("button", { name: "Ikut radar 7 hari" }).click();
    const entry = citra.locator(".stack", { hasText: "Jual rotan mentah Katingan 2 ton" }).last();
    await entry.waitFor();
    check(!(await citra.content()).includes(ayuPin), "radar citra tidak menampilkan PIN utama ayu");
    await citra.screenshot({ path: join(OUT, "d2-radar.png") });
    await entry.getByRole("button", { name: "Undang" }).click();
    await ayu.getByText(/Lewat radar/).waitFor();
    check(true, "undangan dari radar ditandai 'lewat radar' untuk ayu");
    await ayu.getByRole("button", { name: "Terima" }).click();
    await citra.getByRole("button", { name: /Ayu_Rotan/ }).waitFor();

    // --- Moments: dienkripsi per kontak, reaksi real-time ---
    await ayu.getByRole("button", { name: "Moments" }).click();
    await ayu.getByRole("radio", { name: /Tempat/ }).click();
    await ayu.getByLabel("Isi momen").fill("Di gudang Sampit, stok rotan baru datang");
    check(await ayu.getByText("Dikirim ke 2 kontak, dienkripsi satu per satu.").isVisible(), "penulis tahu momen dikirim ke 2 kontak");
    await ayu.getByRole("button", { name: "Bagikan" }).click();
    await ayu.locator(".moment", { hasText: "Di gudang Sampit" }).waitFor();

    await bima.getByRole("button", { name: "Moments" }).click();
    const bimaMoment = bima.locator(".moment", { hasText: "Di gudang Sampit" });
    await bimaMoment.waitFor();
    check(true, "bima membaca momen ayu (didekripsi di perangkatnya)");
    const api = await bima.evaluate(async () => JSON.stringify(await (await fetch("/api/moments")).json()));
    check(!api.includes("Sampit"), "respons server untuk momen hanya berisi ciphertext");
    await bimaMoment.getByRole("button", { name: /Reaksi ❤️/ }).click();
    await ayu.locator(".moment", { hasText: "Di gudang Sampit" }).getByRole("button", { name: "Reaksi ❤️ (1)" }).waitFor();
    check(true, "reaksi ❤️ bima muncul real-time di momen ayu");
    const ov = await bima.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
    check(ov.sw <= ov.vw, `linimasa Moments muat di layar HP (${ov.sw}/${ov.vw})`);
    await bima.screenshot({ path: join(OUT, "d3-bima-moments-mobile.png") });
    await ayu.screenshot({ path: join(OUT, "d4-ayu-moments.png") });

    // Kembali ke chat dari Moments di HP.
    await bima.getByRole("button", { name: "Kembali" }).click();
    await bima.getByRole("button", { name: /Ayu_Rotan/ }).click();
    await bima.locator(".chat-head").waitFor();
    check(true, "navigasi Moments ⇄ chat di HP berjalan");
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
