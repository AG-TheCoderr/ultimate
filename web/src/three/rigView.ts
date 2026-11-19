import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
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
  type Vec3,
} from "@rigpilot/core";
import { buildHandles, pickHandle, type Ray } from "./pick.js";

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
  private readonly hoverRing: Mesh;
  /** One ring per selected joint, kept after use so a shift-clicked chain does not rebuild geometry. */
  private readonly selectRings = new Map<string, Mesh>();
  private readonly ringFor: (color: number, opacity: number) => Mesh;
  private readonly pickableMeshes: Mesh[] = [];
  /**
   * Invisible pick handles, one per poseable joint, held in flat arrays so `update()` mutates in place
   * instead of allocating 21 objects every frame. The radius policy and the aim ranking are pure and tested
   * in `pick.ts`; what lives here is only their position, which has to follow the pose.
   */
  private readonly handleIndex = new Map<string, number>();
  private readonly handleJoints: string[];
  private readonly handleRadii: number[];
  private readonly handleCenters: Float64Array;

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

    // Aim rings. A handle in the torso is invisible *by construction* — it is there so a buried joint can
    // be clicked — so the joint needs a mark that is not buried too: a wireframe shell the size of the
    // handle, drawn over everything. Without this, hovering your own chest highlights a sphere inside the
    // torso box and the feedback is invisible, which is the same complaint in a different costume.
    const ring = (color: number, opacity: number): Mesh => {
      const m = new Mesh(
        unitSphere,
        new MeshBasicMaterial({
          color,
          wireframe: true,
          transparent: true,
          opacity,
          depthTest: false,
        }),
      );
      m.renderOrder = 999;
      m.visible = false;
      return m;
    };
    this.hoverRing = ring(0x9dc0ff, 0.5);
    this.ringFor = ring;
    this.group.add(this.hoverRing);

    const handles = buildHandles(rig);
    this.handleJoints = handles.map(h => h.joint);
    this.handleJoints.forEach((name, i) => this.handleIndex.set(name, i));
    this.handleRadii = handles.map(h => h.radius);
    this.handleCenters = new Float64Array(handles.length * 3);
    handles.forEach((h, i) => {
      this.handleCenters[i * 3] = h.center[0];
      this.handleCenters[i * 3 + 1] = h.center[1];
      this.handleCenters[i * 3 + 2] = h.center[2];
    });

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
    for (let i = 0; i < this.handleJoints.length; i++) {
      const joint = solved.joints[this.handleJoints[i]!];
      if (!joint) continue;
      // a handle frozen at the rest position would pick the joint the body *was* at, not the one it is at
      this.handleCenters[i * 3] = joint.position[0];
      this.handleCenters[i * 3 + 1] = joint.position[1];
      this.handleCenters[i * 3 + 2] = joint.position[2];
    }
    this.placeRing(this.hoverRing, this.hovered);
    for (const joint of this.selected) {
      const mesh = this.selectRings.get(joint) ?? this.addSelectRing(joint);
      this.placeRing(mesh, joint);
    }
    for (const [joint, mesh] of this.selectRings)
      if (!this.selected.has(joint)) mesh.visible = false;
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
  private addSelectRing(joint: string): Mesh {
    const mesh = this.ringFor(0x6ea8fe, 0.75);
    this.selectRings.set(joint, mesh);
    this.group.add(mesh);
    return mesh;
  }

  /** A ring rides its joint's handle: same centre, same radius, so the mark and the grab agree exactly. */
  private placeRing(mesh: Mesh, joint: string | null): void {
    const i = joint === null ? undefined : this.handleIndex.get(joint);
    mesh.visible = i !== undefined;
    if (i === undefined) return;
    mesh.position.set(
      this.handleCenters[i * 3]!,
      this.handleCenters[i * 3 + 1]!,
      this.handleCenters[i * 3 + 2]!,
    );
    mesh.scale.setScalar(this.handleRadii[i]!);
  }

  /**
   * The joint a ray was aimed at, by handle: generous enough that the torso, the wrists and the toes are
   * all reachable, and ranked by what the pointer was closest to. Null means the aim missed every joint,
   * which the caller reads as "clicked empty space" rather than "grab the nearest thing anyway".
   */
  pickJoint(ray: Ray): string | null {
    const at = this.handleJoints.map((joint, i) => ({
      joint,
      radius: this.handleRadii[i]!,
      center: [
        this.handleCenters[i * 3]!,
        this.handleCenters[i * 3 + 1]!,
        this.handleCenters[i * 3 + 2]!,
      ] as Vec3,
    }));
    return pickHandle(ray, at)?.joint ?? null;
  }

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
