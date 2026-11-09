import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createApp } from "./app.ts";
import { defaultDbPath, readEnv, staticDirFor } from "./env.ts";
import { loadNotaryKey, notaryKeyFromSeed } from "./notary.ts";
import { directProvider, simulatedProvider, xenditProvider, type PaymentProvider } from "./payments.ts";
import { vapidFromFile, vapidFromSeed } from "./push.ts";
import { mongoSnapshotStore, restoreSnapshot, snapshotKey, Snapshotter, type SnapshotStore } from "./snapshot.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const production = env.NODE_ENV === "production";

/**
 * Default LANGSUNG: pembeli mentransfer sendiri ke info pembayaran penjual; KAMBE tidak memegang dana.
 * "simulasi" (rekber tiruan) hanya untuk pengembangan & tes; "xendit" = gateway nyata (disimpan).
 */
function paymentProvider(): PaymentProvider {
  const provider = readEnv(env, "PAYMENT_PROVIDER") ?? "langsung";
  if (!["langsung", "simulasi", "xendit"].includes(provider)) throw new Error(`KAMBE_PAYMENT_PROVIDER tidak dikenal: ${provider}`);
  // Produksi tidak boleh berjalan dengan simulasi: "bayar" di sana tidak memindahkan uang sungguhan.
  if (production && provider === "simulasi") {
    throw new Error("NODE_ENV=production menolak KAMBE_PAYMENT_PROVIDER=simulasi (pakai langsung atau xendit)");
  }
  if (provider === "langsung") return directProvider;
  if (provider === "simulasi") return simulatedProvider;
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

const dbPath = readEnv(env, "DB") ?? defaultDbPath(join(root, "data"));

// Hosting gratis berdisk sementara: database dipulihkan dari & disalin ke MongoDB (terenkripsi).
const mongoUri = readEnv(env, "MONGODB_URI");
let snapshotStore: SnapshotStore | null = null;
let snapKey: Buffer | null = null;
if (mongoUri) {
  const secret = readEnv(env, "SNAPSHOT_KEY");
  if (!secret) throw new Error("KAMBE_MONGODB_URI butuh KAMBE_SNAPSHOT_KEY (minimal 32 karakter acak) untuk mengenkripsi snapshot");
  snapKey = snapshotKey(secret);
  snapshotStore = await mongoSnapshotStore(mongoUri, readEnv(env, "MONGODB_DB") ?? "kambe");
  const outcome = await restoreSnapshot(snapshotStore, snapKey, dbPath);
  console.log(`[snapshot] pemulihan saat menyala: ${outcome}`);
}

const app = createApp({
  dbPath,
  // Kunci VAPID Web Push: dari seed notaris (stabil tanpa disk) atau berkas di samping database.
  vapid: readEnv(env, "NOTARY_SEED") ? vapidFromSeed(readEnv(env, "NOTARY_SEED")!) : vapidFromFile(join(dirname(dbPath), "vapid.json")),
  pushSubject: readEnv(env, "PUBLIC_URL"),
  // APK Android (TWA): KAMBE_ANDROID_PACKAGE + KAMBE_ANDROID_CERT_SHA256 (dipisah koma) → /.well-known/assetlinks.json
  androidApp:
    readEnv(env, "ANDROID_PACKAGE") && readEnv(env, "ANDROID_CERT_SHA256")
      ? { packageName: readEnv(env, "ANDROID_PACKAGE")!, sha256: readEnv(env, "ANDROID_CERT_SHA256")!.split(",").map((x) => x.trim()).filter(Boolean) }
      : undefined,
  staticDir: staticDirFor(env, root),
  secure: readEnv(env, "SECURE") === "1",
  trustProxy: readEnv(env, "TRUST_PROXY") === "1",
  allowedOrigins: readEnv(env, "ORIGINS")?.split(",").map((s) => s.trim()).filter(Boolean),
  moderators: readEnv(env, "MODERATORS")?.split(",").map((s) => s.trim()).filter(Boolean),
  // Kunci notaris permanen: dari env (PKCS8 base64) atau data/notary.key (dibuat sekali, izin 0600).
  // Jangan pernah dikirim ke klien; yang dibagikan hanya kunci publiknya (/api/config).
  // Urutan: KAMBE_NOTARY_KEY (PKCS8) → KAMBE_NOTARY_SEED (hosting tanpa disk) → berkas data/notary.key.
  notaryKey: readEnv(env, "NOTARY_KEY") || !readEnv(env, "NOTARY_SEED")
    ? loadNotaryKey(readEnv(env, "NOTARY_KEY"), readEnv(env, "NOTARY_KEY_FILE") ?? join(root, "data", "notary.key"))
    : notaryKeyFromSeed(readEnv(env, "NOTARY_SEED")!),
  feePerMille: feePerMille ? Number(feePerMille) : undefined,
  payments: paymentProvider(),
  // Platform gratis sepenuhnya kecuali dimatikan eksplisit (KAMBE_FREE_PLATFORM=0).
  freePlatform: readEnv(env, "FREE_PLATFORM") !== "0",
  log: (m) => console.error(m),
});

// Default hanya 127.0.0.1: tidak terbuka ke jaringan kecuali sengaja diatur.
const host = env.HOST ?? "127.0.0.1";
const port = Number(env.PORT ?? 3300);
app.server.listen(port, host, () => {
  console.log(`KAMBE ${production ? "(produksi)" : "(dev API)"} di http://${host}:${port}`);
  console.log(`Kunci publik notaris: ${app.notaryPublicKey}`);
});

const snapshotter =
  snapshotStore && snapKey
    ? new Snapshotter({ db: app.db, store: snapshotStore, key: snapKey, intervalMs: Number(readEnv(env, "SNAPSHOT_INTERVAL_S") ?? 30) * 1000, log: (m) => console.error(m) })
    : null;
snapshotter?.start();

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      snapshotter?.stop();
      // Snapshot terakhir sebelum mati (deploy/restart di hosting gratis) — maksimal 10 detik.
      if (snapshotter) {
        await Promise.race([snapshotter.snapshotNow().then((r) => console.log(`[snapshot] terakhir: ${r}`)), new Promise((r) => setTimeout(r, 10_000))]).catch((e) =>
          console.error(`[snapshot] terakhir gagal: ${(e as Error).message}`),
        );
        await snapshotStore?.close?.().catch(() => {});
      }
      await app.close();
      process.exit(0);
    })();
  });
}
