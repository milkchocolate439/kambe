# KAMBE v2 — Rancangan Sistem (Fase A)

Tanggal: 9 Nov 2026 · Branch: `kambe-v2` (dari `sec/hardening` 55f3e60)
Sumber konsep: `PINPAD KONSEP/FORUMCHAT/*.txt` (KAMBE CORE, MODUL STORE, KAMBE COMPLATE, UI UX KAMBE,
ALL IN ONE, index, new — **semuanya terpotong ±10.000 karakter**) + referensi UI `chat.webp`.

## Keputusan pemilik (9 Nov 2026)

| # | Pertanyaan | Keputusan |
|---|---|---|
| 1 | Fee escrow | **GRATIS (0%)** — menggantikan 5%. Tetap bisa diubah lewat `KAMBE_FEE_PER_MILLE` |
| 2 | Warna | **Palet KAMBE tetap** (hitam hangat + merah api), gaya kaca dari referensi |
| 3 | Cakupan | Fase A dulu sampai semua tes lulus ("jalankan semua sesuai rencana") |
| 4 | Berita Intel 24H | Arah (a) kabar per sektor dari pengguna, hangus 24 jam — **ditunda ke setelah Fase A** |
| 5 | Biaya gateway nyata | **Terbuka** — belum berpengaruh selama penyedia `simulasi` |

## Temuan pada kode konsep (tidak disalin mentah)

1. `renderPeerStoreToUI` memakai `innerHTML` dengan data penjual → XSS. KAMBE memakai React escaping.
2. Log hanya diverifikasi dengan hash ulang `txId_status_timestamp` (siapa pun bisa menghitungnya) —
   tanda tangan tidak pernah diperiksa → nol perlindungan.
3. Hash tidak cocok langsung memicu `DISPUTE` → sengketa palsu bisa dipicu dengan data rusak.
4. `REGISTER_PIN` di server signaling tanpa autentikasi → PIN orang lain bisa dibajak.
5. Kunci ECDSA `extractable: true` disimpan polos di IndexedDB.
6. WebRTC langsung membuka IP asli kedua pihak — bertentangan dengan "Hadir tanpa jejak".
7. Bug: STUN `stun:://google.com` tidak valid; `MODUL STORE` menimpa `onmessage` milik `KambeCore`.

## Arsitektur

Fitur "tanpa server" dari konsep dijalankan lewat **relay E2EE yang sudah ada**: server tetap buta isi,
dan cara ini bekerja di balik CGNAT tanpa membuka IP. WebRTC (relay-only) tetap Fase B.

### Pesan kendali (control message) E2EE

Jenis payload baru `{ kind: "ctl", ctl: {...} }` di saluran `msg` (AAD & kunci sama dengan chat).
Server hanya melihat ciphertext biasa. Klien:

- tidak menampilkan pesan kendali sebagai gelembung chat;
- memprosesnya, menyimpannya hanya bila perlu (dalam brankas terenkripsi), lalu mengirim `delivered`
  + `read` agar relay segera menghapus ciphertext dan tidak menambah hitungan belum dibaca;
- saat tersambung, mengambil pesan tertunda untuk kontak dengan `unread > 0` (agar permintaan yang
  datang saat offline tetap diproses tanpa membuka chat — "zero-click").

Validasi ketat di `shared/ctl.ts` (bentuk, panjang, angka bulat). Klien lama yang menerima `ctl`
menampilkannya sebagai pesan rusak — dapat diterima karena belum ada rilis publik.

### 1. Escrow gratis
`FEE_PER_MILLE = 0`. UI menampilkan "Biaya escrow KAMBE: Gratis". Invoice gateway tanpa split rule bila
fee 0. Tes mekanisme fee tetap memakai tarif 5%/2,5% eksplisit. Pemasukan yang tersisa: KAMBE PRO.

### 2. Panic Wipe
Tombol tahan 2 detik (bukan klik) di Pengaturan & menu profil. Urutan: hentikan realtime → `logout`
(hapus sesi server, cookie) → hapus IndexedDB `pinpath` → hapus Cache Storage → hapus
localStorage/sessionStorage → batalkan service worker → muat ulang ke layar masuk.
Opsi "hapus akun di server juga" memakai alur hapus akun yang sudah ada (butuh passphrase).
Batas jujur: salinan di HP lawan dan ciphertext yang sedang di relay tidak ikut terhapus.

### 3. Etalase Hantu (pengganti Private Store)
- Produk disimpan di brankas perangkat penjual (`keystore` secret `ghost-store`), maks. 30 item,
  judul ≤ 80, deskripsi ≤ 300, harga `PRICE_MIN..PRICE_MAX`, `expiresAt = +72 jam` (bisa diperpanjang).
