import type { HumanoidRig, Vec3 } from "@rigpilot/core";

/**
 * Picking, as pure geometry — no three.js, so the rule that fixes "I clicked my own chest and it selected
 * my hips" is testable at rest instead of needing a GPU.
 *
 * Why handles exist. The body is drawn as one sphere per joint and one cylinder per bone, plus a torso box
 * spanning hips→chest that exists so the girdle does not float (see `rig.mesh.torso`). That box is 28 cm
 * wide and 20 cm deep and its owner is **`hips`, which has no DoFs** — while `spine`, `chest` and `neck`
 * sit on the body's centre line, so their 14 cm spheres clear the box's front face by only ~4 cm. Click the
 * left pectoral to twist the torso and the box is what the ray meets first: the selection becomes the root,
 * the panel says "position and heading are keyed on the clip, not here", and the three joints that actually
 * carry torso `twist` cannot be reached by clicking at all. Growing the visible spheres would fix the click
 * by wrecking proportions that are validated data — so the hit target gets bigger and the body does not.
 *
 * Ranking, not first-hit. Overlapping handles must resolve by *what the user aimed at*: the joint whose
 * centre the click came closest to wins, and its radius only decides whether the click counts at all.
 * Scoring relative to radius instead — the obvious first attempt — is wrong and the pick test catches it:
 * a fat torso handle beats a dead-centre click on the neck beside it, because 3 cm off a 21 cm handle looks
 * better than 1 cm off an 8 cm one. A tie goes to whichever is nearer the camera, which is what makes a
 * side view pick the near shoulder instead of reaching through the body for the far one.
 */

export interface Ray {
  readonly origin: Vec3;
  readonly dir: Vec3; // normalized
}

export interface Handle {
  readonly joint: string;
  readonly center: Vec3;
  readonly radius: number;
}

/** Nothing a person aims at should be smaller than this: 7.5 cm at hip height is ~14 px on a 1080p view. */
export const MIN_HANDLE = 0.075;

/** How much of the joint's own display sphere to keep as a target, so the highlight and the grab agree. */
const DISPLAY_KEEP = 1.6;

/** The joints that live inside `mesh.torso`, and so need the box's width as their target. */
const TORSO_JOINTS = new Set(["hips", "spine", "chest", "neck"]);

/**
 * One handle per joint a person can pose (every DoF-carrying joint plus the root), sized from the rig's own
 * numbers rather than a hard-coded table, so a second rig gets the same treatment.
 */
export function buildHandles(rig: HumanoidRig): Handle[] {
  const rest = rig.restPose.joints;
  const mesh = rig.mesh as { torso?: { halfSize?: Vec3 } };
  const boxHalf = mesh.torso?.halfSize ?? [0, 0, 0];
  const boxReach = Math.hypot(boxHalf[0], boxHalf[2]);

  const out: Handle[] = [];
  for (const j of rig.joints) {
    if (j.axes.length === 0 && j.kind !== "root") continue; // end sites are not poseable
    const at = rest[j.name];
    if (!at) continue; // no rest position means nothing to aim at; never invent one
    const display = (j.radius ?? 0) * DISPLAY_KEEP;
    // the box spans hips→chest, so those get its full half-diagonal; the neck sits above it and needs less
    const reach = TORSO_JOINTS.has(j.name) ? boxReach * (j.name === "neck" ? 0.6 : 0.8) : 0;
    out.push({
      joint: j.name,
      center: [at[0], at[1], at[2]],
      radius: Math.max(display, reach, MIN_HANDLE),
    });
  }
  return out;
}

export interface PickResult {
  readonly joint: string;
  /** How far the ray passed from the handle's centre, in metres. 0 is a dead-centre click. */
  readonly perpendicular: number;
  /** How far along the ray that closest approach sits, for the near-side tie-break. */
  readonly along: number;
}

/** The joint this ray was aimed at, or null when it aimed past every handle. */
export function pickHandle(ray: Ray, handles: readonly Handle[]): PickResult | null {
  let best: PickResult | null = null;
  let bestPerp = Infinity;
  let bestAlong = Infinity;
  for (const h of handles) {
    const c: Vec3 = [
      h.center[0] - ray.origin[0],
      h.center[1] - ray.origin[1],
      h.center[2] - ray.origin[2],
    ];
    const along = c[0] * ray.dir[0] + c[1] * ray.dir[1] + c[2] * ray.dir[2];
    if (along <= 0) continue; // behind the camera
    const d: Vec3 = [
      h.center[0] - (ray.origin[0] + ray.dir[0] * along),
      h.center[1] - (ray.origin[1] + ray.dir[1] * along),
      h.center[2] - (ray.origin[2] + ray.dir[2] * along),
    ];
    const perpendicular = Math.hypot(d[0], d[1], d[2]);
    if (perpendicular > h.radius) continue; // a clean miss of this handle
    const tie = Math.abs(perpendicular - bestPerp) <= 1e-6;
    if (perpendicular < bestPerp - 1e-6 || (tie && along < bestAlong)) {
      best = { joint: h.joint, perpendicular, along };
      bestPerp = perpendicular;
      bestAlong = along;
    }
  }
  return best;
}
