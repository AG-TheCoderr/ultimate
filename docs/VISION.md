# RigPilot — Build Prompt for the AI Coding Agent

> Copy this whole file into your AI coding agent (Claude Code, Codex, Antigravity, Copilot, etc.).
> Recommended: also commit it to the repo as `docs/VISION.md` so the agent can re-read it any time.

---

## 0. Your role and how to work

You are the lead engineer building **RigPilot**: a browser-based 3D character animation studio that
**AI agents can control through MCP** to create realistic, game-ready animations.

Working rules:
1. Build **milestone by milestone** (Section 12). Finish, test, and commit one milestone before starting the next. One PR (or clearly separated commits) per milestone.
2. Before writing code for a milestone, briefly restate the plan and list files you will create/change.
3. **Never skip tests** for `core/`. Correctness of motion is the whole point of this product.
4. **No backend, no database, no cloud services.** The web app is a static site on GitHub Pages. The only non-static piece is a small local relay program (Section 8).
5. Keep dependencies minimal. Do not add frameworks or libraries beyond Section 3 without explaining why.
6. If something in this spec is ambiguous or physically wrong, **say so and propose a fix** instead of guessing silently.
7. Keep `README.md` updated with setup, run, deploy, and MCP connection instructions.

---

## 1. Vision (read carefully)

A simple humanoid body made of **cylinders (bones)** and **spheres (joints)** stands in a 3D scene.
An AI agent (Claude Code / Codex / Antigravity) connects via MCP and **animates it**: walk cycles,
runs, jumps, idles, waves, attacks. The user watches the body move **live** in the browser.
The result exports as **GLB** for Unity, Godot, Unreal, Blender, and Three.js.

### The core design principle

> **The app guarantees physical correctness. The AI only decides intent: which pose, when, and with what style.**

AI models are bad at raw 3D rotation math, so the app must do the heavy lifting:
- Joint limits make impossible poses **impossible** (knees and elbows are hinges, never bend backwards).
- Inverse kinematics (IK): the AI says *"put the left foot here"*, the app computes hip/knee/ankle angles.
- Foot contacts: the AI says *"left foot planted from frame 0 to 12"*, the app locks it (no sliding).
- Interpolation: the AI sets **key poses only**; the app generates all in-between frames.
- Validation: the app detects problems (foot sliding, ground penetration, balance, loop breaks, pops) and returns **precise, actionable** reports.
- Previews: the app renders orthographic images (front/side/top) so the AI can **see** its work.

When the AI asks for something impossible, the app **does not fail**. It clamps to the nearest valid
value and **reports what it adjusted and why**, so the AI can learn and correct.

The loop that produces quality: **AI sets poses → app enforces rules → app validates + previews → AI fixes → repeat.**

### Also important
- The studio must be fully usable **by a human without AI** (manual posing, timeline, export).
- Everything the AI does is visible in an **AI activity log** in the UI.

---

## 2. Architecture

```text
┌──────────────── Static web app (GitHub Pages) ────────────────┐
│  web/  — Three.js viewer, timeline, posing UI, activity log    │
│  core/ — pure TS: rig, FK, IK, limits, interpolation,          │
│          contacts, validation, COM, export builders            │
│  Tool executor: runs tool calls against core + updates viewer  │
└──────────────▲─────────────────────────────────────────────────┘
               │ WebSocket  ws://127.0.0.1:8765  (token + origin check)
┌──────────────┴──────────── Local relay (Node, on user's PC) ───┐
│  relay/ — MCP server over stdio + WebSocket server             │
│  Forwards MCP tool calls to the open page, returns results.    │
│  Can write exported files to disk.                             │
└──────────────▲─────────────────────────────────────────────────┘
               │ MCP (stdio)
     Claude Code / Codex / Antigravity
```

