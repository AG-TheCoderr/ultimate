import { loadHumanoidRig } from "@rigpilot/core";
import { PosePanel } from "./panels/posePanel.js";
import { ClipPanel } from "./panels/clipPanel.js";
import { attachAutosave, restoreAutosave } from "./storage.js";
import { ProjectStore } from "./store.js";
import { RigView } from "./three/rigView.js";
import { Studio } from "./three/scene.js";
import { Timeline } from "./timeline.js";

/**
 * M2: the same body as M1, now driven by a clip. The timeline, the sliders and (M3) the MCP tools all go
 * through `ProjectStore`, so there is one pose on screen and one report about it — which is what makes
 * "everything the agent does is visible" a property of the architecture rather than a feature.
 */
const rig = loadHumanoidRig();
const canvas = mustExist("view") as HTMLCanvasElement;
const info = mustExist("info");
const out = mustExist("report");
const status = mustExist("status");

const store = new ProjectStore(rig);
const studio = new Studio(canvas);
studio.init();
const view = new RigView(rig);
studio.scene.add(view.group);

/** The one line the panels and the keyboard handlers share for "something happened, and here's the text". */
const setStatus = (text: string): void => {
  status.textContent = text;
  status.classList.toggle(
    "bad",
    /not |outside |refused|dropped|ignored|backwards|no keys/.test(text),
  );
};

const panel = new PosePanel(rig, store, mustExist("panel"), joint => {
  applySelection(joint ? [joint] : [], joint);
});
const timeline = new Timeline(store, mustExist("timeline"), setStatus);
const clipPanel = new ClipPanel(store, mustExist("clip"), setStatus);
const stopAutosave = attachAutosave(store);

const rev = mustExist("rev");
const restored = restoreAutosave(store);
if (restored.restored) {
  setStatus(
    `restored last session's clip (${store.clip.name}, ${store.clip.frameCount} frames)` +
      (restored.warnings.length > 0 ? ` — ${restored.warnings.join(" · ")}` : ""),
  );
} else if (restored.error) {
  setStatus(`the autosave could not be read: ${restored.error}`);
}

function applySelection(joints: readonly string[], primary: string | null): void {
  store.setSelection(joints);
  panel.select(primary);
}

let lastRender = performance.now();

const apply = (): void => {
  const sample = store.sample();
  view.update(sample.solved);
  view.setSelected(store.selected);
  panel.sync(sample, !store.playing);
  out.textContent = panel.report(sample.solved);
  const complaints =
    sample.solved.adjustments.length +
    sample.solved.unknownJoints.length +
    sample.solved.unknownAxes.length +
    sample.ignored.length;
  out.classList.toggle("bad", complaints > 0);
  rev.textContent = `rev ${store.revision}`;
  const keyed = sample.keyed.joints.length;
  const method = store.selected.length > 0 ? (sample.methods[store.selected[0]!] ?? "—") : "—";
  info.textContent =
    `frame ${sample.frame}/${store.clip.frameCount - 1} @ ${store.clip.fps} fps · ` +
    `${keyed} channel${keyed === 1 ? "" : "s"} keyed (${method})` +
    (store.selected.length > 0 ? ` · ${store.selected.join(", ")}` : " · click a joint to pose it");
};

store.subscribe(apply);

// click to select (shift-click adds, so a chain can be posed together)
let dragging = false;
canvas.addEventListener("pointerdown", () => (dragging = false));
canvas.addEventListener("pointermove", e => {
  if (e.buttons) dragging = true;
});
canvas.addEventListener("pointerup", e => {
  if (dragging) return; // an orbit drag is not a selection
  const hit = studio.pick(e, view.pickables());
  const joint = hit ? view.jointOf(hit) : null;
  applySelection(e.shiftKey && joint ? [...store.selected, joint] : joint ? [joint] : [], joint);
});

mustExist("reset").addEventListener("click", () => store.resetPose());
mustExist("random").addEventListener("click", () => store.randomizePose());
mustExist("wave").addEventListener("click", () => {
  // three key poses across the clip, which is M2's acceptance test: a human, no AI, a playable wave
  store.resetPose();
  const beat = Math.max(2, Math.floor(store.clip.frameCount / 3));
  const poses: { frame: number; joints: Record<string, Record<string, number>> }[] = [
    {
      frame: 0,
      joints: {
        shoulder_R: { side: -78, flex: 12 },
        elbow_R: { flex: 35 },
        chest: { side: -4, twist: -6 },
        head: { side: 6, twist: 8 },
      },
    },
    {
      frame: beat,
      joints: {
        shoulder_R: { side: -95, twist: 30 },
        elbow_R: { flex: 8 },
        chest: { side: 3, twist: 5 },
        head: { side: -4, twist: -6 },
      },
    },
    {
      frame: beat * 2,
      joints: {
        shoulder_R: { side: -70, flex: 20 },
        elbow_R: { flex: 60 },
        chest: { side: -6, twist: -8 },
        head: { side: 8 },
      },
    },
  ];
  for (const p of poses) {
    store.setFrame(p.frame);
    // scratch values first (they are what makes an unkeyed joint hold still between the poses), then one
    // key per pose for exactly the joints this pose moves
    for (const [joint, axes] of Object.entries(p.joints)) {
      for (const [axis, deg] of Object.entries(axes))
        store.setAxis(joint, axis as "flex" | "side" | "twist", deg);
    }
    store.keyPose(Object.keys(p.joints));
  }
  store.setSelection([]);
  store.play();
  setStatus(`keyed ${poses.length} poses across ${store.clip.frameCount} frames — playing`);
});

// keyboard, because scrubbing with a mouse is slow: space plays, arrows step, K keys, Z undoes
window.addEventListener("keydown", e => {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.code === "Space") {
    e.preventDefault();
    store.toggle();
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    if (e.shiftKey) store.jumpKey(1);
    else store.setFrame(store.frame + 1);
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    if (e.shiftKey) store.jumpKey(-1);
    else store.setFrame(store.frame - 1);
  } else if (e.key === "k" || e.key === "K") {
    const report = store.keyPose();
    setStatus([...report.changed, ...report.warnings].join(" · ") || "keyed");
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    setStatus(store[e.shiftKey ? "redo" : "undo"]() ?? "nothing to undo");
  }
});

window.addEventListener("resize", () => studio.resize());

(function loop(now: number): void {
  const dt = Math.min((now - lastRender) / 1000, 0.1); // a tab that was hidden must not fast-forward a clip
  lastRender = now;
  store.tick(dt);
  studio.render();
  requestAnimationFrame(loop);
})(lastRender);

apply();
studio.resize();

window.addEventListener("pagehide", () => {
  timeline.destroy();
  clipPanel.destroy();
  stopAutosave();
});

function mustExist(id: string): HTMLElement {
  const n = document.getElementById(id);
  if (!n) throw new Error(`missing #${id}`);
  return n;
}
