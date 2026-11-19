# RigPilot

A browser humanoid animation studio that **AI agents drive over MCP**.

A body of 21 joints (spheres) and 22 bones (cylinders) stands on a floor grid. An agent — Claude Code,
Codex, Antigravity — sends key poses, IK targets and foot contacts; **the app enforces the physics**
(joint limits, hinges, two-bone IK, contact locks, foot roll) and then _validates its own output_
(foot slide, floor penetration, balance, loop continuity, pops) and hands back orthographic previews so
the agent can see what it did. The result exports as **GLB** and **BVH** for Unity, Godot, Unreal,
Blender and Three.js. Fully usable by a human with no AI in the loop.

> The contract that makes this work: **when the agent asks for something impossible, the app does not
> fail.** It clamps to the nearest legal value and reports what it adjusted, so the agent can learn.
> A name the rig does not have (a bone where a joint belongs, an axis a hinge does not have) is
> reported in `unknownJoints[]` / `unknownAxes[]` rather than quietly ignored.

**Status: M1 is in** — the rig loads, validates, and can be posed by hand in the browser with limits
enforced. M2 (timeline, keyframes, playback, persistence) has landed: a clip model in `core/src/anim/`,
a scrubbable timeline, undo/redo, autosave and `*.rigpilot.json` files. M3 (the relay and the MCP tools
that drive this same store) is next. Milestones:
[`docs/VISION.md`](docs/VISION.md) §12.

|       |                                                                                                                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 ✅ | workspaces, strict TS, ESLint + Prettier, vitest, CI + Pages deploy, the rig as validated data                                                                                                                                                    |
| M1 ✅ | FK on semantic axes, limit clamping with `adjusted` reports, three.js viewer, click-to-select, per-DoF sliders, rest-space primitive binding in `core/src/rig/`. All ten of §6's semantic tests now run in `core/` too (43 tests)                 |
| M2 ✅ | Clip model in `core/src/anim/` (keys, per-DoF interpolation with ease modes, monotone auto tangents, loop wrap), timeline with key markers + scrub + play/loop, undo/redo, autosave, `*.rigpilot.json` save/open. 128 tests (120 core + 8 studio) |
| M3–M7 | relay + MCP + activity log · IK, contacts, root motion, mirroring · validation + previews · GLB/BVH export · gait generator + WebMCP                                                                                                              |

```
docs/VISION.md          the spec — direction for every milestone (read this first)
docs/RECONCILIATION.md  what the spec gets wrong, with fixes applied (VISION rule 6)
docs/PLAN.md            the earlier plan: rig rationale, milestones, risks
docs/DATA-FORMAT.md     conventions, BVH/glTF mapping, retargeting math (M6 + future import)
core/src/rig/humanoid.rig.json   the rig, as data
core/src/kinematics/             fk.ts (composition order lives here), limits.ts (clamp + graze)
tools/gen-rig.py · tools/check-rig.py   generates it · 18 checks including §6's ten semantic tests
```

## Setup

```bash
npm install          # Node 20+
npm test             # core/ invariants + the studio's store tests (vitest, both workspaces)
npm run lint         # eslint (type-aware)
npm run typecheck
npm run build        # core -> dist, relay -> dist, web -> web/dist
npm run rig          # regenerate + re-verify the rig; CI asserts the committed file matches
```

## Run the studio

```bash
npm run dev          # vite on 0.0.0.0:5173
```

Press **▶ Wave demo** (or `P`) — that is the whole M2 loop in one click: three poses get keyed across the
clip, it plays, and reloading the page brings back the clip, the playhead, the selection and the un-keyed
scratch values. `Save .json` writes a `<clip name>.rigpilot.json` you can diff, commit, or hand to an
agent; `Open…` or **dragging the file onto the page** reads it back.

First visit opens a three-step guide; `?` brings it back.

| key                       | what it does                                        |
| ------------------------- | --------------------------------------------------- |
| `Space`                   | play / pause                                        |
| `←` `→`                   | one frame (`Home` / `End` jump to the ends)         |
| `Shift+←/→`               | previous / next keyed frame                         |
| `K`                       | key the pose on screen at this frame                |
| `Shift+K`, `Del`          | delete this frame's keys (selection, else all)      |
| `R`                       | random legal pose — every joint inside its limits   |
| `P`                       | the 3-pose wave demo                                |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo                                         |
| `Esc`                     | deselect (and close the help, and leave a text box) |
| `?` / `F1`                | the guide                                           |

### What a person sees, and why it is shaped that way

- **Human names in the list, rig names beside them.** The picker says "Left elbow" and the `<code>` tag in
  its header says `elbow_L`, because `elbow_L.flex` is what an MCP call sends and what the project file
  stores. The translation lives in `web/src/labels.ts` — one table, derived from the rig's own
  `role`/`name`, and `web/test/labels.test.ts` fails if a joint ever ends up labelled with its raw id.
- **Sliders whose ends are the limits, plus a number box that is not.** Dragging cannot ask for an
  impossible pose (§6). Typing `400` into the box can, on purpose: that is how a human sees the same
  `adjusted[]` report an agent gets.
- **The auto-key rule is written where it bites.** The selected joint's block says "keyed at frame 12 —
  moving a slider writes a key here" or "not keyed yet — your changes stay a scratch pose until you key
  it". Without that line, editing a keyed pose and editing an unkeyed one look identical.
