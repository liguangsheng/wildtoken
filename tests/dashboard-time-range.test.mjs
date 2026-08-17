import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);

  const asyncPrefix = "async ";
  const declarationStart = source.startsWith(asyncPrefix, start - asyncPrefix.length)
    ? start - asyncPrefix.length
    : start;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(declarationStart, index + 1);
      }
    }
  }

  throw new Error(`could not extract ${name}`);
}

const RANGE_VALUES = ["today", "1d", "3d", "7d", "30d", "all", "default", "custom"];

function dashboardContext(overrides = {}) {
  const source = read("static/js/dashboard.js");
  const context = vm.createContext({
    dashboardTimeRange: "30d",
    dashboardCustomStartDate: null,
    dashboardCustomEndDate: null,
    DASHBOARD_RANGE_VALUES: new Set(RANGE_VALUES),
    DASHBOARD_DEFAULT_RANGE: "30d",
    URLSearchParams,
    ...overrides,
  });
  for (const name of [
    "getTimeRangeLabel",
    "dashboardShowsSingleWindow",
    "dashboardRangeParams",
    "dashboardTopWindowLabel",
  ]) {
    vm.runInContext(extractFunction(source, name), context);
  }
  return context;
}

test("every selectable range has a label", () => {
  const context = dashboardContext();
  for (const value of RANGE_VALUES) {
    context.candidate = value;
    const label = vm.runInContext("getTimeRangeLabel(candidate)", context);
    assert.ok(label && label.length > 0, `${value} needs a label`);
  }
  assert.equal(vm.runInContext('getTimeRangeLabel("default")', context), "所有窗口");
  assert.equal(vm.runInContext('getTimeRangeLabel("3d")', context), "最近 3 天");
});

test("a custom label names the selected dates once they are known", () => {
  const withoutDates = dashboardContext();
  assert.equal(
    vm.runInContext('getTimeRangeLabel("custom")', withoutDates),
    "自定义时间",
  );

  const withDates = dashboardContext({
    dashboardCustomStartDate: "2026-08-01",
    dashboardCustomEndDate: "2026-08-10",
  });
  assert.equal(
    vm.runInContext('getTimeRangeLabel("custom")', withDates),
    "2026-08-01 至 2026-08-10",
  );
});

test("only the comparison range renders multiple windows", () => {
  const context = dashboardContext();
  // Before the fix only custom/all took the single-window branch, so picking
  // 7d changed nothing on screen.
  for (const value of ["today", "1d", "3d", "7d", "30d", "all", "custom"]) {
    context.candidate = value;
    assert.equal(
      vm.runInContext("dashboardShowsSingleWindow(candidate)", context),
      true,
      `${value} must render one aggregated window`,
    );
  }
  assert.equal(
    vm.runInContext('dashboardShowsSingleWindow("default")', context),
    false,
  );
});

test("each range produces its own query parameters", () => {
  const context = dashboardContext();
  const paramsFor = (value) => {
    context.candidate = value;
    return vm.runInContext("dashboardRangeParams(candidate).toString()", context);
  };

  // Distinct query strings are what make the presets actually differ.
  const seen = new Map();
  for (const value of ["today", "1d", "3d", "7d", "30d", "all", "default"]) {
    const query = paramsFor(value);
    assert.equal(query, `range=${value}`);
    assert.ok(!seen.has(query), `${value} duplicates ${seen.get(query)}`);
    seen.set(query, value);
  }
});

test("a custom range sends its bounds, and falls back until they are set", () => {
  const ready = dashboardContext({
    dashboardCustomStartDate: "2026-08-01",
    dashboardCustomEndDate: "2026-08-10",
  });
  ready.candidate = "custom";
  const query = vm.runInContext("dashboardRangeParams(candidate).toString()", ready);
  assert.match(query, /range=custom/);
  assert.match(query, /start_date=2026-08-01/);
  assert.match(query, /end_date=2026-08-10/);

  // Without dates a custom query would be rejected; fall back instead.
  const pending = dashboardContext();
  pending.candidate = "custom";
  assert.equal(
    vm.runInContext("dashboardRangeParams(candidate).toString()", pending),
    "range=30d",
  );
});

test("an unknown range cannot reach the server", () => {
  const context = dashboardContext();
  context.candidate = "last-century";
  assert.equal(
    vm.runInContext("dashboardRangeParams(candidate).toString()", context),
    "range=30d",
  );
});

test("ranking labels cover the ranges the shared control can select", () => {
  const context = dashboardContext({
    dashboardCustomStartDate: "2026-08-01",
    dashboardCustomEndDate: "2026-08-10",
  });
  const labelFor = (value) => {
    context.candidate = value;
    return vm.runInContext("dashboardTopWindowLabel(candidate)", context);
  };

  assert.equal(labelFor("all"), "全部");
  assert.equal(labelFor("custom"), "2026-08-01 至 2026-08-10");
  // Rankings have no multi-window mode; they follow the server's 30d fallback.
  assert.equal(labelFor("default"), "30d");
  for (const value of RANGE_VALUES) {
    assert.ok(labelFor(value).length > 0, `${value} needs a ranking label`);
  }
});

