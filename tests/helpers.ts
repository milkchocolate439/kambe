import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createApp } from "../server/app.ts";
import type { DealTimers } from "../server/commerce.ts";
import type { PaymentProvider } from "../server/payments.ts";
import type { ServerEvent } from "../shared/protocol.ts";
import { generateIdentity, type Identity } from "../shared/e2ee.ts";
import { openSealed, seal, type Recipient, type SealedBlob, type SealedKind, type SealedView } from "../shared/sealed.ts";

// ------------------------------------------------ pembantu dagang terenkripsi ---

/** Pajang produk: nama/deskripsi/sektor disegel untuk semua kontak penjual. */
export async function addProduct(seller: Client, p: { title: string; price: number; sector?: string; description?: string }) {
  const content = { title: p.title, description: p.description ?? "", sector: p.sector ?? "Lainnya" };
  return seller.post("/api/products", { price: p.price, sealed: await seller.seal("product", content, await seller.contactParties()) });
}

/** Pembeli membuat kesepakatan dari produk; judul disegel untuk penjual & moderator. */
export async function createDeal(buyer: Client, productId: string, idempotencyKey: string, seller: Recipient, title = "Barang") {
  const sealed = await buyer.seal("deal", { title }, [seller, ...(await buyer.modParties())]);
  return buyer.post("/api/deals", { productId, idempotencyKey, sealed });
}

/** Penjual menawarkan kesepakatan kustom. */
export async function offerDeal(seller: Client, buyer: Recipient, title: string, price: number, idempotencyKey: string) {
  const sealed = await seller.seal("deal", { title }, [buyer, ...(await seller.modParties())]);
  return seller.post("/api/deals/offer", { buyerId: buyer.id, title: undefined, price, idempotencyKey, sealed });
}

export const DEFAULT_SHIPMENT = { courier: "JNE", tracking: "JNE1234567890", note: "" };

/** Aksi "kirim" dengan bukti kirim terenkripsi untuk pembeli, penjual & moderator. */
export async function shipDeal(seller: Client, dealId: string, shipment: unknown = DEFAULT_SHIPMENT) {
  return seller.post(`/api/deals/${dealId}/ship`, { sealed: await seller.seal("shipment", shipment, await seller.dealParties(dealId)) });
}

export const DEFAULT_DISPUTE = { reason: "not_received", text: "Paket belum sampai padahal status resi sudah terkirim." };

export async function disputeDeal(buyer: Client, dealId: string, content: unknown = DEFAULT_DISPUTE) {
  return buyer.post(`/api/deals/${dealId}/dispute`, { sealed: await buyer.seal("statement", content, await buyer.dealParties(dealId)) });
}

export async function addStatement(who: Client, dealId: string, text: string) {
  return who.post(`/api/deals/${dealId}/statements`, { sealed: await who.seal("statement", { text }, await who.dealParties(dealId)) });
}

export async function resolveDispute(mod: Client, dealId: string, decision: string, reason: string) {
  return mod.post(`/api/mod/disputes/${dealId}/resolve`, { decision, sealed: await mod.seal("resolution", { reason }, await mod.dealParties(dealId)) });
}

export const TEST_PASSPHRASE = "kunci-uji-yang-panjang-sekali";

export async function startApp(opts: { dealTimers?: Partial<DealTimers>; feePerMille?: number; payments?: PaymentProvider; freePlatform?: boolean } = {}) {
  const app = createApp({ dbPath: ":memory:", ...opts });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return { app, base, port };
}

export interface HttpResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** Klien HTTP kecil dengan cookie jar + Origin yang benar (seperti browser). */
export class Client {
  cookie = "";
  origin: string | null;
  readonly base: string;

  constructor(base: string) {
    this.base = base;
    this.origin = base;
  }

  async req<T = any>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<HttpResult<T>> {
    const headers: Record<string, string> = { ...extra };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.origin) headers.origin = this.origin;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get("set-cookie");
    if (set) {
      const [pair] = set.split(";");
      this.cookie = pair.endsWith("=") ? "" : pair;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }

  get = <T = any>(p: string) => this.req<T>("GET", p);
  post = <T = any>(p: string, b: unknown = {}) => this.req<T>("POST", p, b);
  put = <T = any>(p: string, b: unknown = {}) => this.req<T>("PUT", p, b);
  patch = <T = any>(p: string, b: unknown = {}) => this.req<T>("PATCH", p, b);
  del = <T = any>(p: string) => this.req<T>("DELETE", p);

