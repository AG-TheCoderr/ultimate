import type { ProjectStore } from "../store.js";
import { button, el, numberInput, textInput, toast } from "../ui.js";

/**
 * Clip settings, undo/redo and the activity log.
 *
 * The log is here from M2 rather than M3 because it is the same list for both: every mutation goes
 * through `ProjectStore.applyEdit`, which appends to it, so by the time an agent is wired up there is
 * nothing to add — the entries are already labelled "who changed what".
 *
 * File operations live in the top bar now. They used to be here, in the bottom-right corner of a page
 * whose only other contents are a ruler and a history list, which is not where someone looks when they
 * are worried about losing work.
 */
export class ClipPanel {
  private readonly nameInput: HTMLInputElement;
  private readonly fpsInput: HTMLInputElement;
  private readonly framesInput: HTMLInputElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly historyList: HTMLElement;
  private readonly logList: HTMLElement;
  private unsub: (() => void) | null = null;

  constructor(
    private readonly store: ProjectStore,
    root: HTMLElement,
    private readonly onMessage: (text: string) => void,
  ) {
    root.innerHTML = "";
    const head = el("h2", undefined, "clip settings");
    const help = el(
      "p",
      "fineprint",
      "Everything here is undoable, and a shorter clip pulls its keys in rather than deleting them.",
    );
    const rows = el("div", "cliprows");

    this.nameInput = textInput("shown in the tab title and used as the file name when you save");
    this.nameInput.addEventListener("change", () => this.apply({ name: this.nameInput.value }));
    this.fpsInput = numberInput(
      "frames per second. 30 is the default; 24 and 60 are also legal. Changing fps changes how fast it plays, not what is keyed",
      1,
      240,
    );
    this.fpsInput.addEventListener("change", () =>
      this.apply({ fps: Number(this.fpsInput.value) }),
    );
    this.framesInput = numberInput(
      "frames per loop. Shortening scales the keys down with it; nothing is deleted",
      2,
      10000,
    );
    this.framesInput.addEventListener("change", () =>
      this.apply({ frameCount: Number(this.framesInput.value) }),
    );

    rows.append(
      field("name", this.nameInput),
      field("fps", this.fpsInput),
      field("frames", this.framesInput),
    );

    const histRow = el("div", "bar");
    this.undoButton = button("↶ undo", "undo the last change (Ctrl+Z)", () =>
      this.step(() => this.store.undo(), "nothing left to undo"),
    );
    this.redoButton = button("↷ redo", "redo what you undid (Ctrl+Shift+Z)", () =>
      this.step(() => this.store.redo(), "nothing to redo"),
    );
    histRow.append(this.undoButton, this.redoButton);

    this.historyList = el("ul", "history");
    this.logList = el("ul", "activity");
    this.logList.setAttribute("aria-live", "polite");

    root.append(
      head,
      help,
      rows,
      histRow,
      section(
        "what happened",
        this.logList,
        "every edit in order, newest first — this is also the agent's log",
      ),
      section(
        "undo history",
        this.historyList,
        "click a step to see it; the list is in memory only, not in the file",
      ),
    );
    this.unsub = store.subscribe(() => this.sync());
    this.sync();
  }

  private apply(settings: Parameters<ProjectStore["setSettings"]>[0]): void {
    const report = this.store.setSettings(settings);
    const text = [...report.changed, ...report.warnings].join(" · ");
    if (text !== "") {
      this.onMessage(text);
      if (report.warnings.length > 0) toast(report.warnings.join(" · "), "bad");
    }
  }

  private step(step: () => string | null, empty: string): void {
    const label = step();
    this.onMessage(label ?? empty);
    toast(label ?? empty, label === null ? "info" : "ok");
  }

  sync(): void {
    const clip = this.store.clip;
    if (document.activeElement !== this.nameInput) this.nameInput.value = clip.name;
    if (document.activeElement !== this.fpsInput) this.fpsInput.value = String(clip.fps);
    if (document.activeElement !== this.framesInput)
      this.framesInput.value = String(clip.frameCount);
    this.undoButton.disabled = !this.store.canUndo();
    this.redoButton.disabled = !this.store.canRedo();
    this.undoButton.title = this.undoButton.disabled
      ? "nothing left to undo — history starts when the page opens"
      : "undo the last change (Ctrl+Z)";
    this.redoButton.title = this.redoButton.disabled
      ? "nothing was undone yet"
      : "redo what you undid (Ctrl+Shift+Z)";

    const steps = this.store.historyLabels;
    this.historyList.replaceChildren(
      ...steps
        .slice()
        .reverse()
        .map(s => {
          const li = el("li", s.current ? "on" : undefined);
          li.textContent = `${s.index} · ${s.label}`;
          li.title = `step ${s.index} of ${steps.length - 1} — the clip now holds revision ${clip.revision}`;
          return li;
        }),
    );

    this.logList.replaceChildren(
      ...this.store.log.map(entry => {
        const li = el("li");
        const strong = el("strong", undefined, entry.label);
        const when = el("span", "when", clock(entry.when));
        const bits = [
          ...entry.report.changed,
          ...entry.report.adjustments.map(
            a =>
              `clamped ${a.joint}.${a.axis} ${a.requested.toFixed(0)}° → ${a.applied.toFixed(0)}°`,
          ),
          ...entry.report.warnings,
        ];
        const detail = el("span", "why", bits.length > 0 ? bits.join(" · ") : "no adjustments");
        li.append(strong, when, detail);
        if (entry.report.adjustments.length > 0 || entry.report.warnings.length > 0) {
          li.classList.add("adjusted");
        }
        li.title = `revision ${entry.revision} — ${bits.length} note(s)`;
        return li;
      }),
    );
  }

  destroy(): void {
    this.unsub?.();
    this.unsub = null;
  }
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

function section(title: string, body: HTMLElement, note: string): HTMLElement {
  const wrap = el("div", "section");
  wrap.append(el("h3", undefined, title), el("p", "fineprint", note), body);
  return wrap;
}

function field(name: string, control: HTMLInputElement): HTMLElement {
  const l = el("label", "ctl");
  l.textContent = name;
  l.append(control);
  return l;
}
