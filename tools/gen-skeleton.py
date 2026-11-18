#!/usr/bin/env python3
"""Generate fixtures/skeletons/lab-21.json — the canonical 21-joint lab rig.

The skeleton is DATA, so it is generated from authored world-space positions and validated on
every run: tree invariant, L/R mirror symmetry, bone lengths against the anthropometric spec,
and the mirror rule for joint limits. Edit positions/DoFs below, re-run, commit both files.

Conventions (see docs/DATA-FORMAT.md):
  Y-up, right-handed, meters, character faces +Z, +X is the character's LEFT side.
  CRP rest pose: every local rest rotation is identity, T-pose, arms along ±X.
  Therefore offset(child) = worldRest(child) - worldRest(parent), and the CRP local frame of every
  joint coincides with world axes at rest — which is exactly why hinge axes must be *declared*
  per joint rather than inherited from a global "X means forward/back" rule.
"""
import json, math, os

HEIGHT = 1.80

# ── authored rest positions (metres, world space) ────────────────────────────
W = {
    "hips":   (0, 0.98, 0), "spine": (0, 1.10, 0), "chest": (0, 1.30, 0),
    "neck":   (0, 1.50, 0), "head":  (0, 1.62, 0), "headEnd": (0, 1.80, 0),
}
for side, sx in (("L", 1.0), ("R", -1.0)):
    W[f"clavicle.{side}"] = (sx*0.03, 1.45, 0)
    W[f"shoulder.{side}"] = (sx*0.19, 1.47, 0)   # acromion; see proportions note re: span
    W[f"elbow.{side}"]    = (sx*0.53, 1.47, 0)
    W[f"wrist.{side}"]    = (sx*0.79, 1.47, 0)
    W[f"handEnd.{side}"]  = (sx*0.98, 1.47, 0)
    W[f"hip.{side}"]      = (sx*0.09, 0.95, 0)
    W[f"knee.{side}"]     = (sx*0.09, 0.51, 0)
    W[f"ankle.{side}"]    = (sx*0.09, 0.07, 0)
    W[f"toe.{side}"]      = (sx*0.09, 0.02, 0.14)
    W[f"toeEnd.{side}"]   = (sx*0.09, 0.02, 0.21)

PARENT = {
    "hips": None, "spine": "hips", "chest": "spine", "neck": "chest", "head": "neck",
    "headEnd": "head",
    **{f"{j}.{s}": (p if p in ("hips", "chest") else f"{p}.{s}") for s in ("L", "R") for j, p in (
        ("hip", "hips"), ("knee", "hip"), ("ankle", "knee"), ("toe", "ankle"),
        ("toeEnd", "toe"), ("clavicle", "chest"), ("shoulder", "clavicle"),
        ("elbow", "shoulder"), ("wrist", "elbow"), ("handEnd", "wrist"))},
}

ROLE = {
    "hips": "hips", "spine": "spine", "chest": "chest", "neck": "neck",
    "head": "head", "headEnd": "headEnd",
    "clavicle.L": "leftShoulder", "shoulder.L": "leftArm", "elbow.L": "leftElbow",
    "wrist.L": "leftWrist", "handEnd.L": "leftHandEnd",
    "clavicle.R": "rightShoulder", "shoulder.R": "rightArm", "elbow.R": "rightElbow",
    "wrist.R": "rightWrist", "handEnd.R": "rightHandEnd",
    "hip.L": "leftHip", "knee.L": "leftKnee", "ankle.L": "leftAnkle",
    "toe.L": "leftFootEnd", "toeEnd.L": "leftToeEnd",
    "hip.R": "rightHip", "knee.R": "rightKnee", "ankle.R": "rightAnkle",
    "toe.R": "rightFootEnd", "toeEnd.R": "rightToeEnd",
}

