#!/usr/bin/env python3
"""Generate core/src/rig/humanoid.rig.json — RigPilot's canonical humanoid (VISION.md §5, §6).

The rig is DATA so that the viewer, the limit clamp, the IK solver, the BVH/GLB writers, the MCP
`get_rig` tool and the tests all read one source. Edit the tables below, re-run, commit both files.

    python3 tools/gen-rig.py && python3 tools/check-semantics.py

Conventions (VISION.md §4):
  metres, frames at clip fps, Y-up right-handed, character faces +Z, LEFT side = +X, floor Y=0.
  Rest pose is a T-pose in which every joint's rest frame is axis-aligned with the world (identity
  rest rotation), so offset(child) == worldRest(child) - worldRest(parent) — a plain subtraction.

Why DoF axes are VECTORS and not "X"/"Y"/"Z" labels:
  Under that identity rest convention a T-pose arm points along ±X while a leg points along -Y, so
  "flexion" is a rotation about world Y for the arm and about world X for the leg. Any pipeline that
  bakes a single letter per joint into the code gets one of those two wrong — and the wrong case is
  a shoulder that swings through the floor instead of forward. Each DoF therefore carries the unit
  axis it rotates about, and positive angle always means the anatomically positive motion.
"""
import json, math, os

BIND_HEIGHT = 1.80
UP, FWD, LEFT = (0., 1., 0.), (0., 0., 1.), (1., 0., 0.)

# ── authored rest positions, world space, metres (VISION §5.1) ───────────────
POS = {
    "hips": (0, 0.98, 0), "spine": (0, 1.10, 0), "chest": (0, 1.30, 0),
    "neck": (0, 1.50, 0), "head": (0, 1.62, 0),
}
for s, sx in (("L", 1.0), ("R", -1.0)):          # +X is the character's LEFT
    POS[f"clavicle_{s}"] = (sx*0.03, 1.45, 0)
    POS[f"shoulder_{s}"] = (sx*0.19, 1.47, 0)
    POS[f"elbow_{s}"]    = (sx*0.53, 1.47, 0)
    POS[f"wrist_{s}"]    = (sx*0.79, 1.47, 0)
    POS[f"hip_{s}"]      = (sx*0.09, 0.95, 0)
    POS[f"knee_{s}"]     = (sx*0.09, 0.51, 0)
    POS[f"ankle_{s}"]    = (sx*0.09, 0.07, 0)
    POS[f"toe_{s}"]      = (sx*0.09, 0.02, 0.14)
END = {"head_end": (0, 1.80, 0.02)}
for s, sx in (("L", 1.0), ("R", -1.0)):
    END[f"hand_end_{s}"] = (sx*0.98, 1.47, 0)
    END[f"toe_end_{s}"]  = (sx*0.09, 0.0, 0.21)

PARENT = {"hips": None, "spine": "hips", "chest": "spine", "neck": "chest", "head": "neck",
          "head_end": "head", "toe_end_L": "toe_L", "toe_end_R": "toe_R"}
for s in ("L", "R"):
    PARENT.update({f"clavicle_{s}": "chest", f"shoulder_{s}": f"clavicle_{s}",
                   f"elbow_{s}": f"shoulder_{s}", f"wrist_{s}": f"elbow_{s}",
                   f"hand_end_{s}": f"wrist_{s}",
                   f"hip_{s}": "hips", f"knee_{s}": f"hip_{s}", f"ankle_{s}": f"knee_{s}",
                   f"toe_{s}": f"ankle_{s}"})

# role = the semantic key retargeting matches on; names are for humans and for an engine's hierarchy
ROLE = {"hips": "hips", "spine": "spine", "chest": "chest", "neck": "neck", "head": "head",
        "head_end": "headEnd",
        "clavicle_L": "leftShoulder", "shoulder_L": "leftArm", "elbow_L": "leftElbow",
        "wrist_L": "leftWrist", "hand_end_L": "leftHandEnd",
        "clavicle_R": "rightShoulder", "shoulder_R": "rightArm", "elbow_R": "rightElbow",
        "wrist_R": "rightWrist", "hand_end_R": "rightHandEnd",
        "hip_L": "leftHip", "knee_L": "leftKnee", "ankle_L": "leftAnkle", "toe_L": "leftFootEnd",
        "toe_end_L": "leftToeEnd",
        "hip_R": "rightHip", "knee_R": "rightKnee", "ankle_R": "rightAnkle", "toe_R": "rightFootEnd",
        "toe_end_R": "rightToeEnd"}

