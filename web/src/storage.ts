import { AUTOSAVE_KEY, type ProjectStore } from "./store.js";

/**
 * Persistence, §7.6: autosave plus a real file. Two mechanisms because they answer different fears —
 * autosave is for "the browser ate my work on reload", the file is for "I want this clip next month, on
 * another machine, in version control".
 *
 * Autosave is debounced and silent on success. It is deliberately *not* a safety net for undo: the
 * history lives in memory only, and pretending otherwise would promise more than it delivers.
 */

export interface RestoreReport {
  readonly restored: boolean;
  readonly warnings: readonly string[];
  readonly error: string | null;
  readonly savedAt: number | null;
}

type Saved = { json: string; savedAt: number };

const readSaved = (): Saved | null => {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    return typeof rec.json === "string"
      ? { json: rec.json, savedAt: Number(rec.savedAt) || 0 }
      : null;
  } catch {
    // A quota error or a corrupt row must not take the studio down; the file route still works.
    return null;
  }
};

/** Load whatever the last session left, if anything. Reports what the file could not honour. */
export function restoreAutosave(store: ProjectStore): RestoreReport {
  const saved = readSaved();
  if (!saved) return { restored: false, warnings: [], error: null, savedAt: null };
  const res = store.restoreFrom(saved.json);
  return { restored: res.ok, warnings: res.warnings, error: res.error, savedAt: saved.savedAt };
}

/**
 * Debounced write-behind. `ms` is generous on purpose: the frame counter changes 60 times a second while
 * playing, and localStorage is synchronous, so saving the playhead per frame would jank the viewport.
 */
export function attachAutosave(store: ProjectStore, ms = 600): () => void {
  // ReturnType, not `number`: `setTimeout` is Node's in this workspace's type universe and its handle is
  // an object, so the browser-flavoured annotation would not compile.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  const flush = (): void => {
    timer = undefined;
    if (!dirty) return;
    dirty = false;
    try {
      localStorage.setItem(
        AUTOSAVE_KEY,
        JSON.stringify({ json: store.snapshot(), savedAt: Date.now() }),
      );
    } catch {
      /* full or blocked: nothing to do but keep working; the user still has save-to-file */
    }
  };
  const unsub = store.subscribe(() => {
    dirty = true;
    if (timer === undefined) timer = setTimeout(flush, ms);
  });
  return () => {
    unsub();
    if (timer !== undefined) clearTimeout(timer);
    flush();
  };
}

export function downloadProject(store: ProjectStore): string {
  const name = store.clip.name.trim().replace(/[^\w.-]+/g, "_") || "clip";
  const text = store.snapshot();
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.rigpilot.json`;
  a.click();
  // Revoke on the next task so the download has had a chance to start (Safari ignores an instant revoke).
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return a.download;
}

/** One file picker, resolved to its text. Null if the user cancels — which is not an error. */
export function pickProjectFile(): Promise<{ name: string; text: string } | null> {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        input.remove();
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        input.remove();
        resolve({ name: file.name, text: typeof reader.result === "string" ? reader.result : "" });
      });
      reader.addEventListener("error", () => {
        input.remove();
        resolve(null);
      });
      reader.readAsText(file);
    });
    document.body.append(input);
    input.click();
  });
}
