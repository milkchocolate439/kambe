// Env KAMBE_* dengan fallback nama lama PINPATH_*, dan path DB default yang tidak "menghilangkan" data instalasi lama.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnv, defaultDbPath, staticDirFor } from "../server/env.ts";

test("readEnv: KAMBE_* kosong (template compose) tidak menutupi PINPATH_*", () => {
  assert.equal(readEnv({ KAMBE_DB: "", PINPATH_DB: "/data/x.db" }, "DB"), "/data/x.db");
  assert.equal(readEnv({ KAMBE_DB: "" }, "DB"), undefined);
});

test("staticDirFor: produksi selalu menyajikan dist", () => {
  assert.equal(staticDirFor({ NODE_ENV: "production" }, "/app"), join("/app", "dist"));
});

test("staticDirFor: KAMBE_SERVE_DIST=1 hanya untuk NODE_ENV=test", () => {
  assert.equal(staticDirFor({ NODE_ENV: "test", KAMBE_SERVE_DIST: "1" }, "/app"), join("/app", "dist"));
  assert.throws(() => staticDirFor({ KAMBE_SERVE_DIST: "1" }, "/app"), /KAMBE_SERVE_DIST.*NODE_ENV=test/);
  assert.throws(() => staticDirFor({ NODE_ENV: "development", PINPATH_SERVE_DIST: "1" }, "/app"), /KAMBE_SERVE_DIST/);
});

test("staticDirFor: dev tanpa saklar tidak menyajikan dist", () => {
  assert.equal(staticDirFor({}, "/app"), undefined);
});

test("readEnv: nama lama PINPATH_* masih diterima", () => {
  assert.equal(readEnv({ PINPATH_DB: "a" }, "DB"), "a");
});

test("readEnv: KAMBE_* menang atas PINPATH_*", () => {
  assert.equal(readEnv({ KAMBE_DB: "b", PINPATH_DB: "a" }, "DB"), "b");
});

test("readEnv: tidak diatur -> undefined", () => {
  assert.equal(readEnv({}, "DB"), undefined);
});

test("defaultDbPath: instalasi baru -> kambe.db", () => {
  const dir = mkdtempSync(join(tmpdir(), "kambe-env-"));
  assert.equal(defaultDbPath(dir), join(dir, "kambe.db"));
});

test("defaultDbPath: pinpath.db lama yang sudah ada tetap dipakai", () => {
  const dir = mkdtempSync(join(tmpdir(), "kambe-env-"));
  writeFileSync(join(dir, "pinpath.db"), "");
  assert.equal(defaultDbPath(dir), join(dir, "pinpath.db"));
});
