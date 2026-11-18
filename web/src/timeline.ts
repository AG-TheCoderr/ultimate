import { lastFrame, type EaseMode } from "@rigpilot/core";
import type { ProjectStore } from "./store.js";
import { dropdown, el, numberInput, toast } from "./ui.js";

/**
 * Transport + ruler + key markers.
 *
 * The strip is DOM, not canvas: a key marker needs a tooltip that lists what is keyed there, needs to be
 * clickable, needs to stay crisp at any zoom, and now needs to be draggable to retime a pose — all things
 * a `<button>` gives for free and a canvas makes you rebuild. The playhead is one transform, so scrubbing
 * stays cheap.
 *
 * Everything reads the store and writes back through it; there is no local copy of the frame number, which
 * is what lets an MCP call, a slider, the space bar and a drag all move the same playhead.
 *
 * Copy rule for this file: labels are what a person would say ("Key pose", "Loop"), never what the data
 * model calls them. The rig-facing words stay one hover away in the tooltip, because they are what an
 * agent call and a project file use.
 */

const EASES: readonly EaseMode[] = ["auto", "linear", "step", "ease_in", "ease_out", "ease_in_out"];

const EASE_HELP: Readonly<Record<EaseMode, string>> = {
  auto: "smooth, and never overshoots the pose you keyed",
  linear: "constant speed between keys — mechanical, good for a turn",
  step: "hold each pose until the next one — snappy, good for a pose-to-pose take",
  ease_in: "leave slowly, arrive fast",
  ease_out: "leave fast, arrive slowly",
  ease_in_out: "slow at both ends",
};

export class Timeline {
  private readonly ruler: HTMLElement;
  private readonly ticks: HTMLElement;
  private readonly marks: HTMLElement;
  private readonly playhead: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly frameInput: HTMLInputElement;
  private readonly total: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly easeSelect: HTMLSelectElement;
  private readonly keyButton: HTMLButtonElement;
  private readonly loopBox: HTMLInputElement;
  private dragging = false;
  /** Set while a marker drag is in progress, so the click that follows it does not also seek. */
  private retiming: { from: number; to: number; moved: boolean } | null = null;
  private unsub: (() => void) | null = null;

  constructor(
    private readonly store: ProjectStore,
    root: HTMLElement,
    private readonly onMessage: (text: string) => void,
  ) {
    root.innerHTML = "";
    const bar = el("div", "transport");
    this.playButton = el("button", "tbtn play");
    this.playButton.addEventListener("click", () => store.toggle());
    this.keyButton = el("button", "tbtn key");
    this.keyButton.textContent = "◆ key pose";
    this.keyButton.addEventListener("click", () => this.keyHere());

    bar.append(
      this.playButton,
      button("⏮", "go to the first frame (Home)", () => store.setFrame(0)),
      button("◀ key", "previous key (Shift + left arrow)", () => store.jumpKey(-1)),
      button("key ▶", "next key (Shift + right arrow)", () => store.jumpKey(1)),
    );

    const frameBox = el("span", "framebox");
    this.frameInput = numberInput("type a frame number to jump to it", 0, lastFrame(store.clip));
    this.frameInput.className = "frame";
    this.frameInput.addEventListener("input", () => store.setFrame(Number(this.frameInput.value)));
    this.total = el("span", "total");
    frameBox.append(el("span", "axisname", "frame"), this.frameInput, this.total);

    this.loopBox = document.createElement("input");
    this.loopBox.type = "checkbox";
    this.loopBox.setAttribute("aria-label", "loop the clip");
    this.loopBox.title = "play the end back into the start — the last key's ease governs the seam";
    this.loopBox.addEventListener("change", () => this.setLoop(this.loopBox.checked));
    const loop = el("label", "ctl chk");
    loop.append(el("span", undefined, "loop"), this.loopBox);
    loop.title = "play the end back into the start";
    const ease = dropdown(EASES, "how the animation moves between two keys");
    this.easeSelect = ease;
    ease.addEventListener("change", () => {
      say(this.onMessage, store.setEaseEverywhere(ease.value as EaseMode));
    });
    const easeBox = el("label", "ctl");
    easeBox.append(el("span", undefined, "ease out of this key"), ease);
    easeBox.title = Object.entries(EASE_HELP)
      .map(([k, v]) => `${k} — ${v}`)
      .join("\n");

    bar.append(
      frameBox,
      loop,
      easeBox,
      this.keyButton,
      button(
        "✕ unkey",
        "delete this frame's keys — the selected joints if you have any (Shift + K)",
        () => say(this.onMessage, store.unkeyPose()),
      ),
    );

    this.ruler = el("div", "ruler");
    this.ruler.tabIndex = 0;
    this.ruler.setAttribute("role", "slider");
    this.ruler.setAttribute(
      "aria-label",
      "timeline — drag to scrub, click a diamond to jump to that key",
    );
    this.ticks = el("div", "ticks");
    this.marks = el("div", "marks");
    this.playhead = el("div", "playhead");
    this.empty = el("p", "empty");
    this.ruler.append(this.ticks, this.marks, this.playhead, this.empty);
    this.wireScrub(this.ruler);

    root.append(bar, this.ruler);
    this.unsub = store.subscribe(() => this.sync());
    this.sync();
  }

