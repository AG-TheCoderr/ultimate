import type { HumanoidRig } from "./types.js";
import type { Vec3 } from "../math/vec3.js";
import { fromUnitVectors, mul, rotate, type Quat } from "../math/quat.js";

/**
 * Rest-space binding: one rigid primitive per bone plus one sphere per joint, each expressed in the
 * local frame of a SINGLE joint. This is what a GPU skin does with one bone and weight 1.0, which is
 * why the same numbers export straight into a glTF skin in M6 (VISION §M6).
 *
 * Lives in `core` rather than in the viewer for two reasons, both learned the hard way:
 *
 * 1. The frame-by-frame rule is `world = parentWorldRest_rotated * local`. If `local` is authored in
 *    WORLD rest space, the parent's own translation is counted twice and the whole body lands one
 *    hip-height away from where it belongs. Deriving it here — with the subtraction explicit in one
 *    place — makes that impossible, and `core/test/bind.test.ts` reconstructs the endpoints from the
 *    bound transform and asserts they land on `restPose`.
 * 2. `local` must be computed by `compose()`, never read off a renderer object. `Object3D.matrix` is
 *    still identity until something calls `updateMatrix()`, so "set position, then clone matrix"
 *    silently binds every primitive at the origin.
 *
 * Under the canonical rest pose every parent's rest rotation is identity, so parent-local positions
 * are `worldRest - parentRest` and rotations carry over unchanged. That simplification is the point.
 */

export type BindKind = "bone" | "joint" | "head" | "torso";

export interface BoundPrimitive {
  readonly label: string;
  readonly kind: BindKind;
  /**
   * The single joint this primitive rides — and the one a click on it selects. There is deliberately
   * ONE owner per primitive (FK: rotating `hip` moves the thigh, so the thigh belongs to `hip`, not
   * to `knee`), which is why picking a bone and picking a joint sphere light up the same meshes.
   */
  readonly parentJoint: string;
  readonly position: Vec3;
  readonly quaternion: Quat;
  readonly scale: Vec3;
  /** Key into `rig.mesh.colors`; the viewer resolves it, core stays renderer-free. */
  readonly colorKey: "bone" | "left" | "right" | "center";
}

const UP: Vec3 = [0, 1, 0];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scaled = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/**
 * A cylinder between two rest positions, returned in `from`'s local frame. `radius`/`length` become
 * the geometry scale so one shared unit cylinder serves all 22 bones.
 */
function cylinderBetween(rest: Record<string, Vec3>, from: string, to: string, radius: number) {
  const a = rest[from]!;
  const b = rest[to]!;
  const dir = sub(b, a);
  const length = len(dir);
  if (length < 1e-9) throw new Error(`bone ${from}->${to} has zero length`);
  return {
    position: scaled(dir, 0.5), // parent-local: the world midpoint minus the parent's rest position
    quaternion: fromUnitVectors(UP, scaled(dir, 1 / length)),
    scale: [radius, length, radius] as Vec3,
    length,
  };
}

export function bindPrimitives(rig: HumanoidRig): BoundPrimitive[] {
  const rest = rig.restPose.joints;
  const mesh = rig.mesh as unknown as {
    head?: { parent: string; radius: number; offset: Vec3; ellipsoidScale: Vec3 };
    torso?: { from: string; to: string; halfSize: Vec3 };
    jointSpheres?: { scale: number };
  };
  const out: BoundPrimitive[] = [];

  for (const b of rig.bones) {
    const c = cylinderBetween(rest, b.from, b.to, b.radius);
    out.push({
      label: `bone:${b.name}`,
      kind: "bone",
      parentJoint: b.from,
      position: c.position,
      quaternion: c.quaternion,
      scale: c.scale,
      colorKey: "bone",
    });
  }

  for (const j of rig.joints) {
    if (j.radius === null) continue;
    out.push({
      label: `joint:${j.name}`,
      kind: "joint",
      parentJoint: j.name,
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [j.radius, j.radius, j.radius],
      colorKey: j.color,
    });
  }

  const head = mesh.head;
  if (head) {
    const r = head.radius;
    const [ex, ey, ez] = head.ellipsoidScale ?? [1, 1, 1];
    out.push({
      label: "shape:head",
      kind: "head",
      parentJoint: head.parent,
      // authored as an offset FROM the head joint on purpose: the joint is the skull base, and a
      // sphere centred there leaves the crown 7 cm short of bindHeight (RECONCILIATION §2.6)
      position: head.offset,
      quaternion: [0, 0, 0, 1],
      scale: [r * ex, r * ey, r * ez],
      colorKey: "center",
    });
  }

  const torso = mesh.torso;
  if (torso) {
    const c = cylinderBetween(rest, torso.from, torso.to, 1);
    const [hx, , hz] = torso.halfSize;
    out.push({
      label: "shape:torso",
      kind: "torso",
      parentJoint: torso.from,
      position: c.position,
      quaternion: c.quaternion,
      scale: [hx * 2, c.length, hz * 2],
      colorKey: "center",
    });
  }

  return out;
}

/**
 * World transform of a bound primitive, given its parent joint's solved world transform. This is the
 * whole per-frame cost of the viewer: one rotate and one quaternion multiply per primitive.
 */
export function bindWorld(
  parent: { position: Vec3; rotation: Quat },
  prim: BoundPrimitive,
): {
  position: Vec3;
  quaternion: Quat;
} {
  // A bound primitive is T(position) * R(quaternion) * S(scale) — the same order three.js'
  // Matrix4.compose uses. So the parent's rotation carries the local TRANSLATION, and the
  // primitive's own rotation must NOT: applying it here flips the thigh's midpoint 0.44 m the wrong
  // way up (caught by the endpoint reconstruction test, which is why it exists).
  return {
    position: add(parent.position, rotate(parent.rotation, prim.position)),
    quaternion: mul(parent.rotation, prim.quaternion),
  };
}