# ── DoFs: authored on the LEFT + centre only ─────────────────────────────────
# (axis, sign, label, min, max, softMin, softMax);  dofValue = sign * rotationAbout(axis)
# positive value always == anatomical flexion / abduction / raise, whichever way the world axis runs.
# The axis is what the source table left implicit: a T-pose arm points along ±X, so its flexion
# lives on Y and its twist on X, while the (down-pointing) leg flexes about X.
DOF = {
    "hips":  [],  # root: free 6 DoF, driven by root.position / root.rotation tracks
    "spine": [("X", -1, "flexion", -15, 30, -5, 5), ("Y", 1, "twist", -20, 20, -5, 5),
              ("Z", 1, "sideBend", -15, 15, -5, 5)],
    "chest": [("X", -1, "flexion", -15, 30, -5, 5), ("Y", 1, "twist", -20, 20, -5, 5),
              ("Z", 1, "sideBend", -15, 15, -5, 5)],
    "neck":  [("X", -1, "flexion", -35, 40, -8, 8), ("Y", 1, "twist", -40, 40, -10, 10),
              ("Z", 1, "sideBend", -30, 30, -8, 8)],
    "head":  [("X", -1, "flexion", -35, 40, -8, 8), ("Y", 1, "twist", -40, 40, -10, 10),
              ("Z", 1, "sideBend", -30, 30, -8, 8)],
    # raising the shoulder girdle swings the ±X-pointing clavicle up => rotation about Z, not Y
    "clavicle": [("Z", 1, "raise", -10, 40, -2, 5), ("Y", -1, "protract", -20, 20, -5, 5)],
    "shoulder": [("Y", -1, "flexion", -50, 180, -8, 8), ("Z", 1, "abduction", 0, 180, -5, 10),
                 ("X", 1, "twist", -90, 90, -15, 15)],   # twist is about the BONE axis
    "elbow":   [("Y", -1, "flexion", 0, 150, -5, 3)],    # hinge; softMin lets locks sit at full extension
    "wrist":   [("Y", -1, "flexion", -70, 80, -10, 10),
                ("X", 1, "twist", -80, 80, -10, 10),      # carries radioulnar supination/pronation
                ("Z", 1, "deviation", -20, 30, -5, 5)],
    "hip":     [("X", -1, "flexion", -20, 120, -8, 5), ("Z", 1, "abduction", -30, 45, -8, 5),
                ("Y", 1, "twist", -40, 40, -10, 10)],
    "knee":    [("X", 1, "flexion", 0, 150, 0, 5)],        # hinge
    "ankle":   [("X", 1, "dorsiflexion", -50, 20, -10, 10),
                ("Z", 1, "subtalar", -20, 20, -5, 5)],
    "toe":     [("X", 1, "extension", -20, 60, -5, 10)],   # hinge
}

# ── cylinders: (from, to, radius, group) ────────────────────────────────────
BONES = [("hips", "spine", 0.085, "spine"), ("spine", "chest", 0.075, "spine"),
         ("chest", "neck", 0.060, "spine"), ("neck", "head", 0.045, "spine"),
         ("head", "headEnd", 0.070, "skull"),
         ("hips", "hip.L", 0.060, "pelvis"), ("hips", "hip.R", 0.060, "pelvis")]
for s in ("L", "R"):
    BONES += [("chest", f"clavicle.{s}", 0.030, "clavicle"),
              (f"clavicle.{s}", f"shoulder.{s}", 0.030, "clavicle"),
              (f"shoulder.{s}", f"elbow.{s}", 0.045, "upperArm"),
              (f"elbow.{s}", f"wrist.{s}", 0.035, "forearm"),
              (f"wrist.{s}", f"handEnd.{s}", 0.030, "hand"),
              (f"hip.{s}", f"knee.{s}", 0.070, "thigh"),
              (f"knee.{s}", f"ankle.{s}", 0.050, "shin"),
              (f"ankle.{s}", f"toe.{s}", 0.038, "foot"),
              (f"toe.{s}", f"toeEnd.{s}", 0.028, "toe")]

SPEC_LENGTHS = {"skull": 0.18, "upperArm": 0.34, "forearm": 0.26, "hand": 0.19,
                "thigh": 0.44, "shin": 0.44, "foot": 0.15, "toe": 0.07}

ORDER_FOR = {"hips", "spine", "chest", "neck", "head", "headEnd",
             "hip", "knee", "ankle", "toe", "toeEnd"}   # limbs that flex in the sagittal plane


def mirror(dofs):
    """Mirror about X: conjugation by an improper transform sends rot(n, θ) -> rot(M·n, -θ).
    M·X = -X, so an X DoF nets out to the same sign; Y and Z DoFs flip sign."""
    return [(ax, sg if ax == "X" else -sg, lb, mn, mx, smn, smx) for ax, sg, lb, mn, mx, smn, smx in dofs]


