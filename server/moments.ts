// Fase 3 — Path Moments terenkripsi end-to-end.
// Klien mengenkripsi momen satu per satu untuk setiap kontak (+ salinan diri sendiri) memakai
// saluran "moment" (AAD terpisah dari chat). Server hanya memvalidasi metadata & menyimpan
// ciphertext. Hanya kontak SAAT INI yang bisa melihat; momen terhapus otomatis setelah 30 hari.

import type { IncomingMessage } from "node:http";
import { tx, type DB } from "./db.ts";
import { HttpError, type AuthHandler, type Handler, type Row, type UserRow } from "./http.ts";
import { isValidPublicKey, NONCE_BYTES } from "../shared/e2ee.ts";
import {
  MAX_MOMENT_COPIES,
  MOMENT_TTL_MS,
  REACTIONS,
  UUID_RE,
  type Reaction,
  type ServerEvent,
  type StoredMoment,
} from "../shared/protocol.ts";

export interface MomentsDeps {
  db: DB;
  route: (method: string, path: string, handler: Handler) => void;
  authed: (h: AuthHandler) => Handler;
  readJson: (req: IncomingMessage, maxBytes?: number) => Promise<Row>;
  limit: (key: string, max: number, windowMs: number, message: string) => void;
  emit: (userId: string, ev: ServerEvent) => void;
  getUser: (id: string) => UserRow | undefined;
  areContacts: (a: string, b: string) => boolean;
}

const HOUR = 60 * 60 * 1000;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const NONCE_B64_LEN = Math.ceil(NONCE_BYTES / 3) * 4;
const MOMENT_CT_MAX = 4096; // 500 karakter teks + JSON + tag GCM, dalam base64
// Teks 500 karakter bisa berisi emoji 4 byte → ±2 KB plaintext → ±3 KB per salinan (base64 + nonce
// + kunci + id + JSON) × (500 kontak + diri sendiri) ≈ 1,5 MB. Endpoint ini juga dibatasi 30/jam.
const MOMENT_BODY_MAX = 2.5 * 1024 * 1024;

