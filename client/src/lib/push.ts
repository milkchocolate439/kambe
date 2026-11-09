// Web Push di perangkat: izin notifikasi → langganan PushManager → didaftarkan ke server.
// Popup tetap muncul walau KAMBE tertutup (Android/desktop; iPhone setelah dipasang ke layar utama).

import { api } from "./api.ts";

export type PushState = "unsupported" | "denied" | "off" | "on";

const b64urlToBytes = (s: string) => {
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob(b);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function pushState(): Promise<PushState> {
  const reg = await registration();
  if (!reg) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "off";
  return (await reg.pushManager.getSubscription()) ? "on" : "off";
}

async function register(sub: PushSubscription) {
  const j = sub.toJSON();
  await api("POST", "/api/push/subscribe", { endpoint: j.endpoint, keys: j.keys });
}

/** Minta izin (harus dari ketukan pengguna) lalu berlangganan. */
export async function enablePush(): Promise<PushState> {
  const reg = await registration();
  if (!reg) return "unsupported";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "denied" : "off";
  const { publicKey } = await api<{ publicKey: string }>("GET", "/api/push/key");
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) }));
  await register(sub);
  return "on";
}

/** Hentikan notifikasi di perangkat ini (juga dipanggil saat keluar & Panic Wipe). */
export async function disablePush(): Promise<void> {
  const reg = await registration().catch(() => null);
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  if (!sub) return;
  await api("DELETE", "/api/push/subscribe", { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

/** Saat aplikasi dibuka: daftarkan ulang langganan yang sudah ada (mis. setelah server pindah). */
export async function resyncPush(): Promise<void> {
  const reg = await registration().catch(() => null);
  if (!reg || Notification.permission !== "granted") return;
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  if (sub) await register(sub).catch(() => {});
}
