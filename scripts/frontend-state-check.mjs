// 隔离浏览器中的状态回归；所有 API 由浏览器内的假响应接管。
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Page, attachPage, launchChrome } from "./browser-check.mjs";
import { addDebugCases } from "./debug-workspace-checks.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const cases = [];
const addCase = (name, run) => cases.push({ name, run });

function installMocks() {
  localStorage.setItem("wildtoken_admin_token", "frontend-state-check-token");
  const caseId = new URL(location.href).searchParams.get("case");
  if (sessionStorage.getItem("debug-test-case") !== caseId) {
    localStorage.removeItem("wildtoken_debug_sessions_v1");
    sessionStorage.setItem("debug-test-case", caseId);
  }
  const channel = {
    id: 1, name: "test-channel", base_url: "http://fake.invalid", enabled: true, archived: false,
    model_names: ["test-model"], model_prefixes: [], model_mappings: {}, effort_mappings: {},
    priority: 100, weight: 100, effective_weight: 100, runtime_health_score: 1,
    auto_weight_enabled: false, api_key_set: false, key_count: 0, enabled_key_count: 0,
    extra_headers: {}, timeout_seconds: 300, rate_limit: null, group_ids: [1],
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", keys: [],
  };
  const state = window.__test = {
    requests: [], holds: [], errors: [], streamConnections: 0,
    channels: [channel, { ...channel, id: 2, name: "test-channel-2" }], imageBody: "null",
    failures: new Set(JSON.parse(new URL(location.href).searchParams.get("fail") ?? "[]")),
    settings: {
      log_body_keep_count: 100, log_retention_days: 30, log_body_max_bytes: 204800,
      max_retries: 2, same_upstream_retry_interval_ms: 100, auto_weight_failure_penalty: 10,
      auto_weight_success_increment: 1, auto_weight_recovery_increment: 5,
      auto_weight_recovery_interval_seconds: 60, proxy_enabled: false, proxy_url: "",
      default_upstream_timeout_seconds: 300, image_storage_max_mb: 1024,
      dashboard_multiplier: 1, revision: 3, updated_at: "2026-01-01T00:00:00Z",
    },
    logs: Array.from({ length: 80 }, (_, index) => {
      const id = 80 - index;
      return {
        id, created_at: new Date(Date.UTC(2026, 0, 1) + id * 1000).toISOString(), method: "POST", path: "/v1/responses",
        upstream_id: id % 2 + 1, upstream_name: `channel-${id % 2}`, upstream_key_id: 0, upstream_key_name: "",
        downstream_token_id: 1, downstream_token_name: "test-token", client_type: `client-${id % 2}`, client_ip: "127.0.0.1",
        model: `model-${id % 2}`, request_model: null, upstream_model: null,
        reasoning_effort: null, upstream_reasoning_effort: null, response_reasoning_effort: null,
        stream: 0, status_code: id % 2 ? 503 : 200, prompt_tokens: 10, completion_tokens: 20, total_tokens: 30,
        prompt_cached_tokens: null, cache_creation_tokens: null, completion_reasoning_tokens: null,
        duration_ms: 100, first_token_ms: 10, error: null, request_id: null, retried: false,
      };
    }),
    groups: [1, 2].map((id) => ({
      id, name: id === 1 ? "default" : "group-2", description: "test group", is_default: id === 1,
      upstream_count: 0, token_count: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    })),
    tokens: [1, 2].map((id) => ({
      id, name: `token-${id}`, description: "", enabled: true, token: `test-token-${id}`,
      token_preview: "test", group_id: 1, group_name: "default", expires_at: null,
      quota: { used_tokens: 0, limit_tokens: null, remaining_tokens: null, exhausted: false, limit_expression: "" },
      allowed_models: [], rate_limit: null,
    })),
  };
  window.addEventListener("error", (event) => state.errors.push(String(event.error ?? event.message)));
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  state.pushLog = (patch = {}, notify = true) => {
    const id = state.logs[0].id + 1;
    const log = { ...state.logs[0], id, created_at: new Date(Date.UTC(2026, 0, 1) + id * 1000).toISOString(), ...patch };
    state.logs.unshift(log);
    if (notify) state.emit?.("log", { log, recent_rpm: 1, recent_tpm: 30 });
    return id;
  };
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const method = init.method ?? "GET";
    state.requests.push({ path: url.pathname, query: url.search, method, body: init.body });
    if (state.failures.has(url.pathname)) return json({ detail: "simulated failure" }, 503);
    if (url.pathname === "/api/admin/logs/clients") return json({ client_types: ["client-0", "client-1"] });
    if (url.pathname === "/api/admin/logs/stream") {
      state.streamConnections += 1;
      return new Response(new ReadableStream({ start(controller) {
        state.emit = (type, body) => controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(body)}\n\n`));
        init.signal?.addEventListener("abort", () => controller.close(), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/api/admin/logs/") {
      const params = url.searchParams;
      const rows = state.logs.filter((log) => {
        if (params.has("before_id") && log.id >= Number(params.get("before_id"))) return false;
        if (params.get("client_type") && log.client_type !== params.get("client_type")) return false;
        if (params.get("upstream_id") && log.upstream_id !== Number(params.get("upstream_id"))) return false;
        const status = params.get("status");
        if (status === "none" && log.status_code !== null) return false;
        if (status && status !== "none" && Math.floor(log.status_code / 100) !== Number(status[0])) return false;
        return !params.get("search") || [log.id, log.model, log.upstream_name, log.downstream_token_name].join(" ").includes(params.get("search"));
      });
      const limit = Number(params.get("limit") ?? 50);
      const snapshot = structuredClone({ items: rows.slice(0, limit), has_more: rows.length > limit, active: [], active_total: 0, recent_rpm: 1, recent_tpm: 30 });
      if (state.holdLogQueries) return new Promise((done) => state.holds.push({ path: "log-query", query: url.search, signal: init.signal, release: () => done(json(snapshot)) }));
      return json(snapshot);
    }
    if (url.pathname === "/api/admin/settings/") {
      if (method === "PUT") {
        const payload = JSON.parse(init.body);
        const save = () => {
          if (payload.revision !== state.settings.revision) return json({ detail: "revision conflict" }, 409);
          state.settings = { ...payload, revision: payload.revision + 1, updated_at: "2026-01-02T00:00:00Z" };
          return json(state.settings);
        };
        if (state.holdSettings) return new Promise((done) => state.holds.push({ path: "settings-save", release: () => done(save()) }));
        return save();
      }
      return json(state.settings);
    }
    if (url.pathname === "/api/admin/system") return json({
      service: "test-service", version: "test-version", default_upstream_timeout_seconds: 300,
      uptime_seconds: 90, current_server_time: "2026-01-01T00:00:00Z", database_ok: true,
      total_log_count: 0, log_count_24h: 0, enabled_upstream_count: 2, total_upstream_count: 2,
      recent_one_minute_log_count: 0, runtime_metrics: {
        active_sse_streams: 0, sse_client_disconnects_total: 0, sse_recent_disconnects_10m: 0,
        sse_upstream_errors_total: 0, log_queue_depth: 0, log_written_total: 0,
        log_write_batches_total: 0, log_dropped_total: 0, log_write_failures_total: 0,
        slow_db_operations_total: 0, cleanup: { active: false, current_rows_cleared: 0, current_batches: 0 },
      },
    });
    const tables = {
      "/api/admin/upstreams/": state.channels,
      "/api/admin/tokens/": state.tokens,
      "/api/admin/groups/": state.groups,
    };
    if (tables[url.pathname]) {
      const rows = tables[url.pathname];
      if (method === "POST") {
        const save = () => {
          const row = { ...rows[0], ...JSON.parse(init.body), id: rows.length + 1, is_default: false };
          rows.push(row);
          return json(row);
        };
        if (state.holdCreates) return new Promise((done) => state.holds.push({ path: `create:${url.pathname}`, release: () => done(save()) }));
        return save();
      }
      const snapshot = structuredClone(rows);
      if (state.holdLists) return new Promise((done) => state.holds.push({
        path: url.pathname, signal: init.signal, release: () => done(json(snapshot)),
      }));
      return json(snapshot);
    }
    const toggle = /\/(upstreams|tokens)\/(\d+)\/enabled$/.exec(url.pathname);
    if (toggle) {
      return new Promise((done) => state.holds.push({
        path: url.pathname,
        release: () => {
          const rows = toggle[1] === "tokens" ? state.tokens : state.channels;
          const row = rows.find((item) => item.id === Number(toggle[2]));
          Object.assign(row, JSON.parse(init.body));
          done(json(row));
        },
      }));
    }
    if (url.pathname === "/api/admin/settings/model-test-prompts") {
      const templates = [
        { id: 1, name: "server-template", prompt: "server-prompt" },
        { id: 2, name: "alternate-template", prompt: "alternate-prompt" },
      ];
      if (location.hash === "#debug") {
        return new Promise((done) => state.holds.push({ path: "templates", release: () => done(json(templates)) }));
      }
      return json(templates);
    }

    if (url.pathname === "/api/admin/debug" || /\/upstreams\/\d+\/debug$/.test(url.pathname)) {
      const id = url.pathname === "/api/admin/debug" ? 0 : Number(url.pathname.split("/").at(-2));
      const payload = JSON.parse(init.body);
      const reply = state.debugResponses?.[id];
      const events = [
        ["request", { url: `https://fake.invalid/v1/${payload.protocol}`, headers: { authorization: "Bearer [redacted]" }, body: payload.body }],
        ["response", { status_code: reply?.status ?? 200, headers: { "content-type": "application/json" }, ttfb_ms: 1 }],
        ["chunk", { text: reply?.body ?? state.imageBody, elapsed_ms: 2 }],
        ["done", { elapsed_ms: 3 }],
      ];
      const frame = ([type, body]) => `event: ${type}\ndata: ${JSON.stringify(body)}\n\n`;
      if (state.holdDebug) {
        return new Response(new ReadableStream({ start(controller) {
          const encoder = new TextEncoder();
          let closed = false;
          const abort = () => { closed = true; controller.error(new DOMException("Aborted", "AbortError")); };
          init.signal?.addEventListener("abort", abort, { once: true });
          controller.enqueue(encoder.encode(events.slice(0, 3).map(frame).join("")));
          state.holds.push({ path: `debug:${id}`, release: () => {
            if (closed) return;
            closed = true;
            init.signal?.removeEventListener("abort", abort);
            controller.enqueue(encoder.encode(frame(events[3])));
            controller.close();
          } });
        } }), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(events.map(frame).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`未配置假响应：${method} ${url.pathname}`);
  };
}

addCase("image", async (page, open) => {
  await open("images");
  await page.waitForSelector(".debug-channel input");
  await page.click(".debug-channel input");
  await page.click(".debug-compose button[type=submit]");
  await page.waitFor(() => document.querySelector(".debug-run-error")?.textContent.includes("不是 JSON 对象"));
  assert.equal(await page.count(".topbar"), 1, "异常响应不能卸载控制台");
  assert.match(await page.text(".debug-run"), /null/, "保留原文");
  assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
  await page.evaluate(() => { window.__test.imageBody = "data: null\n\n"; });
  await page.click(".debug-compose button[type=submit]");
  await page.waitFor(() => document.querySelector(".debug-run-error")?.textContent.includes("图片事件"));
  assert.equal(await page.count(".topbar"), 1);
});

addCase("row-actions", async (page, open) => {
  for (const view of ["tokens", "upstreams"]) {
    await open(view);
    const first = `section[data-view=${view}] tbody tr:nth-child(1) .status-switch`;
    const second = `section[data-view=${view}] tbody tr:nth-child(2) .status-switch`;
    await page.waitForSelector(second);
    await page.click(first);
    await page.click(second);
    assert.deepEqual(await page.evaluate((a, b) => [
      document.querySelector(a).disabled, document.querySelector(b).disabled,
    ], first, second), [true, true], `${view} 两行都应保持禁用`);
    await page.click(first);
    assert.equal(await page.evaluate(() => window.__test.holds.length), 2, "重复点击不再发请求");
    await page.evaluate(() => window.__test.holds[0].release());
    await page.waitFor((selector) => !document.querySelector(selector).disabled, {}, first);
    assert.equal(await page.evaluate((selector) => document.querySelector(selector).disabled, second), true);
    await page.evaluate(() => window.__test.holds[1].release());
    await page.waitFor((selector) => !document.querySelector(selector).disabled, {}, second);
    assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
  }
});

addCase("debug-draft", async (page, open) => {
  await open("debug");
  await page.waitForSelector(".debug-body");
  await choose(page, 'select[aria-label="API 协议"]', "messages");
  await page.fill('textarea[aria-label="发送消息"]', "manual-prompt");
  await page.fill("input[list=debug-model-options]", "manual-model");
  await page.click(".debug-stream-toggle input");
  const raw = '{"model":"manual-model","messages":[{"role":"user","content":"manual-prompt"}],"temperature":0.1}';
  await page.click(".debug-system summary");
  await page.fill(".debug-body", raw);
  await page.waitFor(() => window.__test.holds.some((item) => item.path === "templates"));
  await page.evaluate(() => window.__test.holds.find((item) => item.path === "templates").release());
  await page.waitFor(() => document.querySelector(".debug-template").textContent.includes("server-template"));
  assert.deepEqual(await page.evaluate(() => ({
    body: document.querySelector(".debug-body").value,
    protocol: document.querySelector('select[aria-label="API 协议"]').value,
    model: document.querySelector("input[list=debug-model-options]").value,
    stream: document.querySelector(".debug-stream-toggle input").checked,
  })), { body: raw, protocol: "messages", model: "manual-model", stream: false });
  assert.equal(await page.evaluate(() => document.querySelector('textarea[aria-label="发送消息"]').value), "manual-prompt");

  await page.reload();
  await page.waitForSelector(".debug-body");
  assert.equal(await page.evaluate(() => document.querySelector(".debug-body").value), raw, "刷新恢复本机草稿");
});

addCase("settings-load", async (page, open) => {
  const resources = [
    ["/api/admin/settings/", "运行策略"],
    ["/api/admin/settings/model-test-prompts", "Prompt"],
    ["/api/admin/system", "运行信息"],
  ];
  for (const [path, label] of resources) {
    await open("settings", [path]);
    const retry = `button[aria-label="重试加载${label}"]`;
    await page.waitForSelector(retry);
    const shown = await page.evaluate(() => ({
      inputs: document.querySelectorAll(".settings-server-form input[type=number]").length,
      prompt: document.querySelector(".model-test-template-list")?.textContent.includes("server-template"),
      system: document.querySelector(".system-info-grid")?.textContent.includes("test-service"),
      loading: [...document.querySelectorAll(".settings-loading")].some((item) => item.textContent.includes("加载")),
    }));
    assert.equal(shown.inputs > 0, label !== "运行策略");
    assert.equal(shown.prompt, label !== "Prompt");
    assert.equal(shown.system, label !== "运行信息");
    assert.equal(shown.loading, false, "失败不能伪装成持续加载");
    const before = await page.evaluate(() => window.__test.requests.length);
    await page.evaluate(() => window.__test.failures.clear());
    await page.click(retry);
    await page.waitFor(() => document.querySelectorAll(".settings-server-form input[type=number]").length > 0
      && document.querySelector(".model-test-template-list")?.textContent.includes("server-template")
      && document.querySelector(".system-info-grid")?.textContent.includes("test-service"));
    const requests = await page.evaluate((start) => window.__test.requests.slice(start), before);
    assert.deepEqual(requests.map((item) => item.path), [path], "只重试失败的资源");
    assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
  }
});

addCase("settings-save", async (page, open) => {
  await open("settings");
  const log = "input[name=log_body_keep_count]";
  const proxy = "input[name=proxy_url]";
  const submit = "[data-settings-card=log] button[type=submit]";
  await page.waitForSelector(log);
  await page.fill(log, "200");
  await page.fill(proxy, "http://local-proxy");
  await page.evaluate(() => { window.__test.holdSettings = true; });
  await page.click(submit);
  await page.waitFor(() => window.__test.holds.some((item) => item.path === "settings-save"));
  const sent = await page.evaluate(() => JSON.parse(window.__test.requests.find((item) => item.method === "PUT").body));
  assert.equal(sent.log_body_keep_count, 200);
  assert.equal(sent.proxy_url, "", "其他卡草稿不随之提交");
  assert.equal(sent.revision, 3);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll(".settings-server-form button[type=submit]")].every((button) => button.disabled)), true);
  await page.fill(log, "300");
  await page.evaluate(() => { window.__test.holdSettings = false; window.__test.holds.find((item) => item.path === "settings-save").release(); });
  await page.waitFor((selector) => !document.querySelector(selector).disabled, {}, submit);
  assert.equal(await page.evaluate((selector) => document.querySelector(selector).value, log), "300");
  assert.equal(await page.evaluate((selector) => document.querySelector(selector).value, proxy), "http://local-proxy");

  await page.evaluate(() => document.querySelector("input[name=image_storage_max_mb]").focus());
  await page.fill("input[name=image_storage_max_mb]", "");
  await page.evaluate(() => document.querySelector("input[name=image_storage_max_mb]").blur());
  const restored = await page.evaluate(() => {
    const input = document.querySelector("input[name=image_storage_max_mb]");
    return { text: input.value, value: input.valueAsNumber, stored: window.__test.settings.image_storage_max_mb };
  });
  assert.equal(restored.value, 1, `清空失焦后应恢复 1 GB：${JSON.stringify(restored)}`);
  await page.fill(log, "-1");
  const before = await page.evaluate(() => window.__test.requests.length);
  await page.click(submit);
  assert.equal(await page.evaluate(() => window.__test.requests.length), before, "越界数字不能提交");
  await page.fill(log, "300");

  await page.evaluate(() => { Object.assign(window.__test.settings, { revision: 9, max_retries: 4 }); });
  await page.click(submit);
  await page.waitFor(() => document.querySelector(".toast-region")?.textContent.includes("已被修改"));
  await page.waitFor(() => document.querySelector("input[name=max_retries]").value === "4");
  assert.equal(await page.evaluate((selector) => document.querySelector(selector).value, log), "300");
  assert.equal(await page.evaluate((selector) => document.querySelector(selector).value, proxy), "http://local-proxy");
  await page.click(submit);
  await page.waitFor(() => window.__test.settings.revision === 10);
  const saved = await page.evaluate(() => window.__test.settings);
  assert.equal(saved.log_body_keep_count, 300);
  assert.equal(saved.max_retries, 4);
  assert.equal(saved.proxy_url, "");
  assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
});

async function refreshList(page, view) {
  await page.evaluate((id) => {
    [...document.querySelectorAll(`section[data-view=${id}] .view-toolbar button`)]
      .find((button) => button.textContent.includes("刷新")).click();
  }, view);
}

addCase("quick-import-paste", async (page, open) => {
  await open("upstreams");
  await page.waitForSelector("section[data-view=upstreams] .view-toolbar");
  await page.evaluate(() => [...document.querySelectorAll(".view-toolbar button")]
    .find((button) => button.textContent.includes("快速导入")).click());
  const dialog = "dialog.quick-import-dialog[open]";
  await page.waitForSelector(dialog);
  const text = "Base URL: https://api.example.com/v1\nAPI Key: sk-paste-check-0123456789abcdef";
  await page.evaluate((scope, value) => {
    const textarea = document.querySelector(`${scope} textarea`);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (type) => type === "text/plain" ? value : "" },
    });
    textarea.dispatchEvent(paste);
  }, dialog, text);
  await page.waitFor(() => document.querySelector("#quick-import-url")?.value === "https://api.example.com/v1"
    && document.querySelector("#quick-import-apikey")?.value === "sk-paste-check-0123456789abcdef");
  assert.match(await page.text("#quick-import-source-note"), /识别到 1 个地址、1 把 Key/);
  assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
});

