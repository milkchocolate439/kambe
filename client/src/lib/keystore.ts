// Penyimpanan rahasia di perangkat (IndexedDB). Kunci privat disimpan sebagai
// CryptoKey non-extractable: browser bisa memakainya, tapi skrip apa pun —
// termasuk ekstensi atau XSS — tidak bisa membaca byte kuncinya.

import type { Identity } from "../../../shared/e2ee.ts";

const DB_NAME = "pinpath";
const VERSION = 1;

export interface PinnedKey {
  publicKey: string;
  verified: boolean; // sudah dicocokkan safety number secara langsung
  firstSeen: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("identity")) db.createObjectStore("identity");
      if (!db.objectStoreNames.contains("pins")) db.createObjectStore("pins");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result as T);
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

  /** Hapus semua rahasia lokal (saat hapus akun). */
  async wipe(): Promise<void> {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  },
};
