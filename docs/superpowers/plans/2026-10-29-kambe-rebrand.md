# KAMBE Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mengganti identitas PINPath menjadi KAMBE (tema hantu Dayak) tanpa mengubah fitur maupun protokol kripto. Sekaligus mengaudit dan memperbaiki UI.

**Architecture:**
- Task 1 dikerjakan berurutan sebelum yang lain. Task ini memasang "jangkar" kompatibilitas: vektor emas dari kode sebelum rebrand dan komentar beku. Agen tidak mungkin merusak protokol tanpa membuat tes merah.
- Task 2–4 dikerjakan paralel oleh tiga agen di worktree terpisah (cabang dari commit Task 1), dengan kepemilikan berkas yang tidak tumpang tindih.
- Task 5 menggabungkan hasilnya, Task 6 mengaudit UI, dan Task 7 adalah review akhir.

**Tech Stack:** pnpm, React 19 + Vite, Node 24 + tsx, `node:test`, Chromium lewat playwright-core (`tests/browser/*`).

**Spec:** `docs/superpowers/specs/2026-10-29-kambe-rebrand-design.md`

## Global Constraints

- Nilai berikut TIDAK BOLEH berubah:
  - `PROTOCOL = "pinpath/v1"`
  - `BACKUP_FORMAT = "pinpath-backup"`
  - `RECEIPT_KIND = "pinpath.deal-receipt"`
  - `hashSecret("pinpath-dummy-secret")`
  - IndexedDB `DB_NAME = "pinpath"`
  - kunci `pinpath:identity:*`
- Masing-masing diberi komentar `// label protokol, jangan diganti (lihat spec KAMBE)`.
- Hanya teks yang terlihat pengguna yang diganti. Nama variabel/fungsi, rute API, skema DB, dan nama komponen tetap.
- Peta nama:

  | Lama | Baru |
  |---|---|
  | PINPath | KAMBE |
  | Path Moments / Moments | Jejak |
  | Shadow PIN | PIN Bayang |
  | Radar | Radar Arwah |
  | PIN identitas (judul/undangan) | PIN Kambe |

  `PING!!!` tetap.
- Tagline: `Hadir tanpa jejak.`
- Cadangan baru berakhiran `.kambe`. Input pemulihan menerima `.kambe,.pinpath,application/json`.
- Env: `KAMBE_<NAMA>` lebih diutamakan, lalu jatuh ke `PINPATH_<NAMA>`. `VITE_NOTARY_PUBLIC_KEY` tetap.
- Palet: nilai persis dari tabel "Palet" di spec. Token baru `--arwah: #A9D6DA`.
- CSP tidak boleh dilonggarkan dan tidak boleh ada font atau aset dari luar. Tidak ada dependensi baru.
- Kontras teks ≥ 4.5:1. Target sentuh ≥ 44px. Tidak ada gulir horizontal di lebar 360px.
- Tidak ada fitur baru.

## Review Focus

1. Pengguna lama memulihkan berkas `pinpath-cadangan-*.pinpath`. Pemulihan harus berhasil, karena input file menerima `.pinpath` dan format `pinpath-backup` tidak diubah. Dipatok di Task 1 (dekripsi fixture) dan Task 3 (atribut `accept`).
2. Server yang dijalankan dengan env lama (`PINPATH_DB=...`) tetap memakai DB yang sama. Dipatok di Task 4 (`readEnv` fallback).
3. Kedua env ada sekaligus (`KAMBE_DB` dan `PINPATH_DB`). Yang baru menang. Dipatok di Task 4.
4. Perangkat yang sudah terpasang PWA memakai cache `pinpath-shell-v1`. Cache lama harus dihapus saat `activate` dan tidak ada aset basi. Ini sudah dijamin kode `sw.js:13`. Task 2 hanya mengganti nama cache dan tidak boleh menghapus baris itu.
5. Teks bubble pesan sendiri di atas `--brand` harus berwarna `--brand-ink`, bukan putih (3.68:1 gagal). Dipatok di Task 6 (audit kontras).

---

