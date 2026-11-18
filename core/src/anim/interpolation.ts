import type { AxisName } from "../rig/types.js";
import type { SemanticValues } from "../kinematics/fk.js";
import type { Clip, EaseMode, Key } from "./types.js";
import { bracket } from "./keys.js";

/**
 * One-number-at-a-time interpolation, and the whole reason M2 can be trusted: every rule here is
 * pinned by `core/test/interpolation.test.ts`, including the three that are easy to get wrong and
 * invisible when you do (the wrap segment's neighbours, and which key owns a segment's ease).
 *
 * ## Why scalar channels and not `slerp`/`squad`
 *
 * VISION §7.2 step 2 says "interpolate joint keys (quaternion slerp/squad with ease)". This
 * interpolates each semantic axis as its own number instead, then builds quaternions with
 * `localRotation`. Three reasons, in order of weight:
 *
 * 1. Limits are per-axis. `min`/`max`/`graze` and the `adjusted[]` report — the mechanism §9 is built
 *    on — only exist in degrees. A slerped quaternion has to be decomposed back to swing/twist to be
 *    checked, and that decomposition is not unique near 180°, so the clamp would become a coin flip.
 * 2. The 21 joints are authored as 3 independent DoFs; a channel per DoF is the same model one level
 *    down. "Ease this bend" is a statement about one axis, and `step` on `hip.flex` must not turn
 *    `knee.flex` into a step too.
 * 3. Debuggability: `sample_pose` can print the exact numbers an agent keyed.
 *
 * The cost is that a per-axis path between two far-apart orientations can cut through a slightly
 * different intermediate pose than a geodesic would. For humanoid key poses at 30 fps it is the same
 * difference a spin-bone-free DCC makes, and it is why `swingTwist` and `delta` are exported from
 * `core/src/math/quat.ts` for anything that genuinely needs a geodesic (M4's IK, M6's bake).
 */

export type SampleMethod = "hold" | "step" | "linear" | "ease" | "catmull-rom";

export interface TrackSample {
  readonly value: number;
  readonly method: SampleMethod;
  /** The key the value came out of, for the UI's "between 12 and 20" caption. */
  readonly fromFrame: number;
  readonly toFrame: number;
  readonly ease: EaseMode;
}

const EMPTY: TrackSample = { value: 0, method: "hold", fromFrame: -1, toFrame: -1, ease: "auto" };

/** Cubic ease curves. `t` is already the 0..1 position along the segment. */
export function easeCurve(ease: EaseMode, t: number): number {
  const x = Math.min(Math.max(t, 0), 1);
  switch (ease) {
    case "ease_in":
      return x * x * x;
    case "ease_out":
      return 1 - (1 - x) * (1 - x) * (1 - x);
    case "ease_in_out":
      return x * x * (3 - 2 * x);
    default:
      return x; // linear, auto and step do not reshape t here
  }
}

/** A joint track's scalar channel for one axis. Missing values are 0, which is the rest pose. */
export function axisTrack(keys: readonly Key<SemanticValues>[], axis: AxisName): Key<number>[] {
  return keys.map(k => ({ frame: k.frame, value: k.value[axis] ?? 0, ease: k.ease }));
}

/**
 * The tangent a segment's end gets under `auto`: the **harmonic mean** of the two one-sided secant
 * slopes, and exactly 0 where they disagree in sign (an extremum).
 *
 *     m_i = 2·d_prev·d_next / (d_prev + d_next)      when d_prev·d_next > 0
 *     m_i = 0                                        otherwise
 *
 * The textbook Catmull-Rom slope `(v[i+1] - v[i-1]) / (f[i+1] - f[i-1])` is C1 but NOT monotone: on
 * `0, 100, 100, 0` it drives the middle segment to ~123, i.e. a shoulder that visibly snaps 23° past the
 * pose it was keyed on and comes back. That is the single most common "why does the CG look loose"
 * artefact, and a rig tool whose whole claim is physical correctness cannot ship it. The harmonic mean is
 * the Fritsch–Carlson monotonicity-preserving choice: it is bounded by 2·min(|d_prev|, |d_next|), which
 * is inside their sufficient condition for the cubic to stay within its endpoint values, and it reduces to
 * the plain slope on a straight ramp — so `auto` still reproduces linear motion exactly (a property the
 * tests check).
 *
 * Null at the ends of a non-looping track, where the caller falls back to linear.
 */
function slopeAt(keys: readonly Key<number>[], i: number): number | null {
  const prev = keys[i - 1];
  const here = keys[i];
  const next = keys[i + 1];
  if (!prev || !here || !next) return null;
  const dPrev = (here.value - prev.value) / (here.frame - prev.frame);
  const dNext = (next.value - here.value) / (next.frame - here.frame);
  if (!Number.isFinite(dPrev) || !Number.isFinite(dNext)) return null;
  if (dPrev * dNext <= 0) return 0; // peak or valley: flat through the key, which is what "ease" means
  const sum = dPrev + dNext;
  if (sum === 0) return 0;
  return (2 * dPrev * dNext) / sum;
}

