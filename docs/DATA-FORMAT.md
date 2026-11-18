# `motionlab.anim` — the clip format

Everything downstream depends on this file, so it gets decided first. Design goals, in priority
order:

1. **Editable in the browser.** Sparse keyframes with explicit interpolation, because the manual
   editor is a co-equal input to capture.
2. **Losslessly convertible to BVH and glTF animation.** Both are dense + Euler-or-quat, so the
   format must be able to _bake_ deterministically.
3. **Retargetable by semantics, not by name.** Joints carry a `role`, so a Mixamo rig, the UE
   mannequin, and a Ready Player Me avatar all speak the same file.
4. **Diffable / debuggable.** Plain JSON, one track per joint, no binary blobs, no base64.

Non-goal: this is not an interchange format for _meshes_. Rig skinning, blendshapes, and materials
live in the GLB/FBX side and are only referenced by name.

---

## Conventions (the bugs live here)

| Thing            | Choice                                                                                    | Why it matters                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Units            | meters                                                                                    | BVH is unitless and most mocap BVH is **centimetres** — import must scale, see §BVH                                      |
| Axes             | right-handed, **Y-up**                                                                    | three.js and glTF agree; some BVH is Z-up → needs an explicit up-axis flag                                               |
| Facing           | character looks down **+Z** in the lab                                                    | glTF convention is **-Z forward** → export applies a π yaw on the root node                                              |
| Rest pose        | **Canonical Rest Pose**: every joint's local rotation is identity, T-pose, arms along ±X  | the single biggest simplifier — see below                                                                                |
| Left/right       | `+X` is the character's left side; `.L`/`.R` suffixes                                     | must be _fixed and tested_, not assumed — see the raise-left-arm test below                                              |
| DoF axes         | declared per joint (`{axis, sign}`), never inherited from a global "X means forward" rule | under CRP a T-pose arm flexes about Y while a leg flexes about X; the same number on the wrong axis dislocates the joint |
| Mirror           | `.R` limits generated from `.L` by mirroring about X                                      | authoring both sides by hand is how you get a right elbow that bends backwards                                           |
| Contact          | 6 `markers` (heel, ball, toeTip per foot), non-articulating                               | foot-lock reads marker heights, not ankle velocity guesses                                                               |
| Rotation storage | quaternion `[x, y, z, w]`, local to parent                                                | gimbal-free bake; Euler is a UI-only projection                                                                          |
| Time             | integer **frame index** at `meta.fps`                                                     | float seconds drift and make exact round-trip impossible                                                                 |
| Interpolation    | per keyframe: `linear` \| `step` \| `bezier` \| `ease`                                    | maps onto glTF LINEAR / STEP / CUBICSPLINE                                                                               |

**Canonical Rest Pose (CRP).** The skeleton is authored so that all rest local rotations are
identity and bones point along fixed axes. Three payoffs: BVH needs no rest-rotation channel (it has
none), glTF `inverseBindMatrices` fall out of a single hierarchy walk, and — the one that mattered
for `lab-21` — a joint's `offset` degenerates to a plain world-space subtraction, so a table of
rest positions in metres drops into the skeleton file with no solver in the way. Real rigs that bind in
an A-pose are handled by the **importer**, which re-expresses the rig's joints into CRP once,
records the delta, and never leaks that delta into the clip. If we instead stored "whatever the
DCC gave us", every exporter would need the source bind pose and BVH round-trips would be lossy.

---

## Schema

