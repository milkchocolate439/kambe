// Penyimpanan di perangkat (IndexedDB) = "mesin lokal" KAMBE. Sejak Tahap 2 SEMUA isi
// rahasia di sini terenkripsi dengan kunci yang diturunkan dari frasa kunci pengguna:
//  - vault    : seed frasa kunci, dibungkus passphrase (PBKDF2 → AES-GCM). Tetap ada saat keluar.
//  - unlocked : kunci yang sedang terbuka (identitas X25519 + kunci riwayat + kunci cadangan),
//               semuanya CryptoKey non-extractable. DIHAPUS saat keluar → data di disk terkunci.
//  - pins     : kunci publik kontak yang dipercaya (TOFU) — nilainya terenkripsi.
//  - meta     : rahasia kecil (alamat yang diingat, kunci notaris yang di-pin, seq kuitansi) — terenkripsi.
//  - messages : riwayat percakapan — isinya terenkripsi; hanya (pemilik, lawan, waktu) yang polos
//               agar bisa diurutkan. Server hanya relay; riwayat hanya ada di sini.
//  - identity : (lama) kunci perangkat acak sebelum Tahap 2; dihapus setelah migrasi.

import type { Identity } from "../../../shared/e2ee.ts";
import { openRecord, sealRecord, type LocalKeys, type SealedRecord, type SignIdentity, type VaultBlob } from "../../../shared/vault.ts";

const DB_NAME = "pinpath"; // label protokol, jangan diganti (lihat spec KAMBE)
const VERSION = 4;

export interface PinnedKey {
  publicKey: string;
  verified: boolean; // sudah dicocokkan safety number secara langsung
  firstSeen: number;
}

/** Bentuk pesan di memori (sama dengan ChatMessage + pemilik & lawan bicara). */
export interface LocalMessage {
  key: string; // `${owner}:${id}`
  owner: string;
  peer: string;
  id: string;
  mine: boolean;
  kind: "text" | "ping" | "identity" | "locked" | "broken";
  text: string;
  createdAt: number;
  status: "pending" | "S" | "D" | "R" | "failed" | "X";
  error?: string;
  untrusted?: boolean;
}

/** Bentuk di disk: hanya kolom indeks yang polos. */
interface StoredMessage extends SealedRecord {
  key: string;
  owner: string;
  peer: string;
  createdAt: number;
}

