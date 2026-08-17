import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);

  // Keep an `async` keyword: without it the extracted body cannot await.
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

test("upstream action menu distinguishes channel clone and credential copy actions", () => {
  const source = read("static/js/upstreams.js");

  assert.match(source, /data-action="duplicate" data-id="\$\{upstreamId\}">复制渠道<\/button>/);
  assert.match(source, /data-action="copy-info" data-id="\$\{upstreamId\}">复制渠道信息<\/button>/);
  assert.doesNotMatch(source, /data-action="duplicate" data-id="\$\{upstreamId\}">复制<\/button>/);
});

test("upstream credential clipboard text keeps the requested two-line shape", () => {
  const source = read("static/js/upstreams.js");
  const context = vm.createContext({});
  vm.runInContext(extractFunction(source, "formatUpstreamClipboardText"), context);

  const text = vm.runInContext(
    'formatUpstreamClipboardText({ base_url: "https://api.example.com/v1", api_key: "sk-test" })',
    context,
  );

  assert.equal(text, "baseURL: https://api.example.com/v1\napiKey: sk-test");
});

test("fixed weight checkbox maps to the existing dynamic-weight API field", () => {
  const source = read("static/js/upstreams.js");
  const context = vm.createContext({
    fields: {
      name: { value: "fixed" },
      baseUrl: { value: "https://api.example.test/v1" },
      apiKey: { value: "" },
      modelMappings: { value: "{}" },
      modelPrefixes: { value: "" },
      priority: { value: "100" },
      weight: { value: "25" },
      fixedWeightEnabled: { checked: true },
      timeoutSeconds: { value: "300" },
      rateLimit: { value: "" },
      enabled: { checked: true },
      clearApiKey: { checked: false },
    },
    parseHeaderOverrides: () => ({}),
    parseModelMappings: () => ({}),
    getFormModels: () => [],
    splitList: () => [],
    // 分组选择由 groups.js 提供，这里只验证权重字段，给个空选择即可。
    readUpstreamGroupSelection: () => [],
  });
  vm.runInContext(extractFunction(source, "payloadFromForm"), context);

  assert.equal(vm.runInContext("payloadFromForm().auto_weight_enabled", context), false);
  context.fields.fixedWeightEnabled.checked = false;
  assert.equal(vm.runInContext("payloadFromForm().auto_weight_enabled", context), true);
});

test("upstream weight cell uses fixed and effective weight wording", () => {
  const source = read("static/js/upstreams.js");
  const context = vm.createContext({});
  vm.runInContext(extractFunction(source, "formatEffectiveWeight"), context);
  vm.runInContext(extractFunction(source, "isFixedWeight"), context);
  vm.runInContext(extractFunction(source, "weightCellMarkup"), context);

  const fixedMarkup = vm.runInContext(
    "weightCellMarkup({ weight: 80, effective_weight: 12, auto_weight_enabled: false })",
    context,
  );
  assert.match(fixedMarkup, /<strong>80<\/strong>/);
  assert.match(fixedMarkup, /固定权重/);
  assert.doesNotMatch(fixedMarkup, /有效权重 \/ 基础权重/);

  const dynamicMarkup = vm.runInContext(
    "weightCellMarkup({ weight: 80, effective_weight: 0, auto_weight_enabled: true })",
    context,
  );
  assert.match(dynamicMarkup, /<strong>0 \/ 80<\/strong>/);
  assert.match(dynamicMarkup, /有效权重 \/ 基础权重/);
});

test("spark dot compensation cancels the non-uniform viewBox stretch", () => {
  const context = vm.createContext({});
  vm.runInContext(extractFunction(read("static/js/bootstrap.js"), "sparkDotScaleX"), context);
  const scaleFor = (bounds, view) => {
    context.bounds = bounds;
    context.view = view;
    return vm.runInContext("sparkDotScaleX(bounds, view)", context);
  };

  /* 渠道卡片的实际情形：viewBox 100×40 画在 260×48px 上。横向缩放 2.6、
     纵向 1.2，系数应为 1.2/2.6，圆点因此被横向压回圆形。 */
  const channel = scaleFor({ width: 260, height: 48 }, { width: 100, height: 40 });
  assert.ok(Math.abs(channel - (48 / 40) / (260 / 100)) < 1e-9);
  assert.ok(channel < 1, "横向被拉伸时补偿系数必须小于 1");

  // 横纵缩放一致时不需要补偿。
  assert.equal(scaleFor({ width: 200, height: 80 }, { width: 100, height: 40 }), 1);

  // 零尺寸（隐藏子树）不得产生除零或 Infinity。
  assert.ok(Number.isFinite(scaleFor({ width: 0, height: 0 }, { width: 100, height: 40 })));
});

test("the channel sparkline dot applies the shared stretch compensation", () => {
  const source = read("static/js/upstreams.js");
  // 圆点必须带横向反向缩放，且 cx 除以同一系数抵消位移，否则点是椭圆。
  assert.match(source, /const dotScaleX = sparkDotScaleX\(bounds, CHANNEL_SPARK_VIEW\)/);
  assert.match(source, /dot\.setAttribute\("transform", `scale\(\$\{dotScaleX\} 1\)`\)/);
  assert.match(source, /dot\.setAttribute\("cx", x \/ dotScaleX\)/);
  // viewBox 尺寸集中在一处，hover 数学和 SVG 不会各写一套魔数。
  assert.match(source, /const CHANNEL_SPARK_VIEW = \{ width: 100, height: 40 \}/);
});

test("the balance dialog head carries a refresh control", () => {
  const markup = read("static/admin.html");
  const dialog = markup.slice(
    markup.indexOf('<dialog id="balance-dialog"'),
    markup.indexOf('<dialog id="admin-token-dialog"'),
  );

  assert.match(dialog, /id="balance-refresh"/);
  assert.match(dialog, /class="secondary ghost icon-refresh"/);
  assert.match(read("static/js/models.js"), /balanceRefresh\.addEventListener\("click"/);
});

test("a superseded balance query cannot overwrite the newer result", async () => {
  const source = read("static/js/upstreams.js");
  let releaseStale;
  const staleResponse = new Promise((resolve) => {
    releaseStale = () => resolve({ ok: true, remaining_usd: 1 });
  });
  const responses = [staleResponse, Promise.resolve({ ok: true, remaining_usd: 2 })];
  const context = vm.createContext({
    activeBalanceQuery: { provider: "new-api", endpoint: "/api/admin/upstreams/1/balance" },
    balanceQueryToken: 0,
    balanceRefresh: { disabled: false, classList: { toggle() {} } },
    balanceSummary: { textContent: "" },
    balanceBody: { innerHTML: "" },
    api: () => responses.shift(),
    escapeHtml: (value) => value,
    renderBalanceResult: (result) => `remaining:${result.remaining_usd}`,
  });
  vm.runInContext(extractFunction(source, "setBalanceRefreshBusy"), context);
  vm.runInContext(extractFunction(source, "refreshBalance"), context);

  const stale = vm.runInContext("refreshBalance()", context);
  const fresh = vm.runInContext("refreshBalance()", context);
  await fresh;
  releaseStale();
  await stale;

  assert.equal(context.balanceBody.innerHTML, "remaining:2");
  assert.equal(context.balanceSummary.textContent, "查询成功");
  assert.equal(context.balanceRefresh.disabled, false);
});
