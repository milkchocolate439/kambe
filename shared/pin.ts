// PIN Kambe: 6 karakter dari 32 simbol yang tidak mudah tertukar
// (tanpa 0/O dan 1/I). 32^6 ≈ 1,07 miliar kombinasi.
//
// PIN BUKAN kata sandi — hanya kode untuk berbagi kontak. Karena ruangnya
// bisa dipindai, keamanannya bertumpu pada: undangan wajib disetujui,
// rate limit pencarian di server, dan PIN bisa diganti kapan saja.

export const PIN_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PIN_LENGTH = 6;

/** Acak kriptografis; 256 habis dibagi 32 sehingga `b & 31` tidak bias. */
export function generatePin(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(PIN_LENGTH));
  let pin = "";
  for (const b of bytes) pin += PIN_ALPHABET[b & 31];
  return pin;
}

/** Ramah pengguna: huruf kecil, spasi, dan strip tetap diterima. */
export function normalizePin(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

export function isValidPin(pin: string): boolean {
  return pin.length === PIN_LENGTH && [...pin].every((c) => PIN_ALPHABET.includes(c));
}

/** Pesan salah ketik yang membantu, bukan sekadar "tidak valid". */
export function pinProblem(pin: string): string | null {
  if (pin.length !== PIN_LENGTH) return `PIN terdiri dari ${PIN_LENGTH} karakter`;
  if (/[01IO]/.test(pin)) return "PIN tidak memakai angka 0/1 atau huruf O/I — periksa lagi";
  if (!isValidPin(pin)) return "PIN hanya berisi huruf dan angka";
  return null;
}
