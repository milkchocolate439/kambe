import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Saat `pnpm dev`, Vite (5173) meneruskan /api dan /ws ke server Node (3300).
export default defineConfig({
  root: "client",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3300",
      "/ws": { target: "ws://127.0.0.1:3300", ws: true },
    },
  },
});
