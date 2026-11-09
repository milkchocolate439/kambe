// Web Push: popup notifikasi di HP/desktop saat KAMBE tertutup ("SSSSSTTT!! Pesan baru dari …").
//
// - Isi pesan TIDAK pernah ikut (E2EE — server memang tidak bisa membacanya); hanya alias pengirim.
// - Push hanya dikirim bila penerima TIDAK sedang tersambung (bila tersambung, aplikasi sendiri yang
//   berbunyi & menampilkan popup), dan tidak untuk pesan kendali (etalase/Buku Jejak).
// - Kunci VAPID diturunkan dari KAMBE_NOTARY_SEED (stabil di hosting tanpa disk) atau disimpan di berkas.

import type { IncomingMessage } from "node:http";
import { createECDH, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import webpush from "web-push";
import type { DB } from "./db.ts";
import { HttpError, type AuthHandler, type Handler, type Row } from "./http.ts";

export interface VapidKeys {
  publicKey: string; // base64url, titik P-256 tak terkompresi (65 byte)
  privateKey: string; // base64url, 32 byte
}

export interface PushMessage {
  title: string;
  body: string;
  tag: string;
  url: string;
}

/** Pengirim push (bisa diganti di tes). Melempar galat dengan `statusCode` 404/410 bila langganan mati. */
export type PushSender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<void>;

const b64url = (b: Buffer) => b.toString("base64url");

/** VAPID deterministik dari seed rahasia. */
export function vapidFromSeed(seed: string): VapidKeys {
  const d = createHash("sha256").update(`kambe-vapid|${seed}`).digest();
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(d) };
}

/** VAPID dari berkas (dibuat sekali, izin 0600). */
export function vapidFromFile(path: string): VapidKeys {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as VapidKeys;
  const k = webpush.generateVAPIDKeys();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(k), { mode: 0o600 });
  return k;
}

export interface PushDeps {
  db: DB;
  route: (method: string, path: string, handler: Handler) => void;
  authed: (h: AuthHandler) => Handler;
  readJson: (req: IncomingMessage, maxBytes?: number) => Promise<Row>;
  limit: (key: string, max: number, windowMs: number, message: string) => void;
  vapid: VapidKeys;
  subject: string;
  sender?: PushSender;
  log: (m: string) => void;
}

const MAX_SUBS_PER_USER = 10;

export function registerPush(d: PushDeps) {
  const { db, route, authed } = d;
  db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
    endpoint   TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs(user_id);`);

  const send: PushSender =
    d.sender ??
    ((sub, payload) =>
      webpush
        .sendNotification(sub, payload, { TTL: 3600, urgency: "high", vapidDetails: { subject: d.subject, publicKey: d.vapid.publicKey, privateKey: d.vapid.privateKey } })
        .then(() => undefined));

  route("GET", "/api/push/key", () => ({ publicKey: d.vapid.publicKey }));

  route("POST", "/api/push/subscribe", authed(async ({ req, user }) => {
    d.limit(`push-sub:${user.id}`, 30, 60 * 60 * 1000, "Terlalu sering mengatur notifikasi.");
    const body = await d.readJson(req);
    const endpoint = body.endpoint;
    const keys = body.keys as Record<string, unknown> | undefined;
    if (typeof endpoint !== "string" || !/^https:\/\/[^\s]{8,}$/.test(endpoint) || endpoint.length > 1000) throw new HttpError(400, "bad_endpoint", "Langganan notifikasi tidak valid");
    if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string" || keys.p256dh.length > 200 || keys.auth.length > 100) {
      throw new HttpError(400, "bad_keys", "Langganan notifikasi tidak valid");
    }
    db.prepare(
      `INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    ).run(endpoint, user.id, keys.p256dh, keys.auth, Date.now());
    // Batasi jumlah perangkat per akun (yang paling lama dihapus).
    db.prepare(`DELETE FROM push_subs WHERE user_id = ? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE user_id = ? ORDER BY created_at DESC LIMIT ${MAX_SUBS_PER_USER})`).run(user.id, user.id);
    return { ok: true };
  }));

  route("DELETE", "/api/push/subscribe", authed(async ({ req, user }) => {
    const body = await d.readJson(req);
    if (typeof body.endpoint === "string") db.prepare("DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?").run(body.endpoint, user.id);
    return { ok: true };
  }));

  // Maksimal satu popup per (penerima, pengirim) per 15 detik — tag yang sama juga menggabungkan popup di HP.
  const lastSent = new Map<string, number>();

  return {
    /** Kirim push ke semua perangkat penerima. Tidak pernah melempar (gagal = dicatat). */
    async notify(userId: string, msg: PushMessage, throttleKey: string, now = Date.now()): Promise<number> {
      const k = `${userId}|${throttleKey}`;
      if (now - (lastSent.get(k) ?? 0) < 15_000) return 0;
      lastSent.set(k, now);
      if (lastSent.size > 10_000) lastSent.clear();
      const subs = db.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?").all(userId) as { endpoint: string; p256dh: string; auth: string }[];
      let sent = 0;
      await Promise.all(
        subs.map(async (s) => {
          try {
            await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg));
            sent++;
          } catch (e) {
            const code = (e as { statusCode?: number }).statusCode;
            if (code === 404 || code === 410) db.prepare("DELETE FROM push_subs WHERE endpoint = ?").run(s.endpoint);
            else d.log(`[push] gagal (${code ?? "?"}): ${(e as Error).message}`);
          }
        }),
      );
      return sent;
    },
  };
}

export type Push = ReturnType<typeof registerPush>;
