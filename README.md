# PINPath

Messenger berbasis **PIN 6 karakter** ala BBM dengan **enkripsi end-to-end (E2EE) sungguhan**.
Tanpa nomor HP, tanpa email. Server hanya meneruskan dan menyimpan data acak (ciphertext).

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

> Catatan Kali/WSL: Node dari paket Kali dikompilasi tanpa dukungan TypeScript, jadi semua
> skrip memakai `node --import tsx`.

## Pengujian

```bash
pnpm test           # 49 tes: kriptografi + API/WebSocket + uang/rekber (server sungguhan, DB di memori),
                    # termasuk regresi temuan red-team (DoS frame WS, injeksi event, oracle ID, kunci low-order)
pnpm build && pnpm test:browser   # 21 + 17 pemeriksaan di Chromium headless (chat & dagang), 2 pengguna
```

Tes browser mencakup: undangan PIN, chat E2EE, status D/R, PING!!!, safety number,
**payload XSS di isi chat**, peringatan anti-penipuan, deteksi kunci berubah (MITM),
audit pelanggaran CSP, dan tata letak HP tanpa scroll horizontal. Screenshot di `tests/browser/out/`.

## Model keamanan

| Lapisan | Mekanisme |
|---|---|
| Kunci identitas | X25519 per perangkat, dibuat di browser, **non-extractable** (tidak bisa dibaca skrip), disimpan di IndexedDB |
| Kunci percakapan | HKDF-SHA256 dari ECDH; salt mengikat id + kunci publik kedua pihak |
| Isi pesan | AES-256-GCM, nonce acak 96-bit, AAD mengikat id pesan + pengirim + penerima + kedua kunci (anti tukar/replay) |
| Anti-MITM | Safety number 60 digit + *key pinning* (TOFU). Kunci lawan berubah → peringatan & kirim dikunci sampai ditinjau |
| Akun | Alias + passphrase (scrypt N=2¹⁵), kode pemulihan 100-bit sekali pakai, sesi cookie HttpOnly + SameSite=Strict |
| Orang asing | Undangan PIN wajib disetujui; alias tujuan tidak terlihat sebelum diterima; blokir senyap; ganti PIN menghapus undangan spam |
| Penyalahgunaan | Rate limit: login, pemulihan, pendaftaran, pencarian PIN (30/jam), undangan, pesan, PING (30 dtk, di server **dan** klien) |
| Web | CSP `script-src 'self'` tanpa CDN, cek Origin (anti CSRF & Cross-Site WebSocket Hijacking), anti-clickjacking, React escaping (tanpa `innerHTML`) |
| Privasi | Hapus akun = data server dihapus (CASCADE) + kunci lokal dihapus. Tanda "R" bisa dimatikan |

### Yang **diketahui server** (metadata)

Alias, PIN, status pribadi (pm), siapa terhubung dengan siapa, waktu kirim, ukuran ciphertext,
dan apakah sebuah pesan adalah PING (untuk rate limit). Catatan undangan tidak terenkripsi (diberi label di UI).

### Batasan saat ini (jujur)

- **Belum ada forward secrecy**: kunci percakapan statis per pasangan perangkat. Bila kunci privat
  perangkat dicuri, pesan lama pasangan itu bisa dibuka. → Fase 2: Double Ratchet.
- **Satu perangkat aktif per akun**. Login di perangkat baru = kunci baru; pesan lama hanya terbaca di perangkat lama.
- Riwayat ciphertext disimpan di server (agar bisa dimuat ulang). → Fase 2: simpan lokal + hapus di server setelah terkirim.
- Rate limiter di memori (cukup untuk satu instance). Skala banyak instance → Redis.
- Keamanan E2EE tetap bergantung pada server yang menyajikan kode JS dengan jujur (keterbatasan semua web app E2EE).
  APK/app ter-install mengurangi risiko ini.

## Fase 2 — Etalase & kesepakatan rekber (SIMULASI)

> Tidak ada uang sungguhan. Label **SIMULASI** selalu tampil di UI.

- **PRO Rp49.000/bln** (divalidasi server, idempoten): membuka etalase & tawaran kesepakatan dari chat.
- **Etalase hanya untuk kontak** yang sudah disetujui (bukan publik).
- **Alur rekber**: `AWAITING_PAYMENT → HELD (dana ditahan) → SHIPPED → COMPLETED (dana cair, fee 2,5%)`.
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

## Roadmap

- **Fase 2b**: Double Ratchet (forward secrecy) + riwayat disimpan lokal di perangkat; lampiran terenkripsi.
- **Fase 3 tambahan**: moderator/admin untuk menengahi sengketa.
- **Fase 3**: Path Moments, Radar opt-in (default mati), Shadow PIN 24 jam.
- **Fase 4**: APK (Capacitor), payment gateway berizin (escrow/rekber memegang dana publik butuh izin BI + KYC/AML).
