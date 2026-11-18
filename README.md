# Motion Lab

A browser lab for creating **human motion** — and getting it out as animation a game can actually use.

You move joints on a rig, or record yourself on a webcam, and the lab turns that into editable,
keyframed clips. Clips are stored in an open JSON format, interop through **BVH**, and ship as
**GLB/glTF** (or FBX via Blender) for Unity/Unreal. An assist layer — procedural first, models
later — cleans jitter, locks feet, fills in-betweens, and retargets onto your game skeleton.

> **Status: planning.** No app code yet. The stack, data format, and milestone breakdown are in
> [`docs/PLAN.md`](docs/PLAN.md). The format itself is specced in [`docs/DATA-FORMAT.md`](docs/DATA-FORMAT.md).

## The loop

```
   INPUT                        SOLVE                      DELIVER
   ─────                        ─────                      ───────
   webcam ──► 33 landmarks ┐
                            ├─► IK fit ─► motionlab.anim ─► processors ─► preview on rig
   drag joints + keys ──────┘              (JSON clip)         │
                                                               ├─► .bvh ─► Blender ─► .fbx ─► Unity/Unreal
   import .bvh ────────────────────────────────────────────────┤
                                                .glb ──────────┘ ─► web / Godot

   processors: denoise · foot-lock · root-extract · in-between · retime
               · loop-blend · retarget-to-rig · AI (style / text→motion)
```

## Why a "lab" and not just a recorder

Most webcam-mocap demos stop at "we got 33 landmarks". The useful part — and the part that is
missing — is everything between landmarks and a game clip: skeleton mapping, noise, root motion,
foot contact, retargeting onto a rig with different proportions, and export that survives contact
with an engine. That pipeline is the project. The editors (pose, dopesheet) exist to fix what the
automatic stages get wrong.

## Docs

| File | What's in it |
| --- | --- |
| [`docs/PLAN.md`](docs/PLAN.md) | Stack, architecture, the AI layer and its tiers, milestones M0–M7, risks, open questions |
| [`docs/DATA-FORMAT.md`](docs/DATA-FORMAT.md) | `motionlab.anim` spec, coordinate conventions, BVH + glTF mapping, retargeting math |
