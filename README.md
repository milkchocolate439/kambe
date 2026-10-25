# PINPath

Messenger berbasis **PIN 6 karakter** ala BBM dengan **enkripsi end-to-end (E2EE) sungguhan**.
Tanpa nomor HP, tanpa email. Arsitektur **local-first**: riwayat tinggal di perangkat, server hanya
**relay** (ciphertext dihapus setelah terkirim) + **notaris** kuitansi bertanda tangan + orkestrasi pembayaran.

> 📐 Struktur resmi & pemetaan terhadap konsep "Local Server User & Monetisasi Terdesentralisasi":
> **[docs/ARSITEKTUR.md](docs/ARSITEKTUR.md)** — apa yang diadopsi, disesuaikan, dan ditolak (beserta alasannya).

> Dikembangkan dari prototipe `pinpath_messenger_secret_social_commerce.html`. Prototipe itu
> hanya memberi *label* "E2EE"; versi ini mengimplementasikannya, plus menutup celah XSS,
> PIN `Math.random()`, identitas asli yang bocor ke browser, dan fee yang dihitung di klien.

## Menjalankan

```bash
pnpm install
pnpm dev            # API :3300 + Vite :5173 → buka http://127.0.0.1:5173
pnpm build && pnpm start   # produksi: satu server di http://127.0.0.1:3300
```

Variabel lingkungan (opsional):

| Variabel | Default | Fungsi |
|---|---|---|
| `PORT` / `HOST` | `3300` / `127.0.0.1` | Alamat server (default tidak terbuka ke jaringan) |
| `PINPATH_DB` | `data/pinpath.db` | Lokasi database SQLite |
| `PINPATH_SECURE` | – | `1` di balik HTTPS → cookie `Secure` + HSTS |
| `PINPATH_TRUST_PROXY` | – | `1` hanya bila di belakang reverse proxy milik sendiri |
| `PINPATH_ORIGINS` | – | Daftar Origin yang diizinkan (koma). Kosong = harus sama dengan Host |
| `PINPATH_FEE_PER_MILLE` | `50` | Fee platform per seribu (**default 50 = 5%**; 25 = 2,5%; maks. 200). Tersimpan per kesepakatan saat dibuat |
| `PINPATH_NOTARY_KEY` / `PINPATH_NOTARY_KEY_FILE` | `data/notary.key` | Kunci privat Ed25519 notaris kuitansi (server-only; dibuat otomatis, izin 0600) |
| `PINPATH_PAYMENT_PROVIDER` | `simulasi` | `xendit` untuk gateway nyata (butuh `XENDIT_SECRET_KEY`, `XENDIT_CALLBACK_TOKEN`, `PINPATH_PUBLIC_URL`, opsional `XENDIT_SPLIT_RULE_ID`) |
| `VITE_NOTARY_PUBLIC_KEY` | – | (saat build) kunci publik notaris yang ditanam di aplikasi/APK; tanpa ini klien mem-pin kunci saat pertama terlihat |
| `PINPATH_MODERATORS` | – | **ID akun** (UUID) moderator sengketa, dipisah koma. Cari ID: `node --import tsx scripts/moderator-id.ts <alias>`. Alias sengaja tidak diterima (bisa diserobot lewat pendaftaran) |

> Catatan Kali/WSL: Node dari paket Kali dikompilasi tanpa dukungan TypeScript, jadi semua
> skrip memakai `node --import tsx`.

## Pengujian

```bash
pnpm test           # 104 tes: kriptografi, sealed object, brankas/frasa kunci/cadangan, API/WebSocket, uang/rekber,
                    # sengketa/moderator, Shadow PIN/radar, Moments, notaris (server sungguhan, DB di memori) + regresi red-team
pnpm build && pnpm test:browser   # 4 suite Chromium headless: chat, dagang+moderator, Fase 3, brankas perangkat
```

Tes browser mencakup: undangan PIN, chat E2EE, status D/R, PING!!!, safety number,
**payload XSS di isi chat**, peringatan anti-penipuan, deteksi kunci berubah (MITM),
audit pelanggaran CSP, dan tata letak HP tanpa scroll horizontal. Screenshot di `tests/browser/out/`.

## Model keamanan

