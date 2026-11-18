import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // node, not jsdom: ProjectStore touches no DOM on purpose, so the studio's state machine is testable
  // without a browser and without a fake one. The DOM classes (Timeline, panels) are checked in the page.
  test: { include: ["test/**/*.test.ts"], environment: "node" },
  resolve: {
    alias: { "@rigpilot/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) },
  },
});