```jsonc
{
  "format": "motionlab.anim",
  "version": 1,

  "meta": {
    "name": "nervous_walk_v3",
    "fps": 30,
    "frames": 62, // duration = frames / fps
    "loop": false,
    "rootMotion": "world-space", // "in-place" (root bakes to origin) | "world-space"
    "upAxis": "Y",
    "unitScale": 1.0, // meters
    "created": "2026-11-18T07:55:00Z",
    "revision": 4,
  },

  // A lab clip points at the canonical rig instead of repeating 26 joints on every file,
  // which keeps clip diffs readable. Anything imported from a foreign hierarchy inlines its
  // skeleton instead (exactly one of the two keys must be present).
  "skeletonRef": "lab-21@1",

  "skeleton": {
    "id": "lab-21",
    "version": 1,
    "nodes": 26,
    "articulatingJoints": 21,
    "bones": 25,
    "contactMarkers": 6,
    "joints": [
      {
        "name": "hips",
        "role": "hips", // semantic key, from a fixed enum
        "parent": null, // null => the root body
        "kind": "root", // "root" | "joint" | "leaf" (non-articulating end)
        "offset": [0, 0.98, 0], // parent-local metres; under CRP == world delta
        "limits": [], // root is free 6-DoF, driven by the root tracks
        "channelOrder": "ZXY", // Euler order used for BVH in/out of this joint
      },
      {
        "name": "hip.L", // JOINT is at the hip; the thigh is the bone below it
        "role": "leftHip",
        "parent": "hips",
        "kind": "joint",
        "offset": [0.09, -0.03, 0], // +X is the character's LEFT (see conventions)
        "limits": [
          {
            "axis": "X",
            "sign": -1,
            "label": "flexion",
            "min": -20,
            "max": 120,
            "softMin": -8,
            "softMax": 5,
          },
          {
            "axis": "Z",
            "sign": 1,
            "label": "abduction",
            "min": -30,
            "max": 45,
            "softMin": -8,
            "softMax": 5,
          },
          {
            "axis": "Y",
            "sign": 1,
            "label": "twist",
            "min": -40,
            "max": 40,
            "softMin": -10,
            "softMax": 10,
          },
        ],
        "channelOrder": "ZXY",
      },
      {
        "name": "knee.L",
        "role": "leftKnee",
        "parent": "hip.L",
        "kind": "joint",
        "offset": [0, -0.44, 0],
        "limits": [
          {
            "axis": "X",
            "sign": 1,
            "label": "flexion",
            "min": 0,
            "max": 150,
            "softMin": 0,
            "softMax": 5,
          },
        ], // hinge: one DoF, no side bend
        "channelOrder": "ZXY",
      },
      {
        "name": "toeEnd.L",
        "role": "leftToeEnd",
        "parent": "toe.L",
        "kind": "leaf",
        "offset": [0, 0, 0.07],
        "limits": [],
        "channelOrder": "ZXY",
      },
      // ... 22 more
    ],
    "bones": [
      { "from": "hip.L", "to": "knee.L", "radius": 0.07, "group": "thigh", "length": 0.44 },
    ],
    "markers": [
      {
        "name": "heel.L",
        "role": "leftHeel",
        "parent": "ankle.L",
        "position": [0.09, 0.015, -0.05],
        "contact": true,
      },
    ],
  },

  "tracks": [
    {
      "path": "root.position", // the only prismatic track; always root
      "unit": "m",
      "keys": [
        { "t": 0, "v": [0, 0.98, 0.0], "interp": "bezier", "tanOut": [0, 0, 0.04] },
        {
          "t": 15,
          "v": [0, 0.98, 0.62],
          "interp": "bezier",
          "tanIn": [0, 0, 0.03],
          "tanOut": [0, 0, 0.05],
        },
      ],
    },
    {
      "path": "root.rotation",
      "unit": "quat",
      "keys": [{ "t": 0, "v": [0, 0.7071, 0.7071, 0], "interp": "linear" }],
    },
    {
      "path": "joints.spine.rotation",
      "unit": "quat",
      "keys": [
        { "t": 0, "v": [0, 0, 0, 1], "interp": "bezier", "tanOut": [0, 0, 0.05] },
        { "t": 15, "v": [0, 0, 0.04, 0.999], "interp": "bezier", "tanIn": [0, 0, 0.05] },
      ],
    },
  ],

  "retargetHints": {
    "legLength": 0.95, // hips->floor, meters: the number that drives leg IK on a new rig
    "armLength": 0.71,
    "height": 1.78,
    "style": "heavy", // free label; the style-transfer stage reads it
  },

  "capture": {
    // provenance; optional but keep it whenever you can
    "source": "webcam", // "webcam" | "manual" | "mixed" | "generated"
    "device": "FaceTime HD 1080p",
    "model": "mediapipe-pose-landmarker@0.10 / lite",
    "sourceFps": 29.97,
    "markerFps": 30,
    "visibilityThreshold": 0.5,
    "droppedFrames": [41, 42, 43],
    "landmarks": "assets/nervous_walk_v3.lm33.json", // sidecar file, not inline
  },
}
```

### Rules worth stating out loud

- **`t` is a frame index**, not seconds. Keyframe `t` must be a non-negative integer `< frames`
  when the track is baked; authoring may use any integer, and playback samples by slerp/slerp+ease
  between neighbours. A track with no keys falls back to the joint's rest (identity).
- **Tracks are sparse; processing is dense.** Editors read and write sparse keys. Every processor
  (smooth, foot-lock, retarget) and every exporter starts with `bake(clip) -> DenseClip` — a flat
  `Float32Array` of `frames × joints × 4` quats plus root pos — and ends with `rebake()`. This is
  the single most important API decision: it keeps the editor's data small and human-diffable
  while making the numeric code a straightforward array pass.
