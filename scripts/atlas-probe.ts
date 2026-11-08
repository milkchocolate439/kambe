// Cek kesiapan MongoDB Atlas untuk snapshot KAMBE.
// Pakai: node --import tsx scripts/atlas-probe.ts "<uri>"
//  - tanpa sandi yang benar: membedakan "jaringan/IP ditolak" vs "jaringan OK, sandi salah"
//  - dengan URI lengkap: uji simpan → muat → isi terenkripsi (koleksi GridFS "snapshots", nama uji terpisah)
import { MongoClient } from "mongodb";
import { mongoSnapshotStore, openSnapshot, sealSnapshot, snapshotKey } from "../server/snapshot.ts";

const uri = process.argv[2];
if (!uri) {
  console.error('Pakai: node --import tsx scripts/atlas-probe.ts "<uri>"');
  process.exit(2);
}

async function main() {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
  try {
    await client.connect();
    await client.db("kambe").command({ ping: 1 });
    console.log("✔ terhubung & terautentikasi ke Atlas");
  } catch (e) {
    const msg = (e as Error).message;
    if (/auth|Authentication failed|bad auth/i.test(msg)) console.log("◐ jaringan & IP DIIZINKAN, tapi user/sandi ditolak →", msg);
    else if (/Server selection timed out|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|closed/i.test(msg)) console.log("✖ jaringan/IP DITOLAK atau host salah →", msg.slice(0, 200));
    else console.log("✖ galat lain →", msg.slice(0, 200));
    await client.close().catch(() => {});
    process.exit(1);
  }
  await client.close();

  // Uji snapshot sungguhan (nama terpisah agar tidak mengganggu data asli).
  const key = snapshotKey("uji-atlas-probe-kunci-yang-panjang-sekali-123");
  const store = await mongoSnapshotStore(uri, "kambe", "probe-uji");
  const raw = Buffer.from(`isi uji KAMBE ${Date.now()}`);
  await store.save(sealSnapshot(key, raw), { sha256: "uji", size: raw.length, at: Date.now() });
  const back = await store.load();
  console.log(back && openSnapshot(key, back).equals(raw) ? "✔ simpan → muat → buka enkripsi: utuh" : "✖ data uji tidak kembali utuh");
  console.log(back && !back.includes(Buffer.from("isi uji KAMBE")) ? "✔ yang tersimpan di Atlas terenkripsi" : "✖ teks polos terlihat");
  await store.close?.();
}

main().catch((e) => {
  console.error("✖ terhenti:", (e as Error).message);
  process.exit(1);
});
