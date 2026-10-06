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
