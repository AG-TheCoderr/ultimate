import type { HumanoidRig } from "../rig/types.js";
import {
  solve,
  type SemanticPose,
  type SemanticValues,
  type SolveResult,
} from "../kinematics/fk.js";
import type { SampleMethod } from "./interpolation.js";
import { axisTrack, lapsOf, sampleNumbers, unwrapDegrees } from "./interpolation.js";
import { keyedFrames } from "./keys.js";
import type { Clip, Key } from "./types.js";

/**
 * Sampling: `Clip` + frame -> a pose, in VISION §7.2's order. M2 implements steps 1 and 2 (root, then
 * joints); steps 3-6 (IK targets, contacts, foot roll) are M4's and their slots are marked below so the
 * order stays mandatory rather than being rediscovered. Step 7's clamp is report-only, per
 * RECONCILIATION §2.2 — clamping after the contact lock is what re-introduces the slide contacts exist
 * to prevent.
 */

export interface ClipSample {
  /** The frame actually evaluated: wrapped for a looping clip, clamped for a non-looping one. */
  readonly frame: number;
  /** Interpolated degrees and root, exactly as keyed — before any clamping. */
  readonly pose: SemanticPose;
  readonly keyed: { readonly joints: readonly string[]; readonly root: boolean };
  /** How each channel was evaluated, for the timeline caption and for the interpolation tests. */
  readonly methods: Readonly<Record<string, SampleMethod>>;
  /** Channels the clip has keys for but the rig does not have — reported, never skipped silently. */
  readonly ignored: readonly string[];
  readonly solved: SolveResult;
}

/** One key track of numbers, from a track of anything. The ease always rides along with the key. */
function numberTrack<T>(keys: readonly Key<T>[], value: (key: Key<T>) => number): Key<number>[] {
  return keys.map(k => ({ frame: k.frame, value: value(k), ease: k.ease }));
}

/**
 * Evaluate the clip at one frame.
 *
 * `free` is the studio's scratch pose: joints the clip never keyed fall back to it, which is what keeps
 * M1's manual posing alive next to a timeline and keeps RECONCILIATION §4.1's rule ("an unmentioned
 * joint keeps its previous value", not "resets to rest") true for whole channels too. A joint with at
 * least one key is owned by the clip at every frame — outside the key range the clip holds the end key,
 * exactly as a DCC does.
 */
