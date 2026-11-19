import assert from "node:assert/strict";
import test from "node:test";

import {
  bodyProblem, createDebugDraft, draftForProtocol, editDebugBody, outputTokenKey,
  simpleRequest, withMessages, withPrompt, withSystem,
} from "../web/src/debugDraft.ts";
import { parseBody, withStream } from "../web/src/debugRequest.ts";

const protocols = ["responses", "chat_completions", "messages"];

test("便捷输入读取三种协议的默认消息", () => {
  for (const protocol of protocols) {
    const draft = createDebugDraft(protocol, "model", "你好", true);
    assert.deepEqual(simpleRequest(protocol, parseBody(draft.bodyText)), {
      system: "", messages: [{ role: "user", content: "你好" }],
    });
  }
});

test("表单逐字段修改，保留系统提示、消息和自定义参数", () => {
  for (const protocol of protocols) {
    const original = { ...parseBody(createDebugDraft(protocol, "m", "hi").bodyText), metadata: { trace: "keep" }, tools: [] };
    const before = structuredClone(original);
    const system = withSystem(protocol, original, "仅使用中文");
    const messages = [{ role: "user", content: "hi" }, { role: "assistant", content: "你好" }, { role: "user", content: "继续" }];
    const multi = withMessages(protocol, system, messages);
    const updated = withPrompt(protocol, multi, "新问题");
    assert.deepEqual(simpleRequest(protocol, updated), {
      system: "仅使用中文", messages: [...messages.slice(0, -1), { role: "user", content: "新问题" }],
    });
    assert.deepEqual(updated.metadata, { trace: "keep" });
    assert.deepEqual(updated.tools, []);
    assert.equal(updated.stream, true);
    assert.deepEqual(original, before, "不能修改原对象");
    assert.equal(simpleRequest(protocol, withSystem(protocol, updated, "")).system, "");
  }
});

test("Responses 单条字符串保持形状，添加多轮时才转换为数组", () => {
  const body = { model: "m", input: "old", instructions: "system" };
  assert.equal(withPrompt("responses", body, "new").input, "new");
  const messages = [{ role: "user", content: "old" }, { role: "assistant", content: "reply" }];
  assert.deepEqual(withMessages("responses", body, messages).input, messages);
  assert.deepEqual(withPrompt("responses", { input: [] }, "new").input, [{ role: "user", content: "new" }]);
});

test("非标准文本结构不能被便捷输入压平成文本", () => {
  const cases = [
    ["responses", { input: [{ type: "function_call_output", call_id: "1", output: "ok" }] }],
    ["responses", { input: [{ role: "user", content: [{ type: "input_image", image_url: "url" }] }] }],
    ["responses", { input: "hello", instructions: [{ type: "text", text: "system" }] }],
    ["chat_completions", { messages: [{ role: "assistant", content: "", tool_calls: [] }] }],
    ["chat_completions", { messages: [{ role: "user", content: "hi", name: "test" }] }],
    ["chat_completions", { messages: [{ role: "developer", content: "system" }, { role: "user", content: "hi" }] }],
    ["chat_completions", { messages: [{ role: "system", content: "one" }, { role: "system", content: "two" }] }],
    ["messages", { system: [{ type: "text", text: "system" }], messages: [{ role: "user", content: "hi" }] }],
    ["messages", { messages: [{ role: "user", content: null }] }],
    ["messages", { messages: [], max_tokens: "100" }],
    ["responses", { input: "hi", temperature: null }],
    ["chat_completions", { messages: [], max_tokens: 100, max_completion_tokens: 200 }],
  ];
  for (const [protocol, body] of cases) {
    const previous = structuredClone(body);
    assert.equal(simpleRequest(protocol, body), null);
    assert.deepEqual(withPrompt(protocol, body, "do not replace"), previous);
    assert.deepEqual(withSystem(protocol, body, "do not replace"), previous);
  }
});

test("JSON 编辑同步模型，Messages 只保留匹配正文的 [1m] 别名", () => {
  const draft = createDebugDraft("messages", "opus[1m]", "hi");
  assert.equal(parseBody(draft.bodyText).model, "opus");
  assert.equal(editDebugBody(draft, '{"model":"opus","stream":false}').model, "opus[1m]");
  assert.equal(editDebugBody(draft, '{"model":"other"}').model, "other");
  assert.equal(editDebugBody(draft, '{}').model, "");
  const invalid = editDebugBody(draft, '{"model":');
  assert.equal(invalid.model, "opus[1m]");
  assert.equal(invalid.bodyText, '{"model":');
  const simple = createDebugDraft("responses", "before");
  assert.equal(editDebugBody(simple, '{"model":"after","stream":false}').model, "after");
});

test("首次切换协议携带通用字段，但不修改源协议或挪用专有参数", () => {
  const body = {
    model: "m", input: [{ role: "user", content: "hi" }, { role: "assistant", content: "reply" }],
    instructions: "system", max_output_tokens: 42, temperature: 0, stream: true, reasoning: { effort: "high" },
  };
  const original = editDebugBody(createDebugDraft(), JSON.stringify(body));
  const target = draftForProtocol(original, "chat_completions");
  const parsed = parseBody(target.bodyText);
  assert.equal(original.bodyText, JSON.stringify(body));
  assert.deepEqual(parsed.messages, [{ role: "system", content: "system" }, ...body.input]);
  assert.equal(parsed.max_tokens, 42);
  assert.equal(parsed.temperature, 0);
  assert.deepEqual(parsed.stream_options, { include_usage: true });
  assert.equal("reasoning" in parsed, false);
  assert.equal(target.model, "m");
});

test("Chat Completions 兼容两种输出上限字段", () => {
  assert.equal(outputTokenKey("chat_completions", { max_completion_tokens: 100 }), "max_completion_tokens");
  assert.equal(outputTokenKey("chat_completions", { max_tokens: 100 }), "max_tokens");
  assert.equal(outputTokenKey("responses", {}), "max_output_tokens");
  assert.equal(outputTokenKey("messages", {}), "max_tokens");
});

test("开启流式保留自定义 stream_options", () => {
  const body = { stream_options: { include_obfuscation: false }, temperature: 0.2 };
  assert.deepEqual(withStream("chat_completions", body, true), {
    ...body, stream: true, stream_options: { include_obfuscation: false, include_usage: true },
  });
  assert.deepEqual(body.stream_options, { include_obfuscation: false });
});

test("JSON 校验区分语法错误和非对象", () => {
  assert.equal(bodyProblem('{}'), "");
  for (const text of ["[]", "null", '"text"', "10"]) assert.match(bodyProblem(text), /JSON 对象/);
  for (const text of ["", "{bad"]) assert.match(bodyProblem(text), /JSON 格式有误/);
});