- **`role` beats `name`.** Names are for humans and for matching an existing hierarchy; retargeting
  matches on `role`. Roles are a closed enum (below) — no ad-hoc strings, or retargeting becomes a
  fuzzy-matching nightmare.
- **Three tests pin the conventions**, and they run in CI as the acceptance for the rig (M1): raise
  `leftArm` flexion to 170° and the `+X`-side hand marker must go up and forward, not back;
  `leftHip` flexion 90° must put `knee.L` toward `+Z`; `leftKnee` flexion 90° must move `ankle.L`
  toward `−Z` (heel toward butt) with no lateral travel. A wrong handedness or a wrong hinge axis
  fails one of those three, and every later stage inherits that failure silently.
- **Landmarks stay out of the clip.** 33 MediaPipe landmarks × N frames is the noisy, redundant
  data; it goes in a sidecar so re-running the capture→clip solver never needs the video again.

### The canonical rig: `lab-21` — 21 articulating joints

Generated and validated by [`tools/gen-skeleton.py`](../tools/gen-skeleton.py) into
[`fixtures/skeletons/lab-21.json`](../fixtures/skeletons/lab-21.json). The skeleton is data, not
code, because it has to be readable by the Blender script, the Unity importer and the tests — and
because a rig change should be a diff, not a PR.

| Group    | Joints                                              | DoF                                       |
| -------- | --------------------------------------------------- | ----------------------------------------- |
| Core     | `hips` (root) · `spine` · `chest` · `neck` · `head` | 3-axis each, root free                    |
| Each arm | `clavicle` · `shoulder` · `elbow` (hinge) · `wrist` | 2 / 3 / 1 / 3                             |
| Each leg | `hip` · `knee` (hinge) · `ankle` · `toe` (hinge)    | 3 / 1 / 2 / 1                             |
| Leaves   | `headEnd` · `handEnd.L/R` · `toeEnd.L/R`            | none — geometry + BVH `Site` anchors only |

That is your 21 articulating joints, plus **5 non-articulating leaf nodes**, which is why the tree is
**26 nodes / 25 bones** rather than 22 bones: a tree of 21 joints has 20 edges, so any bone count
above 20 already implies leaf nodes. Hands and feet need a tip to hang a cylinder on, and the head
needs one or the skull can only be drawn by faking a radius. Leaves cost nothing (they carry an
offset and no tracks) and they are exactly what BVH wants as `Site` blocks. Roles:

```
hips · spine · chest · neck · head · headEnd
leftShoulder/rightShoulder (clavicle) · leftArm/rightArm (shoulder) · leftElbow · leftWrist
leftHandEnd · leftHip · leftKnee · leftAnkle · leftFootEnd · leftToeEnd   (+ right*, mirrored)
leftHeel · leftBall · leftToeTip                                            (foot contact markers)
```

Roles come from a closed enum, and `leftShoulder` meaning the _clavicle_ is the one place where the
role names and joint names disagree deliberately — `shoulder` is the glenohumeral joint, and glTF
and both engines will hand you a bone named `shoulder` that is either of them, so `role` disambiguates.
Unrecognised joints get `role: "extra"` with a `side`, so a prop bone (weapon grip, tail, wing) rides
along in a clip without breaking validation.

#### Axes: the part of the table that could not be inherited

Your limits table says "X = bend forward/back, Y = twist, Z = side to side". That is true for the
**legs, spine and head**, and false for a **T-pose arm**, because under CRP the local frames are all
aligned with the world and the arm bones point along ±X:

| Motion         | Bone direction at rest | Rotation axis                                     | So                                      |
| -------------- | ---------------------- | ------------------------------------------------- | --------------------------------------- |
| knee flexion   | shin along −Y          | **X**                                             | "X = forward/back" holds                |
| hip flexion    | thigh along −Y         | **X** (positive value = extension, so `sign: -1`) | holds, with a sign flip                 |
| elbow flexion  | forearm along ±X       | **Y**                                             | a hand reaching forward is a Y rotation |
| humerus twist  | bone along ±X          | **X**                                             | twist = about the _bone_ axis, not "Y"  |
| clavicle raise | clavicle along ±X      | **Z**                                             | lift = Z rotation, not a twist          |
| femur twist    | bone along −Y          | **Y**                                             |                                         |

Two consequences, both already encoded in the generated file:

1. Every DoF declares its `axis` and its `sign`; nothing inherits a global axis meaning. A
   `dofValue = sign * rotationAbout(axis)` so the UI can show "flexion 87°" (anatomical, always
   positive when bending the anatomically positive way) while the math stores signed radians.
   The same `sign` field is what makes the twist/abduction split unambiguous for `axisMap` in
   retargeting.
