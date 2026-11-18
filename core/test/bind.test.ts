import { describe, expect, it } from "vitest";
import { bindPrimitives, bindWorld, loadHumanoidRig, solve } from "../src/index.js";
import type { Vec3 } from "../src/math/vec3.js";
import { rotate } from "../src/math/quat.js";

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * These tests exist because the first version of the viewer authored primitive transforms in WORLD
 * rest space and then multiplied by the parent's world transform — double-counting the parent's
 * translation, so the whole body landed a hip-height off. It could not be caught by reading the code;
 * it is trivially caught by reconstructing where each primitive says its endpoints are.
 */
const rig = loadHumanoidRig();
const prims = bindPrimitives(rig);
const rest = rig.restPose.joints;
const near = (a: Vec3, b: Vec3, eps = 1e-6): boolean =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < eps;
const UP: Vec3 = [0, 1, 0];
const identityWorld = (joint: string) => ({
  position: rest[joint]!,
  rotation: [0, 0, 0, 1] as const,
});

describe("bindPrimitives", () => {
  it("binds one primitive per bone, per joint, plus the head and torso shapes", () => {
    expect(prims.filter(p => p.kind === "bone")).toHaveLength(rig.bones.length);
    expect(prims.filter(p => p.kind === "joint")).toHaveLength(rig.joints.length);
    expect(prims.filter(p => p.kind === "head")).toHaveLength(1);
    expect(prims.filter(p => p.kind === "torso")).toHaveLength(1);
  });

  it("a bone primitive's local position is HALF the bone vector, not the world midpoint", () => {
    for (const b of rig.bones) {
      const prim = prims.find(
        p => p.kind === "bone" && p.parentJoint === b.from && p.label === `bone:${b.name}`,
      )!;
      const a = rest[b.from]!;
      const c = rest[b.to]!;
      const want: Vec3 = [(c[0] - a[0]) / 2, (c[1] - a[1]) / 2, (c[2] - a[2]) / 2];
      expect(near(prim.position, want)).toBe(true);
      // and explicitly NOT the world midpoint, which is the bug this test was written for
      const worldMid: Vec3 = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2, (c[2] + a[2]) / 2];
      if (Math.hypot(a[0], a[1], a[2]) > 1e-6) expect(near(prim.position, worldMid)).toBe(false);
    }
  });

  it("reconstructing endpoints from the bound transform lands on the authored rest positions", () => {
    for (const b of rig.bones) {
      const prim = prims.find(p => p.label === `bone:${b.name}`)!;
      const w = bindWorld(identityWorld(b.from), prim);
      // the primitive's local +Y after its own rotation is the bone direction
      const dir = rotate(prim.quaternion, UP);
      // half-length comes from the rest positions, not from rig.bones[].length — that field is a
      // rounded convenience for the UI (see the length assertion in validateRig)
      const half = dist(rest[b.from]!, rest[b.to]!) / 2;
      const from: Vec3 = [
        w.position[0] - dir[0] * half,
        w.position[1] - dir[1] * half,
        w.position[2] - dir[2] * half,
      ];
      const to: Vec3 = [
        w.position[0] + dir[0] * half,
        w.position[1] + dir[1] * half,
        w.position[2] + dir[2] * half,
      ];
      const err = Math.max(dist(from, rest[b.from]!), dist(to, rest[b.to]!));
      if (err > 1e-6) throw new Error(`${b.name}: reconstruction off by ${err.toExponential(3)}`);
      expect(err).toBeLessThan(1e-6);
    }
  });

  it("head rides its parent: tilting the head moves the skull, turning the hips does not slide it along the spine", () => {
    const headPrim = prims.find(p => p.kind === "head")!;
    const straight = bindWorld(solve(rig, {}).joints["head"]!, headPrim);
    const nod = bindWorld(solve(rig, { joints: { head: { flex: 40 } } }).joints["head"]!, headPrim);
    // A nod carries the skull forward (it is rigid on the head joint) but never stretches it:
    // the distance from the joint must be the authored offset's length in every pose.
    const want = Math.hypot(...(headPrim.position as [number, number, number]));
    const d = (p: { position: Vec3 }): number =>
      dist(p.position, solve(rig, { joints: { head: { flex: 40 } } }).joints["head"]!.position);
    expect(d(nod)).toBeCloseTo(want, 9);
    expect(near(straight.position, nod.position)).toBe(false);

    // a pure root translation moves the skull by exactly that delta, with no rotation leakage
    const [rx, ry, rz] = rig.root.restPosition;
    const moved = bindWorld(
      solve(rig, { root: { position: [rx + 0.5, ry, rz - 1] } }).joints["head"]!,
      headPrim,
    );
    expect(dist(moved.position, straight.position)).toBeCloseTo(Math.hypot(0.5, 0, -1), 9);
  });

  it("a posed bone cylinder still connects its joint to the next one", () => {
    // The rest-pose checks above would pass for a binding that only works when every parent rotation
    // is identity. This is the viewer's actual per-frame contract, so it gets its own test: after
    // solving, reconstructing each cylinder's endpoints must land on the SOLVED joint positions.
    const solved = solve(rig, {
      joints: {
        hips: { flex: 12, side: -6, twist: 22 },
        thigh_L: { flex: 75, side: 10, twist: -15 },
        knee_L: { flex: 61 },
        upper_arm_R: { flex: 120, twist: 40 },
        elbow_R: { flex: 33 },
        neck: { side: 18 },
      },
      root: {
        heading: -35,
        position: [rig.root.restPosition[0] + 0.3, rig.root.restPosition[1], 0],
      },
    });
    let worst = 0;
    for (const b of rig.bones) {
      const prim = prims.find(p => p.label === `bone:${b.name}`)!;
      const w = bindWorld(solved.joints[b.from]!, prim);
      // the WORLD axis of the cylinder: bindWorld already folded in the parent's rotation. Using the
      // primitive's own rest-space quaternion here would compare the thigh against where it points in
      // the rest pose, which is precisely not what a posed body does.
      const dir = rotate(w.quaternion, UP);
      const solvedLen = dist(solved.joints[b.from]!.position, solved.joints[b.to]!.position);
      // rigid FK: bone length never changes, which is the assumption a cylinder bound this way needs
      expect(solvedLen).toBeCloseTo(dist(rest[b.from]!, rest[b.to]!), 9);
      const half = solvedLen / 2;
      const err = Math.max(
        dist(
          [
            w.position[0] + dir[0] * half,
            w.position[1] + dir[1] * half,
            w.position[2] + dir[2] * half,
          ],
          solved.joints[b.to]!.position,
        ),
        dist(
          [
            w.position[0] - dir[0] * half,
            w.position[1] - dir[1] * half,
            w.position[2] - dir[2] * half,
          ],
          solved.joints[b.from]!.position,
        ),
      );
      worst = Math.max(worst, err);
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("every primitive names the joint that owns it, so picking a bone selects that bone's joint", () => {
    const owners = new Map(prims.map(p => [p.parentJoint, p.kind]));
    for (const j of rig.joints) expect(owners.has(j.name)).toBe(true);
    for (const b of rig.bones) {
      const prim = prims.find(p => p.label === `bone:${b.name}`)!;
      expect(prim.parentJoint).toBe(b.from); // FK: the thigh belongs to the hip, not the knee
    }
  });

  it("joint spheres sit on their own joint in every solved pose", () => {
    const solved = solve(rig, {
      joints: {
        shoulder_L: { flex: 60, twist: 20 },
        knee_R: { flex: 100 },
        spine: { side: 9, twist: -14 },
      },
      root: { heading: 40 },
    });
    for (const p of prims.filter(x => x.kind === "joint")) {
      const w = bindWorld(solved.joints[p.parentJoint]!, p);
      expect(near(w.position, solved.joints[p.parentJoint]!.position)).toBe(true);
    }
  });
});
