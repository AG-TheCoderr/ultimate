import { describe, expect, it } from "vitest";
import {
  emptyClip,
  frameToSeconds,
  loadHumanoidRig,
  nextKeyFrame,
  previousKeyFrame,
  sampleClip,
  setClipSettings,
  setKeyPose,
  type Clip,
  type Vec3,
} from "../src/index.js";

/**
 * Sampling a clip is where M2 meets the FK that M1 proved, so the assertions are in metres and degrees
 * rather than in interpolation internals: a keyed knee must put the ankle where §6 says it goes.
 */
const rig = loadHumanoidRig();
const clip = (over: Partial<Clip> = {}): Clip =>
  emptyClip({ name: "t", fps: 30, frameCount: 40, loop: false, ...over });
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe("sampleClip", () => {
  it("an empty clip is exactly the rest pose, not an empty object", () => {
    const s = sampleClip(rig, clip(), 7);
    expect(s.frame).toBe(7);
    for (const j of rig.joints) {
      expect(dist(s.solved.joints[j.name]!.position, rig.restPose.joints[j.name]!)).toBeLessThan(
        1e-12,
      );
    }
    expect(s.keyed.joints).toEqual([]);
    expect(s.keyed.root).toBe(false);
  });

  it("a keyed hinge puts the ankle where the bone length and the angle say it goes", () => {
    let c = clip();
    c = setKeyPose(rig, c, { frame: 0, joints: { hip_L: { flex: 0 } }, ease: "linear" }).clip;
    c = setKeyPose(rig, c, { frame: 20, joints: { hip_L: { flex: 90 } }, ease: "linear" }).clip;
    const mid = sampleClip(rig, c, 10);
    expect(mid.pose.joints?.hip_L?.flex).toBeCloseTo(45, 9);
    expect(mid.keyed.joints).toEqual(["hip_L"]);
    const hip = mid.solved.joints.hip_L!.position;
    const knee = mid.solved.joints.knee_L!.position;
    // 0.44 m of thigh at 45°: forward by sin45, down by cos45, and no sideways drift at all
    expect(knee[2] - hip[2]).toBeCloseTo(0.44 * Math.SQRT1_2, 4);
    expect(hip[1] - knee[1]).toBeCloseTo(0.44 * Math.SQRT1_2, 4);
    expect(knee[0] - hip[0]).toBeCloseTo(0, 9);
    // and the length is rigid, which is the invariant the whole viewer rests on
    expect(dist(hip, knee)).toBeCloseTo(
      dist(rig.restPose.joints.hip_L!, rig.restPose.joints.knee_L!),
      9,
    );
  });

  it("holds the end key outside the key range instead of snapping to rest", () => {
    let c = clip();
    c = setKeyPose(rig, c, { frame: 0, joints: { knee_L: { flex: 60 } }, ease: "linear" }).clip;
    c = setKeyPose(rig, c, { frame: 10, joints: { knee_L: { flex: 20 } }, ease: "linear" }).clip;
    expect(sampleClip(rig, c, 39).pose.joints?.knee_L?.flex).toBe(20);
    expect(sampleClip(rig, c, 0).pose.joints?.knee_L?.flex).toBe(60);
    // "before the first key" is a hold, not a mirror of the first segment
    expect(sampleClip(rig, c, 5).pose.joints?.knee_L?.flex).toBeCloseTo(40, 9);
  });

  it("gives the clip every keyed joint and the free pose the rest", () => {
    let c = clip();
    c = setKeyPose(rig, c, { frame: 0, joints: { knee_L: { flex: 30 } }, ease: "linear" }).clip;
    c = setKeyPose(rig, c, { frame: 10, joints: { knee_L: { flex: 90 } }, ease: "linear" }).clip;
    const s = sampleClip(rig, c, 5, {
      free: { joints: { spine: { flex: 12 }, knee_L: { flex: 0 } } },
    });
    expect(s.pose.joints?.spine?.flex).toBe(12); // never keyed -> the studio's scratch value stands
    expect(s.pose.joints?.knee_L?.flex).toBeCloseTo(60, 9); // keyed -> the clip wins, even against a free value
    expect(s.keyed.joints).toEqual(["knee_L"]);
  });

  it("wraps the frame for a looping clip and clamps it otherwise", () => {
    let c = clip({ loop: true });
    c = setKeyPose(rig, c, { frame: 0, joints: { knee_L: { flex: 0 } }, ease: "linear" }).clip;
    c = setKeyPose(rig, c, { frame: 20, joints: { knee_L: { flex: 40 } }, ease: "linear" }).clip;
    expect(sampleClip(rig, c, 40).frame).toBe(0);
    expect(sampleClip(rig, c, 45).frame).toBe(5);
    expect(sampleClip(rig, c, 45).pose.joints?.knee_L?.flex).toBeCloseTo(10, 9);
    expect(sampleClip(rig, clip(), 400).frame).toBe(39);
    expect(sampleClip(rig, clip(), -400).frame).toBe(0);
  });

  it("interpolates the root, and the whole body rides it", () => {
    let c = clip();
    c = setKeyPose(rig, c, {
      frame: 0,
      root: { position: [0, rig.root.restPosition[1], 0], heading: 0 },
      ease: "linear",
    }).clip;
    c = setKeyPose(rig, c, {
      frame: 20,
      root: { position: [2, rig.root.restPosition[1] + 0.5, -1], heading: 90 },
      ease: "linear",
    }).clip;
    const s = sampleClip(rig, c, 10);
    expect(s.keyed.root).toBe(true);
    expect(s.pose.root?.position).toEqual([1, rig.root.restPosition[1] + 0.25, -0.5]);
    expect(s.pose.root?.heading).toBeCloseTo(45, 9);
    // hips are the root, so their world position is the interpolated one verbatim
    expect(s.solved.joints.hips!.position).toEqual([1, rig.root.restPosition[1] + 0.25, -0.5]);
    // and heading really turns the body: the two hips sit side by side at 0°, so at 45° their
    // separation has swung to equal parts X and Z with no vertical tilt. (A thigh hanging straight down
    // is invariant under yaw, which is why the hips are the honest thing to measure here.)
    const rest = rig.restPose.joints;
    const restSpan = [rest.hip_L![0] - rest.hip_R![0], 0, rest.hip_L![2] - rest.hip_R![2]] as const;
    const span = [
      s.solved.joints.hip_L!.position[0] - s.solved.joints.hip_R!.position[0],
      s.solved.joints.hip_L!.position[1] - s.solved.joints.hip_R!.position[1],
      s.solved.joints.hip_L!.position[2] - s.solved.joints.hip_R!.position[2],
    ] as const;
    expect(Math.hypot(span[0], span[1], span[2])).toBeCloseTo(
      Math.hypot(restSpan[0], restSpan[2]),
      9,
    );
    expect(Math.abs(span[0])).toBeCloseTo(Math.abs(span[2]), 9);
    expect(Math.abs(span[1])).toBeCloseTo(0, 9);
    expect(Math.abs(span[0])).toBeGreaterThan(1e-3); // not still square to the camera
  });

  it("reports a channel for a joint this rig does not have instead of sampling it", () => {
    const c: Clip = {
      ...clip(),
      jointKeys: {
        knee_L: [{ frame: 0, value: { flex: 20 }, ease: "linear" }],
        spine_7: [{ frame: 0, value: { flex: 5 }, ease: "linear" }],
      },
    };
    const s = sampleClip(rig, c, 0);
    expect(s.ignored).toEqual(["spine_7"]);
    expect(s.pose.joints?.spine_7).toBeUndefined();
    expect(s.pose.joints?.knee_L?.flex).toBe(20);
  });

  it("grazes and reports a value that only a hand-edited file could contain", () => {
    // keys are clamped at write time, so the only way to get 200° in here is to edit the JSON by hand —
    // and the solver band plus the report is what makes that visible instead of mysterious
    const c: Clip = {
      ...clip(),
      jointKeys: {
        knee_L: [{ frame: 0, value: { flex: 200 }, ease: "linear" }],
        elbow_R: [{ frame: 0, value: { flex: 152 }, ease: "linear" }],
      },
    };
    const s = sampleClip(rig, c, 0);
    expect(s.solved.adjustments).toHaveLength(1); // 152 grazes; 200 does not
    expect(s.solved.adjustments[0]?.applied).toBe(155);
    expect(s.solved.adjustments[0]?.reason).toContain("solver may graze");
    const hard = sampleClip(rig, c, 0, { mode: "hard" });
    expect(hard.solved.adjustments).toHaveLength(2);
    expect(hard.solved.adjustments.map(a => a.applied)).toEqual([150, 150]);
  });

  it("is deterministic: the same clip and frame always agree to the bit", () => {
    let c = clip({ loop: true, frameCount: 32 });
    for (const [f, v] of [
      [0, 0],
      [8, 60],
      [16, 30],
      [24, 90],
    ] as const) {
      c = setKeyPose(rig, c, {
        frame: f,
        joints: { shoulder_R: { side: v }, hip_L: { flex: v / 2 } },
        ease: "auto",
      }).clip;
    }
    const first = JSON.stringify(sampleClip(rig, c, 13).pose);
    for (let i = 0; i < 200; i++) expect(JSON.stringify(sampleClip(rig, c, 13).pose)).toBe(first);
    expect(first).toContain("shoulder_R");
  });
});