| Lapisan | Mekanisme |
|---|---|
| Kunci identitas | X25519 diturunkan dari **frasa kunci** (seed 256-bit milik pengguna, tidak pernah ke server); dipakai sebagai CryptoKey **non-extractable** |
| Data di perangkat | Riwayat, pin kunci, alamat yang diingat: AES-256-GCM per rekaman. Seed dibungkus passphrase (PBKDF2 600k). Keluar = kunci dihapus, data terkunci |
| Cadangan | File `.pinpath` terenkripsi kunci turunan frasa kunci; dipulihkan di HP baru tanpa mengubah safety number |
| Isi selain chat | Status, catatan undangan, produk, judul/bukti kirim/pernyataan/putusan sengketa, label: *sealed object* multi-penerima (lihat `docs/ARSITEKTUR.md`) |
| Kunci percakapan | HKDF-SHA256 dari ECDH; salt mengikat id + kunci publik kedua pihak |
| Isi pesan | AES-256-GCM, nonce acak 96-bit, AAD mengikat id pesan + pengirim + penerima + kedua kunci (anti tukar/replay) |
| Anti-MITM | Safety number 60 digit + *key pinning* (TOFU). Kunci lawan berubah → peringatan & kirim dikunci sampai ditinjau |
| Akun | Alias + passphrase (scrypt N=2¹⁵), kode pemulihan 100-bit sekali pakai, sesi cookie HttpOnly + SameSite=Strict |
| Orang asing | Undangan PIN wajib disetujui; alias tujuan tidak terlihat sebelum diterima; blokir senyap; ganti PIN menghapus undangan spam |
| Penyalahgunaan | Rate limit: login, pemulihan, pendaftaran, pencarian PIN (30/jam), undangan, pesan, PING (30 dtk, di server **dan** klien) |
| Web | CSP `script-src 'self'` tanpa CDN, cek Origin (anti CSRF & Cross-Site WebSocket Hijacking), anti-clickjacking, React escaping (tanpa `innerHTML`) |
| Privasi | Hapus akun = data server dihapus (CASCADE) + kunci lokal dihapus. Tanda "R" bisa dimatikan |

### Yang **diketahui server** (metadata)

Alias, PIN, siapa terhubung dengan siapa, waktu kirim, ukuran ciphertext, apakah sebuah pesan adalah PING
(untuk rate limit), serta harga/fee/status kesepakatan (wajib untuk rekber & fee 5%). Semua **isi** tulisan
pengguna hanya tersimpan sebagai ciphertext.

### Batasan saat ini (jujur)

- **Belum ada forward secrecy**: kunci percakapan statis per pasangan perangkat. Bila kunci privat
  perangkat dicuri, pesan lama pasangan itu bisa dibuka. → Fase 2: Double Ratchet.
- **Satu perangkat aktif per akun** dalam satu waktu. Pindah HP: pakai frasa kunci (kunci sama) + file cadangan
  untuk riwayat lama. Tanpa frasa kunci = kunci baru, dan pesan lama hanya terbaca di perangkat lama.
- Riwayat hanya ada di perangkat (local-first; server menghapus ciphertext setelah terkirim). Cadangan dibuat manual.
- Passphrase dipakai untuk login **dan** membuka brankas lokal: operator server jahat yang juga mencuri disk HP
  bisa membuka brankas. Frasa kunci sendiri tidak pernah dikirim ke server.
- Rate limiter di memori (cukup untuk satu instance). Skala banyak instance → Redis.
- Keamanan E2EE tetap bergantung pada server yang menyajikan kode JS dengan jujur (keterbatasan semua web app E2EE).
  APK/app ter-install mengurangi risiko ini.

## Fase 2 — Etalase & kesepakatan rekber (SIMULASI)

> Tidak ada uang sungguhan. Label **SIMULASI** selalu tampil di UI.

- **PRO Rp49.000/bln** (divalidasi server, idempoten): membuka etalase & tawaran kesepakatan dari chat.
- **Etalase hanya untuk kontak** yang sudah disetujui (bukan publik).
- **Alur rekber**: `AWAITING_PAYMENT → HELD (dana ditahan) → SHIPPED → COMPLETED (dana cair, fee 5%)`.
  Pembatalan sebelum bayar; penjual bisa refund penuh tanpa fee; pembeli bisa sengketa (menghentikan pencairan otomatis).
