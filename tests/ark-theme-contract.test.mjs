import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const ARK_CSS = "themes/ark/theme.css";

function createThemeContext(storedTheme) {
  const attributes = new Map();
  const storedValues = new Map([["wildtoken_theme", storedTheme]]);
  const elements = new Map();
  const createElement = () => {
    const elementAttributes = new Map();
    const element = {
      getAttribute: (name) => elementAttributes.get(name) ?? null,
      setAttribute: (name, value) => elementAttributes.set(name, String(value)),
      parentNode: null,
      remove: () => {
        if (element.id) elements.delete(element.id);
        element.parentNode = null;
      },
    };
    return element;
  };
  const document = {
    documentElement: {
      getAttribute: (name) => attributes.get(name) ?? null,
      removeAttribute: (name) => attributes.delete(name),
      setAttribute: (name, value) => attributes.set(name, String(value)),
    },
    createElement,
    getElementById: (id) => elements.get(id) ?? null,
    head: {
      appendChild: (element) => {
        element.parentNode = document.head;
        if (element.id) elements.set(element.id, element);
      },
    },
    querySelector: () => null,
  };
  const localStorage = {
    getItem: (name) => storedValues.get(name) ?? null,
    removeItem: (name) => storedValues.delete(name),
    setItem: (name, value) => storedValues.set(name, String(value)),
  };

  return {
    attributes,
    storedValues,
    context: vm.createContext({ document, localStorage }),
  };
}

/** 预绘制脚本是纯 JS 且要在 React 之前跑，所以能在 vm 里真执行。 */
function prePaintScript() {
  const html = read("web/index.html");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "index.html must include its pre-paint theme script");
  return script;
}

test("pre-paint boot preserves a stored Ark selection", () => {
  const { attributes, context } = createThemeContext("ark");
  vm.runInContext(prePaintScript(), context, { filename: "console-prepaint.js" });

  assert.equal(attributes.get("data-theme"), "ark");
  assert.equal(attributes.get("data-ark-theme"), "ark");
  assert.equal(attributes.get("data-ark-depth"), "complex");
});

test("pre-paint boot gives Endfield the same complex family contract", () => {
  const { attributes, context } = createThemeContext("endfield");
  vm.runInContext(prePaintScript(), context, { filename: "console-prepaint.js" });

  assert.equal(attributes.get("data-theme"), "endfield");
  assert.equal(attributes.get("data-ark-theme"), "endfield");
  assert.equal(attributes.get("data-ark-depth"), "complex");
});

/* applyTheme lives in TypeScript, which this runner cannot execute, so the
   runtime half is pinned at the source level: the two attributes must be set
   for the complex family and removed for everything else. Dropping the else
   branch would leave a stale data-ark-depth behind after switching away. */
test("runtime selection keeps the Ark root contract in both directions", () => {
  const source = read("web/src/theme.ts");
  const applyTheme = source.slice(source.indexOf("export function applyTheme"));
  const branch = applyTheme.slice(0, applyTheme.indexOf("const css ="));

  assert.match(branch, /resolved === "ark" \|\| resolved === "endfield"/);
  assert.match(branch, /setAttribute\("data-ark-theme", resolved\)/);
  assert.match(branch, /setAttribute\("data-ark-depth", "complex"\)/);
  assert.match(branch, /removeAttribute\("data-ark-theme"\)/);
  assert.match(branch, /removeAttribute\("data-ark-depth"\)/);
});

test("pre-paint boot clears the Ark root contract for other themes", () => {
  const { attributes, context } = createThemeContext("light");
  vm.runInContext(prePaintScript(), context, { filename: "console-prepaint.js" });

  assert.equal(attributes.get("data-theme"), "light");
  assert.equal(attributes.get("data-ark-theme"), undefined);
  assert.equal(attributes.get("data-ark-depth"), undefined);
});

test("pre-paint boot falls back when a stored theme pack has been removed", () => {
  for (const theme of ["sakura-mist", "anthropic", "anthropic-dark"]) {
    const { attributes, context, storedValues } = createThemeContext(theme);
    storedValues.set("wildtoken_theme_css_id", theme);
    storedValues.set("wildtoken_theme_css", `/theme-packs/${theme}/theme.css`);
    vm.runInContext(prePaintScript(), context, { filename: "console-prepaint.js" });

    assert.equal(attributes.get("data-theme"), "dark", `${theme} should fall back to dark`);
    assert.equal(attributes.get("data-theme-pack-css"), undefined, `${theme} CSS should not load`);
  }
});

/* 主操作只认显式的 .primary（5639f9c）。以前是「所有按钮刷成主操作，再用
   button:not(:where(...)) 白名单把导航、排序、分段控件摘出来」，漏登记一项就
   多一块实心色块。现在不该再有那种全局规则。 */
test("Ark paints only explicit primary actions as primary", () => {
  const css = read(ARK_CSS);
  assert.doesNotMatch(css, /button:not\(:where\(/, "a global primary-action rule is back");
  assert.match(css, /html\[data-theme="ark"\] button\.primary\s*\{/);
  assert.match(css, /html\[data-theme="ark"\] button\.primary:hover\s*\{/);
});

test("Ark's shared button geometry does not override inline utility-control sizing or type", () => {
  const css = read(ARK_CSS);
  const sharedButtonRule = css.match(/html\[data-theme="ark"\] button\s*\{([\s\S]*?)\n\}/);

  assert.ok(sharedButtonRule, "Ark must define a shared button geometry rule");
  assert.doesNotMatch(sharedButtonRule[1], /(?:font-weight|letter-spacing|min-height)\s*:/, "inline controls retain their component-owned type and dimensions");
});

test("Ark keyboard focus remains visible when a control also owns an active-state shadow", () => {
  const css = read(ARK_CSS);
  const focusRule = css.match(/html\[data-theme="ark"\] button:focus-visible,[\s\S]*?html\[data-theme="ark"\] summary:focus-visible\s*\{([\s\S]*?)\n\}/);

  assert.ok(focusRule, "Ark must define a shared keyboard-focus rule");
  assert.match(focusRule[1], /outline:\s*2px solid var\(--ark-signal\)/, "focus cannot rely only on a box shadow that selected controls replace");
  assert.match(focusRule[1], /outline-offset:\s*2px/, "the focus outline needs separation from the active-state edge");
});

test("Ark desktop theme menu opens into the visible content stage from the bottom rail", () => {
  const css = read(ARK_CSS);
  const menuRule = css.match(/html\[data-theme="ark"\] \.theme-menu\s*\{([\s\S]*?)\n\}/);

  assert.ok(menuRule, "Ark must define the desktop theme-menu position");
  assert.match(menuRule[1], /left:\s*calc\(var\(--ark-rail-width\) \+ 12px\)/, "the menu should clear the navigation rail");
  assert.match(menuRule[1], /bottom:\s*0/, "the bottom-rail trigger must anchor the menu upward inside the clipped shell");
  assert.match(menuRule[1], /top:\s*auto/, "the base downward-opening position must be disabled");
});
