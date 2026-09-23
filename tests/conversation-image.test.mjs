// 日志详情的会话模式：生图请求摊成 prompt + 参数，生图响应画成图，截断的标出来。
import assert from "node:assert/strict";
import test from "node:test";

import { parseConversationRequest, parseConversationResponse } from "../web/src/conversation.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("生图请求：prompt 是用户消息，其余参数排成一行", () => {
  const parsed = parseConversationRequest(
    JSON.stringify({ model: "gpt-image-2", prompt: "一只猫", n: 1, size: "1024x1024" }),
  );

  assert.equal(parsed.model, "gpt-image-2");
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].role, "user");
  assert.deepEqual(parsed.messages[0].blocks, [
    { kind: "text", text: "一只猫" },
    { kind: "text", text: "参数：n=1 · size=1024x1024" },
  ]);
});

test("既无 messages 也无 prompt 的请求仍然认不出", () => {
  assert.equal(parseConversationRequest('{"model":"m"}'), null);
});

test("生图响应：每张图一个带 src 的图片块，改写后的 prompt 跟在后面", () => {
  const parsed = parseConversationResponse(
    JSON.stringify({ data: [{ b64_json: PNG, revised_prompt: "a cat" }], usage: {} }),
  );
  const [image, revised] = parsed.messages[0].blocks;

  assert.equal(parsed.messages[0].role, "assistant");
  assert.equal(image.kind, "image");
  assert.ok(image.src.startsWith("data:image/png;base64,"));
  assert.match(image.text, /^PNG · /);
  assert.deepEqual(revised, { kind: "text", text: "改写后的 prompt：a cat" });
  assert.equal(parsed.complete, true);
});

test("日志截断的生图响应：仍然出图，标成截断，会话记为不完整", () => {
  // 线上实测的形状：data[0].b64_json 被日志上限拦腰截断，没有收尾。
  const parsed = parseConversationResponse(`{"created":1,"data":[{"b64_json":"${PNG.slice(0, 50)}`);
  const [image] = parsed.messages[0].blocks;

  assert.equal(image.kind, "image");
  assert.match(image.text, /截断/);
  assert.equal(parsed.complete, false);
});

test("流式生图：中间帧和终图都出", () => {
  const raw = [
    `data: ${JSON.stringify({ type: "image_generation.partial_image", partial_image_index: 0, b64_json: PNG })}`,
    "",
    `data: ${JSON.stringify({ type: "image_generation.completed", b64_json: PNG })}`,
  ].join("\n");
  const blocks = parseConversationResponse(raw).messages[0].blocks;

  assert.equal(blocks.length, 2);
  assert.match(blocks[0].text, /中间帧 #0/);
  assert.equal(parseConversationResponse(raw).stream, true);
});

test("普通对话响应不受影响", () => {
  const parsed = parseConversationResponse(
    JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }),
  );
  assert.deepEqual(parsed.messages[0].blocks, [{ kind: "text", text: "hi" }]);
});

test("已存为文件的图带下载路径", () => {
  const parsed = parseConversationResponse(JSON.stringify({ data: [{ b64_json: "@image:/images/2026-09-23/x.png" }] }));
  const [image] = parsed.messages[0].blocks;

  assert.equal(image.src, "/images/2026-09-23/x.png");
  assert.equal(image.download, "/images/2026-09-23/x.png");
  assert.match(image.text, /已存为文件/);
  assert.equal(parsed.complete, true);
});
