import { describe, expect, it } from "vitest";
import {
  axisTrack,
  easeCurve,
  lapsOf,
  loadHumanoidRig,
  padLooped,
  sampleNumbers,
  setKeyPose,
  unwrapDegrees,
  wrapDegrees,
  type Clip,
  type EaseMode,
  type Key,
  type SemanticValues,
} from "../src/index.js";

/**
 * The curves and the seams. Everything here is checkable by hand on one line of paper, which is the
 * point: an interpolation bug is invisible in a viewport (the motion still looks like motion) and
 * obvious as an equation.
 */
const rig = loadHumanoidRig();
const track = (pts: readonly [number, number, EaseMode?][]): Key<number>[] =>
  pts.map(([frame, value, ease]) => ({ frame, value, ease: ease ?? "auto" }));
const clipAt = (over: Partial<Clip> = {}): Clip => ({
  name: "t",
  fps: 30,
  frameCount: 40,
  loop: false,
  jointKeys: {},
  rootKeys: [],
  ikTargets: {},
  contacts: [],
  revision: 0,
  ...over,
});

const at = (keys: Key<number>[], frame: number, over: Partial<Clip> = {}): number =>
  sampleNumbers(keys, frame, clipAt(over)).value;

describe("easeCurve", () => {
  it("starts at 0 and ends at 1 for every mode", () => {
    for (const ease of [
      "auto",
      "linear",
      "step",
      "ease_in",
      "ease_out",
      "ease_in_out",
    ] as EaseMode[]) {
      const curve = ease === "step" ? "linear" : ease; // step never reaches here; it is a hold, not a curve
      expect(easeCurve(curve, 0)).toBe(0);
      expect(easeCurve(curve, 1)).toBe(1);
    }
  });

  it("is monotone and stays inside 0..1", () => {
    for (const ease of ["linear", "ease_in", "ease_out", "ease_in_out"] as EaseMode[]) {
      let prev = -1;
      for (let i = 0; i <= 100; i++) {
        const v = easeCurve(ease, i / 100);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        prev = v;
      }
    }
  });

  it("delays, front-loads and symmetrises in the middle", () => {
    expect(easeCurve("ease_in", 0.5)).toBeCloseTo(0.125, 12);
    expect(easeCurve("ease_out", 0.5)).toBeCloseTo(0.875, 12);
    expect(easeCurve("ease_in_out", 0.5)).toBeCloseTo(0.5, 12);
    expect(easeCurve("ease_in", 0.25)).toBeLessThan(easeCurve("linear", 0.25));
    expect(easeCurve("ease_out", 0.25)).toBeGreaterThan(easeCurve("linear", 0.25));
    // symmetric: in(t) = 1 - out(1 - t)
    for (const t of [0.1, 0.3, 0.7, 0.9]) {
      expect(easeCurve("ease_in", t)).toBeCloseTo(1 - easeCurve("ease_out", 1 - t), 12);
    }
  });

  it("clamps nonsense t instead of extrapolating", () => {
    expect(easeCurve("ease_in", -3)).toBe(0);
    expect(easeCurve("ease_in", 4)).toBe(1);
  });
});

