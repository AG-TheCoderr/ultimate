import type { AxisName, HumanoidRig, RigJoint, SolveResult } from "@rigpilot/core";
import type { PoseState } from "../pose.js";

/**
 * Joint list + one slider per semantic DoF. The slider range IS the authored limit, so an illegal
 * value is not merely warned about — it cannot be expressed (VISION §6: "impossible poses are
 * impossible"). The numeric box next to it can go past the limit on purpose: that path shows the
 * `adjusted` report, which is the same report an MCP call returns, so a human sees what the agent sees.
 */
export class PosePanel {
  private readonly joints: RigJoint[];
  private rows = new Map<
    string,
    Map<AxisName, { range: HTMLInputElement; num: HTMLInputElement; hint: HTMLElement }>
  >();
  private selected: string | null = null;

  constructor(
    private readonly rig: HumanoidRig,
    private readonly state: PoseState,
    private readonly root: HTMLElement,
    private readonly onSelect: (joint: string | null) => void,
  ) {
    this.joints = rig.joints.filter(j => j.axes.length > 0 || j.kind === "root");
    this.render();
  }

  private render(): void {
    this.root.innerHTML = "";
    const list = el("div", "jointlist");
    for (const j of this.joints) {
      const b = el("button", "joint");
      b.textContent = j.name;
      b.dataset.joint = j.name;
      b.title =
        j.kind === "root"
          ? "root: free translation + heading"
          : j.axes.map(a => `${a.name} ${a.min}..${a.max}`).join(", ");
      b.addEventListener("click", () => this.select(j.name));
      list.append(b);
    }
    this.root.append(list, el("hr"));

    this.rows = new Map<
      string,
      Map<AxisName, { range: HTMLInputElement; num: HTMLInputElement; hint: HTMLElement }>
    >();
    for (const j of this.joints) {
      const block = el("div", "jointblock");
      block.dataset.joint = j.name;
      block.hidden = true;
      const h = el("h3");
      h.textContent = j.name;
      const sub = el("p", "sub");
      sub.textContent =
        j.kind === "root"
          ? "root joint — position and heading are keyed on the clip, not here in M1"
          : `parent: ${j.parent ?? "—"} · role: ${j.role}`;
      block.append(h, sub);
      const axes = j.kind === "root" ? [] : j.axes;
      for (const a of axes) {
        const row = el("label", "axisrow");
        const name = el("span", "axisname");
        name.textContent = a.name;
        const range = document.createElement("input");
        range.type = "range";
        range.min = String(a.min);
        range.max = String(a.max);
        range.step = "1";
        range.value = "0";
        const num = document.createElement("input");
        num.type = "number";
        num.min = String(a.min - a.graze[0]);
        num.max = String(a.max + a.graze[1]);
        num.step = "1";
        num.value = "0";
        const hint = el("span", "hint");
        hint.textContent =
          `${a.positiveMeans} · limit ${a.min}…${a.max}°` +
          (a.graze[0] || a.graze[1]
            ? ` · solver may graze ${a.min - a.graze[0]}…${a.max + a.graze[1]}°`
            : "");
        const set = (deg: number): void => this.state.set(j.name, a.name, deg);
        range.addEventListener("input", () => set(Number(range.value)));
        num.addEventListener("input", () => set(Number(num.value)));
        row.append(name, range, num, hint);
        block.append(row);
        let m = this.rows.get(j.name);
        if (!m)
          this.rows.set(
            j.name,
            (m = new Map<
              AxisName,
              { range: HTMLInputElement; num: HTMLInputElement; hint: HTMLElement }
            >()),
          );
        m.set(a.name, { range, num, hint });
      }
      if (axes.length === 0 && j.kind !== "root") block.append(el("p", "sub"));
      if (j.axes.length === 1) {
        const tag = el("p", "tag");
        tag.textContent =
          "HINGE — one DoF. This is the rule that stops knees and elbows bending sideways.";
        block.append(tag);
      }
      this.root.append(block);
    }
  }

  select(joint: string | null): void {
    this.selected = joint;
    for (const b of this.root.querySelectorAll<HTMLButtonElement>("button.joint"))
      b.classList.toggle("on", b.dataset.joint === joint);
    for (const d of this.root.querySelectorAll<HTMLDivElement>("div.jointblock"))
      d.hidden = d.dataset.joint !== joint;
    this.onSelect(joint);
  }

  /** Keep the widgets in step with state (a viewer drag, an MCP call, or a reset). */
  sync(): void {
    const clamped = this.state.clamped();
    for (const [joint, axes] of this.rows) {
      for (const [name, widgets] of axes) {
        const v = clamped[joint]?.[name] ?? 0;
        const authored = this.state.get(joint, name);
        widgets.range.value = String(Math.round(v));
        widgets.num.value = String(Math.round(authored));
        widgets.num.classList.toggle("over", Math.round(authored) !== Math.round(v));
      }
    }
  }

  report(solved: SolveResult): string {
    if (solved.adjustments.length === 0)
      return "no corrections — every value was inside its limits";
    return solved.adjustments
      .map(
        a =>
          `${a.joint}.${a.axis}: asked ${a.requested.toFixed(0)}°, applied ${a.applied.toFixed(0)}° — ${a.reason}`,
      )
      .join("\n");
  }
}

function el(tag: string, cls?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}
