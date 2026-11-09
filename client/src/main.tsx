import { StrictMode } from "react";
import { unlockAudio } from "./lib/sound.ts";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Service worker hanya di produksi (HTTPS / localhost) agar KAMBE bisa di-install sebagai app.
// Browser hanya mengizinkan suara setelah interaksi pertama pengguna.
for (const ev of ["pointerdown", "keydown"] as const) addEventListener(ev, unlockAudio, { once: true, passive: true });

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