# ── DoFs, authored on the LEFT + centre only (VISION §6 limits) ───────────────
# name: (axis, min, max, grazeBelow, grazeAbove, positive-means)
# Axis is the *signed* unit vector: +angle == the anatomically positive motion, so no separate sign
# field exists to get inverted. graze is a pair of NON-NEGATIVE allowances in degrees: the solver may
# end up |grazeBelow| past `min` or |grazeAbove| past `max` before the pose is reported as `adjusted`.
# A hard stop at exactly 0 on a hinge makes IK jitter against the clamp and fights real elbow
# hyperextension, but the *exported* clamp stays the authored min..max, so engines never see an
# illegal value. (VISION §6 only specifies min/max; graze is ours, and it is deliberately an allowance
# rather than a second pair of absolute bounds — absolute soft bounds silently encode a sign.)
D = {
    "hips":   [],  # root: driven by rootKeys {position, heading, tilt}
    "spine":  {"flex": ((1, 0, 0), -15, 30, -5, 5, "bend forward, chest toward +Z"),
               "side": ((0, 0, -1), -15, 15, -5, 5, "bend toward the character's left"),
               "twist": ((0, 1, 0), -20, 20, -5, 5, "turn the front toward the left")},
    "chest":  {"flex": ((1, 0, 0), -15, 30, -5, 5, "bend forward"),
               "side": ((0, 0, -1), -15, 15, -5, 5, "bend toward the left"),
               "twist": ((0, 1, 0), -20, 20, -5, 5, "turn the front toward the left")},
    "neck":   {"flex": ((1, 0, 0), -35, 40, -8, 8, "chin toward chest"),
               "side": ((0, 0, -1), -30, 30, -8, 8, "ear toward left shoulder"),
               "twist": ((0, 1, 0), -40, 40, -10, 10, "look left")},
    "head":   {"flex": ((1, 0, 0), -35, 40, -8, 8, "look up is NEGATIVE here: + = chin tuck"),
               "side": ((0, 0, -1), -30, 30, -8, 8, "tilt left"),
               "twist": ((0, 1, 0), -40, 40, -10, 10, "look left")},
    "clavicle": {"flex": ((0, -1, 0), -20, 20, -5, 5, "shoulder girdle forward (protract)"),
                 "side": ((0, 0, 1), -10, 35, -2, 5, "shrug up; needed for overhead reach")},
    # a T-pose arm points ±X, so its sagittal sweep is about Y and its twist is about the bone axis
    "shoulder": {"flex": ((0, -1, 0), -60, 130, -8, 8, "swing the arm forward in the transverse plane"),
                 "side": ((0, 0, 1), -100, 80, -5, 10, "raise away from the body; -90 hangs at the side"),
                 "twist": ((1, 0, 0), -90, 90, -15, 15, "roll about the humerus (see mirror caveat)")},
    "elbow":    {"flex": ((0, -1, 0), 0, 150, -5, 3, "hinge: hand toward the face")},
    "wrist":    {"flex": ((0, 0, -1), -70, 80, -10, 10, "curl toward the palm"),
                 "side": ((0, 1, 0), -20, 30, -5, 5, "radial deviation (thumb side up)"),
                 "twist": ((1, 0, 0), -80, 80, -10, 10, "carries radioulnar pronation/supination")},
    # a thigh points -Y, so its sagittal sweep is about X, not Y
    "hip":      {"flex": ((-1, 0, 0), -20, 120, -8, 5, "raise the knee forward"),
                 "side": ((0, 0, 1), -30, 45, -8, 5, "open the leg outward"),
                 "twist": ((0, 1, 0), -40, 40, -10, 10, "femur rotation, + = toe out")},
    "knee":     {"flex": ((1, 0, 0), 0, 150, 0, 5, "hinge: heel toward the butt")},
    "ankle":    {"flex": ((-1, 0, 0), -50, 20, -10, 10, "dorsiflexion: toes up"),
                 "side": ((0, 1, 0), -20, 20, -5, 5, "subtalar: sole toward the midline")},
    "toe":      {"flex": ((-1, 0, 0), -20, 60, -5, 10, "toes bend up (push-off)")},
}

