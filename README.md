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

Keyboard: space plays/pauses, ← / → step a frame, shift+← / shift+→ jump to the previous/next keyed
frame, `K` keys the current pose, ctrl+z / ctrl+shift+z undo and redo. A joint the clip has keyed is
driven by the timeline (editing it writes a key at the current frame, as in every DCC); a joint nobody
has keyed still edits the free pose, and both survive a reload through the autosave.

The quickest look at the whole M2 loop: press **3-pose wave**, watch it play, reload the page — the clip,
the playhead, the selection and the un-keyed scratch values all come back. `save .json` writes a
`<clip name>.rigpilot.json` you can diff, commit, or hand to an agent.

## Run the relay + connect an agent (M3 onward)

```bash
npm run build -w relay
RIGPILOT_TOKEN=change-me node relay/dist/index.js      # ws://127.0.0.1:8765, loopback only
```

Then open the page, click **Connect**, or pass the URL params
(`?relay=ws://127.0.0.1:8765&token=change-me`). `get_connect_link` returns the same URL once M3 lands.

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

Keep it the **only** Pages workflow. GitHub's "deploy a static site" template does the same job badly here:
it uploads the repository root, where there is no `index.html` at all, and it joins the same `pages`
concurrency group, so the two runs cancel each other and which commit the site serves becomes a race. A
`static.yml` of that shape lived here briefly and was removed for exactly that reason.

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
