import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { openDb, tx, type DB } from "./db.ts";
import { HttpError, type AuthHandler, type Ctx, type Handler, type Row, type UserRow } from "./http.ts";
import { registerCommerce, type DealTimers } from "./commerce.ts";
import { registerDiscovery } from "./discovery.ts";
import { registerMoments } from "./moments.ts";
import { createNotary } from "./notary.ts";
import { simulatedProvider, type PaymentProvider } from "./payments.ts";
import type { KeyObject } from "node:crypto";
import {
  RateLimiter,
  burnTime,
  generateRecoveryCode,
  hashSecret,
  newSessionToken,
  normalizeRecoveryCode,
  sha256,
  verifySecret,
} from "./security.ts";
import { generatePin, isValidPin, normalizePin } from "../shared/pin.ts";
import { isValidPublicKey, NONCE_BYTES } from "../shared/e2ee.ts";
import {
  ALIAS_RE,
  CIPHERTEXT_MAX_B64,
  NOTE_MAX,
  PASSPHRASE_MAX,
  PASSPHRASE_MIN,
  PING_COOLDOWN_MS,
  PM_MAX,
  UUID_RE,
  FEE_PER_MILLE,
  PIN_ROTATE_OPTIONS,
  type PinRotateDays,
  type ShadowKind,
  type ClientEvent,
  type Contact,
  type ContactsResponse,
  type DeliveryStatus,
  type Me,
  type ServerEvent,
  type StoredMessage,
} from "../shared/protocol.ts";

export interface AppOptions {
  dbPath: string;
  staticDir?: string;
  /** Set true di balik HTTPS agar cookie diberi atribut Secure + HSTS. */
  secure?: boolean;
  /** Percayai X-Forwarded-For (hanya bila di belakang reverse proxy milik sendiri). */
  trustProxy?: boolean;
  /** Daftar Origin yang diizinkan. Kosong = harus sama dengan header Host. */
  allowedOrigins?: string[];
  /** Tenggat rekber (lihat DealTimers). Default: cair 7 hr, batas kirim 3 hr, refund HELD 7 hr, sengketa 14 hr. */
  dealTimers?: Partial<DealTimers>;
  /** ID akun (UUID) moderator sengketa. Kosong = tidak ada moderator. */
  moderators?: string[];
  /** Kunci privat Ed25519 notaris kuitansi. Kosong = kunci sementara (hanya untuk tes). */
  notaryKey?: KeyObject;
  /** Fee platform per seribu (default 50 = 5%; maks. 200 = 20%). */
  feePerMille?: number;
  /** Penyedia pembayaran. Default: simulasi (tanpa uang sungguhan). */
  payments?: PaymentProvider;
  log?: (msg: string) => void;
}

const COOKIE = "pp_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BODY_LIMIT = 32 * 1024;
const MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const WS_MAX_PAYLOAD = 64 * 1024;
const HOUR = 60 * 60 * 1000;


/**
 * Uji ECDH dengan kunci sementara: kunci publik low-order menghasilkan rahasia
 * bersama nol (atau ditolak Web Crypto). Klien sudah menolaknya, tapi server
 * juga tidak menyimpannya agar tidak ada percakapan yang "rusak" secara diam-diam.
 */
async function isUsableX25519(publicKey: string): Promise<boolean> {
  try {
    const subtle = globalThis.crypto.subtle;
    const pub = await subtle.importKey("raw", Buffer.from(publicKey, "base64"), { name: "X25519" }, false, []);
    const probe = (await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
    const bits = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: pub }, probe.privateKey, 256));
    return bits.some((b) => b !== 0);
  } catch {
    return false;
  }
}