# ── bones: (name, from, to, radius) — exactly VISION §5.2's 22 cylinders ─────
BONES = [("pelvis_L", "hips", "hip_L", 0.08), ("pelvis_R", "hips", "hip_R", 0.08),
         ("lower_spine", "hips", "spine", 0.12), ("upper_spine", "spine", "chest", 0.13),
         ("upper_chest", "chest", "neck", 0.12), ("neck_bone", "neck", "head", 0.05)]
for s in ("L", "R"):
    BONES += [(f"clavicle_bone_{s}", f"clavicle_{s}", f"shoulder_{s}", 0.035),
              (f"upper_arm_{s}", f"shoulder_{s}", f"elbow_{s}", 0.045),
              (f"forearm_{s}", f"elbow_{s}", f"wrist_{s}", 0.035),
              (f"hand_{s}", f"wrist_{s}", f"hand_end_{s}", 0.03),
              (f"thigh_{s}", f"hip_{s}", f"knee_{s}", 0.07),
              (f"shin_{s}", f"knee_{s}", f"ankle_{s}", 0.05),
              (f"foot_{s}", f"ankle_{s}", f"toe_{s}", 0.04),
              (f"toe_bone_{s}", f"toe_{s}", f"toe_end_{s}", 0.03)]

# three hierarchy edges deliberately have no cylinder (head->head_end is only a sphere anchor,
# chest->clavicle is inside the torso box): 26 nodes -> 25 edges -> 22 drawn bones.
BONELESS_EDGE_NOTE = ("25 hierarchy edges, 22 cylinders: chest->clavicle_{L,R} and head->head_end "
                      "have no drawn bone (the clavicle sits inside upper_chest, the skull is one sphere)")

CONTACTS = []
for s, sx in (("L", 1.0), ("R", -1.0)):
    CONTACTS += [(f"heel_{s}", f"ankle_{s}", (sx*0.09, 0.0, -0.05)),
                 (f"ball_{s}", f"ankle_{s}", (sx*0.09, 0.0, 0.14)),
                 (f"toe_tip_{s}", f"toe_{s}", (sx*0.09, 0.0, 0.21))]

EFFECTORS = [("hand_L", "wrist_L"), ("hand_R", "wrist_R"),
             ("foot_L", "ankle_L"), ("foot_R", "ankle_R"),
             ("toe_L", "toe_L"), ("toe_R", "toe_R"), ("head", "head")]

# ── mirror about the sagittal (X=0) plane ────────────────────────────────────
# Pose-mirroring must satisfy VISION §6's last test: mirrored world positions with X negated.
# Conjugating rot(n,θ) by the mirror gives rot(M·n,-θ), i.e. the mirrored axis is (nx,-ny,-nz)
# with the SAME positive angle — which is what makes hinge flexion keep its sign across sides
# (both knees bend backward) while arm raise and elbow flexion invert (both arms hang at -90).
def mirror_axis(a):
    return [a[0], -a[1], -a[2]]


