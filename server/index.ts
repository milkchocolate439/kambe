import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createApp } from "./app.ts";
import { loadNotaryKey } from "./notary.ts";
import { simulatedProvider, xenditProvider, type PaymentProvider } from "./payments.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const production = env.NODE_ENV === "production";

/** Default SIMULASI. Gateway nyata hanya bila dinyalakan eksplisit & semua kunci (server-only) tersedia. */
function paymentProvider(): PaymentProvider {
  // Produksi tidak boleh berjalan dengan simulasi: "bayar" di sana tidak memindahkan uang sungguhan.
  if (production && env.PINPATH_PAYMENT_PROVIDER !== "xendit") {
    throw new Error("NODE_ENV=production butuh PINPATH_PAYMENT_PROVIDER=xendit (simulasi ditolak di produksi)");
  }
  if (env.PINPATH_PAYMENT_PROVIDER !== "xendit") return simulatedProvider;
  const missing = ["XENDIT_SECRET_KEY", "XENDIT_CALLBACK_TOKEN", "PINPATH_PUBLIC_URL"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`PINPATH_PAYMENT_PROVIDER=xendit butuh: ${missing.join(", ")}`);
  return xenditProvider({
    secretKey: env.XENDIT_SECRET_KEY!,
    callbackToken: env.XENDIT_CALLBACK_TOKEN!,
    splitRuleId: env.XENDIT_SPLIT_RULE_ID,
    successUrl: `${env.PINPATH_PUBLIC_URL}/`,
  });
}

const app = createApp({
  dbPath: env.PINPATH_DB ?? join(root, "data", "pinpath.db"),
  staticDir: production ? join(root, "dist") : undefined,
  secure: env.PINPATH_SECURE === "1",
  trustProxy: env.PINPATH_TRUST_PROXY === "1",
  allowedOrigins: env.PINPATH_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
  moderators: env.PINPATH_MODERATORS?.split(",").map((s) => s.trim()).filter(Boolean),
  // Kunci notaris permanen: dari env (PKCS8 base64) atau data/notary.key (dibuat sekali, izin 0600).
  // Jangan pernah dikirim ke klien; yang dibagikan hanya kunci publiknya (/api/config).
  notaryKey: loadNotaryKey(env.PINPATH_NOTARY_KEY, env.PINPATH_NOTARY_KEY_FILE ?? join(root, "data", "notary.key")),
  feePerMille: env.PINPATH_FEE_PER_MILLE ? Number(env.PINPATH_FEE_PER_MILLE) : undefined,
  payments: paymentProvider(),
  log: (m) => console.error(m),
});

// Default hanya 127.0.0.1: tidak terbuka ke jaringan kecuali sengaja diatur.
const host = env.HOST ?? "127.0.0.1";
const port = Number(env.PORT ?? 3300);
app.server.listen(port, host, () => {
  console.log(`PINPath ${production ? "(produksi)" : "(dev API)"} di http://${host}:${port}`);
  console.log(`Kunci publik notaris: ${app.notaryPublicKey}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