addCase("list-lifecycle", async (page, open) => {
  for (const [view, label, key] of [["tokens", "令牌", "tokens"], ["groups", "分组", "groups"], ["upstreams", "渠道", "channels"]]) {
    const path = `/api/admin/${view}/`;
    await open(view);
    await page.waitFor(() => document.querySelectorAll(".view tbody tr").length === 2);
    await page.evaluate(() => { window.__test.holdLists = true; });
    await refreshList(page, view);
    await page.waitFor(() => window.__test.holds.length === 1);
    assert.equal(await page.count(".view tbody tr"), 2, "刷新时保留列表");
    await page.evaluate((key) => { window.__test[key][0].name = "latest-name"; }, key);
    await refreshList(page, view);
    await page.waitFor(() => window.__test.holds.length === 2);
    assert.equal(await page.evaluate(() => window.__test.holds[0].signal.aborted), true);
    await page.evaluate(() => window.__test.holds[1].release());
    await page.waitFor(() => document.querySelector(".view tbody").textContent.includes("latest-name"));
    await page.evaluate(() => window.__test.holds[0].release());
    assert.match(await page.text(".view tbody"), /latest-name/);

    await page.evaluate((path) => { window.__test.holdLists = false; window.__test.failures.add(path); }, path);
    await refreshList(page, view);
    const retry = `button[aria-label="重试加载${label}"]`;
    await page.waitForSelector(retry);
    assert.match(await page.text(".view tbody"), /latest-name/, "刷新失败保留旧数据");
    await page.evaluate(() => window.__test.failures.clear());
    await page.click(retry);
    await page.waitFor((selector) => !document.querySelector(selector), {}, retry);

    if (view !== "groups") {
      await page.evaluate(() => { window.__test.holdLists = true; window.__test.holds = []; });
      await refreshList(page, view);
      await page.waitFor(() => window.__test.holds.length === 1);
      const toggle = ".view tbody tr:first-child .status-switch";
      await page.click(toggle);
      await page.waitFor(() => window.__test.holds.length === 2);
      await page.evaluate(() => window.__test.holds[1].release());
      await page.waitFor((selector) => document.querySelector(selector).getAttribute("aria-checked") === "false", {}, toggle);
      assert.equal(await page.evaluate(() => window.__test.holds[0].signal.aborted), true);
      await page.evaluate(() => window.__test.holds[0].release());
      assert.equal(await page.evaluate((selector) => document.querySelector(selector).getAttribute("aria-checked"), toggle), "false");
    }
    assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
  }
});

