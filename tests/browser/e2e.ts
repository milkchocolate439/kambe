// Uji ujung-ke-ujung di browser sungguhan (Chromium headless) terhadap build
// produksi: dua pengguna, undangan PIN, chat E2EE, D/R, PING, safety number,
// percobaan XSS, dan audit CSP/console. Jalankan: pnpm build && pnpm test:browser
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const PORT = 3311;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(import.meta.dirname, "out");
const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium";
const PASS = "kopi-hujan-rotan-senja";

let failures = 0;
function check(cond: unknown, label: string) {
  console.log(`${cond ? "✔" : "✖"} ${label}`);
  if (!cond) failures++;
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + "/")).ok) return;
    } catch {
      /* belum siap */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server tidak menyala");
}

function watch(page: Page, name: string, problems: string[]) {
  page.on("console", (m) => m.type() === "error" && problems.push(`[${name}] console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`[${name}] pageerror: ${e.message}`));
  // Catat setiap pelanggaran CSP — harus nol.
  void page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP: ${e.violatedDirective} ${e.blockedURI}`));
  });
}

async function signup(page: Page, alias: string) {
  await page.goto(BASE);
  await page.getByRole("tab", { name: "Daftar" }).click();
  await page.getByLabel("Alias (nama samaran)").fill(alias);
  await page.locator("#pass").fill(PASS);
  await page.locator("#pass2").fill(PASS);
  await page.getByRole("button", { name: "Buat akun" }).click();
  await page.getByText("Simpan kode pemulihan").waitFor();
  const code = await page.getByLabel("Kode pemulihan").textContent();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Lanjut ke PINPath" }).click();
  await page.getByText("Simpan frasa kunci perangkat").waitFor();
  const seed = await page.getByLabel("Frasa kunci perangkat").textContent();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Frasa kunci sudah kusimpan" }).click();
  await page.locator(".pin-big").waitFor();
  await page.locator(".dot.online").waitFor();
  return { code: code ?? "", seed: seed ?? "", pin: (await page.locator(".pin-big").textContent()) ?? "" };
}

