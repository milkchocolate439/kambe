// Fase 3 — penemuan yang aman bagi pengguna:
//  - Shadow PIN: PIN sementara 24 jam untuk orang asing; bisa dicabut kapan saja.
//  - Radar ekonomi: opt-in, default MATI, kedaluwarsa sendiri (7 hari), hanya bisa dilihat sesama
//    peserta (resiprokal — penonton pasif/scraper tidak bisa mengintip), dan yang ditampilkan adalah
//    PIN radar khusus, bukan PIN utama. Undangan tetap wajib disetujui seperti biasa.

import type { IncomingMessage } from "node:http";
import { tx, type DB } from "./db.ts";
import { HttpError, type AuthHandler, type Handler, type Row } from "./http.ts";
import {
  MAX_ACTIVE_ONCE,
  MAX_ACTIVE_SHADOW,
  RADAR_HEADLINE_MAX,
  RADAR_TTL_MS,
  SECTORS,
  SHADOW_TTL_MS,
  type MyRadar,
  type RadarEntry,
  type ShadowPin,
} from "../shared/protocol.ts";

export interface DiscoveryDeps {
  db: DB;
  route: (method: string, path: string, handler: Handler) => void;
  authed: (h: AuthHandler) => Handler;
  readJson: (req: IncomingMessage) => Promise<Row>;
  str: (body: Row, key: string, opts?: { min?: number; max?: number; optional?: boolean }) => string;
  cleanText: (s: string) => string;
  limit: (key: string, max: number, windowMs: number, message: string) => void;
  uniquePin: () => string;
}

const HOUR = 60 * 60 * 1000;

