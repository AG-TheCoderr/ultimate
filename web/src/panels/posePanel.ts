import {
  describePoseIssues,
  type AxisName,
  type ClipSample,
  type HumanoidRig,
  type RigJoint,
  type SolveResult,
} from "@rigpilot/core";
import {
  axisVerb,
  labelsFor,
  nounFor,
  POSE_PRESETS,
  poseableJoints,
  type JointLabel,
} from "../labels.js";
import type { ProjectStore } from "../store.js";
import { button, el, numberInput, range, toast } from "../ui.js";

/**
 * Joint picker + one slider per semantic DoF.
 *
 * The slider range IS the authored limit, so an illegal value is not merely warned about — it cannot be
 * expressed (VISION §6: "impossible poses are impossible"). The numeric box next to it can go past the
 * limit on purpose: that path shows the `adjusted` report, which is the same report an MCP call returns,
 * so a human sees what the agent sees.
 *
 * Two things here exist for people rather than for the spec. First, the rig's own names
 * (`shoulder_R.side`) are what an agent must send, and what a project file stores — so they stay visible,
 * in a `<code>` tag and in every tooltip, while the row label says "raise arm sideways". Second, M2's
 * auto-key rule is stated in the block it applies to: "this joint is keyed on frame 12 — moving a slider
 * writes a key here". Without that line, editing a keyed pose looks like it did nothing to a newcomer.
 */
export class PosePanel {
  private readonly joints: RigJoint[];
  private readonly labels = new Map<string, JointLabel>();
  private rows = new Map<string, Map<AxisName, Row>>();
  private selected: string | null = null;
  /** The last thing a slider write refused to do, shown once in the report so it is not lost. */
  private notes: readonly string[] = [];
  private readonly filter: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly keying: HTMLElement;
  private readonly heading: HTMLElement;

  constructor(
    private readonly rig: HumanoidRig,
    private readonly store: ProjectStore,
    private readonly root: HTMLElement,
    private readonly onSelect: (joint: string | null) => void,
  ) {
    this.joints = poseableJoints(rig);
    for (const l of labelsFor(rig)) this.labels.set(l.name, l);

    root.innerHTML = "";

    // ── presets ──────────────────────────────────────────────────────────────────────────────
    const presets = el("div", "presets");
    presets.append(el("h2", "head", "start from a pose"));
    const chips = el("div", "chips");
    for (const p of POSE_PRESETS) {
      const b = button(p.human, p.note, () => {
        const notes = this.store.applyPreset(p);
        if (notes.length > 0) {
          toast(`${p.human}: ${notes.join(" · ")}`, "bad");
          return;
        }
        toast(
          Object.keys(p.joints).length === 0
            ? "back to the rest pose — nothing on the timeline changed"
            : `${p.human} — nothing is keyed yet, so press K if you want to keep it`,
          "ok",
        );
      });
      b.classList.add("chip");
      chips.append(b);
    }
    presets.append(chips);
    presets.append(
      el(
        "p",
        "fineprint",
        "A preset moves joints only — it never invents a key. Nothing on screen changes the clip until you key it.",
      ),
    );

    // ── the list ─────────────────────────────────────────────────────────────────────────────
    const head = el("div", "list-head");
    this.filter = document.createElement("input");
    this.filter.type = "search";
    this.filter.placeholder = "find a joint… (elbow, hip, neck)";
    this.filter.setAttribute("aria-label", "filter the joint list");
    this.filter.addEventListener("input", () => this.applyFilter());
    head.append(
      this.filter,
      button("✕", "clear the selection and the filter (Esc)", () => {
        this.filter.value = "";
        this.applyFilter();
        this.select(null);
      }),
    );
    this.list = el("div", "jointlist");
    this.buildList();
    this.list.addEventListener("keydown", e => this.onListKeys(e));

    // ── the selected joint ────────────────────────────────────────────────────────────────────
    this.heading = el("div", "sel-head");
    this.keying = el("p", "keying");
    const block = el("div", "sel-body");
    block.append(this.heading, this.keying, ...this.buildRows());

    root.append(presets, head, this.list, el("hr"), block);
    this.applyFilter();
  }

