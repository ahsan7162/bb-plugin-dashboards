// The components' motion: every animated rule is reachable by the reduced-motion block, and that
// block ships in dist/app.css (npm test builds first; bb's build appends this CSS to app.css).
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const source = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const at = source.indexOf("@media (prefers-reduced-motion: reduce)");
const [main, reduced] = [source.slice(0, at), source.slice(at)];

test("every rule with an animation or transition targets an bbd- element or its ::before/::after, which the reduced-motion block turns off", () => {
  expect(reduced).toMatch(/\[class\*="bbd-"\],\s*\[class\*="bbd-"\]::before,\s*\[class\*="bbd-"\]::after\s*\{\s*animation: none !important;\s*transition: none !important;/);
  const animated = [...main.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, , body]) => /(^|[;\s])(animation|transition)\s*:/.test(body!)).flatMap(([, selectors]) => selectors!.split(",").map((s) => s.trim()));
  expect(animated.length).toBeGreaterThan(20);
  for (const selector of animated) {
    const target = selector.split(/\s+/).at(-1)!; // the element the rule styles
    const pseudo = target.match(/::[\w-]+$/)?.[0];
    const covered = /\.bbd-/.test(target) && (pseudo === undefined || pseudo === "::before" || pseudo === "::after");
    expect(covered || reduced.includes(`${selector} {`), selector).toBe(true);
  }
});

test("one shared set of timings: every duration is one of the --bbd- variables", () => {
  const durations = [...main.matchAll(/(?:animation|transition)\s*:([^;]+);/g)].flatMap(([, value]) => value!.match(/\b\d+m?s\b|var\(--[\w-]+\)/g) ?? []);
  expect(durations.length).toBeGreaterThan(20);
  for (const d of durations) expect(["var(--bbd-enter)", "var(--bbd-exit)", "var(--bbd-quick)", "var(--bbd-ease-out)", "var(--bbd-ease-in)"]).toContain(d);
  expect(main).toMatch(/--bbd-enter: 1[2-9]\dms;\s*--bbd-exit: 1[0-9]\dms;\s*--bbd-quick: 1[0-9]\dms;/);
});

test("shipped: dist/app.css has the components' classes and the reduced-motion block", () => {
  const app = readFileSync(new URL("../../dist/app.css", import.meta.url), "utf8");
  expect(app).toContain(".bbd-drawer");
  expect(app).toContain("@keyframes bbd-drawer-out");
  // Minified: quotes dropped, ::before as :before, declarations in any order.
  const rule = app.match(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{\s*\[class\*=["']?bbd-["']?\],\s*\[class\*=["']?bbd-["']?\]:+before,\s*\[class\*=["']?bbd-["']?\]:+after\s*\{([^}]*)\}/);
  expect(rule?.[1]).toMatch(/animation:\s*none\s*!important/);
  expect(rule?.[1]).toMatch(/transition:\s*none\s*!important/);
});
