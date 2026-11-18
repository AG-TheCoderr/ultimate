import { describe, expect, it } from "vitest";
import { loadHumanoidRig } from "../src/rig/index.js";
import { clampAxis, clampPose } from "../src/kinematics/limits.js";
import { solve } from "../src/kinematics/fk.js";
import type { RigJoint } from "../src/rig/types.js";

const rig = loadHumanoidRig();
const jointNamed = (n: string): RigJoint => rig.joints.find(j => j.name === n) as RigJoint;
const axisOf = (j: RigJoint, name: "flex" | "side" | "twist") => j.axes.find(a => a.name === name)!;

describe("limits", () => {
  it("refuses a backwards knee and says why in a sentence an agent can act on", () => {
    const k = jointNamed("knee_L");
    const r = clampAxis(k, axisOf(k, "flex"), -45, "hard");
    expect(r.value).toBe(0);
    expect(r.adjustment?.reason).toMatch(/hinge/);
    expect(r.adjustment?.reason).toMatch(/0\.\.150/);
    expect(r.adjustment?.reason).toMatch(/never bend sideways/);
  });

  it("hard mode never exceeds the authored range; solver mode may graze but not run away", () => {
    for (const j of rig.joints) {
      for (const a of j.axes) {
        expect(clampAxis(j, a, 1e6, "hard").value).toBe(a.max);
        expect(clampAxis(j, a, -1e6, "hard").value).toBe(a.min);
        expect(clampAxis(j, a, 1e6, "solver").value).toBeLessThanOrEqual(a.max + a.graze[1]);
        expect(clampAxis(j, a, -1e6, "solver").value).toBeGreaterThanOrEqual(a.min - a.graze[0]);
      }
    }
  });

  it("2000 random requests all clamp legal, and every illegal one is reported", () => {
    let seed = 12345;
    const rnd = (): number =>
      ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 400 - 200;
    let reported = 0;
    for (let i = 0; i < 2_000; i++) {
      const requested: Record<string, Record<"flex" | "side" | "twist", number>> = {};
      const wanted: Record<string, Record<"flex" | "side" | "twist", number>> = {};
      for (const j of rig.joints) {
        if (j.axes.length === 0) continue;
        const v = { flex: rnd(), side: rnd(), twist: rnd() };
        wanted[j.name] = v;
        requested[j.name] = v;
      }
      const { pose, adjustments } = clampPose(rig.joints, requested, "hard");
      reported += adjustments.length;
      for (const j of rig.joints) {
        for (const a of j.axes) {
          const got = pose[j.name]?.[a.name];
          expect(got).toBeDefined();
          expect(got!).toBeGreaterThanOrEqual(a.min);
          expect(got!).toBeLessThanOrEqual(a.max);
          const illegal = wanted[j.name]![a.name] < a.min || wanted[j.name]![a.name] > a.max;
          if (illegal)
            expect(adjustments.some(x => x.joint === j.name && x.axis === a.name)).toBe(true);
        }
      }
    }
    expect(reported).toBeGreaterThan(2_000); // the generator really is asking for impossible poses
  });

  it("a clamped hinge can never move the ankle sideways (knee is a pure sagittal hinge)", () => {
    for (let deg = -60; deg <= 200; deg += 13) {
      const solved = solve(rig, { joints: { knee_L: { flex: deg } } });
      const knee = solved.joints["knee_L"]!.position;
      const ankle = solved.joints["ankle_L"]!.position;
      expect(ankle[0]).toBeCloseTo(knee[0], 9); // no lateral travel, whatever was requested
    }
    // and the same for the elbow: a hinge cannot abduct
    for (let deg = -60; deg <= 200; deg += 13) {
      const solved = solve(rig, { joints: { elbow_L: { flex: deg } } });
      const e = solved.joints["elbow_L"]!.position;
      const w = solved.joints["wrist_L"]!.position;
      expect(w[1]).toBeCloseTo(e[1], 9);
    }
  });

  it("non-finite input is reported, never turned into NaN in the pose", () => {
    const k = jointNamed("knee_L");
    const r = clampAxis(k, axisOf(k, "flex"), Number.NaN, "hard");
    expect(Number.isFinite(r.value)).toBe(true);
    expect(r.adjustment?.reason).toMatch(/not a finite number/);
    const solved = solve(rig, { joints: { knee_L: { flex: Number.POSITIVE_INFINITY } } });
    expect(Number.isFinite(solved.joints["ankle_L"]!.position[2])).toBe(true);
  });

  it("an unmentioned joint is left alone and listed as unauthored (RECONCILIATION §4.1)", () => {
    const solved = solve(rig, { joints: { knee_L: { flex: 45 } } });
    expect(solved.unauthored).toContain("spine");
    expect(solved.unauthored).not.toContain("knee_L");
    expect(solved.unauthored).toHaveLength(
      rig.joints.filter(j => j.axes.length > 0 && j.name !== "knee_L").length,
    );
  });
});