Key decisions:
- **All motion logic lives in `core/`** (pure TypeScript, no DOM, no Three.js dependency) so it is testable and deterministic.
- **The page is the source of truth** for the project state. The relay is a thin forwarder.
- **Tool definitions (names, descriptions, input schemas) live in one shared module** (`core/tools/`), used by both the relay (to advertise tools at MCP init) and the page (to execute them). Single source of truth.
- Bonus (Milestone 7): the page also registers the same tools via **WebMCP** (`document.modelContext.registerTool`) when the browser supports it (feature-detect, never required).

---

## 3. Tech stack

- **Language:** TypeScript everywhere (strict mode).
- **Repo:** npm workspaces monorepo: `core/`, `web/`, `relay/`.
- **Web:** Vite + Three.js. UI in vanilla TS or Preact (keep it light). `OrbitControls`, `TransformControls`, `GLTFExporter` from Three.js examples.
- **Relay:** Node 20+, `@modelcontextprotocol/sdk`, `ws`, `zod`.
- **Validation of inputs:** `zod` schemas, converted to JSON Schema for MCP.
- **Tests:** `vitest` for `core/` (required), optional Playwright smoke test for `web/`.
- **Lint/format:** ESLint + Prettier.
- **Deploy:** GitHub Actions → GitHub Pages. Set Vite `base` to `/<repo-name>/`.

Suggested structure:
```text
/core
  /src/rig        rig types, default humanoid rig, rest pose
  /src/math       vectors, quaternions, euler (semantic axes), swing-twist
  /src/kinematics FK, two-bone IK, foot roll, limits/clamping
  /src/anim       clip model, keyframes, interpolation, sampling, contacts, root motion, mirroring
  /src/validate   checks + report formatting
  /src/physics    center of mass, support polygon
  /src/export     GLB scene builder helpers, BVH writer
  /src/tools      tool definitions (zod schemas + descriptions) + executor
  /test
/web
  /src  viewer, timeline, panels, relay client, preview renderer, webmcp
/relay
  /src  mcp server, ws bridge, file writer
/docs  VISION.md (this file), TOOLS.md (generated tool reference)
```

---

## 4. Coordinate system and units (strict)

- Units: **meters**. Time: **frames** at clip `fps` (default 30).
- **Y-up, character faces +Z**, right-handed (same as glTF).
- **Character's LEFT side = +X**, RIGHT side = −X.
- Floor is the plane **Y = 0**.
- Internally store rotations as **quaternions**.
- The AI-facing API uses **degrees on semantic axes**: `flex`, `side`, `twist` (Section 6). Never expose raw quaternions to the AI.

---

## 5. The body: 21 joints, 22 bones, 1 head sphere

Rest pose is a **T-pose** (arms straight out to the sides, palms down, legs straight, feet flat).
Character height ≈ 1.80 m. All positions are **world space in rest pose**. Every joint's rest local
frame is axis-aligned with the world (identity rest rotation) to keep math simple.

### 5.1 Joints (spheres)

| Joint | Parent | Rest position (x, y, z) | Notes |
|---|---|---|---|
| hips | — (root) | (0, 0.98, 0) | Root: free translation + rotation |
| spine | hips | (0, 1.10, 0) | |
| chest | spine | (0, 1.30, 0) | |
| neck | chest | (0, 1.50, 0) | |
| head | neck | (0, 1.62, 0) | Skull base |
| clavicle_L | chest | (+0.03, 1.45, 0) | |
| shoulder_L | clavicle_L | (+0.19, 1.47, 0) | |
| elbow_L | shoulder_L | (+0.53, 1.47, 0) | upper arm 0.34 |
| wrist_L | elbow_L | (+0.79, 1.47, 0) | forearm 0.26 |
| clavicle_R | chest | (−0.03, 1.45, 0) | |
| shoulder_R | clavicle_R | (−0.19, 1.47, 0) | |
| elbow_R | shoulder_R | (−0.53, 1.47, 0) | |
| wrist_R | elbow_R | (−0.79, 1.47, 0) | |
| hip_L | hips | (+0.09, 0.95, 0) | |
| knee_L | hip_L | (+0.09, 0.51, 0) | thigh 0.44 |
| ankle_L | knee_L | (+0.09, 0.07, 0) | shin 0.44 |
| toe_L | ankle_L | (+0.09, 0.02, 0.14) | ball of foot |
| hip_R | hips | (−0.09, 0.95, 0) | |
| knee_R | hip_R | (−0.09, 0.51, 0) | |
| ankle_R | knee_R | (−0.09, 0.07, 0) | |
| toe_R | ankle_R | (−0.09, 0.02, 0.14) | |

