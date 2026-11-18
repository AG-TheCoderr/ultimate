import { describe, expect, it } from "vitest";
import { loadHumanoidRig, type AxisName } from "@rigpilot/core";
import { POSE_PRESETS } from "../src/labels.js";
import { ProjectStore } from "../src/store.js";

/**
 * M2's "done when", as a test: a human keys a 3-pose wave, plays it, reloads the page, and it is still
 * there. The pixels are checked in the browser; everything this criterion actually depends on — one door,
 * clamped writes, a file that restores the same studio — is here, because `ProjectStore` touches no DOM.
 */
const rig = loadHumanoidRig();
const store = (): ProjectStore => new ProjectStore(rig);

describe("ProjectStore", () => {
  it("keys a 3-pose wave and every frame of it is a real pose", () => {
    const s = store();
    expect(s.setSettings({ name: "wave", frameCount: 30, fps: 30, loop: true }).warnings).toEqual(
      [],
    );
    const poses: { frame: number; joints: Record<string, Record<string, number>> }[] = [
      { frame: 0, joints: { shoulder_R: { side: -78 }, elbow_R: { flex: 35 } } },
      { frame: 10, joints: { shoulder_R: { side: -20 }, elbow_R: { flex: 8 } } },
      { frame: 20, joints: { shoulder_R: { side: -70 }, elbow_R: { flex: 60 } } },
    ];
    for (const p of poses) {
      s.setFrame(p.frame);
      for (const [joint, axes] of Object.entries(p.joints)) {
        for (const [axis, deg] of Object.entries(axes)) {
          expect(s.setAxis(joint, axis as AxisName, deg)).toEqual([]);
        }
      }
      expect(s.keyPose(Object.keys(p.joints)).warnings).toEqual([]);
    }

    // at a keyed frame the pose is exactly what was keyed
    expect(s.sample(0).pose.joints?.shoulder_R?.side).toBeCloseTo(-78, 6);
    expect(s.sample(10).pose.joints?.shoulder_R?.side).toBeCloseTo(-20, 6);
    expect(s.sample(20).pose.joints?.shoulder_R?.side).toBeCloseTo(-70, 6);

    for (let f = 0; f < 30; f++) {
      const smp = s.sample(f);
      for (const j of rig.joints) {
        const p = smp.solved.joints[j.name]!.position;
        expect(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])).toBe(true);
      }
      // nothing on screen was clamped: keys are legal at the door, so sampling has nothing to forgive
      expect(smp.solved.adjustments).toEqual([]);
      // and the arm stayed inside the range the keys define — no phantom overshoot mid-segment
      const side = smp.pose.joints?.shoulder_R?.side ?? 0;
      expect(side).toBeLessThanOrEqual(-19 + 1e-6);
      expect(side).toBeGreaterThanOrEqual(-78 - 1e-6);
    }

    // the loop seam: frame 30 IS frame 0
    expect(s.sample(30).frame).toBe(0);
    expect(s.sample(30).pose.joints?.shoulder_R?.side).toBeCloseTo(-78, 6);
    expect(s.sample(-1).frame).toBe(29);
  });

  it("reload restores the same studio: clip, playhead, selection and scratch pose", () => {
    const a = store();
    a.setSettings({ frameCount: 24, loop: true });
    a.setFrame(7);
    a.setSelection(["knee_L"]);
    a.setAxis("spine", "flex", 12); // unkeyed -> the scratch pose
    a.setAxis("knee_L", "flex", 40);
    expect(a.keyPose(["knee_L"]).warnings).toEqual([]);

    const text = a.snapshot();
    const b = store();
    const res = b.restoreFrom(text);
    expect(res.error).toBeNull();
    expect(res.warnings).toEqual([]);
    expect(b.frame).toBe(7);
    expect(b.selected).toEqual(["knee_L"]);
    expect(b.sample(7).pose.joints?.knee_L?.flex).toBeCloseTo(40, 6);
    expect(b.get("spine", "flex")).toBe(12);
    expect(b.sample(0).pose.joints?.spine?.flex).toBeCloseTo(12, 6);
    // saving the same studio twice is byte-identical, so a diff in version control means a real change
    expect(b.snapshot()).toBe(text);
  });

  it("auto-keys a joint the clip owns and leaves a joint it does not in the scratch pose", () => {
    const s = store();
    s.setSettings({ frameCount: 20 });
    s.setFrame(4);
    s.setAxis("knee_L", "flex", 30);
    expect(s.clip.jointKeys.knee_L).toBeUndefined(); // free pose, nothing on the timeline
    s.keyPose(["knee_L"]);
    expect(s.clip.jointKeys.knee_L).toHaveLength(1);

    s.setFrame(9);
    s.setAxis("knee_L", "flex", 80); // keyed now, so this writes a key
    expect((s.clip.jointKeys.knee_L ?? []).map(k => k.frame)).toEqual([4, 9]);
    expect(s.sample(9).pose.joints?.knee_L?.flex).toBeCloseTo(80, 6);
    // two keys on a channel are linear by the ratified rule, so the midpoint is the midpoint
    expect(s.sample(6).pose.joints?.knee_L?.flex).toBeCloseTo(50, 6);
    expect(s.sample(6).methods.knee_L).toBe("linear");
    // and past the last key it holds instead of falling back to rest
    expect(s.sample(19).pose.joints?.knee_L?.flex).toBeCloseTo(80, 6);
  });

  it("undo and redo walk the data back but always move the revision forward", () => {
    const s = store();
    const r0 = s.revision;
    s.setFrame(2);
    s.setAxis("hip_L", "flex", 45);
    s.keyPose(["hip_L"]);
    expect(s.revision).toBe(r0 + 1);
    const keyed = s.clip.jointKeys.hip_L?.length ?? 0;

    s.setSettings({ fps: 24 });
    expect(s.clip.fps).toBe(24);
    expect(s.revision).toBe(r0 + 2);
    expect(s.undo()).not.toBeNull();
    expect(s.clip.fps).toBe(30);
    expect(s.revision).toBe(r0 + 3); // the data went back a step; the revision did not
    expect(s.clip.jointKeys.hip_L?.length).toBe(keyed); // the key was never the thing being undone
    s.redo();
    expect(s.clip.fps).toBe(24);
    expect(s.revision).toBe(r0 + 4);
    expect(s.canRedo()).toBe(false);
  });

  it("cannot be talked into an illegal key, because the door clamps first", () => {
    const s = store();
    s.setSelection(["knee_R"]);
    for (let deg = 0; deg <= 400; deg += 37) {
      s.setFrame(deg % 20);
      s.setAxis("knee_R", "flex", deg); // scratch, until there is a key to write onto
      s.keyPose(["knee_R"]); // and the key write is where the clamp has to happen
    }
    const track = s.clip.jointKeys.knee_R ?? [];
    expect(track.length).toBeGreaterThan(5);
    for (const k of track) {
      expect(k.value.flex).toBeLessThanOrEqual(150);
      expect(k.value.flex).toBeGreaterThanOrEqual(0);
    }
  });

  it("refuses to key a joint with no DoFs and says why", () => {
    const s = store();
    expect(s.setAxis("head_end", "flex", 20).join(" ")).toContain("head_end");
    expect(s.values.size).toBe(0);
    expect(s.keyPose(["head_end", "toe_end_L"]).warnings.join(" ")).toContain("skipped");
  });

  it("keeps un-keyed channels out of the clip so `unauthored` stays meaningful", () => {
    const s = store();
    s.setAxis("chest", "twist", 8);
    expect(s.clip.jointKeys.chest).toBeUndefined();
    const sampled = s.sample(3);
    expect(sampled.keyed.joints).toEqual([]);
    // `unauthored` is about the pose handed to the solver, and the scratch value IS in it — what stays
    // true is that nothing about the clip claims this channel
    expect(sampled.solved.unauthored).not.toContain("chest");
    expect(sampled.solved.unauthored).toContain("wrist_L");
    expect(sampled.pose.joints?.chest?.twist).toBe(8);
  });

  it("transport: tick advances at the clip's fps and stops at the end when not looping", () => {
    const s = store();
    s.setSettings({ frameCount: 10, fps: 25, loop: false });
    s.play();
    expect(s.tick(0.04)).toBe(true); // one frame at 25 fps
    expect(s.frame).toBe(1);
    s.tick(0.04 * 3);
    expect(s.frame).toBe(4);
    s.tick(10); // a long tab-away: clamp to the end and stop
    expect(s.frame).toBe(9);
    expect(s.playing).toBe(false);
    expect(s.tick(0.04)).toBe(false);
    s.setSettings({ loop: true });
    s.setFrame(9);
    s.play();
    s.tick(0.08);
    expect(s.frame).toBe(1); // and a loop rolls over instead of stopping
  });
});

