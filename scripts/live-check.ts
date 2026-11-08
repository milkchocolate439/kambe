// Uji asap alamat KAMBE yang sudah online (dari luar, lewat internet).
// Pakai: node --import tsx scripts/live-check.ts https://alamat-kambe
// Memeriksa: halaman, /api/config, header keamanan, daftar akun (cookie Secure), sesi, WebSocket E2EE relay,
// dan bahwa permintaan dari Origin asing ditolak. Membuat 2 akun uji bernama "Uji_Live_<acak>".
import WebSocket from "ws";

const BASE = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(BASE)) {
  console.error("Pakai: node --import tsx scripts/live-check.ts https://alamat-kambe");
  process.exit(2);
}
let failures = 0;
const check = (ok: unknown, label: string, detail = "") => {
  console.log(`${ok ? "✔" : "✖"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function signup(alias: string) {
  const r = await fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ alias, passphrase: "kopi-hujan-rotan-senja-live" }),
  });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  return { status: r.status, cookie, setCookie: r.headers.get("set-cookie") ?? "", body: (await r.json()) as { me?: { id: string; pin: string } } };
}

async function main() {
  const page = await fetch(BASE + "/");
  const html = await page.text();
  check(page.status === 200 && html.includes("<div id=\"root\""), "halaman utama tersaji", `${page.status}`);
  const h = page.headers;
  check(/default-src 'self'/.test(h.get("content-security-policy") ?? ""), "CSP ketat aktif");
  check(BASE.startsWith("http://") || /max-age=/.test(h.get("strict-transport-security") ?? ""), "HSTS aktif (HTTPS)");
  check(h.get("x-frame-options") === "DENY" || /frame-ancestors 'none'/.test(h.get("content-security-policy") ?? ""), "anti-clickjacking");

  const cfg = (await (await fetch(BASE + "/api/config")).json()) as { paymentProvider: string; freePlatform: boolean; feePerMille: number; notaryPublicKey: string };
  check(cfg.paymentProvider === "langsung" && cfg.freePlatform === true && cfg.feePerMille === 0, "mode produk: gratis + pembayaran langsung", JSON.stringify({ p: cfg.paymentProvider, free: cfg.freePlatform }));
  check(typeof cfg.notaryPublicKey === "string" && cfg.notaryPublicKey.length === 44, "kunci publik notaris tersedia");

  const tag = Math.random().toString(36).slice(2, 7);
  const a = await signup(`Uji_Live_A${tag}`);
  check(a.status === 200 && !!a.body.me?.pin, "daftar akun lewat internet", `${a.status}`);
  check(/;\s*Secure/i.test(a.setCookie) && /HttpOnly/i.test(a.setCookie), "cookie sesi Secure + HttpOnly");

  const evil = await fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://situs-jahat.example" },
    body: JSON.stringify({ alias: `Uji_Jahat${tag}`, passphrase: "kopi-hujan-rotan-senja-live" }),
  });
  check(evil.status === 403, "permintaan dari Origin asing ditolak (anti-CSRF)", `${evil.status}`);

  const me = await fetch(`${BASE}/api/me`, { headers: { cookie: a.cookie } });
  check(me.status === 200, "sesi bertahan (GET /api/me)", `${me.status}`);

  const wsUrl = BASE.replace(/^http/, "ws") + "/ws";
  const hello = await new Promise<string>((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { cookie: a.cookie, origin: BASE } });
    const t = setTimeout(() => (ws.terminate(), resolve("timeout")), 15000);
    ws.on("message", (d) => {
      clearTimeout(t);
      ws.close();
      resolve(JSON.parse(String(d)).t as string);
    });
    ws.on("error", (e) => (clearTimeout(t), resolve(`error ${e.message}`)));
  });
  check(hello === "hello", "WebSocket realtime tersambung lewat internet", hello);

  const wsEvil = await new Promise<string>((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { cookie: a.cookie, origin: "https://situs-jahat.example" } });
    const t = setTimeout(() => (ws.terminate(), resolve("timeout")), 15000);
    ws.on("open", () => (clearTimeout(t), ws.close(), resolve("open")));
    ws.on("unexpected-response", (_r, res) => (clearTimeout(t), resolve(`ditolak ${res.statusCode}`)));
    ws.on("error", () => (clearTimeout(t), resolve("ditolak")));
  });
  check(wsEvil.startsWith("ditolak"), "WebSocket dari Origin asing ditolak", wsEvil);

  console.log(failures ? `\n${failures} pemeriksaan GAGAL` : `\nSemua pemeriksaan LULUS — ${BASE}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("✖ terhenti:", e);
  process.exit(1);
});
