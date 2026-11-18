# RigPilot vs. the earlier plan — and what the spec gets wrong

`docs/VISION.md` is the direction. This file records (a) what it supersedes, so nothing we already
worked out gets silently lost, and (b) the errors found while building against it, per VISION rule 6
("if something is ambiguous or physically wrong, say so and propose a fix").

Everything in §2 below was verified by running code, not by reading: `python3 tools/gen-rig.py &&
python3 tools/check-rig.py` (17 checks, including all ten of VISION §6's semantic tests).

---

## 1. What VISION replaces, and what survives

| Earlier plan (`motionlab.anim`)                                      | RigPilot                                                        | Verdict                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta.fps`, `frames`, `loop`, `revision`                             | `Clip.fps`, `frameCount`, `loop`, `revision`                    | same, renamed                                                                                                                                                                                                                                               |
| `tracks["joints.spine.rotation"]` = **quaternion** keyframes         | `jointKeys.spine` = **semantic degrees** `{flex,side,twist}`    | **superseded** — and better: quaternions are the right _internal_ form but the wrong _authored_ form. Keys store semantic values, sampling composes quats, nothing else changes                                                                             |
| `root.position` / `root.rotation` tracks                             | `rootKeys {position, heading, tilt{flex,side}}`                 | same, but `heading`+`tilt` is nicer than a free quat for the root: it makes "walk forward while leaning" addressable, which is what `generate_gait` needs                                                                                                   |
| `skeleton` embedded per clip + `skeletonRef`                         | single rig per project, `id: "humanoid-21"`                     | keep `skeletonRef`-style indirection in the project file so a second rig (V: "other rigs can be added later") is a field, not a migration                                                                                                                   |
| foot contacts **derived** from capture                               | `contacts[]` **authored** by the AI, validated afterwards       | both, and they compose: derived-on-import, authored-by-hand. This was the single best idea in VISION — the app checking a _declared_ intent is a far stronger contract than the app guessing                                                                |
| `role` on every joint                                                | not in VISION                                                   | **kept**, free, and it is what `get_rig` should return for a future retarget/mocap step. Names are for humans; `role` is for matching (VISION's own `hip_L` joint vs `thigh_L` bone is exactly the ambiguity roles remove)                                  |
| `motionlab.anim` file                                                | `*.rigpilot.json`                                               | superseded                                                                                                                                                                                                                                                  |
| BVH **import** + webcam capture + retargeting (§2.2, §3 of the plan) | VISION §14 non-goals: "no mocap import (later)"                 | **deferred, not deleted.** `packages/format`'s BVH _writer_ is still M6; `tools/`-level retargeting math stays valid and is worth keeping in `docs/DATA-FORMAT.md` as the appendix for the day BVH import or a second rig arrives                           |
| AI = smoothing / autoencoder / text→motion (Tiers A–C)               | AI = an MCP agent that sets key poses; the app enforces physics | **superseded, and it is the right call.** It removes the GPU service, the dataset, and the AMASS/HumanML3D licensing problem entirely, and it keeps every useful part (limit clamping, IK, contacts, validation) as _deterministic code_ instead of a model |

The one thing to re-read before M4: `docs/DATA-FORMAT.md` §"Conventions" and §"Mapping to BVH" — the
unit/up-axis detection and the per-joint `channelOrder` are not in VISION and M6's BVH writer needs them.

## 2. Errors found in VISION, with fixes applied or proposed

1. **§4: "Y-up, character faces +Z, right-handed (same as glTF)"** — glTF is Y-up right-handed but
   **−Z forward**. The parenthetical will mislead anyone implementing the exporter.
   _Fix applied:_ the rig records it — `conventions.notSameAsGlTF` — and export wraps the rig in one
   parent node yawed π instead of rewriting every root key, so the exported root track stays
   numerically equal to the authored one. (Cheaper to debug when a clip looks mirrored: you can diff
   the numbers against the file.)

2. **§7.2 sampling pipeline has an ordering bug that defeats its own feature.** The order is
   contacts(4) → IK(5) → foot roll(6) → **clamp to limits(7)**. Clamping _after_ the contact lock
   releases the foot off the point it just pinned — so every pose that pushes a knee or hip into its
   stop re-introduces the exact sliding that `set_contact` exists to prevent. Foot roll at step 6 has
   the same problem: it rotates the ankle after the foot was locked.
   _Proposed fix_ — one pass, limits first, contacts last:

   ```
   1 interpolate root      2 interpolate joints (semantic degrees -> quats)
   3 interpolate IK targets (body space via root ground-projection + heading)
   4 IK solve WITH limits (two-bone analytic, pole vector, project onto allowed DoFs; if the
     solution needs an illegal DoF value, take the nearest legal one, extend the chain, record `adjusted`)
   5 foot roll inside the contact solve (heel->flat->ball->toe is an ankle DoF, not a post-transform)
   6 re-lock contacts: shift the chain's root (hips) so the planted marker returns to its
     contact-start position; solve the leg once more, limited
   7 final clamp is REPORT-ONLY: if it changes anything, that is a validation issue, not a silent edit
   ```

   Step 6 is why `foot_roll` and `contacts` must be in the same function, and why "planted foot moves
   < 1 mm while the hips move" (M4's acceptance test) is the right thing to assert.

3. **§10 ground-penetration check cannot see the mesh, so the rest pose fails invisibly.** The check
   tests _contact points and end sites_; those all sit exactly at Y = 0 at rest, so it reports clean.
   But `foot_L` (radius 0.04, ankle 0.07 → toe 0.02) reaches **−0.02 m** and `toe_bone_L` (r 0.03)
   reaches **−0.03 m**: the shipped rig clips 2–3 cm through the floor in a perfect T-pose, on every
   clip, forever.
   _Proposed fix:_ measure **delta-over-rest**, not depth-below-zero — the rig now stores
   `bones[].clearanceAtRest`, and the check flags `min(clearance) < clearanceAtRest − 0.005`. The
   ankle cannot simply move up (the medial malleolus _is_ ~7 cm on a 1.80 m body) and shrinking the
   foot to 0.02 m radius makes a stick; sinking the mesh a little is what games actually do. Testing
   against rest keeps the honest signal: it fires when a _clip_ pushes the foot deeper than the
   geometry already does.

4. **§5.1's hips height has nowhere to live.** `hips` is the parentless root, so its `offset` is
   `[0,0,0]` and its world Y comes from `rootKeys.position` — meaning the authored `0.98` is not in
   the rig, and `get_rig` (§9: "joints, parents, **rest positions**, …") cannot return it, and nothing
   can rebuild the rest pose without a clip.
   _Fix applied:_ `root.restPosition` plus a per-node `restPosition` and a flat `restPose` lookup, all
   derived by the generator from the offsets so the two representations can never drift apart.

5. **§9 lists 16 tools under "keep it at 15 or fewer."** Fine through M6 (15); M7's `generate_gait`
   makes it 16. _Proposed fix:_ fold `undo`/`redo` into `edit_history { action: "undo" | "redo" |
"depth" }` → 15 including `generate_gait`, and it gives the AI a way to ask "how deep is the
   history" for free, which is useful when it is 40 calls into a clip and wants to rewind to a
   checkpoint.

6. **§5.2 head sphere: r 0.11 at y 1.71 → crown 1.82** on a 1.80 m rig, and `head_end` (1.80) lands
   2 cm _inside_ the sphere. _Fix applied:_ r 0.10 at y 1.70 → crown exactly 1.80, plus
   `ellipsoidScale [0.80, 1.0, 1.06]` because a skull is ~4 cm narrower than it is deep
   (half-extents 0.08 wide / 0.106 front-back). `head_end` then sits on the sphere surface, where an
   end site belongs.

7. **§5's "21 joints, 22 bones" counts drawn cylinders, not hierarchy edges.** 26 nodes (21 joints +
   5 end sites) is 25 edges; 22 cylinders because `chest→clavicle_L/R` and `head→head_end` are
   deliberately boneless. VISION is self-consistent — it just doesn't say so, and the difference is
   load-bearing twice over: BVH needs `Site` blocks under every terminal joint, and glTF needs a node
   per joint for `inverseBindMatrices`. _Fix applied:_ `stats` records nodes/edges/bones/end-sites and
   why 3 are boneless; the `torso` box is sized to cover the hidden clavicle stubs so the girdle
   doesn't float.

8. **§6's axis semantics are right but the tool description must not be lazy** — this one bites the
   AI, not us. Because the rig is authored in an identity-frame T-pose, `shoulder.flex` is a
   _transverse_ swing (arm sweeping forward across the chest plane) and `shoulder.side` is _raise_
   (`−90` hangs the arm at the side). An agent that reads "flex the shoulder to raise the arm" — which
   is what "flexion" means in every anatomy text — will sweep the arm horizontally into the torso and
   then chase a self-intersection warning. _Fix applied:_ every DoF carries a `positiveMeans` string
   written for the agent, and `get_rig` returns them verbatim. Recommend the same sentences appear in
   `set_key_pose`'s description, since that's the tool the agent reads at the moment of decision.

9. **Checked and correct, no change:** the Winter mass fractions sum to exactly 100.00 %
   (57.8 centre + 21.1 per side × 2); every §5.1 bone length matches its annotation (thigh 0.44,
   shin 0.44, ankle→toe 0.149, upper arm 0.34, forearm 0.26, hand 0.19, toe 0.073); leg/height 0.528
   is inside the 0.51–0.55 anthropometric band; and the mirror rule (right-side axis = `(x, −y, −z)`,
   angle unchanged) reproduces **all ten** §6 tests exactly, including both `side −90` arms hanging
   down and `knee flex` bending backward on both sides. Verified for twist too, which is the DoF that
   usually breaks: because a twist about the bone axis moves no joint centre, position tests cannot
   catch a wrong twist sign — so it was checked by asserting mirrored _end-site_ positions, which pass.
   `span/height = 1.089` is the one authored number outside its band (fingertip span 1.96 m on a 1.80 m
   character); it is cosmetic here but it is the ratio a retargeter sanity-checks, and it is flagged in
   `proportions.warning` rather than silently kept.

## 3. Where the two docs disagree on the _future_

VISION §14 defers mocap import; the earlier plan made it M4. Both are fine, but one consequence should
be a decision, not drift: **the clip format is where captured data would land.** So keep `capture`
(source, model, per-landmark confidence, dropped frames) as an optional block in `*.rigpilot.json` even
though nothing writes it yet — writing it later means a format migration _and_ a re-capture, which is
the one cost that is not recoverable. Everything else can be deferred safely.

## 4. Decisions taken for M1 (VISION is silent; defaults adopted, 2026-11-18)

Approved as defaults — if any is wrong it is cheaper to overrule now than after M2 builds on it.

1. **An unmentioned joint in `set_key_pose` keeps its previous value.** Keys are per-joint, not
   per-frame-snapshot. Consequences: blocking a 4-pose walk means 4 calls × 3–5 joints, not 4 × 21;
   re-sending a frame merges instead of wiping (VISION §9 "merges into existing keys" only makes sense
   with this reading); and `sample_pose` reports `unauthored: joint[]` for joints with no key spanning
   that frame, so the agent can tell "rest pose" from "nobody decided yet". The alternative — absent
   means return to rest — silently destroys the other 16 joints on every single-axis tweak, which is
   exactly the mistake an agent makes while iterating.
2. **`ease: "auto"` is Catmull-Rom-derived tangents with ≥ 3 keys on that channel, linear with
   exactly 2, and never `step`.** Catmull-Rom needs neighbours on both sides; at a clip end it falls
   back to linear rather than reflecting (reflection invents motion the animator didn't key). For a
   `loop: true` clip the wrap provides neighbours on both sides of frame 0, so `auto` is C-R there too
   — which is what makes §7.3's "velocity continuous across the loop point" achievable without the
   agent hand-tuning tangents.
3. **`render_preview` is capped at 8 frames per call, stated in the tool description.** 3 views × 512²
   PNG per frame, base64 through stdio: at 120 frames that is 360 images and an agent hitting the 30 s
   timeout for what it thought was one call. Batching is the agent's job only if the limit is in the
   description it reads; the error for an oversized request must name the cap and the fix
   ("frames: 8 max per call — sample every Nth frame or split the call").

Also locked from §2: the **delta-over-rest** penetration rule and the **π-yaw export wrapper** stay as
implemented; the **1.089 span/height** stays authored as VISION wrote it (flagged, not fixed), and
`foot`/`toe_bone` keep their radii (2–3 cm of rest sink is intentional, matching what games do).

Implementation home for these: `core/src/anim/` (sampling + merge semantics), and their tests are
`core/test/{keys,interpolation}.test.ts` (all three landed with M2, with §5's extra decisions noted in the
same file). They are deliberately _not_ flags in the rig JSON: the rig is geometry, this is clip behaviour.

---

## 5. Decisions taken for M2 (VISION silent or under-specified; 2026-11-18)

Five things the clip model had to settle. None is a change to §6's physics; all of them are visible in
the file format or in what an agent is told, so they are written down rather than assumed.

1. **Interpolation is per-DoF scalar channels, not `slerp`/`squad`.** §7.2 step 2 says "interpolate joint
   keys (quaternion slerp/squad with ease)". Interpolating quaternions cannot be clamped to `min`/`max`
   or reported per-axis — which is the entire mechanism §9 is built on — and decomposing a squad result
   back into swing/twist to check it is not unique near 180°. So each semantic axis is its own channel and
   `localRotation` composes the quaternion from the clamped degrees, i.e. the same composition §5.3 tests.
   Consequence worth knowing: an `ease` or `step` applies to one axis and not to its siblings, which is
   what an animator means by "ease this bend".
2. **`auto` tangents are Fritsch–Carlson monotone, not textbook Catmull-Rom.** The classical slope
   `(v[i+1]-v[i-1])/(f[i+1]-f[i-1])` is C1 but not monotone: on a shoulder keyed `0, 100, 100, 0` it
   bulges to ~123, so the limb snaps 23° past a pose it was keyed on and comes back — the most common
   "loose CG" artefact, and fatal to §13's physical-correctness claim. `auto` is now the harmonic mean of
   the two one-sided secant slopes, and 0 at an extremum. It reproduces a linear ramp exactly (so `auto`
   with evenly-paced keys is still linear between them) and never leaves the keyed range. This is the part
   of §4.2's ratified `auto` that needed a decision the spec did not make.
3. **Loop wrap is done by padding one lap of real keys, never by reflecting.** `padLooped` prepends
   `last - frameCount` and appends `first + frameCount` to the channel before sampling, so the seam is an
   ordinary segment with real neighbours (which is also what makes frame 0 Catmull-Rom under `auto`). For
   heading the pad value is `first + round((last-first)/360)*360` — frame 0's value expressed in the last
   key's winding — so a turn that closes a full circle keeps turning instead of unwinding across the seam.
   Non-looping clips hold the end keys outside the range, per every DCC.
4. **The project file carries the studio's view, including the un-keyed scratch pose.** §7.6 only says
   "project file"; M2's done-when is "reload the page and it's still there", which is false if a pose
   dragged out on an un-keyed joint vanishes on refresh. So `view: { frame, selected, camera?, freePose? }`
   is part of the format, and `freePose` is validated through the same limit clamps a key goes through.
   Keys are never invented from it: a channel with no keys stays out of `jointKeys`, so `unauthored`
   keeps meaning "nobody decided yet" (§4.1) rather than "decided: rest".
5. **Undo and redo bump `revision`; they do not rewind it.** §7.5 says each mutation increments revision
   but not what undo does to it. Rewinding would let anything watching `revision` (the autosave stamp, and
   in M3 the relay's staleness check) see a number smaller than one it already handled and conclude it was
   current with a state it had never seen. So `ClipHistory` owns the counter, snapshots store `revision: 0`,
   and the live clip's revision is derived on read.

Two smaller conventions, both recorded here because they are observable through MCP:

- **A key's `ease` describes the segment leaving it**, and `setKeyPose` replaces it wholesale on a rewrite
  of the same frame (there is no "leave the old ease alone" sentinel in §9).
- **Values are clamped at the door, not at sample time.** `set_key_pose` refuses to store an illegal
  degree and reports the clamp as an `adjusted[]` entry; sampling then uses the solver band, so the only
  way to reach it is a hand-edited file — which is exactly when a report is worth having. §7.2's step-7
  "final clamp is report-only" is preserved for M4's IK path, where the clamp is not a no-op.

Files: `core/src/anim/{types,keys,interpolation,clip,edit,history,project}.ts`,
`core/test/{keys,interpolation,clip,project,history}.test.ts`, `web/src/{store,timeline,storage}.ts`,
`web/src/panels/clipPanel.ts`, `web/test/store.test.ts`.
