# Arsitektur KAMBE — Local-First + Relay Ringan + Notaris Pembayaran

> *Hadir tanpa jejak.* Seperti kambe, kamu hadir tanpa nomor HP atau email. Pesanmu hanya singgah sebentar
> di server, lalu hilang. Hanya yang kamu izinkan yang bisa melihatmu.
> (KAMBE sebelumnya bernama PINPath; label protokol lama sengaja dibekukan, lihat §6.)

Dokumen ini meluruskan struktur KAMBE terhadap konsep **"Local Server User & Monetisasi Developer
Terdesentralisasi"** (`konsep_arsitektur_dan_logika_monetisasi (1).md`). Setiap butir konsep dipetakan:
**diadopsi**, **disesuaikan**, atau **ditolak**, beserta alasannya. Prinsip penentu: keselamatan pengguna →
kepatuhan hukum Indonesia → kenyamanan → kesederhanaan.

## 1. Bentuk akhir sistem

```
+------------------------------- Ponsel pengguna (node) -------------------------------+
|  UI (React/PWA → APK)  <->  Mesin lokal                                               |
|                            - Kunci identitas X25519 (non-extractable, IndexedDB)      |
|                            - Riwayat pesan & momen TERDEKRIPSI disimpan lokal         |
|                            - Kuitansi transaksi bertanda tangan (diverifikasi lokal)  |
+------------------------------------------+-------------------------------------------+
                                           | WebSocket/HTTPS (hanya ciphertext + metadata minimum)
                                           v
+---------------------------- Server developer (ringan) -------------------------------+
|  Relay      : store-and-forward ciphertext, DIHAPUS setelah terkirim (maks. 30 hari)  |
|  Direktori  : PIN → kunci publik, undangan, blokir (tanpa HP/email/identitas asli)    |
|  Notaris    : menandatangani kuitansi kesepakatan (Ed25519); kunci publik di aplikasi |
|  Orkestrasi : membuat sesi bayar & menerima webhook gateway (kunci rahasia di server)  |
+------------------------------------------+-------------------------------------------+
                                           v
                     Payment gateway berizin (split otomatis: penjual / fee developer)
```

## 2. Pemetaan konsep → KAMBE

| Konsep dokumen | Keputusan | Implementasi di KAMBE |
|---|---|---|
| Database & state lokal di ponsel | **Diadopsi** | Riwayat chat & momen disimpan di IndexedDB perangkat (`client/src/lib/localstore.ts`). Server bukan arsip. |
| Relay ringan (tanpa logika bisnis/penyimpanan) | **Diadopsi untuk pesan** | Ciphertext dihapus dari server segera setelah penerima mengonfirmasi terima (`delivered`), atau setelah 30 hari bila tak pernah terkirim. |
| Sinkronisasi ulang saat ponsel hidup | **Diadopsi** | Antrean kirim (outbox) + pengambilan pesan tertunda saat tersambung lagi (sudah ada sejak Fase 1). |
| Ponsel sebagai server P2P penuh (WebRTC/libp2p) | **Disesuaikan** | Ponsel berada di balik NAT/CGNAT operator dan dibatasi OS saat di latar belakang; tetap perlu relay. Relay hanya melihat ciphertext, jadi tujuan privasinya tercapai. P2P langsung (WebRTC) bisa jadi optimisasi kelak untuk lampiran besar. |
| Server developer pasif | **Disesuaikan** | Server tetap ada tapi **minim data**: tidak menyimpan isi pesan/momen, tidak menyimpan riwayat, tidak menyimpan identitas asli. Logika uang tetap di server karena uang harus dikendalikan pihak tepercaya (lihat §4). |
| **Skema A — smart contract/crypto** | **Ditolak** | Crypto dilarang sebagai alat pembayaran di Indonesia (UU 7/2011 tentang Mata Uang, ketentuan BI). Transaksi on-chain juga permanen & publik — bertentangan dengan privasi. |
| **Skema B — payment gateway split** | **Diadopsi (cara aman)** | Lihat §4. Kunci rahasia gateway **hanya di server**; ponsel hanya membuka halaman/QR bayar. Split penjual/fee dilakukan gateway (mis. xenPlatform). |
| **Skema C — kredit yang bisa ditukar uang** | **Ditolak untuk sekarang** | Nilai tersimpan yang bisa diuangkan = uang elektronik → wajib izin BI. Kredit tertutup (tidak bisa diuangkan) bisa dipertimbangkan kelak. |
| "Tanda tangan dengan Developer **Public** Key" | **Diperbaiki** | Tanda tangan butuh **kunci privat** — kunci itu disimpan di server (notaris), *tidak pernah* di ponsel. Ponsel memverifikasi dengan kunci publik notaris. |
| Validasi silang pembeli–penjual untuk menegakkan fee | **Disesuaikan** | Dua pihak yang bersekongkol selalu bisa bertransaksi di luar aplikasi; fee hanya bisa ditegakkan bila **uang mengalir lewat gateway**. Validasi silang tetap dipakai untuk mencegah *pemalsuan kuitansi* (kuitansi tanpa tanda tangan notaris ditolak klien). |
| HD wallet / master seed | **Diadopsi bertahap** | Tahap berikut: frasa pemulihan → kunci identitas deterministik, agar pindah ponsel tidak mengubah safety number. |
| PIN dinamis (TOTP per N detik) | **Disesuaikan** | TOTP butuh rahasia bersama, sehingga orang asing tak bisa menemukanmu. Penggantinya: **PIN sekali pakai** (hangus setelah 1 undangan), **PIN Bayang 24 jam**, **PIN Radar Arwah**, dan **rotasi PIN utama otomatis**. Kontak hanya melihat PIN yang mereka pakai → PIN berbeda tidak bisa dikaitkan oleh sesama pengguna. |
| Stealth address / one-time payment code | **Disesuaikan** | Setiap kesepakatan memakai **kode referensi bayar sekali pakai** yang tidak memuat identitas; kuitansi hanya berisi alias saat transaksi. |
| Fee 5% (dokumen) | **Diganti: escrow GRATIS (keputusan pemilik 9 Nov 2026)** | Default **0%** (`FEE_PER_MILLE = 0`; sebelumnya 5%). Invoice gateway tanpa split rule bila fee 0; tetap bisa diubah dengan `KAMBE_FEE_PER_MILLE` (nama lama `PINPATH_*` masih diterima) (25 = 2,5%, 50 = 5%, maks. 200). Fee tersimpan di setiap kesepakatan saat dibuat, jadi perubahan tarif tidak mengubah kesepakatan lama. |

