// Siklus brankas perangkat: buka (passphrase), buat baru, pulihkan dari frasa kunci, kunci saat keluar.
// Seed mentah hanya ada di memori sesaat di sini, lalu dihapus (fill(0)).

import type { Me } from "../../../shared/protocol.ts";
import {
  decodeSeed,
  encodeSeed,
  generateSeed,
  identityFromSeed,
  localKeysFromSeed,
  unwrapSeed,
  wrapSeed,
} from "../../../shared/vault.ts";
import { keystore, type UnlockedDevice } from "./keystore.ts";

const LEGACY_SHIPPING = (me: string) => `pinpath:identity:${me}`; // dulu: alamat polos di localStorage; kunci lama, jangan diganti (lihat spec KAMBE)

export type DeviceOpen =
  | { t: "ready"; device: UnlockedDevice; justSetUp: boolean }
  /** Ada sesi, tapi kunci terkunci & tidak ada passphrase → minta masuk lagi. */
  | { t: "locked" }
  /** Perlu keputusan pengguna: perangkat baru / passphrase berubah / akun lama tanpa frasa kunci. */
  | { t: "setup"; reason: "new_device" | "passphrase_changed" | "legacy" };

/** Buka kunci yang sudah terbuka, atau brankas dengan passphrase. */
export async function openDevice(me: Me, passphrase: string | null): Promise<DeviceOpen> {
  const unlocked = await keystore.getUnlocked(me.id);
  if (unlocked) {
    keystore.use(me.id, unlocked);
    return { t: "ready", device: unlocked, justSetUp: false };
  }
  if (passphrase === null) return { t: "locked" };
  const vault = await keystore.getVault(me.id);
  if (!vault) return { t: "setup", reason: (await keystore.getLegacyIdentity(me.id)) ? "legacy" : "new_device" };
  try {
    const seed = await unwrapSeed(vault, passphrase, me.id);
    return { t: "ready", device: await finish(me, seed, null), justSetUp: false };
  } catch (e) {
    if ((e as { code?: string }).code === "bad_passphrase") return { t: "setup", reason: "passphrase_changed" };
    throw e;
  }
}

/** Seed → kunci terbuka. `passphrase` diberikan bila brankas perlu (di)bungkus ulang. */
async function finish(me: Me, seed: Uint8Array<ArrayBuffer>, passphrase: string | null): Promise<UnlockedDevice> {
  try {
    const identity = await identityFromSeed(seed);
    const keys = await localKeysFromSeed(seed, me.id);
    if (passphrase !== null) await keystore.putVault(me.id, await wrapSeed(seed, passphrase, me.id));
    const device: UnlockedDevice = { ...identity, ...keys };
    await keystore.putUnlocked(me.id, device);
    keystore.use(me.id, keys);
    await migrate(me.id);
    return device;
  } finally {
    seed.fill(0);
  }
}

/** Data polos dari sebelum Tahap 2 → terenkripsi; kunci acak lama dibuang. */
async function migrate(userId: string) {
  await keystore.migrateLegacy(userId);
  try {
    const raw = localStorage.getItem(LEGACY_SHIPPING(userId));
    if (raw) {
      await keystore.putSecret(userId, "shipping", JSON.parse(raw));
      localStorage.removeItem(LEGACY_SHIPPING(userId));
    }
  } catch {
    /* localStorage diblokir / isi rusak — abaikan */
  }
  await keystore.deleteLegacyIdentity(userId);
}

/** Frasa kunci baru untuk perangkat ini. Mengembalikan frasa untuk ditampilkan SEKALI. */
export async function createFresh(me: Me, passphrase: string): Promise<{ device: UnlockedDevice; seedCode: string }> {
  const seed = generateSeed();
  const seedCode = await encodeSeed(seed);
  return { device: await finish(me, seed, passphrase), seedCode };
}

/** Pulihkan identitas dari frasa kunci (kunci publik sama dengan perangkat lama). */
export async function restoreFromCode(me: Me, passphrase: string, code: string): Promise<UnlockedDevice> {
  return finish(me, await decodeSeed(code), passphrase);
}

/** Passphrase akun berubah (mis. lewat pemulihan akun): buka brankas dengan passphrase lama, bungkus ulang. */
export async function rewrapWithOld(me: Me, oldPassphrase: string, newPassphrase: string): Promise<UnlockedDevice> {
  const vault = await keystore.getVault(me.id);
  if (!vault) throw new Error("Tidak ada brankas di perangkat ini");
  return finish(me, await unwrapSeed(vault, oldPassphrase, me.id), newPassphrase);
}

/** Tampilkan frasa kunci lagi — wajib passphrase (seed tidak pernah disimpan polos). */
export async function revealSeed(me: Me, passphrase: string): Promise<string> {
  const vault = await keystore.getVault(me.id);
  if (!vault) throw new Error("Tidak ada brankas di perangkat ini");
  const seed = await unwrapSeed(vault, passphrase, me.id);
  try {
    return await encodeSeed(seed);
  } finally {
    seed.fill(0);
  }
}

/** Kunci cadangan dari frasa kunci LAIN (mis. cadangan dari sebelum "mulai baru"). */
export async function backupKeyFromCode(me: Me, code: string): Promise<CryptoKey> {
  const seed = await decodeSeed(code);
  try {
    return (await localKeysFromSeed(seed, me.id)).backup;
  } finally {
    seed.fill(0);
  }
}

export const lockDevice = (userId: string) => keystore.lock(userId);
