// Konfigurasi lewat env: nama baru KAMBE_*, nama lama PINPATH_* tetap diterima agar instalasi lama tidak rusak.
import { existsSync } from "node:fs";
import { join } from "node:path";

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

/** Baca `KAMBE_<name>`, jatuh ke `PINPATH_<name>` (nama lama) bila tidak diatur. String kosong = tidak diatur. */
export function readEnv(env: Env, name: string): string | undefined {
  return env[`KAMBE_${name}`] || env[`PINPATH_${name}`] || undefined;
}

/**
 * Folder tampilan yang disajikan server. Produksi selalu `dist`. `KAMBE_SERVE_DIST=1` hanya untuk uji E2E
 * (NODE_ENV=test): di luar produksi pembayaran masih simulasi, jadi UI lengkap + bayar palsu tidak boleh
 * bisa dinyalakan di deployment sungguhan cukup dengan satu saklar.
 */
export function staticDirFor(env: Env, root: string): string | undefined {
  if (env.NODE_ENV === "production") return join(root, "dist");
  if (readEnv(env, "SERVE_DIST") !== "1") return undefined;
  if (env.NODE_ENV !== "test") throw new Error("KAMBE_SERVE_DIST=1 hanya untuk uji (NODE_ENV=test); deployment pakai NODE_ENV=production");
  return join(root, "dist");
}

/** Path DB default: pakai `pinpath.db` bila sudah ada (instalasi lama), selain itu `kambe.db`. */
export function defaultDbPath(dataDir: string): string {
  const legacy = join(dataDir, "pinpath.db");
  return existsSync(legacy) ? legacy : join(dataDir, "kambe.db");
}