  private buildList(): void {
    this.list.replaceChildren();
    let group: string | null = null;
    for (const j of this.joints) {
      const label = this.labelOf(j);
      if (label.group !== group) {
        group = label.group;
        this.list.append(el("h3", "group", group));
      }
      const b = el("button", "joint");
      b.type = "button";
      b.dataset.joint = j.name;
      b.dataset.hay = `${j.name} ${label.human} ${label.group}`.toLowerCase();
      b.textContent = label.human;
      b.title = this.jointTitle(j, label);
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => this.select(j.name));
      this.list.append(b);
    }
  }

  private buildRows(): HTMLElement[] {
    const out: HTMLElement[] = [];
    this.rows = new Map();
    for (const j of this.joints) {
      const block = el("div", "jointblock");
      block.dataset.joint = j.name;
      block.hidden = true;
      const axes = j.kind === "root" ? [] : j.axes;
      const noun = nounFor(j);
      for (const a of axes) {
        const row = el("label", "axisrow");
        const name = el("span", "axisname");
        name.append(el("strong", undefined, axisVerb(noun, a.name)), el("code", undefined, a.name));
        const slider = range(
          this.jointTitle(j, this.labelOf(j)) + `\n${a.positiveMeans}`,
          a.min,
          a.max,
        );
        slider.dataset.joint = j.name;
        slider.dataset.axis = a.name;
        const num = numberInput(
          `type a value. Past ${a.max} or below ${a.min} the app clamps it and says so`,
          a.min - a.graze[0],
          a.max + a.graze[1],
        );
        num.dataset.joint = j.name;
        num.dataset.axis = a.name;
        const hint = el("span", "hint");
        // both halves are worth saying, and every axis in this rig has a graze band, so they cannot be an
        // either/or — that would hide the double-click gesture from everyone
        hint.textContent =
          `${a.positiveMeans} · ${a.min}…${a.max}°` +
          (a.graze[0] || a.graze[1]
            ? ` · the solver may graze to ${a.min - a.graze[0]}…${a.max + a.graze[1]}°`
            : "") +
          " · double-click to return to 0°";
        const set = (deg: number): void => {
          this.notes = this.store.setAxis(j.name, a.name, deg);
        };
        slider.addEventListener("input", () => set(Number(slider.value)));
        num.addEventListener("input", () => set(Number(num.value)));
        // double-click to zero is the gesture every animator expects and never had to be learned
        for (const box of [slider, num]) {
          box.addEventListener("dblclick", () => {
            set(0);
            toast(`${axisVerb(noun, a.name)} — back to 0°`, "info");
          });
        }
        row.append(name, slider, num, hint);
        block.append(row);
        let m = this.rows.get(j.name);
        if (!m) this.rows.set(j.name, (m = new Map<AxisName, Row>()));
        m.set(a.name, { slider, num, hint });
      }
      const foot = el("div", "block-foot");
      foot.append(
        button(
          "◆ Key this pose",
          `write the ${this.labelOf(j).human} pose on screen as a key at the current frame`,
          () => this.reportEdit(this.store.keyJoint(j.name)),
        ),
        button(
          "⧉ Copy values",
          "copy this joint's degrees, to paste to the agent or into a project file",
          () => void this.copy(j),
        ),
      );
      if (axes.length === 0 && j.kind === "endSite")
        foot.append(el("p", "fineprint", this.labelOf(j).note));
      block.append(foot);
      out.push(block);
    }
    return out;
  }

  /**
   * The report a human sees is the report an agent gets: clamped values from `adjusted[]`, plus a
   * complaint for any name the rig does not have. Both are in one place so the two paths cannot drift.
   */
  report(solved: SolveResult): string {
    const lines = [
      ...this.notes,
      ...solved.adjustments.map(
        a =>
          `${this.humanOf(a.joint)}.${a.axis}: asked ${a.requested.toFixed(0)}°, applied ${a.applied.toFixed(0)}° — ${a.reason}`,
      ),
      ...describePoseIssues(this.rig, solved),
    ];
    return lines.length ? lines.join("\n") : "no corrections — every value was inside its limits";
  }

  /** The same text for an edit report, so a button press is never silent. */
  private reportEdit(r: { changed: readonly string[]; warnings: readonly string[] }): void {
    const text = [...r.changed, ...r.warnings].join(" · ");
    toast(text === "" ? "nothing changed" : text, text === "" ? "info" : "bad");
  }

  private async copy(j: RigJoint): Promise<void> {
    const values = this.store.sample().pose.joints?.[j.name] ?? {};
    const text = JSON.stringify({ joints: { [j.name]: values } }, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      toast(`copied ${this.humanOf(j.name)} as set_key_pose JSON`, "ok");
    } catch {
      // clipboard permission denied (or http): show it instead of claiming a copy happened
      toast(`clipboard blocked — ${text.replace(/\s+/g, " ")}`, "bad");
    }
  }

  humanOf(joint: string): string {
    const l = this.labels.get(joint);
    return l ? `${l.human} (${joint})` : joint;
  }

  private labelOf(j: RigJoint): JointLabel {
    return (
      this.labels.get(j.name) ?? {
        name: j.name,
        human: j.name,
        group: "Core",
        note: `parent: ${j.parent ?? "—"}`,
        informative: j.axes.length === 0,
      }
    );
  }

  private jointTitle(j: RigJoint, label: JointLabel): string {
    if (j.kind === "root") return `${label.human} · ${j.name} · free translation + heading`;
    return [
      `${label.human} — ${j.name}`,
      label.note,
      ...j.axes.map(a => `${a.name}: ${a.min}…${a.max}° — ${a.positiveMeans}`),
    ].join("\n");
  }

  private applyFilter(): void {
    const q = this.filter.value.trim().toLowerCase();
    let shown = 0;
    for (const b of this.list.querySelectorAll<HTMLButtonElement>("button.joint")) {
      const hit = q === "" || (b.dataset.hay ?? "").includes(q);
      b.hidden = !hit;
      if (hit) shown++;
    }
    // hide a heading whose group filtered out entirely, and the "nothing matches" line otherwise
    for (const h of this.list.querySelectorAll<HTMLElement>("h3.group")) {
      const next = h.nextElementSibling;
      let anyVisible = false;
      for (let n = next; n && n.tagName !== "H3"; n = n.nextElementSibling) {
        const b = n as HTMLButtonElement;
        if (b.tagName === "BUTTON" && !b.hidden) anyVisible = true;
      }
      h.hidden = !anyVisible;
    }
    let empty = this.list.querySelector<HTMLElement>("p.empty");
    if (shown === 0) {
      if (!empty) {
        empty = el("p", "empty");
        this.list.append(empty);
      }
      empty.textContent = `no joint matches “${this.filter.value}” — try arm, leg, knee, spine`;
    } else empty?.remove();
  }

  /** ↑/↓ in the list, so a whole body can be walked without leaving the keyboard. */
  private onListKeys(e: KeyboardEvent): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const visible = [...this.list.querySelectorAll<HTMLButtonElement>("button.joint")].filter(
      b => !b.hidden,
    );
    if (visible.length === 0) return;
    e.preventDefault();
    const at = visible.findIndex(b => b.dataset.joint === this.selected);
    const step = e.key === "ArrowDown" ? 1 : -1;
    const next = visible[Math.min(Math.max(at + step, 0), visible.length - 1)]!;
    next.focus();
    this.select(next.dataset.joint ?? null);
  }

  select(joint: string | null): void {
    this.selected = joint;
    for (const b of this.list.querySelectorAll<HTMLButtonElement>("button.joint")) {
      const on = b.dataset.joint === joint;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
    for (const d of this.root.querySelectorAll<HTMLDivElement>("div.jointblock")) {
      d.hidden = d.dataset.joint !== joint;
    }
    const sel = joint ? this.rig.joints.find(j => j.name === joint) : undefined;
    if (sel) {
      const label = this.labelOf(sel);
      this.heading.replaceChildren(
        el("h2", undefined, label.human),
        el("code", "rigid", sel.name),
        el("p", "fineprint", label.note),
      );
      const block = this.root.querySelector<HTMLDivElement>(
        `div.jointblock[data-joint="${sel.name}"]`,
      );
      block?.scrollIntoView({ block: "nearest" });
      this.list
        .querySelector<HTMLButtonElement>(`button.joint[data-joint="${sel.name}"]`)
        ?.scrollIntoView({
          block: "nearest",
        });
    } else {
      this.heading.replaceChildren(
        el("h2", undefined, "Nothing selected"),
        el(
          "p",
          "fineprint",
          "Click the body, or a name above, to pose a joint. Shift-click adds one to the selection.",
        ),
      );
    }
    this.onSelect(joint);
  }

  /** Put the caret in the filter — what "Start from a pose instead" in the help panel asks for. */
  focusFilter(): void {
    this.filter.focus();
    this.filter.select();
  }

  /**
   * Keep the widgets in step with the sampled pose. `all` is false during playback, when only the
   * selected joint's block is on screen and 40 DOM writes a frame buys nothing.
   */
  sync(sample: ClipSample, all = true): void {
    const keyed = new Set(sample.keyed.joints);
    for (const b of this.list.querySelectorAll<HTMLButtonElement>("button.joint")) {
      const name = b.dataset.joint ?? "";
      b.classList.toggle("keyed", keyed.has(name));
    }
    this.keying.textContent = this.keyingLine(sample.frame, keyed);
    for (const [joint, axes] of this.rows) {
      if (!all && joint !== this.selected) continue;
      const values = sample.pose.joints?.[joint];
      for (const [name, widgets] of axes) {
        const v = values?.[name] ?? 0;
        widgets.slider.value = String(Math.round(v));
        widgets.num.value = String(Math.round(v));
        widgets.slider.setAttribute(
          "aria-valuetext",
          `${Math.round(v)} degrees, range ${widgets.slider.min} to ${widgets.slider.max}`,
        );
        widgets.num.classList.toggle(
          "over",
          sample.solved.adjustments.some(a => a.joint === joint && a.axis === name),
        );
      }
    }
  }

  /**
   * The sentence that makes M2's auto-key rule visible where it bites. Only the selected joint's own
   * channel is read: this runs every frame while playing, and walking every channel to decorate a block
   * nobody is looking at is how a 60 fps viewer stops being one (§15).
   */
  private keyingLine(frame: number, keyedAnywhere: ReadonlySet<string>): string {
    if (!this.selected) return "";
    const track = this.store.clip.jointKeys[this.selected] ?? [];
    const keyedHere = new Set(track.map(k => k.frame));
    if (keyedHere.has(frame)) {
      return `keyed at frame ${frame} — moving a slider writes a key here. Shift+← / Shift+→ step between keys.`;
    }
    if (keyedAnywhere.has(this.selected)) {
      return `this joint has keys, but none at frame ${frame} — moving a slider adds one here.`;
    }
    return "not keyed yet — your changes stay a scratch pose (saved, undoable as a pose) until you press ◆ Key this pose.";
  }
}

interface Row {
  readonly slider: HTMLInputElement;
  readonly num: HTMLInputElement;
  readonly hint: HTMLElement;
}
