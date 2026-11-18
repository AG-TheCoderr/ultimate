import type { AxisName, JointAxis, RigJoint } from "../rig/types.js";

/** What the rig corrected, in the shape every MCP response puts in `adjusted[]` (VISION §9). */
export interface AxisAdjustment {
  readonly joint: string;
  readonly axis: AxisName;
  readonly requested: number;
  readonly applied: number;
  readonly reason: string;
}

export interface ClampedAxis {
  readonly value: number;
  /** Present exactly when the requested value was not legal. */
  readonly adjustment: AxisAdjustment | null;
}

/**
 * Clamp one semantic DoF.
 *
 * Two bands, and the difference is the whole point (RECONCILIATION §2.9 / VISION §1 "never fail"):
 *   - `hard` (min..max) is what gets exported and what an engine validates.
 *   - `graze` (min - graze[0] .. max + graze[1]) is what the *solver* may settle in, so IK pressing
 *     against a hinge stop does not chatter, and real elbows can reach a few degrees of hyperextension.
 * Anything past the graze band is pulled back to the hard limit and reported — never silently, because
 * an agent that is not told it asked for a backwards knee will keep asking.
 */
export function clampAxis(
  joint: RigJoint,
  axis: JointAxis,
  requested: number,
  mode: "hard" | "solver" = "hard",
): ClampedAxis {
  if (!Number.isFinite(requested)) {
    return {
      value: axis.min,
      adjustment: {
        joint: joint.name,
        axis: axis.name,
        requested,
        applied: axis.min,
        reason: `${joint.name}.${axis.name} was not a finite number; held at the limit minimum`,
      },
    };
  }
  const [below, above] = axis.graze;
  const lo = mode === "solver" ? axis.min - below : axis.min;
  const hi = mode === "solver" ? axis.max + above : axis.max;
  if (requested >= lo && requested <= hi) return { value: requested, adjustment: null };

  const applied = Math.min(Math.max(requested, lo), hi);
  const over = requested > hi ? `above max ${axis.max}` : `below min ${axis.min}`;
  const exceededGraze = mode === "solver" && (applied < axis.min || applied > axis.max);
  return {
    value: applied,
    adjustment: {
      joint: joint.name,
      axis: axis.name,
      requested,
      applied,
      reason:
        `${joint.name}.${axis.name} is ${over} (${requested.toFixed(1)}°, allowed ${axis.min}..${axis.max}` +
        (axis.graze[0] || axis.graze[1]
          ? `, solver may graze to ${axis.min - axis.graze[0]}..${axis.max + axis.graze[1]}`
          : "") +
        `) -> clamped to ${applied.toFixed(1)}°. ${axisHint(joint, axis)}${exceededGraze ? " [even the solver band was exceeded]" : ""}`,
    },
  };
}

function axisHint(joint: RigJoint, axis: JointAxis): string {
  if (joint.axes.length === 1) {
    return `It is a hinge: ${joint.name} has exactly one DoF (${axis.name}) and can never bend sideways — that single rule removes most "broken-looking" animation.`;
  }
  if (axis.name === "side" && joint.name.startsWith("shoulder")) {
    return `To raise the arm, use "side" (positive = away from the body); "${axis.positiveMeans}".`;
  }
  return `"${axis.name}" on ${joint.name}: ${axis.positiveMeans}.`;
}

/** Clamp a whole pose. Returns the legal values plus every correction, in joint/axis order. */
export function clampPose(
  joints: readonly RigJoint[],
  pose: Readonly<Record<string, Partial<Record<AxisName, number>>>>,
  mode: "hard" | "solver" = "hard",
): { pose: Record<string, Record<AxisName, number>>; adjustments: AxisAdjustment[] } {
  const out: Record<string, Record<AxisName, number>> = {};
  const adjustments: AxisAdjustment[] = [];
  for (const j of joints) {
    if (j.axes.length === 0) continue;
    const requested = pose[j.name] ?? {};
    const values = {} as Record<AxisName, number>;
    for (const axis of j.axes) {
      const r = requested[axis.name] ?? 0;
      const c = clampAxis(j, axis, r, mode);
      values[axis.name] = c.value;
      if (c.adjustment) adjustments.push(c.adjustment);
    }
    out[j.name] = values;
  }
  return { pose: out, adjustments };
}