addCase("list-save", async (page, open) => {
  for (const [view, label] of [["tokens", "令牌"], ["groups", "分组"]]) {
    const path = `/api/admin/${view}/`;
    await open(view);
    await page.waitFor(() => document.querySelectorAll(".view tbody tr").length === 2);
    await page.evaluate(() => {
      window.__test.holdCreates = true;
      [...document.querySelectorAll(".view-toolbar button")].find((button) => button.textContent.includes("新增")).click();
    });
    await page.waitForSelector("dialog.upstream-dialog[open]");
    await page.fill("dialog.upstream-dialog[open] .field input", "new-item");
    await page.click("dialog.upstream-dialog[open] button[type=submit]");
    await page.waitFor(() => window.__test.holds.some((item) => item.path.startsWith("create:")));
    assert.equal(await page.evaluate(() => document.querySelector("dialog.upstream-dialog[open] .upstream-dialog-body").inert), true);
    await page.evaluate(() => document.querySelector("dialog.upstream-dialog[open] form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(await page.evaluate(() => window.__test.requests.filter((item) => item.method === "POST").length), 1);
    assert.equal(await page.evaluate(() => document.querySelector("dialog.upstream-dialog[open]").dispatchEvent(new Event("cancel", { cancelable: true }))), false);
    await page.evaluate((path) => {
      window.__test.failures.add(path);
      window.__test.holds.find((item) => item.path.startsWith("create:")).release();
    }, path);
    await page.waitForSelector(`button[aria-label="重试加载${label}"]`);
    assert.equal(await page.count("dialog.upstream-dialog[open]"), 0, "写入成功后关闭表单");
    assert.doesNotMatch(await page.text(".toast-region"), /保存失败/, "列表读取失败不误报写入失败");
    await page.evaluate(() => window.__test.failures.clear());
    await page.click(`button[aria-label="重试加载${label}"]`);
    await page.waitFor(() => document.querySelector(".view tbody").textContent.includes("new-item"));
  }
});

addCase("channel-selection", async (page, open) => {
  for (const view of ["debug", "images"]) {
    await open(view);
    if (view === "debug") {
      await page.waitForSelector('select[aria-label="发送方式"]');
      await choose(page, 'select[aria-label="发送方式"]', "direct");
    }
    await page.waitFor(() => document.querySelectorAll(".debug-channel input").length === 2);
    await page.evaluate(() => [...document.querySelectorAll(".debug-channel input")].forEach((input) => input.click()));
    const draft = '{"model":"manual-model","prompt":"keep-draft","temperature":0.2}';
    if (view === "debug") await page.click(".debug-system summary");
    await page.fill(".debug-body", draft);
    await page.click(".topbar-nav [data-view=groups]");
    await page.waitForSelector("section[data-view=groups] tbody");
    assert.equal(await page.evaluate(() => window.__test.requests.filter((item) => item.path === "/api/admin/upstreams/").length), 1);
    await page.evaluate(() => {
      const [first, second] = window.__test.channels;
      window.__test.channels = [
        { ...second, archived: true },
        { ...first, id: 3, name: "new-channel", model_names: ["new-model"] },
      ];
    });
    await page.click(`.topbar-nav [data-view=${view}]`);
    await page.waitFor(() => document.querySelector(".debug-channel-list").textContent.includes("new-channel"));
    assert.equal(await page.count(".debug-channel input"), 1);
    assert.equal(await page.count(".debug-channel input:checked"), 0, "删除和归档的渠道应退出选择");
    assert.equal(await page.evaluate(() => document.querySelector(".debug-body").value), draft);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("datalist[id$=model-options] option")].map((item) => item.value)), ["new-model"]);
    assert.equal(await page.evaluate(() => window.__test.requests.filter((item) => item.path === "/api/admin/upstreams/").length), 2);
    assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
  }
});