2. **Left/right is derived by mirroring, never authored twice.** Mirroring about X conjugates
   `rot(n, θ)` to `rot(M·n, −θ)`; since `M·X = −X`, an X-axis DoF nets out the _same_ sign while Y
   and Z DoFs _flip_. Anatomy agrees exactly: knee and hip flexion keep their sign across sides,
   elbow flexion and shoulder abduction invert. The generator applies that rule and asserts on it,
   so a right elbow that bends backwards is impossible by construction — and that single bug class is
   behind a large share of "the retargeted rig looks broken" reports.

`softMin`/`softMax` are a per-DoF overshoot allowance. A hard clamp at exactly 0 on the elbow and
knee makes IK fight the limit and jitter; real elbows hyperextend a few degrees, so the clamp is hard
at the authored bound and the _pose solver_ is allowed to graze past it by `softMin`.

#### Foot contact markers

The 3-per-foot invisible points you asked for are first-class `markers` (6 total) rather than joints:
they never animate, but the **foot-lock processor is built on them** and it changes the algorithm for
the better. Ankle-velocity minima guess contact; heel/ball/toeTip _height under a threshold plus a
velocity test_ is what real contact detection does (the same signal CMU/AMASS contact labels use), so
contact frames become a derived, inspectable array instead of a heuristic. `ball` sits under the MTP
joint and duplicates `toe.L`'s XZ roughly — keep both anyway: the toe joint rotates the toe bone, and
the ball must stay glued to the ground while it does, which is exactly how you get a rolling push-off.

---

## Mapping to BVH

BVH is a hierarchy of `OFFSET` + `CHANNELS`, per-joint Euler rotations in a per-joint channel
order, and no rest-pose rotations. That is **exactly** our model plus one projection — which is why
BVH is the right first export.

Export (`clip -> .bvh`):

```
ROOT <name>
{ OFFSET 0 0 0; if rootMotion=="world-space": the baked root.position, else 0 0 0
  CHANNELS 6  Xposition Yposition Zposition Zrotation Xrotation Yrotation   // or 3 if in-place
  ... JOINT children with OFFSET = joint.offset, CHANNELS 3 with joint.channelOrder
}
END Site    (every terminal joint needs two leaf `Site` blocks; lab-21 has 5 terminals
             -> headEnd, handEnd.L/R, toeEnd.L/R, which is why leaf nodes exist anyway)
```

- quat → Euler **in that joint's `channelOrder`**, degrees. Getting the order wrong per-joint is
  the classic silent corruption in every mocap pipeline; the format stores the order so no inference
  is needed.
- Export `MOTION` with `Frames:` + `Frame Time:` — write `1/fps` with 9 decimals and accept the
  round-trip check compares frame counts, not the float.

Import (`.bvh -> clip`):

- **Height-based unit detection.** Compute rest height from summed `OFFSET` lengths; if it lands in
  120–260, the file is centimetres → `unitScale = 0.01`, rescale all offsets and root positions.
  (1.78 vs 178 is unambiguous; a 600-unit BVH is something else and should fail loudly.)
- **Up-axis sniff**: for a mostly-upright character, compare the std-dev of each root axis; the near-zero
  std-dev axis is the vertical one. Store as `meta.upAxis` and normalise to Y-up by rotating the root.
  Never assume — Z-up BVH from older software is common.
- Any joint with no parent → `root`; joints BVH calls `Hips`/`pelvis`/`hips_joint` → `role: hips`,
  via a small alias table you keep appending to. Roles are matched case-insensitively after
  stripping a `(pelvis|hips|root)` prefix/suffix.

Round-trip contract (property test, not a wish): `bake(import(export(clip)))` equals `bake(clip)`
within **1e-4 per quat component** and 1e-6 m of root position, over random clips. Euler→quat→Euler
is where precision goes to die, so the test asserts on the _baked arrays_, not the keyframes.

---

## Mapping to glTF / GLB

Two different GLBs, and conflating them is a design error the plan has to keep apart:

|                   | What it is                                                                                                                                             | Skinning                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `lab-preview.glb` | the rig you pose and inspect: 25 bone cylinders + 26 joint spheres + the head ellipsoid, each bound to exactly one joint (`JOINT_0 = j, WEIGHT_0 = 1`) | none needed — no weights, no smoothing, exports trivially and never breaks                              |
| delivery clip     | animation _data_ for the game's own character, retargeted onto its skeleton                                                                            | the **game** mesh keeps its own weights; we supply `skin` node names + `animation` channels, not a body |

