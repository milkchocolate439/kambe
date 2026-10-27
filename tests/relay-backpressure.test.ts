import { test } from "node:test";
import assert from "node:assert/strict";
import { RELAY_BUFFER_LIMIT, relaySend, type RelaySocket } from "../server/security.ts";

/** Soket palsu: mencatat apa yang dikirim & apakah diputus. */
function fakeSocket(over: Partial<Pick<RelaySocket, "readyState" | "bufferedAmount">> = {}) {
  const sent: string[] = [];
  let terminated = 0;
  const ws: RelaySocket = {
    readyState: 1,
    bufferedAmount: 0,
    ...over,
    send: (d) => void sent.push(d),
    terminate: () => void terminated++,
  };
  return { ws, sent, terminated: () => terminated };
}

test("relay: penerima normal menerima pesan", () => {
  const s = fakeSocket({ bufferedAmount: 1024 });
  assert.equal(relaySend(s.ws, "pesan-1"), "sent");
  assert.deepEqual(s.sent, ["pesan-1"]);
  assert.equal(s.terminated(), 0);
});

test("relay: tepat di ambang masih dikirim (batas dilanggar hanya bila melewati)", () => {
  const s = fakeSocket({ bufferedAmount: RELAY_BUFFER_LIMIT });
  assert.equal(relaySend(s.ws, "pas"), "sent");
});

test("relay: penerima lambat (antrean > 1 MB) diputus dan pesan TIDAK menumpuk di memori", () => {
  const s = fakeSocket({ bufferedAmount: RELAY_BUFFER_LIMIT + 1 });
  assert.equal(relaySend(s.ws, "pesan-besar"), "slow");
  assert.equal(s.terminated(), 1, "koneksi penerima lambat harus diputus");
  assert.deepEqual(s.sent, [], "tidak ada data tambahan yang ditumpuk ke antrean soket");
});

test("relay: soket yang sudah tidak terbuka dilewati tanpa error", () => {
  const s = fakeSocket({ readyState: 3 }); // CLOSED
  assert.equal(relaySend(s.ws, "x"), "closed");
  assert.deepEqual(s.sent, []);
  assert.equal(s.terminated(), 0);
});

test("relay: ambang bisa diatur (dipakai untuk uji dengan nilai kecil)", () => {
  const s = fakeSocket({ bufferedAmount: 10 });
  assert.equal(relaySend(s.ws, "x", 5), "slow");
  assert.equal(s.terminated(), 1);
});
