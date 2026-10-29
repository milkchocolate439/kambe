import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createApp } from "./app.ts";
import { defaultDbPath, readEnv, staticDirFor } from "./env.ts";
import { loadNotaryKey } from "./notary.ts";
import { simulatedProvider, xenditProvider, type PaymentProvider } from "./payments.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const production = env.NODE_ENV === "production";

/** Default SIMULASI. Gateway nyata hanya bila dinyalakan eksplisit & semua kunci (server-only) tersedia. */
function paymentProvider(): PaymentProvider {
  const provider = readEnv(env, "PAYMENT_PROVIDER");
  // Produksi tidak boleh berjalan dengan simulasi: "bayar" di sana tidak memindahkan uang sungguhan.
  if (production && provider !== "xendit") {
    throw new Error("NODE_ENV=production butuh KAMBE_PAYMENT_PROVIDER=xendit (simulasi ditolak di produksi)");
  }
  if (provider !== "xendit") return simulatedProvider;
  const publicUrl = readEnv(env, "PUBLIC_URL");
  const missing = [
    ...["XENDIT_SECRET_KEY", "XENDIT_CALLBACK_TOKEN"].filter((k) => !env[k]),
    ...(publicUrl ? [] : ["KAMBE_PUBLIC_URL"]),
  ];
  if (missing.length) throw new Error(`KAMBE_PAYMENT_PROVIDER=xendit butuh: ${missing.join(", ")}`);
  return xenditProvider({
    secretKey: env.XENDIT_SECRET_KEY!,
    callbackToken: env.XENDIT_CALLBACK_TOKEN!,
    splitRuleId: env.XENDIT_SPLIT_RULE_ID,
    successUrl: `${publicUrl}/`,
  });
}

const feePerMille = readEnv(env, "FEE_PER_MILLE");

const app = createApp({
  dbPath: readEnv(env, "DB") ?? defaultDbPath(join(root, "data")),
  staticDir: staticDirFor(env, root),
  secure: readEnv(env, "SECURE") === "1",
  trustProxy: readEnv(env, "TRUST_PROXY") === "1",
  allowedOrigins: readEnv(env, "ORIGINS")?.split(",").map((s) => s.trim()).filter(Boolean),
  moderators: readEnv(env, "MODERATORS")?.split(",").map((s) => s.trim()).filter(Boolean),
  // Kunci notaris permanen: dari env (PKCS8 base64) atau data/notary.key (dibuat sekali, izin 0600).
  // Jangan pernah dikirim ke klien; yang dibagikan hanya kunci publiknya (/api/config).
  notaryKey: loadNotaryKey(readEnv(env, "NOTARY_KEY"), readEnv(env, "NOTARY_KEY_FILE") ?? join(root, "data", "notary.key")),
  feePerMille: feePerMille ? Number(feePerMille) : undefined,
  payments: paymentProvider(),
  log: (m) => console.error(m),
});

// Default hanya 127.0.0.1: tidak terbuka ke jaringan kecuali sengaja diatur.
const host = env.HOST ?? "127.0.0.1";
const port = Number(env.PORT ?? 3300);
app.server.listen(port, host, () => {
  console.log(`KAMBE ${production ? "(produksi)" : "(dev API)"} di http://${host}:${port}`);
  console.log(`Kunci publik notaris: ${app.notaryPublicKey}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
