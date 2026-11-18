import type { HumanoidRig } from "./types.js";

/** The rig as authored by `tools/gen-rig.py`. Import it through this module, never deep-path the JSON. */
import rigJson from "./humanoid.rig.json" with { type: "json" };
import { validateRig } from "./validateRig.js";

let cached: HumanoidRig | undefined;

/**
 * Returns the validated canonical rig. Throws with every issue at once: a broken rig file is a build
 * problem, not a runtime state, so failing loudly at load beats a half-posed viewer.
 */
export function loadHumanoidRig(): HumanoidRig {
  if (cached) return cached;
  const rig = rigJson as unknown as HumanoidRig;
  const issues = validateRig(rig);
  if (issues.length > 0) {
    throw new Error(`humanoid.rig.json is invalid:\n  ${issues.join("\n  ")}`);
  }
  cached = rig;
  return rig;
}

/** Non-throwing variant for MCP tools that should report rather than die. */
export function humanoidRigIssues(): string[] {
  return validateRig(rigJson as unknown as HumanoidRig);
}
