// Uji browser Etalase Hantu: katalog di HP penjual → diminta pembeli lewat pesan kendali E2EE →
// pesanan → tawaran rekber otomatis. Termasuk: penjual offline lalu menyala (zero-click),
// tanpa gelembung chat untuk pesan kendali, tanpa teks polos di disk, dan katalog pembeli hanya di memori.
// Jalankan: pnpm build && pnpm test:browser
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const PORT = 3316;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(import.meta.dirname, "out");
const PASS = "kopi-hujan-rotan-senja";
const ITEM = "Arabica Gayo 1 Kg";
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

async function openGhost(page: Page, peerName: RegExp) {
  await page.getByRole("button", { name: peerName }).click();
  await page.getByRole("button", { name: "Menu kontak" }).click();
  await page.getByRole("button", { name: /Etalase Hantu/ }).click();
  await page.getByRole("dialog", { name: "Etalase Hantu" }).waitFor();
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
  const dataDir = mkdtempSync(join(tmpdir(), "kambe-ghost-"));
  const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, NODE_ENV: "test", KAMBE_SERVE_DIST: "1", PORT: String(PORT), KAMBE_DB: join(dataDir, "g.db") },
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
    const sellerCtx = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
    let seller = await sellerCtx.newPage();
    const buyer = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    const watch = (p: Page, n: string) => {
      p.on("console", (m) => m.type() === "error" && problems.push(`[${n}] ${m.text()}`));
      p.on("pageerror", (e) => problems.push(`[${n}] ${e.message}`));
    };
    watch(seller, "seller");
    watch(buyer, "buyer");

    const sellerPin = await signup(seller, "Gayo_Penjual");
    await signup(buyer, "Pembeli_Hantu");
    await buyer.getByLabel("PIN tujuan").fill(sellerPin);
    await buyer.getByRole("button", { name: "Undang" }).click();
    await seller.getByRole("button", { name: "Terima" }).click();
    await buyer.getByRole("button", { name: /Gayo_Penjual/ }).waitFor();

    // Penjual: PRO (agar pesanan bisa jadi tawaran rekber) + pajang barang.
    await seller.getByRole("button", { name: "Toko & Dompet" }).click();
    await seller.getByRole("button", { name: "Aktifkan PRO (simulasi)" }).click();
    await seller.getByText(/Aktif sampai/).waitFor();
    await seller.keyboard.press("Escape");
    await openGhost(seller, /Pembeli_Hantu/);
    await seller.getByRole("tab", { name: /Etalase Saya/ }).click();
    const addBtn = seller.getByRole("button", { name: /Pajang di Etalase Hantu|Isi nama barang|Harga minimal/ });
    check(await addBtn.isDisabled(), "tombol pajang terkunci sampai nama & harga sah");
    await seller.locator("#gs-title").fill(ITEM);
    await seller.locator("#gs-price").fill("125000");
    check((await seller.locator("#gs-price").inputValue()) === "125.000", "harga diformat rupiah");
    await seller.locator("#gs-desc").fill("Panen terbaru, roast medium");
    await seller.getByRole("button", { name: "Pajang di Etalase Hantu" }).click();
    await seller.getByRole("dialog").getByText(ITEM).waitFor();
    check(await seller.getByText(/hangus dalam 2 hari/).isVisible(), "barang hangus otomatis 72 jam (≈ 2 hari 23 jam)");
    await seller.screenshot({ path: join(OUT, "g1-seller-ghost.png") });
    const sellerDisk = await dumpDisk(seller);
    check(!sellerDisk.includes(ITEM) && !sellerDisk.includes("Panen terbaru"), "katalog penjual terenkripsi di disk (tanpa teks polos)");
    await seller.keyboard.press("Escape");

    // Penjual OFFLINE (tab ditutup) saat pembeli membuka etalase.
    await seller.close();
    await openGhost(buyer, /Gayo_Penjual/);
    await buyer.getByRole("dialog").getByText(/Menghubungi HP Gayo_Penjual/).waitFor();
    check(true, "pembeli melihat 'menghubungi HP penjual' saat penjual offline");

    // Penjual menyala lagi → pesan kendali yang menunggu di relay diproses otomatis (zero-click).
    seller = await sellerCtx.newPage();
    watch(seller, "seller2");
    await seller.goto(BASE);
    await seller.locator(".dot.online").waitFor({ timeout: 15000 });
    await buyer.getByRole("dialog").getByText(ITEM).waitFor({ timeout: 30000 });
    check(true, "katalog sampai ke pembeli setelah HP penjual menyala (zero-click, tanpa membuka chat)");
    const dlg = buyer.getByRole("dialog");
    check((await dlg.textContent())?.includes("Rp125.000") === true, "harga & deskripsi tampil di etalase pembeli");
    check((await dlg.textContent())?.includes("Panen terbaru, roast medium") === true, "deskripsi tampil");
    await buyer.screenshot({ path: join(OUT, "g2-buyer-ghost.png") });

    // Pesan → tawaran rekber otomatis dari HP penjual.
    await dlg.getByRole("button", { name: "Pesan", exact: true }).click();
    await dlg.getByText(/Tawaran masuk di chat/).waitFor({ timeout: 20000 });
    await buyer.keyboard.press("Escape");
    const card = buyer.locator(".deal-card", { hasText: ITEM });
    await card.waitFor();
    check((await card.textContent())?.includes("Rp125.000") === true, "tawaran rekber otomatis dengan harga dari katalog penjual");
    check((await card.textContent())?.includes("Gratis") === true, "escrow gratis tampil di tawaran");
    check(await card.getByRole("button", { name: "Bayar ke rekber" }).isVisible(), "pembeli yang membayar — uang tidak bergerak otomatis");

    // Pesan kendali tidak tampil sebagai chat & tidak menambah 'belum dibaca'.
    await buyer.waitForTimeout(800);
    check((await buyer.locator(".bubble").count()) === 0, "tidak ada gelembung chat dari pesan kendali (pembeli)");
    await seller.getByRole("button", { name: /Pembeli_Hantu/ }).click();
    await seller.locator(".deal-card", { hasText: ITEM }).waitFor();
    check((await seller.locator(".bubble").count()) === 0, "tidak ada gelembung chat dari pesan kendali (penjual)");
    check((await seller.locator(".sidebar .item .count").count()) === 0, "pesan kendali tidak menambah hitungan belum dibaca");

    // Katalog pembeli hanya di memori: tidak ada di disk pembeli, dan hilang setelah jendela ditutup.
    const buyerDisk = await dumpDisk(buyer);
    check(!buyerDisk.includes(ITEM) && !buyerDisk.includes("Panen terbaru"), "katalog lawan TIDAK tersimpan di disk pembeli");
    // Server tidak pernah melihat isi katalog.
    const dump = await buyer.evaluate(async () => {
      const c = await (await fetch("/api/contacts")).json();
      return JSON.stringify(await (await fetch(`/api/messages/${c.contacts[0].id}`)).json());
    });
    check(!dump.includes("Arabica") && !dump.includes("125000"), "server tidak melihat isi katalog (hanya ciphertext)");

    // Barang yang dihapus penjual tidak bisa dipesan (item_gone).
    await seller.getByRole("button", { name: "Menu kontak" }).click();
    await seller.getByRole("button", { name: /Etalase Hantu/ }).click();
    await seller.getByRole("tab", { name: /Etalase Saya/ }).click();
    await seller.getByRole("button", { name: `Hapus ${ITEM}` }).click();
    await seller.getByText("Belum ada barang yang dipajang.").waitFor();
    check(true, "penjual bisa menghapus barang dari etalase");
    await seller.keyboard.press("Escape");
    await buyer.getByRole("button", { name: "Menu kontak" }).click();
    await buyer.getByRole("button", { name: /Etalase Hantu/ }).click();
    await buyer.getByRole("dialog").getByText(/belum memajang barang/).waitFor({ timeout: 20000 });
    check(true, "etalase kosong setelah penjual menghapus barang");
    await buyer.screenshot({ path: join(OUT, "g3-buyer-empty.png") });
  } catch (e) {
    failures++;
    console.error("✖ skenario terhenti:", e);
  } finally {
    const real = problems.filter((p) => !/Failed to load resource: the server responded with a status of (401|404)/.test(p));
    check(real.length === 0, `tidak ada error console${real.length ? ":\n  " + real.join("\n  ") : ""}`);
    await browser?.close();
    server.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} pemeriksaan GAGAL` : "\nSemua pemeriksaan Etalase Hantu LULUS");
    process.exit(failures ? 1 : 0);
  }
}

void main();
