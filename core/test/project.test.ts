import { describe, expect, it } from "vitest";
import {
  clipFingerprint,
  emptyClip,
  loadHumanoidRig,
  parseProject,
  sampleClip,
  serializeProject,
  setContacts,
  setKeyPose,
  type Clip,
  type ProjectFile,
} from "../src/index.js";

/**
 * The project file is the only part of M2 that can lie to you: a clip that loads with something quietly
 * missing looks identical to one that was never keyed. So the round trip is checked three ways — bytes,
 * parsed data, and the pose it samples to at every frame — and every rejection has to come with a word.
 */
const rig = loadHumanoidRig();

const built = (): Clip => {
  let c = emptyClip({ name: "wave", fps: 24, frameCount: 32, loop: true });
  c = setKeyPose(rig, c, {
    frame: 0,
    joints: { shoulder_R: { side: -78, flex: 12 }, elbow_R: { flex: 35 } },
    root: { position: [0, rig.root.restPosition[1], 0], heading: 0 },
    ease: "auto",
  }).clip;
  c = setKeyPose(rig, c, {
    frame: 16,
    joints: { shoulder_R: { side: -20 }, chest: { side: -4, twist: -6 } },
    root: { heading: 12, tilt: { side: 2 } },
    ease: "ease_out",
  }).clip;
  return setContacts(c, [{ effector: "foot_L", part: "flat", start: 0, end: 8 }]).clip;
};

const roundTrip = (
  clip: Clip,
  view?: Parameters<typeof serializeProject>[2],
): {
  text: string;
  again: string;
  project: ProjectFile | null;
  warnings: readonly string[];
  error: string | null;
} => {
  const text = serializeProject(clip, rig, view);
  const parsed = parseProject(text, rig);
  return {
    text,
    again: parsed.project ? serializeProject(parsed.project.clip, rig, parsed.project.view) : "",
    project: parsed.project,
    warnings: parsed.warnings,
    error: parsed.error,
  };
};

describe("serialize / parse", () => {
  it("round-trips a real clip to the byte", () => {
    const r = roundTrip(built(), { frame: 7, selected: ["shoulder_R"], camera: "front" });
    expect(r.error).toBeNull();
    expect(r.warnings).toEqual([]);
    expect(r.again).toBe(r.text);
    expect(r.project?.clip.name).toBe("wave");
    expect(r.project?.clip.fps).toBe(24);
    expect(r.project?.clip.loop).toBe(true);
    expect(r.project?.view).toEqual({ frame: 7, selected: ["shoulder_R"], camera: "front" });
  });

  it("samples identically before and after, at every frame of the clip", () => {
    const clip = built();
    const { project } = roundTrip(clip);
    expect(project).not.toBeNull();
    for (let f = 0; f < clip.frameCount; f++) {
      const a = sampleClip(rig, clip, f);
      const b = sampleClip(rig, project!.clip, f);
      expect(JSON.stringify(b.pose)).toBe(JSON.stringify(a.pose));
    }
  });

  it("preserves contacts and the IK channels it cannot yet sample", () => {
    const withIk: Clip = {
      ...built(),
      ikTargets: {
        hand_L: [
          { frame: 0, ease: "linear", value: { position: [0.4, 1.4, 0.2], space: "body" } },
          {
            frame: 10,
            ease: "linear",
            value: { position: [0.5, 1.5, 0.3], space: "world", pole: [0, 1, 0] },
          },
        ],
      },
    };
    const { project, warnings } = roundTrip(withIk);
    expect(warnings).toEqual([]);
    expect(project?.clip.contacts).toEqual([
      { effector: "foot_L", part: "flat", start: 0, end: 8 },
    ]);
    expect(project?.clip.ikTargets.hand_L).toHaveLength(2);
    expect(project?.clip.ikTargets.hand_L?.[1]?.value.pole).toEqual([0, 1, 0]);
    expect(clipFingerprint(project!.clip)).toBe(clipFingerprint(withIk));
  });

  it("does not care what order the joints were keyed in", () => {
    let a = emptyClip({ name: "x", fps: 30, frameCount: 10 });
    a = setKeyPose(rig, a, { frame: 0, joints: { chest: { flex: 5 } } }).clip;
    a = setKeyPose(rig, a, { frame: 0, joints: { spine: { flex: -5 } } }).clip;
    let b = emptyClip({ name: "x", fps: 30, frameCount: 10 });
    b = setKeyPose(rig, b, { frame: 0, joints: { spine: { flex: -5 } } }).clip;
    b = setKeyPose(rig, b, { frame: 0, joints: { chest: { flex: 5 } } }).clip;
    expect(serializeProject(b, rig)).toBe(serializeProject(a, rig));
  });

  it("writes the fields in a fixed order and one key per line", () => {
    const text = serializeProject(built(), rig);
    expect(text.startsWith('{\n  "format": "rigpilot-project",\n')).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf('"fps"')).toBeLessThan(text.indexOf('"jointKeys"'));
  });
});

