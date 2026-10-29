// Dijalankan SEKALI dari kode sebelum rebrand KAMBE untuk merekam vektor emas (tests/fixtures/pre-kambe.json).
// Jangan dijalankan ulang: tes kambe-compat membuktikan kode sekarang masih cocok dengan rekaman ini.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { safetyNumber, toB64 } from "../../shared/e2ee.ts";
import { seal } from "../../shared/sealed.ts";
import { encryptBackup, identityFromSeed, localKeysFromSeed } from "../../shared/vault.ts";

const seedA = new Uint8Array(32).fill(7);
const seedB = new Uint8Array(32).fill(9);
const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";

const a = await identityFromSeed(seedA);
const b = await identityFromSeed(seedB);
const ownerA = { id: userA, publicKey: a.publicKey };
const toB = { id: userB, publicKey: b.publicKey };

const fixture = {
  seedA: toB64(seedA),
  seedB: toB64(seedB),
  userA,
  userB,
  publicKeyA: a.publicKey,
  publicKeyB: b.publicKey,
  safetyNumberAB: await safetyNumber(ownerA, toB),
  backup: await encryptBackup((await localKeysFromSeed(seedA, userA)).backup, userA, { hello: "kambe" }, 1730000000000),
  sealed: await seal(a.privateKey, ownerA, "note", { teks: "pesan dari era PINPath" }, [toB], "33333333-3333-4333-8333-333333333333"),
};

writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "pre-kambe.json"), JSON.stringify(fixture, null, 2) + "\n");
console.log("pre-kambe.json ditulis");
