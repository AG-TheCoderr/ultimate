import type { AxisName, HumanoidRig, SemanticValues } from "@rigpilot/core";
import { clampPose, solve, type AxisAdjustment, type SolveResult } from "@rigpilot/core";

/**
 * The one mutable thing in the studio. VISION §2: "the page is the source of truth for the project
 * state", so this is the object the MCP executor will mutate in M3 and the sliders mutate in M1 —
 * the same path, which is what makes "everything the AI does is visible in the UI" true by
 * construction rather than by syncing two copies.
 */
export class PoseState {
  private readonly listeners = new Set<() => void>();
  /** joint -> semantic axis -> degrees, as authored. Clamping happens at solve time, never here,
   *  so a slider can be dragged past a limit and spring back visibly instead of sticking. */
  readonly values: Map<string, Map<AxisName, number>> = new Map();
  revision = 0;
  lastAdjustments: readonly AxisAdjustment[] = [];

  constructor(readonly rig: HumanoidRig) {}

  get(joint: string, axis: AxisName): number {
    return this.values.get(joint)?.get(axis) ?? 0;
  }

  set(joint: string, axis: AxisName, degrees: number): void {
    let m = this.values.get(joint);
    if (!m) this.values.set(joint, (m = new Map<AxisName, number>()));
    if (m.get(axis) === degrees) return;
    m.set(axis, degrees);
    this.revision++;
    this.emit();
  }

  reset(joint?: string): void {
    if (joint === undefined) this.values.clear();
    else this.values.delete(joint);
    this.revision++;
    this.emit();
  }

  /** Random pose inside the authored limits: the "can this rig even be posed illegally?" button. */
  randomize(seed = Date.now() & 0xffff): void {
    let s = seed || 1;
    const rnd = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (const j of this.rig.joints) {
      if (j.axes.length === 0) continue;
      const m = new Map<AxisName, number>();
      for (const a of j.axes) m.set(a.name, Math.round(a.min + rnd() * (a.max - a.min)));
      this.values.set(j.name, m);
    }
    this.revision++;
    this.emit();
  }

  pose(): Record<string, SemanticValues> {
    const out: Record<string, SemanticValues> = {};
    for (const [joint, m] of this.values) out[joint] = Object.fromEntries(m);
    return out;
  }

  solve(): SolveResult {
    const r = solve(this.rig, { joints: this.pose() });
    this.lastAdjustments = r.adjustments;
    return r;
  }

  /** What the clamped values actually are — the panel shows these, so a limit is visible, not mysterious. */
  clamped(): Record<string, Record<AxisName, number>> {
    return clampPose(this.rig.joints, this.pose(), "hard").pose;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}
