// tsc does not emit .json, and both the web app (bundler resolution) and the relay (node fs)
// need the rig file next to the compiled JS. Cross-platform copy, no extra dependency.
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "rig");
const dst = join(src, "..", "..", "dist", "rig");
await mkdir(dst, { recursive: true });
await cp(join(src, "humanoid.rig.json"), join(dst, "humanoid.rig.json"));
console.log("copied humanoid.rig.json -> dist/rig/");
