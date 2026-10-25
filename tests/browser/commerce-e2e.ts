// Uji browser alur dagang Fase 2 (SIMULASI): PRO → etalase → kesepakatan rekber →
// bayar → kirim → identitas E2EE → konfirmasi → dana cair → tawaran kustom.
// Jalankan: pnpm build && pnpm test:browser
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import { createApp } from "../../server/app.ts";
import { Client } from "../helpers.ts";

const PORT = 3312;
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
  return (await page.locator(".pin-big").textContent()) ?? "";
}

/** Klik tombol aksi pada kartu kesepakatan, lalu konfirmasi di modal bila ada. */
async function dealAction(page: Page, title: string, label: string) {
  await page.locator(".deal-card", { hasText: title }).getByRole("button", { name: label }).click();
  const confirm = page.getByRole("dialog").getByRole("button", { name: "Ya, lanjutkan" });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), "pinpath-commerce-"));
  const dbPath = join(dataDir, "c.db");
  // Moderator ditunjuk lewat ID akun: buat akunnya dulu di DB yang sama, baru nyalakan server dengan ID itu.
  const seed = createApp({ dbPath });
  await new Promise<void>((r) => seed.server.listen(0, "127.0.0.1", () => r()));
  const modId = (await new Client(`http://127.0.0.1:${(seed.server.address() as AddressInfo).port}`).signup("Moderator_Satu", PASS)).me.id;
  await seed.close();
  const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), PINPATH_DB: dbPath, PINPATH_MODERATORS: modId },
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
    const seller = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" })).newPage();
    const buyer = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    for (const [p, n] of [[seller, "seller"], [buyer, "buyer"]] as const) {
      p.on("console", (msg) => msg.type() === "error" && problems.push(`[${n}] ${msg.text()}`));
      p.on("pageerror", (e) => problems.push(`[${n}] ${e.message}`));
    }

    const sellerPin = await signup(seller, "KopiGayo_Roaster");
    await signup(buyer, "Anon_Wolf99");
    await buyer.getByLabel("PIN tujuan").fill(sellerPin);
    await buyer.getByRole("button", { name: "Undang" }).click();
    await seller.getByRole("button", { name: "Terima" }).click();
    await buyer.getByRole("button", { name: /KopiGayo_Roaster/ }).waitFor();

    // Penjual: aktifkan PRO lalu pajang produk.
    await seller.getByRole("button", { name: "Toko & Dompet" }).click();
    await seller.getByRole("button", { name: "Aktifkan PRO (simulasi)" }).click();
    await seller.getByText(/Aktif sampai/).waitFor();
    check(true, "penjual mengaktifkan PRO (simulasi)");
    await seller.getByRole("tab", { name: "Etalase" }).click();
    await seller.getByRole("button", { name: "Tambah produk / jasa" }).click();
    await seller.getByLabel("Nama produk / jasa").fill("Arabica Gayo Wine 5 Kg");
    await seller.getByLabel("Harga").fill("850000");
    check((await seller.getByLabel("Harga").inputValue()) === "850.000", "input harga diformat rupiah otomatis");
    await seller.getByLabel("Deskripsi (opsional)").fill("Panen terbaru, roast medium");
    await seller.getByRole("button", { name: "Simpan" }).click();
    await seller.getByText("Arabica Gayo Wine 5 Kg").waitFor();
    await seller.screenshot({ path: join(OUT, "c1-seller-store.png") });
    await seller.keyboard.press("Escape");

    // Pembeli: buka etalase dari chat & buat kesepakatan.
    await buyer.getByRole("button", { name: /KopiGayo_Roaster/ }).click();
    await buyer.getByRole("button", { name: "Etalase KopiGayo_Roaster" }).click();
    await buyer.getByRole("button", { name: /Arabica Gayo Wine 5 Kg/ }).click();
    check(await buyer.getByText("ditahan rekber").first().isVisible(), "pembeli diberi penjelasan rekber sebelum membuat kesepakatan");
    await buyer.getByRole("button", { name: "Buat kesepakatan" }).click();
    const card = buyer.locator(".deal-card", { hasText: "Arabica Gayo Wine 5 Kg" });
    await card.waitFor();
    check((await card.textContent())?.includes("Rp850.000"), "kartu kesepakatan muncul di chat dengan harga dari server");
    check((await card.textContent())?.includes("SIMULASI"), "label SIMULASI selalu terlihat");
    await card.getByText(/Kuitansi #0 sah \(ditandatangani notaris\)/).waitFor();
    check(true, "kuitansi notaris #0 diverifikasi di perangkat pembeli");

    await dealAction(buyer, "Arabica Gayo Wine 5 Kg", "Bayar ke rekber");
    await card.getByText("Dana ditahan rekber").waitFor();
    check(true, "pembayaran masuk rekber (dana ditahan)");

    // Penjual melihat kartu yang sama secara real-time lalu menandai dikirim.
    await seller.getByRole("button", { name: /Anon_Wolf99/ }).click();
    await seller.locator(".deal-card", { hasText: "Dana ditahan rekber" }).waitFor();
    check(!(await seller.locator(".deal-card").getByRole("button", { name: "Barang diterima · cairkan" }).count()), "penjual tidak punya tombol pencairan (hanya pembeli)");
    await seller.locator(".deal-card", { hasText: "Arabica Gayo Wine 5 Kg" }).getByRole("button", { name: "Tandai sudah dikirim" }).click();
    await seller.getByLabel("Kurir / cara penyerahan").selectOption("SiCepat");
    check(await seller.getByRole("button", { name: "Tandai dikirim" }).isDisabled(), "kirim ditolak tanpa nomor resi");
    await seller.getByLabel("Nomor resi").fill("sc0012345678");
    await seller.getByRole("button", { name: "Tandai dikirim" }).click();
    await card.getByText("Sudah dikirim").waitFor();
    check(await card.getByText(/Cair otomatis/).isVisible(), "pembeli melihat jadwal pencairan otomatis");
    check(await card.getByText("SC0012345678").isVisible(), "pembeli melihat kurir & nomor resi");

    // Pembeli membagikan identitas pengiriman secara E2EE.
    await card.getByRole("button", { name: "Bagikan identitas" }).click();
    await buyer.getByLabel("Nama penerima").fill("Budi Santoso");
    await buyer.getByLabel("Alamat pengiriman").fill("Jl. Tjilik Riwut Km 5, Palangka Raya");
    await buyer.getByText("Ingat di perangkat ini").click();
    await buyer.getByText(/tidak bisa ditarik kembali/).click();
    await buyer.getByRole("button", { name: "Kirim terenkripsi" }).click();
    await seller.locator(".bubble.identity", { hasText: "Budi Santoso" }).waitFor();
    check(true, "penjual menerima identitas sebagai pesan terenkripsi");
    const dump = await seller.evaluate(async () => {
      const c = await (await fetch("/api/contacts")).json();
      return JSON.stringify(await (await fetch(`/api/messages/${c.contacts[0].id}`)).json());
    });
    check(!dump.includes("Budi") && !dump.includes("Tjilik"), "server TIDAK pernah melihat nama/alamat (hanya ciphertext)");
    // Alamat yang "diingat" disimpan di brankas terenkripsi, bukan teks polos di disk HP.
    const disk = await buyer.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res) => {
        const r = indexedDB.open("pinpath");
        r.onsuccess = () => res(r.result);
      });
      const all: unknown[] = [];
      for (const name of [...db.objectStoreNames]) {
        all.push(await new Promise((res) => {
          const r = db.transaction(name).objectStore(name).getAll();
          r.onsuccess = () => res(r.result);
        }));
      }
      db.close();
      return JSON.stringify(all) + JSON.stringify({ ...localStorage });
    });
    check(!disk.includes("Tjilik") && !disk.includes("Budi Santoso"), "alamat yang diingat terenkripsi di perangkat (IndexedDB & localStorage tanpa teks polos)");
    await card.getByRole("button", { name: "Bagikan identitas" }).click();
    const filled = await buyer
      .waitForFunction(() => (document.getElementById("id-address") as HTMLTextAreaElement | null)?.value === "Jl. Tjilik Riwut Km 5, Palangka Raya", null, { timeout: 5000 })
      .then(() => true, () => false);
    check(filled, "alamat yang diingat terisi otomatis dari brankas");
    await buyer.keyboard.press("Escape");

    // Pembeli konfirmasi → dana cair ke penjual.
    await dealAction(buyer, "Arabica Gayo Wine 5 Kg", "Barang diterima · cairkan");
    await card.getByText("Selesai · dana cair").waitFor();
    await seller.locator(".deal-card", { hasText: "Selesai · dana cair" }).waitFor();
    check(true, "dana cair dan status selesai di kedua sisi");
    await card.getByText(/Kuitansi #3 sah/).waitFor();
    await seller.locator(".deal-card", { hasText: "Arabica Gayo Wine 5 Kg" }).getByText(/Kuitansi #3 sah/).waitFor();
    check(true, "rantai kuitansi #0→#3 sah di kedua perangkat");
    await seller.getByRole("button", { name: "Toko & Dompet" }).click();
    await seller.getByRole("tab", { name: "Dompet" }).click();
    await seller.getByText("Rp807.500").first().waitFor();
    check(true, "saldo penjual = harga − fee 5% (Rp807.500)");
    await seller.screenshot({ path: join(OUT, "c2-seller-wallet.png") });
    await seller.keyboard.press("Escape");

    // Penjual menawarkan kesepakatan kustom dari tombol jabat tangan.
    await seller.getByRole("button", { name: "Tawarkan kesepakatan rekber" }).click();
    await seller.getByLabel("Barang / jasa").fill("Roasting kustom 2 Kg");
    await seller.getByLabel("Harga").fill("320000");
    check(await seller.getByText("Kamu menerima Rp304.000").isVisible(), "pratinjau dana bersih untuk penjual (fee 5%)");
    await seller.getByRole("button", { name: "Kirim tawaran" }).click();
    await buyer.locator(".deal-card", { hasText: "Roasting kustom 2 Kg" }).getByText("Menunggu pembayaran").waitFor();
    check(true, "tawaran kustom muncul real-time di chat pembeli");

    // Sengketa → moderator memutus (tanpa melihat chat).
    const roast = buyer.locator(".deal-card", { hasText: "Roasting kustom 2 Kg" });
    await dealAction(buyer, "Roasting kustom 2 Kg", "Bayar ke rekber");
    await roast.getByText("Dana ditahan rekber").waitFor();
    await seller.locator(".deal-card", { hasText: "Roasting kustom 2 Kg" }).getByRole("button", { name: "Tandai sudah dikirim" }).click();
    await seller.getByLabel("Kurir / cara penyerahan").selectOption("Diantar langsung");
    await seller.getByLabel("Keterangan serah terima").fill("Diserahkan langsung di Pasar Besar, 26 Okt 10.00");
    await seller.getByRole("button", { name: "Tandai dikirim" }).click();
    await roast.getByText("Sudah dikirim").waitFor();
    await roast.getByRole("button", { name: "Ajukan sengketa" }).click();
    await buyer.getByLabel("Alasan").selectOption("not_as_described");
    await buyer.getByLabel("Ceritakan masalahnya").fill("Yang diterima roasting medium, bukan dark seperti disepakati.");
    await buyer.getByRole("dialog").getByRole("button", { name: "Ajukan sengketa" }).click();
    await roast.getByText("Sengketa", { exact: true }).waitFor();
    check(await roast.getByText(/Alasan sengketa: Tidak sesuai deskripsi/).isVisible(), "alasan sengketa tampil di kartu");

    const mod = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    mod.on("pageerror", (e) => problems.push(`[mod] ${e.message}`));
    await mod.goto(BASE);
    await mod.getByLabel("Alias (nama samaran)").fill("Moderator_Satu");
    await mod.locator("#pass").fill(PASS);
    await mod.getByRole("button", { name: "Masuk" }).click();
    // Akun moderator dibuat lewat API (kunci Node) → di browser ini perangkat baru tanpa frasa kunci.
    await mod.getByRole("tab", { name: "Mulai baru" }).click();
    await mod.getByRole("checkbox").check();
    await mod.getByRole("button", { name: "Mulai dengan frasa kunci baru" }).click();
    await mod.getByText("Simpan frasa kunci perangkat").waitFor();
    await mod.getByRole("checkbox").check();
    await mod.getByRole("button", { name: "Frasa kunci sudah kusimpan" }).click();
    await mod.getByRole("button", { name: "Moderasi sengketa" }).click();
    await mod.getByText("Roasting kustom 2 Kg").waitFor();
    check(await mod.getByText(/bukan dark seperti disepakati/).isVisible(), "moderator membaca pernyataan pembeli");
    check(await mod.getByText(/Diserahkan langsung di Pasar Besar/).isVisible(), "moderator melihat bukti serah terima");
    await mod.getByRole("button", { name: "Refund ke pembeli" }).click();
    await mod.getByLabel(/alasan \(terenkripsi untuk kedua pihak\)/).fill("Penjual tidak membantah perbedaan tingkat roasting.");
    await mod.getByRole("button", { name: "Putuskan (final)" }).click();
    await mod.getByText("Tidak ada sengketa terbuka.").waitFor();
    await mod.screenshot({ path: join(OUT, "c5-moderator.png") });
    await roast.getByText(/Putusan moderator: dana dikembalikan ke pembeli/).waitFor();
    check(await roast.getByText("Penjual tidak membantah perbedaan tingkat roasting.").isVisible(), "pembeli melihat putusan & alasannya real-time");
    check(!(await buyer.getByRole("button", { name: "Moderasi sengketa" }).count()), "pengguna biasa tidak punya tombol moderasi");

    // Pembeli (non-PRO) menekan jabat tangan → diarahkan ke PRO, bukan error.
    await buyer.getByRole("button", { name: "Tawarkan kesepakatan rekber" }).click();
    await buyer.getByText("PINPath PRO").waitFor();
    check(true, "pengguna non-PRO diarahkan ke penjelasan PRO");
    await buyer.keyboard.press("Escape");

    const ov = await buyer.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
    check(ov.sw <= ov.vw, `kartu kesepakatan muat di layar HP (${ov.sw}/${ov.vw})`);
    await buyer.screenshot({ path: join(OUT, "c3-buyer-mobile-deals.png") });
    await seller.screenshot({ path: join(OUT, "c4-seller-chat.png") });
  } catch (e) {
    failures++;
    console.error("✖ skenario terhenti:", e);
  } finally {
    const real = problems.filter((p) => !/status of (401|404)/.test(p));
    check(real.length === 0, `tidak ada error console${real.length ? ":\n  " + real.join("\n  ") : ""}`);
    await browser?.close();
    server.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} pemeriksaan GAGAL` : "\nSemua pemeriksaan dagang LULUS");
    process.exit(failures ? 1 : 0);
  }
}

void main();