**End sites** (not joints, used for bone ends / effectors):
`head_end` (0, 1.80, 0.02), `hand_end_L` (+0.98, 1.47, 0), `hand_end_R` (−0.98, 1.47, 0),
`toe_end_L` (+0.09, 0.0, 0.21), `toe_end_R` (−0.09, 0.0, 0.21).

**Foot contact points** (invisible, per foot, children of ankle/toe): `heel` (x, 0, −0.05), `ball` (x, 0, 0.14), `toe_tip` (x, 0, 0.21).

### 5.2 Bones (cylinders), 22 total

Each cylinder starts at its parent joint center and ends at the child joint (or end site). Its pivot is the parent joint center.

| Bone | From → To | Radius |
|---|---|---|
| pelvis_L / pelvis_R | hips → hip_L / hip_R | 0.08 |
| lower_spine | hips → spine | 0.12 |
| upper_spine | spine → chest | 0.13 |
| upper_chest | chest → neck | 0.12 |
| neck_bone | neck → head | 0.05 |
| clavicle_bone_L / _R | clavicle → shoulder | 0.035 |
| upper_arm_L / _R | shoulder → elbow | 0.045 |
| forearm_L / _R | elbow → wrist | 0.035 |
| hand_L / _R | wrist → hand_end | 0.03 |
| thigh_L / _R | hip → knee | 0.07 |
| shin_L / _R | knee → ankle | 0.05 |
| foot_L / _R | ankle → toe | 0.04 |
| toe_bone_L / _R | toe → toe_end | 0.03 |

**Head:** one sphere, radius 0.11, centered at (0, 1.71, 0.02), rigidly attached to `head`.
**Joint spheres:** radius = 1.1 × the largest radius of connected cylinders (hides gaps when bending).
**Colors:** left side blue-ish, right side red-ish, center neutral (helps humans and AI read previews).

The rig must be data-driven: ship it as `core/src/rig/humanoid.rig.json` and load it, so other rigs can be added later.

---

## 6. Semantic axes and joint limits

The AI never deals with raw X/Y/Z rotations. Each joint exposes semantic axes in degrees:
- `flex`: anatomical flexion (+) / extension (−)
- `side`: abduction / raise (+) and adduction / lower (−), or lateral bend for the spine/neck (+ = toward character's left)
- `twist`: rotation around the bone's own axis (+ = toward character's left / outward; document it)

`rig.json` maps each semantic axis to a local axis + sign, plus min/max limits. Limits are **relative to the T-pose rest**. Values are approximate; tune visually but keep them anatomically plausible.

| Joint | Type | flex | side | twist |
|---|---|---|---|---|
| hips (root) | free 6-DOF | free | free | free (heading) |
| spine | 3-axis | −15…30 | ±15 | ±20 |
| chest | 3-axis | −15…30 | ±15 | ±20 |
| neck | 3-axis | −35…40 | ±30 | ±40 |
| head | 3-axis | −35…40 | ±30 | ±40 |
| clavicle | 2-axis | ±20 (forward/back) | −10…35 (raise) | — |
| shoulder | ball | −60…130 (swing forward) | −100…80 (raise; −90 ≈ arm down) | ±90 |
| **elbow** | **hinge** | **0…150** | — | — |
| wrist | 2-axis + twist | −70…80 | −20…30 | ±80 (forearm pronation lives here) |
| hip | ball | −20…120 | −30…45 | ±40 |
| **knee** | **hinge** | **0…150** | — | — |
| ankle | 2-axis | −50…20 (+ = toes up) | ±20 | — |
| toe | hinge | −20…60 (+ = toes bend up) | — | — |