describe("the friendly door (presets, wave demo, retiming)", () => {
  it("the Wave demo keys three poses in ONE undo step and starts playing", () => {
    const s = store();
    expect(s.setSettings({ name: "wave", fps: 30, frameCount: 30, loop: true }).warnings).toEqual(
      [],
    );
    const before = s.clip.revision;
    const report = s.waveDemo();
    // the demo's own numbers must never need clamping, or the button would be teaching people that
    // RigPilot silently rewrites what they asked for
    expect(report.warnings).toEqual([]);
    expect(report.adjustments).toEqual([]);
    expect(s.clip.revision).toBe(before + 1);
    // one step, not three: an undo has to mean "the thing I just did"
    expect(s.historyLabels.filter(h => h.label === "3-pose wave demo")).toHaveLength(1);
    expect(s.historyLabels.map(h => h.label)).toEqual([
      "open clip",
      "clip settings",
      "3-pose wave demo",
    ]);
    expect(s.playing).toBe(true);
    expect(s.frame).toBe(0);
    const keyed = Object.entries(s.clip.jointKeys).flatMap(([joint, track]) =>
      (track ?? []).map(k => `${joint}@${k.frame}`),
    );
    expect(keyed.length).toBeGreaterThanOrEqual(12);
    expect(new Set(keyed.map(k => Number(k.split("@")[1]))).size).toBe(3);
    for (let f = 0; f < 30; f++) {
      const sample = s.sample(f);
      expect(sample.solved.adjustments).toEqual([]);
      for (const v of Object.values(sample.pose.joints ?? {})) {
        for (const deg of Object.values(v)) expect(Number.isFinite(deg)).toBe(true);
      }
    }
    s.undo();
    expect(Object.keys(s.clip.jointKeys)).toHaveLength(0);
  });

  it("retiming a frame moves every channel on it, as one step", () => {
    const s = store();
    expect(s.setSettings({ frameCount: 24, fps: 24 }).warnings).toEqual([]);
    s.setAxis("shoulder_R", "side", -40);
    s.setAxis("elbow_R", "flex", 50);
    s.keyJoint("shoulder_R");
    s.keyJoint("elbow_R");
    s.setFrame(10);
    s.setAxis("shoulder_R", "side", -90);
    s.keyJoint("shoulder_R");
    const track = () => (s.clip.jointKeys["shoulder_R"] ?? []).map(k => k.frame);
    expect(track()).toEqual([0, 10]);

    const report = s.retimeKey(10, 14);
    expect(report.warnings).toEqual([]);
    expect(track()).toEqual([0, 14]);
    // the whole frame moves together, so a pose never splits across two frames
    expect((s.clip.jointKeys["elbow_R"] ?? []).map(k => k.frame)).toEqual([0]);
    const at14 = s.clip.jointKeys["shoulder_R"]?.[1];
    expect(at14?.value.side).toBe(-90);
    s.undo();
    expect(track()).toEqual([0, 10]);
  });

  it("refuses to invent an undo step for a retime that changed nothing", () => {
    const s = store();
    const steps = s.historyLabels.length;
    expect(s.retimeKey(3, 9).warnings).toContain("frame 3 has no keys to move");
    expect(s.historyLabels).toHaveLength(steps);
    expect(s.revision).toBe(0);

    s.setAxis("knee_L", "flex", 40);
    s.keyJoint("knee_L");
    expect(s.retimeKey(0, 0).warnings).toEqual(["frame 0 is already there"]);
    expect(s.historyLabels).toHaveLength(steps + 1);
  });

  it("clamps a retime dragged off the end instead of dropping the key", () => {
    const s = store();
    expect(s.setSettings({ frameCount: 10 }).warnings).toEqual([]);
    s.setAxis("neck", "flex", 20);
    s.keyJoint("neck");
    expect(s.retimeKey(0, 999).warnings).toEqual([]);
    expect((s.clip.jointKeys["neck"] ?? []).map(k => k.frame)).toEqual([9]);
  });

  it("a preset on a keyed joint writes a key, and on an unkeyed joint does not", () => {
    const s = store();
    expect(s.setSettings({ frameCount: 12 }).warnings).toEqual([]);
    // head is unkeyed, neck is keyed: the two halves of the auto-key rule in one call
    s.setAxis("neck", "flex", 10);
    s.keyJoint("neck");
    const notes = s.poseFrom({ neck: { flex: -12 }, head: { twist: 20 } });
    expect(notes).toEqual([]);
    expect((s.clip.jointKeys["neck"] ?? []).map(k => k.value.flex)).toEqual([-12]);
    expect(s.clip.jointKeys["head"]).toBeUndefined();
    expect(s.sample(0).pose.joints?.head?.twist).toBe(20);
    expect(s.sample(11).pose.joints?.head?.twist).toBe(20); // scratch holds, it is not animated
  });
});