def build():
    allpos, parent = dict(POS), dict(PARENT)
    allpos.update(END)
    joints = []
    for name in list(POS) + list(END):
        par = parent[name]
        off = [0.0, 0.0, 0.0] if par is None else [round(allpos[name][i] - allpos[par][i], 6) for i in range(3)]
        base = name[:-2] if name.endswith(("_L", "_R")) else name
        side = name[-1] if name.endswith(("_L", "_R")) else None
        src = {} if name in END else D.get(base, {})
        axes = []
        for an, (ax, mn, mx, gb, ga, means) in (src or {}).items():
            a = list(ax) if side != "R" else mirror_axis(list(ax))
            axes.append({"name": an, "axis": [round(v, 6) for v in a], "min": mn, "max": mx,
                         "graze": [abs(gb), abs(ga)], "positiveMeans": means})
        kind = "root" if name == "hips" else ("endSite" if name in END else "joint")
        joints.append({"name": name, "role": ROLE[name], "parent": par, "kind": kind,
                       "offset": off, "restPosition": [round(v, 6) for v in allpos[name]], "axes": axes,
                       "radius": None, "color": "left" if side == "L" else ("right" if side == "R" else "center"),
                       "effector": next((e for e, j in EFFECTORS if j == name), None)})
    bones = [{"name": n, "from": a, "to": b, "radius": r,
              "length": round(math.dist(allpos[a], allpos[b]), 4)} for n, a, b, r in BONES]
    rad_of = {}
    for b in bones:
        for e in (b["from"], b["to"]):
            rad_of[e] = max(rad_of.get(e, 0.0), b["radius"])
    for j in joints:
        j["radius"] = round((rad_of.get(j["name"], 0.05)) * 1.1, 4)  # VISION: 1.1x widest cylinder it joins
    RW = {}
    def rest_of(nm):
        if nm in RW: return RW[nm]
        par = PARENT[nm]
        RW[nm] = allpos[nm] if par is None else tuple(rest_of(par)[i] + (allpos[nm][i]-allpos[par][i]) for i in range(3))
        return RW[nm]
    for b in bones:
        a, c = rest_of(b["from"]), rest_of(b["to"])
        b["clearanceAtRest"] = round(min(a[1], c[1]) - b["radius"], 4)
        b["sinksBelowFloor"] = b["clearanceAtRest"] < -0.005
    marks = [{"name": n, "role": ROLE.get(n, n), "parent": p,
              "offset": [round(pos[i] - allpos[p][i], 6) for i in range(3)],
              "restPosition": [round(v, 6) for v in pos], "contact": True} for n, p, pos in CONTACTS]

    # mesh clearance at rest: the lowest point of each bone's capsule. Authored to expose the fact
    # that foot_L/toe_bone_L sink below the floor even in a perfect T-pose (see RECONCILIATION.md).
    def restworld(nm):
        return rig_rest[allpos, J_local()][nm]
    span = round(2 * allpos["hand_end_L"][0], 3)
    crown = 1.70 + 0.10
    return {
        "id": "humanoid-21", "version": 1, "schema": "rigpilot.rig@1",
        "conventions": {
            "unit": "m", "upAxis": "+Y", "forwardAxis": "+Z", "leftAxis": "+X",
            "handedness": "right-handed", "floor": "Y = 0",
            "restPose": "T-pose, identity rest rotation for every joint, palms down, feet flat",
            "offsetSpace": "parent-local, which under the identity rest equals worldRest(child)-worldRest(parent)",
            "dofOrder": ["flex", "side", "twist"],
            "dofCompose": "local = R(twist) * R(side) * R(flex); each R is about that axis vector by <degrees>",
            "limits": "relative to the T-pose rest; authored in degrees on semantic axes, never raw quaternions",
            "mirroring": "right-side axes are generated from the left by axis (nx,ny,nz)->(nx,-ny,-nz), angle unchanged",
            "notSameAsGlTF": "glTF is -Z forward: export wraps the rig in a parent node yawed by pi rather than "
                             "rewriting every root key, so the exported root track stays numerically equal (VISION "
                             "§4 says 'same as glTF' — that parenthetical is wrong, see docs/RECONCILIATION.md)",
        },
        "root": {"joint": "hips", "restPosition": [0.0, POS["hips"][1], 0.0],
                 "degreesOfFreedom": "position xyz + heading + tilt{flex,side}",
                 "note": "the root's height lives HERE, not in an offset: parent is null, so FK starts "
                         "from rootKeys.position. VISION §5.1 lists hips at y=0.98 — that number has to "
                         "be stored somewhere or get_rig cannot return it and the rest pose cannot be rebuilt."},
        "stats": {"nodes": len(joints), "articulatingJoints": sum(1 for j in joints if j["kind"] in ("root", "joint")),
                  "endSites": sum(1 for j in joints if j["kind"] == "endSite"),
                  "bones": len(bones), "contactMarkers": len(marks), "hierarchyEdges": len(joints) - 1,
        "bonesSinkingAtRest": sorted(b["name"] for b in bones if b["sinksBelowFloor"]),
                  "note": BONELESS_EDGE_NOTE},
        "bindHeight": BIND_HEIGHT,
        "proportions": {"height": BIND_HEIGHT, "span": span, "spanOverHeight": round(span / BIND_HEIGHT, 3),
                        "legLength": 0.95, "armLength": 0.79, "crown": crown,
                        "band": {"spanOverHeight": [0.95, 1.05], "legOverHeight": [0.51, 0.55]},
                        "warning": "span/height 1.089 is outside the band: fingertip span 1.96 m on a 1.80 m "
                                   "character. shoulder_* at ±0.19 is the deltoid, the glenohumeral centre is "
                                   "≈±0.17. Cosmetic in the viewer, but this ratio is what a retargeter "
                                   "sanity-checks on an imported rig."},
        "mesh": {
            "head": {"parent": "head", "type": "sphere", "radius": 0.10, "offset": [0, 0.08, 0.02],
                     "ellipsoidScale": [0.80, 1.0, 1.06], "crown": crown,
                     "note": "VISION says r 0.11 at y 1.71, which crowns at 1.82 on a 1.80 rig; 0.10 at 1.70 "
                             "lands exactly on bindHeight. ellipsoidScale flattens X and lengthens Z because a "
                             "skull is ~4 cm narrower than it is deep (half-extents 0.08 wide / 0.106 deep)."},
            "torso": {"type": "box", "from": "hips", "to": "chest", "halfSize": [0.14, 0.16, 0.10],
                      "note": "covers the boneless chest->clavicle edges so the girdle does not float"},
            "jointSpheres": {"scale": 1.1, "note": "radius = 1.1x the widest cylinder the joint joins, so bending never opens a gap"},
            "colors": {"left": [0.30, 0.55, 0.95], "right": [0.95, 0.42, 0.32], "center": [0.80, 0.82, 0.86],
                       "bone": [0.62, 0.65, 0.70], "floor": [0.10, 0.11, 0.13],
                       "note": "left blue / right red so a preview image tells a mirror bug apart at a glance"},
            "attach": "one rigid primitive per bone, each vertex 100% weighted to a single joint (VISION §M6). "
                      "This is the studio body; a game's own skinned mesh consumes the exported animation, it is "
                      "not something we skin here.",
        },
        "joints": joints, "bones": bones, "markers": marks,
        "effectors": [{"name": c["effector"], "tip": c["tip"], "root": c["root"], "mid": c["mid"]} for c in CHAINS],
        "ikChains": CHAINS,
        "restPose": {"joints": {n: [round(v,6) for v in rest_of(n)] for n in list(POS)+list(END)},
                     "markers": {m["name"]: m["restPosition"] for m in marks},
                     "note": "flat lookup of world rest positions for the viewer, the checks and get_rig; "
                             "derived from offsets by the generator so it can never drift out of sync"},
    }


