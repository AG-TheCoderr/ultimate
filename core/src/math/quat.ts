/**
 * Quaternions, `[x, y, z, w]`, right-handed, angles in DEGREES throughout.
 *
 * Degrees everywhere is a deliberate choice: VISION §4 says the AI-facing API is degrees on semantic
 * axes, and the most common bug in this codebase's family is one function silently taking radians.
 * `core` is deterministic and testable, so we would rather pay a multiply by Math.PI/180 per
 * rotation than a mirrored or twitches-by-57x animation.
 */
import type { Vec3 } from "./vec3.js";
import { cross, dot, normalize } from "./vec3.js";

export type Quat = readonly [number, number, number, number];

const DEG = Math.PI / 180;

export const IDENTITY: Quat = [0, 0, 0, 1];

export function fromAxisAngle(axis: Vec3, degrees: number): Quat {
  if (degrees === 0) return IDENTITY;
  const n = normalize(axis);
  const h = (degrees * DEG) / 2;
  const s = Math.sin(h);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(h)];
}

export const fromAxis = (axis: Vec3, degrees: number): Quat => fromAxisAngle(axis, degrees);

/** Rotate `v` by `q`. Written out (no temporaries) because FK calls this ~26 times per frame. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 * (q.xyz × v);  v' = v + w*t + q.xyz × t
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

export function mul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export const conjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

export const norm = (q: Quat): number => Math.sqrt(q[0] ** 2 + q[1] ** 2 + q[2] ** 2 + q[3] ** 2);

/**
 * a * b⁻¹ — the rotation taking `a` onto `b`. Retargeting and the "how far did the clamp move this
 * joint" report both need this, and getting the order backwards is silent.
 */
export const delta = (from: Quat, to: Quat): Quat => mul(to, conjugate(from));

export function normalizeq(q: Quat): Quat {
  const l = norm(q);
  if (l < 1e-12) return IDENTITY;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Shortest-arc rotation from unit `a` onto unit `b`. Used to aim a cylinder at its bone direction. */
export function fromUnitVectors(a: Vec3, b: Vec3): Quat {
  const d = dot(a, b);
  if (d > 1 - 1e-9) return IDENTITY;
  if (d < -1 + 1e-9) {
    // 180 degrees: any perpendicular axis works; pick the one with the smallest component to stay stable
    const axis = normalize(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
    return [axis[0], axis[1], axis[2], 0];
  }
  const c = cross(a, b);
  return normalizeq([c[0], c[1], c[2], 1 + d]);
}

export interface SwingTwist {
  readonly swing: Quat;
  readonly twist: Quat;
}

/**
 * Split `q` into a twist about `axis` plus a swing that carries it (q = swing * twist).
 * The twist part is the projection of q onto the axis, so it never moves a point lying on the axis —
 * which is the property `core/test/fk.test.ts` uses to pin our DoF composition order.
 */
export function swingTwist(q: Quat, axis: Vec3): SwingTwist {
  const [ax, ay, az, aw] = q;
  const [x, y, z] = axis;
  // twist = the (x,y,z) component of q that is parallel to the axis, re-normalized to unit quat
  const d = ax * x + ay * y + az * z;
  const twist = normalizeq([x * d, y * d, z * d, aw]);
  return { twist, swing: mul(q, conjugate(twist)) };
}

/** Re-aim a twist-only rotation onto a new axis (used when a rig's bone frame differs, see retargeting). */
export function twistAbout(q: Quat, axis: Vec3): Quat {
  return swingTwist(q, axis).twist;
}

/** World-space yaw of `v` in degrees, 0 when v points at +Z (the character's facing). */
export function yawOf(v: Vec3): number {
  return Math.atan2(v[0], v[2]) / DEG;
}
