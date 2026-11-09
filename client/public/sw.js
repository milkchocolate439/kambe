// Service worker KAMBE: hanya menyimpan cangkang aplikasi (HTML/JS/CSS/ikon)
// supaya bisa di-install & cepat dibuka. API dan WebSocket TIDAK pernah di-cache —
// data percakapan tidak boleh tertinggal di cache browser.
const CACHE = "kambe-shell-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", "/icon.svg", "/manifest.webmanifest"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  if (event.request.mode === "navigate") {
    // Jaringan dulu supaya update keamanan langsung sampai; cache hanya cadangan offline.
    event.respondWith(fetch(event.request).catch(() => caches.match("/")));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ??
          fetch(event.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(event.request, copy));
            }
            return res;
          }),
      ),
    );
  }
});

// Web Push: "SSSSSTTT!! Pesan baru dari …" (tanpa isi pesan — isi tetap end-to-end terenkripsi).
const SST_VIBRATE = [40, 25, 40, 25, 40, 25, 220];
self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = {};
  }
  event.waitUntil(
    self.registration.showNotification(String(d.title || "SSSSSTTT!!").slice(0, 60), {
      body: String(d.body || "Pesan baru").slice(0, 120),
      tag: String(d.tag || "kambe"),
      renotify: true,
      icon: "/icon.svg",
      badge: "/icon.svg",
      vibrate: SST_VIBRATE,
      data: { url: "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const w = wins.find((x) => "focus" in x);
      return w ? w.focus() : self.clients.openWindow("/");
    }),
  );
});