**Limit enforcement:** use swing-twist decomposition (or per-axis clamping on the semantic Euler representation, order documented) so limits are reliable. Hinges must have exactly one degree of freedom.

### Required semantic behavior tests (vitest)

These define the sign conventions. They must pass:
- `hip_L flex +90` → knee_L moves **forward (+Z)** and up to ≈ hip height.
- `knee_L flex +90` (thigh straight) → ankle_L moves **backward (−Z)**.
- `shoulder_L side −90` → elbow_L ends **below** shoulder_L (arm hanging down).
- `shoulder_R side −90` → elbow_R ends **below** shoulder_R (mirror correct).
- `shoulder_L flex +90` from T-pose → elbow_L moves **forward (+Z)**.
- `elbow_L flex +90` → wrist_L moves **forward (+Z)** relative to elbow (in T-pose).
- `spine flex +20` → neck moves **forward (+Z)**.
- `ankle_L flex +15` → toe_L moves **up (+Y)**.
- `knee_L flex −20` gets **clamped to 0** and reported in `adjusted`.
- Mirroring a pose from left to right produces exact mirrored world positions (X negated).

---

## 7. Animation model

### 7.1 Clip
```ts
Clip {
  name: string; fps: number; frameCount: number; loop: boolean;
  jointKeys: Record<JointName, Key<SemanticRotation>[]>;   // sparse key poses
  rootKeys: Key<{ position: Vec3; heading: number; tilt?: {flex:number, side:number} }>[];
  ikTargets: Record<Effector, Key<IKTarget>[]>;           // hand_L, hand_R, foot_L, foot_R
  contacts: Contact[];                                     // { effector: foot_L|foot_R, part: heel|ball|toe_tip|flat, start, end }
  revision: number;
}
Key<T> { frame: number; value: T; ease: "auto"|"linear"|"step"|"ease_in"|"ease_out"|"ease_in_out" }
```

### 7.2 Sampling pipeline (per frame, deterministic)
1. Interpolate root keys (position: cubic Hermite / Catmull-Rom; heading: shortest arc).
2. Interpolate joint keys (quaternion slerp/squad with ease, per joint).
3. Interpolate IK targets; positions given in **body space** are converted using the root's ground projection + heading.
4. Apply **contacts**: during a contact window, the planted foot part's world position is locked to its position at contact start (and foot kept flat / rolled appropriately).
5. Solve IK (analytic two-bone IK for arms and legs, with pole vectors: knees point forward, elbows point back/down by default). Respect hinge limits. If out of reach: extend fully and report.
6. Foot roll: support heel → flat → ball → toe transitions for push-off.
7. Clamp all joints to limits; record adjustments.
8. Return world transforms of all joints, end sites, and contact points.

### 7.3 Loops
If `loop: true`, the last frame must blend seamlessly into frame 0 (pose and velocity). Interpolation must wrap around.

### 7.4 Mirroring and cycle offset
`mirror_pose` copies one side to the other. `offset_mirror` (for walk/run cycles) copies left-side keys to the right side shifted by half the cycle length. This makes symmetric gaits easy.

### 7.5 Undo/redo
Every mutating tool is a command in a history stack. Each mutation increments `revision`.

### 7.6 Persistence
Autosave to IndexedDB/localStorage. Save/load a project file (`*.rigpilot.json`) via download/upload.

---

## 8. Local relay (MCP server)

