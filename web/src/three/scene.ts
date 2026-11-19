import {
  Color,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  Mesh,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Vec3 } from "@rigpilot/core";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * Renderer, camera, lights, the 10 cm floor grid (the same grid `render_preview` will draw in M5) and
 * pointer picking. One class, one canvas, no framework: the viewer is a viewport, not an app to
 * re-render, and VISION §15 asks for 60 fps.
 */
export class Studio {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(45, 1, 0.05, 100);
  readonly controls: OrbitControls;
  private renderer: WebGLRenderer | undefined;
  private readonly ray = new Raycaster();
  private readonly ndc = new Vector2();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.scene.background = new Color(0x0e1013);
    this.camera.position.set(2.5, 1.7, 3.5);

    const hemi = new HemisphereLight(0xdfe7ff, 0x1a1d22, 1.15);
    const key = new DirectionalLight(0xffffff, 1.6);
    key.position.set(2.5, 4.2, 2.6);
    const rim = new DirectionalLight(0x88aaff, 0.5);
    rim.position.set(-3, 1.5, -2.5);
    this.scene.add(hemi, key, rim);

    // 4 m across in 40 cells = 10 cm squares; the floor plane is Y = 0 (VISION §4)
    const grid = new GridHelper(4, 40, 0x3d444d, 0x23272e);
    this.scene.add(grid);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.95, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.99;
  }

  init(): void {
    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.resize();
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent || !this.renderer) return;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio ?? 1));
    this.renderer.setSize(w, h, true);
  }

  render(): void {
    this.controls.update();
    this.renderer?.render(this.scene, this.camera);
  }

  /**
   * The event only needs to be a point on screen, so the hover raycast in the render loop can pass the
   * coordinates it stored instead of synthesising a PointerEvent.
   */
  pick(event: { clientX: number; clientY: number }, targets: readonly Mesh[]): Mesh | null {
    if (!targets.length) return null;
    this.rayFromPointer(event);
    const hit = this.ray.intersectObjects([...targets], false)[0];
    return hit ? (hit.object as Mesh) : null;
  }

  /**
   * The pointer as a world-space ray, which is what `RigView.pickJoint` ranks handles with. Exposed rather
   * than kept private because the handles are not three.js objects — and one ray from one place is what
   * keeps hover, click and mesh-picking answering the same question instead of drifting apart.
   */
  rayFromPointer(event: { clientX: number; clientY: number }): { origin: Vec3; dir: Vec3 } {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(
      ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
      -((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1,
    );
    this.ray.setFromCamera(this.ndc, this.camera);
    const { origin, direction } = this.ray.ray;
    return { origin: [origin.x, origin.y, origin.z], dir: [direction.x, direction.y, direction.z] };
  }

  /** Where an orthographic preview camera sits per view (M5 renders PNGs from this). */
  orthoView(view: "front" | "side" | "top", dist = 6): { position: Vector3; target: Vector3 } {
    const target = new Vector3(0, 0.95, 0);
    const position =
      view === "front"
        ? new Vector3(0, 1, dist)
        : view === "side"
          ? new Vector3(-dist, 1, 0)
          : new Vector3(0, dist, 0.001);
    return { position, target };
  }
}
