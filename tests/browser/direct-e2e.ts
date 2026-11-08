// Uji browser: platform GRATIS + kesepakatan LANGSUNG (pembeli mentransfer sendiri; KAMBE tidak memegang dana).
// Alur: info pembayaran (kripto disarankan) → nomor HP diblokir di chat → tawaran → kirim info bayar →
// "Sudah transfer" (+catatan) → "Uang diterima · kirim" → "Barang diterima · selesai" → Buku Jejak 3 ttd.
// Jalankan: pnpm build && pnpm test:browser
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

async function dealAction(page: Page, label: string) {
  await page.locator(".deal-card", { hasText: TITLE }).getByRole("button", { name: label }).click();
  const confirm = page.getByRole("dialog").getByRole("button", { name: "Ya, lanjutkan" });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
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

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), "kambe-direct-"));
  // Konfigurasi produk: default (langsung + gratis) — tanpa variabel pembayaran apa pun.
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
    const cfg = await fetch(BASE + "/api/config").then((r) => r.json());
    check(cfg.paymentProvider === "langsung" && cfg.freePlatform === true, "server produk default: pembayaran langsung + platform gratis");

    browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
    const seller = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" })).newPage();
    const buyer = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    for (const [p, n] of [[seller, "seller"], [buyer, "buyer"]] as const) {
      p.on("console", (m) => m.type() === "error" && problems.push(`[${n}] ${m.text()}`));
      p.on("pageerror", (e) => problems.push(`[${n}] ${e.message}`));
    }
    await buyer.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});

    const sellerPin = await signup(seller, "Gayo_Langsung");
    await signup(buyer, "Pembeli_Langsung");
    await buyer.getByLabel("PIN tujuan").fill(sellerPin);
    await buyer.getByRole("button", { name: "Undang" }).click();
    await seller.getByRole("button", { name: "Terima" }).click();
    await buyer.locator(".glass-item").waitFor();

    // --- Toko & Dompet: tanpa PRO; Dompet = info pembayaran (brankas) ---
    await seller.getByRole("button", { name: "Toko & Dompet" }).click();
    check((await seller.getByRole("tab", { name: "PRO" }).count()) === 0, "tidak ada tab PRO — platform gratis");
    check(await seller.getByText("KAMBE gratis. Pembayaran langsung antarpengguna").isVisible(), "penjelasan: KAMBE tidak memegang dana");
    check((await seller.getByText("SIMULASI").count()) === 0, "tidak ada label SIMULASI");
    await seller.getByRole("tab", { name: "Dompet" }).click();
    // Kripto (disarankan) adalah pilihan pertama.
    check((await seller.getByRole("tab", { name: "Dompet kripto" }).getAttribute("aria-selected")) === "true", "dompet kripto dipilih lebih dulu (disarankan)");
    await seller.getByLabel("Aset & jaringan").fill("USDT · TRC20");
    await seller.getByLabel("Alamat dompet").fill(ADDR);
    await seller.getByRole("button", { name: "Simpan info pembayaran" }).click();
    await seller.getByRole("dialog").getByText(ADDR).waitFor();
    check(await seller.getByRole("dialog").getByText("Disarankan").first().isVisible(), "kripto diberi label Disarankan");
    // Rekening: nomor berbentuk HP ditolak, nomor rekening biasa diterima.
    await seller.getByRole("tab", { name: "Rekening bank" }).click();
    await seller.getByLabel("Nama bank").fill("BCA");
    await seller.getByLabel("Nomor rekening").fill("081234567890");
    await seller.getByLabel("Nama pemilik rekening").fill("Budi Gayo");
    await seller.getByRole("button", { name: "Simpan info pembayaran" }).click();
    await seller.getByText("Itu terlihat seperti nomor HP, bukan nomor rekening").waitFor();
    check(true, "nomor HP tidak bisa disamarkan sebagai nomor rekening");
    await seller.getByLabel("Nomor rekening").fill("1234567890");
    await seller.getByRole("button", { name: "Simpan info pembayaran" }).click();
    await seller.getByRole("dialog").getByText("1234567890").waitFor();
    check(true, "rekening bank tersimpan");
    const sellerDisk = await dumpDisk(seller);
    check(!sellerDisk.includes(ADDR) && !sellerDisk.includes("1234567890"), "info pembayaran terenkripsi di disk penjual");
    await seller.screenshot({ path: join(OUT, "l1-seller-dompet.png") });
    await seller.keyboard.press("Escape");

    // --- Nomor HP & kontak luar diblokir di chat ---
    await buyer.locator(".glass-item").click();
    await buyer.getByLabel("Tulis pesan").fill("Kak, WA aku aja 0812 3456 7890 ya");
    await buyer.getByRole("button", { name: "Kirim" }).click();
    await buyer.getByText(/Nomor HP tidak boleh dibagikan di KAMBE/).first().waitFor();
    check((await buyer.locator(".bubble").count()) === 0, "pesan berisi nomor HP tidak terkirim");
    check((await buyer.getByLabel("Tulis pesan").inputValue()).includes("0812"), "teks tetap di kotak ketik untuk diperbaiki");
    await buyer.getByLabel("Tulis pesan").fill("Halo kak, roasting kustom 2 kg bisa? Harga Rp 320.000 oke");
    await buyer.getByRole("button", { name: "Kirim" }).click();
    await buyer.locator(".bubble", { hasText: "Rp 320.000" }).waitFor();
    check(true, "pesan dagang biasa (dengan harga) tetap terkirim");

    // --- Tawaran tanpa PRO ---
    await seller.getByRole("button", { name: /Pembeli_Langsung/ }).click();
    await seller.getByRole("button", { name: "Tawarkan kesepakatan rekber" }).click();
    await seller.getByLabel("Barang / jasa").fill(TITLE);
    await seller.getByLabel("Harga").fill("320000");
    check(await seller.getByText(/langsung ke info pembayaranmu/).isVisible(), "pratinjau: pembeli mentransfer langsung ke penjual");
    await seller.getByRole("button", { name: "Kirim tawaran" }).click();
    const card = buyer.locator(".deal-card", { hasText: TITLE });
    await card.getByText("Menunggu transfer").waitFor();
    check((await card.textContent())?.includes("Langsung ke penjual") === true, "kartu: pembayaran langsung ke penjual, KAMBE gratis");

    // --- Penjual mengirim info pembayaran (satu ketukan) ---
    await seller.locator(".deal-card", { hasText: TITLE }).getByRole("button", { name: "Kirim info pembayaran" }).click();
    await seller.getByRole("button", { name: "Kirim USDT · TRC20" }).click();
    const payBubble = buyer.locator(".bubble", { hasText: "INFO PEMBAYARAN" });
    await payBubble.waitFor();
    check((await payBubble.textContent())?.includes(ADDR) === true, "pembeli menerima alamat dompet (E2EE)");
    check((await payBubble.textContent())?.includes("Disarankan") === true, "kartu info: kripto disarankan");
    check(await payBubble.getByText(/jaringan yang SAMA/).isVisible(), "peringatan jaringan untuk kripto");
    await payBubble.getByRole("button", { name: "Salin" }).click();
    await buyer.getByText("Disalin").first().waitFor();
    check(true, "satu ketukan menyalin alamat");
    const dump = await buyer.evaluate(async () => {
      const c = await (await fetch("/api/contacts")).json();
      return JSON.stringify(await (await fetch(`/api/messages/${c.contacts[0].id}`)).json());
    });
    check(!dump.includes(ADDR) && !dump.includes("TRC20"), "server tidak melihat info pembayaran (hanya ciphertext)");
    await buyer.screenshot({ path: join(OUT, "l2-buyer-payinfo.png") });

    // --- Pembeli: Sudah transfer (+catatan) ---
    await card.getByRole("button", { name: "Sudah transfer" }).click();
    await buyer.getByLabel("Catatan transfer (opsional)").fill("hash tx 9f3a…c21, 12 Nov 14.05");
    await buyer.getByRole("button", { name: "Ya, sudah transfer" }).click();
    await card.getByText("Pembeli sudah transfer · cek mutasi").waitFor();
    check(true, "status: pembeli sudah transfer");

    // --- Penjual: lihat catatan, uang diterima · kirim ---
    const sCard = seller.locator(".deal-card", { hasText: TITLE });
    await sCard.getByText(/hash tx 9f3a/).waitFor();
    check(true, "penjual membaca catatan transfer (tersegel)");
    check(await sCard.getByRole("button", { name: "Uang belum masuk" }).isVisible(), "penjual punya pilihan 'Uang belum masuk'");
    await sCard.getByRole("button", { name: "Uang diterima · kirim" }).click();
    await seller.getByLabel("Kurir / cara penyerahan").selectOption("Diantar langsung");
    await seller.getByLabel("Keterangan serah terima").fill("Diserahkan langsung di Pasar Besar, 12 Nov 16.00");
    await seller.getByRole("button", { name: "Tandai dikirim" }).click();
    await card.getByText("Uang diterima · dikirim").waitFor();
    check(true, "status: uang diterima penjual & dikirim");

    // --- Pembeli: selesai ---
    await dealAction(buyer, "Barang diterima · selesai");
    await card.getByText("Selesai", { exact: true }).waitFor();
    await sCard.getByText("Selesai", { exact: true }).waitFor();
    check(true, "kesepakatan selesai di kedua sisi");
    await card.getByText(/Buku Jejak: 3 tanda tangan cocok/).waitFor({ timeout: 15000 });
    await sCard.getByText(/Buku Jejak: 3 tanda tangan cocok/).waitFor({ timeout: 15000 });
    check(true, "Buku Jejak: notaris + pembeli + penjual cocok");
    check((await card.textContent())?.includes("SIMULASI") === false, "tanpa label SIMULASI pada kesepakatan langsung");
    const buyerDisk = await dumpDisk(buyer);
    check(!buyerDisk.includes(ADDR) && !buyerDisk.includes("hash tx 9f3a"), "riwayat pembeli (info bayar & catatan) terenkripsi di disk");
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
