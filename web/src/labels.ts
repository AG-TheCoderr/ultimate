import type { AxisName, HumanoidRig, RigJoint, SemanticValues } from "@rigpilot/core";

/**
 * The human-facing half of the rig: what a joint is called when you are not an agent, which group it
 * belongs to, what a slider does in plain words, and a handful of poses to start from.
 *
 * This lives in `web/` on purpose. `core/src/rig/humanoid.rig.json` is the contract — the names in it are
 * what an MCP call sends, what a project file stores and what a GLB skin expects, so "shoulder_R" can
 * never become "Left shoulder" there. A first-time animator however has no idea what `clavicle_L.side`
 * means, and §1 insists the studio be fully usable by a human without AI. So the translation belongs to
 * the viewer, derived from the rig rather than parallel to it: nothing here hard-codes a position or a
 * limit, only names. If a second rig arrives, `labelsFor` still covers it through the fallback path.
 */

export const JOINT_GROUPS = ["Core", "Left arm", "Right arm", "Left leg", "Right leg"] as const;
export type JointGroup = (typeof JOINT_GROUPS)[number];

export interface JointLabel {
  /** The rig name, i.e. the name an agent uses. */
  readonly name: string;
  /** What a person would say out loud. */
  readonly human: string;
  readonly group: JointGroup;
  /** One line on what this joint is for, shown under the sliders. */
  readonly note: string;
  /** True when the list entry opens a block with no sliders (the root, an end site). */
  readonly informative: boolean;
}

/** Joint name -> human name. Anything missing falls through to `deriveLabel`, so this is a polish table. */
const HUMAN: Readonly<Record<string, string>> = {
  hips: "Hips (root)",
  spine: "Lower back",
  chest: "Chest",
  neck: "Neck",
  head: "Head",
  clavicle_L: "Left collarbone",
  shoulder_L: "Left shoulder",
  elbow_L: "Left elbow",
  wrist_L: "Left wrist",
  hip_L: "Left hip",
  knee_L: "Left knee",
  ankle_L: "Left ankle",
  toe_L: "Left toes",
  clavicle_R: "Right collarbone",
  shoulder_R: "Right shoulder",
  elbow_R: "Right elbow",
  wrist_R: "Right wrist",
  hip_R: "Right hip",
  knee_R: "Right knee",
  ankle_R: "Right ankle",
  toe_R: "Right toes",
};

const NOTE: Readonly<Record<string, string>> = {
  hips: "The whole body's height, position and facing. Keyed on the timeline, not with sliders.",
  spine:
    "The small of the back. Most poses want a little flex here — a straight spine reads as a mannequin.",
  chest: "Upper back and ribs. Bends with the spine, and twists the shoulders away from the hips.",
  neck: "Aims the face. It is limited on purpose: 40° of flex is a hard stop, not a suggestion.",
  head: "Turns and tilts the skull. Note the sign: negative looks UP.",
  wrist: "Hand on the forearm. Bends up/down, sideways, and rotates. The fingers are out of scope.",
  elbow: "A hinge. One direction only — this is the joint that can never bend backwards.",
  shoulder: "The ball of the arm: swing, raise, rotate.",
  clavicle: "Shrug and protract. Needed for a reach above the head.",
  hip: "The ball of the leg.",
  knee: "A hinge. Only bends one way, and it is the check everyone forgets.",
  ankle: "Dorsiflex and point. Negative lifts the toes, positive points them.",
  toe: "The toe joint: roll onto the ball of the foot, or lift the toes.",
};

/** End sites have no DoFs, so the list entry exists only to explain that. */
const END_NOTE =
  "An end site: it marks where a chain finishes (a hand or a toe tip), so it has no sliders.";

/** Which group a body part belongs to, keyed on the noun rather than the side. */
const GROUP_BY_NOUN: Readonly<Record<string, JointGroup>> = {
  hips: "Core",
  spine: "Core",
  chest: "Core",
  neck: "Core",
  head: "Core",
  shoulder: "Left arm",
  elbow: "Left arm",
  wrist: "Left arm",
  hand: "Left arm",
  hip: "Left leg",
  knee: "Left leg",
  ankle: "Left leg",
  toe: "Left leg",
  foot: "Left leg",
};

const AXIS_WORD: Readonly<Record<AxisName, string>> = {
  flex: "bend",
  side: "side-bend",
  twist: "twist",
};