/** Kunci yang sedang terbuka di perangkat ini. */
export interface UnlockedDevice extends Identity, LocalKeys {
  /** Kunci tanda tangan Buku Jejak Transaksi (Ed25519, dari seed). Perangkat terbuka versi lama tidak punya → wajib masuk ulang. */
  sign: SignIdentity;
}

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ["identity", "pins", "meta", "vault", "unlocked"]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      if (!db.objectStoreNames.contains("messages")) {
        const s = db.createObjectStore("messages", { keyPath: "key" });
        s.createIndex("thread", ["owner", "peer", "createdAt"]);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve((req ? req.result : undefined) as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const isSealed = (v: unknown): v is SealedRecord => typeof v === "object" && v !== null && typeof (v as SealedRecord).ct === "string" && typeof (v as SealedRecord).nonce === "string";
const prefix = (owner: string) => IDBKeyRange.bound(`${owner}:`, `${owner}:￿`);
const ownerMessages = (owner: string) => IDBKeyRange.bound([owner], [owner, []]);
const SECRET = (owner: string, name: string) => `${owner}:${name}`;

// Kunci riwayat yang sedang aktif. Tanpa ini, rahasia lokal tidak bisa dibaca maupun ditulis.
let active: { owner: string; key: CryptoKey } | null = null;

function historyKey(owner: string): CryptoKey {
  if (!active || active.owner !== owner) throw new Error("Brankas perangkat terkunci");
  return active.key;
}

async function sealMessage(m: LocalMessage): Promise<StoredMessage> {
  const { key, owner, peer, createdAt, ...rest } = m;
  return { key, owner, peer, createdAt, ...(await sealRecord(historyKey(owner), `msg|${key}|${peer}|${createdAt}`, rest)) };
}

async function openMessage(r: StoredMessage | LocalMessage): Promise<{ msg: LocalMessage; legacy: boolean } | null> {
  if (!isSealed(r)) return "text" in r ? { msg: r, legacy: true } : null; // riwayat polos dari sebelum Tahap 2
  try {
    const rest = await openRecord<Omit<LocalMessage, "key" | "owner" | "peer" | "createdAt">>(historyKey(r.owner), `msg|${r.key}|${r.peer}|${r.createdAt}`, r);
    return { msg: { key: r.key, owner: r.owner, peer: r.peer, createdAt: r.createdAt, ...rest }, legacy: false };
  } catch {
    return null; // rusak / dari brankas lain — jangan tampilkan apa pun
  }
}

export const keystore = {
  // ------------------------------------------------------ brankas & kunci ---
  getVault: (userId: string) => run<VaultBlob | undefined>("vault", "readonly", (s) => s.get(userId)),
  putVault: (userId: string, v: VaultBlob) => run<void>("vault", "readwrite", (s) => s.put(v, userId)),

  getUnlocked: (userId: string) => run<UnlockedDevice | undefined>("unlocked", "readonly", (s) => s.get(userId)),
  putUnlocked: (userId: string, d: UnlockedDevice) => run<void>("unlocked", "readwrite", (s) => s.put(d, userId)),

  /** Kunci identitas acak dari sebelum Tahap 2 (tidak punya frasa kunci). */
  getLegacyIdentity: (userId: string) => run<Identity | undefined>("identity", "readonly", (s) => s.get(userId)),
  deleteLegacyIdentity: (userId: string) => run<void>("identity", "readwrite", (s) => s.delete(userId)),

  /** Aktifkan kunci riwayat untuk akun ini (setelah brankas dibuka). */
  use(owner: string, keys: LocalKeys | null) {
    active = keys ? { owner, key: keys.history } : null;
  },

  /** Kunci perangkat: hapus kunci yang terbuka. Yang tersisa hanya brankas berpassphrase + ciphertext. */
  async lock(userId: string): Promise<void> {
    if (active?.owner === userId) active = null;
    await run<void>("unlocked", "readwrite", (s) => s.delete(userId));
    await run<void>("identity", "readwrite", (s) => s.delete(userId));
  },

  // ------------------------------------------------------- pin kunci ---
  async getPin(me: string, peer: string): Promise<PinnedKey | undefined> {
    const raw = await run<SealedRecord | PinnedKey | undefined>("pins", "readonly", (s) => s.get(`${me}:${peer}`));
    if (!raw) return undefined;
    if (!isSealed(raw)) {
      await keystore.putPin(me, peer, raw); // migrasi pin polos lama
      return raw;
    }
    try {
      return await openRecord<PinnedKey>(historyKey(me), `pin|${me}:${peer}`, raw);
    } catch {
      return undefined; // pin yang diutak-atik dianggap tidak ada → kontak diperlakukan sebagai baru
    }
  },
  async putPin(me: string, peer: string, pin: PinnedKey) {
    const rec = await sealRecord(historyKey(me), `pin|${me}:${peer}`, pin);
    await run<void>("pins", "readwrite", (s) => s.put(rec, `${me}:${peer}`));
  },

  // ------------------------------------------------------ rahasia kecil ---
  async getSecret<T>(owner: string, name: string): Promise<T | undefined> {
    const raw = await run<SealedRecord | undefined>("meta", "readonly", (s) => s.get(SECRET(owner, name)));
    if (!isSealed(raw)) return undefined;
    try {
      return await openRecord<T>(historyKey(owner), `secret|${SECRET(owner, name)}`, raw);
    } catch {
      return undefined;
    }
  },
  async putSecret(owner: string, name: string, value: unknown) {
    const rec = await sealRecord(historyKey(owner), `secret|${SECRET(owner, name)}`, value);
    await run<void>("meta", "readwrite", (s) => s.put(rec, SECRET(owner, name)));
  },
  deleteSecret: (owner: string, name: string) => run<void>("meta", "readwrite", (s) => s.delete(SECRET(owner, name))),

  // ----------------------------------------------------------- riwayat ---
  /** Simpan/perbarui beberapa pesan sekaligus (dienkripsi dulu, lalu satu transaksi). */
  async putMessages(msgs: LocalMessage[]) {
    if (!msgs.length) return;
    const sealed = await Promise.all(msgs.map(sealMessage));
    await run<void>("messages", "readwrite", (s) => {
      for (const m of sealed) s.put(m);
    });
  },

  /** Hapus pesan tertentu dari perangkat ini saja (kunci = `${owner}:${id}`). */
  async deleteMessages(owner: string, ids: string[]) {
    if (!ids.length) return;
    await run<void>("messages", "readwrite", (s) => {
      for (const id of ids) s.delete(`${owner}:${id}`);
    });
  },

  /** Riwayat satu percakapan, urut waktu (maks. `limit` terbaru). */
  async getThread(owner: string, peer: string, limit = 1000): Promise<LocalMessage[]> {
    const all = await run<(StoredMessage | LocalMessage)[]>("messages", "readonly", (s) =>
      s.index("thread").getAll(IDBKeyRange.bound([owner, peer, -Infinity], [owner, peer, Infinity])),
    );
    const opened = (await Promise.all(all.slice(-limit).map(openMessage))).filter((x) => x !== null);
    const legacy = opened.filter((x) => x.legacy).map((x) => x.msg);
    if (legacy.length) await keystore.putMessages(legacy);
    return opened.map((x) => x.msg);
  },

  /** Semua riwayat milik akun (untuk cadangan). */
  async allMessages(owner: string): Promise<LocalMessage[]> {
    const all = await run<(StoredMessage | LocalMessage)[]>("messages", "readonly", (s) => s.index("thread").getAll(ownerMessages(owner)));
    return (await Promise.all(all.map(openMessage))).filter((x) => x !== null).map((x) => x.msg);
  },

  async allPins(owner: string): Promise<Record<string, PinnedKey>> {
    const keys = await run<IDBValidKey[]>("pins", "readonly", (s) => s.getAllKeys(prefix(owner)));
    const out: Record<string, PinnedKey> = {};
    for (const k of keys) {
      const peer = String(k).slice(owner.length + 1);
      const pin = await keystore.getPin(owner, peer);
      if (pin) out[peer] = pin;
    }
    return out;
  },

  /** Enkripsi ulang sisa data polos dari sebelum Tahap 2 (riwayat & pin). */
  async migrateLegacy(owner: string): Promise<number> {
    const all = await run<(StoredMessage | LocalMessage)[]>("messages", "readonly", (s) => s.index("thread").getAll(ownerMessages(owner)));
    const plain = all.filter((r): r is LocalMessage => !isSealed(r) && "text" in r);
    await keystore.putMessages(plain);
    await keystore.allPins(owner); // getPin menyegel ulang pin polos
    return plain.length;
  },

  /** Hapus semua rahasia & riwayat lokal (saat hapus akun). */
  async wipe(): Promise<void> {
    active = null;
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  },
};
