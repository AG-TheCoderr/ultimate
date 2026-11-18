import type { AxisName, HumanoidRig } from "../rig/types.js";
import { clampAxis } from "../kinematics/limits.js";
import type { IKTargetValue } from "./types.js";
import { setClipSettings, setContacts, setKeyPose, type EditReport } from "./edit.js";
import { EASE_MODES, type Clip, type EaseMode, type Key, type RootKeyValue } from "./types.js";

/**
 * The project file (`*.rigpilot.json`, §7.6), and the fingerprint `history.ts` uses to decide whether an
 * edit was a no-op.
 *
 * `parseProject` re-runs the file through the same `setKeyPose` / `setClipSettings` / `setContacts` the UI
 * and the MCP tools call, rather than validating JSON on its own. That is deliberate: a second validator
 * is a second opinion, and the two would eventually disagree about what is legal, which is how a saved
 * file becomes a source of bugs instead of a record of them. Keys are re-applied in ascending frame order
 * so inheritance (`keys.ts`) reproduces the authored values exactly.
 */

export const PROJECT_FORMAT = "rigpilot-project";
export const PROJECT_VERSION = 1;

export interface ProjectView {
  readonly frame?: number;
  readonly selected?: readonly string[];
  readonly camera?: "front" | "side" | "top" | "perspective";
  /**
   * The studio's scratch pose: values on joints the clip has never keyed. It is in the file because
   * "reload and it is still there" has to be true for a pose you dragged out by hand too, not only for a
   * pose you keyed — and because silently dropping it would make the timeline a thing that loses work.
   */
  readonly freePose?: Readonly<Record<string, Partial<Record<AxisName, number>>>>;
}

export interface ProjectFile {
  readonly format: typeof PROJECT_FORMAT;
  readonly version: number;
  readonly rigId: string;
  readonly clip: Clip;
  readonly view?: ProjectView;
}

