import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A page-structure guard, not a rendering test.
 *
 * `main.ts` reaches for its HUD elements with `mustExist(id)`, which throws — and a throw at module scope
 * in a Vite entry point is a white screen with one line in the console. Every other test here is
 * DOM-free on purpose, so this is the one place that checks the two files agree, which is exactly the
 * coupling a browser would otherwise discover for you at the worst moment.
 */
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const html = read("../index.html");
const main = read("../src/main.ts");

const ids = [...main.matchAll(/mustExist\("([\w-]+)"\)/g)].map(m => m[1]!);

describe("index.html ↔ main.ts", () => {
  it("declares every element the entry point requires", () => {
    expect(ids.length).toBeGreaterThan(5);
    const missing = ids.filter(id => !new RegExp(`id="${id}"`).test(html));
    expect(missing).toEqual([]);
  });

  it("has an id for each container the panels build themselves into", () => {
    for (const id of ["panel", "timeline", "clip", "report", "info", "status", "view"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("loads the entry module as a module script under the base-agnostic path", () => {
    expect(html).toContain('<script type="module" src="/src/main.ts"></script>');
    expect(html).toContain('<link rel="stylesheet" href="/src/style.css" />');
  });

  it("keeps the CSS variables the classes reference defined in one place", () => {
    const css = read("../src/style.css");
    const used = new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map(m => m[1]!));
    const defined = new Set([...css.matchAll(/(--[\w-]+):/g)].map(m => m[1]!));
    expect([...used].filter(v => !defined.has(v))).toEqual([]);
    expect(defined.size).toBeGreaterThan(5);
  });
});
