import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createApp } from "./app.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const production = env.NODE_ENV === "production";

const app = createApp({
  dbPath: env.PINPATH_DB ?? join(root, "data", "pinpath.db"),
  staticDir: production ? join(root, "dist") : undefined,
  secure: env.PINPATH_SECURE === "1",
  trustProxy: env.PINPATH_TRUST_PROXY === "1",
  allowedOrigins: env.PINPATH_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
  moderators: env.PINPATH_MODERATORS?.split(",").map((s) => s.trim()).filter(Boolean),
  log: (m) => console.error(m),
});

// Default hanya 127.0.0.1: tidak terbuka ke jaringan kecuali sengaja diatur.
const host = env.HOST ?? "127.0.0.1";
const port = Number(env.PORT ?? 3300);
app.server.listen(port, host, () => {
  console.log(`PINPath ${production ? "(produksi)" : "(dev API)"} di http://${host}:${port}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