### Task 1: Jangkar kompatibilitas (dikerjakan sendiri, sebelum agen)

**Files:**
- Create: `tests/fixtures/make-pre-kambe.ts`, untuk membuat fixture sekali dari kode sebelum rebrand
- Create: `tests/fixtures/pre-kambe.json`
- Create: `tests/kambe-compat.test.ts`
- Modify: komentar beku di `shared/e2ee.ts:21`, `shared/vault.ts:205`, `shared/receipt.ts:11`, `server/security.ts:37`, `client/src/lib/keystore.ts:15`, `client/src/lib/device.ts:16`

**Interfaces:**
- Produces: fixture `{ seedA, seedB, userId, publicKeyA, publicKeyB, safetyNumberAB, backupKeyBind?, backup, backupData }` (seed sebagai base64), dan tes `kambe-compat`.

- [ ] **Step 1:** Tulis `make-pre-kambe.ts`:
  - dua seed tetap (`Uint8Array(32).fill(7)` dan `.fill(9)`), lalu `identityFromSeed` untuk keduanya;
  - `safetyNumber(A, B)`;
  - `localKeysFromSeed(seedA, userId)`, lalu `encryptBackup(key, userId, {hello:"kambe"}, 1730000000000)`;
  - tulis hasilnya ke `pre-kambe.json`.

  Jalankan sekali: `node --import tsx tests/fixtures/make-pre-kambe.ts`. Expected: berkas JSON terbentuk.
- [ ] **Step 2:** Tulis `tests/kambe-compat.test.ts`:
  - `identitas dari seed lama tetap sama`: publicKey A dan B sama persis dengan fixture;
  - `nomor keamanan lama tetap sama`: `safetyNumber` sama persis dengan fixture;
  - `cadangan pinpath-backup lama tetap terbuka`: `decryptBackup` pada fixture menghasilkan `{hello:"kambe"}` dan `createdAt === 1730000000000`;
  - `label protokol beku`: `PROTOCOL === "pinpath/v1"` dan `BACKUP_FORMAT === "pinpath-backup"`.
- [ ] **Step 3:** Bukti RED. Ubah sementara `PROTOCOL` menjadi `"kambe/v1"`, lalu jalankan `node --import tsx --test tests/kambe-compat.test.ts`. Expected: FAIL pada tes identitas, nomor keamanan, dan label. Kembalikan nilainya.
- [ ] **Step 4:** Tambahkan komentar beku di 6 lokasi. Jalankan `pnpm test`. Expected: semua lulus (104 + 4 = 108).
- [ ] **Step 5:** Commit `test: jangkar kompatibilitas pra-KAMBE + komentar label protokol beku`.

### Task 2: Agen A, visual

**Files (hanya ini):**
- `client/src/styles.css`, `client/public/icon.svg`, `client/public/manifest.webmanifest`, `client/index.html`, `client/public/sw.js`
- Create: `client/src/ui/Logo.tsx`
- Create: `client/public/motif.svg`

**Interfaces:**
- Produces:
  - `export function Logo({ size = 40, title }: { size?: number; title?: string }): JSX.Element`, berupa SVG inline. Tanpa `title`, logo `aria-hidden`.
  - `export function Wordmark({ className }: { className?: string }): JSX.Element`.
  - Kelas CSS `.motif`, latar pola dari `/motif.svg` dengan opasitas ≤ 0.06. Kelas ini `display:none`/tanpa latar pada `@media (prefers-reduced-motion: reduce)` dan `(prefers-reduced-data: reduce)`.
  - Token `--arwah`.

