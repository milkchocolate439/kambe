import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createApp } from "../server/app.ts";
import type { DealTimers } from "../server/commerce.ts";
import type { ServerEvent } from "../shared/protocol.ts";

export const TEST_PASSPHRASE = "kunci-uji-yang-panjang-sekali";

export async function startApp(opts: { dealTimers?: Partial<DealTimers> } = {}) {
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

  async signup(alias: string, passphrase = TEST_PASSPHRASE) {
    const r = await this.post("/api/auth/signup", { alias, passphrase });
    if (r.status !== 200) throw new Error(`signup ${alias} gagal: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as { me: { id: string; pin: string; alias: string }; recoveryCode: string };
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
