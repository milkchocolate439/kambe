// Bukti pindah server: data lama ikut & kunci notaris sama.
// Pakai: node --import tsx scripts/live-migrated.ts https://alamat-baru <alias-akun-uji-lama> <kunci-publik-notaris-lama>
// Akun uji dibuat oleh scripts/live-browser.ts (passphrase uji publik di skrip itu), bukan akun pengguna sungguhan.
const [BASE_RAW, ALIAS, NOTARY] = process.argv.slice(2);
if (!BASE_RAW || !ALIAS || !NOTARY) {
  console.error("Pakai: node --import tsx scripts/live-migrated.ts https://alamat-baru <alias-uji> <kunci-publik-notaris>");
  process.exit(2);
}
const BASE = BASE_RAW.replace(/\/$/, "");
const PASS = "kopi-hujan-rotan-senja-live";
let failures = 0;
const check = (ok: unknown, label: string, extra = "") => {
  console.log(`${ok ? "✔" : "✖"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

try {
  const t0 = Date.now();
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  check(true, "server menjawab", `${Date.now() - t0} ms (termasuk bangun dari tidur bila ada)`);
  check(cfg.notaryPublicKey === NOTARY, "kunci notaris SAMA dengan server lama (kuitansi lama tetap sah)", cfg.notaryPublicKey);
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ alias: ALIAS, passphrase: PASS }),
  });
  check(login.status === 200, `akun lama "${ALIAS}" bisa masuk di alamat baru (data ikut pindah)`, String(login.status));
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const me = await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie, Origin: BASE } });
  const meBody = me.ok ? await me.json() : null;
  const alias = meBody?.me?.alias ?? meBody?.alias;
  check(alias === ALIAS, "sesi berjalan & profil terbaca", String(alias));
  const contacts = await fetch(`${BASE}/api/contacts`, { headers: { Cookie: cookie, Origin: BASE } });
  const cBody = contacts.ok ? await contacts.json() : null;
  check((cBody?.contacts?.length ?? 0) >= 1, "kontak lama ikut pindah", `${cBody?.contacts?.length ?? 0} kontak`);
} catch (e) {
  failures++;
  console.error("✖ terhenti:", e);
}
console.log(failures ? `\n${failures} pemeriksaan GAGAL` : `\nPindah server TERBUKTI — ${BASE}`);
process.exit(failures ? 1 : 0);