- Node program in `relay/`. MCP transport: **stdio**.
- **CRITICAL: never write logs to stdout** (stdout is reserved for the MCP protocol). Log to stderr only.
- Runs a WebSocket server on `127.0.0.1:8765` (configurable via `RIGPILOT_PORT`). **Bind to 127.0.0.1 only.**
- Security:
  - Check the WebSocket `Origin` header against an allowlist (`RIGPILOT_ORIGINS`, default: `http://localhost:5173` + the GitHub Pages origin).
  - Require a pairing token (`RIGPILOT_TOKEN` env var, or a random one generated at startup). The page connects with `?relay=ws://127.0.0.1:8765&token=...` or via a Connect dialog.
  - Only one page session is active at a time. A new connection replaces the old one, and the old page is notified.
- Message protocol (JSON):
  `{ id, type: "tool_call", name, args }` → `{ id, type: "tool_result", ok, result | error }`. Also `hello`/`ping`.
- Timeout: 30 s per tool call (longer for export).
- If no page is connected, tools return a clear error: *"RigPilot studio is not open/connected. Ask the user to open <URL> and click Connect."* Provide a `get_connect_link` tool that returns the page URL including the token.
- Exports: the relay can write GLB/BVH files to an output dir (`RIGPILOT_OUT`, default `./rigpilot-exports`). Prevent path traversal.
- Populate the MCP server `instructions` field with the Animator Guide (Section 11).
- Note for README: Chrome may show a **local network access** permission prompt when the GitHub Pages site connects to localhost. The user must allow it. Safari may block it, so recommend Chrome, Edge, or Firefox.

### MCP config examples (put in README)

Claude Code:
```bash
claude mcp add --transport stdio rigpilot --env RIGPILOT_TOKEN=change-me -- node /ABS/PATH/relay/dist/index.js
```
Codex (`~/.codex/config.toml`):
```toml
[mcp_servers.rigpilot]
command = "node"
args = ["/ABS/PATH/relay/dist/index.js"]
env = { RIGPILOT_TOKEN = "change-me" }
```
Antigravity (`mcp_config.json`):
```json
{ "mcpServers": { "rigpilot": { "command": "node", "args": ["/ABS/PATH/relay/dist/index.js"], "env": { "RIGPILOT_TOKEN": "change-me" } } } }
```

---

## 9. MCP tools (keep it at 15 or fewer)

Every tool returns structured JSON with: `ok`, `revision`, relevant state, `adjusted[]` (clamps/IK corrections with reasons), and `warnings[]`. Descriptions must be clear and include animation rules (the AI reads them).

| Tool | Purpose |
|---|---|
| `get_studio_state` | Clip info (name, fps, frameCount, loop), key frames per channel, contacts, revision, connection info |
| `get_rig` | Joints, parents, rest positions, semantic axes, limits, effectors, contact points |
| `new_clip` | `{ name, fps=30, frameCount, loop }`, resets the clip |
| `set_key_pose` | `{ frame, joints: { [joint]: { flex?, side?, twist? } }, root?: { position?, heading?, tilt? }, ease? }`, merges into existing keys |
| `set_ik_target` | `{ frame, effector: hand_L|hand_R|foot_L|foot_R, position: {forward, side, up}, space: "body"|"world", pole?, ease? }` |
| `set_contact` | `{ effector: foot_L|foot_R, part: heel|ball|toe_tip|flat, start, end }`, or remove |
| `set_root_motion` | Keys for hips position/heading over time (e.g., forward travel for a non-in-place walk) |
| `mirror_pose` | `{ frame | range, from: "L"|"R", mode: "copy"|"offset_cycle" }` |
| `delete_keys` | Remove keys by frame/joint/effector |
| `sample_pose` | `{ frame }` → world positions of all joints, end sites, contact points, COM, which feet are planted |
| `validate_clip` | Runs all checks (Section 10) → issues with frame ranges, amounts, and suggested fixes |
| `render_preview` | `{ frames: number[], views: ["front","side","top"], onion_skin?: bool }` → PNG image(s) |
| `undo` / `redo` | History navigation |
| `export_animation` | `{ format: "glb"|"bvh", filename }` → page builds file, relay saves to disk, page also offers download |
| `generate_gait` (M7) | `{ type: walk|run|sneak|limp, speed, stride, bounce, arm_swing, in_place }` → creates key poses + contacts + root motion as a starting point the AI then refines |