async function choose(page, selector, value) {
  await page.evaluate((selector, value) => {
    const input = document.querySelector(selector);
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector, value);
}

const shownLogIds = (page) => page.evaluate(() => [...document.querySelectorAll("[data-log-id]")].map((row) => Number(row.dataset.logId)));

addCase("lazy-pages", async (page, open) => {
  await open("dashboard");
  await page.waitForSelector("section[data-view=dashboard]");
  const hasChunk = (resources, name) => resources.some((path) => new RegExp(`/${name}-[^/]+\\.js$`).test(path));
  const initial = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => entry.name.includes("/assets/") && entry.name.endsWith(".js"))
    .map((entry) => new URL(entry.name).pathname));
  assert.equal(hasChunk(initial, "DashboardPage"), true, "默认页应有独立 chunk");
  assert.equal(hasChunk(initial, "LogsPage"), false, "未访问页不能提前下载");
  assert.equal(hasChunk(initial, "DebugPage"), false, "调试页不能提前下载");
  assert.equal(hasChunk(initial, "ImagePage"), false, "生图页不能提前下载");

  await page.click(".topbar-nav [data-view=logs]");
  await page.waitForSelector("section[data-view=logs] .log-table");
  let resources = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => entry.name.includes("/assets/") && entry.name.endsWith(".js"))
    .map((entry) => new URL(entry.name).pathname));
  assert.equal(hasChunk(resources, "LogsPage"), true, "切到日志后应下载日志 chunk");
  assert.equal(hasChunk(resources, "DebugPage"), false);

  await page.click(".topbar-nav [data-view=debug]");
  await page.waitForSelector("section[data-view=debug] .debug-body");
  await page.waitFor(() => window.__test.holds.some((item) => item.path === "templates"));
  await page.evaluate(() => window.__test.holds.find((item) => item.path === "templates").release());
  await page.waitFor(() => document.querySelector(".debug-template").textContent.includes("server-template"));
  await page.click(".debug-system summary");
  await page.fill(".debug-body", '{"model":"keep-state","messages":[],"temperature":0.25}');
  const draft = await page.evaluate(() => document.querySelector(".debug-body").value);
  await page.click(".topbar-nav [data-view=logs]");
  await page.waitFor(() => document.querySelector("section[data-view=debug]")?.hidden === true);
  assert.equal(await page.evaluate(() => document.querySelector(".debug-body")?.value), draft);
  await page.click(".topbar-nav [data-view=debug]");
  await page.waitFor(() => document.querySelector("section[data-view=debug]")?.hidden === false);
  assert.equal(await page.evaluate(() => document.querySelector(".debug-body")?.value), draft);

  resources = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => entry.name.includes("/assets/") && entry.name.endsWith(".js"))
    .map((entry) => new URL(entry.name).pathname));
  assert.equal(hasChunk(resources, "DebugPage"), true, "首次访问调试页才下载调试 chunk");

  await page.click(".topbar-nav [data-view=images]");
  await page.waitForSelector("section[data-view=images] .debug-body");
  await page.fill("section[data-view=images] .debug-body", '{"model":"image-keep-state","prompt":"image-draft","n":1}');
  const imageDraft = await page.evaluate(() => document.querySelector('section[data-view="images"] .debug-body').value);
  resources = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter((entry) => entry.name.includes("/assets/") && entry.name.endsWith(".js"))
    .map((entry) => new URL(entry.name).pathname));
  assert.equal(hasChunk(resources, "ImagePage"), true, "首次访问生图页才下载生图 chunk");
  await page.click(".topbar-nav [data-view=logs]");
  await page.waitFor(() => document.querySelector("section[data-view=images]")?.hidden === true);
  assert.equal(await page.evaluate(() => document.querySelector('section[data-view="images"] .debug-body').value), imageDraft);
  await page.click(".topbar-nav [data-view=images]");
  await page.waitFor(() => document.querySelector("section[data-view=images]")?.hidden === false);
  assert.equal(await page.evaluate(() => document.querySelector('section[data-view="images"] .debug-body').value), imageDraft);
  assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
});