describe("sampleNumbers", () => {
  it("holds a single key forever, in every direction", () => {
    const k = track([[12, 5]]);
    expect(at(k, 0)).toBe(5);
    expect(at(k, 12)).toBe(5);
    expect(at(k, 39)).toBe(5);
    expect(sampleNumbers(k, 33, clipAt()).method).toBe("hold");
  });

  it("returns 0 for an empty channel, which is the rest pose, not NaN", () => {
    const s = sampleNumbers([], 5, clipAt());
    expect(s.value).toBe(0);
    expect(Number.isFinite(s.value)).toBe(true);
  });

  it("two keys under auto are linear, never step (RECONCILIATION §4.2)", () => {
    const k = track([
      [0, 0],
      [10, 20],
    ]);
    const s = sampleNumbers(k, 5, clipAt());
    expect(s.value).toBeCloseTo(10, 12);
    expect(s.method).toBe("linear");
  });

  it("three keys under auto are Catmull-Rom in the interior and linear at the ends", () => {
    // a straight ramp is the exactness check: a correct C-R reproduces a linear function, so anything
    // other than 15 at the midpoint means the tangents or the basis are wrong
    const k = track([
      [0, 0],
      [10, 10],
      [20, 20],
      [30, 30],
    ]);
    expect(sampleNumbers(k, 15, clipAt()).method).toBe("catmull-rom");
    expect(at(k, 15)).toBeCloseTo(15, 9);
    expect(at(k, 25)).toBeCloseTo(25, 9);
    // the first segment has no key before it: linear, not a reflected phantom
    expect(sampleNumbers(k, 5, clipAt()).method).toBe("linear");
    expect(at(k, 5)).toBeCloseTo(5, 9);
    // and past the last key it holds
    expect(at(k, 39)).toBe(30);
  });

  it("flattens the tangent at a peak, which is what makes it not-linear", () => {
    const k = track([
      [0, 0],
      [10, 100],
      [20, 0],
      [30, 100],
    ]);
    const s = sampleNumbers(k, 11, clipAt());
    expect(s.method).toBe("catmull-rom");
    // hand-computed: t=0.1, h00=0.972, h01=0.028, both tangents 0 -> 100*0.972
    expect(s.value).toBeCloseTo(97.2, 6);
    // linear would have said 90 — this is the assertion that distinguishes the two
    expect(s.value).toBeGreaterThan(90);
    // and a correct C-R never overshoots the keys it was given
    let max = -Infinity;
    for (let f = 10; f <= 20; f++) max = Math.max(max, at(k, f));
    expect(max).toBeLessThanOrEqual(100 + 1e-9);
  });

  it("does not launch past a distant neighbour when keys are unevenly spaced", () => {
    // the naive (v[i+1]-v[i-1])/1 tangent would give this a slope of 100/frame and a huge overshoot
    const k = track([
      [0, 0],
      [2, 100],
      [40, 100],
      [42, 0],
    ]);
    for (let f = 0; f <= 42; f++) {
      const v = at(k, f);
      expect(v).toBeLessThanOrEqual(100 + 1e-6);
      expect(v).toBeGreaterThanOrEqual(-1e-6);
    }
    expect(at(k, 2)).toBe(100);
    expect(at(k, 40)).toBe(100);
    // a plateau between two equal keys stays flat instead of bulging: this is the overshoot the
    // textbook Catmull-Rom slope produces and the monotone tangent removes
    expect(at(k, 20)).toBeCloseTo(100, 9);
    expect(at(k, 30)).toBeCloseTo(100, 9);
  });

  it("step holds the left key and jumps at the right one", () => {
    const k = track([
      [0, 10, "step"],
      [10, 20, "linear"],
    ]);
    expect(at(k, 0)).toBe(10);
    expect(at(k, 9)).toBe(10);
    expect(at(k, 9.999)).toBe(10);
    expect(at(k, 10)).toBe(20);
    expect(at(k, 39)).toBe(20);
  });

  it("applies the ease of the key the segment LEAVES, not the one it arrives at", () => {
    const front = track([
      [0, 10, "ease_out"],
      [10, 20, "linear"],
    ]);
    const back = track([
      [0, 10, "linear"],
      [10, 20, "ease_out"],
    ]);
    expect(at(front, 5)).toBeCloseTo(18.75, 9);
    expect(at(back, 5)).toBeCloseTo(15, 9);
  });

  it("wraps a looping clip's tail into frame 0 instead of holding it", () => {
    const k = track([
      [0, 20, "linear"],
      [20, 0, "linear"],
    ]);
    // frames 20..40 are the walk back to the start pose, which is the whole point of a cycle
    expect(at(k, 30, { loop: true })).toBeCloseTo(10, 9);
    expect(at(k, 39, { loop: true })).toBeCloseTo(19, 9); // frame 39 is one frame short of frame 0's pose (20)
    // not looping: the last key is held, which is what "hold the final pose" means everywhere else
    expect(at(k, 30)).toBe(0);
    expect(at(k, 39)).toBe(0);
  });

  it("lets a looping clip's seam see real neighbours (so frame 0 is Catmull-Rom too)", () => {
    const k = track([
      [0, 0],
      [10, 100],
      [20, 0],
      [30, 100],
    ]);
    expect(sampleNumbers(k, 25, clipAt({ loop: true })).method).toBe("catmull-rom");
    expect(sampleNumbers(k, 25, clipAt()).method).toBe("linear");
    // and the value at frame 0 is the keyed value, wrap or not
    expect(at(k, 0, { loop: true })).toBe(0);
  });

  it("normalizes a negative or oversized frame for a looping clip and clamps for one that is not", () => {
    const k = track([
      [0, 0, "linear"],
      [39, 39, "linear"],
    ]);
    expect(at(k, -1, { loop: true })).toBeCloseTo(39, 9); // -1 is frame 39 of the previous lap
    expect(at(k, 41, { loop: true })).toBeCloseTo(1, 9); // 41 is frame 1
    expect(at(k, -5)).toBe(0);
    expect(at(k, 999)).toBe(39);
  });
});

