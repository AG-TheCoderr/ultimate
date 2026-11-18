# Plan: Motion Lab

Browser tool: **make human motion → clean/retarget it → export animation a game can use.**

Inputs: manual joint posing with keyframes **and** webcam capture. Interchange: `motionlab.anim`
JSON + BVH, with glTF/GLB as the delivery format. Assisted by a processing layer that starts
procedural and can grow into real models.

This document is a proposal, not a decision record. Everything marked **[veto me]** is a choice I
made so you have something concrete to react to — say the word and it changes before any code exists.

---

## 1. Stack

| Layer | Pick | Why |
| --- | --- | --- |
| Build | **Vite + TypeScript (strict)** | instant HMR, ships a worker + wasm config that actually works |
| UI | **React 19** **[veto me]** | the editor is a panel-dense app (dopesheet, inspector, library); React's ecosystem wins over three.js-purism here. Svelte would also be fine |
| 3D | **three.js** | the only library where `SkinnedMesh` + `AnimationClip` + `GLTFExporter` are all first-party, so rig preview and GLB export share one scene graph |
| Capture | **`@mediapipe/tasks-vision` `PoseLandmarker`** | runs in-browser, no install, 33 landmarks + `worldLandmarks` (meters, hips-relative) + per-landmark visibility; `LIVE_STREAM` for the camera, `VIDEO` mode to re-run on a recorded file — which is also how CI tests it |
| State | **zustand** + a plain-`class Clip` in a worker | React for panels; clip data must live *outside* React because bake/smooth loops touch 10⁴–10⁵ floats per frame |
| Validation | **zod** | one schema generates the TS types *and* the runtime validator for `.anim` files; a bad drop-in file must produce an error that names the field |
| Storage | **OPFS** (`navigator.storage.getDirectory()`) + File System Access API | a real clip library on disk, no server, no IndexedDB blob gymnastics; "Export to .bvh" is a one-liner with `showSaveFilePicker` |
| Tests | **vitest** (unit + property) · **playwright** (e2e on a recorded video, never a live camera) | |
| Formats CI | optional headless **Blender** (`blender -b -P script.py`) | Blender imports BVH natively and exports FBX — it is a free, scriptable oracle that says whether our BVH is *really* valid |
| Backend | **none until M7** | the whole first pipeline is client-side; a GPU service is a separate deployable and should stay that way |

No `package.json` monorepo tooling beyond **pnpm workspaces**, because the format code has to run
in Node *and* the browser with zero DOM dependencies — that constraint is what forces the split.

```
/                       pnpm workspace
  apps/lab              React app: viewport, dopesheet, capture, library
  packages/format       motionlab.anim schema, bake/rebake, BVH in/out, glTF in/out  (no DOM!)
  packages/processors   smooth, foot-lock, root-extract, retime, loop, retarget, (AI clients)
  packages/capture      mediapipe adapter + landmark→skeleton IK solver            (no React!)
  packages/unity        C# editor scripts (BVH -> AnimationClip, retarget profile)
  fixtures/             .bvh / .anim / recorded-mp4 corpus + golden files
```

The rule that keeps this honest: `packages/format` and `packages/capture` must not import `three`,
React, or `document`. The three.js↔format glue is one adapter in `apps/lab/src/three/clipMixer.ts`.
If that rule breaks, the format becomes browser-only and Blender/Unity/CI tooling dies with it.

---

## 2. Architecture

One data flow, three input paths, one clip type:

