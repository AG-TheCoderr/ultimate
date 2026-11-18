import type { HumanoidRig, RigJoint } from "../rig/types.js";
import { clampAxis, type AxisAdjustment } from "../kinematics/limits.js";
import {
  describePoseIssues,
  recognizePoseNames,
  type RootPose,
  type SemanticValues,
} from "../kinematics/fk.js";
import {
  keyedFrames,
  sortKeys,
  withJointKey,
  withRootKey,
  withoutKeys,
  type JointKeyEdit,
} from "./keys.js";
import { EASE_MODES, type Clip, type Contact, type EaseMode } from "./types.js";

/**
 * Every mutation a clip can take, in one file, because §9's rules are the same for all of them: clamp
 * what is out of range, never throw, and say what happened. M3's MCP tools are thin wrappers over these
 * — which is the whole reason `set_key_pose` and a human dragging a slider end up with identical
 * behaviour, and why the studio report and the agent's `adjusted[]` cannot drift apart.
 */

export interface EditReport {
  /** Values the rig refused to store as asked. Same shape as every other `adjusted[]`. */
  readonly adjustments: readonly AxisAdjustment[];
  /** Everything else the caller needs to know: unknown names, settings that were out of range. */
  readonly warnings: readonly string[];
  /** What changed, for the activity log and for a human's "did that do what I meant?". */
  readonly changed: readonly string[];
}

/** Reports are mostly empty, and a report that must spell out all three fields invites `as any`. */
const rep = (
  over: { adjustments?: AxisAdjustment[]; warnings?: string[]; changed?: string[] } = {},
): EditReport => ({
  adjustments: over.adjustments ?? [],
  warnings: over.warnings ?? [],
  changed: over.changed ?? [],
});

const FPS_RANGE = { min: 1, max: 240 } as const;
const FRAME_RANGE = { min: 2, max: 10000 } as const;

/** §9's `new_clip`. A fresh clip is empty, not resting-pose-keyed: "no keys" must stay visible. */
export function newClip(
  over: { name?: string; fps?: number; frameCount?: number; loop?: boolean } = {},
): { clip: Clip; report: EditReport } {
  const warnings: string[] = [];
  const fps = clampSetting(over.fps ?? 30, FPS_RANGE, "fps", warnings);
  const frameCount = clampSetting(over.frameCount ?? 60, FRAME_RANGE, "frameCount", warnings);
  const name =
    typeof over.name === "string" && over.name.trim() !== "" ? over.name.trim() : "untitled";
  return {
    clip: {
      name,
      fps,
      frameCount,
      loop: over.loop ?? false,
      jointKeys: {},
      rootKeys: [],
      ikTargets: {},
      contacts: [],
      revision: 0,
    },
    report: rep({
      warnings,
      changed: [
        `new clip "${name}" (${fps} fps, ${frameCount} frames, loop ${over.loop ? "on" : "off"})`,
      ],
    }),
  };
}

function clampSetting(
  value: number,
  range: { min: number; max: number },
  name: string,
  warnings: string[],
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`${name} was ${JSON.stringify(value)}, not a number -> ${range.min}`);
    return range.min;
  }
  if (value < range.min || value > range.max) {
    const v = Math.min(Math.max(Math.round(value), range.min), range.max);
    warnings.push(`${name} ${value} is outside ${range.min}..${range.max} -> ${v}`);
    return v;
  }
  return Math.round(value);
}

/** fps / frameCount / loop / name. Shrinking a clip pulls keys in with it rather than deleting them. */
export function setClipSettings(
  clip: Clip,
  settings: { name?: string; fps?: number; frameCount?: number; loop?: boolean },
): { clip: Clip; report: EditReport } {
  const warnings: string[] = [];
  const changed: string[] = [];
  let next: Clip = clip;

  if (settings.name !== undefined) {
    const name = settings.name.trim();
    if (name === "") warnings.push('name was empty -> left as "' + clip.name + '"');
    else {
      next = { ...next, name };
      changed.push(`name "${name}"`);
    }
  }
  if (settings.fps !== undefined) {
    const fps = clampSetting(settings.fps, FPS_RANGE, "fps", warnings);
    if (fps !== next.fps) changed.push(`fps ${next.fps} -> ${fps}`);
    next = { ...next, fps };
  }
  if (settings.loop !== undefined) {
    if (settings.loop !== next.loop) changed.push(`loop ${settings.loop ? "on" : "off"}`);
    next = { ...next, loop: settings.loop };
  }
  if (settings.frameCount !== undefined) {
    const frameCount = clampSetting(settings.frameCount, FRAME_RANGE, "frameCount", warnings);
    if (frameCount !== next.frameCount) {
      const moved = remapFrames(next, frameCount, warnings);
      next = { ...next, frameCount, ...moved };
      changed.push(
        `frameCount ${clip.frameCount} -> ${frameCount} (${keyedFrames(next).length} frames keyed)`,
      );
    }
  }
  return { clip: next, report: rep({ warnings, changed }) };
}

