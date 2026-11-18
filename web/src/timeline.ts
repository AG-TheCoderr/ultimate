import { lastFrame, type EaseMode } from "@rigpilot/core";
import type { ProjectStore } from "./store.js";

/**
 * Transport + ruler + key markers.
 *
 * The strip is DOM, not canvas: a key marker needs a tooltip that lists what is keyed there, needs to be
 * clickable, and needs to stay crisp at any zoom — all things a `<button>` gives for free and a canvas
 * makes you rebuild. The playhead is one transform, so scrubbing stays cheap.
 *
 * Everything reads the store and writes back through it; there is no local copy of the frame number, which
 * is what lets an MCP call, a slider, the space bar and a drag all move the same playhead.
 */

const EASES: readonly EaseMode[] = ["auto", "linear", "step", "ease_in", "ease_out", "ease_in_out"];

export class Timeline {
  private readonly ruler: HTMLElement;
  private readonly ticks: HTMLElement;
  private readonly marks: HTMLElement;
  private readonly playhead: HTMLElement;
  private readonly frameInput: HTMLInputElement;
  private readonly playButton: HTMLButtonElement;
  private readonly easeSelect: HTMLSelectElement;
  private dragging = false;
  private unsub: (() => void) | null = null;

  constructor(
    private readonly store: ProjectStore,
    root: HTMLElement,
    private readonly onMessage: (text: string) => void,
  ) {
    root.innerHTML = "";
    const bar = el("div", "transport");
    this.playButton = button("▶", "play / pause (space)", () => store.toggle());
    bar.append(
      button("⏮", "go to the first frame", () => store.setFrame(0)),
      button("◀", "previous key (left arrow)", () => store.jumpKey(-1)),
      this.playButton,
      button("⏭", "next key (right arrow)", () => store.jumpKey(1)),
    );
    this.frameInput = num(
      "frame",
      () => store.frame,
      v => store.setFrame(v),
    );
    const total = el("span", "total");
    total.title = "frames in the clip — change it in the clip panel";
    bar.append(this.frameInput, total);
    const loop = chk(
      "loop",
      () => store.clip.loop,
      v => {
        const r = store.setSettings({ loop: v });
        say(this.onMessage, r);
      },
    );
    const ease = select("ease");
    for (const mode of EASES) ease.append(option(mode, mode));
    ease.title =
      "ease for the segment LEAVING the key at the current frame. auto = monotone Catmull-Rom with 3+ keys, linear with 2, never step";
    this.easeSelect = ease;
    bar.append(
      loop,
      label("ease", ease),
      button("key pose", "write the current pose as a key at this frame", () =>
        say(this.onMessage, store.keyPose()),
      ),
      button("unkey", "delete this frame's keys (the selected joints, or all of them)", () =>
        say(this.onMessage, store.unkeyPose()),
      ),
    );
    ease.addEventListener("change", () => {
      say(this.onMessage, store.setEaseEverywhere(ease.value as EaseMode));
    });

    this.ruler = el("div", "ruler");
    this.ticks = el("div", "ticks");
    this.marks = el("div", "marks");
    this.playhead = el("div", "playhead");
    this.ruler.append(this.ticks, this.marks, this.playhead);
    this.wireScrub(this.ruler);

    root.append(bar, this.ruler);
    this.unsub = store.subscribe(() => this.sync());
    this.sync();
  }

  private wireScrub(ruler: HTMLElement): void {
    const at = (e: PointerEvent): number => {
      const box = ruler.getBoundingClientRect();
      const t = (e.clientX - box.left) / Math.max(box.width, 1);
      return t * this.store.clip.frameCount;
    };
    ruler.addEventListener("pointerdown", e => {
      if ((e.target as HTMLElement).closest("button.mark")) return; // a marker click is its own action
      this.dragging = true;
      ruler.setPointerCapture(e.pointerId);
      this.store.setFrame(at(e));
    });
    ruler.addEventListener("pointermove", e => {
      if (this.dragging) this.store.setFrame(at(e));
    });
    const end = (e: PointerEvent): void => {
      this.dragging = false;
      if (ruler.hasPointerCapture(e.pointerId)) ruler.releasePointerCapture(e.pointerId);
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
    this.playButton.textContent = this.store.playing ? "⏸" : "▶";

    // ticks: a label every few frames, denser for short clips so a 12-frame cycle is still readable
    const step = count <= 16 ? 1 : count <= 48 ? 4 : count <= 120 ? 10 : Math.round(count / 12);
    this.ticks.replaceChildren();
    for (let f = 0; f <= last; f += step) {
      const tick = el("span", f % (step * 2) === 0 ? "tick major" : "tick");
      tick.style.left = `${(f / (count - 1 || 1)) * 100}%`;
      if (f % (step * 2) === 0) tick.textContent = String(f);
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
      mark.textContent = String(f);
      mark.style.left = `${(f / (count - 1 || 1)) * 100}%`;
      mark.title = `${joints.join(", ")} @ ${f}\n${joints.length} channel(s) — shift-click to delete this frame's keys`;
      mark.addEventListener("click", e => {
        if (e.shiftKey) say(this.onMessage, this.store.unkeyAt(f, joints));
        else this.store.setFrame(f);
      });
      this.marks.append(mark);
    }

    this.playhead.style.left = `${(frame / (count - 1 || 1)) * 100}%`;
    this.playhead.classList.toggle("past", frame >= last);
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

function say(
  onMessage: (t: string) => void,
  report: { warnings: readonly string[]; changed: readonly string[] },
): void {
  const text = [...report.changed, ...report.warnings].join(" · ");
  onMessage(text === "" ? "nothing changed" : text);
}

function select(cls?: string): HTMLSelectElement {
  const n = document.createElement("select");
  if (cls) n.className = cls;
  return n;
}

function el(tag: string, cls?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "tbtn";
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function option(value: string, text: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  return o;
}

function num(cls: string, read: () => number, write: (v: number) => void): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "number";
  i.className = cls;
  i.min = "0";
  i.step = "1";
  i.value = String(read());
  i.addEventListener("input", () => write(Number(i.value)));
  return i;
}

function label(text: string, control: HTMLElement): HTMLElement {
  const l = el("label", "ctl");
  l.textContent = text;
  l.append(control);
  return l;
}

function chk(text: string, read: () => boolean, write: (v: boolean) => void): HTMLElement {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = read();
  box.addEventListener("change", () => write(box.checked));
  const l = label(text, box);
  l.classList.add("chk");
  return l;
}
