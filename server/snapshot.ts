// Snapshot database SQLite ke penyimpanan luar (MongoDB Atlas) — untuk hosting gratis berdisk sementara.
//
// Alur:
//  - Saat server menyala & berkas DB lokal BELUM ada → pulihkan snapshot terbaru (bila ada).
//    (Bila berkas lokal sudah ada, tidak ditimpa — data lokal dianggap lebih baru.)
//  - Tiap N detik → salinan konsisten via `VACUUM INTO`, dikirim HANYA bila isinya berubah.
//  - Saat dimatikan (SIGTERM) → satu snapshot terakhir.
//
// Keamanan: snapshot dikompres lalu dienkripsi AES-256-GCM dengan kunci dari KAMBE_SNAPSHOT_KEY.
// Penyimpanan luar (Atlas) hanya melihat blob acak; diubah sedikit pun → ditolak saat dipulihkan.
//
// Batas yang jujur: hanya untuk SATU server. Kalau server mati mendadak (bukan SIGTERM), perubahan
// sejak snapshot terakhir (≤ interval) hilang. Saat deploy bergulir, tulisan ke server lama selama
// masa tumpang-tindih bisa hilang.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { DB } from "./db.ts";

export interface SnapshotMeta {
  sha256: string;
  size: number;
  at: number;
}

/** Tempat menyimpan blob snapshot terenkripsi. */
export interface SnapshotStore {
  load(): Promise<Buffer | null>;
  save(blob: Buffer, meta: SnapshotMeta): Promise<void>;
  close?(): Promise<void>;
}

const MAGIC = Buffer.from("KSNAP1");
const AAD = Buffer.from("kambe-snapshot|v1");

export function snapshotKey(secret: string): Buffer {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("KAMBE_SNAPSHOT_KEY minimal 32 karakter acak");
  return createHash("sha256").update(`kambe-snapshot-key|${secret}`).digest();
}

/** gzip + AES-256-GCM. Format: MAGIC | iv(12) | tag(16) | ciphertext. */
export function sealSnapshot(key: Buffer, raw: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(gzipSync(raw)), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}

/** Kebalikan sealSnapshot. Melempar bila kunci salah atau blob diubah. */
export function openSnapshot(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < MAGIC.length + 28 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("bukan snapshot KAMBE");
  const iv = blob.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = blob.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(AAD);
  d.setAuthTag(tag);
  const zipped = Buffer.concat([d.update(blob.subarray(MAGIC.length + 28)), d.final()]);
  return gunzipSync(zipped);
}

/** Pulihkan snapshot terbaru ke `dbPath` — HANYA bila berkas DB lokal belum ada. */
export async function restoreSnapshot(store: SnapshotStore, key: Buffer, dbPath: string): Promise<"restored" | "empty" | "local_exists"> {
  if (existsSync(dbPath)) return "local_exists";
  const blob = await store.load();
  if (!blob) return "empty";
  const raw = openSnapshot(key, blob);
  mkdirSync(dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.restore`;
  writeFileSync(tmp, raw, { mode: 0o600 });
  for (const ext of ["-wal", "-shm"]) rmSync(dbPath + ext, { force: true });
  renameSync(tmp, dbPath);
  return "restored";
}

export class Snapshotter {
  private last: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<"saved" | "unchanged"> | null = null;
  private readonly db: DB;
  private readonly store: SnapshotStore;
  private readonly key: Buffer;
  private readonly intervalMs: number;
  private readonly log: (m: string) => void;

  constructor(o: { db: DB; store: SnapshotStore; key: Buffer; intervalMs?: number; log?: (m: string) => void }) {
    this.db = o.db;
    this.store = o.store;
    this.key = o.key;
    this.intervalMs = o.intervalMs ?? 30_000;
    this.log = o.log ?? (() => {});
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.snapshotNow().catch((e) => this.log(`[snapshot] gagal: ${(e as Error).message}`));
    }, this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ambil salinan konsisten; kirim hanya bila berubah. Panggilan bersamaan digabung. */
  snapshotNow(): Promise<"saved" | "unchanged"> {
    if (!this.running) this.running = this.take().finally(() => (this.running = null));
    return this.running;
  }

  private async take(): Promise<"saved" | "unchanged"> {
    const tmp = join(tmpdir(), `kambe-snap-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}.db`);
    try {
      this.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const raw = readFileSync(tmp);
      const sha256 = createHash("sha256").update(raw).digest("hex");
      if (sha256 === this.last) return "unchanged";
      await this.store.save(sealSnapshot(this.key, raw), { sha256, size: raw.length, at: Date.now() });
      this.last = sha256;
      return "saved";
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}

/** Penyimpanan di MongoDB (GridFS, jadi ukuran tidak dibatasi 16 MB). Menyimpan 3 versi terakhir. */
export async function mongoSnapshotStore(uri: string, dbName = "kambe", name = "kambe-db"): Promise<SnapshotStore> {
  const { MongoClient, GridFSBucket } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
  await client.connect();
  const bucket = new GridFSBucket(client.db(dbName), { bucketName: "snapshots" });
  const files = () => bucket.find({ filename: name }).sort({ uploadDate: -1 }).toArray();
  return {
    async load() {
      const [latest] = await files();
      if (!latest) return null;
      const chunks: Buffer[] = [];
      for await (const c of bucket.openDownloadStream(latest._id)) chunks.push(c as Buffer);
      return Buffer.concat(chunks);
    },
    async save(blob, meta) {
      await new Promise<void>((resolve, reject) => {
        const up = bucket.openUploadStream(name, { metadata: meta });
        up.on("finish", () => resolve());
        up.on("error", reject);
        up.end(blob);
      });
      const old = (await files()).slice(3);
      for (const f of old) await bucket.delete(f._id);
    },
    close: () => client.close(),
  };
}
