import { describe, expect, it } from "vitest";
import {
  emptyClip,
  keyAtOrBefore,
  keyedFrames,
  loadHumanoidRig,
  normalizeFrame,
  setKeyPose,
  withoutKeys,
  type Clip,
} from "../src/index.js";

/**
 * Key-track mechanics. The rules under test are the ones RECONCILIATION §4.1 ratified, because they are
 * the ones an animation tool gets wrong by default: an unmentioned joint keeps its previous value, and
 * re-sending a frame merges instead of wiping. A clip where "I only meant to bend the knee" flattened the
 * other 20 joints would be unusable through MCP, and the agent would never see why.
 */
const rig = loadHumanoidRig();

const clip = (over: Partial<Clip> = {}): Clip =>
  emptyClip({ name: "t", fps: 30, frameCount: 40, loop: false, ...over });

describe("normalizeFrame", () => {
  it("rounds to whole frames and keeps them inside the clip", () => {
    const c = clip();
    expect(normalizeFrame(12, c)).toEqual({ frame: 12, note: null });
    expect(normalizeFrame(12.4, c)).toEqual({ frame: 12, note: "frame 12.4 rounded to 12" });
    expect(normalizeFrame(12.6, c)).toEqual({ frame: 13, note: "frame 12.6 rounded to 13" });
    expect(normalizeFrame(-3, c)).toEqual({
      frame: 0,
      note: "frame -3 is before the clip start -> 0",
    });
    expect(normalizeFrame(99, c)).toEqual({
      frame: 39,
      note: "frame 99 is past the last frame (39) -> 39",
    });
  });

  it("says so out loud when it moved a key", () => {
    const { clip: c, report } = setKeyPose(rig, clip(), {
      frame: 99,
      joints: { knee_L: { flex: 30 } },
    });
    expect(report.warnings.join(" ")).toContain("past the last frame");
    // the key exists, at the last legal frame — it is never silently dropped on the floor
    expect(keyedFrames(c)).toEqual([39]);
    expect(report.changed.join(" ")).toContain("@ 39");
  });

  it("refuses a non-number frame rather than producing NaN keys", () => {
    const { clip: c, report } = setKeyPose(rig, clip(), {
      frame: Number.NaN,
      joints: { knee_L: { flex: 30 } },
    });
    expect(report.warnings.join(" ")).toContain("not a number");
    expect(keyedFrames(c)).toEqual([0]);
  });
});

describe("setKeyPose", () => {
  it("does not touch a joint the request does not mention", () => {
    const first = setKeyPose(rig, clip(), {
      frame: 0,
      joints: { spine: { flex: 10, side: 3 } },
    }).clip;
    const second = setKeyPose(rig, first, { frame: 10, joints: { knee_L: { flex: 45 } } }).clip;
    expect(Object.keys(second.jointKeys).sort()).toEqual(["knee_L", "spine"]);
    expect(second.jointKeys.spine).toHaveLength(1);
    expect(second.jointKeys.spine?.[0]?.value).toEqual({ flex: 10, side: 3, twist: 0 });
  });

  it("merges into the key at the same frame instead of replacing it", () => {
    const a = setKeyPose(rig, clip(), { frame: 12, joints: { shoulder_L: { flex: 40 } } }).clip;
    const b = setKeyPose(rig, a, { frame: 12, joints: { shoulder_L: { side: 7 } } }).clip;
    expect(b.jointKeys.shoulder_L).toHaveLength(1);
    expect(b.jointKeys.shoulder_L?.[0]?.value).toEqual({ flex: 40, side: 7, twist: 0 });
    const c = setKeyPose(rig, b, { frame: 12, joints: { shoulder_L: { flex: 20 } } }).clip;
    expect(c.jointKeys.shoulder_L?.[0]?.value).toEqual({ flex: 20, side: 7, twist: 0 });
    expect(c.jointKeys.shoulder_L).toHaveLength(1);
  });

  it("refuses an axis a hinge does not have, and keeps the rest of the key", () => {
    const a = setKeyPose(rig, clip(), { frame: 12, joints: { knee_L: { flex: 40 } } }).clip;
    const { clip: b, report } = setKeyPose(rig, a, { frame: 12, joints: { knee_L: { side: 7 } } });
    expect(b.jointKeys.knee_L?.[0]?.value).toEqual({ flex: 40 });
    expect(report.warnings.join(" ")).toContain("knee_L.side");
    expect(report.warnings.join(" ")).toContain("hinge");
  });

  it("inherits unmentioned axes from the previous key, and says which", () => {
    const a = setKeyPose(rig, clip(), {
      frame: 0,
      joints: { shoulder_L: { flex: 90, side: -20, twist: 15 } },
    }).clip;
    const b = setKeyPose(rig, a, { frame: 20, joints: { shoulder_L: { flex: 30 } } }).clip;
    expect(b.jointKeys.shoulder_L?.[1]?.value).toEqual({ flex: 30, side: -20, twist: 15 });
    const reported = setKeyPose(rig, a, { frame: 20, joints: { shoulder_L: { flex: 30 } } });
    expect([...(reported.keys[0]?.inherited ?? [])].sort()).toEqual(["side", "twist"]);
    expect(reported.keys[0]?.axes).toEqual(["flex"]);
    expect(reported.keys[0]?.replaced).toBe(false);
  });

  it("clamps to the rig's hard limits at the door, and reports it", () => {
    const { clip: c, report } = setKeyPose(rig, clip(), {
      frame: 5,
      joints: { knee_L: { flex: 220 } },
    });
    expect(c.jointKeys.knee_L?.[0]?.value.flex).toBe(150);
    expect(report.adjustments).toHaveLength(1);
    expect(report.adjustments[0]?.reason).toContain("above max 150");
  });

  it("keeps the key total over the joint's axes, so an earlier key's value never changes under foot", () => {
    const a = setKeyPose(rig, clip(), {
      frame: 0,
      joints: { hip_L: { flex: 40, side: 5, twist: -10 } },
    }).clip;
    const b = setKeyPose(rig, a, { frame: 20, joints: { hip_L: { flex: 80 } } }).clip;
    expect(b.jointKeys.hip_L?.[1]?.value).toEqual({ flex: 80, side: 5, twist: -10 });
    // Rewriting key 0 does not rewrite key 20: keys hold values, not links. Documented in keys.ts.
    const c = setKeyPose(rig, b, {
      frame: 0,
      joints: { hip_L: { flex: 0, side: 0, twist: 0 } },
    }).clip;
    expect(c.jointKeys.hip_L?.[1]?.value).toEqual({ flex: 80, side: 5, twist: -10 });
  });

  it("reports a bone name and an end site instead of writing nothing silently", () => {
    const { clip: c, report } = setKeyPose(rig, clip(), {
      frame: 4,
      joints: { thigh_L: { flex: 30 }, head_end: { flex: 10 }, knee_L: { twist: 20 } },
    });
    const text = report.warnings.join("\n");
    expect(text).toContain("thigh_L");
    expect(text).toContain("is a bone, not a joint");
    expect(text).toContain("end site");
    expect(text).toContain("knee_L");
    // knee_L has no twist DoF, so that request wrote nothing either way
    expect(c.jointKeys.knee_L).toBeUndefined();
  });

  it("keeps tracks sorted no matter what order keys arrive in", () => {
    let c = clip();
    for (const f of [25, 3, 40, 12, 7])
      c = setKeyPose(rig, c, { frame: f, joints: { knee_L: { flex: f } } }).clip;
    const frames = (c.jointKeys.knee_L ?? []).map(k => k.frame);
    expect(frames).toEqual([3, 7, 12, 25, 39]); // 40 was pulled inside the clip
    expect(keyAtOrBefore(c.jointKeys.knee_L ?? [], 13)?.frame).toBe(12);
    expect(keyAtOrBefore(c.jointKeys.knee_L ?? [], 2)).toBeNull();
  });

  it("turns a non-number into the limit minimum plus an adjustment, never a NaN key", () => {
    const { clip: c, report } = setKeyPose(rig, clip(), {
      frame: 6,
      joints: { knee_L: { flex: Number.NaN }, elbow_R: { flex: "45" as unknown as number } },
    });
    expect(c.jointKeys.knee_L?.[0]?.value.flex).toBe(0);
    expect(c.jointKeys.elbow_R?.[0]?.value.flex).toBe(0);
    // the JSON value never even reaches a track, which is the only reason the bake is NaN-free
    expect(report.adjustments).toHaveLength(2);
    expect(report.adjustments.every(a => a.reason.includes("not a finite number"))).toBe(true);
  });
});

