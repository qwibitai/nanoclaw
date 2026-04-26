import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Default: served at the server's root (paraclaw runs standalone on a
  // dedicated port — UI at `/`, API at `/api/*`). Override via
  // `VITE_BASE_PATH=/claw/ pnpm build` when serving under the Parachute hub
  // at `https://<host>/claw/` (matches the parachute-notes mount pattern).
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.PARACLAW_WEB_SERVER_URL ?? "http://127.0.0.1:4944",
        changeOrigin: true,
      },
    },
  },
});
