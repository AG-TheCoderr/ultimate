import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Page-structure guards, not rendering tests.
 *
 * `main.ts` reaches for its HUD elements with `mustExist(id)`, which throws — and a throw at module scope
 * in a Vite entry point is a white screen with one line in the console. Every other test in this folder is
 * DOM-free on purpose, so this is the one place that checks the two sides agree, which is exactly the
 * coupling a browser would otherwise discover for you at the worst moment.
 *
 * The reverse direction is checked too (an id nobody reads is dead markup, and markup nobody reads drifts),
 * along with the handful of affordances the UI is required to provide: an accessible name on every button,
 * a live region for the status and the report, a no-JS message, a small-screen layout, a focus ring, and a
 * reduced-motion branch. These are cheap to assert as text and expensive to notice as a user.
 */
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const html = read("../index.html");
const css = read("../src/style.css");

/** Every TS file the studio ships — panels, store, three/, entry point. Walked, not globbed: no new dep. */
function sources(): string {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const at = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(at);
      else if (e.name.endsWith(".ts")) out.push(readFileSync(at, "utf8"));
    }
  };
  walk(root);
  return out.join("\n");
}
const src = sources();

describe("index.html ↔ the modules that fill it", () => {
  it("declares every element an entry point or panel reaches for", () => {
    const wanted = [
      ...[...src.matchAll(/mustExist\("([\w-]+)"\)/g)].map(m => m[1]!),
      ...[...src.matchAll(/getElementById\("([\w-]+)"\)/g)].map(m => m[1]!),
    ];
    // both directions matter: a missing container white-screens the page, and a silently-absent one (the
    // toast host) turns feedback into nothing at all, so the scans themselves have to be non-empty
    expect(wanted.length).toBeGreaterThan(8);
    const missing = [...new Set(wanted)].filter(id => !new RegExp(`id="${id}"`).test(html));
    expect(missing).toEqual([]);
  });

  it("has no id that nothing reads", () => {
    const declared = [...html.matchAll(/id="([\w-]+)"/g)].map(m => m[1]!);
    expect(declared.length).toBeGreaterThan(8);
    const orphans = declared.filter(
      id => !src.includes(`"${id}"`) && !new RegExp(`#${id}\\b`).test(css),
    );
    expect(orphans).toEqual([]);
  });

  it("loads the entry module as a module script under the base-agnostic path", () => {
    expect(html).toContain('<script type="module" src="/src/main.ts"></script>');
    expect(html).toContain('<link rel="stylesheet" href="/src/style.css" />');
  });

  it("says something when JavaScript cannot run, and to whom the page is a studio", () => {
    // a regex and not a literal, because prettier reflows the tag onto two lines and a
    // formatter must never be able to break an assertion simply by tidying the markup
    expect(html).toMatch(/<noscript[\s>]/);
    expect(html).toContain('name="description"');
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(html).toContain('lang="en"');
  });

  it("keeps the readouts in a live region so a screen reader hears them", () => {
    for (const id of ["status", "report", "toasts"]) {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*aria-live`));
    }
    expect(html).toMatch(/id="views"[^>]*role="group"/);
  });
});

describe("the shared DOM layer", () => {
  it("gives every button an accessible name from the same sentence as its tooltip", () => {
    const ui = read("../src/ui.ts");
    expect(ui).toContain('setAttribute("aria-label", plain(title))');
    // one helper, so no panel can forget: the files must not re-implement their own <button> maker
    for (const f of ["timeline", "panels/posePanel", "panels/clipPanel", "panels/topBar"]) {
      const text = read(`../src/${f}.ts`);
      expect(text, `${f} builds buttons another way`).not.toContain(
        `document.createElement("button")`,
      );
    }
  });

  it("has a toast host in the document and never throws without one", () => {
    expect(css).toContain(".toasts {");
    expect(src).toContain('const TOAST_ID = "toasts"');
    expect(src).toMatch(/if \(!host[\s\S]{0,80}return/);
  });
});

describe("the stylesheet the UI depends on", () => {
  it("keeps the layout the panels assume", () => {
    expect(css).toContain("grid-template-areas");
    for (const area of ['"top top"', '"side stage"', '"side dock"']) expect(css).toContain(area);
    expect(css).toContain("#dock {");
  });

  it("styles every affordance the code builds", () => {
    for (const need of [
      ".ruler {",
      ".playhead {",
      ".transport {",
      "button.mark {",
      "button.mark.preview {",
      "ul.activity {",
      ".jointlist {",
      ".modal {",
      ".scrim {",
      ".toast {",
      ".chips {",
      ".keying {",
      ".badge {",
      "body.dropping",
    ]) {
      expect(css, `style.css lost ${need}`).toContain(need);
    }
  });

  it("keeps the CSS variables the classes reference defined in one place", () => {
    const used = new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1]!));
    const defined = new Set([...css.matchAll(/(--[\w-]+):/g)].map(m => m[1]!));
    expect([...used].filter(v => !defined.has(v))).toEqual([]);
    expect(defined.size).toBeGreaterThan(5);
  });

  it("is usable on a phone, by keyboard, and with reduced motion", () => {
    expect(css).toMatch(/@media \(max-width: 860px\)/);
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    // touch: 26 px is the smallest thing a thumb hits reliably, and the sliders are the primary control
    expect(css).toMatch(/button,\s*input,\s*select \{\s*min-height: 26px;/);
  });

  it("never leaves the raw rig name as the only label in the joint list", () => {
    // the human name on the button, the rig id in a <code> and in the title — both, always
    const panel = read("../src/panels/posePanel.ts");
    expect(panel).toContain("b.textContent = label.human");
    expect(panel).toContain('el("code", "rigid", sel.name)');
    expect(panel).toContain("b.title = this.jointTitle(j, label)");
  });
});
