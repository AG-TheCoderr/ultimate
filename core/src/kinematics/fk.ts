import type { AxisName, HumanoidRig, RigJoint } from "../rig/types.js";
import type { Vec3 } from "../math/vec3.js";
import { add } from "../math/vec3.js";
import { IDENTITY, fromAxisAngle, mul, rotate, type Quat } from "../math/quat.js";
import { clampPose, type AxisAdjustment } from "./limits.js";

/**
 * Forward kinematics for the semantic pose model: authored degrees -> clamped degrees -> world
 * transforms of joints, end sites and contact markers.
 *
 * Pure, synchronous, deterministic. This is the ONLY place the DoF composition order is decided:
 *
 *     local = R(flex) * R(side) * R(twist)        (twist INNERMOST)
 *
 * so a twist is a roll about the bone's rest axis that the swing then carries. The reverse order makes
 * `shoulder_L {flex: 90, twist: 90}` drag the elbow through space, which is nonsense for a rotation
 * about the humerus — a twist must never move a joint lying on its own axis. `core/test/fk.test.ts`
 * pins the difference, and VISION §6's ten tests would pass under either order, which is how this
 * would otherwise have shipped wrong.
 */

export type SemanticValues = Partial<Record<AxisName, number>>;

export interface RootPose {
  readonly position?: Vec3 | undefined;
  /** Yaw in degrees; 0 faces +Z (VISION §4). */
  readonly heading?: number | undefined;
  readonly tilt?: { readonly flex?: number; readonly side?: number } | undefined;
}

export interface SemanticPose {
  readonly root?: RootPose | undefined;
  readonly joints?: Readonly<Record<string, SemanticValues>> | undefined;
}

export interface SolvedJoint {
  readonly position: Vec3;
  readonly rotation: Quat;
}

export interface SolveResult {
  readonly joints: Readonly<Record<string, SolvedJoint>>;
  readonly markers: Readonly<Record<string, Vec3>>;
  /** Everything the rig corrected, ready to hand to the agent as `adjusted[]`. */
  readonly adjustments: readonly AxisAdjustment[];
  /**
   * Articulating joints the pose never mentions. "at rest" and "nobody decided yet" stay
   * distinguishable, per RECONCILIATION §4.1.
   */
  readonly unauthored: readonly string[];
}

/** Joints with no DoFs (end sites, the root) contribute identity. */
const NO_AXES: Record<AxisName, number> = { flex: 0, side: 0, twist: 0 };

const rotAbout = (axis: Vec3, degrees: number | undefined): Quat =>
  degrees === undefined || degrees === 0 ? IDENTITY : fromAxisAngle(axis, degrees);

/** Heading is a world yaw; tilt is applied in the hips' frame, so a leaning character still walks along its own forward. */
export function rootRotation(root: RootPose | undefined): Quat {
  const heading = rotAbout([0, 1, 0], root?.heading);
  const tilt = mul(rotAbout([1, 0, 0], root?.tilt?.flex), rotAbout([0, 0, 1], root?.tilt?.side));
  return mul(tilt, heading);
}

/**
 * One joint's local rotation from its clamped semantic values, composed innermost-first
 * (twist, then side, then flex). `rig.dofOrder` is the authored order; the loop reads it backwards so
 * a rig file can redefine the sequence without touching this function.
 */
export function localRotation(joint: RigJoint, values: Readonly<Record<AxisName, number>>): Quat {
  let q = IDENTITY;
  for (let i = joint.axes.length - 1; i >= 0; i--) {
    const a = joint.axes[i]!;
    q = mul(rotAbout(a.axis, values[a.name]), q);
  }
  return q;
}

const orderCache = new Map<string, readonly RigJoint[]>();

/** Parents before children, derived from the hierarchy rather than trusted from file order. */
function parentFirst(rig: HumanoidRig): readonly RigJoint[] {
  const cached = orderCache.get(rig.id);
  if (cached) return cached;
  const byName = new Map(rig.joints.map(j => [j.name, j]));
  const out: RigJoint[] = [];
  const visiting = new Set<string>();
  const emit = (name: string): void => {
    if (out.some(j => j.name === name)) return;
    if (visiting.has(name)) throw new Error(`${name}: the rig hierarchy contains a cycle`);
    const j = byName.get(name);
    if (!j) throw new Error(`unknown joint "${name}" referenced as a parent`);
    visiting.add(name);
    if (j.parent !== null) emit(j.parent);
    visiting.delete(name);
    out.push(j);
  };
  for (const j of rig.joints) emit(j.name);
  orderCache.set(rig.id, out);
  return out;
}

export function solve(
  rig: HumanoidRig,
  pose: SemanticPose,
  opts: { mode?: "hard" | "solver" } = {},
): SolveResult {
  const requested = pose.joints ?? {};
  const { pose: clamped, adjustments } = clampPose(rig.joints, requested, opts.mode ?? "hard");

  const rot: Record<string, Quat> = {};
  const pos: Record<string, Vec3> = {};
  const rootRot = rootRotation(pose.root);
  const rootPos = pose.root?.position ?? rig.root.restPosition;

  for (const j of parentFirst(rig)) {
    const local = localRotation(j, clamped[j.name] ?? NO_AXES);
    if (j.parent === null) {
      rot[j.name] = mul(rootRot, local);
      pos[j.name] = rootPos;
    } else {
      const parentRot = rot[j.parent]!;
      rot[j.name] = mul(parentRot, local);
      pos[j.name] = add(pos[j.parent]!, rotate(parentRot, j.offset));
    }
  }

  const markers: Record<string, Vec3> = {};
  for (const m of rig.markers) {
    markers[m.name] = add(pos[m.parent]!, rotate(rot[m.parent]!, m.offset));
  }

  const joints: Record<string, SolvedJoint> = {};
  for (const j of rig.joints) joints[j.name] = { position: pos[j.name]!, rotation: rot[j.name]! };

  return {
    joints,
    markers,
    adjustments,
    unauthored: rig.joints
      .filter(j => j.axes.length > 0 && requested[j.name] === undefined)
      .map(j => j.name),
  };
}

/** World-space direction of the bone that hangs off `joint`, for pole vectors, previews and bone frames. */
export function boneDirection(rig: HumanoidRig, solved: SolveResult, jointName: string): Vec3 {
  const child = rig.joints.find(j => j.parent === jointName);
  if (!child) throw new Error(`${jointName} has no child bone`);
  return rotate(solved.joints[jointName]!.rotation, child.offset);
}