describe("clip settings", () => {
  it("pull existing keys in when the clip gets shorter, instead of deleting them", () => {
    let c = clip();
    for (const f of [0, 20, 39])
      c = setKeyPose(rig, c, { frame: f, joints: { knee_L: { flex: f } } }).clip;
    const { clip: short, report } = setClipSettings(c, { frameCount: 24 });
    expect(short.frameCount).toBe(24);
    expect((short.jointKeys.knee_L ?? []).map(k => k.frame)).toEqual([0, 20, 23]);
    expect(report.warnings.join(" ")).toContain("pulled to the nearest frame");
  });

  it("merges keys that collide after a shrink, last one winning", () => {
    let c = clip();
    for (const f of [23, 38])
      c = setKeyPose(rig, c, { frame: f, joints: { knee_L: { flex: f } } }).clip;
    const { clip: short, report } = setClipSettings(c, { frameCount: 24 });
    expect((short.jointKeys.knee_L ?? []).map(k => k.frame)).toEqual([23]);
    expect(short.jointKeys.knee_L?.[0]?.value.flex).toBe(38);
    expect(report.warnings.join(" ")).toContain("1 key(s) fell outside");
  });

  it("keeps fps and frameCount inside sane ranges and says when it moved them", () => {
    const { clip: c, report } = setClipSettings(clip(), { fps: 1000, frameCount: 0 });
    expect(c.fps).toBe(240);
    expect(c.frameCount).toBe(2);
    expect(report.warnings.length).toBe(2);
    expect(report.warnings.join(" ")).toContain("outside 1..240");
    expect(report.warnings.join(" ")).toContain("outside 2..10000");
  });
});

describe("transport helpers", () => {
  const built = (): Clip => {
    let c = clip();
    for (const f of [4, 12, 12, 30])
      c = setKeyPose(rig, c, { frame: f, joints: { knee_L: { flex: f } } }).clip;
    return c;
  };

  it("step to the next and previous keyed frame, skipping a frame with no keys", () => {
    const c = built();
    expect(nextKeyFrame(c, 4)).toBe(12);
    expect(nextKeyFrame(c, 12)).toBe(30);
    expect(nextKeyFrame(c, 30)).toBeNull();
    expect(previousKeyFrame(c, 12)).toBe(4);
    expect(previousKeyFrame(c, 4)).toBeNull();
  });

  it("converts frames to seconds at the clip's fps", () => {
    expect(frameToSeconds(15, 30)).toBe(0.5);
    expect(frameToSeconds(48, 24)).toBe(2);
  });
});
