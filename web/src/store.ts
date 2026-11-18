import {
  createHistory,
  deleteKeys,
  emptyClip,
  lastFrame,
  newClip as newClipRecord,
  parseProject,
  sampleClip,
  serializeProject,
  setClipSettings,
  setEase,
  setKeyPose,
  type AxisName,
  type Clip,
  type ClipSample,
  type ClipHistory,
  type EditReport,
  type HumanoidRig,
  type SemanticValues,
} from "@rigpilot/core";

/**
 * The one mutable object in the studio: the clip, its history, the playhead, the selection.
 *
 * VISION §2 says the page is the source of truth for project state, and §2's corollary — "every agent
 * action is visible in the UI" — is only true if there is one door. So `applyEdit` is the only way
 * anything changes the clip: the slider, the timeline buttons, the project file, and (M3) the MCP
 * executor all go through it, which means every one of them gets the same clamping, the same report, the
 * same undo step, the same activity log entry and the same autosave. A mutation that bypassed it would
 * be invisible in exactly the ways that matter.
 */

export const AUTOSAVE_KEY = "rigpilot.project.v1";

export interface LogEntry {
  readonly revision: number;
  readonly label: string;
  readonly when: number;
  readonly report: EditReport;
}

const LOG_LIMIT = 60;

export class ProjectStore {
  private readonly history: ClipHistory;
  private readonly listeners = new Set<() => void>();
  private readonly activity: LogEntry[] = [];
  private frameTime = 0;
  private isPlaying = false;
  private selection: string[] = [];
  /** Un-keyed scratch values, edited by the sliders for joints the clip does not own. */
  readonly values = new Map<string, Map<AxisName, number>>();