export interface ParseResult {
  readonly project: ProjectFile | null;
  readonly warnings: readonly string[];
  /** Set when the file cannot be used at all. A parse error, not a policy disagreement. */
  readonly error: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const easeOf = (v: unknown): EaseMode =>
  EASE_MODES.includes(v as EaseMode) ? (v as EaseMode) : "auto";

/** Key order is fixed here and nowhere else, so two serializations of equal data are equal strings. */
function clipToJson(clip: Clip): Record<string, unknown> {
  return {
    name: clip.name,
    fps: clip.fps,
    frameCount: clip.frameCount,
    loop: clip.loop,
    revision: clip.revision,
    rootKeys: clip.rootKeys.map(k => ({
      frame: k.frame,
      ease: k.ease,
      value: {
        position: [k.value.position[0], k.value.position[1], k.value.position[2]],
        heading: k.value.heading,
        tilt: { flex: k.value.tilt?.flex ?? 0, side: k.value.tilt?.side ?? 0 },
      },
    })),
    jointKeys: Object.fromEntries(
      Object.keys(clip.jointKeys)
        .sort()
        .map(joint => [
          joint,
          clip.jointKeys[joint]!.map(k => ({
            frame: k.frame,
            ease: k.ease,
            value: {
              flex: k.value.flex ?? 0,
              side: k.value.side ?? 0,
              twist: k.value.twist ?? 0,
            },
          })),
        ]),
    ),
    contacts: clip.contacts.map(c => ({
      effector: c.effector,
      part: c.part,
      start: c.start,
      end: c.end,
    })),
    ikTargets: Object.fromEntries(
      Object.keys(clip.ikTargets)
        .sort()
        .map(e => [
          e,
          clip.ikTargets[e]!.map(k => ({
            frame: k.frame,
            ease: k.ease,
            value: {
              position: [k.value.position[0], k.value.position[1], k.value.position[2]],
              space: k.value.space,
              ...(k.value.pole
                ? { pole: [k.value.pole[0], k.value.pole[1], k.value.pole[2]] }
                : {}),
            },
          })),
        ]),
    ),
  };
}

export function serializeProject(clip: Clip, rig: HumanoidRig, view?: ProjectView): string {
  // view is written in a fixed order too, so two sessions with the same state produce the same bytes
  const viewJson = view
    ? {
        ...(view.frame === undefined ? {} : { frame: view.frame }),
        ...(view.selected ? { selected: [...view.selected].sort() } : {}),
        ...(view.camera ? { camera: view.camera } : {}),
        ...(() => {
          const free = view.freePose;
          if (!free) return {};
          return {
            freePose: Object.fromEntries(
              Object.keys(free)
                .sort()
                .map(j => [j, Object.fromEntries(Object.entries(free[j] ?? {}).sort())]),
            ),
          };
        })(),
      }
    : undefined;
  return `${JSON.stringify({ format: PROJECT_FORMAT, version: PROJECT_VERSION, rigId: rig.id, clip: clipToJson(clip), ...(viewJson ? { view: viewJson } : {}) }, null, 2)}\n`;
}

/** Revision-free, key-order-canonical: what `history.ts` compares to decide "did anything change". */
export function clipFingerprint(clip: Clip): string {
  // revision is normalized rather than removed: clipToJson's key order is the canonical one, and a
  // field that is always 0 fingerprints exactly as well as one that is absent.
  return JSON.stringify(clipToJson({ ...clip, revision: 0 }));
}

/** Not a `Key` yet: the axes are still unknown-shaped until they are read against the rig. */
interface LooseJointKey {
  readonly frame: number;
  readonly ease: EaseMode;
  readonly raw: Readonly<Record<string, unknown>>;
}

function looseKeys(raw: unknown): LooseJointKey[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map(k => ({
      frame: num(k.frame, 0),
      ease: easeOf(k.ease),
      raw: isRecord(k.value) ? k.value : {},
    }))
    .sort((a, b) => a.frame - b.frame);
}

function looseRootKeys(raw: unknown): Key<RootKeyValue>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map(k => {
      const v = isRecord(k.value) ? k.value : {};
      const pos = Array.isArray(v.position) ? v.position : [];
      const tilt = isRecord(v.tilt) ? v.tilt : {};
      return {
        frame: num(k.frame, 0),
        ease: easeOf(k.ease),
        value: {
          position: [num(pos[0], 0), num(pos[1], 0), num(pos[2], 0)],
          heading: num(v.heading, 0),
          tilt: { flex: num(tilt.flex, 0), side: num(tilt.side, 0) },
        } satisfies RootKeyValue,
      };
    })
    .sort((a, b) => a.frame - b.frame);
}

function looseIkKeys(raw: unknown): Key<IKTargetValue>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map(k => {
      const v = isRecord(k.value) ? k.value : {};
      const pos = Array.isArray(v.position) ? v.position : [];
      const pole = Array.isArray(v.pole) ? v.pole : null;
      return {
        frame: num(k.frame, 0),
        ease: easeOf(k.ease),
        value: {
          position: [num(pos[0], 0), num(pos[1], 0), num(pos[2], 0)],
          space: v.space === "world" ? "world" : "body",
          ...(pole
            ? {
                pole: [num(pole[0], 0), num(pole[1], 0), num(pole[2], 0)] as [
                  number,
                  number,
                  number,
                ],
              }
            : {}),
        } satisfies IKTargetValue,
      };
    })
    .sort((a, b) => a.frame - b.frame);
}

/**
 * Rebuild a clip from whatever the file actually contains. `warnings` collects every report the edit
 * functions produced, so a hand-edited or forward-versioned file says what it could not honour.
 */
