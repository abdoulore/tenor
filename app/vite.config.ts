import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  root,
  server: {
    // The engine and the sampler live above the app root and are imported directly, so the
    // dev server has to be allowed to read them.
    fs: { allow: [repo] },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