```
 ┌─ capture ─────────────┐   ┌─ manual ─────────┐   ┌─ file ────────┐
 │ webcam / video         │   │ drag joint, IK   │   │ .bvh / .anim  │
 │ 33 landmarks + vis     │   │ dopesheet keys   │   │ drop / import │
 │        │               │   │        │         │   │      │        │
 │        ▼               │   │        │         │   │      ▼        │
 │ landmarks → Clip       │   │        │         │   │  importer     │
 │ (IK solve, §2.2)       │   │        │         │   │              │
 └───────────┬────────────┘   └────────┼─────────┘   └──────┬───────┘
             └──────────────┬───────────┴────────────────────┘
                            ▼
              Clip  (sparse keys, CRP skeleton)          ← the only editable truth
                            │  bake()
                            ▼
              DenseClip (Float32Array frames×joints×4)    ← the only computable form
                            │  processors[]
                            ▼
              ClipPatch (diff applied back to Clip)
                            │  rebake()
                            ▼
              exporters: .anim │ .bvh │ .glb ──► Blender ──► .fbx
                            │
                            ▼
              preview: three.js SkinnedMesh (or stick figure) + AnimationClip
```

**Why `Clip` (sparse) and `DenseClip` (baked) are different types.** Keyframe editing and numeric
signal processing want opposite representations; forcing one to serve both is how editors end up
either slow or lossy. Bake is `O(frames·joints)` — 600 frames × 23 joints ≈ 14k quats, microseconds
in a worker — so "just rebake after every edit" is affordable and removes an entire class of
cache-invalidation bugs.

### 2.1 Manual posing

- Viewport: pick a joint (raycast against a capsule proxy), drag → arcball rotation of that joint
  about the *camera* plane, converted to a local quaternion in parent space. Straight two-bone IK
  on shift-drag of an end-effector (wrist/ankle) so posing hands and feet is not miserable.
- Constrained to CRP axes when a joint's `limits` are set (`{min,max}` per axis, optional) — this is
  what keeps a human from being posed inside-out, and it's also what makes the export engine-safe.
- Dopesheet: rows = joints (grouped by chain), columns = frames, key diamonds, drag to move,
  right-click for interpolation. Selecting all keys of a joint + "N" = new key at playhead.
- **This is the part you described** ("move joints, set keyframes, position"), so it is the first
  thing that gets built, and it is fully usable before any ML exists.

### 2.2 Capture → Clip (the hard algorithm, stated plainly)

Do **not** map landmark→joint 1:1. Single-camera landmark Z is not trustworthy (it's a relative
depth with ~±15 cm error), so naive mapping yields a character that telescopes and pops. The
standard robust approach — and what `packages/capture` implements — is **fitting a constrained
skeleton to 2D evidence**:

```
for each frame:
  1. estimate scale: pixels-per-meter from shoulder width (a bone length we know in meters)
  2. init global rotations from the 2D bone directions (atan2 per bone) — the "good" guess
  3. iterate 4–8 times: for each chain, rotate parent so the chain's end effector lands on the
     observed landmark, weighted by visibility; hard-project to joint limits
  4. temporal: One Euro / Tikhonov smooth across frames, anchored on hips
  5. subtract the estimated root sway → either bake to root.position track or drop to in-place
  6. write dense track; a keyframe only where the derivative changes sign (or every frame at 30fps
     if the clip will be re-smoothed later)
```

Bones are length-fixed, so the character cannot stretch, cannot break its own arms, and survives an
occluded wrist (visibility weight → 0 means "ignore that evidence this frame", the chain keeps its
last good pose). That is a real, defensible technical core for the lab, and it is the difference
between "toy demo" and "usable capture".

Legs are often half out of frame → capture profiles: `full` / `upper` (legs inferred from hip sway
+ a gait prior) / `seated`. Ship `full` first, and let the manual editor fix the rest — that's the
loop the whole tool is built around.

### 2.3 Processors — where "AI" goes

```ts
type Processor = {
  id: string; label: string;
  kind: "local" | "remote";
  run(input: DenseClip, opts: unknown): Promise<ProcessorResult>;  // diff, not a new clip
  schema: ZodType<Opts>;               // so the UI auto-generates the controls
};
```

Same interface whether it's 20 lines of filtering in a worker or a diffusion model on a GPU box.
`schema` makes every processor instantly tunable in the UI, which is what makes it a *lab*: sliders,
A/B against the original, and the ability to re-run the chain with different parameters on a clip you
captured last week.

## 3. The "AI" part — what it should mean here

