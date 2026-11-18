import { describe, expect, it } from "vitest";
import {
  clipFingerprint,
  createHistory,
  emptyClip,
  loadHumanoidRig,
  setClipSettings,
  setKeyPose,
  type Clip,
} from "../src/index.js";

/**
 * Undo/redo (§7.5). The property that matters is not "does undo go back" — it is that going back is a
 * *new* state, so anything watching `revision` (autosave, the relay's stale-check) never has to decide
 * whether a smaller number means an older file or just an older moment of the same one.
 */
const rig = loadHumanoidRig();
const clip = (over: Partial<Clip> = {}): Clip =>
  emptyClip({ name: "t", fps: 30, frameCount: 40, ...over });

const keyAt = (c: Clip, frame: number, flex: number): Clip =>
  setKeyPose(rig, c, { frame, joints: { knee_L: { flex } } }).clip;

describe("createHistory", () => {
  it("starts with one step and nothing to undo", () => {
    const h = createHistory(clip());
    expect(h.steps()).toHaveLength(1);
    expect(h.index()).toBe(0);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    expect(h.undo()).toBeNull();
    expect(h.label()).toBe("open clip");
  });

  it("ignores a commit that changed nothing, so a slider dragged back to its own value adds no step", () => {
    const h = createHistory(clip());
    const before = h.current();
    expect(h.commit({ ...before }, "nudge and release")).toBe(false);
    expect(h.steps()).toHaveLength(1);
    expect(h.commit({ ...before, revision: 99 }, "revision only")).toBe(false);
    expect(h.current().revision).toBe(before.revision);
    // while a key AT the rest pose is a real edit: history compares data, not whether anything moved.
    // Dropping it would lose "this joint was deliberately keyed at zero", which M4's IK relies on.
    expect(h.commit(keyAt(before, 0, 0), "keyed at rest")).toBe(true);
    expect(h.canUndo()).toBe(true);
  });

  it("walks back and forward without ever rewinding the revision", () => {
    const h = createHistory(clip());
    let c = h.current();
    for (const [frame, flex] of [
      [0, 10],
      [10, 40],
      [20, 90],
    ] as const) {
      c = keyAt(c, frame, flex);
      expect(h.commit(c, `key ${frame}`)).toBe(true);
    }
    expect(h.current().revision).toBe(3);
    expect(h.steps().map(s => s.label)).toEqual(["open clip", "key 0", "key 10", "key 20"]);

    const back1 = h.undo();
    expect(back1).not.toBeNull();
    expect((h.current().jointKeys.knee_L ?? []).map(k => k.value.flex)).toEqual([10, 40]); // key 20 is gone
    expect(h.current().revision).toBe(4); // ahead of 3, even though the data went back
    expect(h.label()).toBe("key 10");

    const back2 = h.undo();
    expect(h.current().revision).toBe(5);
    expect(back2).not.toBeNull();

    const fwd = h.redo();
    expect(fwd).not.toBeNull();
    expect(h.current().revision).toBe(6);
    expect(h.label()).toBe("key 10");
    expect(h.canRedo()).toBe(true);
  });

  it("drops the redo tail once you branch off an earlier point", () => {
    const h = createHistory(clip());
    let c = keyAt(h.current(), 0, 10);
    h.commit(c, "a");
    c = keyAt(c, 10, 40);
    h.commit(c, "b");
    c = keyAt(c, 20, 90);
    h.commit(c, "c");
    h.undo(); // back to "b"
    const branch = setClipSettings(h.current(), { frameCount: 24 }).clip;
    expect(h.commit(branch, "branch")).toBe(true);
    expect(h.canRedo()).toBe(false);
    expect(h.redo()).toBeNull();
    expect(h.steps().map(s => s.label)).toEqual(["open clip", "a", "b", "branch"]);
    expect(h.current().frameCount).toBe(24);
  });

  it("gives up the oldest steps past the limit and stays consistent", () => {
    const h = createHistory(clip(), 4);
    let c = h.current();
    for (let i = 1; i <= 8; i++) {
      c = keyAt(c, i, i * 5);
      h.commit(c, `key ${i}`);
    }
    expect(h.steps().map(s => s.label)).toEqual(["key 5", "key 6", "key 7", "key 8"]);
    expect(h.index()).toBe(3);
    expect(h.canUndo()).toBe(true);
    const gone = h.undo();
    expect(h.label()).toBe("key 7");
    expect(clipFingerprint(gone!)).toBe(clipFingerprint(h.current()));
  });

  it("replaces the whole stack on load, with no undo into the previous session", () => {
    const h = createHistory(clip());
    h.commit(keyAt(h.current(), 0, 30), "scratch");
    h.replace(keyAt(clip(), 5, 12), "autosave");
    expect(h.canUndo()).toBe(false);
    expect(h.label()).toBe("autosave");
    expect(h.current().revision).toBe(0);
    // the replaced clip is commit-able, and comparing it does not trip over revision
    expect(h.commit(keyAt(h.current(), 5, 12), "same thing again")).toBe(false);
  });

  it("keeps snapshots independent of later edits, which is the whole reason they are frozen", () => {
    const h = createHistory(clip());
    const first = keyAt(h.current(), 0, 10);
    h.commit(first, "one");
    const stored = h.steps()[1]!.clip;
    // Clips are readonly data, so "mutating" one means making a new one; prove the stored entry did not
    // move when the live clip advanced twice.
    let c = keyAt(first, 10, 40);
    h.commit(c, "two");
    c = keyAt(c, 20, 90);
    h.commit(c, "three");
    expect(clipFingerprint(stored)).toBe(clipFingerprint(first));
    expect(h.steps()[1]!.clip.jointKeys.knee_L).toHaveLength(1);
  });
});
