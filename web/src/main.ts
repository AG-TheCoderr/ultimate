import { loadHumanoidRig } from "@rigpilot/core";
import { ClipPanel } from "./panels/clipPanel.js";
import { HelpPanel } from "./panels/helpPanel.js";
import { PosePanel } from "./panels/posePanel.js";
import { TopBar } from "./panels/topBar.js";
import { attachAutosave, attachFileDrop, restoreAutosave } from "./storage.js";
import { ProjectStore } from "./store.js";
import { RigView } from "./three/rigView.js";
import { Studio } from "./three/scene.js";
import { Timeline } from "./timeline.js";
import { el, toast } from "./ui.js";

/**
 * Wiring, and nothing else: build the rig, the store, the four surfaces, then keep them pointed at each
 * other. Every edit a person or (M3) an agent makes goes through `ProjectStore`, so this file has no
 * state of its own to keep in sync — which is the only reason the HUD lines below can be so blunt about
 * what just happened.
 *
 * The first-run help overlay is here rather than in a README because §1 asks for a studio a human can use
 * without a manual, and the one rule it has to learn (a keyed joint edits by writing a key) is invisible
 * otherwise.
 */

let rig;
try {
  rig = loadHumanoidRig();
} catch (e) {
  // A missing rig file must say so on screen: without this the page is a black rectangle and the only
  // evidence is a console line, which is the worst possible failure for someone who just arrived.
  document.body.replaceChildren(
    el("p", "fatal", `RigPilot could not load its rig data: ${String(e)}`),
    el(
      "p",
      "fatal",
      "Reload the page. If it persists, the file core/src/rig/humanoid.rig.json is missing from this build.",
    ),
  );
  throw e;
}

const canvas = mustExist("view") as HTMLCanvasElement;
const info = mustExist("info");
const out = mustExist("report");
const status = mustExist("status");
const hover = mustExist("hover");

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
    /not |outside |refused|dropped|ignored|backwards|no keys|blocked/.test(text),
  );
};

const panel = new PosePanel(rig, store, mustExist("panel"), joint => {
  applySelection(joint ? [joint] : [], joint);
});
const timeline = new Timeline(store, mustExist("timeline"), setStatus);
const clipPanel = new ClipPanel(store, mustExist("clip"), setStatus);
const help = new HelpPanel(mustExist("overlay"), {
  onWave: () => runWave(),
  onPickPreset: () => panel.focusFilter(),
});
const topBar = new TopBar(store, mustExist("top"), () => help.toggle());
const stopAutosave = attachAutosave(store);
const stopFileDrop = attachFileDrop(store);

const rev = el("span", "rev");
mustExist("top").querySelector(".brand")?.append(rev);

const restored = restoreAutosave(store);
if (restored.restored) {
  setStatus(
    `back where you left off — ${store.clip.name}, frame ${store.frame}` +
      (restored.warnings.length > 0 ? ` · ${restored.warnings.join(" · ")}` : ""),
  );
  if (restored.warnings.length > 0) toast(restored.warnings.join(" · "), "bad");
} else if (restored.error) {
  setStatus(`the autosave could not be read: ${restored.error}`);
} else {
  setStatus("nothing keyed yet — press ? for the three moves, or hit “▶ Wave demo”");
}
if (HelpPanel.isFirstVisit()) help.open();

function applySelection(joints: readonly string[], primary: string | null): void {
  store.setSelection(joints);
  panel.select(primary);
}

function runWave(): void {
  const report = store.waveDemo();
  const text = [...report.changed, ...report.warnings];
  setStatus(
    text.length > 0
      ? text.join(" · ")
      : `keyed ${report.changed.length} channels across ${store.clip.frameCount} frames — playing`,
  );
  toast("three poses keyed, playing now. ← → steps frames, K keys, Ctrl+Z undoes the lot", "ok");
}

// ── the stage HUD: where to look, and what is under the cursor ────────────────────────────────────

const VIEWS = {
  fit: { pos: [2.5, 1.7, 3.5], label: "whole body" },
  front: { pos: [0, 1.25, 3.2], label: "front" },
  side: { pos: [-3.2, 1.25, 0], label: "side" },
  top: { pos: [0, 3.4, 0.001], label: "top" },
} as const;

const views = mustExist("views");
for (const [key, v] of Object.entries(VIEWS)) {
  const b = el("button", "tbtn");
  b.type = "button";
  b.textContent = key;
  b.title = `frame the camera: ${v.label}. Drag anywhere else to orbit, wheel to zoom`;
  b.addEventListener("click", () => {
    studio.camera.position.set(v.pos[0], v.pos[1], v.pos[2]);
    studio.controls.target.set(0, key === "top" ? 0.9 : 0.95, 0);
    studio.controls.update();
    setStatus(`camera: ${v.label}`);
  });
  views.append(b);
}

// ── the loop ──────────────────────────────────────────────────────────────────────────────────────

let lastRender = performance.now();
let lastStamp = -1;
/**
 * The pointer position for the hover raycast, resolved once per frame instead of once per mousemove. A
 * field on an object rather than a bare `let`: TS narrows a local that is only written from callbacks to
 * its initial value at the point of the check, which would make the guard below provably-empty and the
 * read an error. The holder keeps the write visible as a write.
 */