Your answer to that question was *"move joints, set keyframes, position etc."* — which is the manual
editor, not the AI, so the AI's job is still genuinely open. That's fine, but it's the one thing I
won't guess, because it decides whether we need a GPU, a dataset, and a month. Ranked by value per
unit of risk:

**Tier A — no model at all, ships inside M5.** Call it "assisted", not AI, and get the value now:
One Euro + Tikhonov denoise · visibility-weighted gap fill over dropped frames · **foot-contact lock**
(detect heel-strike from the ankle's velocity minimum, then IK-lock the foot so it stops sliding —
the #1 mocap artifact, and it makes output look dramatically better for ~150 lines) · root
motion ↔ in-place conversion · loop crossfade · 2× in-between at slerp+ease for slow-mo · retime
with pitch-preserving resampling · naive delta-retarget onto a named rig.

**Tier B — a small model in the browser, no server.** ONNX Runtime Web (WASM+SIMD, or WebGL) with a
**motion autoencoder** (GRU, ~1–3 M params): encode a noisy clip, decode → the output is snapped onto
the manifold of real human motion. That is genuinely "AI cleaning" and it beats hand-tuned filters on
occluded frames. A GRU inpainting model (mask some frames, predict them) is the same weights. Also
here: a per-style fine-tune for *style transfer* (walk → tired/zombie/sneaky) if we have styled data
(the "100 Styles" set is exactly this — see licensing, §5).

**Tier C — text→motion on a GPU service.** MLD / GMDM / MDM class models: "a nervous walk, carrying
something heavy" → clip. Highest wow, highest cost: a Python FastAPI service, a checkpoint, warm-up
latency, and a licensing problem (see below). Treat as its own project with an API boundary; the
`Processor.kind:"remote"` slot means it can be bolted on in a day once a service exists.

**My recommendation:** build Tier A as the pipeline's spine (it's required either way — no
generated motion should ship without smoothing + retarget + foot-lock), design the processor
interface for Tier B, and treat Tier C as a demo you add once the format is frozen. If you want the
text→motion demo *first*, that reorders everything (backend before editor) and I'd plan it that way
instead — but say so before M0.

## 4. Milestones

Effort = focused days for one developer using AI codegen assist. Order is chosen so each milestone
leaves a *usable* thing, and so the format is frozen before the two expensive parts (capture, export).

| | Build | Acceptance — the demo that proves it | Days |
| --- | --- | --- | --- |
| **M0** | pnpm workspace, Vite app, zod schema + `Clip`/`DenseClip`/bake, three.js empty scene with a stick figure in CRP, CI runs vitest | `pnpm dev` shows a 23-joint figure in T-pose; `Clip.parse(fixture)` round-trips; CI green | 0.5–1 |
| **M1** | Joint picking + drag-rotate, two-bone IK on end-effectors, joint limits, pose-only (no time) | Pose a human that looks anatomically legal; limits visibly block impossible bends | 2–3 |
| **M2** | Timeline: play/pause/scrub, keyframe create/move/delete, linear/step/bezier, dopesheet, OPFS save/load | Animate a wave cycle by hand, 30 fps smooth, no dropped frames while dragging keys | 2–3 |
| **M3** | Format I/O: `.anim` + full BVH import/export + unit & up-axis normalisation | BVH→clip→BVH round-trip is within 1e-4 on baked arrays; **a public BVH from the internet plays correctly in our viewport** — that one test kills most format bugs | 2–3 |
| **M4** | Webcam + video capture: MediaPipe, the §2.2 solver, capture profiles, landmarks sidecar, live preview while recording | Record a 10 s walk → editable clip → it reads as a walk without manual fixes; scrubbing shows per-landmark confidence | 3–4 |
| **M5** | Processor chain UI (Tier A all of it) + `Processor` interface with auto-generated controls + A/B compare | Foot-lock visibly kills sliding on a captured clip; A/B with the original side-by-side on the same canvas | 3–4 |
| **M6** | Delivery: GLB export onto a **skinned preview character**, `roles` in `extras`, Blender BVH→FBX script, Unity C# importer | A GLB opens in [gltf.report](https://gltf.report) with named animations; the FBX lands in Unity with working `Animator` clips on a real rigged character | 2–3 |
| **M7** | *(optional)* Tier B model in-browser, and/or a Tier C remote service behind the same interface | Same UI, one dropdown change: the noise filter becomes a learned one, and the demo still passes | 5–10 |

