import { downloadProject, lastAutosaveAt, pickProjectFile } from "../storage.js";
import type { ProjectStore } from "../store.js";
import { button, el, toast } from "../ui.js";

/**
 * The top bar: what this is, whether the work is saved, and the file operations.
 *
 * Save and Open lived in the bottom-right dock, where a person who just lost an hour of posing looks
 * least. They are here now, next to a live "saved 12:04:31" readout, because the honest answer to "is my
 * work safe?" has to be visible without opening a menu. The connection badge is also here — M3 fills its
 * text — so the relay's state reads as part of the app rather than as a panel bolted on later.
 */
export class TopBar {
  private readonly saved: HTMLElement;
  private readonly badge: HTMLElement;
  private unsub: (() => void) | null = null;

  constructor(
    private readonly store: ProjectStore,
    root: HTMLElement,
    private readonly onHelp: () => void,
  ) {
    root.innerHTML = "";

    const brand = el("div", "brand");
    brand.append(
      el("h1", undefined, "RigPilot"),
      el("span", "tag", "pose a humanoid · key it · play it"),
    );

    const actions = el("div", "bar actions");
    actions.append(
      button(
        "▶ Wave demo",
        "key three poses across the clip and play them — the quickest way to see what this does",
        () => this.onMessage(this.store.waveDemo()),
        "primary",
      ),
      button("Random pose", "fill every joint with a legal random value (R)", () =>
        this.store.randomizePose(),
      ),
      button("Reset pose", "back to the rest pose (0 on every slider)", () =>
        this.store.resetPose(),
      ),
      button(
        "?",
        "how this works — the three moves, the one rule, every shortcut",
        () => this.onHelp(),
        "help",
      ),
    );

    const fileRow = el("div", "bar filerow");
    this.saved = el("span", "saved");
    this.saved.setAttribute("role", "status");
    fileRow.append(
      button("Save .json", "download this clip as a project file you can keep or send", () => {
        const name = downloadProject(this.store);
        toast(`saved ${name}`, "ok");
      }),
      button(
        "Open…",
        "load a *.rigpilot.json project (or just drag it onto this page)",
        () => void this.open(),
      ),
      button("New clip", "empty timeline — undo brings the current one back", () => {
        this.store.newClip();
        toast("new empty clip (Ctrl+Z brings the old one back)", "info");
      }),
      this.saved,
    );

    this.badge = el("span", "badge off", "agent: not connected (M3)");
    this.badge.title =
      "M3 adds a local relay: Claude Code or Codex drives this page over MCP, and every call lands in the activity log below the timeline";

    root.append(brand, actions, fileRow, this.badge);
    this.unsub = store.subscribe(() => this.sync());
    this.sync();
  }

  private onMessage(report: { warnings: readonly string[]; changed: readonly string[] }): void {
    const text = [...report.changed, ...report.warnings].join(" · ");
    toast(text === "" ? "nothing changed" : text, text === "" ? "info" : "bad");
  }

  private async open(): Promise<void> {
    const file = await pickProjectFile();
    if (!file) {
      toast("open cancelled", "info");
      return;
    }
    const res = this.store.restoreFrom(file.text);
    if (!res.ok) {
      toast(`${file.name}: ${res.error ?? "could not be read"}`, "bad");
      return;
    }
    toast(
      `opened ${file.name} · ${this.store.clip.name}, ${this.store.clip.frameCount} frames` +
        (res.warnings.length > 0 ? ` — ${res.warnings.join(" · ")}` : ""),
      res.warnings.length > 0 ? "bad" : "ok",
    );
  }

  sync(): void {
    const at = lastAutosaveAt();
    this.saved.textContent =
      at === null
        ? "not saved yet — autosaves as you work"
        : `saved locally ${new Date(at).toLocaleTimeString()}`;
    this.saved.classList.toggle("pending", at === null);
  }

  /** M3 calls this with the relay's state; the shape is here now so the layout does not move later. */
  setConnected(connected: boolean, detail = ""): void {
    this.badge.textContent = connected
      ? `agent: connected ${detail}`.trim()
      : "agent: not connected (M3)";
    this.badge.classList.toggle("off", !connected);
    this.badge.classList.toggle("on", connected);
  }

  destroy(): void {
    this.unsub?.();
    this.unsub = null;
  }
}