/** Short verb per axis, refined by the joint, because "flex" alone tells a human nothing. */
const AXIS_VERB: Readonly<Record<string, Partial<Record<AxisName, string>>>> = {
  elbow: { flex: "bend the arm" },
  knee: { flex: "bend the leg" },
  toe: { flex: "curl the toes" },
  ankle: { flex: "toes up / toes down" },
  wrist: { flex: "tilt the hand", twist: "rotate the hand" },
  shoulder: { flex: "swing arm fwd/back", side: "raise arm sideways", twist: "roll the upper arm" },
  hip: { flex: "lift the thigh", side: "open the leg sideways", twist: "rotate the thigh" },
  clavicle: { flex: "shoulders fwd/back", side: "shrug" },
  spine: { flex: "lean fwd/back", side: "lean sideways", twist: "twist the torso" },
  chest: { flex: "lean fwd/back", side: "lean sideways", twist: "twist the torso" },
  neck: { flex: "chin to chest", side: "ear to shoulder", twist: "look left / right" },
  head: { flex: "chin down (− looks up)", side: "tilt the head", twist: "turn the head" },
  hips: { flex: "lean the pelvis", side: "tilt the pelvis" },
};

/** Everything the pose list needs, in list order: group by group, rig order inside a group. */
export function labelsFor(rig: HumanoidRig): JointLabel[] {
  const all = rig.joints.map(j => labelOf(j));
  return JOINT_GROUPS.flatMap(g => all.filter(l => l.group === g));
}

/** The joints worth listing at all: those with DoFs, plus the root. End sites stay out of the panel. */
export function poseableJoints(rig: HumanoidRig): RigJoint[] {
  return rig.joints.filter(j => j.axes.length > 0 || j.kind === "root");
}

function labelOf(j: RigJoint): JointLabel {
  const side = sideOf(j);
  const noun = nounOf(j);
  const tableHuman = HUMAN[j.name];
  const human = tableHuman ?? deriveHuman(j, side, noun);
  const group: JointGroup =
    j.kind === "root"
      ? "Core"
      : side === "L"
        ? nounIs(noun, "leg")
          ? "Left leg"
          : "Left arm"
        : side === "R"
          ? nounIs(noun, "leg")
            ? "Right leg"
            : "Right arm"
          : "Core";
  return {
    name: j.name,
    human,
    group,
    note: NOTE[noun] ?? (j.kind === "endSite" ? END_NOTE : `parent: ${j.parent ?? "—"}`),
    informative: j.axes.length === 0,
  };
}

function sideOf(j: RigJoint): "L" | "R" | null {
  if (/_L$/.test(j.name)) return "L";
  if (/_R$/.test(j.name)) return "R";
  if (/^left/i.test(j.role)) return "L";
  if (/^right/i.test(j.role)) return "R";
  return null;
}

/** `shoulder_L` -> `shoulder`, `leftShoulder` -> `shoulder`: the noun without the side marker. */
function nounOf(j: RigJoint): string {
  const fromName = j.name.replace(/_(?:[LR]|end_[LR])$/, "").replace(/_end$/, "");
  if (fromName && fromName !== j.name) return fromName;
  const fromRole = j.role.replace(/^(?:left|right|Left|Right)/, "").replace(/End$/, "");
  return (fromRole || fromName || j.name).toLowerCase();
}

function nounIs(noun: string, family: "leg" | "arm"): boolean {
  const group = GROUP_BY_NOUN[noun];
  if (!group) return false;
  return group === `Left ${family}`;
}

function deriveHuman(j: RigJoint, side: "L" | "R" | null, noun: string): string {
  const words = noun.replace(/_/g, " ");
  const titled = words.charAt(0).toUpperCase() + words.slice(1);
  return side ? `${side === "L" ? "Left" : "Right"} ${titled}` : titled;
}

export function axisWord(axis: AxisName): string {
  return AXIS_WORD[axis];
}

/**
 * The plain-English verb for one DoF of one joint. Falls back to the axis name rather than to nothing, so
 * a rig with an unexpected joint still gets a usable row instead of a blank label.
 */
export function axisVerb(noun: string, axis: AxisName): string {
  return AXIS_VERB[noun]?.[axis] ?? axisWord(axis);
}

/** The noun for a joint name, exposed so the panel can ask for a verb without re-deriving it. */
export function nounFor(j: RigJoint): string {
  return nounOf(j);
}

// ── starter poses ────────────────────────────────────────────────────────────────────────────────

export interface PosePreset {
  readonly id: string;
  readonly human: string;
  readonly note: string;
  readonly joints: Readonly<Record<string, SemanticValues>>;
}

/**
 * A few poses to grab rather than invent. Values are degrees on the semantic axes — the same numbers an
 * agent sends — and every one of them is inside the authored limits, which `web/test/labels.test.ts`
 * asserts against the rig rather than trusting. A preset that needed clamping would be a bug in the
 * preset, and the report would say so on screen; the test is here so it never has to.
 */