def _stats(joints, bones, markers):
    parents = {j["parent"] for j in joints if j["parent"]}
    terminals = [j["name"] for j in joints if j["name"] not in parents]
    return {"nodes": len(joints),
            "articulatingJoints": sum(1 for j in joints if j["kind"] in ("root", "joint")),
            "leafNodes": sum(1 for j in joints if j["kind"] == "leaf"),
            "bones": len(bones), "contactMarkers": len(markers),
            "terminals": terminals,
            "note": f"{len(terminals)} terminal joints each need 2 synthetic Site nodes to satisfy "
                    f"BVH (Site blocks are mandatory in the spec); glTF needs no such padding"}


def build():
    joints = []
    for name, pos in W.items():
        par = PARENT[name]
        off = [0.0, 0.0, 0.0] if par is None else [round(pos[i] - W[par][i], 6) for i in range(3)]
        base, _, side = name.rpartition(".")
        dofs = DOF.get(name) or DOF.get(base) or []
        if side == "R":
            dofs = mirror(dofs)
        joints.append({
            "name": name, "role": ROLE[name], "parent": par,
            "kind": "root" if name == "hips" else ("leaf" if name.endswith("End") or "End." in name else "joint"),
            "offset": off,
            "limits": [{"axis": ax, "sign": sg, "label": lb, "min": mn, "max": mx,
                        "softMin": smn, "softMax": smx} for ax, sg, lb, mn, mx, smn, smx in dofs],
            "channelOrder": "ZXY" if base in ORDER_FOR else "YXZ",
        })
    length = lambda a, b: round(math.dist(W[a], W[b]), 4)
    bones = [{"from": a, "to": b, "radius": r, "group": g, "length": length(a, b)} for a, b, r, g in BONES]
    markers = []
    for s, sx, pre in (("L", 1, "left"), ("R", -1, "right")):
        for mn, parent, pos in (("heel", f"ankle.{s}", (sx*0.09, 0.015, -0.05)),
                               ("ball", f"ankle.{s}", (sx*0.09, 0.010, 0.13)),
                               ("toeTip", f"toe.{s}", (sx*0.09, 0.010, 0.20))):
            p = W[parent]
            markers.append({"name": f"{mn}.{s}", "role": f"{pre}{mn[0].upper()}{mn[1:]}",
                            "parent": parent, "position": list(pos), "contact": True,
                            "offset": [round(pos[i] - p[i], 6) for i in range(3)]})
    span = round(2 * W["handEnd.L"][0], 3)
    return {"id": "lab-21", "version": 1,
            "conventions": {
                "upAxis": "Y", "forwardAxis": "+Z", "leftSideAxis": "+X", "unit": "m",
                "restPose": "CRP — all local rest rotations identity, T-pose, arms along ±X",
                "offsetSpace": "parent-local, which under CRP equals worldRest(child) - worldRest(parent)",
                "limits": "dofValue = sign * rotationAbout(axis), in the CRP local frame of that joint; "
                          "positive == flexion/abduction/raise. Axis is per-joint, never a global rule.",
                "authoringSide": "left + centre authored; right derived by mirroring about X "
                                 "(X-DoF sign preserved, Y/Z-DoF sign flipped)",
            },
            "bindHeight": HEIGHT,
            "pairing": [{"base": b, "left": f"{b}.L", "right": f"{b}.R", "mirrorAxis": "X"}
                        for b in ("clavicle", "shoulder", "elbow", "wrist", "handEnd",
                                  "hip", "knee", "ankle", "toe", "toeEnd")],
            "proportions": {
                "height": HEIGHT, "legLength": 0.95, "armLength": 0.79, "span": span,
                "spanOverHeight": round(span / HEIGHT, 3), "legOverHeight": round(0.95 / HEIGHT, 3),
                "tolerance": {"spanOverHeight": [0.95, 1.05], "legOverHeight": [0.51, 0.55]},
                "warning": "span/height 1.089 exceeds 1.05: anthropometrically span ≈ height. Cause is "
                           "shoulder lateral offset ±0.19 (deltoid, not glenohumeral ≈±0.17) plus hand 0.19. "
                           "Cosmetic in the lab, but it is the number a retargeter sanity-checks. "
                           "Fix = shoulder x 0.19->0.17 and hand 0.19->0.17.",
            },
            "mesh": {
                "head": {"parent": "head", "type": "sphere", "radius": 0.095,
                         "ellipsoidScale": [0.80, 1.0, 1.06], "offset": [0, 0.09, 0.012],
                         "note": "the head JOINT is the skull base at y=1.62; centring the sphere on the "
                                 "joint puts the crown at 1.73 on a 1.80 character. Offset it up. "
                                 "ellipsoidScale flattens X and lengthens Z because a skull is not a sphere "
                                 "(≈0.076 wide / 0.101 deep half-extents)."},
                "torso": {"type": "box", "from": "hips", "to": "chest", "halfSize": [0.13, 0.16, 0.09]},
                "jointSpheres": {"scale": 1.15,
                                 "note": "sphere radius = 1.15 × the widest cylinder it joins, so bending "
                                        "never opens a gap between segments"},
                "attach": "each primitive is rigidly parented to one bone (no skin weights) — this is the "
                          "LAB PREVIEW rig, not the delivery format; a game's own skinned mesh consumes the "
                          "retargeted clip",
            },
            "joints": joints, "bones": bones, "markers": markers,
            "stats": _stats(joints, bones, markers)}


