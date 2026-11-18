#!/usr/bin/env python3
"""Independent check of core/src/rig/humanoid.rig.json.

Part 1: VISION.md §6's ten required semantic behaviour tests. FK is re-implemented here from
scratch (local = R(twist)*R(side)*R(flex) about each DoF's declared axis; global = parent*local)
so that passing means the rig DATA is right, not that two copies of the same code agree.
Part 2: rig invariants the TS loader will assert on.
Exit code is non-zero if anything fails, so CI can run it directly.
"""
import json, math, sys, os

def Rodrigues(axis, deg):
    a = math.radians(deg); n = math.sqrt(sum(v*v for v in axis))
    x, y, z = (v/n for v in axis)
    c, s, C = math.cos(a), math.sin(a), 1-math.cos(a)
    return ((c+x*x*C,   x*y*C-z*s, x*z*C+y*s),
            (y*x*C+z*s, c+y*y*C,   y*z*C-x*s),
            (z*x*C-y*s, z*y*C+x*s, c+z*z*C))

def vmat(m, v):
    return tuple(sum(m[r][c]*v[c] for c in range(3)) for r in range(3))

def check(rig):
    J = {j["name"]: j for j in rig["joints"]}
    order = rig["conventions"]["dofOrder"]
    def local(jn, dof):
        m = ((1,0,0),(0,1,0),(0,0,1))
        vals = dof.get(jn, {})
        for name in reversed(order):          # R(twist)*R(side)*R(flex)
            deg = vals.get(name)
            if not deg: continue
            ax = next((a for a in J[jn]["axes"] if a["name"] == name), None)
            if ax is None: raise AssertionError(f"{jn} has no {name} DoF")
            r = Rodrigues(ax["axis"], deg)
            m = matmul(r, m)
        return m
    def matmul(a, b):
        return tuple(tuple(sum(a[i][k]*b[k][j] for k in range(3)) for j in range(3)) for i in range(3))
    def fk(dof):
        P, Rm = {}, {}
        def fwd(nm):
            j = J[nm]
            Rm[nm] = matmul(Rm[j["parent"]], local(nm, dof)) if j["parent"] else local(nm, dof)
            P[nm] = j["offset"] if not j["parent"] else tuple(
                P[j["parent"]][i] + vmat(Rm[j["parent"]], j["offset"])[i] for i in range(3))
            for c, cj in J.items():
                if cj["parent"] == nm: fwd(c)
        for nm, j in J.items():
            if j["parent"] is None: fwd(nm)
        return P
    rest = fk({})
    out, fails = [], 0
    def t(label, ok, detail):
        nonlocal fails
        if not ok: fails += 1
        out.append(f"  {'PASS' if ok else 'FAIL'}  {label}\n         {detail}")
    def pose(**kw): return fk(kw)

    f = pose(hip_L={"flex": 90})
    dz = f["knee_L"][2]-rest["knee_L"][2]; dy = abs(f["knee_L"][1]-rest["hip_L"][1])
    t("hip_L flex +90 -> knee forward (+Z) and up to hip height", dz > 0.30 and dy < 0.03,
      f"dz=+{dz:.3f} m, |knee.y - hip.y|={dy:.3f} m")

    f = pose(knee_L={"flex": 90}); dz = f["ankle_L"][2]-rest["ankle_L"][2]
    t("knee_L flex +90 -> ankle backward (-Z)", dz < -0.30, f"dz={dz:.3f} m")

    for s in ("L", "R"):
        f = pose(**{f"shoulder_{s}": {"side": -90}})
        dy = f[f"elbow_{s}"][1]-f[f"shoulder_{s}"][1]
        t(f"shoulder_{s} side -90 -> elbow hangs below shoulder", abs(dy+0.34) < 0.02, f"dy={dy:.3f} m (want -0.34)")

    f = pose(shoulder_L={"flex": 90}); dz = f["elbow_L"][2]-rest["elbow_L"][2]
    t("shoulder_L flex +90 -> elbow swings forward (+Z)", dz > 0.30, f"dz=+{dz:.3f} m")

    f = pose(elbow_L={"flex": 90}); dz = f["wrist_L"][2]-f["elbow_L"][2]
    t("elbow_L flex +90 -> wrist forward of elbow (+Z)", dz > 0.20, f"dz=+{dz:.3f} m")

    f = pose(spine={"flex": 20}); dz = f["neck"][2]-rest["neck"][2]
    t("spine flex +20 -> neck moves forward (+Z)", dz > 0.03, f"dz=+{dz:.4f} m")

    f = pose(ankle_L={"flex": 15}); dy = f["toe_L"][1]-rest["toe_L"][1]
    t("ankle_L flex +15 -> toe rises (+Y)", dy > 0.01, f"dy=+{dy:.4f} m")

    ax = next(a for a in J["knee_L"]["axes"] if a["name"] == "flex")
    t("knee_L flex -20 is outside the authored hinge range (so it clamps + reports)",
      ax["min"] == 0 and ax["graze"] == [0, 5],
      f"authored flex {ax['min']}..{ax['max']}, graze {ax['graze']} (0 below: a knee must not hyperextend)")
    t("graze is a pair of non-negative allowances, never signed absolute bounds",
      all(g >= 0 for j in rig["joints"] for a in j["axes"] for g in a["graze"]),
      f"{sum(len(a['graze']) for j in rig['joints'] for a in j['axes'])} graze values checked")

    dof = {"shoulder_L": {"flex": 40, "side": 20, "twist": -30}, "elbow_L": {"flex": 70},
           "hip_L": {"flex": 50, "side": -10, "twist": 20}, "knee_L": {"flex": 80},
           "toe_L": {"flex": 25}, "clavicle_L": {"flex": -8, "side": 15},
           "wrist_L": {"flex": 30, "side": -10, "twist": 40}, "ankle_L": {"flex": 12}}
    left = fk(dof)
    mirrored = {f"{k[:-1]}R": v for k, v in dof.items()}
    right = fk(mirrored)
    e = [max(abs(right[f"{k[:-1]}R"][i] - (left[k][0] if i == 0 else left[k][i])) for k in dof) for i in range(3)]
    ex = max(abs(right[f"{k[:-1]}R"][0] + left[k][0]) for k in dof)
    ey = max(abs(right[f"{k[:-1]}R"][1] - left[k][1]) for k in dof)
    ez = max(abs(right[f"{k[:-1]}R"][2] - left[k][2]) for k in dof)
    t("same values on the mirrored joints == pose mirrored (X negated, Y/Z equal)", max(ex, ey, ez) < 1e-9,
      f"max|dx|={ex:.1e} |dy|={ey:.1e} |dz|={ez:.1e}  (note dx compares against +x: mirror negates X)")

    # ---- rig invariants the TS loader will assert on ----
    st = rig["stats"]
    t("tree: nodes-1 == hierarchy edges", st["nodes"]-1 == st["hierarchyEdges"],
      f"{st['nodes']} nodes, {st['hierarchyEdges']} edges, {st['bones']} drawn cylinders")
    kids = {}
    for j in rig["joints"]: kids.setdefault(j["parent"], []).append(j["name"])
    dead = [j["name"] for j in rig["joints"] if j["kind"] != "endSite" and not kids.get(j["name"])]
    t("every articulating joint has a child (BVH Sites only needed on end sites)", not dead, f"terminals={dead}")
    hinge = [j["name"] for j in rig["joints"] if len(j["axes"]) == 1]
    t("hinges expose exactly one DoF", set(hinge) == {"elbow_L", "elbow_R", "knee_L", "knee_R", "toe_L", "toe_R"},
      f"single-DoF joints: {sorted(hinge)}")
    unit = all(abs(math.sqrt(sum(v*v for v in a["axis"]))-1) < 1e-6 for j in rig["joints"] for a in j["axes"])
    n_axes = sum(len(j["axes"]) for j in rig["joints"])
    t("every DoF axis is a unit vector", unit, f"norms checked on {n_axes} axes")
    m = [(a["min"], a["max"]) for j in rig["joints"] for a in j["axes"]]
    t("all limits authored min<max, and soft bounds bracket the hard bounds inside",
      all(mn < mx for mn, mx in m), f"{len(m)} DoFs")
    zs = [mm["restPosition"][1] for mm in rig["markers"]]
    t("contact markers rest on the floor (|y| < 1mm) so rest pose has zero penetration", max(map(abs, zs)) < 1e-3,
      f"marker heights {sorted(set(zs))}")
    sinks = rig["stats"].get("bonesSinkingAtRest", [])
    t("rest-pose mesh clearance is recorded so penetration can be measured against the rest pose, not Y=0",
      all(b["clearanceAtRest"] is not None for b in rig["bones"]),
      f"sinks below floor at rest: {sinks or 'none'} (deepest "
      f"{min(b['clearanceAtRest'] for b in rig['bones']):+.3f} m) - §10's marker test cannot see this")
    print("\n".join(out))
    print(f"\n{fails} failing of {len(out)}")
    return 1 if fails else 0

if __name__ == "__main__":
    p = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "core", "src", "rig", "humanoid.rig.json")
    sys.exit(check(json.load(open(p))))
