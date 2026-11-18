/**
 * Minimal, allocation-light 3-vector helpers over plain tuples. Tuples (not classes) so a pose is
 * JSON-serialisable, diffable, and cheap to bake into a Float32Array later. Everything here is pure.
 */
export type Vec3 = readonly [number, number, number];

export const vec = (x: number, y: number, z: number): Vec3 => [x, y, z];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const lengthSq = (a: Vec3): number => dot(a, a);
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));

export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  if (l < 1e-12) throw new Error("cannot normalize a zero-length vector");
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Componentwise max/min, used by the support-polygon and clearance checks. */
export const min3 = (a: Vec3, b: Vec3): Vec3 => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.min(a[2], b[2]),
];

/** Axis of the mirror plane that swaps the character's left and right (VISION §4: left is +X). */
export const mirrorX = (a: Vec3): Vec3 => [-a[0], a[1], a[2]];

export const X = 0;
export const Y = 1;
export const Z = 2;
export const AXIS_X: Vec3 = [1, 0, 0];
export const AXIS_Y: Vec3 = [0, 1, 0];
export const AXIS_Z: Vec3 = [0, 0, 1];
export const ZERO: Vec3 = [0, 0, 0];
