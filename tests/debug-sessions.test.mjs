import assert from "node:assert/strict";
import test from "node:test";

import { createDebugDraft } from "../web/src/debugDraft.ts";
import { parseBody } from "../web/src/debugRequest.ts";
import {
  appendChatMessage, chatParameterProblem, decodeDebugSessions, encodeDebugSessions, finishChatTurn,
  initialSessionState, newDebugSession, replyText, requestWithMessage, sessionModels, useTurnContext,
} from "../web/src/debugSessions.ts";
import { openLocalRecord } from "../web/src/driver/localRecord.ts";

const run = (id = 0, text = "reply", patch = {}) => ({
  batch: 1, upstreamId: id, name: "route", phase: "done", startedAt: 100, request: null, status: 200,
  responseHeaders: {}, ttfbMs: 1, firstChunkMs: 2, elapsedMs: 3, error: "",
  raw: JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }), ...patch,
});
const withTurn = (session, runs) => ({ ...session, turns: [{ id: "turn", prompt: "hello", request: session.draft, runs, contextId: null, contextResolved: false }] });

test("新会话默认按模型自动路由，并清理上一会话的上下文", () => {
  const first = newDebugSession();
  assert.equal(first.routing, "auto");
  assert.equal(first.groupId, 1);
  assert.deepEqual(parseBody(first.draft.bodyText).input, []);
  first.draft = { ...first.draft, model: "m", bodyText: JSON.stringify({ model: "m", input: "history", instructions: "system", temperature: 0, previous_response_id: "resp_old" }) };
  first.input = "unsent";
  const next = newDebugSession(first);
  assert.notEqual(first.id, next.id);
  assert.equal(next.input, "");
  assert.deepEqual(next.turns, []);
  assert.deepEqual(parseBody(next.draft.bodyText), { model: "m", input: [], instructions: "system", temperature: 0 });
});

test("三种协议逐轮追加消息，不丢系统提示和未知参数", () => {
  for (const protocol of ["responses", "chat_completions", "messages"]) {
    let session = newDebugSession({ ...newDebugSession(), draft: createDebugDraft(protocol, "m", "") });
    const original = parseBody(session.draft.bodyText);
    session.draft.bodyText = JSON.stringify({ ...original, metadata: { keep: true } });
    session.draft = requestWithMessage(session.draft, "hello");
    session = finishChatTurn(withTurn(session, []), "turn", [run()]);
    const next = requestWithMessage(session.draft, "follow-up");
    const body = parseBody(next.bodyText);
    assert.deepEqual(body[protocol === "responses" ? "input" : "messages"], [
      { role: "user", content: "hello" }, { role: "assistant", content: "reply" }, { role: "user", content: "follow-up" },
    ]);
    assert.deepEqual(body.metadata, { keep: true });
    assert.equal(session.turns[0].contextId, 0);
  }
});

test("复杂请求只追加消息，不压平图片和工具结果", () => {
  const body = { model: "m", input: [{ role: "user", content: [{ type: "input_image", image_url: "https://fake.invalid/a.png" }] }], tools: [{ type: "web_search" }] };
  const next = appendChatMessage("responses", body, { role: "user", content: "解释图片" });
  assert.deepEqual(next.input[0], body.input[0]);
  assert.deepEqual(next.tools, body.tools);
  assert.equal(body.input.length, 1);
  assert.throws(() => appendChatMessage("messages", { messages: {} }, { role: "user", content: "hi" }), /消息数组/);
});

test("多个回复先选择上下文，选择不会覆盖刚调整的参数", () => {
  let session = newDebugSession();
  session.draft = requestWithMessage(session.draft, "hello");
  session = finishChatTurn(withTurn(session, []), "turn", [run(1, "one"), run(2, "two")]);
  assert.equal(session.turns[0].contextResolved, false);
  session.draft.bodyText = JSON.stringify({ ...parseBody(session.draft.bodyText), temperature: 0.2, model: "new-model" });
  session = useTurnContext(session, "turn", 2);
  assert.equal(parseBody(session.draft.bodyText).input.at(-1).content, "two");
  assert.equal(parseBody(session.draft.bodyText).temperature, 0.2);
  assert.equal(parseBody(session.draft.bodyText).model, "new-model");
  assert.equal(session.turns[0].contextId, 2);
  assert.equal(useTurnContext(session, "turn", 999), session);
});

