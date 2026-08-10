import { defineConfig } from "vite";

/**
 * Production bundles must run inside the stock Car Thing webview:
 * QtWebEngine 5.12.7 ≈ Chromium 69. `target: "chrome69"` makes esbuild
 * transpile syntax (optional chaining, nullish coalescing, etc.) that
 * engine lacks. Keep CSS conservative by hand: no flex `gap`,
 * no `aspect-ratio`, no `:is()`.
 */
export default defineConfig({
  base: "./",
  build: {
    target: "chrome69",
    outDir: "dist",
    assetsInlineLimit: 8192,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
