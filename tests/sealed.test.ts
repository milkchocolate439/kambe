import { test } from "node:test";
import assert from "node:assert/strict";
import { fromB64, generateIdentity, toB64, type Identity } from "../shared/e2ee.ts";
import { addRecipients, cleanDisplayText, openSealed, seal, sealedHash, type SealedBlob, type SealedView } from "../shared/sealed.ts";

async function party(id: string) {
  const key = await generateIdentity();
  return { id, key, r: { id, publicKey: key.publicKey } };
}

/** Tampilan yang dikirim server ke satu penerima (hanya bungkus miliknya). */
function viewFor(blob: SealedBlob, ownerId: string, who: { r: { id: string } }): SealedView {
  return { id: blob.id, kind: blob.kind, ownerId, ownerKey: blob.ownerKey, nonce: blob.nonce, ciphertext: blob.ciphertext, wrap: blob.wraps.find((w) => w.to === who.r.id) ?? null };
}

test("sealed: pemilik & semua penerima bisa membuka, isi identik", async () => {
  const seller = await party("penjual");
  const buyer = await party("pembeli");
  const mod = await party("moderator");
  const content = { courier: "JNE", tracking: "JNE123456789", note: "dikemas kayu" };
  const blob = await seal(seller.key.privateKey, seller.r, "shipment", content, [buyer.r, mod.r]);
  assert.equal(blob.wraps.length, 3, "pemilik + 2 penerima");
  for (const p of [seller, buyer, mod]) assert.deepEqual(await openSealed(p.key.privateKey, p.key.publicKey, viewFor(blob, seller.id, p)), content);
  assert.ok(!blob.ciphertext.includes("JNE"), "ciphertext tidak memuat isi");
});

test("sealed: pihak ketiga tidak bisa membuka walau mencuri bungkus orang lain", async () => {
  const owner = await party("pemilik");
  const friend = await party("teman");
  const eve = await party("eve");
  const blob = await seal(owner.key.privateKey, owner.r, "pm", { text: "Lagi cari supplier rotan" }, [friend.r]);
  await assert.rejects(openSealed(eve.key.privateKey, eve.key.publicKey, viewFor(blob, owner.id, eve)), { code: "no_wrap" });
  const stolen = { ...viewFor(blob, owner.id, friend), wrap: { ...blob.wraps[1], toKey: eve.key.publicKey } };
  await assert.rejects(openSealed(eve.key.privateKey, eve.key.publicKey, stolen), { code: "unwrap_failed" });
});

test("sealed: server tidak bisa memalsukan objek atas nama pemilik", async () => {
  const owner = await party("penjual_asli");
  const buyer = await party("pembeli");
  const server = await party("server_jahat"); // punya kunci sendiri, tapi bukan kunci pemilik
  // Server membuat objek baru dengan ownerKey = kunci publik penjual (pemalsuan identitas).
  const forged = await seal(server.key.privateKey, { id: owner.id, publicKey: server.key.publicKey }, "statement", { text: "saya mengaku salah" }, [buyer.r]);
  const passedOff = { ...viewFor(forged, owner.id, buyer), ownerKey: owner.key.publicKey };
  await assert.rejects(openSealed(buyer.key.privateKey, buyer.key.publicKey, passedOff));
});

test("sealed: isi/bungkus tidak bisa dipindah ke objek, jenis, atau isi lain", async () => {
  const a = await party("a");
  const b = await party("b");
  const blob = await seal(a.key.privateKey, a.r, "deal", { title: "Rotan 1 ton" }, [b.r]);
  const v = viewFor(blob, a.id, b);
  await assert.rejects(openSealed(b.key.privateKey, b.key.publicKey, { ...v, id: crypto.randomUUID() }), { code: "unwrap_failed" });
  await assert.rejects(openSealed(b.key.privateKey, b.key.publicKey, { ...v, kind: "pm" }), { code: "unwrap_failed" });
  const ct = fromB64(v.ciphertext);
  ct[2] ^= 1;
  await assert.rejects(openSealed(b.key.privateKey, b.key.publicKey, { ...v, ciphertext: toB64(ct) }), { code: "decrypt_failed" });
  const other = await seal(a.key.privateKey, a.r, "deal", { title: "Kopi" }, [b.r]);
  await assert.rejects(openSealed(b.key.privateKey, b.key.publicKey, { ...v, nonce: other.nonce, ciphertext: other.ciphertext }), { code: "decrypt_failed" });
});

test("sealed: pemilik bisa menambah penerima baru tanpa mengubah isi", async () => {
  const owner = await party("pemilik");
  const later: Identity = await generateIdentity();
  const newbie = { id: "kontak_baru", key: later, r: { id: "kontak_baru", publicKey: later.publicKey } };
  const blob = await seal(owner.key.privateKey, owner.r, "product", { title: "Madu hutan 2L", price: 150_000 }, []);
  assert.equal(blob.wraps.length, 1, "awalnya hanya pemilik");
  const extra = await addRecipients(owner.key.privateKey, owner.r, viewFor(blob, owner.id, owner), [newbie.r]);
  const updated = { ...blob, wraps: [...blob.wraps, ...extra] };
  assert.deepEqual(await openSealed(newbie.key.privateKey, newbie.key.publicKey, viewFor(updated, owner.id, newbie)), { title: "Madu hutan 2L", price: 150_000 });
  assert.equal(await sealedHash(blob), await sealedHash(updated), "sidik isi tidak berubah saat menambah penerima");
});

test("cleanDisplayText membuang trik tampilan dari isi yang didekripsi", () => {
  assert.equal(cleanDisplayText("Ko​pi‮ G­ayo ＰＲＯ\u0007"), "Kopi Gayo PRO");
  assert.equal(cleanDisplayText(123), "");
  assert.equal(cleanDisplayText("x".repeat(50), 10), "xxxxxxxxxx");
});
