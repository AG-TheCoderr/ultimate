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

**Status: M0 (repo foundation) is in.** `core/` loads and validates the rig, CI is green, the studio
page builds. M1 (FK + viewer + posing) is next. See [`docs/VISION.md`](docs/VISION.md) §12.

```
docs/VISION.md          the spec — direction for every milestone (read this first)
docs/RECONCILIATION.md  what the spec gets wrong, with fixes applied (VISION rule 6)
docs/PLAN.md            the earlier plan: rig rationale, milestones, risks
docs/DATA-FORMAT.md     conventions, BVH/glTF mapping, retargeting math (M6 + future import)
core/src/rig/humanoid.rig.json   the rig, as data
tools/gen-rig.py · tools/check-rig.py   generates it · 18 checks including §6's ten semantic tests
```

## Setup

```bash
npm install          # Node 20+
npm test             # core/ invariants (vitest)
npm run lint         # eslint (type-aware)
npm run typecheck
npm run build        # core -> dist, relay -> dist, web -> web/dist
npm run rig          # regenerate + re-verify the rig; CI asserts the committed file matches
```

## Run the studio

```bash
npm run dev          # vite on 0.0.0.0:5173
```

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
`RIGPILOT_BASE`). Settings → Pages must be set to **GitHub Actions**. The site is static: no server, no
database, nothing to host besides Pages.

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