export const POSE_PRESETS: readonly PosePreset[] = [
  {
    id: "stand",
    human: "Stand (T-pose)",
    note: "the rig's rest pose — clears every slider",
    joints: {},
  },
  {
    id: "wave",
    human: "Wave hello",
    note: "right arm up, elbow cocked, head watching the hand",
    joints: {
      shoulder_R: { side: -92, twist: 24 },
      elbow_R: { flex: 74 },
      wrist_R: { flex: 12 },
      clavicle_R: { side: 8 },
      chest: { side: -4, twist: -7 },
      head: { side: 7, twist: 9 },
    },
  },
  {
    id: "ready",
    human: "Athletic ready",
    note: "weight low, knees out, hands up — a good first key for anything that moves",
    joints: {
      hip_L: { flex: 26, side: 6 },
      hip_R: { flex: 26, side: -6 },
      knee_L: { flex: 48 },
      knee_R: { flex: 48 },
      ankle_L: { flex: -22 },
      ankle_R: { flex: -22 },
      spine: { flex: 14 },
      chest: { flex: 8 },
      shoulder_L: { flex: 22, twist: 18 },
      shoulder_R: { flex: 22, twist: -18 },
      elbow_L: { flex: 78 },
      elbow_R: { flex: 78 },
      head: { flex: -6 },
    },
  },
  {
    id: "think",
    human: "Thinking",
    note: "hand to chin, weight on one leg",
    joints: {
      shoulder_R: { flex: 62, side: -18, twist: -46 },
      elbow_R: { flex: 132 },
      wrist_R: { flex: -18 },
      neck: { flex: 14, side: -8 },
      head: { flex: 10, side: -10, twist: -12 },
      chest: { twist: -8, side: -3 },
      hip_L: { side: 8 },
      knee_L: { flex: 12 },
    },
  },
  {
    id: "reach",
    human: "Reach overhead",
    note: "shows why the collarbone exists: the arm alone cannot get there",
    joints: {
      shoulder_L: { side: 68, flex: 10, twist: 22 },
      clavicle_L: { side: 22 },
      elbow_L: { flex: 12 },
      wrist_L: { flex: -14 },
      shoulder_R: { side: -12 },
      spine: { side: -6, flex: -8 },
      chest: { side: -6 },
      head: { flex: -12, side: -4 },
    },
  },
  {
    id: "cheer",
    human: "Both arms up",
    note: "symmetric, so it is also the quickest check that mirroring looks right",
    joints: {
      shoulder_L: { side: 62, flex: 14 },
      shoulder_R: { side: -62, flex: 14 },
      clavicle_L: { side: 18 },
      clavicle_R: { side: 18 },
      elbow_L: { flex: 34 },
      elbow_R: { flex: 34 },
      spine: { flex: -10 },
      chest: { flex: -10 },
      head: { flex: -14 },
      hip_L: { side: 4 },
      hip_R: { side: -4 },
    },
  },
];

/** Any preset value outside the rig's authored limits, as human-readable lines. Empty means all legal. */
export function presetIssues(
  rig: HumanoidRig,
  pose: Readonly<Record<string, SemanticValues>>,
): string[] {
  const out: string[] = [];
  for (const [joint, axes] of Object.entries(pose)) {
    const spec = rig.joints.find(j => j.name === joint);
    if (!spec) {
      out.push(`${joint}: the rig has no joint by that name`);
      continue;
    }
    for (const [axis, deg] of Object.entries(axes ?? {})) {
      const a = spec.axes.find(x => x.name === axis);
      if (!a) {
        out.push(`${joint}.${axis}: this joint has no such DoF`);
        continue;
      }
      if (deg < a.min || deg > a.max) {
        out.push(`${joint}.${axis}: ${deg}° is outside ${a.min}…${a.max}°`);
      }
    }
  }
  return out;
}

// ── the 3-pose wave, which is M2's acceptance criterion ──────────────────────────────────────────

export interface WaveBeat {
  readonly frame: number;
  readonly joints: Readonly<Record<string, SemanticValues>>;
}

/**
 * Three key poses spread across the clip, in thirds. Expressed as fractions of `frameCount` so the demo
 * still lands on beats when the clip is retimed — and as data rather than inline in a click handler so a
 * test can keep every angle inside the limits.
 */
export function waveBeats(frameCount: number): WaveBeat[] {
  const beat = Math.max(2, Math.floor(frameCount / 3));
  const poses: Omit<WaveBeat, "frame">[] = [
    {
      joints: {
        shoulder_R: { side: -78, flex: 12 },
        elbow_R: { flex: 35 },
        chest: { side: -4, twist: -6 },
        head: { side: 6, twist: 8 },
      },
    },
    {
      joints: {
        shoulder_R: { side: -95, twist: 30 },
        elbow_R: { flex: 8 },
        chest: { side: 3, twist: 5 },
        head: { side: -4, twist: -6 },
      },
    },
    {
      joints: {
        shoulder_R: { side: -70, flex: 20 },
        elbow_R: { flex: 60 },
        chest: { side: -6, twist: -8 },
        head: { side: 8 },
      },
    },
  ];
  return poses.map((p, i) => ({
    frame: Math.min(i * beat, Math.max(0, frameCount - 1)),
    joints: p.joints,
  }));
}
