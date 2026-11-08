// Penyedia pembayaran — Skema B dokumen konsep dalam bentuk AMAN:
//  - Kunci rahasia gateway HANYA di server (env), tidak pernah di ponsel/APK.
//  - Ponsel hanya menerima URL/QR bayar; konfirmasi lunas datang lewat WEBHOOK ke server (ponsel tidak
//    punya alamat publik), diverifikasi dengan token (timing-safe) dan diproses idempoten.
//  - Fee developer dipotong oleh gateway lewat split rule (xenPlatform), bukan oleh kode di ponsel.
//
// "simulasi" = default (tanpa uang sungguhan). "xendit" = kerangka siap pakai; aktif setelah akun,
// sub-akun penjual (KYC xenPlatform) & kepatuhan disetujui. Lihat docs/ARSITEKTUR.md §4.

import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export interface PaymentRequest {
  dealId: string;
  payRef: string; // kode bayar sekali pakai — jadi external_id di gateway (tanpa identitas)
  amount: number; // rupiah utuh
  /** Fee platform kesepakatan ini; 0 = escrow gratis → tidak ada split rule ke gateway. */
  fee: number;
  description: string;
  sellerAccount: string | null; // id sub-akun penjual di gateway
}

export type PaymentStart = { mode: "instant" } | { mode: "redirect"; url: string; providerRef: string };

export interface WebhookEvent {
  payRef: string;
  status: "PAID" | "EXPIRED";
  amount: number;
}

export interface PaymentProvider {
  readonly name: "simulasi" | "xendit" | "langsung";
  start(req: PaymentRequest): Promise<PaymentStart>;
  /** Verifikasi & urai webhook. null = tidak sah (abaikan, jangan bocorkan alasan). */
  parseWebhook(headers: IncomingHttpHeaders, rawBody: string): WebhookEvent | null;
}

/**
 * LANGSUNG (default produk): pembeli mentransfer sendiri ke rekening/dompet yang dibagikan penjual lewat
 * E2EE. KAMBE tidak memegang dana, tidak membuat invoice, dan tidak menerima webhook.
 */
export const directProvider: PaymentProvider = {
  name: "langsung",
  async start() {
    throw new Error("direct_mode");
  },
  parseWebhook() {
    return null;
  },
};

/** Simulasi: pembayaran dianggap lunas seketika. Tidak ada uang sungguhan yang berpindah. */
export const simulatedProvider: PaymentProvider = {
  name: "simulasi",
  async start() {
    return { mode: "instant" };
  },
  parseWebhook() {
    return null; // simulasi tidak menerima webhook
  },
};

export interface XenditOptions {
  secretKey: string; // kunci rahasia API (server-only)
  callbackToken: string; // "verification token" dari dasbor Xendit
  splitRuleId?: string; // split rule xenPlatform (fee developer)
  successUrl: string;
  invoiceDurationSec?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch; // untuk tes
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function xenditProvider(o: XenditOptions): PaymentProvider {
  const fetcher = o.fetchImpl ?? fetch;
  const base = o.baseUrl ?? "https://api.xendit.co";
  return {
    name: "xendit",
    async start(req) {
      if (!req.sellerAccount) throw new Error("seller_account_missing");
      const headers: Record<string, string> = {
        authorization: "Basic " + Buffer.from(`${o.secretKey}:`).toString("base64"),
        "content-type": "application/json",
        "for-user-id": req.sellerAccount, // dana masuk ke sub-akun penjual…
      };
      // …dengan fee developer dipotong otomatis. Escrow gratis (fee 0) = tanpa split rule sama sekali.
      if (o.splitRuleId && req.fee > 0) headers["with-split-rule"] = o.splitRuleId;
      const res = await fetcher(`${base}/v2/invoices`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          external_id: req.payRef,
          amount: req.amount,
          description: req.description.slice(0, 200),
          invoice_duration: o.invoiceDurationSec ?? 3600,
          currency: "IDR",
          success_redirect_url: o.successUrl,
        }),
      });
      if (!res.ok) throw new Error(`gateway_error_${res.status}`);
      const data = (await res.json()) as { id?: string; invoice_url?: string };
      if (!data.id || !data.invoice_url || !data.invoice_url.startsWith("https://")) throw new Error("gateway_bad_response");
      return { mode: "redirect", url: data.invoice_url, providerRef: data.id };
    },
    parseWebhook(headers, rawBody) {
      const token = headers["x-callback-token"];
      if (typeof token !== "string" || !safeEqual(token, o.callbackToken)) return null;
      let body: { external_id?: unknown; status?: unknown; amount?: unknown; paid_amount?: unknown };
      try {
        body = JSON.parse(rawBody);
      } catch {
        return null;
      }
      const amount = Number(body.paid_amount ?? body.amount);
      if (typeof body.external_id !== "string" || !Number.isSafeInteger(amount)) return null;
      if (body.status === "PAID" || body.status === "SETTLED") return { payRef: body.external_id, status: "PAID", amount };
      if (body.status === "EXPIRED") return { payRef: body.external_id, status: "EXPIRED", amount };
      return null;
    },
  };
}
