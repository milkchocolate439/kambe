# KAMBE untuk Android (APK / Play Store)

KAMBE dibungkus sebagai **TWA (Trusted Web Activity)**: aplikasi Android sungguhan yang menjalankan KAMBE
lewat mesin Chrome. Keuntungannya dibanding PWA biasa:

- ikon & nama di laci aplikasi, tanpa bilah alamat, bisa terbit di Play Store;
- **notifikasi "SSSSSTTT!!" tetap masuk walau aplikasi ditutup** (Web Push dikirim server saat penerima offline);
- notifikasi diposkan atas nama aplikasi KAMBE → bisa memakai **channel Android dengan bunyi kustom** (`sssttt.wav`).

Isi folder ini:

| Berkas | Kegunaan |
|---|---|
| `twa-manifest.json` | Konfigurasi Bubblewrap (paket `app.kambe.twa`). Ganti `GANTI-DENGAN-HOST-KAMBE` dengan host KAMBE (mis. `kambe-xxx.koyeb.app`) |
| `sssttt.wav` | Bunyi notifikasi khas, dibuat ulang dengan `node --import tsx scripts/make-android-assets.ts` |

## Syarat

1. KAMBE sudah online di **HTTPS dengan host tetap** (Koyeb / domain sendiri). Alamat trycloudflare berganti-ganti → tidak cocok.
2. Android SDK + JDK — Bubblewrap menawarkan memasangnya otomatis saat `init` pertama kali.

## Langkah build

```bash
cd android
npx @bubblewrap/cli init --manifest https://HOST-KAMBE/manifest.webmanifest   # jawab "Y" untuk memasang JDK/SDK
npx @bubblewrap/cli build                                                      # menghasilkan app-release-signed.apk
```

Lalu ambil sidik sertifikat penandatangan dan pasang di server agar Android mempercayai domainnya:

```bash
keytool -list -v -keystore kambe-upload.keystore -alias kambe | grep SHA256
# di Koyeb (Environment variables):
#   KAMBE_ANDROID_PACKAGE=app.kambe.twa
#   KAMBE_ANDROID_CERT_SHA256=AA:BB:...   (kalau terbit di Play Store, tambahkan juga sidik "App signing key" dari Play Console, dipisah koma)
```

Server lalu menyajikan `https://HOST-KAMBE/.well-known/assetlinks.json` (diuji di `tests/push.test.ts`).
Tanpa ini, APK tetap jalan tetapi menampilkan bilah alamat kecil di atas.

## Bunyi "SSSSSTTT!!" pada notifikasi saat aplikasi tertutup

Proyek hasil Bubblewrap ada di folder ini setelah `init`. Untuk bunyi kustom:

1. Salin `sssttt.wav` ke `app/src/main/res/raw/sssttt.wav`.
2. Di `LauncherActivity` (atau `Application`) buat channel notifikasi dengan bunyi itu sebelum notifikasi pertama
   (Android 8+: bunyi melekat pada channel dan tidak bisa diubah setelah channel dibuat):

```java
NotificationChannel ch = new NotificationChannel("kambe_sssttt", "Pesan KAMBE", NotificationManager.IMPORTANCE_HIGH);
ch.setSound(Uri.parse("android.resource://" + getPackageName() + "/" + R.raw.sssttt),
    new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build());
ch.setVibrationPattern(new long[] {0, 40, 25, 40, 25, 40, 25, 220});
getSystemService(NotificationManager.class).createNotificationChannel(ch);
```

Catatan jujur: notifikasi TWA diposkan lewat layanan delegasi `android-browser-helper`, yang membuat channel-nya sendiri
berdasarkan nama situs. Pastikan channel yang dipakai layanan itu memakai bunyi di atas (uji di HP sungguhan) — bagian ini
belum bisa diuji di PC ini karena Android SDK belum terpasang.

## Yang TIDAK bisa dijanjikan

- Android bisa mematikan aplikasi apa pun di latar belakang (penghemat baterai). Web Push lewat Google tetap sampai,
  tetapi pengguna sebaiknya mengecualikan KAMBE dari optimasi baterai di HP yang agresif (Xiaomi, Oppo, Vivo).
- iPhone: tidak ada TWA. Pasang KAMBE ke layar utama (Safari → Bagikan → Tambahkan ke Layar Utama) agar Web Push aktif (iOS 16.4+).