- [ ] **Step 1:** Ganti nilai token di `:root` sesuai tabel spec. Tambahkan `--arwah`. Semua aturan yang memakai `color:#fff` di atas `--brand` atau `--bubble-me` diganti menjadi `var(--brand-ink)` / `var(--bubble-me-ink)`.
- [ ] **Step 2:** Buat `icon.svg`: lingkaran `#0E0B0A`, siluet hantu `#EEE9E2`, garis ukir aso `#E4572E`. Gunakan viewBox 0 0 512 512, tanpa teks, tanpa gradien eksternal. `Logo.tsx` memakai path yang sama.
- [ ] **Step 3:** Ubah `manifest.webmanifest`: name dan short_name `KAMBE`, `theme_color`/`background_color` `#0E0B0A`. Di `index.html`: `<title>KAMBE</title>`, meta description dengan tagline, dan `theme-color`. Di `sw.js`: `CACHE = "kambe-shell-v1"`. Baris penghapus cache lama tidak boleh diubah.
- [ ] **Step 4:** Jalankan `pnpm typecheck && pnpm build`. Expected: sukses tanpa error.
- [ ] **Step 5:** Commit `feat(brand): token & logo KAMBE`.

### Task 3: Agen B, teks UI

**Files (hanya ini):** `client/src/ui/*.tsx` (kecuali `Logo.tsx`), `client/src/App.tsx`, `client/src/main.tsx`, `tests/browser/*.ts`

**Interfaces:**
- Consumes: `Logo` dan `Wordmark` dari `./Logo` (Task 2), kelas `.motif`, token `--arwah`. Agen B boleh mengimpor `Logo.tsx` sebelum berkasnya ada. Integrasi di Task 5 yang menyatukannya. Untuk typecheck lokal, buat stub sementara di cabangnya sendiri lalu hapus sebelum commit.

- [ ] **Step 1:** Ganti semua teks yang terlihat pengguna sesuai peta nama. Contohnya label tab Moments → Jejak, judul Radar → Radar Arwah, Shadow PIN → PIN Bayang, dan "PINPath" → "KAMBE". `aria-label` dan `title` juga diganti. Nama identifier tetap.
- [ ] **Step 2:** Di `Auth.tsx`:
  - pakai `<Logo size={72}/>` + `<Wordmark/>` + tagline `Hadir tanpa jejak.`;
  - tambahkan paragraf filosofi (teks persis dari spec bagian Brand);
  - bungkus layar dengan kelas `motif`.

  Di `Settings.tsx`, bagian "Tentang" memuat paragraf filosofi yang sama. Header `Shell.tsx`/`Sidebar.tsx` memakai `<Logo size={28}/>`.
- [ ] **Step 3:** Di `Vault.tsx`:
  - nama unduhan cadangan menjadi `kambe-cadangan-${alias}-${tanggal}.kambe`;
  - frasa kunci menjadi `kambe-frasa-kunci.txt` dengan judul isi `Frasa kunci perangkat KAMBE`;
  - `accept=".kambe,.pinpath,application/json"`.

  Nomor keamanan dan lencana terverifikasi memakai `color: var(--arwah)` lewat kelas yang sudah ada di styles.css. Bila kelasnya belum ada, catat di laporan dan biarkan Task 5 yang menambahkan.
- [ ] **Step 4:** Perbarui `tests/browser/*.ts` yang mencocokkan teks atau nama berkas lama. Contohnya selektor "PINPath", "Moments", dan ekstensi `.pinpath` untuk unduhan baru. Tes pemulihan di `vault-e2e.ts` tambahkan satu kasus: memulihkan berkas bernama `*.pinpath` tetap berhasil.
- [ ] **Step 5:** Jalankan `pnpm typecheck`. Expected: lulus (dengan stub). Commit `feat(ui): teks & nama fitur KAMBE`.

### Task 4: Agen C, server, env & dokumen

**Files (hanya ini):** `server/*.ts`, `shared/protocol.ts`, `shared/commerce.ts` (deskripsi saja), `scripts/*`, `README.md`, `docs/ARSITEKTUR.md`, `package.json` (`name`, `description`), `tests/*.test.ts` kecuali `kambe-compat.test.ts`. Create: `server/env.ts`, `tests/env.test.ts`.

**Interfaces:**
- Produces: `export function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined`. Fungsi ini mengembalikan `env["KAMBE_"+name] ?? env["PINPATH_"+name]`.

