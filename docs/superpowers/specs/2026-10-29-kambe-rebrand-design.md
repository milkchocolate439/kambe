# KAMBE — Rebrand PINPath (Desain)

Tanggal: 29 Okt 2026 · Branch: `kambe-rebrand` (dari `sec/hardening` 050805b)

## Tujuan

Mengganti identitas PINPath menjadi **KAMBE** (bahasa Dayak Ngaju: hantu/roh). Fitur dan fungsi tetap sama.
Sambil merebrand, audit UI dan perbaiki temuan (kontras, target sentuh, tata letak HP). **Tidak ada fitur baru.**

Ukuran berhasil:
1. Semua teks yang terlihat pengguna memakai nama KAMBE dan nama fitur bertema.
2. Identitas, nomor keamanan, cadangan, dan data tersegel yang dibuat sebelum rebrand tetap terbaca (dibuktikan dengan tes).
3. Semua tes lama lulus: 104 unit dan 4 suite browser. Tes kompatibilitas baru juga lulus.
4. Kontras teks ≥ 4.5:1, target sentuh ≥ 44px, dan tidak ada gulir horizontal di lebar 360/390px.

## Brand

- **Nama:** KAMBE. **Tagline:** "Hadir tanpa jejak."
- **Filosofi** (teks layar masuk/Pengaturan): seperti kambe, kamu hadir tanpa nomor HP atau email. Pesan hanya
  singgah sebentar di server lalu hilang. Hanya yang kamu izinkan yang bisa melihatmu.
- **Logo:** siluet hantu di dalam lingkaran dengan garis ukir Dayak (aso/sulur). Warnanya putih kabut dengan aksen merah api.
  Logo berupa SVG murni (`client/public/icon.svg`, plus komponen inline). Wordmark "KAMBE" juga SVG/teks sistem.
- **Huruf:** tetap memakai font sistem, karena CSP `font-src 'self'` melarang Google Fonts dan kita tidak menambah berkas font.

## Palet (token semantik yang sudah ada, nilainya diganti)

| Token | Nilai | Catatan |
|---|---|---|
| `--bg` | `#0E0B0A` | hitam malam hangat |
| `--bg-2` | `#13100E` | |
| `--panel` | `#1A1614` | |
| `--panel-2` | `#241E1B` | |
| `--line` / `--line-2` | `#2E2723` / `#3B332E` | |
| `--text` | `#EEE9E2` | 13.6:1 |
| `--text-2` | `#C8C0B5` | 9.1:1 |
| `--muted` | `#9A9087` | 5.26:1 |
| `--brand` | `#E4572E` | isian tombol; teksnya `--brand-ink` |
| `--brand-ink` | `#1A0703` | 5.30:1 di atas brand (teks putih hanya 3.68, jadi tidak dipakai) |
| `--brand-2` | `#F07A50` | teks/tautan aksen ≥ 5.96:1 |
| `--brand-glow` | `rgb(228 87 46 / .35)` | |
| `--amber` / `--warn` | `#F2B33D` | ≥ 8.8:1 |
| `--arwah` (baru) | `#A9D6DA` | nomor keamanan/terverifikasi ≥ 10.4:1 |
| `--ok` | `#5FD18A` | |
| `--danger` / `--rose` | `#FF7B72` | |
| `--bubble-me` / `--bubble-me-ink` | `var(--brand)` / `var(--brand-ink)` | |

Motif Dayak yang halus (pola SVG dengan opasitas rendah) dipakai di layar masuk dan header.
Motif ini dimatikan saat `prefers-reduced-motion` atau saat mode hemat data aktif.

## Peta nama (hanya teks yang terlihat pengguna)

| Lama | Baru |
|---|---|
| PINPath | KAMBE |
| Path Moments / Moments | Jejak |
| Shadow PIN | PIN Bayang |
| Radar | Radar Arwah |
| PIN (identitas, di judul & undangan) | PIN Kambe |
| PING!!! | tetap |
| Berkas cadangan `.pinpath` | `.kambe` (pemulihan tetap menerima `.pinpath`) |

