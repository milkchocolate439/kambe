// Penyimpanan lampiran terenkripsi (foto bukti bayar & foto etalase).
// Server hanya menyimpan blob acak + sidiknya; kunci dekripsi ada di isi tersegel pihak yang berhak.
//
// Hak akses unduh:
//  - "proof"   (bukti bayar)  : pembeli, penjual & moderator kesepakatan tsb.
//  - "product" (foto etalase) : pemilik & kontaknya (hanya setelah ditautkan ke produk).
// Lampiran yang tak pernah ditautkan dihapus setelah 1 hari; bukti bayar dihapus 30 hari setelah
// kesepakatan ditutup (hemat ruang — juga ikut snapshot MongoDB).

import type { IncomingMessage } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { ATTACH_MAX_BYTES } from "../shared/attach.ts";
import type { DB } from "./db.ts";
import { HttpError, type AuthHandler, type Handler, type Row, type UserRow } from "./http.ts";

export type AttachKind = "proof" | "product";

export interface AttachDeps {
  db: DB;
  route: (method: string, path: string, handler: Handler) => void;
  authed: (h: AuthHandler) => Handler;
  readJson: (req: IncomingMessage, maxBytes?: number) => Promise<Row>;
  limit: (key: string, max: number, windowMs: number, message: string) => void;
  areContacts: (a: string, b: string) => boolean;
  isModerator: (u: UserRow) => boolean;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_UNLINKED = 10;

export function registerAttachments(d: AttachDeps) {
  const { db, route, authed } = d;
  db.exec(`CREATE TABLE IF NOT EXISTS attachments (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('proof','product')),
    context    TEXT,
    data       BLOB NOT NULL,
    size       INTEGER NOT NULL,
    sha256     TEXT NOT NULL,
    linked     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS attachments_owner ON attachments(owner_id, linked);`);

  const getDeal = (id: string) => db.prepare("SELECT id, buyer_id, seller_id, status, direct, payinfo_object FROM deals WHERE id = ?").get(id) as Row | undefined;

  route("POST", "/api/attachments", authed(async ({ req, user }) => {
    d.limit(`attach:${user.id}`, 60, HOUR, "Terlalu banyak unggahan foto dalam satu jam.");
    const body = await d.readJson(req, Math.ceil((ATTACH_MAX_BYTES * 4) / 3) + 4096);
    const kind = body.kind;
    if (kind !== "proof" && kind !== "product") throw new HttpError(400, "bad_kind", "Jenis lampiran tidak dikenal");
    if (typeof body.data !== "string" || !B64_RE.test(body.data)) throw new HttpError(400, "bad_data", "Data lampiran tidak valid");
    const data = Buffer.from(body.data, "base64");
    if (data.length < 29 || data.length > ATTACH_MAX_BYTES) throw new HttpError(413, "too_large", "Foto terlalu besar");
    let context: string | null = null;
    if (kind === "proof") {
      const deal = typeof body.context === "string" ? getDeal(body.context) : undefined;
      if (!deal || deal.buyer_id !== user.id) throw new HttpError(404, "not_found", "Kesepakatan tidak ditemukan");
      if (!deal.direct || deal.status !== "AWAITING_PAYMENT") throw new HttpError(409, "bad_state", "Bukti bayar hanya untuk kesepakatan yang menunggu pembayaran");
      if (!deal.payinfo_object) throw new HttpError(409, "payinfo_missing", "Penjual belum mengirim rekening penerima. Tunggu rekeningnya dulu.");
      context = deal.id as string;
    }
    const pending = db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE owner_id = ? AND linked = 0").get(user.id) as { n: number };
    if (pending.n >= MAX_UNLINKED) throw new HttpError(429, "too_many", "Terlalu banyak foto yang belum dipakai. Coba lagi nanti.");
    const id = randomUUID();
    const sha256 = createHash("sha256").update(data).digest("hex");
    db.prepare("INSERT INTO attachments (id, owner_id, kind, context, data, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      id, user.id, kind, context, data, data.length, sha256, Date.now(),
    );
    return { id, size: data.length, sha256 };
  }));

  route("GET", "/api/attachments/:id", authed(({ user, params }) => {
    const a = db.prepare("SELECT * FROM attachments WHERE id = ?").get(params.id) as Row | undefined;
    const deny = () => new HttpError(404, "not_found", "Lampiran tidak ditemukan");
    if (!a) throw deny();
    const owner = a.owner_id as string;
    let ok = owner === user.id;
    if (!ok && a.kind === "proof") {
      const deal = getDeal(a.context as string);
      ok = !!deal && !!a.linked && (deal.buyer_id === user.id || deal.seller_id === user.id || d.isModerator(user));
    }
    if (!ok && a.kind === "product") ok = !!a.linked && d.areContacts(user.id, owner);
    if (!ok) throw deny();
    return { data: Buffer.from(a.data as Uint8Array).toString("base64"), sha256: a.sha256 as string };
  }));

  return {
    /** Tautkan lampiran milik `owner` (jenis & konteks harus cocok). Melempar 400 bila tidak sah. */
    link(ids: unknown, owner: string, kind: AttachKind, context: string | null, max: number): string[] {
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > max || ids.some((x) => typeof x !== "string")) {
        throw new HttpError(400, "attachment_required", kind === "proof" ? "Foto bukti pembayaran wajib diunggah" : "Foto wajib");
      }
      const uniq = [...new Set(ids as string[])];
      for (const id of uniq) {
        const a = db.prepare("SELECT owner_id, kind, context, linked FROM attachments WHERE id = ?").get(id) as Row | undefined;
        if (!a || a.owner_id !== owner || a.kind !== kind || (a.context ?? null) !== context || a.linked) {
          throw new HttpError(400, "bad_attachment", "Foto tidak valid atau sudah dipakai");
        }
      }
      for (const id of uniq) db.prepare("UPDATE attachments SET linked = 1 WHERE id = ?").run(id);
      return uniq;
    },
    remove(id: string | null | undefined) {
      if (id) db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    },
    /** Hapus yang tak pernah dipakai (> 1 hari) & bukti bayar kesepakatan yang sudah lama ditutup (> 30 hari). */
    sweep(now = Date.now()): number {
      const a = Number(db.prepare("DELETE FROM attachments WHERE linked = 0 AND created_at <= ?").run(now - DAY).changes);
      const b = Number(
        db.prepare("DELETE FROM attachments WHERE kind = 'proof' AND context IN (SELECT id FROM deals WHERE closed_at IS NOT NULL AND closed_at <= ?)").run(now - 30 * DAY).changes,
      );
      return a + b;
    },
  };
}

export type Attachments = ReturnType<typeof registerAttachments>;
