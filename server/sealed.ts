// Penyimpanan sealed object di server: HANYA ciphertext + bungkus kunci per penerima.
// Server memvalidasi format, pemilik (kunci perangkat terbaru), dan SIAPA yang boleh menerima
// per jenis objek — tapi tidak pernah bisa membaca isi (lihat shared/sealed.ts).

import { createHash } from "node:crypto";
import { tx, type DB } from "./db.ts";
import { HttpError, type Row, type UserRow } from "./http.ts";
import { isValidPublicKey, NONCE_BYTES } from "../shared/e2ee.ts";
import { SEALED_CT_MAX_B64, SEALED_KINDS, type SealedBlob, type SealedKind, type SealedView, type Wrap } from "../shared/sealed.ts";
import { UUID_RE } from "../shared/protocol.ts";

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const NONCE_B64 = Math.ceil(NONCE_BYTES / 3) * 4;
const WRAP_B64_MAX = 128; // 32 byte kunci + 16 byte tag GCM

export interface SealedDeps {
  db: DB;
  getUser: (id: string) => UserRow | undefined;
  /** Daftar penerima yang sah untuk objek ini (selain pemilik, yang selalu sah). */
  allowed: (kind: SealedKind, ownerId: string, context: string | null) => Set<string>;
}

export function createSealedStore(d: SealedDeps) {
  const { db } = d;

  function parseWrap(w: unknown): Wrap {
    const o = w as Record<string, unknown>;
    if (
      typeof o !== "object" || o === null ||
      typeof o.to !== "string" || o.to.length > 64 ||
      !isValidPublicKey(o.toKey) ||
      typeof o.nonce !== "string" || o.nonce.length !== NONCE_B64 || !B64_RE.test(o.nonce) ||
      typeof o.wrapped !== "string" || o.wrapped.length > WRAP_B64_MAX || !B64_RE.test(o.wrapped)
    ) {
      throw new HttpError(400, "bad_sealed", "Format bungkus kunci tidak valid");
    }
    return { to: o.to, toKey: o.toKey, nonce: o.nonce, wrapped: o.wrapped };
  }

  /** Validasi bentuk objek dari klien (belum menyimpan). */
  function parse(raw: unknown, kind: SealedKind, owner: UserRow): SealedBlob {
    const o = raw as Record<string, unknown>;
    if (typeof o !== "object" || o === null) throw new HttpError(400, "bad_sealed", "Isi terenkripsi wajib disertakan");
    if (typeof o.id !== "string" || !UUID_RE.test(o.id)) throw new HttpError(400, "bad_sealed", "ID objek tidak valid");
    if (o.kind !== kind || !(SEALED_KINDS as readonly unknown[]).includes(o.kind)) throw new HttpError(400, "bad_sealed", "Jenis objek tidak cocok");
    if (o.ownerKey !== owner.public_key || !isValidPublicKey(o.ownerKey)) throw new HttpError(409, "stale_device_key", "Akun ini aktif di perangkat lain");
    if (typeof o.nonce !== "string" || o.nonce.length !== NONCE_B64 || !B64_RE.test(o.nonce)) throw new HttpError(400, "bad_sealed", "Nonce tidak valid");
    if (typeof o.ciphertext !== "string" || !o.ciphertext || o.ciphertext.length > SEALED_CT_MAX_B64 || !B64_RE.test(o.ciphertext)) {
      throw new HttpError(400, "bad_sealed", "Ciphertext tidak valid atau terlalu besar");
    }
    if (!Array.isArray(o.wraps) || o.wraps.length === 0 || o.wraps.length > 600) throw new HttpError(400, "bad_sealed", "Bungkus kunci tidak valid");
    return { id: o.id, kind, ownerKey: o.ownerKey, nonce: o.nonce, ciphertext: o.ciphertext, wraps: o.wraps.map(parseWrap) };
  }

  /** Periksa daftar penerima: sah untuk jenis/konteks ini & memakai kunci perangkat mereka yang TERBARU. */
  function checkWraps(wraps: Wrap[], kind: SealedKind, owner: UserRow, context: string | null, requireSelf: boolean) {
    const ok = d.allowed(kind, owner.id, context);
    const seen = new Set<string>();
    let self = false;
    const stale: string[] = [];
    for (const w of wraps) {
      if (seen.has(w.to)) throw new HttpError(400, "bad_sealed", "Penerima ganda");
      seen.add(w.to);
      if (w.to === owner.id) {
        if (w.toKey !== owner.public_key) throw new HttpError(400, "bad_sealed", "Bungkus pribadi harus memakai kunci perangkat ini");
        self = true;
        continue;
      }
      if (!ok.has(w.to)) throw new HttpError(403, "recipient_not_allowed", "Penerima ini tidak berhak atas isi tersebut");
      if (d.getUser(w.to)?.public_key !== w.toKey) stale.push(w.to);
    }
    if (requireSelf && !self) throw new HttpError(400, "bad_sealed", "Sertakan bungkus untuk dirimu sendiri");
    if (stale.length) throw new HttpError(409, "key_changed", "Kunci beberapa penerima berubah. Muat ulang lalu coba lagi.");
  }

  /** Simpan objek baru (di dalam transaksi pemanggil bila ada). Mengembalikan id. */
  function store(raw: unknown, kind: SealedKind, owner: UserRow, context: string | null = null): string {
    const blob = parse(raw, kind, owner);
    checkWraps(blob.wraps, kind, owner, context, true);
    return tx(db, () => {
      if (db.prepare("SELECT 1 FROM sealed_objects WHERE id = ?").get(blob.id)) throw new HttpError(409, "duplicate", "Objek sudah ada");
      db.prepare("INSERT INTO sealed_objects (id, kind, owner_id, owner_key, nonce, ciphertext, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        blob.id,
        kind,
        owner.id,
        blob.ownerKey,
        blob.nonce,
        blob.ciphertext,
        context,
        Date.now(),
      );
      const ins = db.prepare("INSERT INTO sealed_wraps (object_id, recipient_id, recipient_key, nonce, wrapped) VALUES (?, ?, ?, ?, ?)");
      for (const w of blob.wraps) ins.run(blob.id, w.to, w.toKey, w.nonce, w.wrapped);
      return blob.id;
    });
  }

  /** Pemilik menambah/memperbarui bungkus untuk penerima baru (kontak baru, moderator, kunci baru). */
  function addWraps(objectId: string, owner: UserRow, rawWraps: unknown): number {
    const obj = db.prepare("SELECT * FROM sealed_objects WHERE id = ?").get(objectId) as Row | undefined;
    if (!obj || obj.owner_id !== owner.id) throw new HttpError(404, "not_found", "Objek tidak ditemukan");
    if (obj.owner_key !== owner.public_key) throw new HttpError(409, "stale_device_key", "Objek ini disegel perangkat lain");
    if (!Array.isArray(rawWraps) || rawWraps.length === 0 || rawWraps.length > 600) throw new HttpError(400, "bad_sealed", "Bungkus kunci tidak valid");
    const wraps = rawWraps.map(parseWrap);
    checkWraps(wraps, obj.kind as SealedKind, owner, (obj.context as string | null) ?? null, false);
    tx(db, () => {
      const up = db.prepare(
        `INSERT INTO sealed_wraps (object_id, recipient_id, recipient_key, nonce, wrapped) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(object_id, recipient_id) DO UPDATE SET recipient_key = excluded.recipient_key, nonce = excluded.nonce, wrapped = excluded.wrapped`,
      );
      for (const w of wraps) up.run(objectId, w.to, w.toKey, w.nonce, w.wrapped);
    });
    return wraps.length;
  }

  /** Tampilan untuk satu penerima: hanya bungkus miliknya. null bila objek tidak ada. */
  function view(objectId: string | null | undefined, viewerId: string): SealedView | null {
    if (!objectId) return null;
    const o = db.prepare("SELECT * FROM sealed_objects WHERE id = ?").get(objectId) as Row | undefined;
    if (!o) return null;
    const w = db.prepare("SELECT recipient_id, recipient_key, nonce, wrapped FROM sealed_wraps WHERE object_id = ? AND recipient_id = ?").get(objectId, viewerId) as Row | undefined;
    return {
      id: o.id as string,
      kind: o.kind as SealedKind,
      ownerId: o.owner_id as string,
      ownerKey: o.owner_key as string,
      nonce: o.nonce as string,
      ciphertext: o.ciphertext as string,
      wrap: w ? { to: w.recipient_id as string, toKey: w.recipient_key as string, nonce: w.nonce as string, wrapped: w.wrapped as string } : null,
    };
  }

  /** Daftar penerima yang sudah punya bungkus (agar pemilik tahu siapa yang perlu ditambah). */
  function recipients(objectId: string): { id: string; key: string }[] {
    return (db.prepare("SELECT recipient_id, recipient_key FROM sealed_wraps WHERE object_id = ?").all(objectId) as Row[]).map((r) => ({ id: r.recipient_id as string, key: r.recipient_key as string }));
  }

  function remove(objectId: string | null | undefined) {
    if (objectId) db.prepare("DELETE FROM sealed_objects WHERE id = ?").run(objectId);
  }

  function hashOf(objectId: string): string | null {
    const o = db.prepare("SELECT id, owner_key, nonce, ciphertext FROM sealed_objects WHERE id = ?").get(objectId) as Row | undefined;
    if (!o) return null;
    // Harus identik dengan shared/sealed.ts → sealedHash (sha256 "id|ownerKey|nonce|ciphertext").
    return createHash("sha256").update(`${o.id as string}|${o.owner_key as string}|${o.nonce as string}|${o.ciphertext as string}`).digest("hex");
  }

  function meta(objectId: string): { kind: SealedKind; ownerId: string; context: string | null } | null {
    const o = db.prepare("SELECT kind, owner_id, context FROM sealed_objects WHERE id = ?").get(objectId) as Row | undefined;
    return o ? { kind: o.kind as SealedKind, ownerId: o.owner_id as string, context: (o.context as string | null) ?? null } : null;
  }

  return { store, addWraps, view, recipients, remove, hashOf, parse, meta };
}

export type SealedStore = ReturnType<typeof createSealedStore>;
