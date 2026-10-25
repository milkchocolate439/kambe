// Cari ID akun (UUID) dari alias untuk diisikan ke PINPATH_MODERATORS.
// Pakai: node --import tsx scripts/moderator-id.ts <alias> [path-db]
// Moderator sengaja ditentukan lewat ID, bukan alias, agar alias yang belum terdaftar tidak bisa diserobot.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const [alias, dbArg] = process.argv.slice(2);
const dbPath = dbArg ?? process.env.PINPATH_DB ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data", "pinpath.db");
if (!alias) {
  console.error("Pakai: node --import tsx scripts/moderator-id.ts <alias> [path-db]");
  process.exit(2);
}
if (!existsSync(dbPath)) {
  console.error(`Database tidak ditemukan: ${dbPath}`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const row = db.prepare("SELECT id, alias, created_at FROM users WHERE alias = ? COLLATE NOCASE").get(alias) as { id: string; alias: string; created_at: number } | undefined;
if (!row) {
  console.error(`Alias "${alias}" belum terdaftar. Daftarkan akunnya dulu lewat aplikasi.`);
  process.exit(1);
}
console.log(`Alias  : ${row.alias} (dibuat ${new Date(row.created_at).toLocaleString("id-ID")})`);
console.log(`ID     : ${row.id}`);
console.log(`\nJalankan server dengan:\n  PINPATH_MODERATORS=${row.id} pnpm start`);
