// 调试页的默认请求体、流式开关和请求体校验。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { bodyModel, defaultBody, parseBody, withStream } from "../web/src/debugRequest.ts";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("三种协议的默认体和后端 modelTestRequest 同形", () => {
  assert.deepEqual(defaultBody("responses", "gpt-5", "hi", false), {
    model: "gpt-5", input: "hi", max_output_tokens: 1000,
  });
  assert.deepEqual(defaultBody("chat_completions", "gpt-5", "hi", false), {
    model: "gpt-5", messages: [{ role: "user", content: "hi" }], max_tokens: 1000,
  });
  assert.deepEqual(defaultBody("messages", "opus", "hi", false), {
    model: "opus", max_tokens: 1000, messages: [{ role: "user", content: "hi" }],
  });
});

test("messages 协议去掉 [1m] 后缀，其余协议原样", () => {
  assert.equal(bodyModel("messages", "claude-opus-5[1m]"), "claude-opus-5");
  assert.equal(bodyModel("chat_completions", "claude-opus-5[1m]"), "claude-opus-5[1m]");
});

test("流式开关：chat_completions 要带 include_usage，关掉时一起清", () => {
  const on = withStream("chat_completions", { model: "m" }, true);
  assert.deepEqual(on, { model: "m", stream: true, stream_options: { include_usage: true } });
  assert.deepEqual(withStream("chat_completions", on, false), { model: "m" });

  // 其他协议只动 stream，手改的字段保留。
  assert.deepEqual(withStream("messages", { model: "m", temperature: 0 }, true), {
    model: "m", temperature: 0, stream: true,
  });
});

test("请求体只接受 JSON 对象，和后端校验一致", () => {
  assert.deepEqual(parseBody('{"a":1}'), { a: 1 });
  for (const text of ["", "[1]", "null", '"x"', "{bad"]) {
    assert.equal(parseBody(text), null, text);
  }
});

test("调试、生图依次排在设置前面", () => {
  const views = read("web/src/App.tsx").match(/const VIEWS: ViewId\[\] = \[([^\]]+)\]/)[1];
  assert.match(views, /"debug", "images", "settings"/);

  const nav = read("web/src/components/Topbar.tsx");
  const order = ["debug", "images", "settings"].map((id) => nav.indexOf(`id: "${id}"`));
  assert.ok(order[0] < order[1] && order[1] < order[2], "顶栏顺序应为调试、生图、设置");
});

// 切页不能打断调试：两页常驻，切走只隐藏；刷新命令只重挂当前页。
test("调试和生图切页后仍挂着，只是隐藏", () => {
  const app = read("web/src/App.tsx");
  assert.match(app, /const KEEP_ALIVE: readonly ViewId\[\] = \["debug", "images"\]/);
  assert.match(app, /<DebugPage key=\{pageKey\("debug"\)\} active=\{view === "debug"\}/);
  assert.match(app, /<ImagePage key=\{pageKey\("images"\)\} active=\{view === "images"\}/);
  // 路由区的 key 必须和常驻页的 key 区分开，否则当前页是常驻页时两者撞 key，渲染出两份。
  assert.match(app, /<Fragment key=\{`routed-\$\{pageKey\(view\)\}`\}>/);

  for (const [file, view] of [["DebugPage", "debug"], ["ImagePage", "images"]]) {
    const page = read(`web/src/pages/${file}.tsx`);
    assert.ok(page.includes(`data-view="${view}" hidden={!active}`), `${file} 没按 active 隐藏`);
  }
});