addCase("logs-visibility-resume", async (page, open) => {
  await open("logs");
  await page.waitFor(() => document.querySelectorAll("[data-log-id]").length === 50 && window.__test.streamConnections === 1);
  await page.waitForSelector(".live-indicator.is-live");
  await page.evaluate(() => {
    window.__test.documentHidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__test.documentHidden });
    window.__test.documentHidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForSelector(".live-indicator:not(.is-live)");
  const recoveredId = await page.evaluate(() => window.__test.pushLog({ model: "created-while-hidden" }, false));
  await page.evaluate(() => {
    window.__test.documentHidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitFor((id) => document.querySelector(`[data-log-id="${id}"]`) !== null, {}, recoveredId);
  await page.waitForSelector(".live-indicator.is-live");
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
  assert.equal(await page.evaluate(() => window.__test.streamConnections), 2, "唤醒只建立一个新流");
  assert.equal(await page.evaluate((id) => document.querySelectorAll(`[data-log-id="${id}"]`).length, recoveredId), 1, "补拉与推送不重复显示日志");
  await page.evaluate(() => window.__test.pushLog({ model: "after-resume" }));
  await page.waitFor(() => document.querySelector("[data-log-id]")?.textContent.includes("after-resume"));
  assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
});

addCase("logs-pagination", async (page, open) => {
  await open("logs");
  await page.waitFor(() => document.querySelectorAll("[data-log-id]").length === 50 && window.__test.emit);
  await choose(page, "select[aria-label=日志每页条数]", "20");
  await page.waitFor(() => document.querySelectorAll("[data-log-id]").length === 20);
  await page.evaluate(() => window.__test.pushLog());
  await page.waitFor(() => document.querySelector("[data-log-id]")?.dataset.logId === "81");
  const first = await shownLogIds(page);
  assert.equal(first.length, 20);
  await page.evaluate(() => {
    const next = [...document.querySelectorAll(".pager-actions button")].find((button) => button.textContent.includes("下一页"));
    next.click(); next.click();
  });
  await page.waitFor(() => document.querySelector("[data-log-id]")?.dataset.logId === "61");
  assert.match(await page.text(".pager-meta-text"), /第 2 页/);
  const request = await page.evaluate(() => window.__test.requests.filter((item) => item.path === "/api/admin/logs/").at(-1));
  assert.equal(new URLSearchParams(request.query).get("before_id"), String(first.at(-1)));
  await page.evaluate(() => window.__test.pushLog());
  await page.waitFor(() => !document.querySelector(".log-new-entries-notice").hidden);
  assert.equal((await shownLogIds(page))[0], 61, "旧页不混入实时日志");
  await page.click(".log-new-entries-notice button");
  await page.waitFor(() => document.querySelector("[data-log-id]")?.dataset.logId === "82");
  assert.match(await page.text(".pager-meta-text"), /第 1 页/);
});

addCase("logs-filter-race", async (page, open) => {
  await open("logs");
  await page.waitFor(() => document.querySelectorAll("[data-log-id]").length === 50);
  await page.evaluate(() => { window.__test.holdLogQueries = true; });
  const client = "select[aria-label=按客户端筛选日志]";
  await choose(page, client, "client-0");
  await page.waitFor(() => window.__test.holds.length === 1);
  await choose(page, client, "client-1");
  await page.waitFor(() => window.__test.holds.length === 2);
  await page.evaluate(() => window.__test.holds[1].release());
  await page.waitFor(() => document.querySelectorAll("[data-log-id]").length === 40 && document.querySelector("[data-log-id]")?.dataset.logId === "79");
  await page.evaluate(() => window.__test.holds[0].release());
  assert.equal((await shownLogIds(page)).every((id) => id % 2 === 1), true);
  await page.evaluate(() => { window.__test.holdLogQueries = false; });
  await choose(page, "select[aria-label=按状态码筛选日志]", "5xx");
  await page.waitFor(() => window.__test.requests.some((item) => item.query.includes("status=5xx")));
  await page.evaluate(() => { window.__test.pushLog({ status_code: 200 }); window.__test.pushLog({ status_code: 503, client_type: "client-1" }); });
  await page.waitFor(() => document.querySelector("[data-log-id]")?.dataset.logId === "82");
  assert.equal((await shownLogIds(page)).includes(81), false);
  await page.fill("#log-search", "model-1");
  await page.waitFor(() => window.__test.requests.some((item) => item.query.includes("search=model-1")));
  const last = await page.evaluate(() => window.__test.requests.filter((item) => item.path === "/api/admin/logs/").at(-1));
  assert.equal(new URLSearchParams(last.query).get("before_id"), null);
});

addCase("logs-gap", async (page, open) => {
  await open("logs");
  await page.waitFor(() => document.querySelectorAll("[data-log-id]").length === 50 && window.__test.emit);
  const before = await page.evaluate(() => window.__test.requests.filter((item) => item.path === "/api/admin/logs/").length);
  await page.evaluate(() => { for (let i = 0; i < 230; i += 1) window.__test.pushLog(); });
  await page.waitFor((count) => window.__test.requests.filter((item) => item.path === "/api/admin/logs/").length > count, {}, before);
  await page.waitFor(() => document.querySelector("[data-log-id]")?.dataset.logId === "310");
  assert.equal((await shownLogIds(page)).length, 50);
  assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
});

addDebugCases(addCase);

// 后续状态用例。

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "wildtoken-state-"));
  let chrome;
  let cdp;
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    const relative = path.startsWith("/console/assets/") ? `web/dist/${path.slice(9)}`
      : path.startsWith("/theme-packs/") ? `themes/${path.slice(13)}`
        : path.startsWith("/static/") ? path.slice(1) : "web/dist/index.html";
    const file = resolve(ROOT, relative);
    if (!file.startsWith(ROOT)) { response.writeHead(403).end(); return; }
    try {
      const content = readFileSync(file);
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[extname(file)];
      response.writeHead(200, { "content-type": type ?? "application/octet-stream" }).end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  const cleanup = () => {
    cdp?.close();
    if (chrome?.pid) {
      try { process.kill(-chrome.pid, "SIGKILL"); } catch { chrome.kill("SIGKILL"); }
    }
    server.closeAllConnections();
    server.close();
  };
  const onSignal = () => { cleanup(); process.exitCode = 1; };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const launched = await launchChrome(profile);
    chrome = launched.chrome;
    cdp = await attachPage(launched.port);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    // 显式模拟焦点，才能验证 React 的 onFocus/onBlur。
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await cdp.send("Network.enable");
    await cdp.send("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installMocks.toString()})();` });
    const page = new Page(cdp);
    let generation = 0;
    const open = (view, failures = []) => page.goto(`http://127.0.0.1:${server.address().port}/console?case=${++generation}&fail=${encodeURIComponent(JSON.stringify(failures))}#${view}`);
    const chosen = process.argv.slice(2);
    assert(chosen.every((name) => cases.some((item) => item.name === name)), "存在未知用例名");
    for (const item of cases.filter((item) => chosen.length === 0 || chosen.includes(item.name))) {
      await item.run(page, open);
      console.log(`通过：${item.name}`);
    }
  } finally {
    const exited = chrome && chrome.exitCode === null ? once(chrome, "exit") : Promise.resolve();
    cleanup();
    await exited;
    rmSync(profile, { recursive: true, force: true });
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
}

await main();