**~15–20 days to a genuinely usable lab (M0–M6).** If you want the pitch deck in one week instead:
M0 → M4 → M5, skipping M2's dopesheet polish (pose-edit can be minimal and still fix captures), then
come back for M1/M3 rigour. I'd argue against skipping M3 — every later bug you can't explain is a
convention bug, and conventions are what M3 forces you to write down.

## 5. Risks, honestly

1. **The AI's job is undefined** (§3). The only risk big enough to change the architecture. Resolve
   before M0, since it decides whether a backend exists at all.
2. **Single-camera capture is mediocre, and pretending otherwise kills the project.** Depth is
   ambiguous, occlusion is constant, there are no hands or face. The plan's answer is the IK-fit in
   §2.2 plus a manual editor for the residue — the *tool* is the moat, not the model.
3. **Licensing of motion data.** AMASS and HumanML3D (what every text→motion paper trains on) are
   **research-only, non-commercial**; CMU/ACAID have no formal licence and are commonly treated as
   research data; "100 Styles" is distributed as CC0. If this becomes a product, re-check each
   dataset's terms before training, and prefer motion we generate ourselves in the lab (our own
   captures become the training set — a real advantage of owning the capture tool).
4. **Export realism arrives too late.** A "GLB" that Unity mangles is a week of debugging. That's why
   M6 includes a real engine smoke test in the same milestone as the exporter, not a later one.
5. **Format churn.** Everything is a function of `motionlab.anim`; changing it after M4 invalidates
   every fixture and capture. Freeze at the end of M3, then migrate-only.
6. **Perf.** MediaPipe WASM at 30 fps with a live 1080p stream is fine on an M-series laptop and
   marginal on a mid-range Windows laptop. Mitigations: `lite` model, 720p input, worker-thread
   inference, and a visible fps/dropped-frame readout so the failure is honest. Safari: WASM SIMD
   needs iOS 16.4+ / macOS Safari 16.4+; test on the phone you actually own, and expect to fall back
   to video-file import on older ones.
7. **Scope creep into "Blender in a browser."** The tie-breaker question for any feature: *does it
   move motion from a human into an engine clip more reliably?* If not, it's a DCC feature and it
   waits.

## 6. Open questions (I need these to write M0)

1. **What is the AI for** — §3 Tier A / B / C, or something specific like "retarget only" or
   "text→motion demo first"?
2. **Do you have a rigged target character?** An FBX/GLB with skinning we can retarget onto and
   preview in M6. Without one we can only validate against our own stick figure, which hides real
   engine bugs.
3. **Which engine do we test against** — Unity, Unreal, Godot, or "web/GLB only for now"?
4. **Fingers and face?** Changes the capture model (Pose + Hands + Face blendshapes, ~3× cost) and
   makes the skeleton 23 → 60+ joints. If the goal is *game locomotion*, the answer is no, and it
   stays out of the format's way.
5. **Local-only, or hosted/multi-user?** OPFS keeps it serverless; hosted means a clip store, auth,
   and shareable URLs — a decision with real cost, best made now.
6. **Is Blender available in your workflow?** If yes, the FBX path is a script, not a project. If no,
   Unity-side BVH import becomes our main road and `packages/unity` gets bigger.

## 7. First session, concretely

If you approve: **M0** — pnpm workspace, strict TS, `packages/format` with the zod schema for
`motionlab.anim`, `bake`/`rebake`, and vitest property tests over a random-clip generator; plus
`apps/lab` showing the CRP stick figure so there's a window to look at. Then M1's joint-drag on top.
No capture, no export, no AI — just the format and the figure, because both are load-bearing for
everything after.
