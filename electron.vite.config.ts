import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  main: {
    build: {
      outDir: resolve(projectRoot, "out/main"),
      rollupOptions: {
        external: ["electron", "node:sqlite"],
        input: resolve(projectRoot, "src/main/index.ts"),
        output: {
          entryFileNames: "index.cjs",
          format: "cjs",
        },
      },
    },
  },
  preload: {
    build: {
      outDir: resolve(projectRoot, "out/preload"),
      rollupOptions: {
        external: ["electron"],
        input: resolve(projectRoot, "src/preload/index.ts"),
        output: {
          entryFileNames: "index.cjs",
          format: "cjs",
        },
      },
    },
  },
  renderer: {
    root: resolve(projectRoot, "src/renderer"),
    plugins: [react()],
    resolve: {
      alias: {
        "@": resolve(projectRoot, "src"),
      },
    },
    build: {
      emptyOutDir: true,
      outDir: resolve(projectRoot, "out/renderer"),
      rollupOptions: {
        input: resolve(projectRoot, "src/renderer/index.html"),
      },
    },
  },
});
