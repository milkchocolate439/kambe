import { test } from "node:test";
import assert from "node:assert/strict";
import { bankNumberProblem, findContactLeak, maskContacts } from "../shared/contactguard.ts";

test("penjaga kontak: nomor HP Indonesia dalam berbagai tulisan diblokir", () => {
  for (const t of [
    "hubungi 081234567890 ya",
    "wa aku 0812-3456-7890",
    "+62 812 3456 7890",
    "6281234567890",
    "0812.3456.789",
    "(0812) 3456 7890",
    "nol delapan satu dua tiga empat lima enam tujuh delapan",
  ]) {
    const l = findContactLeak(t);
    assert.ok(l && (l.kind === "phone" || l.kind === "longnumber" || l.kind === "handle"), t);
  }
});

test("penjaga kontak: email, tautan WA/Telegram/IG, dan akun media sosial diblokir", () => {
  assert.equal(findContactLeak("email: budi.santoso@gmail.com")?.kind, "email");
  assert.equal(findContactLeak("budi (at) gmail (dot) com")?.kind, "email");
  assert.equal(findContactLeak("klik wa.me/6281234567890")?.kind, "link");
  assert.equal(findContactLeak("gabung t.me/kopigayo")?.kind, "link");
  assert.equal(findContactLeak("lihat instagram.com/kopigayo")?.kind, "link");
  assert.equal(findContactLeak("ig: kopigayo_roaster")?.kind, "handle");
  assert.equal(findContactLeak("telegram @kopigayo")?.kind, "handle");
});

test("penjaga kontak: nomor panjang (rekening) di teks bebas diblokir", () => {
  assert.equal(findContactLeak("transfer ke 1234567890 BCA")?.kind, "longnumber");
  assert.equal(findContactLeak("rek 123 456 789 012")?.kind, "longnumber");
});

test("penjaga kontak: percakapan dagang biasa TIDAK diblokir", () => {
  for (const t of [
    "Harganya Rp 1.250.000 sudah termasuk ongkir",
    "harga 125.000.000 nego",
    "Rp125000000 untuk 1 ton",
    "stok ada 20 kg, kirim besok jam 10",
    "ukuran 30x40 cm, berat 1200 gram",
    "pesanan #12345 sudah siap",
    "online terus kok, line produksi lancar",
    "harga 2 juta, 1500000 kalau ambil 3",
    "Halo, kopinya masih ada?",
  ]) {
    assert.equal(findContactLeak(t), null, t);
  }
});

test("maskContacts: kebocoran disamarkan, teks lain utuh", () => {
  const r = maskContacts("Halo, WA 081234567890 atau email a@b.co ya. Harga Rp 50.000");
  assert.equal(r.masked, true);
  assert.ok(!r.text.includes("0812") && !r.text.includes("a@b.co"));
  assert.ok(r.text.includes("Halo") && r.text.includes("Rp 50.000"));
  assert.deepEqual(maskContacts("aman saja"), { text: "aman saja", masked: false });
});

test("nomor rekening: angka 6–20 digit; bentuk nomor HP ditolak", () => {
  assert.equal(bankNumberProblem("1234567890"), null);
  assert.equal(bankNumberProblem("123-456-7890"), null);
  assert.ok(bankNumberProblem("12345"));
  assert.ok(bankNumberProblem("12345abc90"));
  assert.ok(bankNumberProblem("081234567890"));
  assert.ok(bankNumberProblem("6281234567890"));
});