test("the request KPI spark uses the whole card as its hover target", () => {
  const source = read("static/js/dashboard.js");
  const styles = read("static/css/dashboard.css");
  assert.match(source, /card\.addEventListener\("pointerenter"/);
  assert.match(source, /card\.addEventListener\("pointermove"/);
  assert.match(source, /card\.addEventListener\("pointerleave"/);
  assert.doesNotMatch(source, /hoverLayer\.addEventListener\("pointermove"/);
  assert.match(styles, /\.kpi-bg-spark\s*\{[\s\S]*?pointer-events:\s*none;/);
  // tooltip 必须是卡片的直接子节点，不能塞回曲线容器里被数字压住。
  assert.match(source, /class="kpi-spark-tooltip" role="status"/);
  assert.doesNotMatch(source, /class="kpi-spark-hit-layer"/);
});

test("request KPI spark maps pointer X to interpolated bucket data", () => {
  const source = read("static/js/dashboard.js");
  const context = vm.createContext({ KPI_SPARK_VIEW: { width: 100, height: 32 } });
  vm.runInContext(extractFunction(source, "kpiSparkPointAtRatio"), context);
  const point = vm.runInContext(
    "kpiSparkPointAtRatio([10, 30, 50], 0.25)",
    context,
  );
  assert.equal(point.index, 0);
  assert.equal(point.next, 1);
  assert.equal(point.progress, 0.5);
  assert.equal(point.value, 20);
  assert.equal(point.x, 25);

  context.candidate = -1;
  assert.equal(vm.runInContext("kpiSparkPointAtRatio([10, 30, 50], candidate).value", context), 10);
  context.candidate = 2;
  assert.equal(vm.runInContext("kpiSparkPointAtRatio([10, 30, 50], candidate).value", context), 50);
});

test("the dashboard exposes exactly one time control", () => {
  const markup = read("static/admin.html");

  assert.match(markup, /id="dashboard-time-preset"/);
  // The separate ranking-period select was merged into the shared control;
  // reintroducing it would let the two disagree again.
  assert.doesNotMatch(markup, /id="dashboard-top-window"/);
  assert.equal((markup.match(/id="dashboard-time-preset"/g) || []).length, 1);

  // The comparison view has to remain reachable from the dropdown.
  assert.match(markup, /<option value="default">/);
  for (const value of ["today", "1d", "3d", "7d", "30d", "all", "custom"]) {
    assert.match(markup, new RegExp(`<option value="${value}"`), `${value} option missing`);
  }
});

test("the range control lives in the dashboard panel head", () => {
  const markup = read("static/admin.html");
  const panelHead = markup.slice(
    markup.indexOf('<p id="dashboard-scope">'),
    markup.indexOf('aria-labelledby="dashboard-overview-title"'),
  );

  assert.match(panelHead, /id="dashboard-time-preset"/);
  assert.match(panelHead, /id="dashboard-custom-range"/);
});

test("no markup pre-selects a range that JS would then contradict", () => {
  const markup = read("static/admin.html");
  const select = markup.slice(
    markup.indexOf('<select id="dashboard-time-preset"'),
    markup.indexOf("</select>", markup.indexOf('<select id="dashboard-time-preset"')),
  );

  // The restored preference is applied in JS; a hardcoded `selected` here is
  // what made the dropdown disagree with the data being shown.
  assert.doesNotMatch(select, /selected/);
  assert.match(read("static/js/bootstrap.js"), /dashboardTimePreset\.value = dashboardTimeRange/);
});

test("the custom range panel toggles via the hidden attribute", () => {
  const markup = read("static/admin.html");
  const dashboard = read("static/js/dashboard.js");

  assert.match(markup, /id="dashboard-custom-range"[^>]*hidden/);
  assert.doesNotMatch(markup, /id="dashboard-custom-range"[^>]*style="display/);
  assert.match(dashboard, /el\.hidden = false/);
  assert.match(dashboard, /el\.hidden = true/);
});

test("the selected range and its custom dates are persisted", () => {
  const bootstrap = read("static/js/bootstrap.js");
  const events = read("static/js/events.js");

  assert.match(bootstrap, /DASHBOARD_RANGE_KEY = "wildtoken_dashboard_range"/);
  assert.match(bootstrap, /DASHBOARD_CUSTOM_RANGE_KEY/);
  // The old ranking-only preference should carry over rather than be dropped.
  assert.match(bootstrap, /DASHBOARD_TOP_WINDOW_KEY/);
  assert.match(events, /localStorage\.setItem\(DASHBOARD_RANGE_KEY/);
});