/**
 * One lap of real keys on each side, so a looping clip's seam is an ordinary segment: the value at
 * `frame 0` of the next lap is `first + shiftPerLap`, and the ease that governs the wrap segment is the
 * last key's, which is the only reading of "ease describes the segment leaving it" that makes a loop
 * work. `shiftPerLap` is 0 for a pose channel and 360° x turns for a heading that turns a full circle,
 * so a looping 360 turn interpolates forward instead of spinning backwards across the seam.
 */
export function padLooped(
  keys: readonly Key<number>[],
  frameCount: number,
  shiftPerLap = 0,
): Key<number>[] {
  if (keys.length < 2) return [...keys]; // one key is a constant; there is no seam to cross
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  return [
    { frame: last.frame - frameCount, value: last.value - shiftPerLap, ease: last.ease },
    ...keys,
    { frame: first.frame + frameCount, value: first.value + shiftPerLap, ease: first.ease },
  ];
}

/**
 * Sample a scalar track at a frame. `frame` may be anywhere: a looping clip wraps, a non-looping one
 * holds the end keys (which is what makes "hold the last pose" the default rather than a snap to rest).
 *
 * `shiftPerLap` exists for heading; see `padLooped`.
 */
export function sampleNumbers(
  keys: readonly Key<number>[],
  frame: number,
  clip: Pick<Clip, "loop" | "frameCount">,
  shiftPerLap = 0,
): TrackSample {
  if (keys.length === 0) return EMPTY;
  // ">= 3 keys on the channel" is a statement about what the animator keyed, so it is measured before
  // padding, not after: a padded track always has two more keys than the one that was authored.
  const enoughKeys = keys.length >= 3;
  const track = clip.loop ? padLooped(keys, clip.frameCount, shiftPerLap) : keys;
  const at = clip.loop
    ? ((frame % clip.frameCount) + clip.frameCount) % clip.frameCount
    : Math.min(Math.max(frame, 0), clip.frameCount - 1);
  const b = bracket(track, at, { loop: false, frameCount: clip.frameCount });
  if (!b) return EMPTY;
  const ease = b.from.ease;
  const lerp = (t: number): number => b.from.value + (b.to.value - b.from.value) * t;

  if (b.toFrame === b.fromFrame) {
    return {
      value: b.from.value,
      method: "hold",
      fromFrame: b.fromFrame,
      toFrame: b.toFrame,
      ease,
    };
  }

  // The ease belongs to the segment LEAVING `from` (see types.ts), not the one arriving at `to`.
  if (ease === "step") {
    return {
      value: b.t < 1 ? b.from.value : b.to.value,
      method: "step",
      fromFrame: b.fromFrame,
      toFrame: b.toFrame,
      ease,
    };
  }

  if (ease === "auto") {
    // Ratified decision (RECONCILIATION §4.2): auto is Catmull-Rom tangents with >= 3 keys on THIS
    // channel, linear with exactly 2, never step. "Never step" matters because auto is the default, so a
    // default that silently held values would read as a broken rig rather than as a choice.
    if (enoughKeys) {
      // Outside a loop the end segments have no neighbour on one side, and the fallback is linear rather
      // than a reflected phantom key: reflecting invents motion nobody animated.
      const m0 = slopeAt(track, b.index);
      const m1 = slopeAt(track, b.index + 1);
      if (m0 !== null && m1 !== null) {
        const dt = b.toFrame - b.fromFrame;
        const t = b.t;
        const t2 = t * t;
        const t3 = t2 * t;
        const value =
          (2 * t3 - 3 * t2 + 1) * b.from.value +
          (t3 - 2 * t2 + t) * m0 * dt +
          (-2 * t3 + 3 * t2) * b.to.value +
          (t3 - t2) * m1 * dt;
        return { value, method: "catmull-rom", fromFrame: b.fromFrame, toFrame: b.toFrame, ease };
      }
    }
    return { value: lerp(b.t), method: "linear", fromFrame: b.fromFrame, toFrame: b.toFrame, ease };
  }

  return {
    value: lerp(easeCurve(ease, b.t)),
    method: "ease",
    fromFrame: b.fromFrame,
    toFrame: b.toFrame,
    ease,
  };
}

/**
 * Heading is the one channel that must be unwrapped before interpolation: 350° to 10° is 20° of turn,
 * but linear in the raw numbers it is a 340° spin the wrong way. Each step between neighbouring keys is
 * normalized to (-180, 180] and accumulated, so the file keeps the authored degrees (what an agent wrote
 * is what `get_studio_state` shows) and only the interpolation sees a monotone ramp. A step of exactly
 * 180° takes the negative direction, because there is no right answer to give it.
 */
export function unwrapDegrees(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      out.push(values[0]!);
      continue;
    }
    const step = values[i]! - values[i - 1]!;
    out.push(out[i - 1]! + (step - Math.round(step / 360) * 360));
  }
  return out;
}

/** Full revolutions the unwrapped ramp covers, for `padLooped`'s shift. */
export function lapsOf(headingTrack: readonly Key<number>[]): number {
  if (headingTrack.length < 2) return 0;
  const first = headingTrack[0]!.value;
  const last = headingTrack[headingTrack.length - 1]!.value;
  return Math.round((last - first) / 360);
}

/** Wrap to (-180, 180] for display. Sampling never needs it; a number box does. */
export function wrapDegrees(degrees: number): number {
  const w = (((degrees % 360) + 540) % 360) - 180;
  return w === -180 ? 180 : w;
}