- **Presets, not a blank body.** Six starter poses (T-pose, wave, athletic ready, thinking, reach, both
  arms up) apply through the same door as a slider, so a preset cannot mean something different from a
  hand-move. They are data in `labels.ts`, and the test asserts every angle is inside the authored limits
  so clicking one can never produce a correction.
- **Hover tells you the body is clickable.** One raycast per frame at most (resolved in the render loop,
  not in `pointermove`), a ring the size of the click target, and the joint's name at the cursor. Selection
  is blue, a flash of green means "this edit moved those joints" — the same hook M3's tool calls will use.
- **Clicking works where the body is fat, which is exactly where the torso joints hid.** Every poseable
  joint gets an invisible pick handle sized from the rig's own numbers (`web/src/three/pick.ts`). The drawn
  spheres are 4–8 cm, while the torso box — 28 cm wide, and owned by `hips`, which has no DoFs — stood in
  front of `spine` and `chest`, so a click aimed at the chest selected the root and reported "nothing to
  key here". Handles are ranked by _what the pointer was closest to_ rather than first-hit, so a side view
  picks the near shoulder instead of reaching through the body for the far one. Drawn bones stay pickable
  as the fallback, and a genuine miss deselects instead of grabbing whatever was nearby. The hover ring is
  drawn over the body for the same reason: a sphere buried inside the torso cannot show you its own hover.
- **A key can be retimed by dragging its diamond**, and the whole frame moves together as one undo step:
  a pose blocked on the wrong frame is the most common fix after blocking a clip.
- **Everything refuses out loud.** An edit that wrote nothing says why, in a toast and in the activity log;
  the ruler says "no keys yet — pose the body, then press ◆ key pose"; a page with no JavaScript and a
  build with no rig file both say what is wrong instead of showing a black rectangle.

## Run the relay + connect an agent (M3 onward)

```bash
npm run build -w relay
RIGPILOT_TOKEN=change-me node relay/dist/index.js      # ws://127.0.0.1:8765, loopback only
```

Then open the page and pass the URL params (`?relay=ws://127.0.0.1:8765&token=change-me`) — M3 adds the
**Connect** affordance next to the "agent: not connected" badge in the top bar, and `get_connect_link`
returns the same URL. Until M3 the relay is a stub and the badge is deliberately honest about that.

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
{
  "mcpServers": {
    "rigpilot": {
      "command": "node",
      "args": ["/ABS/PATH/relay/dist/index.js"],
      "env": { "RIGPILOT_TOKEN": "change-me" }
    }
  }
}
```

**Browser:** use Chrome, Edge or Firefox. Chrome will ask for **local network access** when the GitHub
Pages site connects to `127.0.0.1` — allow it. Safari may block the request outright.

## Deploy

`deploy.yml` builds `web/` and publishes it to GitHub Pages with `base = /<repo>/` (override with
`RIGPILOT_BASE`). Settings → Pages must be set to **GitHub Actions** — not "Deploy from a branch", and not
Jekyll: the artifact is `web/dist` served verbatim, and a Jekyll step would only add a Ruby build that
strips anything beginning with `_`. The site is static afterwards: no server, no database, nothing to host
besides Pages.

**One workflow may deploy this site.** `deploy.yml` owns the `pages` concurrency group and the
`github-pages` environment, so a second Pages workflow — including the `static.yml` that GitHub offers when
you tick Pages on — races it: both upload an artifact named `github-pages` and whichever finishes last
publishes it, while the loser shows up as a red "Deploying Pages site failed 🍰" or a cancelled run. The
stock `static.yml` also uploads `'.'`, the repository root, which has no `index.html` at all — a push that
wins that race publishes a 404 over the working site. If Pages was enabled through the GitHub UI and it
committed a deploy workflow for you, delete it and keep `deploy.yml`.

## The rig, in one table

|             |                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Joints      | 21 articulating (`hips spine chest neck head`, `clavicle shoulder elbow wrist` ×2, `hip knee ankle toe` ×2) + 5 end sites = 26 nodes                         |
| Bones       | 22 cylinders (3 hierarchy edges are deliberately boneless: `chest→clavicle_L/R`, `head→head_end`)                                                            |
| Rest        | T-pose, identity rest rotation per joint, 1.80 m, crown 1.80                                                                                                 |
| Conventions | metres, frames at 30 fps default, Y-up right-handed, faces **+Z**, character's **left = +X**, floor **Y = 0**                                                |
| Limits      | degrees on semantic axes `flex / side / twist`, each with a unit axis vector, `min/max`, and a `graze` allowance the solver may exceed before it is reported |
| Hinges      | elbow, knee, toe: exactly one DoF. This is the rule that stops most "broken-looking" animation                                                               |
| Contacts    | heel, ball, toe_tip per foot (6), resting exactly on Y = 0 so a standing pose has zero penetration by construction                                           |

Because the rest frames are identity-aligned with the world, **`offset(child) == worldRest(child) −
worldRest(parent)`**, and a DoF's axis has to be a _vector per joint_, not a shared letter: a leg
pointing −Y flexes about **X**, while a T-pose arm pointing ±X flexes about **Y** and twists about
**X**. Left/right is generated by mirroring the axis `(x, y, z) → (x, −y, −z)` with the angle unchanged
— which is why hinge flexion keeps its sign across sides (both knees bend backward) while arm raise and
elbow flexion invert (both arms hang at `side −90`). All ten of VISION §6's semantic tests pass against
the shipped data: `python3 tools/check-rig.py`.
