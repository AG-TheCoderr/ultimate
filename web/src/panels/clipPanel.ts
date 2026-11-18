import { downloadProject, pickProjectFile } from "../storage.js";
import { AUTOSAVE_KEY, type ProjectStore } from "../store.js";

/**
 * Clip settings, file I/O, undo/redo and the activity log.
 *
 * The log is here from M2 rather than M3 because it is the same list for both: every mutation goes
 * through `ProjectStore.applyEdit`, which appends to it, so by the time an agent is wired up there is
 * nothing to add — the entries are already labelled "who changed what".
 */
export class ClipPanel {
  private readonly nameInput: HTMLInputElement;
  private readonly fpsInput: HTMLInputElement;
  private readonly framesInput: HTMLInputElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly historyList: HTMLElement;
  private readonly logList: HTMLElement;
  private readonly savedAt: HTMLElement;
  private unsub: (() => void) | null = null;

  constructor(
    private readonly store: ProjectStore,
    root: HTMLElement,
    private readonly onMessage: (text: string) => void,
  ) {
    root.innerHTML = "";
    const head = el("h2");
    head.textContent = "clip";
    const rows = el("div", "cliprows");

    this.nameInput = input("text", "clip name — becomes the file name on download");
    this.nameInput.addEventListener("change", () => this.apply({ name: this.nameInput.value }));
    this.fpsInput = input(
      "number",
      "frames per second. 30 is the default; 24 and 60 are also legal",
    );
    this.fpsInput.min = "1";
    this.fpsInput.max = "240";
    this.fpsInput.step = "1";
    this.fpsInput.addEventListener("change", () =>
      this.apply({ fps: Number(this.fpsInput.value) }),
    );
    this.framesInput = input(
      "number",
      "frames per loop. Shortening pulls keys in; nothing is deleted",
    );
    this.framesInput.min = "2";
    this.framesInput.step = "1";
    this.framesInput.addEventListener("change", () =>
      this.apply({ frameCount: Number(this.framesInput.value) }),
    );

    rows.append(
      field("name", this.nameInput),
      field("fps", this.fpsInput),
      field("frames", this.framesInput),
    );

    const fileRow = el("div", "bar");
    fileRow.append(
      button("save .json", "download this clip as a *.rigpilot.json project file", () => {
        this.onMessage(`downloaded ${downloadProject(this.store)}`);
      }),
      button("open…", "load a *.rigpilot.json file", () => void this.open()),
      button("new clip", "empty the timeline (undoable)", () => {
        this.store.newClip();
        this.onMessage("new empty clip — undo brings the old one back");
      }),
    );

    const histRow = el("div", "bar");
    this.undoButton = button("undo", "undo the last change (ctrl+z)", () =>
      this.onMessage(this.store.undo() ?? "nothing to undo"),
    );
    this.redoButton = button("redo", "redo (ctrl+shift+z)", () =>
      this.onMessage(this.store.redo() ?? "nothing to redo"),
    );
    this.savedAt = el("span", "saved");
    histRow.append(this.undoButton, this.redoButton, this.savedAt);

    this.historyList = el("ul", "history");
    this.logList = el("ul", "activity");

    root.append(
      head,
      rows,
      fileRow,
      histRow,
      section("history", this.historyList),
      section("activity log", this.logList),
    );
    this.unsub = store.subscribe(() => this.sync());
    this.sync();
  }

  private apply(settings: Parameters<ProjectStore["setSettings"]>[0]): void {
    const report = this.store.setSettings(settings);
    const text = [...report.changed, ...report.warnings].join(" · ");
    if (text !== "") this.onMessage(text);
  }

  private async open(): Promise<void> {
    const file = await pickProjectFile();
    if (!file) {
      this.onMessage("open cancelled");
      return;
    }
    const res = this.store.restoreFrom(file.text);
    if (!res.ok) {
      this.onMessage(`${file.name}: ${res.error ?? "could not be read"}`);
      return;
    }
    const warnings = res.warnings.length > 0 ? ` — ${res.warnings.join(" · ")}` : "";
    this.onMessage(
      `loaded ${file.name} (${this.store.clip.name}, ${this.store.clip.frameCount} frames)${warnings}`,
    );
  }

  sync(): void {
    const clip = this.store.clip;
    if (document.activeElement !== this.nameInput) this.nameInput.value = clip.name;
    if (document.activeElement !== this.fpsInput) this.fpsInput.value = String(clip.fps);
    if (document.activeElement !== this.framesInput)
      this.framesInput.value = String(clip.frameCount);
    this.undoButton.disabled = !this.store.canUndo();
    this.redoButton.disabled = !this.store.canRedo();

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
        const strong = el("strong");
        strong.textContent = entry.label;
        const bits = [
          ...entry.report.changed.map(c => c),
          ...entry.report.adjustments.map(
            a =>
              `clamped ${a.joint}.${a.axis} ${a.requested.toFixed(0)}° → ${a.applied.toFixed(0)}°`,
          ),
          ...entry.report.warnings.map(w => w),
        ];
        const detail = el("span", "why");
        detail.textContent = bits.length > 0 ? bits.join(" · ") : "ok";
        li.append(strong, detail);
        return li;
      }),
    );

    const saved = readAutosaveStamp();
    this.savedAt.textContent =
      saved === null ? "not saved yet" : `autosaved ${new Date(saved).toLocaleTimeString()}`;
  }

  destroy(): void {
    this.unsub?.();
    this.unsub = null;
  }
}

/** The autosave stamp lives in the same key storage.ts writes; reading it here keeps the panel honest. */
function readAutosaveStamp(): number | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: number };
    return typeof parsed.savedAt === "number" ? parsed.savedAt : null;
  } catch {
    return null;
  }
}

function el(tag: string, cls?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function section(title: string, body: HTMLElement): HTMLElement {
  const wrap = el("div", "section");
  const h = el("h3");
  h.textContent = title;
  wrap.append(h, body);
  return wrap;
}

function input(type: "text" | "number", title: string): HTMLInputElement {
  const i = document.createElement("input");
  i.type = type;
  i.title = title;
  return i;
}

function field(name: string, control: HTMLInputElement): HTMLElement {
  const l = el("label", "ctl");
  l.textContent = name;
  l.append(control);
  return l;
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "tbtn";
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}
