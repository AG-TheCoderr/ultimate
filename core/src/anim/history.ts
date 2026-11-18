import { clipFingerprint } from "./project.js";
import type { Clip } from "./types.js";

/**
 * Undo/redo, §7.5: "every mutating tool is a command in a history stack. Each mutation increments
 * `revision`."
 *
 * Whole-clip snapshots, not diffs. A clip is a few kilobytes of numbers and the diff needed to undo a
 * frame remap or a `mirror_pose` across 21 channels would have to be right about merge order for every
 * one of them — and history is exactly the place where a subtle asymmetry between do and undo hides for
 * months. The limit bounds memory instead of cleverness.
 *
 * Undo bumps the revision rather than rewinding it. If it went backwards, an autosave or an MCP client
 * watching `revision` would see a *smaller* number than one it already handled and conclude it was up to
 * date with a state it had never seen.
 */

export interface HistoryStep {
  readonly label: string;
  readonly clip: Clip;
}

export interface ClipHistory {
  readonly current: () => Clip;
  /** `false` when the clip is unchanged, so a slider drag that lands on the same value adds no step. */
  readonly commit: (clip: Clip, label: string) => boolean;
  /** The moved-to clip, or null at the ends of the stack. `label()` says what it was. */
  readonly undo: () => Clip | null;
  readonly redo: () => Clip | null;
  readonly canUndo: () => boolean;
  readonly canRedo: () => boolean;
  /** Newest last; the entry at `index()` is the current one. Labels are for the UI's tooltip. */
  readonly steps: () => readonly HistoryStep[];
  readonly index: () => number;
  readonly label: () => string;
  /** Adopt a clip as the baseline with no history — page load, autosave restore, project open. */
  readonly replace: (clip: Clip, label?: string) => void;
}

export function createHistory(initial: Clip, limit = 120): ClipHistory {
  // Snapshots store revision 0: the counter belongs to the history, not to a frozen moment in it, and
  // deriving it on read is what lets undo move the counter forward while the data moves back.
  const snapshot = (clip: Clip): Clip => ({ ...clip, revision: 0 });
  let entries: HistoryStep[] = [{ label: "open clip", clip: snapshot(initial) }];
  let cursor = 0;
  let revision = initial.revision;

  const current = (): Clip => ({ ...entries[cursor]!.clip, revision });

  return {
    current,
    commit(clip, label) {
      if (clipFingerprint(clip) === clipFingerprint(current())) return false;
      revision++;
      const next = [...entries.slice(0, cursor + 1), { label, clip: snapshot(clip) }];
      // A redo tail is dropped the moment you edit off an earlier point, as in every editor: keeping it
      // would mean "redo" can resurrect a state that is no longer reachable from anything.
      entries = next.length > limit ? next.slice(next.length - limit) : next;
      cursor = entries.length - 1;
      return true;
    },
    undo() {
      if (cursor === 0) return null;
      cursor--;
      revision++;
      return current();
    },
    redo() {
      if (cursor >= entries.length - 1) return null;
      cursor++;
      revision++;
      return current();
    },
    canUndo: () => cursor > 0,
    canRedo: () => cursor < entries.length - 1,
    steps: () => entries,
    index: () => cursor,
    label: () => entries[cursor]!.label,
    replace(clip, label = "loaded") {
      revision = clip.revision;
      entries = [{ label, clip: snapshot(clip) }];
      cursor = 0;
    },
  };
}