  constructor(readonly rig: HumanoidRig) {
    this.history = createHistory(emptyClip({ name: "untitled", fps: 30, frameCount: 60 }));
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────────

  get clip(): Clip {
    return this.history.current();
  }

  get revision(): number {
    return this.clip.revision;
  }

  get frame(): number {
    return this.wrap(this.frameTime);
  }

  /** The float position of the playhead, so playback can be smooth while keys stay on whole frames. */
  get playhead(): number {
    return this.frameTime;
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  get selected(): readonly string[] {
    return this.selection;
  }

  get log(): readonly LogEntry[] {
    return this.activity;
  }

  get historyLabels(): { label: string; index: number; current: boolean }[] {
    return this.history.steps().map((s, i) => ({
      label: s.label,
      index: i,
      current: i === this.history.index(),
    }));
  }

  canUndo(): boolean {
    return this.history.canUndo();
  }

  canRedo(): boolean {
    return this.history.canRedo();
  }

  /** The pose at a frame: the clip where it is keyed, the scratch values where it is not. */
  sample(frame = this.frame): ClipSample {
    return sampleClip(this.rig, this.clip, frame, { free: { joints: this.freePose() } });
  }

  private freePose(): Record<string, SemanticValues> {
    const out: Record<string, SemanticValues> = {};
    for (const [joint, axes] of this.values) out[joint] = Object.fromEntries(axes);
    return out;
  }

  get(joint: string, axis: AxisName): number {
    return this.values.get(joint)?.get(axis) ?? 0;
  }

  private wrap(frame: number): number {
    const count = this.clip.frameCount;
    const whole = Math.floor(frame);
    const clip = this.clip;
    if (clip.loop) return ((whole % count) + count) % count;
    return Math.min(Math.max(whole, 0), lastFrame(clip));
  }

  // ── the write door ────────────────────────────────────────────────────────────────────────────

  /**
   * Apply one mutation, then commit, log, notify and autosave. Every caller gets identical treatment
   * from a human or an agent because there is only this one path.
   */
  applyEdit(label: string, mutate: (clip: Clip) => { clip: Clip; report: EditReport }): EditReport {
    const before = this.clip;
    const { clip, report } = mutate(before);
    const committed = this.history.commit(clip, label);
    this.activity.unshift({
      revision: this.history.current().revision,
      label,
      when: Date.now(),
      report,
    });
    if (this.activity.length > LOG_LIMIT) this.activity.length = LOG_LIMIT;
    if (committed) this.emit();
    else this.emit(); // a no-op edit still refreshes the report line, so the feedback is not confusing
    return report;
  }

  /** Undo/redo go through the store too, so the playhead and the UI resync from one place. */
  undo(): string | null {
    const clip = this.history.undo();
    if (!clip) return null;
    this.frameTime = this.wrap(this.frameTime);
    this.emit();
    return this.history.label();
  }

  redo(): string | null {
    const clip = this.history.redo();
    if (!clip) return null;
    this.emit();
    return this.history.label();
  }

  // ── pose edits ────────────────────────────────────────────────────────────────────────────────

  /**
   * One slider move. If the joint is keyed the value lands on a key at the current frame (auto-key, as
   * in every DCC: you cannot edit a posed frame without recording it); if it is not keyed it stays in the
   * scratch pose, which is what makes M1's "just pose the body" workflow survive the timeline.
   */
  /** Returns the messages worth showing, so a refused edit is never silent. */
  setAxis(joint: string, axis: AxisName, degrees: number): readonly string[] {
    const spec = this.rig.joints.find(j => j.name === joint);
    if (!spec) return [`"${joint}" is not a joint of this rig — nothing was changed`];
    if (spec.axes.length === 0) {
      return [`${joint} is an end site with no DoFs — nothing was changed`];
    }
    const track = this.clip.jointKeys[joint] ?? [];
    if (track.length === 0) {
      let m = this.values.get(joint);
      if (!m) this.values.set(joint, (m = new Map<AxisName, number>()));
      if (m.get(axis) === degrees) return [];
      m.set(axis, degrees);
      this.emit();
      return [];
    }
    const frame = this.frame;
    // Seed from what is on screen so the other axes do not jump to the previous key's values mid-drag.
    const sampled = this.sample(frame).pose.joints?.[joint] ?? {};
    const values: SemanticValues = { ...sampled, [axis]: degrees };
    const ease = track.find(k => k.frame === frame)?.ease ?? "auto";
    const report = this.applyEdit(`key ${joint}.${axis} @ ${frame}`, clip =>
      setKeyPose(this.rig, clip, { frame, joints: { [joint]: values }, ease }),
    );
    return [
      ...report.warnings,
      ...report.adjustments.map(
        a =>
          `${a.joint}.${a.axis}: ${a.requested.toFixed(0)}° is not legal -> ${a.applied.toFixed(0)}°`,
      ),
    ];
  }

  /**
   * Stamp the pose on screen onto a key at the current frame. §11's workflow — "block key poses first,
   * then refine" — is this call with a joint list; the button uses it with no argument, which means
   * "whatever I have selected, or everything I have moved".
   *
   * The values come from `sample()`, so a joint the clip already owns keeps its clip value (rather than
   * snapping to the scratch pose, which is what would happen if the free values were the only source) and
   * a joint nobody has keyed comes in from the scratch pose at its current numbers.
   */
  keyPose(joints?: readonly string[]): EditReport {
    const frame = this.frame;
    const wanted =
      joints && joints.length > 0
        ? joints
        : this.selection.length > 0
          ? this.selection
          : [...this.values.keys()];
    const sampled = this.sample(frame).pose.joints ?? {};
    const toKey: Record<string, SemanticValues> = {};
    const skipped: string[] = [];
    for (const joint of wanted) {
      const spec = this.rig.joints.find(j => j.name === joint);
      if (!spec || spec.axes.length === 0) {
        skipped.push(joint);
        continue;
      }
      const value = sampled[joint];
      if (!value || Object.keys(value).length === 0) {
        skipped.push(joint);
        continue;
      }
      toKey[joint] = { ...value };
    }
    if (Object.keys(toKey).length === 0) {
      return {
        adjustments: [],
        warnings: [
          `nothing to key at frame ${frame} — select a joint or move a slider first` +
            (skipped.length > 0 ? ` (skipped ${skipped.join(", ")}: no DoFs or no value)` : ""),
        ],
        changed: [],
      };
    }
    const report = this.applyEdit(`key ${Object.keys(toKey).join(", ")} @ ${frame}`, clip =>
      setKeyPose(this.rig, clip, { frame, joints: toKey }),
    );
    if (skipped.length === 0) return report;
    // EditReport is readonly by contract (it is handed to an agent as-is), so extend a copy
    return {
      ...report,
      warnings: [...report.warnings, `skipped, nothing to write: ${skipped.join(", ")}`],
    };
  }

  keyJoint(joint: string): EditReport {
    return this.keyPose([joint]);
  }

  /**
   * Drop this frame's keys. Scoped to the selection when there is one, because "delete the pose I am
   * looking at" and "delete the whole frame" are different intentions and only one of them is reversible
   * by accident.
   */
  unkeyAt(frame = this.frame, joints?: readonly string[]): EditReport {
    const wanted =
      joints && joints.length > 0 ? joints : this.selection.length > 0 ? this.selection : undefined;
    return this.applyEdit(`unkey @ ${frame}`, clip => deleteKeys(clip, { frame, joints: wanted }));
  }

  unkeyPose(): EditReport {
    return this.unkeyAt(this.frame);
  }

  resetPose(): void {
    this.values.clear();
    this.emit();
  }

  randomizePose(): void {
    let s = Date.now() & 0xffff || 1;
    const rnd = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (const j of this.rig.joints) {
      if (j.axes.length === 0) continue;
      const m = new Map<AxisName, number>();
      for (const a of j.axes) m.set(a.name, Math.round(a.min + rnd() * (a.max - a.min)));
      this.values.set(j.name, m);
    }
    this.emit();
  }

  // ── clip settings ─────────────────────────────────────────────────────────────────────────────

  /** §9's `new_clip`: an empty timeline, undoable, so "start over" is not a destructive button. */
  newClip(
    over: { name?: string; fps?: number; frameCount?: number; loop?: boolean } = {},
  ): EditReport {
    // the current clip is deliberately ignored: a new clip replaces, it does not edit
    return this.applyEdit("new clip", () => newClipRecord(over));
  }

  setSettings(settings: {
    name?: string;
    fps?: number;
    frameCount?: number;
    loop?: boolean;
  }): EditReport {
    return this.applyEdit("clip settings", clip => setClipSettings(clip, settings));
  }

  setEaseEverywhere(ease: Parameters<typeof setEase>[1]["ease"]): EditReport {
    const frame = this.frame;
    return this.applyEdit(`ease "${ease}" @ ${frame}`, clip => setEase(clip, { ease, frame }));
  }

  // ── transport ─────────────────────────────────────────────────────────────────────────────────

  setFrame(frame: number): void {
    const next = Math.max(0, Math.round(frame));
    if (next === Math.floor(this.frameTime)) return;
    this.frameTime = next;
    this.emit();
  }

  /** Advance playback. Returns whether the frame changed, so the render loop can skip work. */
  tick(seconds: number): boolean {
    if (!this.isPlaying) return false;
    const fps = this.clip.fps;
    const last = lastFrame(this.clip);
    let next = this.frameTime + seconds * fps;
    if (this.clip.loop) {
      next = ((next % this.clip.frameCount) + this.clip.frameCount) % this.clip.frameCount;
    } else if (next > last) {
      // stop at the end rather than loop or hold — a human pressing play expects it to end
      this.frameTime = last;
      this.isPlaying = false;
      this.emit();
      return true;
    }
    const moved = this.wrap(next) !== this.wrap(this.frameTime);
    this.frameTime = next;
    if (moved) this.emit();
    return moved;
  }

  play(): void {
    this.isPlaying = true;
    this.emit();
  }

  pause(): void {
    this.isPlaying = false;
    this.emit();
  }

  toggle(): void {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  /** Jump to the next/previous keyed frame; the arrow keys in every animation tool. */
  jumpKey(direction: 1 | -1): void {
    const frames = [0, ...this.keyedFrames(), this.clip.frameCount - 1];
    const at = this.frame;
    const wanted =
      direction === 1 ? frames.find(f => f > at) : [...frames].reverse().find(f => f < at);
    if (wanted !== undefined) this.setFrame(wanted);
  }

  private keyedFrames(): number[] {
    const set = new Set<number>();
    for (const track of Object.values(this.clip.jointKeys)) for (const k of track) set.add(k.frame);
    for (const k of this.clip.rootKeys) set.add(k.frame);
    return [...set].sort((a, b) => a - b);
  }

  // ── selection ─────────────────────────────────────────────────────────────────────────────────

  setSelection(joints: readonly string[]): void {
    const next = [...new Set(joints.filter(j => this.rig.joints.some(x => x.name === j)))];
    if (next.join(",") === this.selection.join(",")) return;
    this.selection = next;
    this.emit();
  }

  // ── persistence ───────────────────────────────────────────────────────────────────────────────

  snapshot(): string {
    return serializeProject(this.clip, this.rig, {
      frame: this.frame,
      selected: this.selection,
      // the un-keyed scratch values go in the file too: reload must restore the pose a human dragged out
      // by hand, not only the ones they thought to key
      freePose: this.freePose(),
    });
  }

  /** Adopt a clip wholesale: page load, autosave restore, project open. Not an undoable edit. */
  load(
    clip: Clip,
    view?: {
      frame?: number;
      selected?: readonly string[];
      freePose?: Record<string, SemanticValues>;
    },
  ): readonly string[] {
    this.history.replace(clip, "loaded project");
    this.activity.length = 0;
    this.frameTime = view?.frame ?? 0;
    this.values.clear();
    for (const [joint, axes] of Object.entries(view?.freePose ?? {})) {
      const m = new Map<AxisName, number>();
      for (const [axis, deg] of Object.entries(axes ?? {})) m.set(axis as AxisName, Number(deg));
      this.values.set(joint, m);
    }
    this.setSelection(view?.selected ?? []);
    this.emit();
    return [];
  }

  restoreFrom(text: string): { ok: boolean; warnings: readonly string[]; error: string | null } {
    const parsed = parseProject(text, this.rig);
    if (!parsed.project) return { ok: false, warnings: parsed.warnings, error: parsed.error };
    this.load(parsed.project.clip, parsed.project.view);
    return { ok: true, warnings: parsed.warnings, error: null };
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
