// PANIC WIPE — hapus semua jejak KAMBE di perangkat ini dalam satu gerakan.
//
// Urutan sengaja: server dulu (selagi cookie sesi masih ada), lalu semua penyimpanan lokal, lalu
// muat ulang halaman supaya isi yang sudah didekripsi di memori JavaScript ikut hilang.
// Setiap langkah berdiri sendiri: kegagalan satu langkah (mis. offline) tidak menghentikan langkah lain.
//
// Batas yang jujur: salinan pesan di HP lawan bicara dan ciphertext yang masih menunggu di relay tidak
// bisa ikut dihapus dari sini. Kalau offline, sesi server baru dicabut saat aplikasi dibuka lagi
// (brankas sudah kosong → aplikasi otomatis keluar).

import { api } from "./api.ts";
import { keystore } from "./keystore.ts";

export const WIPED_HASH = "#jejak-dihapus";
export const WIPED_SERVER_HASH = "#akun-dihapus";

export interface PanicReport {
  server: "logout" | "deleted" | "failed";
  local: string[];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

/**
 * Hapus semua data lokal. `deletePassphrase` diisi = hapus akun di server juga (alur hapus akun biasa;
 * ditolak server bila masih ada kesepakatan berjalan → jatuh ke keluar biasa).
 */
export async function panicWipe(deletePassphrase?: string): Promise<PanicReport> {
  const report: PanicReport = { server: "failed", local: [] };

  // 1) Server: hapus akun (bila diminta) atau cabut sesi. Maks. 3 detik — jangan menahan penghapusan lokal.
  if (deletePassphrase) {
    try {
      await withTimeout(api("POST", "/api/me/delete", { passphrase: deletePassphrase }), 3000);
      report.server = "deleted";
    } catch {
      /* lanjut ke keluar biasa */
    }
  }
  if (report.server !== "deleted") {
    try {
      await withTimeout(api("POST", "/api/auth/logout"), 3000);
      report.server = "logout";
    } catch {
      /* offline: sesi dicabut saat aplikasi dibuka lagi */
    }
  }

  // 2) IndexedDB (brankas, kunci, riwayat, pin, rahasia kecil, etalase hantu, buku jejak).
  try {
    await withTimeout(keystore.wipe(), 4000);
    report.local.push("indexeddb");
  } catch {
    /* lanjut */
  }

  // 3) Cache Storage (cangkang aplikasi dari service worker).
  try {
    if ("caches" in globalThis) {
      for (const k of await caches.keys()) await caches.delete(k);
      report.local.push("cache");
    }
  } catch {
    /* lanjut */
  }

  // 4) localStorage & sessionStorage.
  try {
    localStorage.clear();
    sessionStorage.clear();
    report.local.push("storage");
  } catch {
    /* penyimpanan diblokir */
  }

  // 5) Service worker.
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    for (const r of regs) await r.unregister();
    report.local.push("sw");
  } catch {
    /* lanjut */
  }

  return report;
}

/** Setelah wipe: muat ulang bersih (memori JS ikut terbuang) dengan penanda untuk layar masuk. */
export function reloadAfterWipe(report: PanicReport) {
  // Mengganti hash saja TIDAK memuat ulang dokumen; reload() memastikan memori JS (isi terdekripsi) terbuang.
  location.hash = report.server === "deleted" ? WIPED_SERVER_HASH : WIPED_HASH;
  location.reload();
}
