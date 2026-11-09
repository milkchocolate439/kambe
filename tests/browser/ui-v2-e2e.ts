// Uji browser UI v2: daftar obrolan di atas, chip filter, baris cerita, dock HP, profil kontak.
// Jalankan: pnpm build && pnpm test:browser
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const PORT = 3317;
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

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), "kambe-uiv2-"));
  const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, NODE_ENV: "test", KAMBE_SERVE_DIST: "1", PORT: String(PORT), KAMBE_DB: join(dataDir, "u.db") },
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
    const mobile = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    const desk = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    for (const [p, n] of [[mobile, "mobile"], [desk, "desktop"]] as const) {
      p.on("console", (m) => m.type() === "error" && problems.push(`[${n}] ${m.text()}`));
      p.on("pageerror", (e) => problems.push(`[${n}] ${e.message}`));
    }

    const pinM = await signup(mobile, "Ayu_Mobile");
    await signup(desk, "Bima_Desktop");
    await desk.getByLabel("PIN tujuan").fill(pinM);
    await desk.getByRole("button", { name: "Undang" }).click();
    await mobile.getByRole("button", { name: "Terima" }).click();
    await mobile.locator(".glass-item").waitFor(); // item kontak sungguhan (bukan tombol "Blokir Bima_Desktop" di kartu undangan)

    // Pengguna baru (belum ada kontak) melihat kartu PIN dulu; setelah punya kontak, daftar obrolan di atas.
    await mobile.evaluate("window.__name = (f) => f"); // helper esbuild (tsx) yang ikut terserialisasi
    const order = await mobile.evaluate(() => {
      const y = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().top ?? Infinity;
      return { chats: y(".chats"), hero: y(".hero-card") };
    });
    check(order.chats < order.hero, "punya kontak: daftar obrolan jadi layar utama (kartu PIN pindah ke Profil)");
    check((await mobile.getByRole("heading", { name: "Obrolan" }).count()) === 1, "judul besar 'Obrolan'");

    // Dock HP.
    check(await mobile.getByRole("navigation", { name: "Navigasi utama" }).isVisible(), "dock navigasi pil tampil di HP");
    check(await mobile.getByRole("button", { name: "Tambah kontak" }).first().isVisible(), "tombol tambah (+) melayang tampil");
    check((await mobile.getByRole("button", { name: "Pengaturan" }).count()) === 1, "satu tombol Pengaturan saja yang terlihat (topbar disembunyikan di layar daftar)");
    check((await overflow(mobile)) <= 1, "HP: tanpa gulir horizontal");
    await mobile.screenshot({ path: join(OUT, "u1-mobile-list.png") });

    // Chip filter: pesan masuk → "Belum dibaca" menyaring.
    await desk.getByRole("button", { name: /Ayu_Mobile/ }).click();
    await desk.getByLabel("Tulis pesan").fill("Halo dari desktop");
    await desk.getByRole("button", { name: "Kirim" }).click();
    await mobile.getByRole("button", { name: /Belum dibaca \(1\)/ }).waitFor();
    const sst = await mobile.evaluate(() => Number(document.documentElement.dataset.sst ?? 0));
    check(sst >= 1, `pesan masuk berbunyi "SSSSSTTT!!" (${sst}×)`);
    await mobile.getByRole("button", { name: /Belum dibaca/ }).click();
    check((await mobile.getByRole("button", { name: /Bima_Desktop/ }).count()) === 1, "filter 'Belum dibaca' menampilkan kontak yang mengirim pesan");
    await mobile.getByRole("button", { name: "Terverifikasi" }).click();
    await mobile.getByText("Tidak ada obrolan yang cocok.").waitFor();
    check(true, "filter 'Terverifikasi' kosong sebelum ada yang diverifikasi");
    await mobile.getByRole("button", { name: "Semua" }).click();

    // Pencarian kontak.
    await mobile.getByRole("button", { name: "Cari obrolan" }).click();
    await mobile.getByLabel("Cari nama kontak").fill("zzz");
    await mobile.getByText("Tidak ada obrolan yang cocok.").waitFor();
    await mobile.getByLabel("Cari nama kontak").fill("bima");
    check((await mobile.getByRole("button", { name: /Bima_Desktop/ }).count()) === 1, "pencarian kontak (tanpa peduli huruf besar)");
    await mobile.getByRole("button", { name: "Cari obrolan" }).click();

    // Buka chat → dock hilang, topbar aksi kembali.
    await mobile.getByRole("button", { name: /Bima_Desktop/ }).click();
    await mobile.getByText("Halo dari desktop").waitFor();
    check(!(await mobile.getByRole("navigation", { name: "Navigasi utama" }).isVisible()), "chat terbuka: dock disembunyikan (ruang untuk kotak ketik)");
    check(await mobile.getByRole("button", { name: "Pengaturan" }).isVisible(), "chat terbuka: tombol Pengaturan topbar kembali");

    // Profil kontak.
    await mobile.getByRole("button", { name: "Profil kontak" }).click();
    const dlg = mobile.getByRole("dialog", { name: "Bima_Desktop" });
    await dlg.waitFor();
    check((await dlg.textContent())?.includes("Pesan") === true && (await dlg.textContent())?.includes("Kesepakatan") === true && (await dlg.textContent())?.includes("Jejak") === true, "profil: kartu statistik Pesan · Kesepakatan · Jejak");
    check((await dlg.locator(".stat-value").first().textContent()) === "1", "profil: jumlah pesan dihitung dari riwayat perangkat");
    check((await dlg.textContent())?.includes("PIN ") === true, "profil: PIN Kambe tampil sebagai pengganti nomor HP");
    await mobile.screenshot({ path: join(OUT, "u2-mobile-profile.png") });
    await dlg.getByRole("button", { name: "Nomor keamanan" }).click();
    await mobile.getByRole("dialog", { name: "Safety number" }).waitFor();
    check(true, "profil → Nomor keamanan membuka dialog safety number");
    await mobile.keyboard.press("Escape");

    // Desktop: dua kolom, tombol tambah di header daftar, tanpa dock.
    await desk.keyboard.press("Escape");
    check(!(await desk.getByRole("navigation", { name: "Navigasi utama" }).isVisible()), "desktop: tanpa dock");
    check(await desk.getByRole("button", { name: "Tambah kontak" }).isVisible(), "desktop: tombol tambah kontak di header Obrolan");
    await desk.screenshot({ path: join(OUT, "u3-desktop.png") });

    // Popup Web Push: kirim push sungguhan ke service worker lewat DevTools Protocol.
    check(await desk.getByRole("button", { name: "Notifikasi" }).isVisible(), "tombol lonceng notifikasi tersedia");
    await desk.context().grantPermissions(["notifications"], { origin: BASE });
    await desk.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    const cdp = await desk.context().newCDPSession(desk);
    const regs: string[] = [];
    cdp.on("ServiceWorker.workerRegistrationUpdated", (e: { registrations: { registrationId: string; scopeURL: string }[] }) => {
      for (const r of e.registrations) if (r.scopeURL.startsWith(BASE)) regs.push(r.registrationId);
    });
    await cdp.send("ServiceWorker.enable");
    for (let i = 0; i < 20 && !regs.length; i++) await desk.waitForTimeout(100);
    await cdp.send("ServiceWorker.deliverPushMessage", {
      origin: BASE + "/",
      registrationId: regs[0],
      data: JSON.stringify({ title: "SSSSSTTT!!", body: "Pesan baru dari Ayu_Mobile", tag: "kambe-uji", url: "/" }),
    });
    let shown: string[] = [];
    for (let i = 0; i < 30 && !shown.length; i++) {
      await desk.waitForTimeout(200);
      shown = await desk.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => `${n.title}|${n.body}`));
    }
    check(shown.includes("SSSSSTTT!!|Pesan baru dari Ayu_Mobile"), `popup notifikasi muncul dari push (${shown.join(", ") || "tidak ada"})`);
  } catch (e) {
    failures++;
    console.error("✖ skenario terhenti:", e);
  } finally {
    const real = problems.filter((p) => !/Failed to load resource: the server responded with a status of (401|404)/.test(p));
    check(real.length === 0, `tidak ada error console${real.length ? ":\n  " + real.join("\n  ") : ""}`);
    await browser?.close();
    server.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} pemeriksaan GAGAL` : "\nSemua pemeriksaan UI v2 LULUS");
    process.exit(failures ? 1 : 0);
  }
}

void main();