- **Tenggat anti-sandera (kedua arah)** — dana tidak pernah bisa terkunci selamanya:

  | Situasi | Tenggat |
  |---|---|
  | Dibayar, penjual belum kirim | Wajib kirim ≤ **3 hari**; lewat itu pembeli boleh **tarik dana sendiri**; otomatis kembali ke pembeli setelah **7 hari** |
  | Dikirim, pembeli diam | Dana cair ke penjual setelah **7 hari** |
  | Sengketa buntu | Dana kembali ke pembeli setelah **14 hari** (dana belum pernah cair, pengiriman tak terbukti) |

  Catatan: aturan sengketa sedikit memihak pembeli; perlindungan penjual penuh menunggu bukti kirim + moderator (Fase 3).
- **Anti-manipulasi**: harga & fee hanya dari server; transisi status lewat tabel tunggal + `UPDATE … WHERE status=<lama>`
  dalam transaksi (klik ganda/paralel tidak bisa mencairkan dua kali); pembuatan kesepakatan & langganan idempoten.
- **Buku besar double-entry** (rupiah bulat): setiap posting berjumlah nol; audit memastikan saldo escrow = dana yang ditahan.
- **Identitas asli** (nama/alamat/WA) dibagikan sebagai **pesan E2EE** di chat — server tidak pernah melihatnya.
- Hapus akun ditolak selama ada kesepakatan terbuka (dana pihak lain tidak ikut hilang). Diblokir di tengah jalan:
  pembayaran ditolak, tapi refund/konfirmasi tetap bisa.

## Fase 3 — Moderator sengketa, Shadow PIN, Radar, Path Moments

**Bukti kirim & moderator**
- "Kirim" wajib bukti: kurir dari daftar + nomor resi (6–40 huruf/angka), atau keterangan serah terima untuk
  "Diantar langsung"/"Jasa digital". Bukti terlihat pembeli & moderator.
- Sengketa wajib alasan (tidak diterima / tidak sesuai / rusak / lainnya) + cerita. Kedua pihak bisa menambah
  maks. 5 pernyataan — **dibaca moderator, tidak terenkripsi E2EE** (diberi label jelas di UI).
- Moderator (`PINPATH_MODERATORS=<id-akun>,…`) melihat data kesepakatan, bukti kirim, dan pernyataan —
  **bukan isi chat**. Putusan refund/cairkan wajib alasan (dibaca kedua pihak), final, atomik, tercatat di
  `moderation_log`. Moderator tidak bisa memutus kesepakatannya sendiri; panel tersembunyi (404) bagi pengguna biasa.
- Sengketa yang kedaluwarsa (14 hari) dicatat sebagai putusan sistem yang bisa dibaca kedua pihak.

**Shadow PIN (24 jam)** — PIN sementara untuk orang asing; maks. 3 aktif; bisa dicabut (undangan tertunda ikut hangus).
Yang terhubung lewat Shadow PIN **tidak pernah melihat PIN utama** (kontak menampilkan PIN yang dipakai saat terhubung).

**Radar ekonomi (opt-in, default mati)** — tampil 7 hari per sektor dengan kebutuhan/tawaran; hanya sesama peserta yang
bisa melihat (resiprokal, anti-pengintip pasif); memakai **PIN radar khusus**; tanpa id internal; peserta yang diblokir
atau sudah jadi kontak tidak tampil; keluar radar = PIN radar mati.

**Path Moments (E2EE)** — pikiran/musik/tempat (nama, bukan GPS)/bangun/tidur. Setiap momen **dienkripsi terpisah
untuk tiap kontak** + salinan diri sendiri (`deriveSelfKey`), saluran AAD `moment` terpisah dari `msg` (ciphertext tidak
bisa dipindah antar-saluran). Hanya kontak saat ini yang melihat; kontak dengan safety number berubah yang belum ditinjau
tidak ikut dikirimi; terhapus otomatis setelah 30 hari. Reaksi 😊😮❤️ adalah metadata yang terlihat server.

## Roadmap

- **Fase 2b**: Double Ratchet (forward secrecy) + riwayat disimpan lokal di perangkat; lampiran terenkripsi (foto bukti sengketa).
- **Fase 4**: APK (Capacitor), payment gateway berizin, notifikasi push.
- **Fase 3**: Path Moments, Radar opt-in (default mati), Shadow PIN 24 jam.
- **Fase 4**: APK (Capacitor), payment gateway berizin (escrow/rekber memegang dana publik butuh izin BI + KYC/AML).
