// Penyimpanan di perangkat (IndexedDB) = "mesin lokal" PINPath.
//  - identity : kunci privat X25519 sebagai CryptoKey non-extractable (skrip apa pun — termasuk
//               ekstensi atau XSS — tidak bisa membaca byte kuncinya, hanya memakainya)
//  - pins     : kunci publik kontak yang sudah dipercaya (key pinning / TOFU)
//  - messages : riwayat percakapan TERDEKRIPSI. Server hanya relay; setelah pesan diterima,
//               ciphertext dihapus di server, jadi riwayat hanya ada di sini.

import type { Identity } from "../../../shared/e2ee.ts";

const DB_NAME = "pinpath";
const VERSION = 3;

export interface PinnedKey {
  publicKey: string;
  verified: boolean; // sudah dicocokkan safety number secara langsung
  firstSeen: number;
}

/** Bentuk pesan yang disimpan lokal (sama dengan ChatMessage + pemilik & lawan bicara). */
export interface LocalMessage {
  key: string; // `${owner}:${id}`
  owner: string;
  peer: string;
  id: string;
  mine: boolean;
  kind: "text" | "ping" | "identity" | "locked" | "broken";
  text: string;
  createdAt: number;
  status: "pending" | "S" | "D" | "R" | "failed";
  error?: string;
  untrusted?: boolean;
}

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("identity")) db.createObjectStore("identity");
      if (!db.objectStoreNames.contains("pins")) db.createObjectStore("pins");
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta"); // kunci notaris yang di-pin, seq kuitansi terakhir, dsb.
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

export const keystore = {
  getIdentity: (userId: string) => run<Identity | undefined>("identity", "readonly", (s) => s.get(userId)),
  putIdentity: (userId: string, id: Identity) => run<void>("identity", "readwrite", (s) => s.put(id, userId)),
  deleteIdentity: (userId: string) => run<void>("identity", "readwrite", (s) => s.delete(userId)),

  getPin: (me: string, peer: string) => run<PinnedKey | undefined>("pins", "readonly", (s) => s.get(`${me}:${peer}`)),
  putPin: (me: string, peer: string, pin: PinnedKey) => run<void>("pins", "readwrite", (s) => s.put(pin, `${me}:${peer}`)),

  getMeta: <T>(key: string) => run<T | undefined>("meta", "readonly", (s) => s.get(key)),
  putMeta: (key: string, value: unknown) => run<void>("meta", "readwrite", (s) => s.put(value, key)),

  /** Simpan/perbarui beberapa pesan sekaligus dalam satu transaksi. */
  putMessages: (msgs: LocalMessage[]) =>
    msgs.length
      ? run<void>("messages", "readwrite", (s) => {
          for (const m of msgs) s.put(m);
        })
      : Promise.resolve(),

  /** Riwayat satu percakapan, urut waktu (maks. `limit` terbaru). */
  async getThread(owner: string, peer: string, limit = 1000): Promise<LocalMessage[]> {
    const all = await run<LocalMessage[]>("messages", "readonly", (s) =>
      s.index("thread").getAll(IDBKeyRange.bound([owner, peer, -Infinity], [owner, peer, Infinity])),
    );
    return all.slice(-limit);
  },

  /** Hapus semua rahasia & riwayat lokal (saat hapus akun). */
  async wipe(): Promise<void> {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  },
};
