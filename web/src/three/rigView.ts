import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";
import type { HumanoidRig, SolveResult, Vec3 } from "@rigpilot/core";

/**
 * The studio body: one rigid primitive per bone plus a sphere per joint, no skin weights (VISION §M6).
 *
 * Each primitive is bound ONCE, in rest space, to a single joint, and every frame we multiply the
 * joint's solved world transform by that rest-space local matrix. That is exactly what a GPU skin does
 * with one bone and weight 1.0 — which is why the same numbers export cleanly to a glTF skin later, and
 * why nothing here has to know about hierarchies or IK.
 */

interface Primitive {
  readonly mesh: Mesh;
  readonly parentJoint: string;
  readonly local: Matrix4;
  readonly baseColor: number;
}

const toV = (v: Vec3): Vector3 => new Vector3(v[0], v[1], v[2]);
const ONE = new Vector3(1, 1, 1);
const chan = (v: number | undefined, fallback: number): number => Math.round((v ?? fallback) * 255);
const hex = (rgb: readonly number[] | undefined, fallback: readonly number[]): number =>
  (chan(rgb?.[0], fallback[0] ?? 0.6) << 16) |
  (chan(rgb?.[1], fallback[1] ?? 0.6) << 8) |
  chan(rgb?.[2], fallback[2] ?? 0.7);

export class RigView {
  readonly group = new Group();
  private readonly prims: Primitive[] = [];
  private readonly byJoint = new Map<string, Mesh[]>();
  private readonly selected = new Set<string>();
  private readonly tmp = new Matrix4();

  constructor(private readonly rig: HumanoidRig) {
    const m = this.rig.mesh as unknown as {
      colors: Record<string, readonly number[]>;
      head: { parent: string; radius: number; offset: Vec3; ellipsoidScale: Vec3 };
      torso: { type: "box"; from: string; to: string; halfSize: Vec3 };
    };
    const boneColor = hex(m.colors["bone"], [0.62, 0.65, 0.7]);
    const sideColor = (c: string): number =>
      hex(
        m.colors[c],
        c === "left" ? [0.3, 0.55, 0.95] : c === "right" ? [0.95, 0.42, 0.32] : [0.8, 0.82, 0.86],
      );

    const up = new Vector3(0, 1, 0);
    const unitCyl = new CylinderGeometry(1, 1, 1, 20, 1, true);
    const unitSphere = new SphereGeometry(1, 20, 14);
    const rest = this.rig.restPose.joints;

    // bones: cylinder from `from` to `to`, authored to end AT the child joint
    for (const b of this.rig.bones) {
      const a = toV(rest[b.from]!);
      const c = toV(rest[b.to]!);
      const dir = c.clone().sub(a);
      const len = dir.length();
      const mesh = new Mesh(
        unitCyl,
        new MeshStandardMaterial({ color: boneColor, roughness: 0.7, metalness: 0 }),
      );
      mesh.scale.set(b.radius, len, b.radius);
      mesh.position.copy(a.clone().addScaledVector(dir, 0.5));
      mesh.quaternion.setFromUnitVectors(up, dir.clone().normalize());
      this.push(mesh, b.from, b.name, boneColor);
    }

    // joints: spheres 1.1x the widest cylinder they join, so bending never opens a gap
    for (const j of this.rig.joints) {
      if (j.radius === null) continue;
      const color = sideColor(j.color);
      const mesh = new Mesh(
        unitSphere,
        new MeshStandardMaterial({ color, roughness: 0.55, metalness: 0 }),
      );
      mesh.scale.setScalar(j.radius);
      mesh.position.copy(toV(j.restPosition));
      this.push(mesh, j.name, `joint:${j.name}`, color);
    }

    // head: the one shape that is not a joint or a bone, offset from the head joint on purpose
    // (centring it on the joint puts the crown 7 cm short of bindHeight; see RECONCILIATION §2.6)
    const head = m.head;
    const hm = new Mesh(
      unitSphere,
      new MeshStandardMaterial({ color: sideColor("center"), roughness: 0.5, metalness: 0 }),
    );
    hm.scale.set(
      head.radius * head.ellipsoidScale[0],
      head.radius * head.ellipsoidScale[1],
      head.radius * head.ellipsoidScale[2],
    );
    hm.position.copy(toV(rest[head.parent]!).add(toV(head.offset)));
    this.push(hm, head.parent, "shape:head", sideColor("center"));

    const torso = m.torso;
    const ta = toV(rest[torso.from]!);
    const tb = toV(rest[torso.to]!);
    const tdir = tb.clone().sub(ta);
    const box = new Mesh(
      new BoxGeometry(torso.halfSize[0] * 2, tdir.length(), torso.halfSize[2] * 2),
      new MeshStandardMaterial({ color: sideColor("center"), roughness: 0.8, metalness: 0 }),
    );
    box.position.copy(ta.clone().addScaledVector(tdir, 0.5));
    box.quaternion.setFromUnitVectors(up, tdir.clone().normalize());
    this.push(box, torso.from, "shape:torso", sideColor("center"));
  }

