import type { HumanoidRig, RigJoint } from "./types.js";

/**
 * Structural + geometric invariants. Pure, synchronous, deterministic: the same checks the python
 * generator runs (`tools/check-rig.py`), so a hand-edited rig file cannot pass CI one way and fail
 * the other. Returns human-readable issues instead of throwing, because `get_rig` must be able to
 * report them to an AI agent rather than crash the page.
 */
export function validateRig(rig: HumanoidRig): string[] {
  const issues: string[] = [];
  const byName = new Map<string, RigJoint>(rig.joints.map(j => [j.name, j]));

  if (byName.size !== rig.joints.length) issues.push("duplicate joint name");

  // A tree: exactly one root, and nodes-1 edges.
  const roots = rig.joints.filter(j => j.parent === null);
  if (roots.length !== 1) issues.push(`expected exactly 1 root joint, got ${roots.length}`);
  if (rig.joints.length - 1 !== rig.stats["hierarchyEdges"]) {
    issues.push(`${rig.joints.length} joints needs ${rig.joints.length - 1} hierarchy edges`);
  }

  for (const j of rig.joints) {
    if (j.parent !== null && !byName.has(j.parent))
      issues.push(`${j.name}: unknown parent ${j.parent}`);
    if (j.parent === j.name) issues.push(`${j.name}: parent is itself`);
    // offsets are the only place geometry lives, so rest positions must agree with them
    const [px, py, pz] = j.restPosition;
    const [ox, oy, oz] = j.offset;
    const parent = j.parent === null ? undefined : byName.get(j.parent);
    if (parent) {
      const [rx, ry, rz] = parent.restPosition;
      const parts: readonly [
        readonly [number, number, string],
        readonly [number, number, string],
        readonly [number, number, string],
      ] = [
        [rx + ox, px, "x"],
        [ry + oy, py, "y"],
        [rz + oz, pz, "z"],
      ];
      for (const [want, got, axisName] of parts) {
        if (Math.abs(want - got) > 1e-6) {
          issues.push(`${j.name}.restPosition.${axisName} = ${got} but offset implies ${want}`);
        }
      }
    } else if (rig.root.joint === j.name) {
      const [hx, hy, hz] = rig.root.restPosition;
      if (Math.abs(hx - px) > 1e-9 || Math.abs(hy - py) > 1e-9 || Math.abs(hz - pz) > 1e-9) {
        issues.push(`${j.name} is the root: restPosition must equal root.restPosition`);
      }
    }

    for (const a of j.axes) {
      const [ax, ay, az] = a.axis;
      const norm = Math.hypot(ax, ay, az);
      if (Math.abs(norm - 1) > 1e-6)
        issues.push(`${j.name}.${a.name}: axis not unit (${norm.toFixed(6)})`);
      if (!(a.min < a.max)) issues.push(`${j.name}.${a.name}: min >= max`);
      if (a.min < -180 || a.max > 360) issues.push(`${j.name}.${a.name}: limit outside -180..360`);
      const [below, above] = a.graze;
      if (!(below >= 0) || !(above >= 0))
        issues.push(
          `${j.name}.${a.name}: graze [${a.graze.join(", ")}] must be non-negative allowances, not signed bounds`,
        );
      if (below > 20 || above > 20)
        issues.push(
          `${j.name}.${a.name}: graze [${a.graze.join(", ")}] exceeds a 20° safety window`,
        );
      if (!a.positiveMeans)
        issues.push(`${j.name}.${a.name}: empty positiveMeans (the AI needs this sentence)`);
    }
    if (j.kind === "endSite" && j.axes.length > 0)
      issues.push(`${j.name}: end sites must not animate`);
  }

  // Hinges are the single most important rule in the rig: exactly one DoF, no exceptions.
  const hinges = ["elbow_L", "elbow_R", "knee_L", "knee_R", "toe_L", "toe_R"];
  for (const n of hinges) {
    const j = byName.get(n);
    if (!j) issues.push(`missing hinge ${n}`);
    else if (j.axes.length !== 1 || j.axes[0]?.name !== "flex")
      issues.push(
        `${n} must be a one-DoF hinge on flex, got [${j.axes.map(a => a.name).join(", ")}]`,
      );
  }

  // Paired joints: right axes are the left axes with (x, -y, -z), angle unchanged.
  for (const j of rig.joints) {
    if (!j.name.endsWith("_L")) continue;
    const r = byName.get(j.name.replace(/_L$/, "_R"));
    if (!r) {
      issues.push(`${j.name} has no _R partner`);
      continue;
    }
    if (r.axes.length !== j.axes.length) {
      issues.push(`${j.name}/${r.name}: different DoF counts`);
      continue;
    }
    for (let i = 0; i < j.axes.length; i++) {
      const la = j.axes[i]!,
        ra = r.axes[i]!;
      const [lux, luy, luz] = la.axis;
      const [rux, ruy, ruz] = ra.axis;
      if (Math.abs(lux - rux) > 1e-9 || Math.abs(-luy - ruy) > 1e-9 || Math.abs(-luz - ruz) > 1e-9)
        issues.push(
          `${r.name}.${la.name}: axis [${rux}, ${ruy}, ${ruz}] is not the mirror ` +
            `[${lux}, ${-luy}, ${-luz}] of ${j.name}.${la.name}`,
        );
      for (const key of ["min", "max"] as const) {
        if (la[key] !== ra[key])
          issues.push(`${r.name}.${la.name}.${key} = ${ra[key]} but ${j.name} has ${la[key]}`);
      }
      if (la.graze[0] !== ra.graze[0] || la.graze[1] !== ra.graze[1])
        issues.push(
          `${r.name}.${la.name}: graze [${ra.graze.join(", ")}] != mirrored [${la.graze.join(", ")}]`,
        );
    }
  }

  for (const b of rig.bones) {
    if (!byName.has(b.from) || !byName.has(b.to)) issues.push(`bone ${b.name}: unknown endpoint`);
    const from = byName.get(b.from),
      to = byName.get(b.to);
    if (from && to && to.parent !== from.name)
      issues.push(
        `bone ${b.name} ${b.from}->${b.to} is not a hierarchy edge (only drawn bones may follow parentage)`,
      );
  }

  // Floor contact truth: markers rest on Y=0 so a standing pose has zero penetration by construction.
  for (const m of rig.markers) {
    const [mx, my, mz] = m.restPosition;
    const [mo, no_, oo] = m.offset;
    if (Math.abs(my) > 1e-6) issues.push(`${m.name}: rest y must be 0 (floor), got ${my}`);
    const par = byName.get(m.parent);
    if (!par) {
      issues.push(`${m.name}: unknown parent ${m.parent}`);
      continue;
    }
    const [prx, pry, prz] = par.restPosition;
    if (
      Math.abs(prx + mo - mx) > 1e-6 ||
      Math.abs(pry + no_ - my) > 1e-6 ||
      Math.abs(prz + oo - mz) > 1e-6
    )
      issues.push(`${m.name}: offset/restPosition disagree with parent ${m.parent}`);
  }
  if (rig.markers.length !== 6)
    issues.push(`expected 6 foot contact markers, got ${rig.markers.length}`);

  return issues;
}
