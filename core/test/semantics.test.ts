import { describe, expect, it } from "vitest";
import { loadHumanoidRig } from "../src/rig/index.js";
import { solve } from "../src/kinematics/fk.js";

/**
 * VISION §6: these ten expectations DEFINE the sign conventions. They are the contract between the rig
 * data and every consumer (viewer, IK, exporters, the MCP `set_key_pose` clamp), so they are written
 * against world positions the way an animator would check them by eye — not against internal numbers.
 * `tools/check-rig.py` runs the same ten against the generated JSON in python, so the data cannot pass
 * one and fail the other.
 */
const rig = loadHumanoidRig();
const at = (frame: Record<string, Record<string, number>>, joint: string) =>
  solve(rig, { joints: frame }).joints[joint]!.position;
const rest = solve(rig, {});

describe("VISION §6 required semantic behaviour", () => {
  it("hip_L flex +90 puts the knee forward and up at hip height", () => {
    const p = at({ hip_L: { flex: 90 } }, "knee_L");
    expect(p[2] - rest.joints["knee_L"]!.position[2]).toBeGreaterThan(0.3);
    expect(Math.abs(p[1] - rest.joints["hip_L"]!.position[1])).toBeLessThan(0.001);
  });

  it("knee_L flex +90 swings the ankle backward", () => {
    const p = at({ knee_L: { flex: 90 } }, "ankle_L");
    expect(p[2] - rest.joints["ankle_L"]!.position[2]).toBeLessThan(-0.3);
  });

  it.each(["L", "R"])("shoulder_%s side -90 hangs the arm straight down", s => {
    const p = at({ [`shoulder_${s}`]: { side: -90 } }, `elbow_${s}`);
    const sh = at({ [`shoulder_${s}`]: { side: -90 } }, `shoulder_${s}`);
    expect(p[1] - sh[1]).toBeCloseTo(-0.34, 6);
    expect(p[2] - sh[2]).toBeCloseTo(0, 6);
  });

  it("shoulder_L flex +90 swings the elbow forward in the transverse plane", () => {
    const p = at({ shoulder_L: { flex: 90 } }, "elbow_L");
    expect(p[2] - rest.joints["elbow_L"]!.position[2]).toBeGreaterThan(0.3);
    expect(p[1]).toBeCloseTo(rest.joints["elbow_L"]!.position[1], 6); // a transverse swing stays level
  });

  it("elbow_L flex +90 brings the wrist forward of the elbow", () => {
    const p = at({ elbow_L: { flex: 90 } }, "wrist_L");
    const e = at({ elbow_L: { flex: 90 } }, "elbow_L");
    expect(p[2] - e[2]).toBeGreaterThan(0.2);
  });

  it("spine flex +20 moves the neck forward", () => {
    const p = at({ spine: { flex: 20 } }, "neck");
    expect(p[2] - rest.joints["neck"]!.position[2]).toBeGreaterThan(0.03);
  });

  it("ankle_L flex +15 raises the toe", () => {
    const p = at({ ankle_L: { flex: 15 } }, "toe_L");
    expect(p[1] - rest.joints["toe_L"]!.position[1]).toBeGreaterThan(0.01);
  });

  it("knee_L flex -20 is refused and reported, never applied", () => {
    const r = solve(rig, { joints: { knee_L: { flex: -20 } } });
    expect(r.joints["ankle_L"]!.position).toEqual(rest.joints["ankle_L"]!.position);
    expect(r.adjustments).toHaveLength(1);
    expect(r.adjustments[0]).toMatchObject({
      joint: "knee_L",
      axis: "flex",
      requested: -20,
      applied: 0,
    });
    expect(r.adjustments[0]!.reason).toMatch(/hinge/);
  });

  it("mirroring a left-side pose gives X negated and Y/Z identical", () => {
    const left: Record<string, Record<string, number>> = {
      shoulder_L: { flex: 40, side: 20, twist: -30 },
      elbow_L: { flex: 70 },
      hip_L: { flex: 50, side: -10, twist: 20 },
      knee_L: { flex: 80 },
      toe_L: { flex: 25 },
      clavicle_L: { flex: -8, side: 15 },
      wrist_L: { flex: 30, side: -10, twist: 40 },
    };
    const mirrored = Object.fromEntries(
      Object.entries(left).map(([j, v]) => [j.replace(/_L$/, "_R"), v]),
    ) as typeof left;
    const a = solve(rig, { joints: left }).joints;
    const b = solve(rig, { joints: mirrored }).joints;
    for (const name of Object.keys(left)) {
      const pa = a[name.replace(/_L$/, "_L")]!.position;
      const pb = b[name.replace(/_L$/, "_R")]!.position;
      expect(pb[0]).toBeCloseTo(-pa[0], 9);
      expect(pb[1]).toBeCloseTo(pa[1], 9);
      expect(pb[2]).toBeCloseTo(pa[2], 9);
    }
  });
});