## 3. Apa yang diketahui server (setelah penyelarasan)

### 3a. Audit enkripsi (Tahap 1 "enkripsi mutlak")

Semua **isi** yang ditulis pengguna disegel di perangkat. Server hanya menyimpan ciphertext,
tanpa kunci untuk membukanya.

| Isi | Cara dilindungi | Siapa yang bisa membaca |
|---|---|---|
| Pesan chat & PING | E2EE X25519 → AES-256-GCM per percakapan | Kedua pihak |
| Jejak (momen) | E2EE per penerima | Kontak yang dipilih penulis |
| Identitas pengiriman (nama/alamat) | Dikirim sebagai pesan E2EE | Penjual |
| Status pribadi (PM) | Sealed object `pm` | Kontak dengan safety number yang dipercaya |
| Catatan undangan | Sealed object `note` | Pemilik PIN tujuan |
| Label PIN Bayang | Sealed object `label` | Pemilik saja |
| Judul, deskripsi & sektor produk | Sealed object `product` | Kontak penjual |
| Judul kesepakatan | Sealed object `deal` | Pembeli, penjual & moderator |
| Bukti kirim (kurir/resi/catatan) | Sealed object `shipment` | Pembeli, penjual & moderator |
| Pernyataan & alasan sengketa | Sealed object `statement` | Pembeli, penjual & moderator |
| Alasan putusan moderator | Sealed object `resolution` | Pembeli & penjual |
| Kuitansi notaris | Hanya memuat `contentHash` dari isi tersegel, bukan judulnya | Semua orang bisa memverifikasi; isinya tidak bocor |

**Sealed object** (`shared/sealed.ts`) bekerja begini:

- Isi dienkripsi sekali dengan kunci acak K (AES-256-GCM).
- K dibungkus untuk tiap penerima memakai KEK = HKDF(X25519(kunci privat pemilik, kunci publik penerima)).
- AAD mengikat jenis objek, id, kunci pemilik dan kunci penerima, sehingga bungkus tidak bisa dipindah ke objek lain.

Aturan di server:

- Server menolak isi polos (`*_must_be_encrypted`).
- Server menolak penerima di luar yang berhak (`recipient_not_allowed`).
- Server menolak kunci penerima yang sudah usang (`key_changed`).
- Kontak yang safety number-nya sedang berubah tidak diberi kunci sampai ditinjau.
- Bila moderator ganti perangkat, pihak sengketa menerima sinyal `reshare_needed`. Klien mereka lalu otomatis membungkus ulang isi untuk kunci baru moderator.

