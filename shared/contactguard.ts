// Penjaga kontak luar: mencegah pembagian nomor HP, nomor panjang (HP/rekening), email, tautan
// WhatsApp/Telegram/dll., dan "WA: …" di teks bebas KAMBE.
//
// Batas yang jujur: isi pesan terenkripsi end-to-end, jadi server TIDAK bisa memeriksanya. Penjaga ini
// berjalan di perangkat pengirim (blokir sebelum dienkripsi) dan di perangkat penerima (menyamarkan
// bila pengirim memakai aplikasi yang dimodifikasi). Server hanya menegakkannya pada teks publik
// (headline Radar Arwah). Penulisan yang sangat kreatif tetap bisa lolos — ini penghalang praktis.
//
// Rekening bank dibagikan lewat "Kirim info pembayaran" (kartu kesepakatan), bukan chat bebas.

export type LeakKind = "phone" | "longnumber" | "email" | "link" | "handle";

export interface Leak {
  kind: LeakKind;
  match: string;
}

export const LEAK_MESSAGE: Record<LeakKind, string> = {
  phone: "Nomor HP tidak boleh dibagikan di KAMBE. Ngobrol & bertransaksi tetap di sini supaya aman.",
  longnumber: "Nomor panjang (HP/rekening) tidak boleh di teks bebas. Untuk rekening, pakai tombol \"Kirim info pembayaran\" di kartu kesepakatan.",
  email: "Alamat email tidak boleh dibagikan di KAMBE.",
  link: "Tautan ke WhatsApp/Telegram/media sosial tidak boleh dibagikan di KAMBE.",
  handle: "Akun WhatsApp/Telegram/media sosial tidak boleh dibagikan di KAMBE.",
};

const DIGIT_WORDS = "nol|kosong|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|zero|one|two|three|four|five|six|seven|eight|nine";
const WORD_RUN = new RegExp(`\\b(?:(?:${DIGIT_WORDS})[\\s,.\\-]*){8,}`, "i");
const LINK_RE = /\b(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|whatsapp\.com\/|t\.me|telegram\.(?:me|dog)|line\.me|ig\.me|m\.me|instagram\.com\/|facebook\.com\/|fb\.com\/|tiktok\.com\/@|signal\.me|discord\.gg|x\.com\/|twitter\.com\/)\S*/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+\s*(?:@|\(at\)|\[at\])\s*[A-Za-z0-9-]+(?:\s*(?:\.|\(dot\)|\[dot\])\s*[A-Za-z0-9-]+)*\s*(?:\.|\(dot\)|\[dot\])\s*[A-Za-z]{2,}/i;
// Nama platform diikuti akun. Dianggap akun hanya bila ada penanda tegas (":" "=" "@") ATAU tokennya
// berbentuk akun (memuat angka, "_" atau "."), supaya kalimat biasa ("line produksi") tidak tertangkap.
const HANDLE_RE = /\b(?:wa|whatsapp|whatsap|watsap|wasap|telegram|tele|tg|line|ig|insta|instagram|signal|fb|facebook|tiktok)\b(?:\s*(?:ku|aku|saya|gw|gue|di))?\s*(?:[:=]\s*@?[A-Za-z0-9_.]{3,}|@[A-Za-z0-9_.]{3,}|(?=[A-Za-z]*[0-9_.])[A-Za-z0-9_.]{4,})/i;
// Rangkaian angka (boleh diselingi spasi, titik, strip, kurung, garis miring), minimal 9 digit.
const DIGIT_RUN = /\+?\d(?:[\s.\-()/]*\d){8,}/g;

function isPrice(text: string, start: number, run: string): boolean {
  const before = text.slice(Math.max(0, start - 4), start).toLowerCase();
  const after = text.slice(start + run.length, start + run.length + 6).toLowerCase();
  if (/(rp|idr)\s*\.?\s*$/.test(before)) return true;
  if (/^\s*(rb|ribu|jt|juta|k\b|rupiah)/.test(after)) return true;
  return /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(run.trim()); // 1.250.000 = format ribuan rupiah
}

/** Temukan kebocoran kontak pertama di teks, atau null bila aman. */
export function findContactLeak(text: string): Leak | null {
  if (!text) return null;
  const link = text.match(LINK_RE);
  if (link) return { kind: "link", match: link[0] };
  const email = text.match(EMAIL_RE);
  if (email && /@|\(at\)|\[at\]/i.test(email[0])) return { kind: "email", match: email[0] };
  for (const m of text.matchAll(DIGIT_RUN)) {
    const run = m[0];
    if (isPrice(text, m.index ?? 0, run)) continue;
    const digits = run.replace(/\D/g, "");
    // Nomor seluler Indonesia: 08…, 628…, +628…, atau 8… (tanpa awalan), total 9–14 digit.
    if (/^(?:0|62)?8[1-9]\d{6,11}$/.test(digits)) return { kind: "phone", match: run };
    if (digits.length >= 10) return { kind: "longnumber", match: run };
  }
  const words = text.match(WORD_RUN);
  if (words) return { kind: "phone", match: words[0] };
  const handle = text.match(HANDLE_RE);
  if (handle) return { kind: "handle", match: handle[0] };
  return null;
}

/** Samarkan semua kebocoran kontak (untuk teks yang DITERIMA dari pengirim yang melewati penjaga). */
export function maskContacts(text: string): { text: string; masked: boolean } {
  let out = text;
  let masked = false;
  for (let i = 0; i < 20; i++) {
    const leak = findContactLeak(out);
    if (!leak) break;
    out = out.replace(leak.match, "[kontak disembunyikan]");
    masked = true;
  }
  return { text: out, masked };
}

/** Nomor rekening: 6–20 digit; menolak yang jelas berbentuk nomor HP Indonesia (08…/628…). */
export function bankNumberProblem(raw: string): string | null {
  const digits = raw.replace(/[\s.-]/g, "");
  if (!/^\d{6,20}$/.test(digits)) return "Nomor rekening harus 6–20 angka";
  if (/^(?:08|628)[1-9]\d{7,10}$/.test(digits)) return "Itu terlihat seperti nomor HP, bukan nomor rekening";
  return null;
}
