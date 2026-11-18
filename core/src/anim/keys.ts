import type { AxisName } from "../rig/types.js";
import type { SemanticValues } from "../kinematics/fk.js";
import type { Clip, EaseMode, Key } from "./types.js";

/**
 * Key track mechanics: the only place that knows how keys are ordered, merged, and filled in.
 *
 * Two rules decide most of animation-tool arguments, and both are here so they are stated once:
 *
 * 1. **Keys are per-joint, not per-frame-snapshot** (RECONCILIATION §4.1). Writing
 *    `{frame: 12, knee_L: {flex: 40}}` must not flatten `spine`, `shoulder_L` and the other 18 joints
 *    to rest, and it must not wipe `knee_L`'s own `side`/`twist` either. So a write merges into the key
 *    at that frame, and any axis the key does not define inherits the nearest value at or before that
 *    frame.
 * 2. **Inheritance resolves at write time, so the data is explicit afterwards.** A re-sampled clip
 *    never depends on lookup order, an exported glTF bake sees the same numbers the file contains, and
 *    `get_studio_state` can hand an agent literal values instead of a diff against an earlier key. The
 *    cost is honest and documented: editing an earlier key does not propagate to later keys that
 *    inherited from it, exactly like a studio whose keys store values rather than links.
 */

/** Frames are integers: a key at 12.5 has no meaning in a 30 fps bake and only makes scrubbing fuzzy. */
export function normalizeFrame(frame: number, clip: Clip): { frame: number; note: string | null } {
  if (!Number.isFinite(frame)) return { frame: 0, note: `frame ${frame} is not a number -> 0` };
  let f = Math.round(frame);
  let note: string | null = null;
  // Compare against what was ASKED, not against the rounded value: `Math.round(x) !== Math.round(x)` is
  // never true, which is how a fractional frame could be silently snapped with no report at all.
  if (f !== frame) note = `frame ${frame} rounded to ${f}`;
  if (f < 0) {
    note = `${note ?? ""}frame ${f} is before the clip start -> 0`.trim();
    f = 0;
  }
  if (f > clip.frameCount - 1) {
    // A key at exactly frameCount would be a duplicate of frame 0 in a looping clip and unreachable
    // otherwise, since playback samples 0..frameCount-1.
    note =
      `${note ?? ""}frame ${f} is past the last frame (${clip.frameCount - 1}) -> ${clip.frameCount - 1}`.trim();
    f = clip.frameCount - 1;
  }
  return { frame: f, note };
}

export function sortKeys<T>(keys: readonly Key<T>[]): Key<T>[] {
  return [...keys].sort((a, b) => a.frame - b.frame);
}

/** The last key at or before `frame`, or null when the channel has not started yet. */
export function keyAtOrBefore<T>(keys: readonly Key<T>[], frame: number): Key<T> | null {
  let found: Key<T> | null = null;
  for (const k of keys) {
    if (k.frame <= frame) found = k;
    else break;
  }
  return found;
}

export function keyAtOrAfter<T>(keys: readonly Key<T>[], frame: number): Key<T> | null {
  for (const k of keys) if (k.frame >= frame) return k;
  return null;
}

/**
 * The two keys a frame lies between, plus `t` in 0..1. Outside the track it holds: `{from: k, to: k}`,
 * which makes every caller branch-free and matches the "hold the first and last key" convention of every
 * DCC. Loop wrap is NOT handled here — `interpolation.ts` pads the track with one lap of real keys on
 * each side instead, so the seam has genuine neighbours (see `padLoopedTrack`). Keeping wrap out of this
 * function is what stops "the clip turns 360° and spins backwards across the seam" from being possible.
 */
