// Uji browser v3: platform gratis + kesepakatan LANGSUNG dengan alur TEGAS.
//  1) Etalase: maks 3 barang, foto WAJIB lewat kamera di aplikasi (kamera palsu Chromium).
//  2) Pembeli TIDAK bisa "Sudah bayar" sebelum penjual mengirim rekening.
//  3) "Sudah bayar" hanya lewat form bukti + foto bukti yang diunggah (terenkripsi).
//  4) Penjual melihat form & foto bukti → Uang diterima · kirim → selesai → Buku Jejak 3 ttd.
//  + nomor HP diblokir di chat; data bayar & bukti tidak terlihat server / disk.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const PORT = 3318;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(import.meta.dirname, "out");
const PASS = "kopi-hujan-rotan-senja";
const ADDR = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";
const TITLE = "Roasting kustom 2 Kg";
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

const dumpDisk = (page: Page) =>
  page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res) => {
      const r = indexedDB.open("pinpath");
      r.onsuccess = () => res(r.result);
    });
    const all: unknown[] = [];
    for (const name of [...db.objectStoreNames]) {
      all.push(await new Promise((res) => {
        const r = db.transaction(name).objectStore(name).getAll();
        r.onsuccess = () => res(r.result.map((v) => (v && typeof v === "object" && "privateKey" in v ? { ...v, privateKey: "[CryptoKey]" } : v)));
      }));
    }
    db.close();
    return JSON.stringify(all) + JSON.stringify({ ...localStorage });
  });

