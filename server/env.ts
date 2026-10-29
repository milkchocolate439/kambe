// Konfigurasi lewat env: nama baru KAMBE_*, nama lama PINPATH_* tetap diterima agar instalasi lama tidak rusak.
import { existsSync } from "node:fs";
import { join } from "node:path";

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

/** Baca `KAMBE_<name>`, jatuh ke `PINPATH_<name>` (nama lama) bila tidak diatur. */
export function readEnv(env: Env, name: string): string | undefined {
  return env[`KAMBE_${name}`] ?? env[`PINPATH_${name}`];
}

/** Path DB default: pakai `pinpath.db` bila sudah ada (instalasi lama), selain itu `kambe.db`. */
export function defaultDbPath(dataDir: string): string {
  const legacy = join(dataDir, "pinpath.db");
  return existsSync(legacy) ? legacy : join(dataDir, "kambe.db");
}