**Yang sengaja TIDAK dienkripsi** (tanpa data ini server tidak bisa berfungsi):

| Data | Alasan |
|---|---|
| Alias, PIN, kunci publik | Direktori untuk saling menemukan |
| Siapa berteman dengan siapa, waktu & status kirim | Metadata routing relay |
| Harga, fee, status kesepakatan, buku besar | Rekber (dan fee bila diaktifkan; default gratis) ditegakkan di server; harus bisa diaudit |
| Iklan Radar Arwah (citra) | Memang publik bagi peserta radar |
| Pilihan putusan moderator (refund/release) | Menggerakkan uang |

### 3b. Di perangkat: brankas & frasa kunci (Tahap 2)

| Komponen | Cara kerja |
|---|---|
| **Frasa kunci** | Seed acak 256-bit, ditulis sebagai 14 grup × 4 karakter Crockford base32 dengan checksum 20-bit (salah ketik langsung ketahuan). Tidak pernah dikirim ke server. |
| Kunci identitas | X25519 diturunkan dari seed dengan HKDF. Memulihkan frasa di HP baru menghasilkan kunci publik yang **sama**, jadi kontak tidak melihat "safety number berubah". |
| Kunci riwayat & cadangan | HKDF(seed, label + id akun) → AES-256-GCM non-extractable. Kedua kunci ini terpisah dari kunci identitas. |
| **Brankas** | Seed dibungkus passphrase (PBKDF2-SHA256 600.000 iterasi → AES-256-GCM, AAD = akun + kunci publik). |
| Riwayat, pin kunci kontak, alamat yang diingat, pin notaris, seq kuitansi | Dienkripsi per rekaman di IndexedDB. AAD mengikat kunci rekaman, jadi rekaman tidak bisa ditukar. Yang polos hanya (pemilik, lawan, waktu) untuk pengurutan. |
| **Keluar** | Kunci yang sedang terbuka dihapus. Di disk hanya tersisa brankas berpassphrase + ciphertext. Masuk lagi dengan passphrase membuka kembali riwayat. |
| Muat ulang halaman | Kunci terbuka (CryptoKey non-extractable) tetap ada selama sesi, jadi tidak perlu mengetik passphrase lagi. |
| **Cadangan** | File `.kambe` dienkripsi dengan kunci cadangan, terikat ke akun dan waktu pembuatan. File disimpan pengguna sendiri, tidak diunggah ke server. Bisa dipulihkan di HP baru dengan frasa yang sama, atau dengan frasa lama setelah "mulai baru". File `.pinpath` dari era PINPath tetap bisa dipulihkan (format di dalamnya sama). |
| Migrasi data lama | Riwayat/pin polos dari sebelum Tahap 2 dienkripsi ulang otomatis. Alamat polos di `localStorage` dipindah ke brankas lalu dihapus. Kunci perangkat acak lama dibuang. |

Batas yang jujur:

- Saat sedang masuk, perangkat yang dibobol (malware/root) tetap bisa memakai kunci yang terbuka.
- Passphrase juga dipakai untuk login. Artinya operator server yang jahat **sekaligus** memegang disk HP bisa membuka brankas. Frasa kunci tetap tidak pernah ke server.

### 3c. Ringkasan

| Data | Disimpan server? |
|---|---|
| Isi pesan, Jejak, identitas pengiriman | Tidak pernah (E2EE) |
| Ciphertext pesan | Hanya sampai terkirim (maks. 30 hari bila penerima tak pernah online) |
| Isi lain (status, catatan, produk, judul, bukti kirim, pernyataan, putusan, label) | Hanya ciphertext (sealed object) |
| Alias, PIN, kunci publik, kontak, blokir | Ya (direktori) |
| Harga, status kesepakatan, buku besar | Ya (diperlukan untuk menegakkan aturan uang & moderasi) |
| Nomor HP, email, KTP | Tidak pernah diminta |

## 4. Uang: notaris + gateway (Skema B yang benar)

```
Ponsel pembeli ──(1) minta bayar──▶ Server ──(2) buat invoice split (kunci rahasia)──▶ Gateway
      ▲                                │                                                 │
      └──────(3) URL/QR bayar──────────┘                                                 │
Ponsel pembeli ──(4) bayar langsung di halaman gateway──────────────────────────────────▶ │
Server ◀──(5) webhook (diverifikasi token/HMAC, idempoten)────────────────────────────────┘
Server ──(6) kuitansi bertanda tangan Ed25519──▶ kedua ponsel (diverifikasi & disimpan lokal)
```

