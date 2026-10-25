import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Skema sengaja minim data pribadi: tidak ada nomor HP, email, atau
// identitas asli. Kolom `ciphertext` tidak pernah bisa dibaca server.
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  alias           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pin             TEXT NOT NULL UNIQUE,
  pass_hash       TEXT NOT NULL,
  recovery_hash   TEXT NOT NULL,
  public_key      TEXT,
  pm              TEXT NOT NULL DEFAULT '',
  read_receipts   INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS contact_requests (
  id          TEXT PRIMARY KEY,
  from_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  UNIQUE (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS requests_to ON contact_requests(to_id);

-- Satu baris per arah (A->B dan B->A) supaya query per pengguna sederhana.
CREATE TABLE IF NOT EXISTS contacts (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  since     INTEGER NOT NULL,
  PRIMARY KEY (user_id, peer_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  sender_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_key     TEXT NOT NULL,
  recipient_key  TEXT NOT NULL,
  nonce          TEXT NOT NULL,
  ciphertext     TEXT NOT NULL,
  ping           INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  delivered_at   INTEGER,
  read_at        INTEGER
);
CREATE INDEX IF NOT EXISTS messages_pair ON messages(sender_id, recipient_id, created_at);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages(recipient_id, read_at);

-- ---------------------------------------------------------- Fase 2: dagang
-- Semua nominal dalam RUPIAH UTUH (INTEGER) — tidak pernah float.

CREATE TABLE IF NOT EXISTS products (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  sector       TEXT NOT NULL,
  price        INTEGER NOT NULL CHECK (price > 0),
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS products_owner ON products(owner_id, active);

CREATE TABLE IF NOT EXISTS deals (
  id            TEXT PRIMARY KEY,
  buyer_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by    TEXT NOT NULL,
  product_id    TEXT,
  title         TEXT NOT NULL,
  price         INTEGER NOT NULL CHECK (price > 0),
  fee           INTEGER NOT NULL CHECK (fee >= 0 AND fee < price),
  status        TEXT NOT NULL,
  idem_key      TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  paid_at       INTEGER,
  shipped_at    INTEGER,
  disputed_at   INTEGER,
  closed_at     INTEGER,
  UNIQUE (created_by, idem_key)
);
CREATE INDEX IF NOT EXISTS deals_pair ON deals(buyer_id, seller_id, created_at);
CREATE INDEX IF NOT EXISTS deals_seller ON deals(seller_id, status);
CREATE INDEX IF NOT EXISTS deals_status ON deals(status, shipped_at);

-- Buku besar double-entry: setiap transaksi = beberapa baris dengan ref sama yang jumlahnya NOL.
-- Akun: 'user:<id>' (saldo simulasi), 'external:<id>' (uang dari luar sistem), 'escrow', 'platform'.
CREATE TABLE IF NOT EXISTS ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ref         TEXT NOT NULL,
  account     TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  deal_id     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_account ON ledger(account);
CREATE INDEX IF NOT EXISTS ledger_ref ON ledger(ref);

-- Sealed object: isi terenkripsi multi-penerima (catatan, status, etalase, judul kesepakatan, bukti
-- kirim, pernyataan, alasan putusan, label). Server hanya memegang ciphertext + bungkus kunci.
CREATE TABLE IF NOT EXISTS sealed_objects (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_key   TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  context     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sealed_owner ON sealed_objects(owner_id, kind);
CREATE INDEX IF NOT EXISTS sealed_context ON sealed_objects(context);

CREATE TABLE IF NOT EXISTS sealed_wraps (
  object_id      TEXT NOT NULL REFERENCES sealed_objects(id) ON DELETE CASCADE,
  recipient_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_key  TEXT NOT NULL,
  nonce          TEXT NOT NULL,
  wrapped        TEXT NOT NULL,
  PRIMARY KEY (object_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS wraps_recipient ON sealed_wraps(recipient_id);

-- Kuitansi notaris berantai per kesepakatan (lihat shared/receipt.ts). Append-only.
CREATE TABLE IF NOT EXISTS deal_receipts (
  deal_id     TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  body        TEXT NOT NULL,
  sig         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (deal_id, seq)
);

-- Fase 3: pernyataan sengketa (dikirim sadar ke moderator) & log audit keputusan moderator.
CREATE TABLE IF NOT EXISTS deal_statements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id     TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  author_id   TEXT NOT NULL,
  role        TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS statements_deal ON deal_statements(deal_id, created_at);

CREATE TABLE IF NOT EXISTS moderation_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id       TEXT NOT NULL,
  moderator_id  TEXT NOT NULL,
  decision      TEXT NOT NULL,
  reason        TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Fase 3: PIN alternatif. kind 'shadow' = PIN sementara 24 jam; 'radar' = PIN khusus radar.
-- Orang yang terhubung lewat PIN ini hanya pernah melihat PIN ini, bukan PIN utama.
CREATE TABLE IF NOT EXISTS shadow_pins (
  pin         TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shadow_user ON shadow_pins(user_id, kind);

-- Radar ekonomi: opt-in, kedaluwarsa sendiri, hanya terlihat oleh sesama peserta.
CREATE TABLE IF NOT EXISTS radar_entries (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sector      TEXT NOT NULL,
  headline    TEXT NOT NULL,
  pin         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS radar_sector ON radar_entries(sector, expires_at);

-- Fase 3: Path Moments — satu baris salinan terenkripsi per penerima.
CREATE TABLE IF NOT EXISTS moments (
  id          TEXT PRIMARY KEY,
  author_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_key  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS moments_author ON moments(author_id, created_at);
CREATE INDEX IF NOT EXISTS moments_expiry ON moments(expires_at);

CREATE TABLE IF NOT EXISTS moment_copies (
  moment_id     TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  recipient_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_key TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  ciphertext    TEXT NOT NULL,
  PRIMARY KEY (moment_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS copies_recipient ON moment_copies(recipient_id);

CREATE TABLE IF NOT EXISTS moment_reactions (
  moment_id   TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (moment_id, user_id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  ref         TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idem_key    TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  period_end  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, idem_key)
);
`;

/** Migrasi kecil untuk database yang dibuat versi sebelumnya. */
function migrate(db: DatabaseSync) {
  const cols = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("pro_until")) db.exec("ALTER TABLE users ADD COLUMN pro_until INTEGER NOT NULL DEFAULT 0");
  const dealCols = (db.prepare("PRAGMA table_info(deals)").all() as { name: string }[]).map((c) => c.name);
  const addDealCol = (name: string, def: string) => !dealCols.includes(name) && db.exec(`ALTER TABLE deals ADD COLUMN ${name} ${def}`);
  addDealCol("disputed_at", "INTEGER");
  addDealCol("courier", "TEXT");
  addDealCol("tracking", "TEXT");
  addDealCol("ship_note", "TEXT");
  addDealCol("dispute_reason", "TEXT");
  addDealCol("resolution", "TEXT");
  addDealCol("resolution_reason", "TEXT");
  addDealCol("resolved_by", "TEXT");
  addDealCol("pay_ref", "TEXT");
  addDealCol("payment_url", "TEXT");
  addDealCol("provider_ref", "TEXT");
  // Sub-akun penjual di payment gateway (xenPlatform) — diisi setelah onboarding/KYC penjual.
  const userCols = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
  if (!userCols.includes("gateway_account")) db.exec("ALTER TABLE users ADD COLUMN gateway_account TEXT");
  // PIN dinamis: rotasi PIN utama otomatis (0 = mati).
  if (!userCols.includes("pin_rotate_days")) db.exec("ALTER TABLE users ADD COLUMN pin_rotate_days INTEGER NOT NULL DEFAULT 0");
  if (!userCols.includes("pin_rotated_at")) db.exec("ALTER TABLE users ADD COLUMN pin_rotated_at INTEGER NOT NULL DEFAULT 0");

  // Enkripsi isi: kolom teks lama dikosongkan, isi pindah ke sealed_objects (lihat server/sealed.ts).
  const addCol = (table: string, name: string, def: string) => {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  };
  addCol("users", "pm_object", "TEXT");
  addCol("contact_requests", "note_object", "TEXT");
  addCol("shadow_pins", "label_object", "TEXT");
  addCol("products", "content_object", "TEXT");
  addCol("deals", "content_object", "TEXT");
  addCol("deals", "shipment_object", "TEXT");
  addCol("deals", "resolution_object", "TEXT");
  addCol("deal_statements", "object_id", "TEXT");
  addCol("moderation_log", "reason_object", "TEXT");
  // Data teks lama (sebelum enkripsi isi) dihapus — tidak boleh tertinggal di server.
  db.exec("UPDATE users SET pm = '' WHERE pm != ''");
  db.exec("UPDATE contact_requests SET note = '' WHERE note != ''");
  db.exec("UPDATE shadow_pins SET label = '' WHERE label != '' AND kind != 'radar'");
  // PIN yang dipakai saat terhubung (shadow/radar) — itulah yang ditampilkan ke pihak pengundang.
  for (const table of ["contacts", "contact_requests"]) {
    const c = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((x) => x.name);
    if (!c.includes("via_pin")) db.exec(`ALTER TABLE ${table} ADD COLUMN via_pin TEXT`);
  }
  // Jenis PIN yang dipakai saat mengundang (shadow/once/radar) — tetap terbaca walau PIN-nya sudah hangus.
  const reqCols = (db.prepare("PRAGMA table_info(contact_requests)").all() as { name: string }[]).map((x) => x.name);
  if (!reqCols.includes("via_kind")) db.exec("ALTER TABLE contact_requests ADD COLUMN via_kind TEXT");
}

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

const depth = new WeakMap<DB, number>();

/**
 * Jalankan fn dalam satu transaksi; rollback otomatis bila gagal. Boleh bersarang:
 * level dalam memakai SAVEPOINT sehingga semuanya tetap satu kesatuan atomik.
 */
export function tx<T>(db: DB, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const sp = `sp_${level}`;
  db.exec(level === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
  depth.set(db, level + 1);
  try {
    const out = fn();
    db.exec(level === 0 ? "COMMIT" : `RELEASE ${sp}`);
    return out;
  } catch (err) {
    db.exec(level === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  } finally {
    depth.set(db, level);
  }
}
