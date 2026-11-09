// Buat aset Android/PWA dari sumber di repo (tanpa unduhan apa pun):
//  - ikon PNG 192/512 + maskable 512 dari client/public/icon.svg (dirender Chromium)
//  - bunyi notifikasi "SSSSSTTT!!" → android/sssttt.wav (algoritma sama dengan client/src/lib/sound.ts)
// Pakai: node --import tsx scripts/make-android-assets.ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const root = join(import.meta.dirname, "..");

async function icons() {
  const svg = readFileSync(join(root, "client/public/icon.svg"), "utf8");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (size: number, file: string, maskable: boolean) => {
    const pad = maskable ? Math.round(size * 0.18) : 0; // zona aman ikon maskable (lingkaran 80%)
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:${maskable ? "#0E0B0A" : "transparent"};width:${size}px;height:${size}px;display:grid;place-items:center">` +
        `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" style="width:${size - 2 * pad}px;height:${size - 2 * pad}px"></body></html>`,
    );
    await page.waitForFunction(() => document.querySelector("img")!.complete);
    await page.screenshot({ path: join(root, "client/public", file), omitBackground: !maskable });
  };
  await render(192, "icon-192.png", false);
  await render(512, "icon-512.png", false);
  await render(512, "icon-maskable-512.png", true);
  await browser.close();
}

/** Biquad RBJ sederhana (bandpass skirt-konstan / highpass). */
function biquad(type: "bandpass" | "highpass", sr: number, freqAt: (i: number) => number, q: number) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x: number, i: number) => {
    const w0 = (2 * Math.PI * freqAt(i)) / sr;
    const alpha = Math.sin(w0) / (2 * q);
    const cos = Math.cos(w0);
    let b0, b1, b2;
    if (type === "bandpass") [b0, b1, b2] = [alpha, 0, -alpha];
    else [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
    const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

function sssttt(): Buffer {
  const sr = 44100;
  const n = Math.ceil(sr * 1.0);
  const out = new Float32Array(n);
  // "SSSSS" 0–0,6 dtk: desis bandpass 4,8→7,4 kHz dengan amplop naik-tahan-turun.
  const bp = biquad("bandpass", sr, (i) => 4800 + (2600 * Math.min(i, 0.55 * sr)) / (0.55 * sr), 0.9);
  for (let i = 0; i < 0.65 * sr; i++) {
    const t = i / sr;
    const env = t < 0.07 ? t / 0.07 : t < 0.48 ? 1 : Math.max(0, 1 - (t - 0.48) / 0.12);
    out[i] += bp(Math.random() * 2 - 1, i) * env * 0.9;
  }
  // "T T": dua ketukan highpass pendek.
  for (const at of [0.68, 0.82]) {
    const hp = biquad("highpass", sr, () => 2600, 0.707);
    const s0 = Math.floor(at * sr);
    for (let k = 0; k < 0.05 * sr; k++) {
      const t = k / sr;
      const env = t < 0.005 ? t / 0.005 : Math.exp(-(t - 0.005) * 90);
      out[s0 + k] += hp(Math.random() * 2 - 1, k) * env * 1.1;
    }
  }
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const pcm = Buffer.alloc(44 + n * 2);
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write("WAVE", 8);
  pcm.write("fmt ", 12); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(sr, 24); pcm.writeUInt32LE(sr * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
  pcm.write("data", 36); pcm.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round((out[i] / peak) * 0.85 * 32767), 44 + i * 2);
  return pcm;
}

await icons();
mkdirSync(join(root, "android"), { recursive: true });
writeFileSync(join(root, "android/sssttt.wav"), sssttt());
console.log("ikon PNG & android/sssttt.wav dibuat");