- Pembeli: `store.req {reqId}` → HP penjual menjawab sendiri `store.res {reqId, part, parts, items}`
  (dipecah ≤ 12 KB per bagian). Pembeli menyimpan katalog **hanya di memori**.
- Beli: `store.order {orderId, itemId}` → HP penjual (bila PRO) otomatis membuat tawaran rekber
  (`/api/deals/offer`, `idempotencyKey = orderId`) dengan harga dari katalognya sendiri; bila tidak
  bisa → `store.nack {orderId, reason}`.
- Batas: 20 `store.req` & 5 `store.order` per pembeli per jam (di perangkat penjual). Hanya kontak
  dengan safety number yang tidak sedang berubah yang dilayani.
- Aturan PRO tidak diubah: membuka etalase hantu gratis untuk semua, **pembayaran rekber tetap butuh
  penjual PRO** (keputusan bisnis terpisah; lihat "Terbuka").

### 4. Buku Jejak Transaksi (pengganti Zero-Click Report Log)
- Kunci tanda tangan perangkat **Ed25519** diturunkan dari seed (`HKDF … device-sign-ed25519`, label
  baru — label lama tidak disentuh), non-extractable. Kunci publiknya didaftarkan ke server
  (`PUT /api/me/sign-key`, kolom `users.sign_key`) dan ikut di data kontak; klien mem-pin (TOFU).
- Setiap kuitansi notaris yang lolos verifikasi menambah entri ke rantai lokal milik akun:
  `{dealId, seq, status, price, fee, receiptHash, role, signer, signKey, at, prev}` → ditandatangani
  perangkat → disimpan terenkripsi → dikirim ke lawan (`txlog.entry`).
- Penerima memverifikasi tanda tangan dengan kunci yang di-pin, lalu mencocokkan `receiptHash` dengan
  kuitansinya sendiri untuk `(dealId, seq)` yang sama. Cocok → entri berstatus **tiga tanda tangan**
  (notaris + saya + lawan). Tidak cocok → banner "Catatan tidak cocok" + ekspor bukti; **tidak** membuka
  sengketa otomatis. Ini mendeteksi notaris yang menunjukkan kuitansi berbeda ke pembeli dan penjual.
- `verifyTxEvidence()` di `shared/txlog.ts` dapat dipakai pihak ketiga (moderator) untuk memeriksa
  berkas bukti ekspor dengan kunci publik notaris.

### 5. UI v2 (referensi chat.webp, palet KAMBE)
- Daftar obrolan: judul besar "Obrolan", tombol bulat kaca (cari, PIN, lainnya), baris **Jejak**
  bergaya story, chip filter (Semua · Belum dibaca · Dagang · Terverifikasi), item dengan waktu & badge.
- HP: **navigasi pil melayang** (Obrolan · Radar · Jejak · Profil) + FAB (+ undang PIN).
- Ruang chat: latar gradasi hangat, header kaca, gelembung lawan kaca gelap / saya merah api,
  composer berbentuk pil.
- Profil kontak: avatar besar, PIN Kambe (pengganti nomor HP), kartu statistik (Pesan · Kesepakatan ·
  Jejak), daftar aksi (Nomor keamanan, Etalase Hantu, Buku Jejak, Cari pesan, Blokir).
- `backdrop-filter` hanya di dalam `@supports`, fallback warna solid. Kontras ≥ 4,5:1, target ≥ 44px,
  tanpa gulir horizontal di 360/390px (dijaga `tests/browser/audit-e2e.ts`).

## Skala & keandalan
MVP 10 rb pengguna / 1 rb WS bersamaan / 20 pesan per orang per hari ≈ 2,3 pesan/dtk (puncak ±25):
satu proses Node + SQLite WAL cukup. Pesan kendali menambah ±1 pesan per perubahan status kesepakatan
dan per permintaan etalase. Tinjau ulang bila WS > 10 rb (shard + pub/sub), multi-instance (Postgres),
atau Fase B (biaya TURN).

## Terbuka / berikutnya
- Biaya gateway nyata saat Xendit aktif: platform / pembeli / penjual.
- Rekber untuk penjual non-PRO lewat Etalase Hantu (sekarang tetap butuh PRO).
- Kabar 24 Jam per sektor (Berita Intel) — butuh kebijakan moderasi.
- Fase B: WebRTC relay-only + Jabat Tangan QR. Fase C: grup E2EE, lampiran foto, panggilan.
