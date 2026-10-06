import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** The Hearloom server the dev console talks to (auth, RPC, media, realtime). */
const target = process.env.HEARLOOM_SERVER_URL ?? "http://localhost:3000";
/** `pnpm dev:host` sets 127.0.0.1, where `tailscale serve` forwards the tailnet's HTTPS traffic. */
const host = process.env.HEARLOOM_WEB_HOST;

/** Signing in over the tailnet needs that origin trusted by the server; say so at startup. */
const remoteHint: Plugin = {
  name: "hearloom-remote-hint",
  configureServer(server) {
    if (!host) return;
    server.httpServer?.once("listening", () => {
      server.config.logger.info(
        "\n  Signing in over the tailnet? Add its https origin to TRUSTED_ORIGINS in .env and\n" +
          "  restart, e.g. TRUSTED_ORIGINS=http://localhost:5173,https://<machine>.<tailnet>.ts.net:5173\n",
      );
    });
  },
};

export default defineConfig({
  plugins: [
    // Must run before the React plugin so generated route code gets transformed.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    remoteHint,
  ],
  server: {
    port: 5173,
    // TRUSTED_ORIGINS and `tailscale serve` both expect 5173; fail rather than drift to 5174.
    strictPort: true,
    // IPv4 loopback, not Vite's default localhost (::1 only on macOS), so `tailscale serve` reaches it.
    host: host ?? "127.0.0.1",
    // Tailscale MagicDNS names, as forwarded by `tailscale serve` (localhost is always allowed).
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
