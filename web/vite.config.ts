import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// base = /<repo-name>/ so the same build works from GitHub Pages and from a bare preview server.
export default defineConfig({
  base: process.env.RIGPILOT_BASE ?? "/ultimate/",
  build: { target: "es2022", outDir: "dist", sourcemap: true, assetsInlineLimit: 0 },
  // core is consumed as TypeScript source: HMR into the motion logic while posing, and no
  // "rebuild core or the page runs stale code" failure mode during M1-M7.
  resolve: {
    alias: { "@rigpilot/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    // the sandbox/proxy front door is not "localhost", so don't reject Host/Origin headers
    allowedHosts: true,
  },
  preview: { host: "0.0.0.0", allowedHosts: true },
});