`render_preview` details: offscreen orthographic Three.js renderer, ~512×512 per view, floor grid with 10 cm lines,
left side blue / right side red, optional joint name labels, frame number stamped on the image.
Return as MCP image content (base64 PNG) via the relay.

---

## 10. Validation checks (with thresholds)

| Check | Rule | Report |
|---|---|---|
| Joint limits | Any clamping applied during sampling | joint, frames, requested vs applied |
| Foot slide | Planted contact point moves > 1.0 cm during its contact window | foot, frames, max distance |
| Ground penetration | Any contact point/end site below Y = −0.5 cm | part, frames, depth |
| Floating plant | Foot marked planted but > 1 cm above ground | foot, frames |
| Self-intersection | Capsule-capsule overlap between non-adjacent bones (e.g., arm through torso, legs crossing) | bone pair, frames |
| Balance | When the body is near-static (COM speed < 0.2 m/s), the COM ground projection must be inside the support polygon of planted feet (+ 3 cm margin) | frames, distance outside |
| Loop continuity | If loop: pose diff and velocity diff between last frame and frame 0 below thresholds | joints/root, amount |
| Pops / jerk | Angular velocity > 720°/s or sudden accel spikes between consecutive frames | joint, frame |
| Unreachable IK | IK target out of reach | effector, frames, distance |

**Center of mass:** use segment mass fractions (Winter): head+neck 8.1%, trunk 49.7% (split over pelvis/spine/chest),
upper arm 2.8%, forearm 1.6%, hand 0.6%, thigh 10.0%, shin 4.65%, foot 1.45% (per side). COM of each segment at its cylinder midpoint (approximation is fine).

Every issue includes a short **suggested fix** string, e.g. *"Add contact for foot_L frames 4–9 or move its IK target to keep it fixed."*

---

## 11. Animator Guide (embed in MCP `instructions` and relevant tool descriptions)

> You are animating a humanoid rig. Work like a professional animator:
> 1. Call `get_rig` and `get_studio_state` first.
> 2. Block **key poses** first (e.g., walk: contact, down, passing, up), then refine. Do not key every frame.
> 3. Use `set_ik_target` + `set_contact` for hands/feet touching things or the ground. Use `set_key_pose` for spine, head, arms, and style.
> 4. Feet on the ground must have `up = 0` and an active contact. Planted feet must not slide.
> 5. Opposite arm swings forward with each leg step. Hips drop at contact/down poses and rise at passing/up poses. The head counter-balances.
> 6. Use anticipation (crouch before a jump), follow-through, and ease in/out. Heavier characters have slower, deeper motion.
> 7. For symmetric cycles, animate one side and use `mirror_pose` with `offset_cycle`.
> 8. After each blocking pass: `validate_clip`, then `render_preview` (side view for walks, front for balance). Fix every issue until validation passes.
> 9. Read `adjusted[]` in every response: it tells you when the rig corrected you.

---

## 12. Milestones and acceptance criteria

### M0 — Repo foundation
- npm workspaces (`core`, `web`, `relay`), TS strict, ESLint/Prettier, vitest.
- GitHub Actions: test on PR; deploy `web` to GitHub Pages on `main`.
- **Done when:** CI is green and the empty studio page is live on GitHub Pages.

### M1 — Rig + forward kinematics + viewer
- Load `humanoid.rig.json`, FK in `core`, semantic axes + limits + clamping.
- Three.js viewer: floor grid, orbit camera, cylinders and spheres built from the rig, left/right colors.
- Joint panel: select a joint (click or list), sliders for flex/side/twist respecting limits.
- **Done when:** all semantic behavior tests (Section 6) pass, and a human can pose the body by hand with no impossible poses.