export function sampleClip(
  rig: HumanoidRig,
  clip: Clip,
  frame: number,
  opts: { free?: SemanticPose; mode?: "hard" | "solver" } = {},
): ClipSample {
  const at = clip.loop
    ? ((frame % clip.frameCount) + clip.frameCount) % clip.frameCount
    : Math.min(Math.max(frame, 0), clip.frameCount - 1);

  const joints: Record<string, SemanticValues> = {};
  const keyed: string[] = [];
  const methods: Record<string, SampleMethod> = {};
  const ignored: string[] = [];

  // §7.2 step 1: root. position per component, heading shortest-arc (see unwrapDegrees).
  let root: SemanticPose["root"];
  if (clip.rootKeys.length > 0) {
    const keys = clip.rootKeys;
    const headings = unwrapDegrees(keys.map(k => k.value.heading));
    const headingTrack = keys.map((k, i) => ({
      frame: k.frame,
      value: headings[i]!,
      ease: k.ease,
    }));
    const px = numberTrack(keys, k => k.value.position[0] ?? 0);
    const py = numberTrack(keys, k => k.value.position[1] ?? 0);
    const pz = numberTrack(keys, k => k.value.position[2] ?? 0);
    const tiltFlex = numberTrack(keys, k => k.value.tilt?.flex ?? 0);
    const tiltSide = numberTrack(keys, k => k.value.tilt?.side ?? 0);
    // A loop that turns N full revolutions has to keep turning across the seam, not snap back.
    const shift = lapsOf(headingTrack) * 360;

    const [sx, sy, sz, sh, sf, ss] = [
      sampleNumbers(px, at, clip),
      sampleNumbers(py, at, clip),
      sampleNumbers(pz, at, clip),
      sampleNumbers(headingTrack, at, clip, shift),
      sampleNumbers(tiltFlex, at, clip),
      sampleNumbers(tiltSide, at, clip),
    ] as const;
    root = {
      position: [sx.value, sy.value, sz.value],
      heading: sh.value,
      tilt: { flex: sf.value, side: ss.value },
    };
    methods["root.heading"] = sh.method;
    methods["root.position"] = sx.method;
    methods["root.tilt"] = sf.method;
  } else if (opts.free?.root) {
    root = opts.free.root;
  }

  // §7.2 step 2: joints, per semantic axis. Iterating the RIG rather than the clip's key map is what
  // makes the output order canonical: an authored clip and the same clip reloaded from a file (where
  // `project.ts` sorts channel names) must produce a byte-identical pose, or every downstream diff,
  // cache key and MCP response would jitter for a reason that means nothing.
  const known = new Set<string>();
  for (const spec of rig.joints) {
    known.add(spec.name);
    const track = clip.jointKeys[spec.name];
    if (!track || track.length === 0) continue;
    if (spec.axes.length === 0) {
      ignored.push(spec.name);
      continue;
    }
    const values: SemanticValues = {};
    let used: SampleMethod = "hold";
    for (const axis of spec.axes) {
      const s = sampleNumbers(axisTrack(track, axis.name), at, clip);
      values[axis.name] = s.value;
      used = s.method;
    }
    joints[spec.name] = values;
    keyed.push(spec.name);
    methods[spec.name] = used;
  }
  for (const name of Object.keys(clip.jointKeys)) if (!known.has(name)) ignored.push(name);

  // §7.2 steps 3-6 (M4): interpolate IK targets -> contacts -> two-bone IK inside limits -> foot roll,
  // then re-lock contacts by shifting the hips. They go here, in that order, and nothing moves above it.
  const free = opts.free?.joints;
  const ordered: Record<string, SemanticValues> = {};
  for (const spec of rig.joints) {
    // A joint the clip keyed is the clip's at every frame — including frames outside the key range, where
    // the clip holds its end key. Falling back to `free` there would make a channel flip owners as the
    // playhead moved, which is a pop you can only see in the numbers.
    const fromClip = joints[spec.name];
    if (fromClip) ordered[spec.name] = fromClip;
    else if (free?.[spec.name]) ordered[spec.name] = free[spec.name]!;
  }

  const pose: SemanticPose = { ...(root ? { root } : {}), joints: ordered };
  return {
    frame: at,
    pose,
    keyed: { joints: keyed, root: clip.rootKeys.length > 0 }, // already in rig order
    methods,
    ignored: ignored.sort(),
    // "solver" so a value sitting on a stop may graze; keys are clamped at write time (edit.ts), so this
    // band is only ever reached by a hand-edited project file, and then it is reported.
    solved: solve(rig, pose, { mode: opts.mode ?? "solver" }),
  };
}

/** Snap-to-key for the transport. `keys.keyedFrames` is the single source of "which frames are keyed". */
export function nextKeyFrame(clip: Clip, frame: number): number | null {
  return keyedFrames(clip).find(f => f > frame) ?? null;
}

export function previousKeyFrame(clip: Clip, frame: number): number | null {
  const before = keyedFrames(clip).filter(f => f < frame);
  return before.length ? before[before.length - 1]! : null;
}

/** Seconds, for the transport's time readout. Frame counts stay the unit of record (VISION §4). */
export function frameToSeconds(frame: number, fps: number): number {
  return frame / fps;
}

export function solvePose(
  rig: HumanoidRig,
  pose: SemanticPose,
  mode: "hard" | "solver" = "hard",
): SolveResult {
  return solve(rig, pose, { mode });
}