describe("padLooped", () => {
  it("adds one lap of real keys on each side, shifted by the given amount", () => {
    const k = track([
      [0, 0, "linear"],
      [20, 360, "linear"],
    ]);
    const padded = padLooped(k, 40, 360);
    expect(padded.map(p => p.frame)).toEqual([-20, 0, 20, 40]);
    expect(padded.map(p => p.value)).toEqual([0, 0, 360, 360]);
    // the pad on the right is frame 0 of the NEXT lap: 0 + one full turn, so the ramp keeps going
    expect(padded[3]!.value).toBe(360);
    expect(padded[0]!.ease).toBe("linear"); // the wrap segment is governed by the last key's ease
  });

  it("leaves a one-key channel alone", () => {
    expect(padLooped(track([[5, 7]]), 40, 360)).toHaveLength(1);
  });
});

describe("heading shortest arc", () => {
  it("unwraps so 350 to 10 is 20 degrees of turn", () => {
    expect(unwrapDegrees([350, 10, 20])).toEqual([350, 370, 380]);
    expect(unwrapDegrees([10, -350])).toEqual([10, 10]);
    // exactly 180° takes the negative direction (documented): round(0.5) is 1, so +180 becomes -180
    expect(unwrapDegrees([0, 90, 270, -90])).toEqual([0, 90, -90, -90]);
    expect(unwrapDegrees([350, 10, 20])).toEqual([350, 370, 380]);
  });

  it("counts the revolutions a looping turn covers", () => {
    expect(
      lapsOf(
        track([
          [0, 0],
          [20, 360],
        ]),
      ),
    ).toBe(1);
    expect(
      lapsOf(
        track([
          [0, 10],
          [20, 30],
        ]),
      ),
    ).toBe(0);
    expect(
      lapsOf(
        track([
          [0, 0],
          [20, 720],
        ]),
      ),
    ).toBe(2);
    expect(lapsOf([])).toBe(0);
  });

  it("keeps turning forward across the seam of a looping 360 turn", () => {
    const loopClip = clipAt({ loop: true });
    const k = track([
      [0, 0, "linear"],
      [20, 360, "linear"],
    ]);
    const shift = lapsOf(k) * 360;
    const s = (frame: number): number => sampleNumbers(k, frame, loopClip, shift).value;
    // The authored keys say the turn FINISHES at frame 20, so the tail holds instead of rewinding: a
    // naive wrap (360 at frame 20 -> 0 at frame 40) would spin the body a full turn backwards.
    expect(s(25)).toBeCloseTo(360, 9);
    expect(s(39)).toBeCloseTo(360, 9);
    expect(s(10)).toBeCloseTo(180, 9);
    let prev = -Infinity;
    for (let f = 0; f <= 39; f++) {
      const v = s(f);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9); // never turns back
      prev = v;
    }
    // §7.3's seam: the last frame's pose IS frame 0's pose, in orientation terms
    expect(wrapDegrees(s(39))).toBeCloseTo(wrapDegrees(s(0)), 9);
  });

  it("wrapDegrees keeps the readout in one turn", () => {
    expect(wrapDegrees(0)).toBe(0);
    expect(wrapDegrees(370)).toBe(10);
    expect(wrapDegrees(-350)).toBe(10);
    expect(wrapDegrees(180)).toBe(180);
    expect(wrapDegrees(-180)).toBe(180);
    expect(wrapDegrees(720)).toBe(0);
  });
});

describe("axisTrack", () => {
  it("treats an axis a key does not carry as rest, so a channel never returns undefined", () => {
    const keys: Key<SemanticValues>[] = [
      { frame: 0, value: { flex: 30 }, ease: "linear" },
      { frame: 10, value: { side: 5 }, ease: "linear" },
    ];
    expect(axisTrack(keys, "flex").map(k => k.value)).toEqual([30, 0]);
    expect(axisTrack(keys, "twist").map(k => k.value)).toEqual([0, 0]);
    expect(axisTrack(keys, "side")[1]!.ease).toBe("linear");
  });
});

describe("the authored ease of a key survives the round trip through set_key_pose", () => {
  it("stores ease per key, and a later write to the same frame may change it", () => {
    let c = clipAt();
    c = setKeyPose(rig, c, { frame: 0, joints: { knee_L: { flex: 20 } }, ease: "ease_in" }).clip;
    expect(c.jointKeys.knee_L?.[0]?.ease).toBe("ease_in");
    c = setKeyPose(rig, c, { frame: 0, joints: { knee_L: { side: 0 } } }).clip; // knee has no side -> no write
    expect(c.jointKeys.knee_L?.[0]?.ease).toBe("ease_in");
    c = setKeyPose(rig, c, { frame: 0, joints: { knee_L: { flex: 20 } }, ease: "step" }).clip;
    expect(c.jointKeys.knee_L?.[0]?.ease).toBe("step");
    expect(c.jointKeys.knee_L).toHaveLength(1);
  });
});