  private keyHere(): void {
    const report = this.store.keyPose();
    if (report.changed.length === 0 && report.warnings.length > 0) {
      toast(report.warnings.join(" · "), "bad");
      this.onMessage(report.warnings.join(" · "));
      return;
    }
    toast(`${report.changed.length} channel(s) keyed at frame ${this.store.frame}`, "ok");
    this.onMessage([...report.changed, ...report.warnings].join(" · "));
  }

  private setLoop(v: boolean): void {
    const r = this.store.setSettings({ loop: v });
    if (v && r.warnings.length === 0)
      toast("loop on — the last key eases back into the first", "info");
    else if (r.warnings.length > 0) say(this.onMessage, r);
  }

  private wireScrub(ruler: HTMLElement): void {
    const at = (e: PointerEvent): number => {
      const box = ruler.getBoundingClientRect();
      const t = (e.clientX - box.left) / Math.max(box.width, 1);
      return t * this.store.clip.frameCount;
    };
    ruler.addEventListener("pointerdown", e => {
      const mark = (e.target as HTMLElement).closest<HTMLButtonElement>("button.mark");
      if (mark && e.shiftKey) {
        // a modifier click is a decision, not the start of a drag
        e.preventDefault();
        say(this.onMessage, this.store.unkeyAt(Number(mark.dataset.frame)));
        return;
      }
      if (mark) {
        // a marker is its own control: press-and-move retimes it, a click seeks, shift-click deletes
        this.retiming = {
          from: Number(mark.dataset.frame),
          to: Number(mark.dataset.frame),
          moved: false,
        };
        ruler.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      this.dragging = true;
      ruler.setPointerCapture(e.pointerId);
      this.store.setFrame(at(e));
    });
    ruler.addEventListener("pointermove", e => {
      if (this.retiming) {
        const box = ruler.getBoundingClientRect();
        const t = (e.clientX - box.left) / Math.max(box.width, 1);
        const to = Math.round(t * (this.store.clip.frameCount - 1));
        if (to !== this.retiming.to) {
          this.retiming = { ...this.retiming, to, moved: true };
          // live preview without touching the store: a drag that gets abandoned must not have edited keys
          const preview = this.marks.querySelector<HTMLButtonElement>("button.mark.preview");
          preview?.classList.remove("preview");
          const mark = this.marks.querySelector<HTMLButtonElement>(
            `button.mark[data-frame="${this.retiming.from}"]`,
          );
          mark?.classList.add("preview");
          if (mark)
            mark.style.left = `${(to / Math.max(this.store.clip.frameCount - 1, 1)) * 100}%`;
        }
        return;
      }
      if (this.dragging) this.store.setFrame(at(e));
    });
    const end = (e: PointerEvent): void => {
      this.dragging = false;
      const drag = this.retiming;
      this.retiming = null;
      if (ruler.hasPointerCapture(e.pointerId)) ruler.releasePointerCapture(e.pointerId);
      if (drag && drag.moved && drag.to !== drag.from) {
        say(this.onMessage, this.store.retimeKey(drag.from, drag.to));
      } else if (drag) {
        this.store.setFrame(drag.from);
      }
    };
    ruler.addEventListener("pointerup", end);
    ruler.addEventListener("pointercancel", end);
  }

  sync(): void {
    const clip = this.store.clip;
    const count = clip.frameCount;
    const last = lastFrame(clip);
    const frame = this.store.frame;
    if (document.activeElement !== this.frameInput) this.frameInput.value = String(frame);
    this.frameInput.max = String(last);
    const playing = this.store.playing;
    this.playButton.textContent = playing ? "⏸ pause" : "▶ play";
    this.playButton.title = playing ? "pause (space)" : "play (space)";
    this.playButton.setAttribute("aria-pressed", playing ? "true" : "false");
    this.total.textContent = `of ${last} · ${(frame / clip.fps).toFixed(2)} s`;
    this.keyButton.textContent = "◆ key pose";
    this.keyButton.title =
      "stamp the pose on screen onto a key at this frame — everything selected, or everything you have moved";

    // ticks: a label every few frames, denser for short clips so a 12-frame cycle is still readable
    const step = count <= 16 ? 1 : count <= 48 ? 4 : count <= 120 ? 10 : Math.round(count / 12);
    this.ticks.replaceChildren();
    for (let f = 0; f <= last; f += step) {
      const tick = el("span", f % (step * 2) === 0 ? "tick major" : "tick");
      tick.style.left = `${(f / (count - 1 || 1)) * 100}%`;
      if (f % (step * 2) === 0) tick.textContent = String(f);
      tick.title = `frame ${f} · ${(f / clip.fps).toFixed(2)} s`;
      this.ticks.append(tick);
    }

    // markers, one per keyed frame, titled with what lives there
    const selected = new Set(this.store.selected);
    const byFrame = new Map<number, string[]>();
    for (const [joint, track] of Object.entries(clip.jointKeys)) {
      for (const k of track ?? []) {
        const list = byFrame.get(k.frame) ?? [];
        list.push(joint);
        byFrame.set(k.frame, list);
      }
    }
    for (const k of clip.rootKeys) {
      const list = byFrame.get(k.frame) ?? [];
      list.push("root");
      byFrame.set(k.frame, list);
    }
    this.marks.replaceChildren();
    for (const [f, joints] of [...byFrame.entries()].sort((a, b) => a[0] - b[0])) {
      const mark = el(
        "button",
        selected.size && joints.some(j => selected.has(j)) ? "mark sel" : "mark",
      );
      mark.type = "button";
      mark.dataset.frame = String(f);
      mark.textContent = `◆${f}`;
      mark.style.left = `${(f / (count - 1 || 1)) * 100}%`;
      mark.title =
        `${joints.length} channel(s) keyed at frame ${f} (${(f / clip.fps).toFixed(2)} s)\n` +
        joints.join(", ") +
        "\n\ndrag sideways to move this key · click to jump here · shift-click to delete";
      // click stays for keyboard activation (detail 0); the pointer path above owns the drag
      mark.addEventListener("click", e => {
        if ((e as MouseEvent).detail !== 0) return;
        this.store.setFrame(f);
      });
      this.marks.append(mark);
    }

    const total = byFrame.size;
    this.empty.textContent =
      total === 0
        ? "no keys yet — pose the body, then press ◆ key pose (K). Do it on frame 0 and again at frame 20 and something will move between them."
        : "";
    this.empty.hidden = total !== 0;

    this.playhead.style.left = `${(frame / (count - 1 || 1)) * 100}%`;
    this.playhead.classList.toggle("past", frame >= last);
    this.playhead.title = `frame ${frame} of ${last}`;
    if (this.loopBox.checked !== clip.loop) this.loopBox.checked = clip.loop;
    this.playButton.setAttribute("aria-label", playing ? "pause" : "play");
    this.keyButton.setAttribute("aria-label", "key this pose at the current frame");
    this.keyButton.title = `stamp the pose on screen onto a key at frame ${frame} — the selected joints, or every joint you have moved (K)`;
    this.ruler.setAttribute("aria-valuenow", String(frame));
    this.ruler.setAttribute("aria-valuemin", "0");
    this.ruler.setAttribute("aria-valuemax", String(last));
    if (document.activeElement !== this.easeSelect)
      this.easeSelect.value = this.easeAt(frame) ?? "auto";
  }

  private easeAt(frame: number): EaseMode | null {
    const clip = this.store.clip;
    for (const track of Object.values(clip.jointKeys)) {
      const k = (track ?? []).find(x => x.frame === frame);
      if (k) return k.ease;
    }
    return clip.rootKeys.find(k => k.frame === frame)?.ease ?? null;
  }

  destroy(): void {
    this.unsub?.();
    this.unsub = null;
  }
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "tbtn");
  b.textContent = text;
  b.title = title;
  b.setAttribute("aria-label", text.replace(/[^\w ]/g, "").trim() || title.split(" ")[0]!);
  b.addEventListener("click", onClick);
  return b;
}

function say(
  onMessage: (t: string) => void,
  report: { warnings: readonly string[]; changed: readonly string[] },
): void {
  const text = [...report.changed, ...report.warnings].join(" · ");
  onMessage(text === "" ? "nothing changed" : text);
  if (report.warnings.length > 0) toast(report.warnings.join(" · "), "bad");
}
