import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export type Row = Record<string, unknown>;

export interface UserRow {
  id: string;
  alias: string;
  pin: string;
  pass_hash: string;
  recovery_hash: string;
  public_key: string | null;
  pm: string;
  read_receipts: number;
  pro_until: number;
  created_at: number;
  pin_rotate_days: number;
  pin_rotated_at: number;
  gateway_account: string | null;
  pm_object: string | null;
  /** Kunci publik Ed25519 untuk tanda tangan Buku Jejak Transaksi (null = belum didaftarkan). */
  sign_key: string | null;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  ip: string;
  params: Record<string, string>;
}

export interface AuthCtx extends Ctx {
  user: UserRow;
  tokenHash: string;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
export type AuthHandler = (ctx: AuthCtx) => Promise<unknown> | unknown;
