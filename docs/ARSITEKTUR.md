# Arsitektur PINPath — Local-First + Relay Ringan + Notaris Pembayaran

Dokumen ini meluruskan struktur PINPath terhadap konsep **"Local Server User & Monetisasi Developer
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

## 2. Pemetaan konsep → PINPath

| Konsep dokumen | Keputusan | Implementasi di PINPath |
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
| PIN dinamis (TOTP per N detik) | **Disesuaikan** | TOTP butuh rahasia bersama, sehingga orang asing tak bisa menemukanmu. Penggantinya: **PIN sekali pakai** (hangus setelah 1 undangan), **Shadow PIN 24 jam**, **PIN radar**, dan **rotasi PIN utama otomatis**. Kontak hanya melihat PIN yang mereka pakai → PIN berbeda tidak bisa dikaitkan oleh sesama pengguna. |
| Stealth address / one-time payment code | **Disesuaikan** | Setiap kesepakatan memakai **kode referensi bayar sekali pakai** yang tidak memuat identitas; kuitansi hanya berisi alias saat transaksi. |
| Fee 5% (dokumen) | **Diadopsi (keputusan pemilik)** | Default **5%** (`FEE_PER_MILLE = 50`); tetap bisa diubah dengan `PINPATH_FEE_PER_MILLE` (25 = 2,5%, 50 = 5%, maks. 200). Fee tersimpan di setiap kesepakatan saat dibuat, jadi perubahan tarif tidak mengubah kesepakatan lama. |

## 3. Apa yang diketahui server (setelah penyelarasan)

| Data | Disimpan server? |
|---|---|
| Isi pesan, momen, identitas pengiriman | Tidak pernah (E2EE) |
| Ciphertext pesan | Hanya sampai terkirim (maks. 30 hari bila penerima tak pernah online) |
| Alias, PIN, kunci publik, kontak, blokir | Ya (direktori) |
| Kesepakatan, buku besar, bukti kirim, pernyataan sengketa | Ya (diperlukan untuk menegakkan aturan uang & moderasi) |
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
| Penemuan aman (Shadow/sekali pakai/radar) | `server/discovery.ts` |
| Momen E2EE | `server/moments.ts` |
| Rekber, buku besar, sengketa | `server/commerce.ts` |
| Notaris kuitansi | `server/notary.ts`, `shared/receipt.ts` |
| Penyedia pembayaran | `server/payments.ts` |
| Kripto bersama | `shared/e2ee.ts` |
| Mesin lokal klien | `client/src/lib/messenger.ts`, `client/src/lib/localstore.ts`, `client/src/lib/keystore.ts` |
