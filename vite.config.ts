import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  // Scan every entry up front, including the e2e fixture page and lazy
  // imports. A dependency first met mid-session makes Vite re-optimize and
  // reload the page, which aborted in-flight chunk loads (ERR_NETWORK_CHANGED)
  // and left e2e tests with an empty app.
  optimizeDeps: { entries: ["index.html", "tests/fixtures/*.html", "src/**/*.{ts,tsx}", "!src/**/*.test.{ts,tsx}"] },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