- [ ] **Step 1:** Tulis `tests/env.test.ts` dengan tiga kasus:
  - `readEnv({PINPATH_DB:"a"},"DB") === "a"`;
  - `readEnv({KAMBE_DB:"b",PINPATH_DB:"a"},"DB") === "b"`;
  - `readEnv({},"DB") === undefined`.
- [ ] **Step 2:** Jalankan `node --import tsx --test tests/env.test.ts`. Expected: FAIL karena modul belum ada.
- [ ] **Step 3:** Implementasikan `server/env.ts`. Ganti semua `env.PINPATH_X` di `server/index.ts`, `scripts/moderator-id.ts`, dan pesan log `server/app.ts` dengan `readEnv(env,"X")`. Pesan error menyebut nama `KAMBE_*`.
  - Nilai bawaan `dbPath` tetap `data/pinpath.db` bila berkas itu ada. Bila belum ada, pakai `data/kambe.db`. Tujuannya agar instalasi lama tidak kehilangan data.
  - Uji perilaku ini di `tests/env.test.ts` dengan fungsi `defaultDbPath(dataDir: string): string`, yang diekspor dari `server/env.ts`.
- [ ] **Step 4:** Ganti teks bermerek di server dan dokumen:
  - `shared/commerce.ts` → `KAMBE ${pay_ref}`;
  - README dan ARSITEKTUR: judul, tagline, tabel env `KAMBE_*` + catatan "nama lama `PINPATH_*` masih diterima", dan bagian "Label protokol yang dibekukan";
  - `package.json` name `kambe`;
  - tes yang mencocokkan teks lama (`payments.test.ts`, `pro-guard.test.ts`).
- [ ] **Step 5:** Jalankan `pnpm test`. Expected: semua lulus. Commit `feat(server): env KAMBE_* dengan fallback PINPATH_*, dokumen KAMBE`.

### Task 5: Integrasi (dikerjakan sendiri)

- [ ] **Step 1:** Merge cabang A, lalu C, lalu B ke `kambe-rebrand`. Hapus stub B dan selesaikan benturan.
- [ ] **Step 2:** Jalankan `grep -rniE "pinpath|path moments|shadow pin" client/src server shared scripts README.md docs/ARSITEKTUR.md`. Expected: yang tersisa hanya identitas beku Global Constraints, kunci legacy, `accept` `.pinpath`, `defaultDbPath`, fallback env, dan catatan dokumen.
- [ ] **Step 3:** Jalankan `pnpm test && pnpm build && pnpm test:browser`. Expected: unit lulus semua dan 4 suite browser lulus.
- [ ] **Step 4:** Commit integrasi.

### Task 6: Audit UI (dikerjakan sendiri)

- [ ] **Step 1:** Buat `tests/browser/audit-e2e.ts`, lalu tambahkan ke script `test:browser`. Tes ini mendaftar, lalu mengunjungi layar masuk, chat, Jejak, Radar Arwah, dan Pengaturan di lebar 360 dan 390. Yang diperiksa:
  - (a) `document.documentElement.scrollWidth <= innerWidth`;
  - (b) setiap `button, a, [role=button], input` yang terlihat punya tinggi dan lebar ≥ 44 (atau ≥ 24 dengan jarak 44 bila inline teks);
  - (c) kontras teks setiap elemen terlihat terhadap latar terdekat ≥ 4.5 (≥ 3 untuk teks ≥ 24px atau tebal ≥ 18.66px).

  Selain itu ambil tangkapan layar ke `tests/browser/out/`.
- [ ] **Step 2:** Jalankan tes itu. Expected awal: mungkin FAIL dengan daftar temuan. Perbaiki di styles.css atau komponen sampai lulus. Setiap perbaikan dicatat di ledger.
- [ ] **Step 3:** Jalankan `pnpm test && pnpm build && pnpm test:browser`. Expected: semua lulus. Commit `fix(ui): temuan audit KAMBE`.

### Task 7: Review akhir

- [ ] Satu reviewer baru (model terkuat) memeriksa paket review seluruh branch dari `050805b`, mengikuti Review Focus di atas. Temuan Critical/Important diperbaiki dengan TDD. Temuan Minor dicatat.
