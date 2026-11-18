# `motionlab.anim` — the clip format

Everything downstream depends on this file, so it gets decided first. Design goals, in priority
order:

1. **Editable in the browser.** Sparse keyframes with explicit interpolation, because the manual
   editor is a co-equal input to capture.
2. **Losslessly convertible to BVH and glTF animation.** Both are dense + Euler-or-quat, so the
   format must be able to *bake* deterministically.
3. **Retargetable by semantics, not by name.** Joints carry a `role`, so a Mixamo rig, the UE
   mannequin, and a Ready Player Me avatar all speak the same file.
4. **Diffable / debuggable.** Plain JSON, one track per joint, no binary blobs, no base64.

Non-goal: this is not an interchange format for *meshes*. Rig skinning, blendshapes, and materials
live in the GLB/FBX side and are only referenced by name.

---

## Conventions (the bugs live here)

| Thing | Choice | Why it matters |
| --- | --- | --- |
| Units | meters | BVH is unitless and most mocap BVH is **centimetres** — import must scale, see §BVH |
| Axes | right-handed, **Y-up** | three.js and glTF agree; some BVH is Z-up → needs an explicit up-axis flag |
| Facing | character looks down **+Z** in the lab | glTF convention is **-Z forward** → export applies a π yaw on the root node |
| Rest pose | **Canonical Rest Pose**: every joint's local rotation is identity, T-pose, arms along ±X | the single biggest simplifier — see below |
| Rotation storage | quaternion `[x, y, z, w]`, local to parent | gimbal-free bake; Euler is a UI-only projection |
| Time | integer **frame index** at `meta.fps` | float seconds drift and make exact round-trip impossible |
| Interpolation | per keyframe: `linear` \| `step` \| `bezier` \| `ease` | maps onto glTF LINEAR / STEP / CUBICSPLINE |

**Canonical Rest Pose (CRP).** The skeleton is authored so that all rest local rotations are
identity and bones point along fixed axes. Two payoffs: BVH needs no rest-rotation channel (it has
none), and glTF `inverseBindMatrices` fall out of a single hierarchy walk. Real rigs that bind in
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
    "frames": 62,                    // duration = frames / fps
    "loop": false,
    "rootMotion": "world-space",     // "in-place" (root bakes to origin) | "world-space"
    "upAxis": "Y",
    "unitScale": 1.0,                // meters
    "created": "2026-11-18T07:55:00Z",
    "revision": 4
  },

  "skeleton": {
    "id": "lab-tpose-23",
    "jointCount": 23,
    "joints": [
      {
        "name": "hips",
        "role": "hips",                       // semantic key, from a fixed enum
        "parent": null,                        // null => the root body
        "offset": [0, 1.02, 0],                // translation in PARENT-local space, meters
        "length": 0,                           // derived from children; stored for the UI
        "channelOrder": "ZXY"                  // Euler order used for BVH in/out of this joint
      },
      {
        "name": "thigh.L",
        "role": "leftHip",
        "parent": "hips",
        "offset": [-0.09, -0.06, 0],
        "length": 0.44,
        "channelOrder": "ZXY"
      }
      // ...
    ]
  },

  "tracks": [
    {
      "path": "root.position",                 // the only prismatic track; always root
      "unit": "m",
      "keys": [
        { "t": 0,  "v": [0, 1.02, 0.0],  "interp": "bezier", "tanOut": [0, 0, 0.04] },
        { "t": 15, "v": [0, 0.98, 0.62], "interp": "bezier", "tanIn": [0, 0, 0.03], "tanOut": [0, 0, 0.05] }
      ]
    },
    {
      "path": "root.rotation",
      "unit": "quat",
      "keys": [ { "t": 0, "v": [0, 0.7071, 0.7071, 0], "interp": "linear" } ]
    },
    {
      "path": "joints.spine.rotation",
      "unit": "quat",
      "keys": [
        { "t": 0,  "v": [0, 0, 0, 1], "interp": "bezier", "tanOut": [0, 0, 0.05] },
        { "t": 15, "v": [0, 0, 0.04, 0.999], "interp": "bezier", "tanIn": [0, 0, 0.05] }
      ]
    }
  ],

  "retargetHints": {
    "legLength": 0.92,          // hips->floor, meters: the number that drives leg IK on a new rig
    "armLength": 0.71,
    "height": 1.78,
    "style": "heavy"            // free label; the style-transfer stage reads it
  },

  "capture": {                  // provenance; optional but keep it whenever you can
    "source": "webcam",         // "webcam" | "manual" | "mixed" | "generated"
    "device": "FaceTime HD 1080p",
    "model": "mediapipe-pose-landmarker@0.10 / lite",
    "sourceFps": 29.97,
    "markerFps": 30,
    "visibilityThreshold": 0.5,
    "droppedFrames": [41, 42, 43],
    "landmarks": "assets/nervous_walk_v3.lm33.json"   // sidecar file, not inline
  }
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
- **Landmarks stay out of the clip.** 33 MediaPipe landmarks × N frames is the noisy, redundant
  data; it goes in a sidecar so re-running the capture→clip solver never needs the video again.

### The role enum (v1: 23 joints, no fingers, no face)

```
hips, spine, chest, upperChest, neck, head,
shoulder.L/R  ->  leftShoulder / rightShoulder
elbow.L/R     ->  leftElbow / rightElbow
wrist.L/R     ->  leftWrist / rightWrist
hand.L/R      ->  leftHand / rightHand
thigh.L/R     ->  leftHip / rightHip
knee.L/R      ->  leftKnee / rightKnee
ankle.L/R     ->  leftAnkle / rightAnkle
foot.L/R      ->  leftFootEnd / rightFootEnd
```

Naming inside a clip follows three.js/BVH habit (`.L`/`.R` suffixes); the `role` is unambiguous.
Optional `role: "extra"` with `side` for props (weapon grip, tail) so a rig can carry more joints
without breaking validators.

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
END Site  (BVH requires two leaf Sites: hips and the last joint)
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
is where precision goes to die, so the test asserts on the *baked arrays*, not the keyframes.

---

## Mapping to glTF / GLB

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
  two-bone IK on `hip->knee->ankle` and `shoulder->elbow->wrist` targeting where A's foot/hand *would*
  be (scaled by the length ratio), so ground contact and held props survive. `retargetHints.legLength`
  and `armLength` exist precisely to make that exact rather than estimated.
- **Swing/twist split at the hips.** Split `devB[hips]` into twist about the spine axis + swing, and
  route them differently: swing stays on the hip bone, twist goes into `root.rotation` when
  `meta.rootMotion == "world-space"`, and is discarded when `"in-place"` — otherwise the character
  spins on the spot instead of stepping forward.
- **DoF loss.** A clip joint is a free quaternion; a UE/Mixamo joint is usually 1-3 Euler channels.
  Project onto the target's allowed axes (`clampToDoF`) *before* export, or the engine snaps silently
  every frame and the result jitters in a way that is miserable to debug.

Order of operations that matters: **retarget after smoothing, before foot-lock.** Retargeting rescales
limbs, which changes velocities — and foot-lock reads velocities. Lock first and the locks drift.


## Versioning

`version` is an integer, and the loader accepts only `major == 1`. Migrations are pure functions
`v1 -> v1 -> v2` living in `src/format/migrations/`, each with a fixture. Because clips are
human-readable JSON, a broken loader is inspectable — which is the whole reason we are not using
GLB as the authoring format.