export function parseProject(text: string, rig: HumanoidRig): ParseResult {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { project: null, warnings: [], error: `not valid JSON: ${(e as Error).message}` };
  }
  if (!isRecord(raw))
    return { project: null, warnings: [], error: "expected a JSON object at the top level" };
  if (raw.format !== PROJECT_FORMAT) {
    return {
      project: null,
      warnings: [],
      error: `format is ${JSON.stringify(raw.format)}, expected "${PROJECT_FORMAT}"`,
    };
  }
  const version = num(raw.version, 0);
  if (version < 1)
    return {
      project: null,
      warnings: [],
      error: `version ${JSON.stringify(raw.version)} is not readable by this build`,
    };
  if (version > PROJECT_VERSION) {
    warnings.push(
      `file version ${version} is newer than this build writes (v${PROJECT_VERSION}) — reading the fields it knows`,
    );
  }
  for (const key of Object.keys(raw)) {
    if (!["format", "version", "rigId", "clip", "view"].includes(key))
      warnings.push(`unknown top-level field "${key}" ignored`);
  }
  if (typeof raw.rigId === "string" && raw.rigId !== rig.id) {
    warnings.push(
      `file was written for rig "${raw.rigId}", this build loads "${rig.id}" — keys are matched by joint name`,
    );
  }

  const clipRaw = isRecord(raw.clip) ? raw.clip : {};
  const base: Clip = {
    name: str(clipRaw.name, "untitled"),
    fps: num(clipRaw.fps, 30),
    frameCount: num(clipRaw.frameCount, 60),
    loop: bool(clipRaw.loop, false),
    jointKeys: {},
    rootKeys: [],
    ikTargets: {},
    contacts: [],
    revision: num(clipRaw.revision, 0),
  };
  // Passing the loaded values back through setClipSettings is the whole validation: the same clamps and
  // the same wording a UI edit gets, with no second copy of the rules to fall out of step with.
  const { clip, report: settingsReport } = setClipSettings(base, {
    name: base.name,
    fps: base.fps,
    frameCount: base.frameCount,
    loop: base.loop,
  });
  warnings.push(...settingsReport.warnings);

  // Re-apply through the authoring path, one key at a time in frame order.
  let next = clip;
  const jointKeysRaw = isRecord(clipRaw.jointKeys) ? clipRaw.jointKeys : {};
  for (const [joint, track] of Object.entries(jointKeysRaw)) {
    const spec = rig.joints.find(j => j.name === joint);
    if (!spec) {
      warnings.push(
        `"${joint}" has keys in the file but is not a joint of this rig — its ${Array.isArray(track) ? track.length : 0} key(s) were dropped`,
      );
      continue;
    }
    if (spec.axes.length === 0) {
      warnings.push(`${joint} is an end site with no DoFs — its keys were dropped`);
      continue;
    }
    for (const key of looseKeys(track)) {
      const values: Record<string, number> = {};
      for (const axis of spec.axes) {
        const asked = key.raw[axis.name];
        if (asked !== undefined) values[axis.name] = num(asked, 0);
      }
      const res = setKeyPose(rig, next, {
        frame: key.frame,
        joints: { [joint]: values },
        ease: key.ease,
      });
      next = res.clip;
      warnings.push(...res.report.warnings);
      for (const a of res.report.adjustments) {
        warnings.push(
          `${a.joint}.${a.axis} @ ${key.frame}: ${a.requested.toFixed(2)}° is outside the rig's limits -> ${a.applied.toFixed(2)}°`,
        );
      }
    }
  }

  const rootTrack = looseRootKeys(clipRaw.rootKeys);
  for (const key of rootTrack) {
    const res = setKeyPose(rig, next, {
      frame: key.frame,
      root: { position: key.value.position, heading: key.value.heading, tilt: key.value.tilt },
      ease: key.ease,
    });
    next = res.clip;
    warnings.push(...res.report.warnings);
  }

  if (Array.isArray(clipRaw.contacts)) {
    const res = setContacts(
      next,
      clipRaw.contacts.filter(isRecord).map(c => ({
        effector: str(c.effector, ""),
        part: str(c.part, ""),
        start: num(c.start, 0),
        end: num(c.end, 0),
      })),
    );
    next = res.clip;
    warnings.push(...res.report.warnings);
  }
  // IK channels are carried through untouched: M2 cannot sample them, but a file round trip must not be
  // a way to lose work. Sampling them is M4's step 3.
  const ikTargets: Record<string, readonly Key<IKTargetValue>[]> = {};
  if (isRecord(clipRaw.ikTargets)) {
    for (const [effector, track] of Object.entries(clipRaw.ikTargets)) {
      if (!rig.ikChains.some(c => c.effector === effector)) {
        warnings.push(`ikTargets.${effector} is not an effector of this rig — dropped`);
        continue;
      }
      const keys = looseIkKeys(track);
      for (const key of keys) {
        if (key.frame > next.frameCount - 1) {
          warnings.push(
            `ikTargets.${effector} key at frame ${key.frame} is past the clip -> ${next.frameCount - 1}`,
          );
          break;
        }
      }
      if (keys.length > 0)
        ikTargets[effector] = keys.map(k =>
          k.frame > next.frameCount - 1 ? { ...k, frame: next.frameCount - 1 } : k,
        );
    }
  }

  for (const key of Object.keys(clipRaw)) {
    if (
      ![
        "name",
        "fps",
        "frameCount",
        "loop",
        "revision",
        "rootKeys",
        "jointKeys",
        "contacts",
        "ikTargets",
      ].includes(key)
    ) {
      warnings.push(`clip field "${key}" is not understood by this build and was ignored`);
    }
  }
  if (Object.keys(jointKeysRaw).length === 0 && rootTrack.length === 0) {
    warnings.push("file has no keys — the clip loads as an empty timeline");
  }

  const viewRaw = isRecord(raw.view) ? raw.view : null;
  // The scratch pose goes through the same limit clamps as a key, because a hand-edited file can put
  // anything in here and a NaN in the view must not become a NaN in the viewport.
  let freePose: Record<string, Partial<Record<AxisName, number>>> | undefined;
  if (isRecord(viewRaw?.freePose)) {
    freePose = {};
    for (const [name, values] of Object.entries(viewRaw?.freePose ?? {})) {
      const joint = rig.joints.find(j => j.name === name);
      if (!joint || joint.axes.length === 0) {
        warnings.push(`view.freePose.${name} is not a posable joint of this rig — dropped`);
        continue;
      }
      const kept: Partial<Record<AxisName, number>> = {};
      for (const [axis, asked] of Object.entries(isRecord(values) ? values : {})) {
        const spec = joint.axes.find(a => a.name === axis);
        if (!spec) {
          warnings.push(`view.freePose.${name}.${axis} is not a DoF of ${name} — dropped`);
          continue;
        }
        const clamped = clampAxis(joint, spec, num(asked, 0), "hard");
        kept[spec.name] = clamped.value;
        if (clamped.adjustment) {
          warnings.push(
            `view.freePose ${clamped.adjustment.requested.toFixed(1)}° is outside ${name}.${spec.name}'s limits -> ${clamped.adjustment.applied.toFixed(1)}°`,
          );
        }
      }
      if (Object.keys(kept).length > 0) freePose[name] = kept;
    }
    if (Object.keys(freePose).length === 0) freePose = undefined;
  }

  const view: ProjectView = viewRaw
    ? {
        ...(freePose ? { freePose } : {}),
        frame: Math.min(Math.max(Math.round(num(viewRaw.frame, 0)), 0), next.frameCount - 1),
        ...(Array.isArray(viewRaw.selected)
          ? {
              selected: viewRaw.selected.filter(
                (j): j is string => typeof j === "string" && rig.joints.some(x => x.name === j),
              ),
            }
          : {}),
        ...(viewRaw.camera === "front" ||
        viewRaw.camera === "side" ||
        viewRaw.camera === "top" ||
        viewRaw.camera === "perspective"
          ? { camera: viewRaw.camera }
          : {}),
      }
    : {};

  return {
    project: {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      rigId: rig.id,
      clip: { ...next, ikTargets, revision: num(clipRaw.revision, next.revision) },
      ...(Object.keys(view).length ? { view } : {}),
    },
    warnings,
    error: null,
  };
}

/** For callers that only want "give me a clip, or tell me why not". */
export function projectClip(
  result: ParseResult,
  fallback: Clip,
): { clip: Clip; report: EditReport; warnings: readonly string[] } {
  if (!result.project)
    return {
      clip: fallback,
      report: { adjustments: [], warnings: result.warnings, changed: [] },
      warnings: result.warnings,
    };
  return {
    clip: result.project.clip,
    report: {
      adjustments: [],
      warnings: result.warnings,
      changed: [`loaded ${result.project.clip.name}`],
    },
    warnings: result.warnings,
  };
}