/** Pull every key into 0..frameCount-1, merging collisions. Keys are data, so losing them silently is not an option. */
function remapFrames(
  clip: Clip,
  frameCount: number,
  warnings: string[],
): Pick<Clip, "jointKeys" | "rootKeys"> {
  const last = frameCount - 1;
  let merged = 0;
  const fit = <T>(
    keys: readonly { frame: number; value: T; ease: EaseMode }[],
  ): { frame: number; value: T; ease: EaseMode }[] => {
    const out: { frame: number; value: T; ease: EaseMode }[] = [];
    for (const k of keys) {
      const frame = Math.min(Math.max(k.frame, 0), last);
      if (frame !== k.frame) merged++;
      const clash = out.findIndex(o => o.frame === frame);
      if (clash >= 0)
        out[clash] = { frame, value: k.value, ease: k.ease }; // later key wins, as in set_key_pose
      else out.push({ frame, value: k.value, ease: k.ease });
    }
    return out;
  };
  const jointKeys: Record<
    string,
    readonly { frame: number; value: SemanticValues; ease: EaseMode }[]
  > = {};
  for (const [joint, track] of Object.entries(clip.jointKeys)) {
    const kept = fit(track);
    if (kept.length > 0) jointKeys[joint] = sortKeys(kept);
  }
  if (merged > 0) {
    warnings.push(
      `${merged} key(s) fell outside 0..${last} and were pulled to the nearest frame. Shrink a clip and its poses come with it; nothing is dropped without being counted.`,
    );
  }
  return { jointKeys, rootKeys: sortKeys(fit(clip.rootKeys)) };
}

export interface KeyPoseRequest {
  readonly frame: number;
  readonly joints?: Readonly<Record<string, SemanticValues>>;
  readonly root?: RootPose;
  readonly ease?: EaseMode;
}

/**
 * §9's `set_key_pose`. Values are clamped to the joint's hard limits HERE, at the door, not at sample
 * time: a clip should not be able to contain a backwards knee, so validation (§10) gets to assume the
 * keys are legal and report only what the *solver* had to graze.
 */
export function setKeyPose(
  rig: HumanoidRig,
  clip: Clip,
  request: KeyPoseRequest,
): { clip: Clip; report: EditReport; keys: JointKeyEdit[] } {
  // Typed as EaseMode, but this is also the door a JSON body from the relay comes through, so the value
  // is checked rather than trusted. A bad ease must not become a bad key.
  const asked: EaseMode | undefined = request.ease;
  const ease: EaseMode = asked !== undefined && EASE_MODES.includes(asked) ? asked : "auto";
  const warnings: string[] = [];
  const adjustments: AxisAdjustment[] = [];
  const changed: string[] = [];
  if (asked !== undefined && ease !== asked) {
    warnings.push(`ease ${JSON.stringify(asked)} is not one of ${EASE_MODES.join(", ")} -> "auto"`);
  }

  let next = clip;
  const keys: JointKeyEdit[] = [];
  const byName = new Map<string, RigJoint>(rig.joints.map(j => [j.name, j]));

  for (const [name, values] of Object.entries(request.joints ?? {})) {
    const joint = byName.get(name);
    if (!joint) continue; // reported below, once, with the bone hint
    if (joint.axes.length === 0) continue; // end site: reported below, once
    const legal: SemanticValues = {};
    for (const axis of joint.axes) {
      const asked = values?.[axis.name];
      if (asked === undefined) continue;
      const clamped = clampAxis(joint, axis, asked, "hard");
      legal[axis.name] = clamped.value;
      if (clamped.adjustment) adjustments.push(clamped.adjustment);
    }
    // Nothing legal to write (every axis named was bogus, or the object was empty): report and leave the
    // track alone. Stamping a key at the frame anyway would be a no-op the agent has to diff to notice.
    if (Object.keys(legal).length === 0) continue;
    const edited = withJointKey(
      next,
      name,
      joint.axes.map(a => a.name),
      request.frame,
      legal,
      ease,
    );
    next = edited.clip;
    keys.push(edited.edit);
    for (const note of edited.edit.notes) warnings.push(note);
    changed.push(
      `${name} @ ${edited.edit.frame}: ${Object.entries(legal)
        .map(([a, v]) => `${a} ${v.toFixed(1)}°`)
        .join(
          ", ",
        )}${edited.edit.inherited.length ? ` (inherited ${edited.edit.inherited.join(", ")})` : ""}${edited.edit.replaced ? " [replaced]" : ""}`,
    );
  }

  if (request.root !== undefined) {
    const edited = withRootKey(
      next,
      request.frame,
      { position: request.root.position, heading: request.root.heading, tilt: request.root.tilt },
      ease,
      rig.root.restPosition,
    );
    next = edited.clip;
    for (const note of edited.edit.notes) warnings.push(note);
    changed.push(`root @ ${edited.edit.frame}`);
  }

  // Unknown names go through the same reporter the FK path and the UI panel use, so a typo is described
  // identically wherever it is caught.
  const issues = recognizePoseNames(rig, request.joints);
  warnings.push(...describePoseIssues(rig, issues));

  return { clip: next, report: rep({ adjustments, warnings, changed }), keys };
}