/** Masuk di perangkat yang belum punya brankas → pilih "Mulai baru" (kunci baru). */
async function loginFreshDevice(page: Page, alias: string) {
  await page.goto(BASE);
  await page.getByLabel("Alias (nama samaran)").fill(alias);
  await page.locator("#pass").fill(PASS);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.getByRole("tab", { name: "Mulai baru" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Mulai dengan frasa kunci baru" }).click();
  await page.getByText("Simpan frasa kunci perangkat").waitFor();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Frasa kunci sudah kusimpan" }).click();
  await page.locator(".pin-big").waitFor();
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), "pinpath-e2e-"));
  const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), PINPATH_DB: join(dataDir, "e2e.db") },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let browser: Browser | null = null;
  const problems: string[] = [];
  try {
    await waitForServer();
    const html = await fetch(BASE + "/");
    check(/script-src 'self'/.test(html.headers.get("content-security-policy") ?? ""), "CSP ketat dikirim server");
    check(html.headers.get("x-frame-options") === "DENY", "anti-clickjacking aktif");

    browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
    // Alice memakai tema gelap, bob tema terang — keduanya ikut teruji secara visual.
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
    const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const alice = await ctxA.newPage();
    const bob = await ctxB.newPage();
    watch(alice, "alice", problems);
    watch(bob, "bob", problems);

    const a = await signup(alice, "Anon_Wolf99");
    check(/^[2-9A-HJ-NP-Z]{6}$/.test(a.pin), `alice mendapat PIN ${a.pin}`);
    check(/^([2-9A-HJ-NP-Z]{5}-){3}[2-9A-HJ-NP-Z]{5}$/.test(a.code), "kode pemulihan tampil sekali");
    await signup(bob, "KopiGayo_Roaster");
    await alice.screenshot({ path: join(OUT, "01-alice-home.png") });

    // Bob mengundang PIN alice (ketik huruf kecil + spasi: harus tetap diterima).
    await bob.getByLabel("PIN tujuan").fill(a.pin.toLowerCase().replace(/(...)/, "$1 "));
    await bob.getByLabel("Catatan undangan").fill("Mau tawarkan Gayo Wine Process");
    await bob.getByRole("button", { name: "Undang" }).click();
    await bob.getByText("Menunggu persetujuan").waitFor();
    check(!(await bob.getByText("Anon_Wolf99").count()), "alias tujuan tidak bocor sebelum disetujui");

    await alice.getByText("Undangan masuk").waitFor();
    check(await alice.getByText("Mau tawarkan Gayo Wine Process").isVisible(), "alice melihat catatan undangan bob");
    await alice.screenshot({ path: join(OUT, "02-alice-invite.png") });
    await alice.getByRole("button", { name: "Terima" }).click();
    await bob.getByRole("button", { name: /Anon_Wolf99/ }).waitFor();

    // Bob membuka chat & mengirim pesan berisi payload XSS.
    await bob.getByRole("button", { name: /Anon_Wolf99/ }).click();
    await bob.locator(".chat-head").waitFor();
    const overflow = await bob.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((el) => el.getBoundingClientRect().right > vw + 1)
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}.${el.className} → ${Math.round(el.getBoundingClientRect().right)}px`);
      return { vw, sw: document.documentElement.scrollWidth, wide };
    });
    check(overflow.sw <= overflow.vw, `tidak ada scroll horizontal di HP (lebar ${overflow.sw}/${overflow.vw})${overflow.wide.length ? "\n  " + overflow.wide.join("\n  ") : ""}`);
    const XSS = `Halo! <img src=x onerror="window.__xss=1"> <script>window.__xss=2</script>`;
    await bob.getByLabel("Tulis pesan").fill(XSS);
    await bob.getByRole("button", { name: "Kirim" }).click();

    await alice.getByRole("button", { name: /KopiGayo_Roaster/ }).click();
    await alice.getByText("Halo! <img", { exact: false }).waitFor();
    check((await alice.evaluate(() => (window as unknown as { __xss?: number }).__xss)) === undefined, "payload XSS tampil sebagai teks, TIDAK dieksekusi");
    check((await alice.locator(".messages img").count()) === 0, "tidak ada elemen <img> yang disuntikkan");

    // Bob seharusnya melihat status R setelah alice membaca.
    await bob.locator(".status.R").first().waitFor({ timeout: 5000 });
    check(true, "status BBM berubah menjadi R setelah dibaca");

    // Alice mengirim pesan berpola penipuan → bob mendapat peringatan di perangkatnya.
    await alice.getByLabel("Tulis pesan").fill("Boleh minta kode OTP kamu? biar saya proses");
    await alice.keyboard.press("Enter");
    await bob.getByText("Boleh minta kode OTP").waitFor();
    check(await bob.getByText("Jangan pernah membagikan OTP").isVisible(), "peringatan anti-penipuan muncul untuk penerima");

    // PING!!! dari bob.
    await bob.getByRole("button", { name: "PING!!!" }).click();
    await alice.locator(".ping-pill", { hasText: "KOPIGAYO_ROASTER MENGIRIM PING!!!" }).waitFor();
    check(true, "PING!!! diterima secara real-time");
    await bob.getByRole("button", { name: "PING!!!" }).click();
    await bob.getByText(/PING!!! bisa dikirim lagi dalam/).waitFor();
    check(true, "PING!!! kedua dalam 30 detik ditahan (anti-teror)");

    // Safety number identik di kedua sisi.
    await alice.getByRole("button", { name: /ketuk untuk verifikasi/ }).click();
    const snA = (await alice.getByLabel("Angka safety number").textContent())?.replace(/\s/g, "");
    await bob.getByRole("button", { name: /ketuk untuk verifikasi/ }).click();
    const snB = (await bob.getByLabel("Angka safety number").textContent())?.replace(/\s/g, "");
    check(!!snA && snA.length === 60 && snA === snB, "safety number 60 digit identik di kedua perangkat");
    await alice.screenshot({ path: join(OUT, "03-alice-safety.png") });
    await alice.getByRole("button", { name: /Angka cocok/ }).click();
    await alice.getByText("Terenkripsi · terverifikasi").waitFor();
    check(true, "kontak bisa ditandai terverifikasi");
    await bob.keyboard.press("Escape");

    await alice.screenshot({ path: join(OUT, "04-alice-chat.png") });
    await bob.screenshot({ path: join(OUT, "05-bob-mobile-chat.png") });

    // Server hanya menyimpan ciphertext: periksa langsung via API bob.
    const apiDump = await bob.evaluate(async () => {
      const contacts = await (await fetch("/api/contacts")).json();
      const peer = contacts.contacts[0].id;
      return JSON.stringify(await (await fetch(`/api/messages/${peer}`)).json());
    });
    check(!apiDump.includes("OTP") && !apiDump.includes("Halo!"), "respons server berisi ciphertext saja, tanpa plaintext");
    const relay = JSON.parse(apiDump) as { pending: unknown[]; statuses: unknown[] };
    check(relay.pending.length === 0 && relay.statuses.length >= 1, "relay: pesan yang sudah diterima tidak lagi disimpan server (hanya status)");

    // Muat ulang: pesan lama tetap bisa dibuka (kunci tersimpan di IndexedDB perangkat).
    await alice.reload();
    await alice.getByRole("button", { name: /KopiGayo_Roaster/ }).click();
    await alice.getByText("Boleh minta kode OTP").waitFor();
    check(true, "setelah reload, riwayat terdekripsi lagi dari kunci perangkat");

    // Bob ganti perangkat TANPA frasa kunci ("mulai baru") → alice dapat peringatan safety number berubah.
    const ctxB2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const bob2 = await ctxB2.newPage();
    watch(bob2, "bob2", problems);
    await loginFreshDevice(bob2, "KopiGayo_Roaster");
    await alice.getByText(/Safety number dengan KopiGayo_Roaster berubah/).waitFor({ timeout: 8000 });
    check(true, "alice diperingatkan saat kunci bob berubah (deteksi MITM)");
    check(await alice.getByLabel("Tulis pesan").isDisabled(), "pengiriman dikunci sampai alice meninjau perubahan");
    await bob.getByText("Akunmu sekarang aktif di perangkat lain").waitFor({ timeout: 8000 });
    check(true, "perangkat lama bob diberi tahu akun aktif di perangkat lain");
    await alice.screenshot({ path: join(OUT, "06-alice-key-changed.png") });
    await ctxB2.close();
  } catch (e) {
    failures++;
    console.error("✖ skenario terhenti:", e);
  } finally {
    const real = problems.filter((p) => !/Failed to load resource: the server responded with a status of (401|404)/.test(p));
    check(real.length === 0, `tidak ada error console / pelanggaran CSP${real.length ? ":\n  " + real.join("\n  ") : ""}`);
    await browser?.close();
    server.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} pemeriksaan GAGAL` : "\nSemua pemeriksaan browser LULUS");
    process.exit(failures ? 1 : 0);
  }
}

void main();