/** PNG uji "screenshot bukti transfer" yang dibuat di halaman. */
const proofPng = async (page: Page) =>
  Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 360;
      c.height = 220;
      const g = c.getContext("2d")!;
      g.fillStyle = "#1f6f43";
      g.fillRect(0, 0, 360, 220);
      g.fillStyle = "#fff";
      g.font = "22px sans-serif";
      g.fillText("TRANSFER BERHASIL", 24, 110);
      return c.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), "kambe-direct-"));
  const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, NODE_ENV: "test", KAMBE_SERVE_DIST: "1", PORT: String(PORT), KAMBE_DB: join(dataDir, "d.db") },
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
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
      args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    });
    const seller = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: "dark", permissions: ["camera"] })).newPage();
    const buyer = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    for (const [p, n] of [[seller, "seller"], [buyer, "buyer"]] as const) {
      p.on("console", (m) => m.type() === "error" && problems.push(`[${n}] ${m.text()}`));
      p.on("pageerror", (e) => problems.push(`[${n}] ${e.message}`));
    }

    const sellerPin = await signup(seller, "Gayo_Langsung");
    await signup(buyer, "Pembeli_Langsung");
    await buyer.getByLabel("PIN tujuan").fill(sellerPin);
    await buyer.getByRole("button", { name: "Undang" }).click();
    await seller.getByRole("button", { name: "Terima" }).click();
    await buyer.locator(".glass-item").waitFor();

    // --- Etalase: foto kamera wajib, maks 3 ---
    await seller.getByRole("button", { name: "Toko & Dompet" }).click();
    await seller.getByRole("tab", { name: "Etalase" }).click();
    await seller.getByRole("button", { name: "Tambah barang" }).click();
    check((await seller.locator('input[type="file"]').count()) === 0, "etalase: tidak ada pilih-berkas (galeri) sama sekali");
    await seller.getByLabel("Nama barang").fill("Arabica Gayo 1 Kg");
    await seller.getByLabel("Harga").fill("125000");
    check(await seller.getByRole("button", { name: "Simpan" }).isDisabled(), "simpan terkunci sebelum ada foto");
    await seller.getByRole("button", { name: "Ambil foto" }).click();
    await seller.locator("video.camera-view").waitFor();
    await seller.waitForFunction(() => (document.querySelector("video.camera-view") as HTMLVideoElement | null)?.videoWidth! > 0, null, { timeout: 15000 });
    await seller.getByRole("button", { name: "Ambil foto" }).last().click();
    await seller.locator(".photo-thumb img").first().waitFor();
    check(true, "foto diambil langsung dari kamera di aplikasi");
    await seller.getByRole("button", { name: "Simpan" }).click();
    await seller.getByText("Etalase 1/3").waitFor();
    check(true, "barang berfoto dipajang (1/3)");
    const sellerDisk = await dumpDisk(seller);
    check(!sellerDisk.includes("Arabica Gayo 1 Kg"), "etalase terenkripsi di disk penjual");

    // Rekening (kripto disarankan) di Dompet.
    await seller.getByRole("tab", { name: "Dompet" }).click();
    await seller.getByLabel("Aset & jaringan").fill("USDT · TRC20");
    await seller.getByLabel("Alamat dompet").fill(ADDR);
    await seller.getByRole("button", { name: "Simpan info pembayaran" }).click();
    await seller.getByRole("dialog").getByText(ADDR).waitFor();
    await seller.screenshot({ path: join(OUT, "l1-seller-dompet.png") });
    await seller.keyboard.press("Escape");

    // Pembeli melihat etalase berfoto.
    await buyer.locator(".glass-item").click();
    await buyer.getByRole("button", { name: "Etalase Gayo_Langsung" }).click();
    await buyer.getByRole("dialog").locator(".photo-thumb img").first().waitFor({ timeout: 15000 });
    check(await buyer.getByRole("dialog").getByText("Arabica Gayo 1 Kg").isVisible(), "pembeli melihat barang + foto (didekripsi di HP)");
    await buyer.keyboard.press("Escape");

    // --- Nomor HP diblokir ---
    await buyer.getByLabel("Tulis pesan").fill("Kak, WA aku aja 0812 3456 7890 ya");
    await buyer.getByRole("button", { name: "Kirim" }).click();
    await buyer.getByText(/Nomor HP tidak boleh dibagikan di KAMBE/).first().waitFor();
    check((await buyer.locator(".bubble").count()) === 0, "pesan berisi nomor HP tidak terkirim");

    // --- Tawaran → MENUNGGU REKENING (pembeli belum bisa bayar) ---
    await seller.getByRole("button", { name: /Pembeli_Langsung/ }).click();
    await seller.getByRole("button", { name: "Tawarkan kesepakatan rekber" }).click();
    await seller.getByLabel("Barang / jasa").fill(TITLE);
    await seller.getByLabel("Harga").fill("320000");
    await seller.getByRole("button", { name: "Kirim tawaran" }).click();
    const card = buyer.locator(".deal-card", { hasText: TITLE });
    await card.getByText("Menunggu rekening").waitFor();
    check((await card.getByRole("button", { name: "Sudah bayar" }).count()) === 0, "sebelum rekening dikirim: tombol 'Sudah bayar' TIDAK ada");

    // --- Penjual kirim rekening ---
    const sCard = seller.locator(".deal-card", { hasText: TITLE });
    await sCard.getByRole("button", { name: "Kirim rekening" }).click();
    await seller.getByRole("button", { name: "Kirim USDT · TRC20" }).click();
    await card.getByText("Menunggu transfer").waitFor();
    check((await card.textContent())?.includes(ADDR) === true, "rekening penerima muncul di kartu kesepakatan pembeli");
    check((await card.textContent())?.includes("Disarankan") === true, "kripto ditandai Disarankan");
    const dump = await buyer.evaluate(async () => {
      const c = await (await fetch("/api/contacts")).json();
      return JSON.stringify(await (await fetch(`/api/deals?peer=${c.contacts[0].id}`)).json());
    });
    check(!dump.includes(ADDR), "server tidak melihat rekening (tersegel)");

    // --- Form bukti + foto wajib ---
    await card.getByRole("button", { name: "Sudah bayar" }).click();
    const dlg = buyer.getByRole("dialog", { name: "Bukti pembayaran" });
    const submit = dlg.getByRole("button", { name: "Sudah bayar" });
    check(await submit.isDisabled(), "kirim terkunci sebelum form & foto lengkap");
    await dlg.getByLabel("Dari bank / dompet").fill("USDT TRC20 · Binance");
    await dlg.getByLabel("Nama pengirim").fill("Pembeli Langsung");
    await dlg.getByLabel("No. referensi / hash").fill("9f3a7c21deadbeef");
    check(await submit.isDisabled(), "tanpa foto bukti: tetap terkunci");
    await dlg.locator("#pp-photo").setInputFiles({ name: "bukti.png", mimeType: "image/png", buffer: await proofPng(buyer) });
    await dlg.locator(".photo-thumb img").first().waitFor();
    check(await submit.isEnabled(), "form + foto lengkap: bisa dikirim");
    await submit.click();
    await card.getByText("Pembeli sudah transfer · cek mutasi").waitFor();
    check(true, "status: sudah bayar (dengan bukti)");

    // --- Penjual melihat bukti + foto ---
    await sCard.getByText("9f3a7c21deadbeef").waitFor({ timeout: 15000 });
    const proofImg = sCard.locator(".photo-thumb img").first();
    await proofImg.waitFor({ timeout: 15000 });
    check(await proofImg.evaluate((i) => (i as HTMLImageElement).naturalWidth > 0), "penjual melihat foto bukti (didekripsi di perangkatnya)");
    await seller.screenshot({ path: join(OUT, "l2-seller-proof.png") });
    await sCard.getByRole("button", { name: "Uang diterima · kirim" }).click();
    await seller.getByLabel("Kurir / cara penyerahan").selectOption("Diantar langsung");
    await seller.getByLabel("Keterangan serah terima").fill("Diserahkan langsung di Pasar Besar, 12 Nov 16.00");
    await seller.getByRole("button", { name: "Tandai dikirim" }).click();
    await card.getByText("Uang diterima · dikirim").waitFor();

    await card.getByRole("button", { name: "Barang diterima · selesai" }).click();
    await buyer.getByRole("dialog").getByRole("button", { name: "Ya, lanjutkan" }).click();
    await card.getByText("Selesai", { exact: true }).waitFor();
    await card.getByText(/Buku Jejak: 3 tanda tangan cocok/).waitFor({ timeout: 15000 });
    check(true, "selesai + Buku Jejak 3 tanda tangan");
    const buyerDisk = await dumpDisk(buyer);
    check(!buyerDisk.includes(ADDR) && !buyerDisk.includes("9f3a7c21"), "rekening & bukti tidak tersimpan polos di HP");
    check((await buyer.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1, "HP 390px: tanpa gulir horizontal");
    await buyer.screenshot({ path: join(OUT, "l3-buyer-done.png") });
  } catch (e) {
    failures++;
    console.error("✖ skenario terhenti:", e);
  } finally {
    const real = problems.filter((p) => !/Failed to load resource: the server responded with a status of (401|404)/.test(p));
    check(real.length === 0, `tidak ada error console${real.length ? ":\n  " + real.join("\n  ") : ""}`);
    await browser?.close();
    server.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} pemeriksaan GAGAL` : "\nSemua pemeriksaan kesepakatan langsung LULUS");
    process.exit(failures ? 1 : 0);
  }
}

void main();
