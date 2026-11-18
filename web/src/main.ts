import { loadHumanoidRig } from "@rigpilot/core";
import { PoseState } from "./pose.js";
import { RigView } from "./three/rigView.js";
import { Studio } from "./three/scene.js";
import { PosePanel } from "./panels/posePanel.js";

/**
 * M1: load the rig, draw it, let a human pose it by clicking a joint and moving semantic sliders with
 * limits applied. No timeline yet (M2), no relay (M3) — but the state object here is already the one
 * the MCP executor will mutate, so the AI path and the human path share every code path from day one.
 */
const rig = loadHumanoidRig();
const canvas = mustExist("view") as HTMLCanvasElement;
const info = mustExist("info");
const out = mustExist("report");

// Selection is a Set, not an array: shift-click adds a joint and re-adding must not double-highlight.
let selected: Set<string> = new Set();
const studio = new Studio(canvas);
studio.init();
const view = new RigView(rig);
studio.scene.add(view.group);

const state = new PoseState(rig);
const panel = new PosePanel(rig, state, mustExist("panel"), joint => {
  view.setSelected(joint ? [joint] : []);
  info.textContent = joint ? `selected ${joint}` : "click a joint sphere or pick from the list";
});

const apply = (): void => {
  const solved = state.solve();
  view.update(solved);
  panel.sync();
  const text = panel.report(solved);
  out.textContent = text;
  out.classList.toggle("bad", solved.adjustments.length > 0);
  rev.textContent = `rev ${state.revision}`;
};

const unsub = state.subscribe(apply);

// click to select (and shift-click to add, so a chain can be posed together)
let dragging = false;
canvas.addEventListener("pointerdown", () => (dragging = false));
canvas.addEventListener("pointermove", e => {
  if (e.buttons) dragging = true;
});
canvas.addEventListener("pointerup", e => {
  if (dragging) return; // an orbit drag is not a selection
  const hit = studio.pick(e, view.pickables());
  const joint = hit ? view.jointOf(hit) : null;
  if (e.shiftKey && joint) {
    const next = new Set<string>([...selected, joint]);
    selected = next;
    view.setSelected(next);
    info.textContent = `selected ${[...next].join(", ")}`;
    return;
  }
  selected = joint ? new Set([joint]) : new Set();
  panel.select(joint);
});
// A set, not an array: shift-click adds the same joint twice without double-highlighting.

const rev = mustExist("rev");
mustExist("reset").addEventListener("click", () => state.reset());
mustExist("random").addEventListener("click", () => state.randomize());
mustExist("wave").addEventListener("click", () => {
  // the "can it look human at all" smoke test, in the fewest numbers
  state.reset();
  for (const [joint, v] of [
    ["shoulder_R", { side: -78, flex: 12 }],
    ["elbow_R", { flex: 35 }],
    ["clavicle_R", { side: 6 }],
    ["chest", { side: -4, twist: -6 }],
    ["head", { side: 6, twist: 8 }],
    ["hip_L", { flex: 8 }],
    ["knee_L", { flex: 12 }],
  ] as const) {
    for (const [axis, deg] of Object.entries(v))
      state.set(joint, axis as "flex" | "side" | "twist", deg);
  }
});

window.addEventListener("resize", () => studio.resize());
(function loop() {
  studio.render();
  requestAnimationFrame(loop);
})();
apply();
studio.resize();

window.addEventListener("beforeunload", () => void unsub());

function mustExist(id: string): HTMLElement {
  const n = document.getElementById(id);
  if (!n) throw new Error(`missing #${id}`);
  return n;
}