# two-bone chains the solver owns: (effector, root, mid, end, pole direction at rest)
CHAINS = [
    {"effector": "hand_L", "tip": "hand_end_L", "root": "shoulder_L", "mid": "elbow_L",
     "pole": [0, -1, 0], "poleNote": "elbows point back/down: the pole is the direction the mid joint bulges"},
    {"effector": "hand_R", "tip": "hand_end_R", "root": "shoulder_R", "mid": "elbow_R", "pole": [0, -1, 0]},
    {"effector": "foot_L", "tip": "ankle_L", "root": "hip_L", "mid": "knee_L", "pole": [0, 0, 1],
     "poleNote": "knees point forward (+Z)"},
    {"effector": "foot_R", "tip": "ankle_R", "root": "hip_R", "mid": "knee_R", "pole": [0, 0, 1]},
]
for i, c in enumerate(CHAINS):
    CHAINS[i]["name"] = c["effector"]

SPEC_LEN = {"thigh_L": 0.44, "shin_L": 0.44, "upper_arm_L": 0.34, "forearm_L": 0.26,
            "hand_L": 0.19, "foot_L": 0.152, "toe_bone_L": 0.073, "hand_R": 0.19}

if __name__ == "__main__":
    rig = build()
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.join(here, "..")
    dst = os.path.join(root, "core", "src", "rig", "humanoid.rig.json")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "w") as f:
        json.dump(rig, f, indent=1)
        f.write("\n")
    st = rig["stats"]
    print(f"{st['articulatingJoints']} articulating joints + {st['endSites']} end sites = {st['nodes']} nodes")
    print(f"{st['hierarchyEdges']} hierarchy edges -> {st['bones']} drawn cylinders + 3 boneless")
    print(f"{st['contactMarkers']} foot contact markers, {len(CHAINS)} IK chains")
    for g, want in SPEC_LEN.items():
        got = next(b["length"] for b in rig["bones"] if b["name"] == g)
        assert abs(got - want) < 0.011, f"{g}: {got} != {want}"
    print("bone lengths vs VISION §5.1 notes: ALL MATCH")
    print(f"span/height {rig['proportions']['spanOverHeight']} (band 0.95-1.05), crown {rig['proportions']['crown']}")
    print("wrote", os.path.relpath(dst, root))
