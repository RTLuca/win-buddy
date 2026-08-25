import { defineConfig } from "vite";
import { resolve } from "node:path";

// Tre superfici, tre pagine (§ 5.1). Il core Tauri le crea e le distrugge
// secondo il ciclo di vita: qui si buildano soltanto.
export default defineConfig({
  root: "ui",
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        overlay: resolve(__dirname, "ui/overlay/index.html"),
        panel: resolve(__dirname, "ui/panel/index.html"),
        capture: resolve(__dirname, "ui/capture/index.html"),
      },
    },
  },
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
  },
});
