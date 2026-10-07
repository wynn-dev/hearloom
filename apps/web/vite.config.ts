import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The Hearloom server the dev console talks to (auth, RPC, media, realtime). */
const target = process.env.HEARLOOM_SERVER_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [
    // Must run before the React plugin so generated route code gets transformed.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5173,
    // TRUSTED_ORIGINS expects 5173; fail rather than drift to 5174.
    strictPort: true,
    // IPv4 loopback, not Vite's default localhost (::1 only on macOS), so proxies forwarding to
    // 127.0.0.1 reach it.
    host: "127.0.0.1",
    // Tailscale MagicDNS names, for a tailnet proxy you set up yourself (localhost is always allowed).
    allowedHosts: [".ts.net"],
    proxy: {
      "/api": { target },
      "/rpc": { target },
      "/media": { target },
      "/realtime": { target, ws: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      "/api": { target },
      "/rpc": { target },
      "/media": { target },
      "/realtime": { target, ws: true },
    },
  },
  build: {
    target: "es2023",
    sourcemap: true,
  },
});