  private push(mesh: Mesh, parentJoint: string, label: string, baseColor: number): void {
    mesh.name = label;
    mesh.userData.joint = parentJoint;
    mesh.matrixAutoUpdate = true;
    this.prims.push({ mesh, parentJoint, local: mesh.matrix.clone(), baseColor });
    const list = this.byJoint.get(parentJoint) ?? [];
    list.push(mesh);
    this.byJoint.set(parentJoint, list);
    this.group.add(mesh);
  }

  update(solved: SolveResult): void {
    for (const p of this.prims) {
      const j = solved.joints[p.parentJoint];
      if (!j) continue;
      const [x, y, z] = j.position;
      const [qx, qy, qz, qw] = j.rotation;
      this.tmp.compose(new Vector3(x, y, z), new Quaternion(qx, qy, qz, qw).normalize(), ONE);
      p.mesh.matrix.copy(this.tmp).multiply(p.local);
      p.mesh.matrixAutoUpdate = false;
      p.mesh.matrixWorldNeedsUpdate = true;
    }
  }

  /** Selected joints glow; the material is per-mesh so this never leaks into siblings. */
  setSelected(joints: Iterable<string>): void {
    const next = new Set(joints);
    for (const name of [...this.selected]) {
      if (next.has(name)) continue;
      for (const mesh of this.byJoint.get(name) ?? []) this.tint(mesh, this.base(mesh), 0x000000);
      this.selected.delete(name);
    }
    for (const name of next) {
      if (this.selected.has(name)) continue;
      for (const mesh of this.byJoint.get(name) ?? []) this.tint(mesh, this.base(mesh), 0x2f6bff);
      this.selected.add(name);
    }
  }

  /** Brief highlight for the joints an MCP call just changed (M3 reuses this). */
  flash(joints: Iterable<string>, ms = 700): void {
    const list = [...joints];
    for (const name of list)
      for (const mesh of this.byJoint.get(name) ?? []) this.tint(mesh, this.base(mesh), 0x49d29a);
    setTimeout(() => {
      for (const name of list)
        for (const mesh of this.byJoint.get(name) ?? [])
          this.tint(mesh, this.base(mesh), this.selected.has(name) ? 0x2f6bff : 0x000000);
    }, ms);
  }

  private base(mesh: Mesh): number {
    const p = this.prims.find(x => x.mesh === mesh);
    return p?.baseColor ?? 0xffffff;
  }

  private tint(mesh: Mesh, color: number, emissive: number): void {
    const mat = mesh.material as MeshStandardMaterial;
    mat.color.setHex(color);
    mat.emissive.setHex(emissive);
    mat.emissiveIntensity = emissive === 0 ? 1 : 0.55;
  }

  /** Picking targets: the joint spheres only, so clicking a bone still selects its parent joint. */
  pickables(): Mesh[] {
    return this.prims.filter(p => p.mesh.geometry.type === "SphereGeometry").map(p => p.mesh);
  }

  jointOf(mesh: Mesh): string | null {
    const label = mesh.name;
    return label.startsWith("joint:") ? label.slice(6) : null;
  }
}