describe("presets through the same door as a slider", () => {
  it("the rest pose clears the scratch values instead of doing nothing", () => {
    const s = store();
    s.setAxis("neck", "flex", 20);
    expect(s.sample(0).pose.joints?.neck?.flex).toBe(20);
    const rest = POSE_PRESETS.find(p => p.id === "stand")!;
    expect(Object.keys(rest.joints)).toHaveLength(0);
    expect(s.applyPreset(rest)).toEqual([]);
    expect(s.sample(0).pose.joints?.neck?.flex ?? 0).toBe(0);
  });

  it("a real preset moves the body and never invents a key", () => {
    const s = store();
    expect(s.setSettings({ frameCount: 12 }).warnings).toEqual([]);
    const cheer = POSE_PRESETS.find(p => p.id === "cheer")!;
    expect(s.applyPreset(cheer)).toEqual([]);
    expect(s.clip.jointKeys).toEqual({}); // an unowned joint stays a pose, not a key
    expect(s.sample(0).pose.joints?.shoulder_L?.side).toBe(62);
    expect(s.sample(11).pose.joints?.shoulder_L?.side).toBe(62); // holds, because nothing is animated
    // key it once, and the next preset edit lands on a key like any other edit would
    s.keyPose(["shoulder_L"]);
    expect((s.clip.jointKeys["shoulder_L"] ?? []).map(k => k.frame)).toEqual([0]);
    s.setFrame(6);
    expect(s.applyPreset(POSE_PRESETS.find(p => p.id === "reach")!)).toEqual([]);
    expect((s.clip.jointKeys["shoulder_L"] ?? []).map(k => k.frame)).toEqual([0, 6]);
  });
});