- **Mengapa bukan langsung dari ponsel?** Kunci rahasia gateway di dalam APK bisa diekstrak dan dipakai
  untuk refund/payout ke rekening penyerang. Webhook juga butuh alamat publik yang tidak dimiliki ponsel.
- **Fee developer** dipotong otomatis oleh gateway (split rule), bukan oleh kode di ponsel → tidak bisa dicurangi
  dengan memodifikasi aplikasi.
- **Kuitansi notaris**: setiap perubahan status kesepakatan menghasilkan kuitansi `{id, status, harga, fee, waktu, …}`
  yang ditandatangani server. Klien menolak kuitansi dengan tanda tangan tidak sah → server yang dibobol pun tidak
  bisa memalsukan riwayat yang sudah diterima klien tanpa ketahuan, dan pengguna punya bukti transaksi offline.
- **Status saat ini**: penyedia `simulasi` (tanpa uang sungguhan). Penyedia `xendit` disiapkan sebagai kerangka
  (pembuatan invoice + verifikasi webhook); aktif setelah akun & kunci gateway tersedia dan kepatuhan disetujui.

## 5. Peta kode

| Lapisan | Berkas |
|---|---|
| Relay & direktori | `server/app.ts` (auth, kontak, WebSocket, store-and-forward) |
| Penemuan aman (PIN Bayang/sekali pakai/Radar Arwah) | `server/discovery.ts` |
| Jejak E2EE (rute API tetap `/api/moments`) | `server/moments.ts` |
| Konfigurasi env (`KAMBE_*`, fallback `PINPATH_*`) | `server/env.ts` |
| Rekber, buku besar, sengketa | `server/commerce.ts` |
| Notaris kuitansi | `server/notary.ts`, `shared/receipt.ts` |
| Penyedia pembayaran | `server/payments.ts` |
| Kripto bersama | `shared/e2ee.ts`, `shared/sealed.ts` |
| Penyimpanan sealed object | `server/sealed.ts` |
| Mesin lokal klien | `client/src/lib/messenger.ts`, `client/src/lib/keystore.ts` |
| Brankas & frasa kunci | `shared/vault.ts`, `client/src/lib/device.ts`, `client/src/ui/Vault.tsx` |

## 6. Label protokol yang dibekukan

Rebrand PINPath → KAMBE hanya mengganti nama yang terlihat pengguna. Nama fitur juga berganti
(Moments → **Jejak**, Shadow PIN → **PIN Bayang**, Radar → **Radar Arwah**), tetapi nama rute API, identifier
kode, skema DB, dan berkas `data/pinpath.db` instalasi lama **tidak** diganti.

Label di bawah ini ikut masuk ke penurunan kunci (HKDF), AAD enkripsi, isi yang ditandatangani, atau nama
penyimpanan. Mengubah satu saja berarti kunci & safety number berubah, pesan dan sealed object lama tidak bisa
dibuka, kuitansi lama gagal diverifikasi, dan cadangan lama tidak bisa dipulihkan. Karena itu dibekukan dan
dijaga oleh `tests/kambe-compat.test.ts` (memakai data contoh era PINPath di `tests/fixtures/pre-kambe.json`).

| Label | Lokasi | Dipakai untuk |
|---|---|---|
| `PROTOCOL = "pinpath/v1"` | `shared/e2ee.ts` | Label HKDF/AAD pesan, sealed object, kunci brankas |
| `BACKUP_FORMAT = "pinpath-backup"` | `shared/vault.ts` | Penanda format & AAD file cadangan (`.kambe` maupun `.pinpath`) |
| `RECEIPT_KIND = "pinpath.deal-receipt"` | `shared/receipt.ts` | Isi kuitansi yang ditandatangani notaris |
| `hashSecret("pinpath-dummy-secret")` | `server/security.ts` | Hash tiruan anti timing-attack saat alias tidak ada |
| IndexedDB `"pinpath"` | `client/src/lib/keystore.ts` | Database lokal perangkat; mengganti = riwayat & brankas lama tidak terlihat |

Env juga kompatibel ke belakang: server membaca `KAMBE_<NAMA>` lebih dulu, lalu `PINPATH_<NAMA>`
(`server/env.ts`). Tanpa `KAMBE_DB`, server memakai `data/pinpath.db` bila sudah ada, selain itu `data/kambe.db`.