### M2 — Timeline, keyframes, playback, persistence
- Timeline with key markers, scrub, play/pause, loop toggle, fps/frameCount settings.
- Interpolation with ease modes; loop wrap-around.
- Undo/redo; autosave; project file save/load.
- **Done when:** a human can key a 3-pose wave, play it smoothly, reload the page, and it's still there.

### M3 — Relay + MCP + live sync
- `relay/` with MCP stdio server, WS bridge, token + origin checks, `get_connect_link`.
- Page: Connect dialog/URL params, connection status badge, **AI activity log** (tool name, args summary, adjustments, time).
- Tools: `get_studio_state`, `get_rig`, `new_clip`, `set_key_pose`, `delete_keys`, `sample_pose`, `undo`, `redo`.
- Viewer updates instantly on each tool call and briefly highlights changed joints.
- **Done when:** from Claude Code (or Codex/Antigravity) the user says "raise the left arm and wave" and watches it happen live.

### M4 — IK, contacts, root motion, mirroring
- Two-bone IK with pole vectors, reach clamping, foot roll (heel/ball/toe), contact locking, body-space targets.
- Tools: `set_ik_target`, `set_contact`, `set_root_motion`, `mirror_pose`.
- **Done when:** tests prove (a) a planted foot moves < 1 mm while the hips move, (b) knees never invert, (c) unreachable targets are clamped and reported.

### M5 — Validation + previews
- All checks in Section 10, with COM and support polygon.
- `validate_clip` and `render_preview` (front/side/top, onion skin).
- UI issues panel: click an issue to jump to its frame and highlight the joint.
- **Done when:** a deliberately broken clip (sliding foot, backwards knee request, broken loop) yields correct, specific issues, and the preview images are clear.

### M6 — Export
- **GLB:** a skeleton exported as a glTF skin (one node per joint, standard names), a single mesh of all cylinders and spheres rigidly skinned (each vertex 100% weighted to its bone), and an animation baked at clip fps (rotations for all joints, translation for hips).
- **BVH:** standard hierarchy + motion for retargeting.
- Tool: `export_animation` (relay saves file; page also downloads).
- **Done when:** the GLB re-imports into Three.js and plays correctly (automated test if possible), and the README explains verifying in Blender/Godot/Unity.

### M7 — Gait generator + WebMCP
- `generate_gait` creates parameterized walk/run/sneak/limp starting points that **pass validation**.
- WebMCP: feature-detect `document.modelContext` and register the same tools from the shared registry.
- **Done when:** the AI can produce a "tired walk" in fewer than 10 tool calls that passes validation and looks natural in preview.

---

## 13. Final success test (end-to-end)

The user opens the GitHub Pages studio, clicks Connect, and in Claude Code / Codex / Antigravity types:

> "Make a looping tired walk cycle, 32 frames, in place, then export it as GLB."

The AI blocks key poses, sets contacts, mirrors the cycle, validates, previews, fixes issues, and exports.
The user watches it build live, validation reports **zero issues**, and the GLB plays correctly in a game engine.

---

## 14. Non-goals (for now)

- No backend/database/cloud, no user accounts.
- No physics engine or ragdoll (balance check only).
- No fingers, facial rig, or twist bones (rig is data-driven so they can be added later).
- No multiple characters or animation blending/layers (design data model so they can be added later).
- No mocap import (later).

---

## 15. Quality bar

- `core/` is pure, deterministic, and covered by tests (FK, limits, IK, interpolation, contacts, validation, mirroring, export round-trip).
- Viewer runs at 60 fps; validating a 120-frame clip takes < 50 ms.
- Clear error messages everywhere; no silent failures.
- Code is readable and commented where the math is non-obvious (IK, swing-twist, foot roll).