export function createApp(opts: AppOptions) {
  const db: DB = openDb(opts.dbPath);
  const limiter = new RateLimiter();
  const log = opts.log ?? (() => {});
  const sockets = new Map<string, Set<WebSocket & { tokenHash?: string; alive?: boolean }>>();

  // ------------------------------------------------------------ helpers ---

  const q = {
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    userByAlias: db.prepare("SELECT * FROM users WHERE alias = ?"),
    userByPin: db.prepare("SELECT * FROM users WHERE pin = ?"),
    session: db.prepare("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?"),
    isContact: db.prepare("SELECT 1 FROM contacts WHERE user_id = ? AND peer_id = ?"),
    isBlocked: db.prepare("SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)"),
    contactIds: db.prepare("SELECT peer_id FROM contacts WHERE user_id = ?"),
  };

  const getUser = (id: string) => q.userById.get(id) as UserRow | undefined;
  // Moderator ditentukan oleh ID akun (UUID acak buatan server), BUKAN alias: alias yang belum
  // terdaftar bisa diserobot siapa pun lewat pendaftaran (temuan audit Fase 3 #1).
  const moderatorIdSet = new Set((opts.moderators ?? []).filter((id) => UUID_RE.test(id)));
  for (const bad of (opts.moderators ?? []).filter((id) => !UUID_RE.test(id))) {
    log(`[peringatan] PINPATH_MODERATORS: "${bad}" bukan ID akun (UUID) — diabaikan. Cari ID dengan: node --import tsx scripts/moderator-id.ts <alias>`);
  }
  const isModerator = (u: UserRow) => moderatorIdSet.has(u.id);
  const notary = createNotary(opts.notaryKey);
  const feePerMille = opts.feePerMille ?? FEE_PER_MILLE;
  if (!Number.isInteger(feePerMille) || feePerMille < 0 || feePerMille > 200) throw new Error("feePerMille harus bilangan bulat 0–200 (0%–20%)");

  function toMe(u: UserRow): Me {
    return {
      id: u.id,
      alias: u.alias,
      pin: u.pin,
      publicKey: u.public_key,
      pm: u.pm,
      readReceipts: u.read_receipts === 1,
      createdAt: u.created_at,
      isModerator: isModerator(u),
      pinRotateDays: ((PIN_ROTATE_OPTIONS as readonly number[]).includes(u.pin_rotate_days) ? u.pin_rotate_days : 0) as PinRotateDays,
      pinRotatedAt: u.pin_rotated_at,
    };
  }

  function emit(userId: string, event: ServerEvent, exceptTokenHash?: string) {
    const set = sockets.get(userId);
    if (!set) return;
    const data = JSON.stringify(event);
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN && ws.tokenHash !== exceptTokenHash) ws.send(data);
    }
  }

  function closeSockets(userId: string, reason: string, onlyTokenHash?: string) {
    const set = sockets.get(userId);
    if (!set) return;
    for (const ws of set) {
      if (onlyTokenHash && ws.tokenHash !== onlyTokenHash) continue;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "session_ended", reason } satisfies ServerEvent));
      ws.close(4001, reason);
    }
  }

  function limit(key: string, max: number, windowMs: number, message: string) {
    if (!limiter.take(key, max, windowMs)) {
      throw new HttpError(429, "rate_limited", message, limiter.retryAfter(key, windowMs));
    }
  }

  function clientIp(req: IncomingMessage): string {
    if (opts.trustProxy) {
      const xff = req.headers["x-forwarded-for"];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  /** Tolak permintaan lintas-situs (CSRF / Cross-Site WebSocket Hijacking). */
  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return false;
    if (opts.allowedOrigins?.length) return opts.allowedOrigins.includes(origin);
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  function readCookie(req: IncomingMessage, name: string): string | null {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === name) return v.join("=");
    }
    return null;
  }

  function authenticate(req: IncomingMessage): { user: UserRow; tokenHash: string } | null {
    const token = readCookie(req, COOKIE);
    if (!token || token.length > 128) return null;
    const tokenHash = sha256(token);
    const row = q.session.get(tokenHash, Date.now()) as { user_id: string } | undefined;
    if (!row) return null;
    const user = getUser(row.user_id);
    return user ? { user, tokenHash } : null;
  }

  function sessionCookie(token: string, maxAgeMs: number): string {
    const attrs = [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    if (opts.secure) attrs.push("Secure");
    return attrs.join("; ");
  }

  function startSession(res: ServerResponse, userId: string) {
    const token = newSessionToken();
    const now = Date.now();
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
      sha256(token),
      userId,
      now,
      now + SESSION_TTL_MS,
    );
    res.setHeader("Set-Cookie", sessionCookie(token, SESSION_TTL_MS));
  }

  /** Body mentah (untuk verifikasi webhook yang harus melihat byte persis). */
  async function readRaw(req: IncomingMessage, maxBytes = BODY_LIMIT): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw new HttpError(413, "too_large", "Permintaan terlalu besar");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** Batas default 32 KB; endpoint tertentu (mis. momen = banyak salinan terenkripsi) boleh meminta lebih. */
  async function readJson(req: IncomingMessage, maxBytes = BODY_LIMIT): Promise<Row> {
    const type = req.headers["content-type"] ?? "";
    if (!type.startsWith("application/json")) throw new HttpError(415, "bad_content_type", "Gunakan application/json");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw new HttpError(413, "too_large", "Permintaan terlalu besar");
      chunks.push(chunk as Buffer);
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      return parsed as Row;
    } catch {
      throw new HttpError(400, "bad_json", "JSON tidak valid");
    }
  }

  function str(body: Row, key: string, { min = 0, max = 1000, optional = false } = {}): string {
    const v = body[key];
    if (v === undefined && optional) return "";
    if (typeof v !== "string") throw new HttpError(400, "bad_field", `Kolom ${key} wajib diisi`);
    if (v.length < min || v.length > max) throw new HttpError(400, "bad_field", `Panjang ${key} harus ${min}–${max} karakter`);
    return v;
  }

  /**
   * Bersihkan teks yang ditampilkan ke orang lain dari trik penipuan visual: karakter kontrol,
   * pembalik arah (RLO dsb.), mark arah LRM/RLM, karakter tak terlihat (zero-width, BOM, soft hyphen),
   * lalu normalisasi NFKC agar huruf "tiruan" (mis. ｐａｙ lebar penuh) jadi huruf biasa (temuan red-team F3).
   */
  function cleanText(s: string): string {
    return s
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "")
      .trim();
  }

  /**
   * PIN unik di seluruh ruang PIN (utama + shadow/sekali pakai/radar). PIN yang pernah dipakai untuk
   * terhubung TIDAK didaur ulang — kontak masih melihatnya, jadi memberikannya ke orang lain bisa
   * membuat orang salah sambung.
   */
  function uniquePin(): string {
    for (let i = 0; i < 20; i++) {
      const pin = generatePin();
      const taken =
        q.userByPin.get(pin) ||
        db.prepare("SELECT 1 FROM shadow_pins WHERE pin = ?").get(pin) ||
        db.prepare("SELECT 1 FROM contacts WHERE via_pin = ? LIMIT 1").get(pin) ||
        db.prepare("SELECT 1 FROM contact_requests WHERE via_pin = ? LIMIT 1").get(pin);
      if (!taken) return pin;
    }
    throw new HttpError(503, "pin_exhausted", "Gagal membuat PIN unik, coba lagi");
  }

  /** Cari pemilik PIN: PIN utama, atau Shadow/sekali pakai/radar PIN yang MASIH aktif. */
  function resolvePin(pin: string): { user: UserRow; via: { pin: string; kind: ShadowKind; label: string } | null } | null {
    const direct = q.userByPin.get(pin) as UserRow | undefined;
    if (direct) return { user: direct, via: null };
    const sp = db.prepare("SELECT user_id, kind, label FROM shadow_pins WHERE pin = ? AND expires_at > ?").get(pin, Date.now()) as
      | { user_id: string; kind: ShadowKind; label: string }
      | undefined;
    const owner = sp && getUser(sp.user_id);
    return owner ? { user: owner, via: { pin, kind: sp.kind, label: sp.label } } : null;
  }

  function messageStatus(m: Row, recipientReadReceipts: boolean): DeliveryStatus {
    if (m.read_at && recipientReadReceipts) return "R";
    if (m.delivered_at) return "D";
    return "S";
  }

  function toMessage(m: Row, recipientReadReceipts: boolean): StoredMessage {
    return {
      id: m.id as string,
      from: m.sender_id as string,
      to: m.recipient_id as string,
      fromKey: m.sender_key as string,
      toKey: m.recipient_key as string,
      nonce: m.nonce as string,
      ciphertext: m.ciphertext as string,
      ping: m.ping === 1,
      createdAt: m.created_at as number,
      status: messageStatus(m, recipientReadReceipts),
    };
  }

  function areContacts(a: string, b: string): boolean {
    return !!q.isContact.get(a, b) && !q.isBlocked.get(a, b, b, a);
  }

  /**
   * Relay store-and-forward: begitu penerima mengonfirmasi pesan sudah tersimpan di perangkatnya,
   * ciphertext DIHAPUS dari server. Yang tersisa hanya metadata minimum (status D/R & hitungan
   * belum dibaca), dan metadata pun dihapus setelah MESSAGE_RETENTION_MS.
   */
  function markDelivered(recipientId: string, ids: string[]) {
    const now = Date.now();
    const bySender = new Map<string, string[]>();
    const find = db.prepare("SELECT sender_id FROM messages WHERE id = ? AND recipient_id = ? AND delivered_at IS NULL");
    const upd = db.prepare("UPDATE messages SET delivered_at = ?, nonce = '', ciphertext = '' WHERE id = ?");
    tx(db, () => {
      for (const id of ids.slice(0, 200)) {
        const row = find.get(id, recipientId) as { sender_id: string } | undefined;
        if (!row) continue;
        upd.run(now, id);
        bySender.set(row.sender_id, [...(bySender.get(row.sender_id) ?? []), id]);
      }
    });
    for (const [sender, list] of bySender) emit(sender, { t: "status", ids: list, status: "D" });
  }

  // ------------------------------------------------------------- routes ---

  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];

  function route(method: string, path: string, handler: Handler) {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" + path.replace(/:(\w+)/g, (_m, k: string) => (keys.push(k), "([^/]+)")) + "$",
    );
    routes.push({ method, pattern, keys, handler });
  }

  function authed(handler: AuthHandler): Handler {
    return (ctx) => {
      const auth = authenticate(ctx.req);
      if (!auth) throw new HttpError(401, "unauthorized", "Silakan masuk dulu");
      return handler({ ...ctx, ...auth });
    };
  }

  // ---- akun ----

  route("POST", "/api/auth/signup", async ({ req, res, ip }) => {
    limit(`signup:${ip}`, 5, HOUR, "Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti.");
    const body = await readJson(req);
    const alias = str(body, "alias", { min: 3, max: 24 });
    const passphrase = str(body, "passphrase", { min: PASSPHRASE_MIN, max: PASSPHRASE_MAX });
    if (!ALIAS_RE.test(alias)) throw new HttpError(400, "bad_alias", "Alias 3–24 karakter: huruf, angka, atau _");
    if (passphrase.toLowerCase().includes(alias.toLowerCase())) {
      throw new HttpError(400, "weak_passphrase", "Passphrase tidak boleh mengandung alias");
    }
    if (q.userByAlias.get(alias)) throw new HttpError(409, "alias_taken", "Alias sudah dipakai, pilih yang lain");

    const recoveryCode = generateRecoveryCode();
    const [passHash, recoveryHash] = await Promise.all([hashSecret(passphrase), hashSecret(normalizeRecoveryCode(recoveryCode))]);
    const id = randomUUID();
    try {
      db.prepare(
        "INSERT INTO users (id, alias, pin, pass_hash, recovery_hash, created_at, pin_rotated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(id, alias, uniquePin(), passHash, recoveryHash, Date.now(), Date.now());
    } catch {
      throw new HttpError(409, "alias_taken", "Alias sudah dipakai, pilih yang lain");
    }
    startSession(res, id);
    return { me: toMe(getUser(id)!), recoveryCode };
  });

  route("POST", "/api/auth/login", async ({ req, res, ip }) => {
    const body = await readJson(req);
    const alias = str(body, "alias", { min: 1, max: 24 });
    const passphrase = str(body, "passphrase", { min: 1, max: PASSPHRASE_MAX });
    limit(`login-ip:${ip}`, 20, 15 * 60 * 1000, "Terlalu banyak percobaan masuk. Tunggu sebentar.");
    limit(`login-alias:${alias.toLowerCase()}`, 8, 15 * 60 * 1000, "Terlalu banyak percobaan untuk akun ini. Tunggu 15 menit.");
    const user = q.userByAlias.get(alias) as UserRow | undefined;
    if (!user) {
      await burnTime(passphrase);
      throw new HttpError(401, "bad_credentials", "Alias atau passphrase salah");
    }
    if (!(await verifySecret(passphrase, user.pass_hash))) throw new HttpError(401, "bad_credentials", "Alias atau passphrase salah");
    limiter.reset(`login-alias:${alias.toLowerCase()}`);
    startSession(res, user.id);
    return { me: toMe(user) };
  });

  route("POST", "/api/auth/recover", async ({ req, res, ip }) => {
    limit(`recover-ip:${ip}`, 5, HOUR, "Terlalu banyak percobaan pemulihan. Coba lagi nanti.");
    const body = await readJson(req);
    const alias = str(body, "alias", { min: 1, max: 24 });
    const code = normalizeRecoveryCode(str(body, "recoveryCode", { min: 20, max: 40 }));
    const passphrase = str(body, "newPassphrase", { min: PASSPHRASE_MIN, max: PASSPHRASE_MAX });
    limit(`recover-alias:${alias.toLowerCase()}`, 5, HOUR, "Terlalu banyak percobaan untuk akun ini.");
    const user = q.userByAlias.get(alias) as UserRow | undefined;
    if (!user) {
      await burnTime(code);
      throw new HttpError(401, "bad_recovery", "Alias atau kode pemulihan salah");
    }
    if (!(await verifySecret(code, user.recovery_hash))) throw new HttpError(401, "bad_recovery", "Alias atau kode pemulihan salah");

    // Kode pemulihan sekali pakai: langsung diganti, dan semua sesi lama dicabut.
    const recoveryCode = generateRecoveryCode();
    const [passHash, recoveryHash] = await Promise.all([hashSecret(passphrase), hashSecret(normalizeRecoveryCode(recoveryCode))]);
    tx(db, () => {
      db.prepare("UPDATE users SET pass_hash = ?, recovery_hash = ? WHERE id = ?").run(passHash, recoveryHash, user.id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    });
    closeSockets(user.id, "recovered");
    startSession(res, user.id);
    return { me: toMe(getUser(user.id)!), recoveryCode };
  });

  route("POST", "/api/auth/logout", authed(({ res, user, tokenHash }) => {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    closeSockets(user.id, "logout", tokenHash);
    res.setHeader("Set-Cookie", sessionCookie("", 0));
    return { ok: true };
  }));

  route("POST", "/api/auth/logout-all", authed(({ res, user }) => {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    closeSockets(user.id, "logout_all");
    res.setHeader("Set-Cookie", sessionCookie("", 0));
    return { ok: true };
  }));

  route("GET", "/api/me", authed(({ user }) => ({ me: toMe(user) })));

  route("PUT", "/api/me/key", authed(async ({ req, user, tokenHash }) => {
    limit(`key:${user.id}`, 10, 24 * HOUR, "Kunci perangkat terlalu sering diganti hari ini.");
    const publicKey = (await readJson(req)).publicKey;
    if (!isValidPublicKey(publicKey) || !(await isUsableX25519(publicKey))) {
      throw new HttpError(400, "bad_public_key", "Kunci publik tidak valid");
    }
    if (publicKey === user.public_key) return { me: toMe(user) };
    db.prepare("UPDATE users SET public_key = ? WHERE id = ?").run(publicKey, user.id);
    // Kontak perlu tahu agar memperingatkan "safety number berubah".
    for (const row of q.contactIds.all(user.id) as { peer_id: string }[]) emit(row.peer_id, { t: "key_changed", userId: user.id });
    emit(user.id, { t: "key_changed", userId: user.id }, tokenHash);
    return { me: toMe(getUser(user.id)!) };
  }));

  route("PATCH", "/api/me/settings", authed(async ({ req, user }) => {
    const body = await readJson(req);
    if (body.pm !== undefined) {
      const pm = cleanText(str(body, "pm", { max: PM_MAX * 2 })).slice(0, PM_MAX);
      db.prepare("UPDATE users SET pm = ? WHERE id = ?").run(pm, user.id);
    }
    if (body.readReceipts !== undefined) {
      if (typeof body.readReceipts !== "boolean") throw new HttpError(400, "bad_field", "readReceipts harus boolean");
      db.prepare("UPDATE users SET read_receipts = ? WHERE id = ?").run(body.readReceipts ? 1 : 0, user.id);
    }
    if (body.pinRotateDays !== undefined) {
      if (!(PIN_ROTATE_OPTIONS as readonly unknown[]).includes(body.pinRotateDays)) throw new HttpError(400, "bad_field", "Pilihan rotasi PIN: 0, 1, 7, atau 30 hari");
      // Hitungan dimulai dari sekarang agar mengaktifkan fitur tidak langsung mengganti PIN tanpa terduga.
      db.prepare("UPDATE users SET pin_rotate_days = ?, pin_rotated_at = ? WHERE id = ?").run(body.pinRotateDays as number, Date.now(), user.id);
    }
    for (const row of q.contactIds.all(user.id) as { peer_id: string }[]) emit(row.peer_id, { t: "contacts_changed" });
    return { me: toMe(getUser(user.id)!) };
  }));

  route("POST", "/api/me/pin/rotate", authed(({ user }) => {
    limit(`pin-rotate:${user.id}`, 5, 24 * HOUR, "PIN sudah terlalu sering diganti hari ini.");
    db.prepare("UPDATE users SET pin = ?, pin_rotated_at = ? WHERE id = ?").run(uniquePin(), Date.now(), user.id);
    // Undangan tertunda ke PIN lama ikut dibatalkan — itulah gunanya ganti PIN saat kena spam.
    db.prepare("DELETE FROM contact_requests WHERE to_id = ? AND via_pin IS NULL").run(user.id); // undangan lewat shadow/radar tetap
    for (const row of q.contactIds.all(user.id) as { peer_id: string }[]) emit(row.peer_id, { t: "contacts_changed" });
    return { me: toMe(getUser(user.id)!) };
  }));

  route("POST", "/api/me/delete", authed(async ({ req, res, user }) => {
    const passphrase = str(await readJson(req), "passphrase", { min: 1, max: PASSPHRASE_MAX });
    limit(`delete:${user.id}`, 5, HOUR, "Terlalu banyak percobaan.");
    if (!(await verifySecret(passphrase, user.pass_hash))) throw new HttpError(401, "bad_credentials", "Passphrase salah");
    // Jangan biarkan dana pihak lain tersangkut di rekber karena akun lawan hilang.
    if (commerce.hasOpenDeals(user.id)) {
      throw new HttpError(409, "open_deals", "Masih ada kesepakatan yang belum selesai. Selesaikan atau batalkan dulu sebelum menghapus akun.");
    }
    const peers = (q.contactIds.all(user.id) as { peer_id: string }[]).map((r) => r.peer_id);
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id); // CASCADE: sesi, kontak, pesan, blokir
    closeSockets(user.id, "deleted");
    for (const p of peers) emit(p, { t: "contacts_changed" });
    res.setHeader("Set-Cookie", sessionCookie("", 0));
    return { ok: true };
  }));

  // ---- kontak via PIN ----

  function contactsFor(userId: string): ContactsResponse {
    const contacts = (
      db
        .prepare(
          `SELECT u.id, u.alias, COALESCE(c.via_pin, u.pin) AS pin, u.public_key, u.pm, c.since,
             (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id AND m.recipient_id = c.user_id AND m.read_at IS NULL) AS unread,
             (SELECT MAX(m.created_at) FROM messages m
                WHERE (m.sender_id = u.id AND m.recipient_id = c.user_id) OR (m.sender_id = c.user_id AND m.recipient_id = u.id)) AS last_at
           FROM contacts c JOIN users u ON u.id = c.peer_id
           WHERE c.user_id = ?
           ORDER BY COALESCE(last_at, c.since) DESC`,
        )
        .all(userId) as Row[]
    ).map(
      (r): Contact => ({
        id: r.id as string,
        alias: r.alias as string,
        pin: r.pin as string,
        publicKey: r.public_key as string | null,
        pm: r.pm as string,
        since: r.since as number,
        unread: r.unread as number,
        lastMessageAt: (r.last_at as number | null) ?? null,
      }),
    );
    const incoming = (
      db
        .prepare(
          `SELECT r.id, r.note, r.created_at, r.via_pin, COALESCE(r.via_kind, s.kind) AS via_kind, s.label AS via_label, u.id AS uid, u.alias, u.pin, u.pm
           FROM contact_requests r JOIN users u ON u.id = r.from_id
           LEFT JOIN shadow_pins s ON s.pin = r.via_pin
           WHERE r.to_id = ? ORDER BY r.created_at DESC`,
        )
        .all(userId) as Row[]
    ).map((r) => ({
      id: r.id as string,
      from: { id: r.uid as string, alias: r.alias as string, pin: r.pin as string, pm: r.pm as string },
      note: r.note as string,
      createdAt: r.created_at as number,
      via: r.via_pin
        ? { pin: r.via_pin as string, kind: ((r.via_kind as string | null) ?? "shadow") as ShadowKind, label: (r.via_label as string | null) ?? "" }
        : null,
    }));
    // Pengundang hanya melihat PIN yang ia ketik — PIN utama target tidak pernah bocor lewat shadow/radar.
    const outgoing = (
      db
        .prepare(
          `SELECT r.id, r.created_at, COALESCE(r.via_pin, u.pin) AS pin FROM contact_requests r JOIN users u ON u.id = r.to_id
           WHERE r.from_id = ? ORDER BY r.created_at DESC`,
        )
        .all(userId) as Row[]
    ).map((r) => ({ id: r.id as string, pin: r.pin as string, createdAt: r.created_at as number }));
    return { contacts, incoming, outgoing };
  }

  /** Hubungkan a↔b. viaAB = PIN yang dipakai a untuk menjangkau b (ditampilkan ke a), dan sebaliknya. */
  function connect(a: string, b: string, viaAB: string | null = null, viaBA: string | null = null) {
    const now = Date.now();
    tx(db, () => {
      db.prepare("INSERT OR IGNORE INTO contacts (user_id, peer_id, since, via_pin) VALUES (?, ?, ?, ?), (?, ?, ?, ?)").run(a, b, now, viaAB, b, a, now, viaBA);
      db.prepare("DELETE FROM contact_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)").run(a, b, b, a);
    });
  }

  route("GET", "/api/contacts", authed(({ user }) => contactsFor(user.id)));

  route("POST", "/api/contacts/invite", authed(async ({ req, user }) => {
    const body = await readJson(req);
    const pin = normalizePin(str(body, "pin", { min: 1, max: 16 }));
    const note = cleanText(str(body, "note", { max: NOTE_MAX * 2, optional: true })).slice(0, NOTE_MAX);
    if (!isValidPin(pin)) throw new HttpError(400, "bad_pin", "Format PIN tidak valid");
    // Batas ketat pencarian PIN = pertahanan utama terhadap pemindaian massal.
    limit(`pin-lookup:${user.id}`, 30, HOUR, "Terlalu banyak pencarian PIN. Coba lagi dalam satu jam.");
    const found = resolvePin(pin);
    if (!found) throw new HttpError(404, "pin_not_found", "PIN tidak ditemukan atau sudah kedaluwarsa. Periksa lagi ketikannya.");
    const target = found.user;
    const viaPin = found.via?.pin ?? null;
    if (target.id === user.id) throw new HttpError(400, "self_invite", "Itu PIN kamu sendiri");
    const existingContact = db.prepare("SELECT via_pin FROM contacts WHERE user_id = ? AND peer_id = ?").get(user.id, target.id) as
      | { via_pin: string | null }
      | undefined;
    if (existingContact) {
      // Kontak yang datang lewat Shadow/radar PIN tidak boleh bisa "memastikan" tebakan PIN utama
      // dari beda jawaban 409 vs 404 (temuan audit Fase 3 #3): PIN lain milik orang itu = "tidak ditemukan".
      if (existingContact.via_pin && existingContact.via_pin !== pin) {
        throw new HttpError(404, "pin_not_found", "PIN tidak ditemukan atau sudah kedaluwarsa. Periksa lagi ketikannya.");
      }
      throw new HttpError(409, "already_contacts", "Kalian sudah terhubung");
    }

    // PIN sekali pakai hangus pada pemakaian pertama yang "berhasil" (termasuk jalur pura-pura blokir,
    // supaya PIN itu tidak bisa dipakai untuk menguji apakah seseorang memblokir kita).
    const burnOnce = () => {
      if (found.via?.kind === "once") db.prepare("DELETE FROM shadow_pins WHERE pin = ? AND kind = 'once'").run(found.via.pin);
    };

    // Diblokir? Pura-pura terkirim — pemblokir tidak boleh "ketahuan" memblokir.
    if (q.isBlocked.get(user.id, target.id, target.id, user.id)) {
      burnOnce();
      return { status: "pending" };
    }

    // Kalau dia sudah lebih dulu mengundang kita, langsung terhubung (dua-duanya mau).
    const reverse = db.prepare("SELECT via_pin FROM contact_requests WHERE from_id = ? AND to_id = ?").get(target.id, user.id) as
      | { via_pin: string | null }
      | undefined;
    if (reverse) {
      connect(user.id, target.id, viaPin, reverse.via_pin);
      burnOnce();
      emit(target.id, { t: "contacts_changed" });
      emit(user.id, { t: "contacts_changed" });
      return { status: "connected" };
    }

    const pending = db.prepare("SELECT COUNT(*) AS n FROM contact_requests WHERE from_id = ?").get(user.id) as { n: number };
    if (pending.n >= 20) throw new HttpError(429, "too_many_pending", "Masih ada 20 undangan menunggu. Batalkan sebagian dulu.");
    limit(`invite:${user.id}`, 15, HOUR, "Terlalu banyak undangan dalam satu jam.");

    const existing = db.prepare("SELECT 1 FROM contact_requests WHERE from_id = ? AND to_id = ?").get(user.id, target.id);
    if (!existing) {
      db.prepare("INSERT INTO contact_requests (id, from_id, to_id, note, created_at, via_pin, via_kind) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        randomUUID(),
        user.id,
        target.id,
        note,
        Date.now(),
        viaPin,
        found.via?.kind ?? null,
      );
      emit(target.id, { t: "contacts_changed" });
    }
    burnOnce();
    return { status: "pending" };
  }));

  route("POST", "/api/contacts/requests/:id/accept", authed(({ user, params }) => {
    const r = db.prepare("SELECT from_id, via_pin FROM contact_requests WHERE id = ? AND to_id = ?").get(params.id, user.id) as
      | { from_id: string; via_pin: string | null }
      | undefined;
    if (!r) throw new HttpError(404, "not_found", "Undangan tidak ditemukan");
    connect(r.from_id, user.id, r.via_pin, null);
    emit(r.from_id, { t: "contacts_changed" });
    return contactsFor(user.id);
  }));

  route("POST", "/api/contacts/requests/:id/decline", authed(({ user, params }) => {
    const r = db.prepare("SELECT from_id FROM contact_requests WHERE id = ? AND to_id = ?").get(params.id, user.id) as
      | { from_id: string }
      | undefined;
    if (!r) throw new HttpError(404, "not_found", "Undangan tidak ditemukan");
    db.prepare("DELETE FROM contact_requests WHERE id = ?").run(params.id);
    emit(r.from_id, { t: "contacts_changed" });
    return contactsFor(user.id);
  }));

  route("DELETE", "/api/contacts/requests/:id", authed(({ user, params }) => {
    const r = db.prepare("SELECT to_id FROM contact_requests WHERE id = ? AND from_id = ?").get(params.id, user.id) as
      | { to_id: string }
      | undefined;
    if (!r) throw new HttpError(404, "not_found", "Undangan tidak ditemukan");
    db.prepare("DELETE FROM contact_requests WHERE id = ?").run(params.id);
    emit(r.to_id, { t: "contacts_changed" });
    return contactsFor(user.id);
  }));

  route("DELETE", "/api/contacts/:id", authed(({ user, params }) => {
    const { changes } = db
      .prepare("DELETE FROM contacts WHERE (user_id = ? AND peer_id = ?) OR (user_id = ? AND peer_id = ?)")
      .run(user.id, params.id, params.id, user.id);
    // Beri tahu hanya bila benar-benar ada kontak yang terputus — bukan sembarang userId (temuan red-team #2).
    if (Number(changes) > 0) emit(params.id, { t: "contacts_changed" });
    return contactsFor(user.id);
  }));

  route("POST", "/api/blocks", authed(async ({ req, user }) => {
    const userId = str(await readJson(req), "userId", { min: 1, max: 64 });
    if (userId === user.id || !getUser(userId)) throw new HttpError(404, "not_found", "Pengguna tidak ditemukan");
    tx(db, () => {
      db.prepare("INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)").run(user.id, userId, Date.now());
      db.prepare("DELETE FROM contacts WHERE (user_id = ? AND peer_id = ?) OR (user_id = ? AND peer_id = ?)").run(user.id, userId, userId, user.id);
      db.prepare("DELETE FROM contact_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)").run(user.id, userId, userId, user.id);
    });
    emit(userId, { t: "contacts_changed" });
    return contactsFor(user.id);
  }));

  route("GET", "/api/blocks", authed(({ user }) => ({
    blocked: db
      .prepare("SELECT u.id, u.alias, b.created_at AS createdAt FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ? ORDER BY b.created_at DESC")
      .all(user.id),
  })));

  route("DELETE", "/api/blocks/:id", authed(({ user, params }) => {
    db.prepare("DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?").run(user.id, params.id);
    return { ok: true };
  }));

  // ---- pesan ----

  // Server BUKAN arsip: yang dikembalikan hanya pesan masuk yang belum diambil (masih berciphertext)
  // + status pesan yang kita kirim. Riwayat lengkap tinggal di perangkat (mesin lokal klien).
  // Penerima wajib mengirim `delivered` SETELAH menyimpan lokal — baru saat itu ciphertext dihapus.
  route("GET", "/api/messages/:peer", authed(({ user, params }) => {
    const peer = getUser(params.peer);
    if (!peer || !q.isContact.get(user.id, peer.id)) throw new HttpError(404, "not_found", "Percakapan tidak ditemukan");
    const pending = (
      db
        .prepare("SELECT * FROM messages WHERE sender_id = ? AND recipient_id = ? AND delivered_at IS NULL ORDER BY created_at ASC LIMIT 500")
        .all(peer.id, user.id) as Row[]
    ).map((r) => toMessage(r, user.read_receipts === 1));
    const statuses = (
      db
        .prepare("SELECT id, delivered_at, read_at, created_at FROM messages WHERE sender_id = ? AND recipient_id = ? ORDER BY created_at DESC LIMIT 500")
        .all(user.id, peer.id) as Row[]
    ).map((r) => ({ id: r.id as string, status: messageStatus(r, peer.read_receipts === 1), createdAt: r.created_at as number }));
    return { pending, statuses };
  }));

  // ---- Fase 2: etalase, kesepakatan rekber (simulasi), buku besar ----

  const commerce = registerCommerce({
    db,
    route,
    authed,
    readJson,
    str,
    cleanText,
    emit,
    limit,
    areContacts,
    getUser,
    contactIds: (id) => (q.contactIds.all(id) as { peer_id: string }[]).map((r) => r.peer_id),
    timers: {
      autoReleaseMs: 7 * 24 * HOUR,
      shipWindowMs: 3 * 24 * HOUR,
      heldRefundMs: 7 * 24 * HOUR,
      disputeTimeoutMs: 14 * 24 * HOUR,
      ...opts.dealTimers,
    },
    isModerator,
    moderatorIds: () => [...moderatorIdSet],
    notary,
    feePerMille,
    payments: opts.payments ?? simulatedProvider,
    readRaw,
    log,
  });

  // ---- Fase 3: Shadow PIN & radar ekonomi (opt-in) ----

  const discovery = registerDiscovery({ db, route, authed, readJson, str, cleanText, limit, uniquePin });

  /**
   * PIN dinamis: ganti PIN utama pengguna yang mengaktifkan rotasi otomatis. Kontak yang sudah
   * terhubung tidak terputus; undangan yang sudah masuk tetap ada (berbeda dengan ganti PIN manual
   * karena spam). Orang luar yang menyimpan PIN lama tidak bisa memakainya lagi.
   */
  function runPinRotation(now = Date.now()): number {
    const due = db
      .prepare("SELECT id FROM users WHERE pin_rotate_days > 0 AND pin_rotated_at + pin_rotate_days * 86400000 <= ?")
      .all(now) as { id: string }[];
    for (const { id } of due) {
      db.prepare("UPDATE users SET pin = ?, pin_rotated_at = ? WHERE id = ?").run(uniquePin(), now, id);
      emit(id, { t: "me_changed" });
      for (const row of q.contactIds.all(id) as { peer_id: string }[]) emit(row.peer_id, { t: "contacts_changed" });
    }
    return due.length;
  }
  const moments = registerMoments({ db, route, authed, readJson, limit, emit, getUser, areContacts });

  // ------------------------------------------------------- static files ---

  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
    ".json": "application/json",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
  };

  function serveStatic(ctx: Ctx): boolean {
    if (!opts.staticDir || (ctx.req.method !== "GET" && ctx.req.method !== "HEAD")) return false;
    const root = resolve(opts.staticDir);
    let path = decodeURIComponent(ctx.url.pathname);
    if (path.includes("\0")) return false;
    let file = normalize(join(root, path));
    if (!file.startsWith(root + sep) && file !== root) return false; // anti path-traversal
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (path.startsWith("/api/") || extname(path)) return false;
      file = join(root, "index.html"); // SPA fallback
      path = "/index.html";
      if (!existsSync(file)) return false;
    }
    const immutable = path.startsWith("/assets/");
    ctx.res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    ctx.res.end(ctx.req.method === "HEAD" ? undefined : readFileSync(file));
    return true;
  }

  // ------------------------------------------------------------- server ---

  function securityHeaders(res: ServerResponse) {
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "worker-src 'self'",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    res.setHeader("X-Frame-Options", "DENY");
    if (opts.secure) res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }

  function sendJson(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }

  const server = createServer(async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url ?? "/", "http://localhost");
    const ctx: Ctx = { req, res, url, ip: clientIp(req), params: {} };
    try {
      if (url.pathname.startsWith("/api/")) {
        const method = req.method ?? "GET";
        // Pengecualian SATU-SATUNYA: webhook gateway (server-ke-server, tanpa Origin & tanpa cookie);
        // keasliannya diverifikasi token gateway di handler-nya.
        const isWebhook = method === "POST" && url.pathname.startsWith("/api/payments/webhook/");
        if (method !== "GET" && method !== "HEAD" && !isWebhook && !originAllowed(req)) {
          throw new HttpError(403, "bad_origin", "Permintaan lintas-situs ditolak");
        }
        limit(`api:${ctx.ip}`, 300, 60 * 1000, "Terlalu banyak permintaan. Pelan-pelan dulu.");
        for (const r of routes) {
          if (r.method !== method) continue;
          const m = r.pattern.exec(url.pathname);
          if (!m) continue;
          r.keys.forEach((k, i) => (ctx.params[k] = decodeURIComponent(m[i + 1])));
          const out = await r.handler(ctx);
          return sendJson(res, 200, out);
        }
        throw new HttpError(404, "not_found", "Endpoint tidak ditemukan");
      }
      if (serveStatic(ctx)) return;
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Tidak ditemukan");
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.retryAfter) res.setHeader("Retry-After", String(err.retryAfter));
        return sendJson(res, err.status, { error: err.code, message: err.message });
      }
      log(`[error] ${req.method} ${url.pathname}: ${(err as Error).stack ?? err}`);
      // Jangan bocorkan detail internal ke klien.
      if (!res.headersSent) sendJson(res, 500, { error: "internal", message: "Terjadi kesalahan di server" });
    }
  });

  // ---------------------------------------------------------- WebSocket ---

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  wss.on("error", (err) => log(`[wss-error] ${err.message}`));
  // Socket mentah bisa error sebelum/saat upgrade (klien putus di tengah handshake).
  server.on("clientError", (err, socket) => {
    log(`[client-error] ${err.message}`);
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", (err) => log(`[upgrade-error] ${err.message}`));
    const url = new URL(req.url ?? "/", "http://localhost");
    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== "/ws") return reject(404, "Not Found");
    if (!originAllowed(req)) return reject(403, "Forbidden");
    const auth = authenticate(req);
    if (!auth) return reject(401, "Unauthorized");
    const ip = clientIp(req);
    if (!limiter.take(`ws-connect:${ip}`, 30, 60 * 1000)) return reject(429, "Too Many Requests");

    wss.handleUpgrade(req, socket, head, (ws: WebSocket & { tokenHash?: string; alive?: boolean }) => {
      const userId = auth.user.id;
      ws.tokenHash = auth.tokenHash;
      ws.alive = true;
      let set = sockets.get(userId);
      if (!set) sockets.set(userId, (set = new Set()));
      if (set.size >= 5) {
        ws.close(4029, "too_many_connections");
        return;
      }
      set.add(ws);
      // WAJIB: tanpa listener ini, error protokol (frame > maxPayload, UTF-8 rusak, opcode aneh)
      // menjadi "Unhandled 'error' event" dan mematikan SELURUH proses (temuan red-team #1).
      ws.on("error", (err) => {
        log(`[ws-error] ${userId}: ${err.message}`);
        ws.terminate();
      });
      ws.on("pong", () => (ws.alive = true));
      ws.on("close", () => {
        set!.delete(ws);
        if (set!.size === 0) sockets.delete(userId);
      });
      ws.on("message", (raw, isBinary) => {
        if (isBinary) return ws.close(1003, "binary_not_supported");
        // Sesi bisa dicabut kapan saja (logout di perangkat lain) — periksa ulang.
        if (!q.session.get(auth.tokenHash, Date.now())) return ws.close(4001, "session_expired");
        let ev: ClientEvent;
        try {
          ev = JSON.parse(raw.toString()) as ClientEvent;
        } catch {
          return ws.close(1007, "bad_json");
        }
        try {
          handleEvent(userId, ws, ev);
        } catch (err) {
          log(`[ws-error] ${(err as Error).stack ?? err}`);
        }
      });
      ws.send(JSON.stringify({ t: "hello", userId } satisfies ServerEvent));
    });
  });

  function reject(ws: WebSocket, id: string, code: string, message: string) {
    ws.send(JSON.stringify({ t: "rejected", id, code, message } satisfies ServerEvent));
  }

  const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

  function handleEvent(userId: string, ws: WebSocket, ev: ClientEvent) {
    if (ev?.t === "send") {
      const id = typeof ev.id === "string" ? ev.id : "";
      if (!UUID_RE.test(id)) return reject(ws, id, "bad_id", "ID pesan tidak valid");
      if (
        typeof ev.to !== "string" ||
        !isValidPublicKey(ev.fromKey) ||
        !isValidPublicKey(ev.toKey) ||
        typeof ev.nonce !== "string" ||
        ev.nonce.length !== Math.ceil(NONCE_BYTES / 3) * 4 ||
        !B64_RE.test(ev.nonce) ||
        typeof ev.ciphertext !== "string" ||
        ev.ciphertext.length === 0 ||
        ev.ciphertext.length > CIPHERTEXT_MAX_B64 ||
        !B64_RE.test(ev.ciphertext) ||
        typeof ev.ping !== "boolean"
      ) {
        return reject(ws, id, "bad_message", "Format pesan tidak valid");
      }
      if (!limiter.take(`msg:${userId}`, 30, 10 * 1000)) return reject(ws, id, "rate_limited", "Terlalu cepat mengirim pesan. Tunggu sebentar.");
      if (ev.ping && !limiter.take(`ping:${userId}:${ev.to}`, 1, PING_COOLDOWN_MS)) {
        return reject(ws, id, "ping_cooldown", "PING!!! hanya bisa dikirim 30 detik sekali");
      }

      // Cek kontak DULU: bukan-kontak selalu mendapat jawaban seragam, jadi tidak bisa
      // dipakai untuk menebak keberadaan ID pesan orang lain (temuan red-team #3).
      const me = getUser(userId);
      const peer = getUser(ev.to);
      if (!me || !peer || !areContacts(userId, peer.id)) return reject(ws, id, "not_contacts", "Kalian belum terhubung");

      // Pesan ulang (klien retry setelah koneksi putus) → kembalikan ack yang sama.
      const dup = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
      if (dup) {
        if (dup.sender_id !== userId || dup.recipient_id !== peer.id) return reject(ws, id, "bad_id", "ID pesan bentrok");
        const s = messageStatus(dup, peer.read_receipts === 1);
        return ws.send(JSON.stringify({ t: "ack", id, createdAt: dup.created_at as number, status: s } satisfies ServerEvent));
      }
      if (me.public_key !== ev.fromKey) return reject(ws, id, "stale_device_key", "Akun ini aktif di perangkat lain");
      if (peer.public_key !== ev.toKey) return reject(ws, id, "key_changed", "Kunci lawan bicara berubah — periksa safety number");

      const createdAt = Date.now();
      db.prepare(
        `INSERT INTO messages (id, sender_id, recipient_id, sender_key, recipient_key, nonce, ciphertext, ping, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, userId, peer.id, ev.fromKey, ev.toKey, ev.nonce, ev.ciphertext, ev.ping ? 1 : 0, createdAt);
      const stored = toMessage(db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row, peer.read_receipts === 1);
      ws.send(JSON.stringify({ t: "ack", id, createdAt, status: "S" } satisfies ServerEvent));
      emit(peer.id, { t: "message", message: stored });
      // Sinkronkan tab lain milik pengirim.
      const set = sockets.get(userId);
      if (set) for (const other of set) if (other !== ws && other.readyState === WebSocket.OPEN) other.send(JSON.stringify({ t: "message", message: stored }));
      return;
    }

    if (ev?.t === "delivered" && Array.isArray(ev.ids)) {
      return markDelivered(userId, ev.ids.filter((x): x is string => typeof x === "string"));
    }

    if (ev?.t === "read" && typeof ev.peer === "string" && Array.isArray(ev.ids)) {
      const me = getUser(userId);
      if (!me) return;
      const now = Date.now();
      const changed: string[] = [];
      const upd = db.prepare(
        "UPDATE messages SET read_at = ?, delivered_at = COALESCE(delivered_at, ?), nonce = '', ciphertext = '' WHERE id = ? AND recipient_id = ? AND sender_id = ? AND read_at IS NULL",
      );
      tx(db, () => {
        for (const id of ev.ids.slice(0, 200)) {
          if (typeof id === "string" && upd.run(now, now, id, userId, ev.peer).changes > 0) changed.push(id);
        }
      });
      // Tanda "R" hanya dikirim bila pembaca mengizinkan; kalau tidak, pengirim tetap melihat "D".
      if (changed.length) emit(ev.peer, { t: "status", ids: changed, status: me.read_receipts === 1 ? "R" : "D" });
      emit(userId, { t: "contacts_changed" });
    }
  }

  // ---------------------------------------------------------- perawatan ---

  const heartbeat = setInterval(() => {
    for (const set of sockets.values()) {
      for (const ws of set) {
        if (!ws.alive) {
          ws.terminate();
          continue;
        }
        ws.alive = false;
        ws.ping();
      }
    }
  }, 30_000);

  const janitor = setInterval(() => {
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
    // Relay, bukan arsip: ciphertext yang tak pernah diambil & metadata status dihapus setelah 30 hari.
    db.prepare("DELETE FROM messages WHERE created_at <= ?").run(Date.now() - MESSAGE_RETENTION_MS);
    discovery.sweep();
    moments.sweep();
    runPinRotation();
    limiter.sweep(24 * HOUR);
  }, 10 * 60 * 1000);
  const releaser = setInterval(() => {
    try {
      const { released, refunded } = commerce.runTimers();
      if (released || refunded) log(`[rekber] otomatis: ${released} dicairkan, ${refunded} dikembalikan ke pembeli`);
    } catch (err) {
      log(`[auto-release-error] ${(err as Error).stack ?? err}`);
    }
  }, 60 * 1000);
  heartbeat.unref();
  janitor.unref();
  releaser.unref();

  return {
    server,
    db,
    runTimers: commerce.runTimers,
    runPinRotation,
    notaryPublicKey: notary.publicKey,
    /** Ganti daftar moderator (ID akun) saat berjalan — dipakai tes; produksi memakai env saat start. */
    setModerators(ids: string[]) {
      moderatorIdSet.clear();
      for (const id of ids) if (UUID_RE.test(id)) moderatorIdSet.add(id);
    },
    audit: commerce.audit,
    async close() {
      clearInterval(heartbeat);
      clearInterval(janitor);
      clearInterval(releaser);
      for (const set of sockets.values()) for (const ws of set) ws.terminate();
      wss.close();
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections(); // jangan menunggu koneksi keep-alive yang menganggur
      await closed;
      db.close();
    },
  };
}