Yang **tidak** diganti: nama variabel/fungsi kode, rute API, skema DB, nama komponen.

## Identitas protokol yang DIBEKUKAN

Nilai-nilai berikut masuk ke HKDF, AAD AES-GCM, tanda tangan, atau nama penyimpanan. Kalau diubah, kunci
turunan berubah, nomor keamanan berubah, dan cadangan/data lama rusak. Semuanya tetap seperti sekarang dan
diberi komentar `// label protokol, jangan diganti (lihat spec KAMBE)`:

- `PROTOCOL = "pinpath/v1"` (shared/e2ee.ts)
- `BACKUP_FORMAT = "pinpath-backup"` (shared/vault.ts)
- `RECEIPT_KIND = "pinpath.deal-receipt"` (shared/receipt.ts)
- `hashSecret("pinpath-dummy-secret")` (server/security.ts), dipakai untuk menyamakan waktu respons
- IndexedDB `DB_NAME = "pinpath"` (client/src/lib/keystore.ts)
- kunci lama localStorage `pinpath:identity:*` (client/src/lib/device.ts)
- cache SW `pinpath-shell-v1`: boleh diganti ke `kambe-shell-v1` karena ini cache tampilan, bukan data.
  Service worker harus menghapus cache lama saat `activate`.

## Variabel lingkungan

Nama baru: `KAMBE_*` (DB, SECURE, TRUST_PROXY, ORIGINS, FEE_PER_MILLE, NOTARY_KEY, NOTARY_KEY_FILE,
PAYMENT_PROVIDER, PUBLIC_URL, MODERATORS). Satu helper `env(nama)` membaca `KAMBE_<nama>`, lalu jatuh
ke `PINPATH_<nama>` bila yang baru tidak ada. `VITE_NOTARY_PUBLIC_KEY` tetap. README ditulis dengan nama
baru dan mencatat bahwa nama lama masih diterima. Deskripsi pembayaran: `KAMBE ${pay_ref}`.
Nama paket di package.json: `kambe`.

## Eksekusi (agen paralel)

1. **Kunci kontrak** (saya): token CSS di atas + peta nama di dokumen ini. Kontrak ini satu-satunya acuan agen.
2. **Tiga agen paralel** dengan berkas yang tidak saling tumpang tindih:
   - **A, visual:** `client/src/styles.css`, `client/public/icon.svg`, `manifest.webmanifest`, `client/index.html`,
     komponen logo baru `client/src/ui/Logo.tsx`, `sw.js`.
   - **B, teks UI:** `client/src/ui/*.tsx` (kecuali Logo.tsx), `client/src/App.tsx`, `main.tsx`,
     dan nama berkas unduhan cadangan di klien.
   - **C, server & dokumen:** `server/*`, `shared/*` (komentar beku + format cadangan), `scripts/*`,
     `README.md`, `docs/ARSITEKTUR.md`, `package.json`, serta tes yang memeriksa teks.
3. **Integrasi** (saya): gabungkan, selesaikan benturan, jalankan semua tes.
4. **Tes kompatibilitas baru** (C, ditulis TDD): identitas dari frasa pemulihan lama menghasilkan kunci publik
   dan nomor keamanan yang sama persis dengan vektor yang direkam sebelum rebrand. Cadangan berformat
   `pinpath-backup` tetap bisa dipulihkan. Env `PINPATH_*` tetap terbaca bila `KAMBE_*` kosong.
5. **Audit UI** (saya): kontras token, target 44px, 360/390px lewat suite browser + tangkapan layar. Perbaiki temuannya.
6. **Satu reviewer baru** memeriksa seluruh branch. Temuan Critical/Important diperbaiki dengan TDD.

## Di luar cakupan

Fitur baru, rename folder `~/projects/pinpath`, merge ke branch lain, dan perubahan protokol kripto.
Semuanya menunggu izin pengguna.