const pending: { at: { clientX: number; clientY: number } | null } = { at: null };

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
  // the clean line stays visible on purpose: "no corrections" is the evidence that nothing was quietly
  // rewritten, which is the promise the whole app makes
  out.classList.toggle("bad", complaints > 0);
  document.title = `RigPilot · ${store.clip.name}${store.playing ? " ▶" : ""}`;

  const keyed = sample.keyed.joints.length;
  const parts = [
    `frame ${sample.frame + 1} of ${store.clip.frameCount}`,
    `${(sample.frame / store.clip.fps).toFixed(2)} s`,
    keyed === 0 ? "no keys yet" : `${keyed} joint${keyed === 1 ? "" : "s"} keyed at this frame`,
    store.playing ? "playing" : "paused",
  ];
  if (store.selected.length > 0) {
    parts.push(
      store.selected.length === 1
        ? `selected ${panel.humanOf(store.selected[0]!)}`
        : `selected ${store.selected.length} joints`,
    );
  }
  info.textContent = parts.join(" · ");
  rev.textContent = `rev ${store.revision}`;
  rev.title =
    "the clip's revision number. Every edit bumps it, including undo, so a reloaded page and an agent can tell whether they are looking at the same state";

  // what an edit moved glows green for a moment — the same hook M3's tool calls will use
  if (store.touchStamp !== lastStamp) {
    lastStamp = store.touchStamp;
    if (store.lastTouched.length > 0) view.flash(store.lastTouched);
  }
};

store.subscribe(apply);

// click to select (shift-click adds, so a chain can be posed together)
let dragging = false;
canvas.addEventListener("pointerdown", () => (dragging = false));
canvas.addEventListener("pointermove", e => {
  if (e.buttons) dragging = true;
  else pending.at = { clientX: e.clientX, clientY: e.clientY };
});
canvas.addEventListener("pointerleave", () => {
  pending.at = null;
  view.setHover(null);
  hover.hidden = true;
  canvas.style.cursor = "grab";
});
canvas.addEventListener("pointerup", e => {
  if (dragging) return; // an orbit drag is not a selection
  const hit = studio.pick(e, view.pickables());
  const joint = hit ? view.jointOf(hit) : null;
  applySelection(e.shiftKey && joint ? [...store.selected, joint] : joint ? [joint] : [], joint);
});

// keyboard, because scrubbing with a mouse is slow. Every one of these is also a button, and `?` lists them
// all: a shortcut that cannot be discovered from the page is a secret, not a feature.
window.addEventListener("keydown", e => {
  const at = e.target as HTMLElement | null;
  const typing = at && /^(INPUT|SELECT|TEXTAREA)$/.test(at.tagName);
  if (typing) {
    if (e.key === "Escape") at.blur();
    return;
  }
  // the modal owns the keyboard while it is up, and it closes itself on Escape
  if (help.showing && e.key !== "Escape" && e.key !== "?" && e.key !== "F1") return;

  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  switch (true) {
    case e.code === "Space":
      e.preventDefault();
      store.toggle();
      return;
    case e.key === "ArrowRight":
      e.preventDefault();
      if (e.shiftKey) store.jumpKey(1);
      else store.setFrame(store.frame + 1);
      return;
    case e.key === "ArrowLeft":
      e.preventDefault();
      if (e.shiftKey) store.jumpKey(-1);
      else store.setFrame(store.frame - 1);
      return;
    case e.key === "Home":
      e.preventDefault();
      store.setFrame(0);
      return;
    case e.key === "End":
      e.preventDefault();
      store.setFrame(store.clip.frameCount - 1);
      return;
    case key === "k" && e.shiftKey:
    case e.key === "Delete" || e.key === "Backspace": {
      const report = store.unkeyPose();
      setStatus([...report.changed, ...report.warnings].join(" · ") || "no keys at this frame");
      return;
    }
    case key === "k": {
      const report = store.keyPose();
      setStatus([...report.changed, ...report.warnings].join(" · ") || "keyed");
      return;
    }
    case key === "r":
      store.randomizePose();
      setStatus(
        "random legal pose — every joint inside its limits, so the report should stay clean",
      );
      return;
    case key === "p":
      runWave();
      return;
    case mod && key === "z":
      e.preventDefault();
      setStatus(store[e.shiftKey ? "redo" : "undo"]() ?? "nothing to undo");
      return;
    case e.key === "?" || e.key === "F1":
      e.preventDefault();
      help.toggle();
      return;
    case e.key === "Escape":
      applySelection([], null);
      return;
  }
});

(function loop(now: number): void {
  const dt = Math.min((now - lastRender) / 1000, 0.1); // a tab that was hidden must not fast-forward a clip
  lastRender = now;
  store.tick(dt);
  if (pending.at) {
    // hover is resolved here, not in the pointermove handler: one raycast per frame at most
    const at = pending.at;
    pending.at = null;
    const hit = studio.pick(at, view.pickables());
    const joint = hit ? view.jointOf(hit) : null;
    view.setHover(joint);
    canvas.style.cursor = joint ? "pointer" : "grab";
    hover.hidden = joint === null;
    if (joint) {
      hover.textContent = panel.humanOf(joint);
      // the HUD element is fixed to the viewport, so client coordinates are already the right space
      hover.style.left = `${at.clientX + 14}px`;
      hover.style.top = `${at.clientY + 14}px`;
    }
  }
  studio.render();
  requestAnimationFrame(loop);
})(lastRender);

apply();
studio.resize();

window.addEventListener("pagehide", () => {
  timeline.destroy();
  clipPanel.destroy();
  topBar.destroy();
  help.destroy();
  stopFileDrop();
  stopAutosave();
});

function mustExist(id: string): HTMLElement {
  const n = document.getElementById(id);
  if (!n) throw new Error(`missing #${id}`);
  return n;
}
