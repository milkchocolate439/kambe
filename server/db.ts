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
  if (!dealCols.includes("disputed_at")) db.exec("ALTER TABLE deals ADD COLUMN disputed_at INTEGER");
}

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Jalankan fn dalam satu transaksi; rollback otomatis bila gagal. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