/** §9's `delete_keys`. Nothing to delete is a warning, not an error — §9 says never fail. */
export function deleteKeys(
  clip: Clip,
  opts: { frame?: number; joints?: readonly string[] },
): { clip: Clip; report: EditReport } {
  const removed = withoutKeys(clip, opts);
  const changed = removed.removed.map(r => `${r.joint}: removed keys at ${r.frames.join(", ")}`);
  if (removed.rootRemoved.length > 0)
    changed.push(`root: removed keys at ${removed.rootRemoved.join(", ")}`);
  const warnings: string[] =
    changed.length === 0
      ? [
          `no keys matched (frame ${opts.frame ?? "any"}, joints ${opts.joints?.join(", ") ?? "all"}) — nothing was deleted`,
        ]
      : [];
  return { clip: removed.clip, report: rep({ warnings, changed }) };
}

/** Re-curve the segment leaving each matching key. */
export function setEase(
  clip: Clip,
  opts: { ease: EaseMode; frame?: number; joints?: readonly string[] },
): { clip: Clip; report: EditReport } {
  if (!EASE_MODES.includes(opts.ease)) {
    return {
      clip,
      report: rep({
        warnings: [`ease ${JSON.stringify(opts.ease)} is not one of ${EASE_MODES.join(", ")}`],
      }),
    };
  }
  const wanted = opts.joints && opts.joints.length > 0 ? new Set(opts.joints) : null;
  const touched: string[] = [];
  const jointKeys: Record<
    string,
    readonly { frame: number; value: SemanticValues; ease: EaseMode }[]
  > = { ...clip.jointKeys };
  for (const [joint, track] of Object.entries(jointKeys)) {
    if (wanted && !wanted.has(joint)) continue;
    const nextTrack = track.map(k =>
      opts.frame === undefined || k.frame === opts.frame ? { ...k, ease: opts.ease } : k,
    );
    if (nextTrack.some((k, i) => k.ease !== track[i]!.ease)) {
      jointKeys[joint] = nextTrack;
      touched.push(joint);
    }
  }
  const rootKeys = clip.rootKeys.map(k =>
    opts.frame === undefined || k.frame === opts.frame ? { ...k, ease: opts.ease } : k,
  );
  const rootChanged = rootKeys.some((k, i) => k.ease !== clip.rootKeys[i]!.ease);
  return {
    clip: { ...clip, jointKeys, ...(rootChanged ? { rootKeys } : {}) },
    report: rep({
      changed: [
        `${touched.length} joint channel(s)${rootChanged ? " + root" : ""} set to ease "${opts.ease}"${opts.frame !== undefined ? ` at frame ${opts.frame}` : ""}`,
      ],
    }),
  };
}

/** Contacts and IK targets are shaped in M2 and solved in M4; this keeps their frames legal on the way in. */
export function setContacts(
  clip: Clip,
  contacts: readonly { effector: string; part: string; start: number; end: number }[],
): { clip: Clip; report: EditReport } {
  const warnings: string[] = [];
  const known = new Set(["heel", "ball", "toe_tip", "flat"]);
  const effectors = new Set(["hand_L", "hand_R", "foot_L", "foot_R"]);
  const accepted: Contact[] = [];
  for (const c of contacts) {
    if (!effectors.has(c.effector)) {
      warnings.push(`contact effector "${c.effector}" is not one of ${[...effectors].join(", ")}`);
      continue;
    }
    if (!known.has(c.part)) {
      warnings.push(`contact part "${c.part}" is not one of ${[...known].join(", ")}`);
      continue;
    }
    const start = Math.min(Math.max(Math.round(c.start), 0), clip.frameCount - 1);
    const end = Math.min(Math.max(Math.round(c.end), 0), clip.frameCount - 1);
    if (end < start) {
      warnings.push(
        `contact ${c.effector} frames ${c.start}..${c.end} run backwards -> ${end}..${start}`,
      );
      accepted.push({
        effector: c.effector as Contact["effector"],
        part: c.part as Contact["part"],
        start: end,
        end: start,
      });
      continue;
    }
    if (start !== c.start || end !== c.end)
      warnings.push(
        `contact ${c.effector} frames ${c.start}..${c.end} clipped to the clip -> ${start}..${end}`,
      );
    accepted.push({
      effector: c.effector as Contact["effector"],
      part: c.part as Contact["part"],
      start,
      end,
    });
  }
  return {
    clip: { ...clip, contacts: accepted },
    report: rep({ warnings, changed: [`${accepted.length} contact window(s) set`] }),
  };
}

/** Bump the revision. Every mutation goes through here so "revision changed" and "the clip changed" stay the same fact. */
export function bump(clip: Clip, revision = clip.revision + 1): Clip {
  return { ...clip, revision };
}