The rigid-preview rig is why the exporter is easy, and it is also why the preview will look like a
robot at the shoulders and hips. That is fine — the preview exists to judge _motion_, and adding skin
weights to the lab would silently make the lab's rig the thing you author against, which is the wrong
dependency. If a smooth preview body is wanted later, it is one extra asset plus `KHR_materials`, not
a format change.

One glTF `skin`, one `node` per joint, `name` = joint name, `extras` carries `role` so the rig
stays retargetable after export:

- `inverseBindMatrices`: walk the hierarchy from CRP; since all rest local rotations are identity,
  `worldRest(j) = translate(worldRest(parent)) * translate(offset(j))` — no solver needed.
- Per joint, one `animation.channel` targeting `node.rotation` (`sampler.output` = quats,
  `input` = seconds as `frame / fps`) and, for `root`, a second channel targeting
  `node.translation`.
- Interpolation: `linear`→`LINEAR`, `step`→`STEP`, `bezier`→`CUBICSPLINE` (which stores in/out
  tangents per key — our `tanIn`/`tanOut` map directly, so **bezier survives the export**).
- Forward-axis fix: since we author facing `+Z` and glTF says `-Z`, wrap the whole rig in a parent
  node rotated π about Y rather than mutating every root key. That keeps the exported root track
  numerically equal to the authored one, which matters for debugging.
- `extras.motionlab` on the mesh gets `{fps, frames, loop, rootMotion, retargetHints}` — Unity's
  GLTFast and Unreal's glTF plugin both surface `extras`, so the metadata is not lost in the binary.

---

## Retargeting: the actual math

Rig A (our clip) -> Rig B (the game skeleton). Work in **local space, on deviations from rest**, and
carry one per-joint axis-alignment rotation. Under CRP the source's rest is identity, so the A side
is free and all the mismatch lives on B.

```
// A is already authored against identity rest, so its local track IS the deviation:
devA[j] = qA[j]

// align A's bone axes onto B's (identity when both rigs use the same bone-local frames)
M[j]    = axisMap(A.boneFrame[j], B.boneFrame[j])
devB[j] = M[j]^-1 * devA[j] * M[j]
devB[j] = clampToDoF(devB[j], B.joints[j].allowedAxes)   // 1-3 axis rigs, see below

// apply through B's bind pose, then convert back to what the engine stores
gB[j]        = gB[parent(j)] * B.restLocal[j] * devB[j] * B.restLocal[j]^-1
qB_local[j]  = inverse(B.restLocal[j]) * inverse(gB[parent(j)]) * gB[j] * B.restLocal[j]
```

`axisMap` is the piece every retargeter quietly gets wrong: a bone's local frame has an arbitrary
roll in most DCC exports, so "rotate around the bone's X" means different things on two rigs. Derive
each frame from the bone direction plus a roll hint (knee/elbow pole vector, or the rig's own twist
axis) — never from index or name.

Three things that need real code, which is why this is a milestone and not a utility:

- **Limb-length mismatch.** Rotations transfer; translations do not. If A's leg is 0.92 m and B's is
  1.05 m, identical thigh/shin angles leave B's foot floating. Fix: after the rotation pass, run
  two-bone IK on `hip->knee->ankle` and `shoulder->elbow->wrist` targeting where A's foot/hand _would_
  be (scaled by the length ratio), so ground contact and held props survive. `retargetHints.legLength`
  and `armLength` exist precisely to make that exact rather than estimated.
- **Swing/twist split at the hips.** Split `devB[hips]` into twist about the spine axis + swing, and
  route them differently: swing stays on the hip bone, twist goes into `root.rotation` when
  `meta.rootMotion == "world-space"`, and is discarded when `"in-place"` — otherwise the character
  spins on the spot instead of stepping forward.
- **DoF loss.** A clip joint is a free quaternion; a UE/Mixamo joint is usually 1-3 Euler channels.
  Project onto the target's allowed axes (`clampToDoF`) _before_ export, or the engine snaps silently
  every frame and the result jitters in a way that is miserable to debug.

Order of operations that matters: **retarget after smoothing, before foot-lock.** Retargeting rescales
limbs, which changes velocities — and foot-lock reads velocities. Lock first and the locks drift.

## Versioning

`version` is an integer, and the loader accepts only `major == 1`. Migrations are pure functions
`v1 -> v1 -> v2` living in `src/format/migrations/`, each with a fixture. Because clips are
human-readable JSON, a broken loader is inspectable — which is the whole reason we are not using
GLB as the authoring format.
