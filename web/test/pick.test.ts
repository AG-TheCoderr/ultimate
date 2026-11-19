import { loadHumanoidRig, type Vec3 } from "@rigpilot/core";
import { describe, expect, it } from "vitest";
import { buildHandles, MIN_HANDLE, pickHandle, type Ray } from "../src/three/pick.js";

/**
 * The regression the user reported: "the spheres can be small for rotation in the torso region".
 *
 * These are the only tests in the repo that assert *aim*, because the failure was not in the maths or the
 * data — it was that a click on the chest resolved to the hips, and the hips have no sliders, so the three
 * joints carrying torso `twist` could not be selected by clicking at all. Everything below is plain spheres
 * and rays, which is why it needs no browser.
 */
const rig = loadHumanoidRig();
const handles = buildHandles(rig);

/** A pinhole looking from `eye` at `target`: the same geometry Studio's raycaster produces. */
function ray(eye: Vec3, target: Vec3): Ray {
  const d: Vec3 = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  return { origin: eye, dir: [d[0] / len, d[1] / len, d[2] / len] };
}

const FRONT: Vec3 = [0, 1.25, 3.2]; // the viewer's "front" camera position
const SIDE: Vec3 = [-3.2, 1.25, 0]; // and "side", i.e. the character's right

describe("pick handles", () => {
  it("cover every poseable joint, including the root, and exclude end sites", () => {
    const poseable = rig.joints.filter(j => j.axes.length > 0 || j.kind === "root");
    expect(handles).toHaveLength(poseable.length);
    for (const j of poseable)
      expect(
        handles.some(h => h.joint === j.name),
        j.name,
      ).toBe(true);
    for (const j of rig.joints.filter(x => x.kind === "endSite")) {
      expect(
        handles.some(h => h.joint === j.name),
        j.name,
      ).toBe(false);
    }
  });

  it("are never smaller than the minimum, wherever the display sphere is", () => {
    for (const h of handles) {
      expect(h.radius, h.joint).toBeGreaterThanOrEqual(MIN_HANDLE);
      expect(Number.isFinite(h.radius)).toBe(true);
    }
    // the torso region specifically: its handles have to reach past the box that used to eat the click
    const box = (rig.mesh as { torso: { halfSize: Vec3 } }).torso.halfSize;
    const reach = Math.hypot(box[0], box[2]);
    for (const j of ["hips", "spine", "chest"]) {
      const h = handles.find(x => x.joint === j)!;
      expect(h.radius, j).toBeGreaterThanOrEqual(reach * 0.8);
    }
  });

  it("put the small joints back within reach: the wrist is a target, not a dot", () => {
    const wrist = handles.find(h => h.joint === "wrist_L")!;
    const display = rig.joints.find(j => j.name === "wrist_L")!.radius!;
    expect(display).toBeLessThan(MIN_HANDLE); // this is why it was hard to hit
    expect(wrist.radius).toBe(MIN_HANDLE);
  });
});

describe("aiming at the torso", () => {
  it("selects chest when the ray is aimed at the left pectoral, not hips", () => {
    const hit = pickHandle(ray(FRONT, [0.12, 1.36, 0]), handles);
    expect(hit?.joint).toBe("chest");
  });

  it("selects spine dead-centre in the belly, which used to land on the box's owner", () => {
    const hit = pickHandle(ray(FRONT, [0, 1.16, 0]), handles);
    expect(hit?.joint).toBe("spine");
  });

  it("still answers hips for the pelvis, where the root genuinely is", () => {
    const hit = pickHandle(ray(FRONT, [0, 0.98, 0]), handles);
    expect(hit?.joint).toBe("hips");
  });

  it("gives neck the throat and head the skull, without one swallowing the other", () => {
    expect(pickHandle(ray(FRONT, [0, 1.5, 0]), handles)?.joint).toBe("neck");
    expect(pickHandle(ray(FRONT, [0, 1.7, 0]), handles)?.joint).toBe("head");
  });

  it("gives the collarbone a click on the shoulder top, which had a 3.8 cm sphere", () => {
    expect(pickHandle(ray(FRONT, [0.03, 1.45, 0]), handles)?.joint).toBe("clavicle_L");
  });
});

describe("sides, limbs and misses", () => {
  it("from the side, picks the near shoulder rather than reaching through the body", () => {
    // SIDE is at -X, and -X is the character's RIGHT (§4), so the near one must be shoulder_R
    const hit = pickHandle(ray(SIDE, [0, 1.47, 0]), handles);
    expect(hit?.joint).toBe("shoulder_R");
  });

  it("finds the elbow along the T-pose arm from the front", () => {
    expect(pickHandle(ray(FRONT, [0.53, 1.47, 0]), handles)?.joint).toBe("elbow_L");
    expect(pickHandle(ray(FRONT, [-0.53, 1.47, 0]), handles)?.joint).toBe("elbow_R");
  });

  it("finds the knee and the toe from a front view", () => {
    expect(pickHandle(ray(FRONT, [0.09, 0.51, 0]), handles)?.joint).toBe("knee_L");
    expect(pickHandle(ray(FRONT, [0.09, 0.02, 0.14]), handles)?.joint).toBe("toe_L");
  });

  it("returns null for air, so a miss deselects instead of grabbing the nearest joint", () => {
    // the targets have to miss the *silhouette*, not just the joint: a ray aimed through the chest towards
    // a point behind it passes 0 cm from the spine, and returning "spine" there is the correct answer
    expect(pickHandle(ray(FRONT, [0, 3.2, 0]), handles)).toBeNull(); // over the head
    expect(pickHandle(ray(FRONT, [2.4, 1.1, 0]), handles)).toBeNull(); // way out past the fingertips
    expect(pickHandle(ray(FRONT, [0.5, -0.4, 0]), handles)).toBeNull(); // below the floor
  });

  it("lets a dead-centre click on a small joint beat a near miss on a fat one", () => {
    // the reason the ranking is absolute and not relative to radius: the neck's handle is 2.6x the
    // shoulder's, so a relative score would take the throat for any aim near it
    const atNeck = pickHandle(ray(SIDE, [0, 1.5, 0]), handles);
    expect(atNeck?.joint).toBe("neck");
    const atShoulder = pickHandle(ray(SIDE, [-0.19, 1.47, 0]), handles);
    expect(atShoulder?.joint).toBe("shoulder_R");
  });
});
