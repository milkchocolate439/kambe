// Uji browser alamat KAMBE yang sudah online: 2 pengguna (desktop + HP) lewat internet.
// Pakai: node --import tsx scripts/live-browser.ts https://alamat-kambe
// Membuat 2 akun uji "Live_Penjual<acak>" & "Live_Pembeli<acak>".
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";

const BASE = (process.argv[2] ?? "").replace(/\/$/, "");
const PASS = "kopi-hujan-rotan-senja-live";
let failures = 0;
const check = (ok: unknown, label: string) => {
  console.log(`${ok ? "✔" : "✖"} ${label}`);
  if (!ok) failures++;
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
  await page.locator(".dot.online").waitFor({ timeout: 30000 });
  return (await page.locator(".pin-big").first().textContent()) ?? "";
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
  const problems: string[] = [];
  try {
    const seller = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    const buyer = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    for (const [p, n] of [[seller, "penjual"], [buyer, "pembeli"]] as const) {
      p.on("pageerror", (e) => problems.push(`[${n}] ${e.message}`));
      p.on("console", (m) => m.type() === "error" && !/status of 40[14]/.test(m.text()) && problems.push(`[${n}] ${m.text()}`));
    }
    const tag = Math.random().toString(36).slice(2, 6);
    const pin = await signup(seller, `Live_Penjual${tag}`);
    check(/^[0-9A-Z]{6}$/.test(pin.trim()), `penjual terdaftar lewat internet (PIN ${pin.trim()})`);
    await signup(buyer, `Live_Pembeli${tag}`);
    check(true, "pembeli terdaftar dari HP (390px)");
    await buyer.getByLabel("PIN tujuan").fill(pin.trim());
    await buyer.getByRole("button", { name: "Undang" }).click();
    await seller.getByRole("button", { name: "Terima" }).click({ timeout: 30000 });
    await buyer.locator(".glass-item").waitFor({ timeout: 30000 });
    check(true, "undangan PIN diterima realtime");

    await buyer.locator(".glass-item").click();
    await buyer.getByLabel("Tulis pesan").fill("WA aku 0812 3456 7890");
    await buyer.getByRole("button", { name: "Kirim" }).click();
    await buyer.getByText(/Nomor HP tidak boleh dibagikan/).first().waitFor();
    check((await buyer.locator(".bubble").count()) === 0, "nomor HP diblokir di produksi");
    await buyer.getByLabel("Tulis pesan").fill("Halo, dari internet! Harga Rp 50.000 ya");
    await buyer.getByRole("button", { name: "Kirim" }).click();
    await seller.locator(".glass-item").click();
    await seller.getByText("Halo, dari internet! Harga Rp 50.000 ya").waitFor({ timeout: 30000 });
    check(true, "pesan E2EE sampai ke lawan lewat relay internet");
    await buyer.locator(".status.D, .status.R").first().waitFor({ timeout: 30000 });
    check(true, "status D/R kembali ke pengirim");

    await seller.getByRole("button", { name: "Tawarkan kesepakatan rekber" }).click();
    await seller.getByLabel("Barang / jasa").fill("Kopi uji live");
    await seller.getByLabel("Harga").fill("50000");
    await seller.getByRole("button", { name: "Kirim tawaran" }).click();
    const card = buyer.locator(".deal-card", { hasText: "Kopi uji live" });
    await card.getByText("Menunggu transfer").waitFor({ timeout: 30000 });
    check((await card.textContent())?.includes("Langsung ke penjual") === true, "kesepakatan langsung (gratis) sampai ke pembeli");
    await card.getByText(/Kuitansi #0 sah/).waitFor({ timeout: 30000 });
    check(true, "kuitansi notaris terverifikasi di HP pembeli");
  } catch (e) {
    failures++;
    console.error("✖ terhenti:", e);
  } finally {
    check(problems.length === 0, `tanpa error di browser${problems.length ? ": " + problems.join(" | ") : ""}`);
    await browser.close();
    console.log(failures ? `\n${failures} pemeriksaan GAGAL` : `\nUji browser LULUS — ${BASE}`);
    process.exit(failures ? 1 : 0);
  }
}

void main();