describe("parse rejects loudly and keeps what it can", () => {
  const patch = (mutate: (raw: Record<string, unknown>) => void): string => {
    const raw = JSON.parse(serializeProject(built(), rig)) as Record<string, unknown>;
    mutate(raw);
    return JSON.stringify(raw);
  };

  it("refuses a file that is not JSON, and one that is not a project", () => {
    expect(parseProject("{ nope", rig).error).toContain("not valid JSON");
    expect(parseProject("[]", rig).error).toContain("expected a JSON object");
    expect(parseProject('{"format":"other"}', rig).error).toContain("expected");
    expect(parseProject("{}", rig).error).toContain("format");
  });

  it("refuses a version this build cannot read, and warns about a newer one", () => {
    expect(
      parseProject(
        patch(r => (r.version = 0)),
        rig,
      ).error,
    ).toContain("version");
    const future = parseProject(
      patch(r => (r.version = 99)),
      rig,
    );
    expect(future.error).toBeNull();
    expect(future.project).not.toBeNull();
    expect(future.warnings.join(" ")).toContain("newer than this build");
  });

  it("drops keys for joints this rig does not have, and keeps the rest", () => {
    const res = parseProject(
      patch(r => {
        const clip = r.clip as Record<string, Record<string, unknown>>;
        clip.jointKeys ??= {};
        clip.jointKeys.spine_9 = [{ frame: 0, ease: "linear", value: { flex: 10 } }];
      }),
      rig,
    );
    expect(res.warnings.join(" ")).toContain("spine_9");
    expect(res.warnings.join(" ")).toContain("not a joint of this rig");
    expect(res.project?.clip.jointKeys.chest).toBeDefined();
  });

  it("clamps a value that is outside the rig's limits and reports it", () => {
    const res = parseProject(
      patch(r => {
        const clip = r.clip as Record<string, Record<string, unknown>>;
        clip.jointKeys ??= {};
        clip.jointKeys.knee_L = [
          { frame: 0, ease: "linear", value: { flex: 400, side: 0, twist: 0 } },
        ];
      }),
      rig,
    );
    expect(res.project?.clip.jointKeys.knee_L?.[0]?.value.flex).toBe(150);
    expect(res.warnings.join(" ")).toContain("outside the rig's limits");
  });

  it("rounds a fractional frame and says so", () => {
    const res = parseProject(
      patch(r => {
        const clip = r.clip as Record<string, Record<string, unknown>>;
        clip.jointKeys ??= {};
        clip.jointKeys.knee_L = [
          { frame: 4.6, ease: "linear", value: { flex: 10, side: 0, twist: 0 } },
        ];
      }),
      rig,
    );
    expect(res.project?.clip.jointKeys.knee_L?.[0]?.frame).toBe(5);
    expect(res.warnings.join(" ")).toContain("rounded to 5");
  });

  it("shrinks a clip whose settings are out of range, rather than refusing to load", () => {
    const res = parseProject(
      patch(r => {
        const clip = r.clip as Record<string, unknown>;
        clip.fps = 5000;
        clip.frameCount = 1;
      }),
      rig,
    );
    expect(res.error).toBeNull();
    expect(res.project?.clip.fps).toBe(240);
    expect(res.project?.clip.frameCount).toBe(2);
    expect(res.warnings.join(" ")).toContain("outside 1..240");
  });

  it("mentions fields it does not know instead of dropping them silently", () => {
    const res = parseProject(
      patch(r => {
        (r.clip as Record<string, unknown>).furPacks = 4;
        r.notes = "from a 2027 build";
      }),
      rig,
    );
    expect(res.warnings.join(" ")).toContain("furPacks");
    expect(res.warnings.join(" ")).toContain("notes");
    expect(res.project?.clip.name).toBe("wave"); // and it still loaded
  });

  it("tells you when a file is a valid empty clip", () => {
    const res = parseProject(
      JSON.stringify({
        format: "rigpilot-project",
        version: 1,
        rigId: rig.id,
        clip: { name: "nothing" },
      }),
      rig,
    );
    expect(res.error).toBeNull();
    expect(res.project?.clip.jointKeys).toEqual({});
    expect(res.warnings.join(" ")).toContain("no keys");
  });

  it("filters the saved view down to joints and frames that exist", () => {
    const res = parseProject(
      JSON.stringify({
        format: "rigpilot-project",
        version: 1,
        rigId: "some-other-rig",
        clip: { name: "n", fps: 30, frameCount: 10, loop: false, jointKeys: {}, rootKeys: [] },
        view: { frame: 500, selected: ["chest", "hip_9", "knee_L"], camera: "isometric" },
      }),
      rig,
    );
    expect(res.warnings.join(" ")).toContain("was written for rig");
    expect(res.project?.view?.frame).toBe(9);
    expect(res.project?.view?.selected).toEqual(["chest", "knee_L"]);
    expect(res.project?.view?.camera).toBeUndefined(); // not a camera this build knows, so not carried
  });

  it("keeps the file's revision, because undo depth is not the same fact as edit count", () => {
    const clip = { ...built(), revision: 41 };
    const { project } = roundTrip(clip);
    expect(project?.clip.revision).toBe(41);
  });
});

describe("clipFingerprint", () => {
  it("ignores the revision and nothing else", () => {
    const a = built();
    expect(clipFingerprint({ ...a, revision: 999 })).toBe(clipFingerprint({ ...a, revision: 0 }));
    expect(clipFingerprint({ ...a, name: "other" })).not.toBe(clipFingerprint(a));
    expect(clipFingerprint({ ...a, loop: false })).not.toBe(clipFingerprint(a));
  });
});
