import type { AxisName } from "../rig/types.js";
import type { Vec3 } from "../math/vec3.js";
import type { SemanticValues } from "../kinematics/fk.js";

/**
 * The clip model, VISION §7.1. Data only: no evaluation here, so the shape stays the shape that goes
 * into `*.rigpilot.json`, the MCP `get_studio_state` reply, and (M6) a baked glTF animation.
 *
 * Everything is `readonly` on purpose. Undo/redo works by keeping whole clips, so a mutation that
 * quietly edited in place would corrupt history; the edit functions in `edit.ts` return new clips.
 */

/**
 * Ease lives on the key and describes the segment LEAVING it (Blender's convention), because that is
 * the only reading where "ease the arm into the reach" means setting ease on the reach key. The last
 * key's ease is unused unless `loop` is on, where it governs the wrap back to frame 0.
 */
export type EaseMode = "auto" | "linear" | "step" | "ease_in" | "ease_out" | "ease_in_out";

export interface Key<T> {
  readonly frame: number;
  readonly value: T;
  readonly ease: EaseMode;
}

/** A root key: where the hips are, which way they face, and how the body leans. */
export interface RootKeyValue {
  readonly position: Vec3;
  /** Degrees. 0 faces +Z; unwrapped along the track so a 350°→10° turn is 20° of motion. */
  readonly heading: number;
  readonly tilt?: { readonly flex?: number; readonly side?: number } | undefined;
}

/**
 * The four effectors `rig.effectors` names. A union rather than `string` because §10's checks and the
 * contact table both key on it — but `edit.ts` still validates against the RIG, so a rig that renames
 * an effector is a report, never a silent drop.
 */
export type EffectorName = "hand_L" | "hand_R" | "foot_L" | "foot_R";

/**
 * Which part of the foot is planted. `heel`/`ball`/`toe_tip` are the three contact markers per foot
 * (`rig.markers`); `flat` is a mode, not a marker: the sole is level, so the ankle height and both
 * extreme markers are held, which is what a normal stance looks like.
 */
export type ContactPart = "heel" | "ball" | "toe_tip" | "flat";

/** An IK goal, in body space (relative to the root's ground projection + heading) or world space. */
export interface IKTargetValue {
  readonly position: Vec3;
  readonly space: "body" | "world";
  /** Knee/elbow hint as a world direction; omitted means the rig's default pole. */
  readonly pole?: Vec3 | undefined;
}

export interface Contact {
  readonly effector: EffectorName;
  readonly part: ContactPart;
  /** Inclusive frame range the part is planted. */
  readonly start: number;
  readonly end: number;
}

export interface Clip {
  readonly name: string;
  readonly fps: number;
  /** Frames per loop: valid key frames are 0 .. frameCount-1. */
  readonly frameCount: number;
  readonly loop: boolean;
  /**
   * joint -> key poses. Sparse on purpose: a channel that is absent entirely means "the animator never
   * touched this joint", which is NOT the same as a channel full of zeros (RECONCILIATION §4.1).
   */
  readonly jointKeys: Readonly<Record<string, readonly Key<SemanticValues>[]>>;
  readonly rootKeys: readonly Key<RootKeyValue>[];
  /** Shaped now so M4 adds a solver without touching the file format. */
  readonly ikTargets: Readonly<Record<string, readonly Key<IKTargetValue>[]>>;
  readonly contacts: readonly Contact[];
  /** Monotonic; every mutation, including undo and redo, bumps it. */
  readonly revision: number;
}

/** Every axis a joint can be keyed on, filled in. `setKeyPose` inherits the rest (see keys.ts). */
export type KeyedAxes = Readonly<Record<AxisName, number>>;

export const EASE_MODES: readonly EaseMode[] = [
  "auto",
  "linear",
  "step",
  "ease_in",
  "ease_out",
  "ease_in_out",
];

export function emptyClip(
  over: Partial<Pick<Clip, "name" | "fps" | "frameCount" | "loop">> = {},
): Clip {
  return {
    name: over.name ?? "untitled",
    fps: over.fps ?? 30,
    frameCount: over.frameCount ?? 60,
    loop: over.loop ?? false,
    jointKeys: {},
    rootKeys: [],
    ikTargets: {},
    contacts: [],
    revision: 0,
  };
}
