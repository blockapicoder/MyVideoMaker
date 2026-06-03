import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0"
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
