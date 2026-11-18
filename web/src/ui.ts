/**
 * The small DOM layer every panel builds on, plus the toast channel.
 *
 * The panels used to each carry their own `el`/`button` helpers, which is how a focus ring or an
 * `aria-label` ends up in one panel and not the others. `button()` here always sets an accessible name
 * from the same string as the tooltip, so a screen reader and a hover can't disagree.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K];
export function el(tag: string, cls?: string, text?: string): HTMLElement;
export function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function button(
  text: string,
  title: string,
  onClick: () => void,
  cls = "tbtn",
): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = text;
  b.title = title;
  b.setAttribute("aria-label", plain(title));
  b.addEventListener("click", onClick);
  return b;
}

export function label(text: string, control: HTMLElement, cls = "ctl"): HTMLElement {
  const l = el("label", cls);
  l.textContent = text;
  l.append(control);
  return l;
}

export function range(title: string, min: number, max: number, step = 1): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "range";
  i.min = String(min);
  i.max = String(max);
  i.step = String(step);
  i.value = "0";
  i.title = title;
  return i;
}

export function numberInput(
  title: string,
  min: number,
  max: number,
  step = 1,
  value = 0,
): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "number";
  i.min = String(min);
  i.max = String(max);
  i.step = String(step);
  i.value = String(value);
  i.title = title;
  return i;
}

export function textInput(title: string, value = ""): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "text";
  i.value = value;
  i.title = title;
  return i;
}

export function check(
  text: string,
  read: () => boolean,
  write: (v: boolean) => void,
  title?: string,
): HTMLElement {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = read();
  box.setAttribute("aria-label", text);
  if (title) box.title = title;
  box.addEventListener("change", () => write(box.checked));
  const l = label(text, box, "ctl chk");
  if (title) l.title = title;
  return l;
}

export function dropdown(options: readonly string[], title: string): HTMLSelectElement {
  const s = document.createElement("select");
  s.title = title;
  s.setAttribute("aria-label", plain(title));
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o;
    opt.textContent = o;
    s.append(opt);
  }
  return s;
}

/** A tooltip is prose; an accessible name should not be a whole sentence with punctuation in it. */
function plain(title: string): string {
  const first = title.split(/[.—:]/)[0] ?? title;
  return first.trim();
}

// ── toasts ───────────────────────────────────────────────────────────────────────────────────────

export type ToastKind = "ok" | "bad" | "info";

const TOAST_ID = "toasts";
const LIVE_MS = 3200;
const STACK = 3;

/**
 * Transient feedback for the things that currently only appear in the status line: a save, a refused
 * edit, an undo. The status HUD stays the permanent readout; this is the "I heard you" channel, so a
 * click that did something is never indistinguishable from one that did nothing (§15, no silent
 * failures). The container is optional on purpose — the module is imported by tests that have no DOM.
 */
export function toast(text: string, kind: ToastKind = "info"): void {
  const host = document.getElementById(TOAST_ID);
  if (!host || typeof document.createElement === "undefined") return;
  const note = el("div", `toast ${kind}`, text);
  note.addEventListener("click", () => note.remove());
  host.append(note);
  while (host.children.length > STACK) host.firstElementChild?.remove();
  setTimeout(() => note.classList.add("fade"), LIVE_MS);
  setTimeout(() => note.remove(), LIVE_MS + 500);
}