test("失败或工具调用不自动混入后续上下文", () => {
  const error = run(1, "bad", { status: 503 });
  const tools = run(2, "", { raw: JSON.stringify({ choices: [{ message: { role: "assistant", content: "thinking", tool_calls: [{ id: "1", type: "function", function: { name: "lookup", arguments: "{}" } }] } }] }) });
  assert.equal(replyText(error), null);
  assert.equal(replyText(tools), null);
  assert.equal(replyText(undefined), null);
  const failed = finishChatTurn(withTurn(newDebugSession(), []), "turn", [error]);
  assert.equal(failed.turns[0].contextResolved, true);
  const waiting = finishChatTurn(withTurn(newDebugSession(), []), "turn", [tools]);
  assert.equal(waiting.turns[0].contextResolved, false);
  assert.equal(useTurnContext(waiting, "turn", null).turns[0].contextResolved, true);
});

test("模型候选按路由分组过滤，指定渠道也允许测试停用渠道", () => {
  const channel = { id: 1, enabled: true, archived: false, group_ids: [1], model_names: ["m"], model_mappings: { alias: "provider-only" } };
  const list = [channel, { ...channel, id: 2, group_ids: [2], model_names: ["private"], model_mappings: {} }, { ...channel, id: 3, enabled: false, model_names: ["disabled"], model_mappings: {} }];
  const session = newDebugSession();
  assert.deepEqual(sessionModels(list, session), ["alias", "m"]);
  assert.deepEqual(sessionModels(list, { ...session, routing: "direct", channels: [3] }), ["disabled"]);
});

test("本机记录保留消息与参数，但排除 HTTP 头和真实请求地址", () => {
  const state = initialSessionState();
  state.sessions[0] = withTurn(state.sessions[0], [run(0, "kept", {
    request: { url: "https://secret-url.invalid", headers: { authorization: "secret-header" }, body: {} },
    responseHeaders: { "set-cookie": "secret-cookie" },
  })]);
  state.sessions[0].input = "draft";
  const encoded = encodeDebugSessions(state);
  assert.doesNotMatch(encoded, /secret-url|secret-header|secret-cookie/);
  const restored = decodeDebugSessions(encoded);
  assert.equal(restored.sessions[0].input, "draft");
  assert.equal(replyText(restored.sessions[0].turns[0].runs[0]), "kept");
  assert.equal(restored.sessions[0].turns[0].runs[0].request, null);
});

test("刷新不恢复网络请求，运行中的记录转为已停止", () => {
  const state = initialSessionState();
  state.sessions[0] = withTurn(state.sessions[0], [run(0, "partial", { phase: "running", elapsedMs: null })]);
  const restored = decodeDebugSessions(encodeDebugSessions(state));
  assert.equal(restored.sessions[0].turns[0].runs[0].phase, "aborted");
  assert.equal(restored.sessions[0].turns[0].contextResolved, true);
  for (const raw of ["{bad", "null", '{"version":2,"sessions":[]}', '{"version":1,"sessions":[{}]}']) assert.equal(decodeDebugSessions(raw), null);
});

test("本机存储冲突和空间不足显式报错，不覆盖其他标签页", () => {
  let value = "initial";
  const storage = { getItem: () => value, setItem: (_, next) => { value = next; } };
  const first = openLocalRecord("key", storage);
  const second = openLocalRecord("key", storage);
  assert.equal(first.save("new"), "");
  assert.match(second.save("stale"), /其他标签页/);
  assert.equal(value, "new");
  const full = openLocalRecord("key", { ...storage, setItem() { throw new Error("quota"); } });
  assert.match(full.save("lost"), /空间不足/);
  assert.equal(value, "new");
});

test("普通聊天在发送前检查生成参数，JSON 模式仍由请求体控制", () => {
  const draft = createDebugDraft("messages", "m", "hi");
  assert.equal(chatParameterProblem(draft), "");
  assert.match(chatParameterProblem({ ...draft, bodyText: '{"model":"m","max_tokens":0}' }), /输出上限/);
  assert.match(chatParameterProblem({ ...draft, bodyText: '{"model":"m","max_tokens":10,"temperature":2}' }), /温度/);
});
