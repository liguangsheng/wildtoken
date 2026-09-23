import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("themes/gojo/theme.json"));
const css = read("themes/gojo/theme.css");
const themeModule = read("web/src/theme.ts");
const consoleHtml = read("web/index.html");

test("Gojo manifest exposes the Limitless palette", () => {
  assert.deepEqual(manifest, {
    id: "gojo",
    label: "五条悟",
    css: "theme.css",
    swatch: ["#070910", "#63dcff"],
    version: "1.0.0",
    description: "Satoru Gojo character theme with a blindfold rail, Six Eyes focus states, and blue-red-violet Limitless fields.",
  });
});

test("Gojo defines a scoped Six Eyes theme without external assets", () => {
  assert.match(css, /html\[data-theme="gojo"\]\s*\{/);
  for (const token of [
    "--bg: #070910;",
    "--panel-solid: #0d101a;",
    "--text: #f7f9ff;",
    "--accent: #63dcff;",
    "--gojo-red: #ff6178;",
    "--gojo-purple: #a983ff;",
  ]) {
    assert.ok(css.includes(token), `missing ${token}`);
  }
  assert.match(css, /\.brand-mark::before[\s\S]*radial-gradient/);
  assert.match(css, /body::before[\s\S]*repeating-radial-gradient/);
  assert.doesNotMatch(css, /url\(["']?https?:/);
});

test("Gojo covers every console view with a distinct domain mark", () => {
  const views = ["dashboard", "upstreams", "logs", "tokens", "groups", "debug", "images", "settings"];
  for (const view of views) {
    assert.match(css, new RegExp(`\\[data-view="${view}"\\]`), `missing ${view}`);
  }
  const marks = [...css.matchAll(/--gojo-view-mark:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.equal(marks.length, views.length);
  assert.equal(new Set(marks).size, views.length);
});

/* The pack has to be registered in two places: the pre-paint script in
   index.html, which runs before React and prevents a flash of the default
   theme, and the runtime registry the theme menu reads. Missing either one
   fails in a way that only shows up in a browser. */
test("Gojo is registered for both pre-paint and runtime theme selection", () => {
  const cssHref = "/theme-packs/gojo/theme.css";
  assert.ok(themeModule.includes(`gojo: "${cssHref}"`), "missing runtime pack entry");
  assert.ok(themeModule.includes('gojo: ["#070910", "#63dcff"]'), "missing swatch");
  assert.ok(consoleHtml.includes(`gojo: "${cssHref}"`), "missing pre-paint entry");
});

test("Gojo keeps the mobile dock stable and honors reduced motion", () => {
  assert.match(css, /grid-template-columns:\s*repeat\(8, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /animation:\s*none !important/);
});

/* The neighbouring packs all set `outline: none` on .status-switch:focus-visible
   without putting anything back, which leaves the toggle invisible to a keyboard
   user. This pack moves the ring onto the track instead, and that is easy to
   undo by copying a block from another theme — so it is pinned here. */
test("Gojo gives the status switch a keyboard focus indicator", () => {
  const rule = css.match(
    /\.status-switch:focus-visible \.status-switch-track \{[^}]+\}/,
  );
  assert.ok(rule, "the switch track has no :focus-visible rule");
  assert.match(rule[0], /border-color: var\(--focus\)/);
  assert.match(rule[0], /box-shadow:/);

  // The switch itself may drop its outline only because the track carries it.
  const stripped = css.match(/\.status-switch:focus-visible \{[^}]+\}/);
  assert.ok(stripped, "expected an explicit :focus-visible rule on the switch");
});

test("Gojo renders the log view picker as a themed segmented control", () => {
  assert.match(css, /\.log-view-mode \{[\s\S]*?background:[\s\S]*?#070a12;[\s\S]*?padding: 3px;[\s\S]*?\}/);
  assert.match(css, /\.log-view-mode-button\[aria-pressed="true"\][\s\S]*?linear-gradient\(135deg/);
  assert.match(css, /\.log-view-mode-button:focus-visible \{[\s\S]*?box-shadow: var\(--focus-ring\)/);

  const primaryButtonSelectors = [...css.matchAll(/button:not\(:where\(([\s\S]*?)\)\)(?=[^{]*\{)/g)];
  assert.ok(primaryButtonSelectors.length > 0, "expected Gojo primary-button selectors");
  for (const [, exclusions] of primaryButtonSelectors) {
    assert.match(exclusions, /\.log-view-mode-button/, "log mode leaked into the primary-button treatment");
  }
});