export function bracket<T>(
  keys: readonly Key<T>[],
  frame: number,
  clip: Pick<Clip, "loop" | "frameCount">,
): {
  readonly from: Key<T>;
  readonly to: Key<T>;
  readonly fromFrame: number;
  readonly toFrame: number;
  readonly t: number;
  /** Index of `from` in `keys`, so a caller can fetch the neighbour tangents. */
  readonly index: number;
} | null {
  if (keys.length === 0) return null;
  const wrapped = clip.loop
    ? ((frame % clip.frameCount) + clip.frameCount) % clip.frameCount
    : Math.min(Math.max(frame, 0), clip.frameCount - 1);
  const last = keys.length - 1;
  const hold = (i: number) => {
    const k = keys[i]!;
    return { from: k, to: k, fromFrame: k.frame, toFrame: k.frame, t: 0, index: i };
  };
  if (wrapped <= keys[0]!.frame) return hold(0);
  if (wrapped >= keys[last]!.frame) return hold(last);
  for (let i = 0; i < last; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (wrapped >= a.frame && wrapped <= b.frame) {
      const span = b.frame - a.frame;
      return {
        from: a,
        to: b,
        fromFrame: a.frame,
        toFrame: b.frame,
        t: span === 0 ? 0 : (wrapped - a.frame) / span,
        index: i,
      };
    }
  }
  return hold(last);
}

export interface JointKeyEdit {
  readonly joint: string;
  readonly frame: number;
  /** Filled-in axes actually in the key, so the UI can say "keyed 3, asked 1". */
  readonly axes: readonly AxisName[];
  /** Axes copied from an earlier key because the request did not mention them. */
  readonly inherited: readonly AxisName[];
  readonly replaced: boolean;
  readonly notes: readonly string[];
}

/**
 * Merge `values` into `joint`'s key at `frame`, inheriting any axis it does not mention.
 * Returns a new clip; never mutates.
 */
export function withJointKey(
  clip: Clip,
  joint: string,
  axes: readonly AxisName[],
  frame: number,
  values: SemanticValues,
  ease: EaseMode,
): { clip: Clip; edit: JointKeyEdit } {
  const track = clip.jointKeys[joint] ?? [];
  const at = normalizeFrame(frame, clip);
  const existing = track.find(k => k.frame === at.frame);
  const before = keyAtOrBefore(track, at.frame);
  const notes: string[] = [];
  if (at.note) notes.push(at.note);

  const filled: Record<AxisName, number> = { flex: 0, side: 0, twist: 0 };
  const inherited: AxisName[] = [];
  const keyed: AxisName[] = [];
  for (const name of axes) {
    const asked = values[name];
    if (asked === undefined) {
      // Unmentioned axis: keep this key's own value if it had one, else inherit. A joint with no keys
      // yet falls through to 0, which is the rest pose, which is what "no decision" means here.
      filled[name] = existing?.value[name] ?? before?.value[name] ?? 0;
      if (existing?.value[name] === undefined && before) inherited.push(name);
      continue;
    }
    if (typeof asked !== "number" || !Number.isFinite(asked)) {
      notes.push(
        `${joint}.${name} was ${JSON.stringify(asked)}, not a finite number -> held at ${filled[name] ?? 0}`,
      );
      continue;
    }
    filled[name] = asked;
    keyed.push(name);
  }

  const value: SemanticValues = {};
  for (const a of axes) value[a] = filled[a];
  // The request's ease always wins: §9's set_key_pose has no "leave the old ease alone" sentinel, and a
  // half-updated key would be indistinguishable from an animation nobody meant.
  const key: Key<SemanticValues> = { frame: at.frame, value, ease };
  const next = sortKeys(track.filter(k => k.frame !== at.frame).concat(key));
  return {
    clip: { ...clip, jointKeys: { ...clip.jointKeys, [joint]: next } },
    edit: {
      joint,
      frame: at.frame,
      axes: keyed,
      inherited,
      replaced: existing !== undefined,
      notes,
    },
  };
}

