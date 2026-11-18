import { describe, expect, it } from "vitest";
import { loadHumanoidRig } from "@rigpilot/core";
import {
  axisVerb,
  JOINT_GROUPS,
  labelsFor,
  nounFor,
  POSE_PRESETS,
  poseableJoints,
  presetIssues,
  waveBeats,
} from "../src/labels.js";

/**
 * The UI's promise to a human, checked as data.
 *
 * A label table rots silently: a joint gets added to the rig, the list shows a raw `wrist_R`, and nobody
 * notices for a month. Same for a preset — a preset that needs clamping would teach every newcomer that
 * the app rewrites what they asked for, which is the one lesson §15 forbids. Both are cheap to assert, so
 * they are asserted instead of eyeballed.
 */
const rig = loadHumanoidRig();
const listed = poseableJoints(rig);
const labels = labelsFor(rig);

describe("joint labels", () => {
  it("covers every joint the pose panel lists, and translates it", () => {
    expect(listed.length).toBeGreaterThan(15);
    for (const j of listed) {
      const l = labels.find(x => x.name === j.name);
      expect(l, `no label for ${j.name}`).toBeDefined();
      expect(l!.human).not.toBe(j.name);
      expect(l!.human.length).toBeGreaterThan(3);
      expect(JOINT_GROUPS).toContain(l!.group);
      expect(l!.note.length).toBeGreaterThan(12);
    }
  });

  it("says Left for _L and Right for _R, because the body faces +Z and the user does not", () => {
    for (const l of labels) {
      if (!/_L$/.test(l.name) && !/^left/i.test(l.name)) continue;
      expect(l.human.startsWith("Left"), l.human).toBe(true);
    }
    for (const l of labels.filter(x => /_R$/.test(x.name))) {
      expect(l.human.startsWith("Right"), l.human).toBe(true);
    }
  });

  it("keeps each side in its own group, and the centre in Core", () => {
    const groups = new Map(labels.map(l => [l.name, l.group]));
    expect(groups.get("shoulder_L")).toBe("Left arm");
    expect(groups.get("shoulder_R")).toBe("Right arm");
    expect(groups.get("knee_L")).toBe("Left leg");
    expect(groups.get("toe_R")).toBe("Right leg");
    expect(groups.get("chest")).toBe("Core");
    expect(groups.get("hips")).toBe("Core");
    // the list is grouped, not alphabetical: a person reaches for an arm, then picks a joint
    const order = labels.map(l => l.group);
    expect(order).toEqual(
      [...order].sort((a, b) => JOINT_GROUPS.indexOf(a) - JOINT_GROUPS.indexOf(b)),
    );
  });

  it("gives every DoF a verb, so a slider is never labelled with only its API name", () => {
    for (const j of listed) {
      for (const a of j.axes) {
        const verb = axisVerb(nounFor(j), a.name);
        expect(verb.length, `${j.name}.${a.name}`).toBeGreaterThan(a.name.length);
      }
    }
    expect(axisVerb("knee", "flex")).toBe("bend the leg");
    expect(axisVerb("mystery_joint", "flex")).toBe("bend"); // unknown parts fall back, they never blank out
  });

  it("is a pure remap: no limit, position or axis is invented here", () => {
    for (const j of listed) {
      const l = labels.find(x => x.name === j.name)!;
      expect(l.informative).toBe(j.axes.length === 0);
    }
    // sanity check on the fixture rather than the code, so a rig change cannot pass by accident:
    // 21 articulating joints, of which the root carries no DoF sliders
    expect(rig.joints.filter(j => j.axes.length > 0)).toHaveLength(20);
  });
});

describe("starter poses", () => {
  it("are all inside the rig's authored limits — a preset must never need clamping", () => {
    expect(POSE_PRESETS.length).toBeGreaterThanOrEqual(5);
    for (const p of POSE_PRESETS) {
      expect(
        presetIssues(rig, p.joints),
        `${p.id}: ${presetIssues(rig, p.joints).join("; ")}`,
      ).toEqual([]);
    }
  });

  it("name joints and DoFs that exist, and each one moves something except the rest pose", () => {
    for (const p of POSE_PRESETS) {
      const moved = Object.values(p.joints).reduce((n, axes) => n + Object.keys(axes).length, 0);
      if (p.id === "stand") expect(moved).toBe(0);
      else expect(moved, p.id).toBeGreaterThan(1);
      for (const joint of Object.keys(p.joints)) {
        expect(
          rig.joints.some(j => j.name === joint),
          `${p.id} names ${joint}`,
        ).toBe(true);
      }
    }
  });

  it("are unique by id and readable by name", () => {
    const ids = POSE_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of POSE_PRESETS) {
      expect(p.human.length).toBeGreaterThan(3);
      expect(p.note.length).toBeGreaterThan(8);
    }
  });
});

describe("the 3-pose wave, which is M2's acceptance criterion", () => {
  it("lands on beats inside the clip at any length", () => {
    for (const frameCount of [6, 12, 30, 60, 97]) {
      const beats = waveBeats(frameCount);
      expect(beats).toHaveLength(3);
      const frames = beats.map(b => b.frame);
      expect(frames).toEqual([...frames].sort((a, b) => a - b));
      for (const f of frames) {
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThan(frameCount);
      }
    }
  });

  it("stays inside the limits, so the demo button cannot produce a correction", () => {
    for (const count of [30, 60]) {
      for (const beat of waveBeats(count)) {
        expect(presetIssues(rig, beat.joints), `frame ${beat.frame}`).toEqual([]);
      }
    }
  });
});
