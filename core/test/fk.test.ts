import { describe, expect, it } from "vitest";
import { loadHumanoidRig } from "../src/rig/index.js";
import { boneDirection, localRotation, rootRotation, solve } from "../src/kinematics/fk.js";
import {
  IDENTITY,
  conjugate,
  delta,
  fromAxisAngle,
  mul,
  norm,
  rotate,
  swingTwist,
} from "../src/math/quat.js";
import type { RigJoint } from "../src/rig/types.js";
import type { Vec3 } from "../src/math/vec3.js";

const rig = loadHumanoidRig();
/** 9-dp rounding; the `+ 0` folds -0 to 0 so toEqual is not tripped by a sign of zero. */
const round9 = (v: readonly number[]): number[] => v.map(n => Math.round(n * 1e9) / 1e9 + 0);
const shoulder = rig.joints.find(j => j.name === "shoulder_L") as RigJoint;
const flexAxis: Vec3 = shoulder.axes.find(a => a.name === "flex")!.axis;
const twistAxis: Vec3 = shoulder.axes.find(a => a.name === "twist")!.axis;

describe("FK", () => {
  it("at zero degrees everywhere reproduces the rig's own rest positions", () => {
    const solved = solve(rig, {});
    for (const [name, p] of Object.entries(rig.restPose.joints)) {
      expect(round9(solved.joints[name]!.position)).toEqual(round9(p));
    }
  });

  it("keeps the contact markers exactly on the floor in the rest pose", () => {
    const solved = solve(rig, {});
    for (const m of rig.markers) expect(solved.markers[m.name]![1]).toBeCloseTo(0, 9);
  });

  it("bone lengths never change (rigid hierarchy, no telescoping)", () => {
    const solved = solve(rig, {
      joints: {
        spine: { flex: 18, twist: -12 },
        shoulder_L: { flex: 55, side: -70, twist: 33 },
        elbow_L: { flex: 111 },
        hip_R: { flex: 96, side: 12, twist: -20 },
        knee_R: { flex: 133 },
        ankle_L: { flex: 9 },
      },
      root: { position: [0.2, 0.9, -0.4], heading: 37, tilt: { flex: 6, side: -3 } },
    });
    for (const b of rig.bones) {
      const a = solved.joints[b.from]!.position;
      const c = solved.joints[b.to]!.position;
      expect(Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2])).toBeCloseTo(b.length, 4); // rig JSON rounds length to 4dp
    }
  });

  it("twist never moves a joint lying on the bone axis — this pins the composition order", () => {
    const flexOnly = solve(rig, { joints: { shoulder_L: { flex: 90 } } }).joints["elbow_L"]!
      .position;
    const withTwist = solve(rig, { joints: { shoulder_L: { flex: 90, twist: 90 } } }).joints[
      "elbow_L"
    ]!.position;
    expect(round9(withTwist)).toEqual(round9(flexOnly));

    // The order the first draft of the rig conventions implied (twist OUTERMOST) *would* have moved
    // the elbow. Asserting the failure keeps a future refactor from "simplifying" the loop order.
    const twistOutermost = rotate(
      mul(fromAxisAngle(twistAxis, 90), fromAxisAngle(flexAxis, 90)),
      [0.34, 0, 0],
    );
    expect(Math.abs(twistOutermost[1])).toBeGreaterThan(0.1); // the elbow drops: this is the bug our order avoids
    // ...while our order, swing-then-twist-applied-first, leaves it level.
    const ours = localRotation(shoulder, { flex: 90, twist: 90 });
    expect(round9(rotate(ours, [0.34, 0, 0]))).toEqual(
      round9(rotate(fromAxisAngle(flexAxis, 90), [0.34, 0, 0])),
    );
  });

  it("swing * twist rebuilds q, and the twist part leaves its own axis alone", () => {
    const q = localRotation(shoulder, { flex: 40, side: -70, twist: 25 });
    const { swing, twist } = swingTwist(q, twistAxis);
    expect(norm(mul(swing, twist))).toBeCloseTo(1, 9);
    expect(round9(rotate(twist, twistAxis))).toEqual(round9(twistAxis));
    expect(norm(q)).toBeCloseTo(1, 9);
  });

  it("left-multiplying by q⁻¹ recovers a composed factor, and delta(a, b) is b * a⁻¹", () => {
    const a = fromAxisAngle(twistAxis, 20);
    const b = fromAxisAngle(flexAxis, -55);
    expect(round9(mul(conjugate(a), mul(a, b)))).toEqual(round9(b)); // q⁻¹ · (q·r) == r
    // delta is the WORLD-frame rotation taking a onto b, i.e. b·a⁻¹ — not a⁻¹·b. Getting these
    // backwards is the classic silent retargeting bug, so both orders are pinned here.
    expect(round9(delta(a, mul(a, b)))).not.toEqual(round9(b));
    expect(round9(delta(a, b))).toEqual(round9(mul(b, conjugate(a))));
  });

  it("root heading rotates about the world Y axis through the hips, not about the parent frame", () => {
    const turned = solve(rig, { root: { heading: 90 }, joints: { hip_L: { flex: 60 } } });
    const plain = solve(rig, { joints: { hip_L: { flex: 60 } } });
    const a = turned.joints["knee_L"]!.position;
    const b = plain.joints["knee_L"]!.position;
    const [hx, , hz] = rig.root.restPosition;
    expect(a[0]).toBeCloseTo(b[2] - hz + hx, 6);
    expect(a[2]).toBeCloseTo(-(b[0] - hx) + hz, 6);
    expect(a[1]).toBeCloseTo(b[1], 6);
  });

  it("boneDirection reports the rotated bone; a flexed knee keeps the shin level", () => {
    const solved = solve(rig, { joints: { knee_L: { flex: 90 } } });
    const d = boneDirection(rig, solved, "knee_L");
    expect(d[1]).toBeCloseTo(0, 6);
    expect(d[2]).toBeCloseTo(-0.44, 6);
    expect(solved.joints["ankle_L"]!.position[1]).toBeCloseTo(
      solved.joints["knee_L"]!.position[1],
      6,
    );
  });

  it("rootRotation with no keys is the identity, and children follow the root's translation", () => {
    expect(rootRotation(undefined)).toEqual(IDENTITY);
    const moved = solve(rig, { root: { position: [1, 0.98, -2] as Vec3 } });
    expect(round9(moved.joints["chest"]!.position)).toEqual(
      round9([
        1 + rig.restPose.joints["chest"]![0],
        rig.restPose.joints["chest"]![1],
        -2 + rig.restPose.joints["chest"]![2],
      ]),
    );
  });
});