export function registerMoments(d: MomentsDeps) {
  const { db, route, authed } = d;

  /** Boleh melihat momen penulis ini? Diri sendiri, atau kontak aktif yang tidak saling blokir. */
  const canSee = (viewer: string, author: string) => viewer === author || d.areContacts(viewer, author);

  route("POST", "/api/moments", authed(async ({ req, user }) => {
    d.limit(`moment-post:${user.id}`, 30, HOUR, "Terlalu banyak momen dalam satu jam.");
    // Satu salinan terenkripsi per kontak → body bisa besar; batas eksplisit cukup untuk MAX_MOMENT_COPIES
    // (temuan audit Fase 3 #2: batas default 32 KB membuat momen gagal untuk ±40+ kontak).
    const body = await d.readJson(req, MOMENT_BODY_MAX);
    const id = body.id;
    const fromKey = body.fromKey;
    const copies = body.copies;
    if (typeof id !== "string" || !UUID_RE.test(id)) throw new HttpError(400, "bad_id", "ID momen tidak valid");
    if (!isValidPublicKey(fromKey) || fromKey !== user.public_key) throw new HttpError(409, "stale_device_key", "Akun ini aktif di perangkat lain");
    if (!Array.isArray(copies) || copies.length === 0 || copies.length > MAX_MOMENT_COPIES + 1) {
      throw new HttpError(400, "bad_copies", `Salinan momen harus 1–${MAX_MOMENT_COPIES + 1}`);
    }

    const seen = new Set<string>();
    const stale: string[] = [];
    let hasSelf = false;
    for (const c of copies as Row[]) {
      if (
        typeof c !== "object" || c === null ||
        typeof c.to !== "string" || seen.has(c.to) ||
        !isValidPublicKey(c.toKey) ||
        typeof c.nonce !== "string" || c.nonce.length !== NONCE_B64_LEN || !B64_RE.test(c.nonce) ||
        typeof c.ciphertext !== "string" || c.ciphertext.length === 0 || c.ciphertext.length > MOMENT_CT_MAX || !B64_RE.test(c.ciphertext)
      ) {
        throw new HttpError(400, "bad_copy", "Format salinan momen tidak valid");
      }
      seen.add(c.to);
      if (c.to === user.id) {
        if (c.toKey !== user.public_key) throw new HttpError(400, "bad_copy", "Salinan pribadi harus memakai kunci perangkat ini");
        hasSelf = true;
        continue;
      }
      // Hanya kontak aktif — momen tidak bisa "disemprotkan" ke orang asing.
      if (!d.areContacts(user.id, c.to)) throw new HttpError(403, "not_contacts", "Momen hanya bisa dibagikan ke kontak");
      if (d.getUser(c.to)?.public_key !== c.toKey) stale.push(c.to);
    }
    if (!hasSelf) throw new HttpError(400, "self_copy_required", "Sertakan salinan untuk dirimu sendiri");
    if (stale.length) throw new HttpError(409, "key_changed", "Kunci beberapa kontak berubah. Muat ulang lalu coba lagi.");

    const now = Date.now();
    tx(db, () => {
      if (db.prepare("SELECT 1 FROM moments WHERE id = ?").get(id)) throw new HttpError(409, "duplicate", "Momen sudah ada");
      db.prepare("INSERT INTO moments (id, author_id, author_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(id, user.id, fromKey, now, now + MOMENT_TTL_MS);
      const ins = db.prepare("INSERT INTO moment_copies (moment_id, recipient_id, recipient_key, nonce, ciphertext) VALUES (?, ?, ?, ?, ?)");
      for (const c of copies as Row[]) ins.run(id, c.to as string, c.toKey as string, c.nonce as string, c.ciphertext as string);
    });
    for (const c of copies as Row[]) d.emit(c.to as string, { t: "moments_changed" });
    return { id, createdAt: now, expiresAt: now + MOMENT_TTL_MS };
  }));

  route("GET", "/api/moments", authed(({ user, url }) => {
    const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
    const rows = db
      .prepare(
        `SELECT m.id, m.author_id, m.author_key, m.created_at, m.expires_at, u.alias,
                c.recipient_key, c.nonce, c.ciphertext,
                (SELECT emoji FROM moment_reactions r WHERE r.moment_id = m.id AND r.user_id = ?) AS mine
         FROM moment_copies c
         JOIN moments m ON m.id = c.moment_id
         JOIN users u ON u.id = m.author_id
         WHERE c.recipient_id = ? AND m.expires_at > ? AND m.created_at < ?
           AND (m.author_id = ? OR EXISTS (SELECT 1 FROM contacts k WHERE k.user_id = ? AND k.peer_id = m.author_id))
           AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = ? AND b.blocked_id = m.author_id) OR (b.user_id = m.author_id AND b.blocked_id = ?))
         ORDER BY m.created_at DESC LIMIT 50`,
      )
      .all(user.id, user.id, Date.now(), before, user.id, user.id, user.id, user.id) as Row[];
    const counts = db.prepare("SELECT emoji, COUNT(*) AS n FROM moment_reactions WHERE moment_id = ? GROUP BY emoji");
    const moments: StoredMoment[] = rows.map((r) => {
      const reactions = { smile: 0, gasp: 0, love: 0 } as Record<Reaction, number>;
      for (const c of counts.all(r.id as string) as { emoji: Reaction; n: number }[]) reactions[c.emoji] = c.n;
      return {
        id: r.id as string,
        authorId: r.author_id as string,
        authorAlias: r.alias as string,
        authorKey: r.author_key as string,
        createdAt: r.created_at as number,
        expiresAt: r.expires_at as number,
        copy: { toKey: r.recipient_key as string, nonce: r.nonce as string, ciphertext: r.ciphertext as string },
        reactions,
        myReaction: (r.mine as Reaction | null) ?? null,
      };
    });
    return { moments, hasMore: rows.length === 50 };
  }));

  route("POST", "/api/moments/:id/react", authed(async ({ req, user, params }) => {
    d.limit(`moment-react:${user.id}`, 300, HOUR, "Terlalu banyak reaksi.");
    const emoji = (await d.readJson(req)).emoji;
    if (emoji !== null && !(REACTIONS as readonly unknown[]).includes(emoji)) throw new HttpError(400, "bad_emoji", "Reaksi tidak dikenal");
    const m = db
      .prepare("SELECT m.author_id FROM moments m JOIN moment_copies c ON c.moment_id = m.id AND c.recipient_id = ? WHERE m.id = ? AND m.expires_at > ?")
      .get(user.id, params.id, Date.now()) as { author_id: string } | undefined;
    if (!m || !canSee(user.id, m.author_id)) throw new HttpError(404, "not_found", "Momen tidak ditemukan");
    if (emoji === null) db.prepare("DELETE FROM moment_reactions WHERE moment_id = ? AND user_id = ?").run(params.id, user.id);
    else
      db.prepare(
        `INSERT INTO moment_reactions (moment_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(moment_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at`,
      ).run(params.id, user.id, emoji as string, Date.now());
    d.emit(m.author_id, { t: "moments_changed" });
    return { ok: true };
  }));

  route("DELETE", "/api/moments/:id", authed(({ user, params }) => {
    const recipients = (db.prepare("SELECT recipient_id FROM moment_copies WHERE moment_id = ?").all(params.id) as { recipient_id: string }[]).map((r) => r.recipient_id);
    const { changes } = db.prepare("DELETE FROM moments WHERE id = ? AND author_id = ?").run(params.id, user.id);
    if (Number(changes) === 0) throw new HttpError(404, "not_found", "Momen tidak ditemukan");
    for (const r of recipients) d.emit(r, { t: "moments_changed" });
    return { ok: true };
  }));

  function sweep(now = Date.now()) {
    db.prepare("DELETE FROM moments WHERE expires_at <= ?").run(now);
  }

  return { sweep };
}