export function registerDiscovery(d: DiscoveryDeps) {
  const { db, route, authed } = d;

  const toShadow = (r: Row): ShadowPin => ({
    pin: r.pin as string,
    kind: r.kind as ShadowPin["kind"],
    label: r.label as string,
    createdAt: r.created_at as number,
    expiresAt: r.expires_at as number,
  });

  // ------------------------------------------------------- Shadow PIN ---

  route("GET", "/api/shadow-pins", authed(({ user }) => ({
    pins: (db.prepare("SELECT * FROM shadow_pins WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC").all(user.id, Date.now()) as Row[]).map(toShadow),
  })));

  // once=true → PIN SEKALI PAKAI: hangus otomatis begitu dipakai untuk satu undangan (PIN dinamis).
  route("POST", "/api/shadow-pins", authed(async ({ req, user }) => {
    const body = await d.readJson(req);
    const label = d.cleanText(d.str(body, "label", { max: 80, optional: true })).slice(0, 40);
    const kind = body.once === true ? "once" : "shadow";
    d.limit(`shadow-create:${user.id}`, 20, 24 * HOUR, "Terlalu banyak PIN sementara dibuat hari ini.");
    const now = Date.now();
    const max = kind === "once" ? MAX_ACTIVE_ONCE : MAX_ACTIVE_SHADOW;
    const pin = tx(db, () => {
      const active = db.prepare("SELECT COUNT(*) AS n FROM shadow_pins WHERE user_id = ? AND kind = ? AND expires_at > ?").get(user.id, kind, now) as { n: number };
      if (active.n >= max) {
        throw new HttpError(409, "too_many_shadow", `Maksimal ${max} ${kind === "once" ? "PIN sekali pakai" : "Shadow PIN"} aktif. Cabut salah satu dulu.`);
      }
      const p = d.uniquePin();
      db.prepare("INSERT INTO shadow_pins (pin, user_id, kind, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(p, user.id, kind, label, now, now + SHADOW_TTL_MS);
      return p;
    });
    return toShadow(db.prepare("SELECT * FROM shadow_pins WHERE pin = ?").get(pin) as Row);
  }));

  route("DELETE", "/api/shadow-pins/:pin", authed(({ user, params }) => {
    const { changes } = db.prepare("DELETE FROM shadow_pins WHERE pin = ? AND user_id = ? AND kind IN ('shadow', 'once')").run(params.pin, user.id);
    if (Number(changes) === 0) throw new HttpError(404, "not_found", "Shadow PIN tidak ditemukan");
    // Undangan yang belum diterima lewat PIN ini ikut hangus — itulah gunanya mencabut.
    db.prepare("DELETE FROM contact_requests WHERE to_id = ? AND via_pin = ?").run(user.id, params.pin);
    return { ok: true };
  }));

  // ------------------------------------------------------------ Radar ---

  function myRadar(userId: string, now = Date.now()): MyRadar | null {
    const r = db.prepare("SELECT * FROM radar_entries WHERE user_id = ? AND expires_at > ?").get(userId, now) as Row | undefined;
    return r ? { sector: r.sector as string, headline: r.headline as string, pin: r.pin as string, expiresAt: r.expires_at as number } : null;
  }

  route("GET", "/api/radar/me", authed(({ user }) => ({ radar: myRadar(user.id) })));

  // Ikut / perpanjang radar 7 hari.
  route("PUT", "/api/radar", authed(async ({ req, user }) => {
    const body = await d.readJson(req);
    const sector = d.str(body, "sector", { min: 1, max: 40 });
    if (!(SECTORS as readonly string[]).includes(sector)) throw new HttpError(400, "bad_sector", "Sektor tidak dikenal");
    const headline = d.cleanText(d.str(body, "headline", { min: 1, max: RADAR_HEADLINE_MAX * 2 })).slice(0, RADAR_HEADLINE_MAX);
    if (headline.length < 10) throw new HttpError(400, "bad_headline", "Tulis kebutuhan/tawaranmu minimal 10 karakter");
    d.limit(`radar-write:${user.id}`, 10, 24 * HOUR, "Radar terlalu sering diubah hari ini.");
    const now = Date.now();
    const expires = now + RADAR_TTL_MS;
    tx(db, () => {
      const existing = myRadar(user.id, now);
      const pin = existing?.pin ?? d.uniquePin();
      db.prepare("DELETE FROM shadow_pins WHERE user_id = ? AND kind = 'radar' AND pin != ?").run(user.id, pin);
      db.prepare(
        `INSERT INTO shadow_pins (pin, user_id, kind, label, created_at, expires_at) VALUES (?, ?, 'radar', 'Radar', ?, ?)
         ON CONFLICT(pin) DO UPDATE SET expires_at = excluded.expires_at`,
      ).run(pin, user.id, now, expires);
      db.prepare(
        `INSERT INTO radar_entries (user_id, sector, headline, pin, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET sector = excluded.sector, headline = excluded.headline, pin = excluded.pin, expires_at = excluded.expires_at`,
      ).run(user.id, sector, headline, pin, now, expires);
    });
    return { radar: myRadar(user.id) };
  }));

  route("DELETE", "/api/radar", authed(({ user }) => {
    tx(db, () => {
      db.prepare("DELETE FROM radar_entries WHERE user_id = ?").run(user.id);
      db.prepare("DELETE FROM shadow_pins WHERE user_id = ? AND kind = 'radar'").run(user.id);
    });
    return { radar: null };
  }));

  // Lihat radar: hanya untuk peserta aktif, sampel acak, tanpa id internal.
  route("GET", "/api/radar", authed(({ user, url }) => {
    const now = Date.now();
    if (!myRadar(user.id, now)) throw new HttpError(403, "radar_optin_required", "Ikut radar dulu untuk melihat peserta lain (resiprokal demi keamanan).");
    d.limit(`radar-view:${user.id}`, 60, HOUR, "Radar terlalu sering dimuat. Coba lagi nanti.");
    const sector = url.searchParams.get("sector");
    if (sector && !(SECTORS as readonly string[]).includes(sector)) throw new HttpError(400, "bad_sector", "Sektor tidak dikenal");
    const rows = db
      .prepare(
        `SELECT r.sector, r.headline, r.pin, r.created_at, u.alias, u.pro_until
         FROM radar_entries r JOIN users u ON u.id = r.user_id
         WHERE r.expires_at > ? AND r.user_id != ? ${sector ? "AND r.sector = ?" : ""}
           AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = ? AND b.blocked_id = r.user_id) OR (b.user_id = r.user_id AND b.blocked_id = ?))
           AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.user_id = ? AND c.peer_id = r.user_id)
         ORDER BY random() LIMIT 20`,
      )
      .all(...([now, user.id, ...(sector ? [sector] : []), user.id, user.id, user.id] as (string | number)[])) as Row[];
    const entries: RadarEntry[] = rows.map((r) => ({
      alias: r.alias as string,
      pin: r.pin as string,
      sector: r.sector as string,
      headline: r.headline as string,
      pro: (r.pro_until as number) > now,
      since: r.created_at as number,
    }));
    return { entries };
  }));

  /** Bersihkan PIN & entri radar kedaluwarsa (dipanggil janitor). */
  function sweep(now = Date.now()) {
    db.prepare("DELETE FROM shadow_pins WHERE expires_at <= ?").run(now);
    db.prepare("DELETE FROM radar_entries WHERE expires_at <= ?").run(now);
  }

  return { sweep };
}