def validate(sk):
    out = []
    J = {j["name"]: j for j in sk["joints"]}
    assert len(sk["bones"]) == len(sk["joints"]) - 1
    out.append(f"tree: {sk['stats']['nodes']} nodes / {sk['stats']['bones']} bones (nodes-1 invariant OK); "
               f"{sk['stats']['articulatingJoints']} articulating + {sk['stats']['leafNodes']} leaf")
    for g, want in SPEC_LENGTHS.items():
        got = {b["length"] for b in sk["bones"] if b["group"] == g}
        bad = [v for v in got if abs(v - want) > 0.011]
        assert not bad, f"{g}: {got} vs spec {want}"
    out.append("bone lengths vs authored spec: ALL MATCH "
               + ", ".join(f"{g} {v}" for g, v in SPEC_LENGTHS.items()))
    for j in sk["joints"]:
        if j["name"].endswith(".L"):
            b = j["name"][:-2]
            r = J.get(f"{b}.R")
            if r:
                assert abs(j["offset"][0] + r["offset"][0]) < 1e-9 and j["offset"][1:] == r["offset"][1:], b
                for dl, dr in zip(j["limits"], r["limits"]):
                    assert (dl["sign"] == dr["sign"]) == (dl["axis"] == "X")
    out.append("L/R symmetry + mirror rule: OK (X DoFs keep sign — knee/hip flexion identical both "
               "sides; Y/Z flip — elbow/abduction opposed, as anatomy requires)")
    kids = {}
    for j in sk["joints"]:
        kids.setdefault(j["parent"], []).append(j["name"])
    dead = [j["name"] for j in sk["joints"] if j["kind"] != "leaf" and not kids.get(j["name"])]
    out.append(f"terminals needing BVH Site synthesis: {dead or 'none'}")
    span = sk["proportions"]["spanOverHeight"]
    lo, hi = sk["proportions"]["tolerance"]["spanOverHeight"]
    out.append(f"proportions: span/height={span} {'OK' if lo <= span <= hi else f'WARN (outside {lo}-{hi})'} | "
               f"leg/height={sk['proportions']['legOverHeight']} (0.51-0.55 expected)")
    crown = W["head"][1] + sk["mesh"]["head"]["offset"][1] + sk["mesh"]["head"]["radius"] * sk["mesh"]["head"]["ellipsoidScale"][1]
    out.append(f"crown with offset head primitive: {crown:.3f} m (bind height {HEIGHT})")
    return out


if __name__ == "__main__":
    sk = build()
    for line in validate(sk):
        print(line)
    here = os.path.dirname(os.path.abspath(__file__))
    dst = os.path.join(here, "..", "fixtures", "skeletons", "lab-21.json")
    with open(dst, "w") as f:
        json.dump(sk, f, indent=1)
        f.write("\n")
    print(f"\nwrote {os.path.relpath(dst, os.path.join(here, '..'))}")