  /** Kunci perangkat (seperti aplikasi asli: dibuat & didaftarkan saat pertama masuk). */
  key!: Identity;
  id!: string;

  async signup(alias: string, passphrase = TEST_PASSPHRASE) {
    const r = await this.post("/api/auth/signup", { alias, passphrase });
    if (r.status !== 200) throw new Error(`signup ${alias} gagal: ${r.status} ${JSON.stringify(r.body)}`);
    this.id = r.body.me.id;
    await this.useKey(await generateIdentity());
    return r.body as { me: { id: string; pin: string; alias: string }; recoveryCode: string };
  }

  /** Ganti kunci perangkat (mis. simulasi ganti HP). */
  async useKey(key: Identity) {
    this.key = key;
    const r = await this.put("/api/me/key", { publicKey: key.publicKey });
    if (r.status !== 200) throw new Error(`gagal mendaftarkan kunci: ${r.status} ${JSON.stringify(r.body)}`);
  }

  get party(): Recipient {
    return { id: this.id, publicKey: this.key.publicKey };
  }

  /** Segel isi sebagai pengguna ini (persis seperti klien). */
  seal(kind: SealedKind, content: unknown, recipients: Recipient[] = []): Promise<SealedBlob> {
    return seal(this.key.privateKey, this.party, kind, content, recipients);
  }

  /** Buka isi terenkripsi dengan kunci perangkat pengguna ini. */
  open<T = unknown>(view: SealedView | null | undefined): Promise<T> {
    if (!view) throw new Error("tidak ada objek terenkripsi");
    return openSealed<T>(this.key.privateKey, this.key.publicKey, view);
  }

  async contactParties(): Promise<Recipient[]> {
    const cs = (await this.get("/api/contacts")).body.contacts as { id: string; publicKey: string | null }[];
    return cs.filter((c) => c.publicKey).map((c) => ({ id: c.id, publicKey: c.publicKey! }));
  }

  async modParties(): Promise<Recipient[]> {
    return (await this.get("/api/mod/keys")).body.moderators as Recipient[];
  }

  /** Pembeli, penjual & moderator kesepakatan (penerima sah untuk isi terkait kesepakatan). */
  async dealParties(dealId: string): Promise<Recipient[]> {
    const k = (await this.get(`/api/deals/${dealId}/keys`)).body as { buyer: Recipient | null; seller: Recipient | null; moderators: Recipient[] };
    return [k.buyer, k.seller, ...k.moderators].filter((x): x is Recipient => !!x);
  }

  async socket(): Promise<Socket> {
    const ws = new WebSocket(this.base.replace("http", "ws") + "/ws", {
      headers: { cookie: this.cookie, ...(this.origin ? { origin: this.origin } : {}) },
    });
    const s = new Socket(ws);
    await s.next("hello");
    return s;
  }
}

/** Pembungkus WebSocket yang mengantrekan event agar mudah di-await di tes. */
export class Socket {
  readonly ws: WebSocket;
  private queue: ServerEvent[] = [];
  private waiters: { t: string; resolve: (e: ServerEvent) => void }[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => {
      const ev = JSON.parse(raw.toString()) as ServerEvent;
      const i = this.waiters.findIndex((w) => w.t === ev.t);
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(ev);
      else this.queue.push(ev);
    });
  }

  next<T extends ServerEvent["t"]>(t: T, timeoutMs = 3000): Promise<Extract<ServerEvent, { t: T }>> {
    const i = this.queue.findIndex((e) => e.t === t);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0] as Extract<ServerEvent, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout menunggu event ${t}`)), timeoutMs);
      this.waiters.push({
        t,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e as Extract<ServerEvent, { t: T }>);
        },
      });
    });
  }

  send(ev: unknown) {
    this.ws.send(JSON.stringify(ev));
  }

  close() {
    this.ws.close();
  }
}

/** Buka koneksi WS dan kembalikan kode penolakan HTTP-nya (untuk tes negatif). */
export function wsRejection(base: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(base.replace("http", "ws") + "/ws", { headers });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("error", () => {});
  });
}