describe("root keys", () => {
  it("store position and heading even when only one of them is mentioned", () => {
    let c = clip();
    c = setKeyPose(rig, c, { frame: 0, root: { position: [0.5, 0.98, 0], heading: 10 } }).clip;
    c = setKeyPose(rig, c, { frame: 20, root: { heading: 190 } }).clip;
    expect(c.rootKeys[1]?.value.position).toEqual([0.5, 0.98, 0]);
    expect(c.rootKeys[1]?.value.heading).toBe(190);
    expect(c.rootKeys[0]?.value.tilt).toEqual({ flex: 0, side: 0 });
  });

  it("fall back to the rig's rest position for the first key's untouched fields", () => {
    const { clip: c } = setKeyPose(rig, clip(), { frame: 0, root: { heading: 90 } });
    expect(c.rootKeys[0]?.value.position).toEqual(rig.root.restPosition);
  });
});

describe("withoutKeys", () => {
  const built = (): Clip => {
    let c = clip();
    c = setKeyPose(rig, c, {
      frame: 0,
      joints: { knee_L: { flex: 10 } },
      root: { heading: 5 },
    }).clip;
    c = setKeyPose(rig, c, {
      frame: 10,
      joints: { knee_L: { flex: 20 }, elbow_R: { flex: 30 } },
      root: { heading: 15 },
    }).clip;
    return c;
  };

  it("removes every key of one joint and leaves the rest of the clip alone", () => {
    const { clip: c, removed } = withoutKeys(built(), { joints: ["knee_L"] });
    expect(removed.map(r => r.joint)).toEqual(["knee_L"]);
    expect(c.jointKeys.knee_L).toBeUndefined();
    expect(c.jointKeys.elbow_R).toHaveLength(1);
    expect(c.rootKeys).toHaveLength(2); // the root belongs to no joint
  });

  it("removes the root key too when the caller only named a frame", () => {
    const { clip: c, rootRemoved } = withoutKeys(built(), { frame: 10 });
    expect(rootRemoved).toEqual([10]);
    expect(c.rootKeys.map(k => k.frame)).toEqual([0]);
    expect(c.jointKeys.knee_L).toHaveLength(1);
    expect(c.jointKeys.elbow_R).toBeUndefined();
  });

  it("reports when nothing matched, rather than returning a quiet success", () => {
    const { removed, rootRemoved } = withoutKeys(clip(), { frame: 3 });
    expect(removed).toEqual([]);
    expect(rootRemoved).toEqual([]);
  });
});
