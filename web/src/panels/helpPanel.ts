import { button, el } from "../ui.js";

/**
 * The one-time explanation, and the help that stays available after that.
 *
 * This is not decoration. The rule the studio cannot do without — a joint the clip already keyed edits by
 * *writing a key*, a joint nobody keyed edits a scratch pose that only becomes durable when you key it —
 * is invisible in the UI unless someone says it, and it is exactly the thing a first-timer gets wrong.
 * VISION §1 requires the studio to be fully usable by a human without AI, so the explanation is part of
 * the deliverable, and `?` brings it back.
 *
 * Shown once per browser (`localStorage`), then on demand. Dismissing is not a decision the user has to
 * remember the key for: `?` and the button in the top bar both open it.
 */

const SEEN_KEY = "rigpilot.help.seen.v1";

export class HelpPanel {
  private readonly box: HTMLElement;
  private readonly scrim: HTMLElement;
  private isOpen = false;
  private restoreFocusTo: HTMLElement | null = null;

  constructor(
    root: HTMLElement,
    private readonly actions: {
      onWave: () => void;
      onPickPreset: () => void;
    },
  ) {
    root.innerHTML = "";
    this.scrim = el("div", "scrim");
    this.scrim.hidden = true;
    this.box = el("div", "modal");
    this.box.setAttribute("role", "dialog");
    this.box.setAttribute("aria-modal", "true");
    this.box.setAttribute("aria-labelledby", "help-title");
    this.box.append(this.content());
    this.scrim.append(this.box);
    this.scrim.addEventListener("click", e => {
      if (e.target === this.scrim) this.close();
    });
    root.append(this.scrim);
    window.addEventListener("keydown", this.onKey);
  }

  /** True when nothing has ever dismissed this panel, i.e. the first visit. */
  static isFirstVisit(): boolean {
    try {
      return localStorage.getItem(SEEN_KEY) === null;
    } catch {
      return false; // storage blocked (private mode): better to stay quiet than to nag forever
    }
  }

  static markSeen(): void {
    try {
      localStorage.setItem(SEEN_KEY, "seen");
    } catch {
      /* nothing to do */
    }
  }

  private content(): DocumentFragment {
    const frag = document.createDocumentFragment();

    const head = el("div", "modal-head");
    const title = el("h2", undefined, "RigPilot in three moves");
    title.id = "help-title";
    head.append(
      title,
      button("close", "close this (Esc)", () => this.close(), "close"),
    );
    frag.append(head);

    frag.append(
      el(
        "p",
        "lede",
        "Pose a humanoid body, put those poses on a timeline, and play it. The app enforces what a body " +
          "can do — a knee or an elbow is a hinge and cannot bend backwards — so nothing you key here is " +
          "physically impossible. The same door serves an AI agent over MCP, so what you see is exactly " +
          "what it asked for.",
      ),
    );

    const steps = el("ol", "steps");
    for (const [n, t] of [
      [
        "1",
        [
          "Pick a joint",
          "Click the body in the 3D view, or use the list on the left — type in its box to narrow it to “elbow”. Left side is blue, right side is red, seen from the character's point of view.",
        ],
      ],
      [
        "2",
        [
          "Move a slider",
          "The slider's ends ARE the joint's limits, so an impossible value cannot be typed into it. The number box next to it goes past the limit on purpose: do that and the line in the bottom right says what the app changed it to and why. Nothing is quietly fixed.",
        ],
      ],
      [
        "3",
        [
          "Key it, then play",
          "Press “◆ Key pose” (or K) to stamp this frame. Shift between frames with ← / →, jump to the next key with Shift + ←/→, Space plays. Everything you do is one Ctrl+Z away.",
        ],
      ],
    ] as const) {
      const li = el("li");
      li.append(
        el("span", "num", n),
        (() => {
          const wrap = el("div");
          wrap.append(el("strong", undefined, t[0]), el("p", undefined, t[1]));
          return wrap;
        })(),
      );
      steps.append(li);
    }
    frag.append(steps);

    const key = el("div", "twocol");
    key.append(
      this.block(
        "The one rule worth knowing",
        "A joint the clip already has keys for is owned by the clip: moving its slider writes a key at " +
          "the frame you are looking at (every animation tool works this way). A joint nobody has keyed " +
          "yet is your scratch pose: it shows on screen and is saved in your browser, but it only joins " +
          "the animation when you key it. A joint in the list with a blue ◆ is clip-owned.",
      ),
      this.block(
        "Keyboard",
        "Space — play / pause · ← → — one frame · Shift + ← → — to the next / previous key · K — key this " +
          "pose · Shift + K — delete this frame's keys · Ctrl+Z / Ctrl+Shift+Z — undo / redo · R — random " +
          "legal pose (a quick way to see the limits bite) · Esc — deselect · ? — this panel",
      ),
    );
    frag.append(key);

    const your = el("div", "twocol");
    your.append(
      this.block(
        "Your work is not lost",
        "The clip autosaves in this browser every second or so, so reloading the page brings back the " +
          "poses, the playhead and the values you dragged out. “Save .json” writes a portable project " +
          "file you can keep or send; “Open” or dragging the file onto the page reads it back.",
      ),
      this.block(
        "Where it fits",
        "This is milestone M2 of the build: rig, posing, timeline and persistence are here. Inverse " +
          "kinematics (put this foot here), the validation report and GLB export for Unity, Godot, " +
          "Unreal and Blender land in M4–M6, and the MCP connection for the agent is M3.",
      ),
    );
    frag.append(your);

    const bar = el("div", "modal-actions");
    bar.append(
      button(
        "▶ Show me: key a 3-pose wave and play it",
        "key three poses across the clip and play them — M2's demo",
        () => {
          this.close();
          this.actions.onWave();
        },
        "primary",
      ),
      button("Start from a pose instead", "close this and open the pose presets", () => {
        this.close();
        this.actions.onPickPreset();
      }),
      button("Just explore", "close this", () => this.close()),
    );
    frag.append(bar);
    return frag;
  }

  private block(title: string, body: string): HTMLElement {
    const box = el("div", "block");
    box.append(el("h3", undefined, title), el("p", undefined, body));
    return box;
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.isOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    } else if (e.key === "Tab") {
      this.keepFocusInside(e);
    }
  };

  /** A modal that lets focus escape is a trap for keyboard users, so ring the buttons instead. */
  private keepFocusInside(e: KeyboardEvent): void {
    const items = [...this.box.querySelectorAll<HTMLElement>("button, input, select, [href]")];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === this.box)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  }

  open(): void {
    this.isOpen = true;
    this.restoreFocusTo =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.scrim.hidden = false;
    this.box.querySelector<HTMLButtonElement>("button.close")?.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.scrim.hidden = true;
    HelpPanel.markSeen();
    this.restoreFocusTo?.focus();
    this.restoreFocusTo = null;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** So the keyboard handler in main.ts can ignore clip shortcuts while the modal has the focus. */
  get showing(): boolean {
    return this.isOpen;
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKey);
  }
}
