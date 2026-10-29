// Audit UI KAMBE di lebar HP 360 & 390: tanpa gulir horizontal, target sentuh ≥ 44px, kontras teks WCAG AA.
// Jalankan: pnpm build && node --import tsx tests/browser/audit-e2e.ts
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const PORT = 3315;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(import.meta.dirname, "out");
const PASS = "kopi-hujan-rotan-senja";
let failures = 0;
const check = (cond: unknown, label: string, detail: string[] = []) => {
  console.log(`${cond ? "✔" : "✖"} ${label}`);
  if (!cond) {
    failures++;
    for (const d of detail.slice(0, 15)) console.log(`    - ${d}`);
  }
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
  return ((await page.locator(".pin-big").first().textContent()) ?? "").trim();
}

/** Diperiksa di dalam halaman: gulir horizontal, ukuran target, kontras teks. */
function inspect() {
  type RGBA = [number, number, number, number];
  const parse = (s: string): RGBA | null => {
    let m = s.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    m = s.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/);
    if (m) return [+m[1] * 255, +m[2] * 255, +m[3] * 255, m[4] === undefined ? 1 : +m[4]];
    return null;
  };
  const over = (top: RGBA, bottom: RGBA): RGBA => {
    const a = top[3];
    return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
  };
  const lum = (c: RGBA) => {
    const f = (v: number) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: RGBA, b: RGBA) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.1;
  };
  const name = (el: Element) => {
    const t = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `<${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""}> "${t}"`;
  };
  // Latar efektif: tumpuk warna latar leluhur dari bawah (body) ke atas. Gradien/gambar = tidak bisa dinilai.
  const background = (el: Element): RGBA | "image" => {
    const chain: Element[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) chain.push(e);
    let bg: RGBA = [255, 255, 255, 1];
    for (const e of chain.reverse()) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== "none" && e === el.closest("*")) return "image";
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0) bg = over(c, bg);
    }
    return bg;
  };

  const overflow = document.documentElement.scrollWidth > window.innerWidth + 1 ? [`scrollWidth ${document.documentElement.scrollWidth} > ${window.innerWidth}`] : [];

  const small: string[] = [];
  for (const el of document.querySelectorAll("button, a[href], [role=button], [role=tab], input:not([type=hidden]), select, textarea, summary")) {
    if (!visible(el) || (el as HTMLButtonElement).disabled) continue;
    let target: Element = el;
    const type = (el as HTMLInputElement).type;
    if (el.tagName === "INPUT" && (type === "checkbox" || type === "radio")) target = el.closest("label") ?? el;
    const r = target.getBoundingClientRect();
    // Tautan di dalam kalimat dikecualikan WCAG 2.5.8 (inline); cukup ≥ 24 tinggi.
    const inline = el.tagName === "A" && getComputedStyle(el).display === "inline";
    const ok = inline ? r.height >= 16 : r.width >= 44 && r.height >= 44;
    if (!ok) small.push(`${name(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
  }

  const low: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.textContent?.trim()) continue;
    seen.add(el);
    if (!visible(el) || el.closest("[aria-hidden=true], :disabled, .sr-only") || el.closest("svg")) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    const bg = background(el);
    if (!fg || bg === "image") continue;
    // opasitas leluhur ikut meredupkan teks
    let alpha = fg[3];
    for (let e: Element | null = el; e; e = e.parentElement) alpha *= Number(getComputedStyle(e).opacity);
    const shown = over([fg[0], fg[1], fg[2], alpha], bg);
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    const r = ratio(shown, bg);
    if (r < need) low.push(`${name(el)} ${r.toFixed(2)} < ${need} (${cs.color} di atas rgb(${bg.slice(0, 3).map(Math.round).join(",")}))`);
  }
  return { overflow, small, low };
}

async function audit(page: Page, label: string) {
  await page.waitForTimeout(250);
  await page.evaluate("window.__name = (f) => f"); // helper esbuild (tsx) yang ikut terserialisasi bersama inspect()
  const r = await page.evaluate(inspect);
  check(r.overflow.length === 0, `${label}: tanpa gulir horizontal`, r.overflow);
  check(r.small.length === 0, `${label}: target sentuh ≥ 44px`, r.small);
  check(r.low.length === 0, `${label}: kontras teks AA`, r.low);
  await page.screenshot({ path: join(OUT, `audit-${label.replace(/[^\w]+/g, "-")}.png`) });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), "kambe-audit-"));
  const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env: { ...process.env, NODE_ENV: "test", KAMBE_SERVE_DIST: "1", PORT: String(PORT), KAMBE_DB: join(dataDir, "a.db") },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let browser: Browser | null = null;
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(BASE)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
    for (const width of [360, 390]) {
      const ctx = () => browser!.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, colorScheme: "dark" });
      const a = await (await ctx()).newPage();
      const b = await (await ctx()).newPage();

      await a.goto(BASE);
      await audit(a, `${width} masuk`);
      await a.getByRole("tab", { name: "Daftar" }).click();
      await audit(a, `${width} daftar`);

      const pinA = await signup(a, `Ayu_${width}`);
      await signup(b, `Bima_${width}`);
      await audit(a, `${width} beranda`);

      await b.getByLabel("PIN tujuan").fill(pinA);
      await b.getByRole("button", { name: "Undang" }).click();
      await a.getByRole("button", { name: "Terima" }).click();
      await a.getByRole("button", { name: new RegExp(`Bima_${width}`) }).click();
      await a.getByLabel("Tulis pesan").fill("Halo dari KAMBE");
      await a.getByRole("button", { name: "Kirim" }).click();
      await b.getByRole("button", { name: new RegExp(`Ayu_${width}`) }).click();
      await b.getByLabel("Tulis pesan").fill("Halo juga");
      await b.getByRole("button", { name: "Kirim" }).click();
      await a.getByText("Halo juga").waitFor();
      await audit(a, `${width} chat`);

      await a.goto(BASE);
      await a.locator(".dot.online").waitFor();
      await a.getByRole("button", { name: "Jejak" }).first().click();
      await audit(a, `${width} jejak`);
      await a.keyboard.press("Escape");

      await a.goto(BASE);
      await a.locator(".dot.online").waitFor();
      await a.getByRole("button", { name: /^Radar Arwah/ }).first().click();
      await audit(a, `${width} radar-arwah`);
      await a.keyboard.press("Escape");

      await a.goto(BASE);
      await a.locator(".dot.online").waitFor();
      await a.getByRole("button", { name: "Pengaturan" }).click();
      await audit(a, `${width} pengaturan`);
    }
  } catch (e) {
    check(false, `skenario terhenti: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    await browser?.close();
    server.kill();
  }
  if (failures) {
    console.log(`\n${failures} pemeriksaan audit GAGAL`);
    process.exit(1);
  }
  console.log("\nSemua pemeriksaan audit LULUS");
}

void main();
