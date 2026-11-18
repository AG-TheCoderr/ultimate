import { loadHumanoidRig } from "@rigpilot/core";

/**
 * M0 placeholder: proves the workspace wiring (core -> web), the Pages `base` path, and the relay
 * URL contract from VISION §8. The Three.js viewer, the grid and the rig geometry land in M1, where
 * `#viewport` gets replaced by a canvas and this file becomes the app bootstrap.
 */
const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
};

const status = el("status");
try {
  const rig = loadHumanoidRig();
  const articulating = rig.joints.filter(j => j.kind !== "endSite").length;
  const rows: [string, string][] = [
    ["rig", `${rig.id} v${rig.version}`],
    ["joints", `${articulating} articulating + ${rig.joints.length - articulating} end sites`],
    [
      "bones",
      `${rig.bones.length} cylinders, ${Number(rig.stats["hierarchyEdges"])} hierarchy edges`,
    ],
    ["contact markers", `${rig.markers.length} (heel, ball, toe tip per foot)`],
    ["bind height", `${rig.bindHeight} m, crown ${(rig.proportions as { crown: number }).crown} m`],
    [
      "conventions",
      `${rig.conventions.upAxis} up · faces ${rig.conventions.forwardAxis} · left ${rig.conventions.leftAxis}`,
    ],
  ];
  el("riginfo").innerHTML =
    `<table><tbody>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</tbody></table>` +
    `<div id="viewport">three.js viewer + floor grid arrive in M1</div>`;
  status.textContent = "core → web wiring OK · rig validated at load";
  status.classList.add("ok");
} catch (err) {
  status.textContent = `rig failed to load: ${(err as Error).message}`;
  el("riginfo").innerHTML = `<pre>${String((err as Error).message)}</pre>`;
  status.classList.add("bad");
  throw err;
}

// VISION §8: the page reaches the local relay over ws://127.0.0.1:8765 with a pairing token.
// M3 implements the client; M0 only reads the contract so the URL format is settled and testable.
const params = new URLSearchParams(location.search);
const relay = params.get("relay");
const token = params.get("token") ?? location.hash.slice(1);
if (relay)
  console.log(`[relay] would connect to ${relay} (token ${token ? "present" : "missing"})`);
if (token && !params.has("token")) {
  // tokens belong in the fragment, which never reaches a server or a log line
  console.debug("[relay] token read from URL fragment");
}
