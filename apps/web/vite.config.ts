import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** The Hearloom server the dev console talks to (auth, RPC, media, realtime). */
const target = process.env.HEARLOOM_SERVER_URL ?? "http://localhost:3000";
/** `pnpm dev:host` sets 0.0.0.0 so other devices (Tailscale, LAN) can open the dev console. */
const host = process.env.HEARLOOM_WEB_HOST;

/** Signing in from another host needs its origin trusted by the server; say so at startup. */
const remoteHint: Plugin = {
  name: "hearloom-remote-hint",
  configureServer(server) {
    if (!host) return;
    server.httpServer?.once("listening", () => {
      server.config.logger.info(
        "\n  Opening the console from another device? Add its origin to TRUSTED_ORIGINS in .env and\n" +
          "  restart, e.g. TRUSTED_ORIGINS=http://localhost:5173,http://<machine>.<tailnet>.ts.net:5173\n",
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
    host,
    // Tailscale MagicDNS and Bonjour names (IP addresses and localhost are always allowed).
    allowedHosts: [".ts.net", ".local"],
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
