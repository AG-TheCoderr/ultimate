import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";
import {
  bindPrimitives,
  type BoundPrimitive,
  type HumanoidRig,
  type SolveResult,
} from "@rigpilot/core";

/**
 * Draws the studio body: one rigid primitive per bone, one sphere per joint, plus the head and torso
 * shapes. No skin weights (VISION §M6).
 *
 * All binding math lives in `core/src/rig/bind.ts`; this file only turns bound TRS triples into meshes
 * and multiplies them by the solved joint transforms. That split is what caught two bugs the first
 * version had here — reading `mesh.matrix` before `updateMatrix()` (always the identity), and authoring
 * primitives in world rest space so the parent's translation was counted twice, dropping the whole body
 * a hip-height off. `core/test/bind.test.ts` now fails loudly if either comes back.
 */
interface Entry {
  readonly mesh: Mesh;
  readonly bound: BoundPrimitive;
  readonly parentJoint: string;
  readonly base: Color;
}

export class RigView {
  readonly group = new Group();
  private readonly entries: Entry[] = [];
  private readonly byJoint = new Map<string, Mesh[]>();
  private readonly selected = new Set<string>();
  private hovered: string | null = null;
  private readonly pickableMeshes: Mesh[] = [];

  constructor(rig: HumanoidRig) {
    const palette =
      (rig.mesh as unknown as { colors?: Record<string, readonly number[]> }).colors ?? {};
    const colorOf = (key: string): Color => {
      const c = palette[key];
      // rig values are 0..1 triples; setRGB keeps them in the renderer's working color space
      return new Color().setRGB(c?.[0] ?? 0.62, c?.[1] ?? 0.65, c?.[2] ?? 0.7);
    };

    // shared unit geometry, scaled per primitive: ~53 meshes from three geometries
    const unitCyl = new CylinderGeometry(1, 1, 1, 20, 1, true);
    const unitSphere = new SphereGeometry(1, 20, 14);
    const unitBox = new BoxGeometry(1, 1, 1);

    for (const bound of bindPrimitives(rig)) {
      const geometry =
        bound.kind === "bone" ? unitCyl : bound.kind === "torso" ? unitBox : unitSphere;
      const base = colorOf(bound.colorKey);
      const mesh = new Mesh(
        geometry,
        new MeshStandardMaterial({
          color: base.clone(),
          roughness: bound.kind === "joint" ? 0.55 : 0.72,
          metalness: 0,
        }),
      );
      mesh.name = bound.label;
      mesh.userData.rigpilot = { joint: bound.parentJoint, kind: bound.kind };
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.entries.push({ mesh, bound, parentJoint: bound.parentJoint, base });
      const list = this.byJoint.get(bound.parentJoint) ?? [];
      list.push(mesh);
      this.byJoint.set(bound.parentJoint, list);
      this.pickableMeshes.push(mesh);
      this.group.add(mesh);
    }
    // no priming pass: main.ts calls update(solve(rig, {})) on startup, and the rest pose is just
    // another solve. Duplicating that here is how a viewer and a solver drift apart.
  }

  /** world = parentWorld * local, per primitive. ~53 compose calls per frame: cheap, allocation-free. */
  update(solved: SolveResult): void {
    for (const e of this.entries) {
      const joint = solved.joints[e.parentJoint];
      if (!joint) continue;
      const b = e.bound;
      const rot = _q.set(
        joint.rotation[0],
        joint.rotation[1],
        joint.rotation[2],
        joint.rotation[3],
      );
      _v.set(b.position[0], b.position[1], b.position[2]).applyQuaternion(rot);
      e.mesh.position.set(
        joint.position[0] + _v.x,
        joint.position[1] + _v.y,
        joint.position[2] + _v.z,
      );
      // the primitive's own rotation is applied AFTER the parent's, i.e. parentRot * localRot
      e.mesh.quaternion
        .copy(rot)
        .multiply(_q2.set(b.quaternion[0], b.quaternion[1], b.quaternion[2], b.quaternion[3]));
      e.mesh.scale.set(b.scale[0], b.scale[1], b.scale[2]);
      e.mesh.updateMatrix();
    }
  }

  /** Selected joints glow. Materials are per-mesh, so a highlight never bleeds into a sibling. */
  setSelected(joints: Iterable<string>): void {
    const next = new Set(joints);
    for (const name of [...this.selected]) {
      if (next.has(name)) continue;
      const hovering = name === this.hovered;
      for (const mesh of this.byJoint.get(name) ?? [])
        this.tint(mesh, hovering ? 0x1a3a5c : 0x000000, hovering ? 0.35 : 0);
      this.selected.delete(name);
    }
    for (const name of next) {
      if (this.selected.has(name)) continue;
      for (const mesh of this.byJoint.get(name) ?? []) this.tint(mesh, 0x2f6bff, 0.6);
      this.selected.add(name);
    }
  }

  /**
   * Hover feedback, separate from selection so the two never fight over the same channel: a hovered mesh
   * gets a faint emissive, a selected one keeps its stronger blue. This exists because "the body is
   * clickable" is not guessable from a static render — a pointer that changes colour when it arrives over
   * a joint is what tells a first-timer they can pose the arm by grabbing it.
   */
  setHover(joint: string | null): void {
    if (joint === this.hovered) return;
    const clear = this.hovered;
    this.hovered = joint;
    for (const name of [clear, joint]) {
      if (!name) continue;
      const on = name === joint;
      for (const mesh of this.byJoint.get(name) ?? []) {
        if (this.selected.has(name)) continue; // selection wins
        this.tint(mesh, on ? 0x1a3a5c : 0x000000, on ? 0.35 : 0);
      }
    }
  }

  /** Brief highlight for the joints an MCP call just changed (M3 reuses this). */
  flash(joints: Iterable<string>, ms = 700): void {
    const list = [...joints];
    for (const name of list)
      for (const mesh of this.byJoint.get(name) ?? []) this.tint(mesh, 0x49d29a, 0.75);
    setTimeout(() => {
      for (const name of list)
        for (const mesh of this.byJoint.get(name) ?? [])
          this.tint(
            mesh,
            this.selected.has(name) ? 0x2f6bff : 0x000000,
            this.selected.has(name) ? 0.6 : 0,
          );
    }, ms);
  }

  private tint(mesh: Mesh, emissive: number, intensity: number): void {
    const entry = this.entries.find(e => e.mesh === mesh);
    const mat = mesh.material as MeshStandardMaterial;
    if (entry) mat.color.copy(entry.base);
    mat.emissive.setHex(emissive);
    mat.emissiveIntensity = intensity;
  }

  /**
   * Everything is pickable. Joint spheres alone were 5-7 cm targets floating inside the limb they
   * belonged to; a bone cylinder is the same joint's own geometry, and `parentJoint` maps it back.
   */
  pickables(): readonly Mesh[] {
    return this.pickableMeshes;
  }

  /** The joint that owns the mesh the ray hit. */
  jointOf(mesh: Mesh): string | null {
    return (mesh.userData.rigpilot as { joint?: string } | undefined)?.joint ?? null;
  }
}

// scratch objects: update() runs every frame, so no per-call allocation
const _q = new Quaternion();
const _q2 = new Quaternion();
const _v = new Vector3();
