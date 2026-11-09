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

    // Penjual menyimpan dompet kripto (disarankan) di brankasnya.
    const ADDR = "TLiveUji7xQp2mN8vR4sK1aZ9cY3bW6dE5";
    await seller.getByRole("button", { name: "Toko & Dompet" }).click();
    await seller.getByRole("tab", { name: "Dompet" }).click();
    await seller.getByLabel("Aset & jaringan").fill("USDT · TRC20");
    await seller.getByLabel("Alamat dompet").fill(ADDR);
    await seller.getByRole("button", { name: "Simpan info pembayaran" }).click();
    await seller.getByRole("dialog").getByText(ADDR).waitFor();
    await seller.keyboard.press("Escape");

    // Alur tegas v3: tawaran → MENUNGGU REKENING → rekening dikirim → bukti berfoto.
    await seller.getByRole("button", { name: "Tawarkan kesepakatan rekber" }).click();
    await seller.getByLabel("Barang / jasa").fill("Kopi uji live");
    await seller.getByLabel("Harga").fill("50000");
    await seller.getByRole("button", { name: "Kirim tawaran" }).click();
    const card = buyer.locator(".deal-card", { hasText: "Kopi uji live" });
    await card.getByText("Menunggu rekening").waitFor({ timeout: 30000 });
    check((await card.textContent())?.includes("KESEPAKATAN LANGSUNG") === true, "kesepakatan langsung (gratis) sampai ke pembeli");
    check((await card.getByRole("button", { name: "Sudah bayar" }).count()) === 0, "sebelum rekening dikirim: pembeli TIDAK bisa 'Sudah bayar'");
    await card.getByText(/Kuitansi #0 sah/).waitFor({ timeout: 30000 });
    check(true, "kuitansi notaris terverifikasi di HP pembeli");

    const sCard = seller.locator(".deal-card", { hasText: "Kopi uji live" });
    await sCard.getByRole("button", { name: "Kirim rekening" }).click();
    await seller.getByRole("button", { name: "Kirim USDT · TRC20" }).click();
    await card.getByText("Menunggu transfer").waitFor({ timeout: 30000 });
    check((await card.textContent())?.includes(ADDR) === true, "rekening penjual sampai ke HP pembeli (tersegel E2EE)");

    await card.getByRole("button", { name: "Sudah bayar" }).click();
    const dlg = buyer.getByRole("dialog", { name: "Bukti pembayaran" });
    const submit = dlg.getByRole("button", { name: "Sudah bayar" });
    await dlg.getByLabel("Dari bank / dompet").fill("USDT TRC20 · uji live");
    await dlg.getByLabel("Nama pengirim").fill("Pembeli Live");
    await dlg.getByLabel("No. referensi / hash").fill("live7c21beef");
    check(await submit.isDisabled(), "tanpa foto bukti: 'Sudah bayar' terkunci");
    const png = Buffer.from(
      await buyer.evaluate(() => {
        const c = document.createElement("canvas");
        c.width = 320;
        c.height = 200;
        const g = c.getContext("2d")!;
        g.fillStyle = "#1f6f43";
        g.fillRect(0, 0, 320, 200);
        g.fillStyle = "#fff";
        g.font = "20px sans-serif";
        g.fillText("TRANSFER UJI LIVE", 20, 100);
        return c.toDataURL("image/png").split(",")[1];
      }),
      "base64",
    );
    await dlg.locator("#pp-photo").setInputFiles({ name: "bukti.png", mimeType: "image/png", buffer: png });
    await dlg.locator(".photo-thumb img").first().waitFor();
    await submit.click();
    await card.getByText("Pembeli sudah transfer · cek mutasi").waitFor({ timeout: 30000 });
    await sCard.getByText("live7c21beef").waitFor({ timeout: 30000 });
    const proofImg = sCard.locator(".photo-thumb img").first();
    await proofImg.waitFor({ timeout: 30000 });
    check(await proofImg.evaluate((i) => (i as HTMLImageElement).naturalWidth > 0), "bukti + foto terenkripsi terunggah & terbuka di perangkat penjual");
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
