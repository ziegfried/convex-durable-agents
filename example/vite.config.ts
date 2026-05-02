import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig({
  envDir: "../",
  plugins: [react()],
  resolve: {
    conditions: ["@convex-dev/component-source"],
    alias: {
      "@vercel/oidc": fileURLToPath(
        new URL("./src/shims/vercel-oidc.ts", import.meta.url),
      ),
    },
  },
});