/** Root keys hold a whole value (position + heading + tilt), so an unmentioned field inherits too. */
export function withRootKey(
  clip: Clip,
  frame: number,
  value: { position?: Vec3Like; heading?: number; tilt?: { flex?: number; side?: number } },
  ease: EaseMode,
  restPosition: readonly [number, number, number],
): { clip: Clip; edit: { frame: number; replaced: boolean; notes: string[] } } {
  const at = normalizeFrame(frame, clip);
  const track = clip.rootKeys;
  const existing = track.find(k => k.frame === at.frame);
  const before = keyAtOrBefore(track, at.frame);
  const notes: string[] = [];
  if (at.note) notes.push(at.note);

  const prev = existing?.value ?? before?.value;
  const old = prev?.position ?? restPosition;
  const posIn = value.position ?? old;
  // Literal indices, because a tuple read through a variable index is `number | undefined` under
  // noUncheckedIndexedAccess and every one of those would have to be papered over.
  const takeAxis = (i: 0 | 1 | 2, v: number): number => {
    if (Number.isFinite(v)) return v;
    notes.push(
      `root position.${(["x", "y", "z"] as const)[i]} was ${JSON.stringify(v)} -> ${old[i]}`,
    );
    return old[i];
  };
  const position: [number, number, number] = [
    takeAxis(0, posIn[0]),
    takeAxis(1, posIn[1]),
    takeAxis(2, posIn[2]),
  ];
  const heading = Number.isFinite(value.heading) ? (value.heading as number) : (prev?.heading ?? 0);
  if (value.heading !== undefined && !Number.isFinite(value.heading)) {
    notes.push(`root heading was ${JSON.stringify(value.heading)} -> ${heading}`);
  }
  const tiltFlex = value.tilt?.flex ?? prev?.tilt?.flex ?? 0;
  const tiltSide = value.tilt?.side ?? prev?.tilt?.side ?? 0;

  const next = sortKeys(
    track
      .filter(k => k.frame !== at.frame)
      .concat({
        frame: at.frame,
        ease,
        value: {
          position,
          heading,
          tilt: { flex: tiltFlex, side: tiltSide },
        },
      }),
  );
  return {
    clip: { ...clip, rootKeys: next },
    edit: { frame: at.frame, replaced: existing !== undefined, notes },
  };
}

type Vec3Like = readonly [number, number, number];

/** Drop keys by frame, joint, or both. `frame` undefined means every frame of that joint. */
export function withoutKeys(
  clip: Clip,
  opts: { frame?: number; joints?: readonly string[] },
): { clip: Clip; removed: { joint: string; frames: number[] }[]; rootRemoved: number[] } {
  const removed: { joint: string; frames: number[] }[] = [];
  const rootRemoved: number[] = [];
  const wanted = opts.joints && opts.joints.length > 0 ? new Set(opts.joints) : null;
  const jointKeys: Record<string, readonly Key<SemanticValues>[]> = { ...clip.jointKeys };
  for (const [joint, track] of Object.entries(jointKeys)) {
    if (wanted && !wanted.has(joint)) continue;
    const gone = track.filter(k => opts.frame === undefined || k.frame === opts.frame);
    if (gone.length === 0) continue;
    removed.push({ joint, frames: gone.map(k => k.frame) });
    const kept = track.filter(k => !gone.includes(k));
    if (kept.length === 0) delete jointKeys[joint];
    else jointKeys[joint] = kept;
  }
  // Root keys belong to no joint, so they go only when the caller named no joints: `delete_keys` with
  // a bare frame removes the root key too, `delete_keys` for one joint leaves it alone.
  if (!wanted)
    for (const k of clip.rootKeys)
      if (opts.frame === undefined || k.frame === opts.frame) rootRemoved.push(k.frame);
  return {
    clip: {
      ...clip,
      jointKeys,
      ...(wanted ? {} : { rootKeys: clip.rootKeys.filter(k => !rootRemoved.includes(k.frame)) }),
    },
    removed,
    rootRemoved,
  };
}

export function keyedJoints(clip: Clip): string[] {
  return Object.keys(clip.jointKeys).filter(j => (clip.jointKeys[j] ?? []).length > 0);
}

/** Frames that have at least one key anywhere, ascending. Drives the timeline's marker row. */
export function keyedFrames(clip: Clip): number[] {
  const set = new Set<number>();
  for (const track of Object.values(clip.jointKeys)) for (const k of track) set.add(k.frame);
  for (const k of clip.rootKeys) set.add(k.frame);
  return [...set].sort((a, b) => a - b);
}
