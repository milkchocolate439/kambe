// Notaris kuitansi: memegang kunci privat Ed25519 developer — HANYA di server, tidak pernah di ponsel.
// Kunci dimuat dari KAMBE_NOTARY_KEY (nama lama PINPATH_NOTARY_KEY masih diterima; PKCS8 base64) atau berkas data/notary.key (dibuat sekali, izin 0600).

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Notary {
  /** Kunci publik raw 32 byte (base64) — disematkan/di-pin oleh aplikasi. */
  publicKey: string;
  signBody(body: string): string;
}

export function createNotary(privateKey?: KeyObject): Notary {
  const priv = privateKey ?? generateKeyPairSync("ed25519").privateKey;
  if (priv.asymmetricKeyType !== "ed25519") throw new Error("Kunci notaris harus Ed25519");
  const jwk = createPublicKey(priv).export({ format: "jwk" }) as { x: string };
  const publicKey = Buffer.from(jwk.x, "base64url").toString("base64");
  return {
    publicKey,
    signBody: (body) => sign(null, Buffer.from(body, "utf8"), priv).toString("base64"),
  };
}

/** Muat kunci notaris permanen; buat baru di `path` bila belum ada. */
export function loadNotaryKey(envValue: string | undefined, path: string): KeyObject {
  if (envValue) return createPrivateKey({ key: Buffer.from(envValue, "base64"), format: "der", type: "pkcs8" });
  if (existsSync(path)) return createPrivateKey(readFileSync(path));
  mkdirSync(dirname(path), { recursive: true });
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(path, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  chmodSync(path, 0o600);
  return privateKey;
}
