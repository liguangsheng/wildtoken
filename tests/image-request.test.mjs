// 生图页：请求体字段增删、流式开关、响应解析与 base64 折叠。
import assert from "node:assert/strict";
import test from "node:test";

import {
  collapseBase64,
  defaultImageBody,
  parseImageResponse,
  setField,
  sniffFormat,
  withImageStream,
} from "../web/src/imageRequest.ts";

// 1x1 PNG。
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("默认体最小：只带模型、prompt、数量和尺寸", () => {
  assert.deepEqual(defaultImageBody("gpt-image", "cat"), { model: "gpt-image", prompt: "cat", n: 1, size: "1024x1024" });
});

test("「不传」就是把字段删掉", () => {
  assert.deepEqual(setField({ a: 1, quality: "high" }, "quality", ""), { a: 1 });
  assert.deepEqual(setField({ a: 1 }, "quality", "low"), { a: 1, quality: "low" });
});

test("流式开关连带 partial_images，关掉时一起清", () => {
  const on = withImageStream({ model: "m" }, true);
  assert.deepEqual(on, { model: "m", stream: true, partial_images: 2 });
  assert.deepEqual(withImageStream({ ...on, partial_images: 3 }, true).partial_images, 3);
  assert.deepEqual(withImageStream(on, false), { model: "m" });
});

test("按文件头认格式", () => {
  assert.equal(sniffFormat(PNG), "png");
  assert.equal(sniffFormat("/9j/4AAQ"), "jpeg");
  assert.equal(sniffFormat("UklGRiQ"), "webp");
  assert.equal(sniffFormat("abcd"), null);
});

test("非流式：data[] 里的 b64 和 url 都认，带出用量与改写的 prompt", () => {
  const raw = JSON.stringify({
    data: [{ b64_json: PNG, revised_prompt: "a cat" }, { url: "https://x/y.png" }],
    usage: { total_tokens: 9 },
  });
  const result = parseImageResponse(raw);

  assert.equal(result.images.length, 2);
  assert.ok(result.images[0].src.startsWith("data:image/png;base64,iVBOR"));
  assert.equal(result.images[0].format, "png");
  assert.equal(result.images[0].revisedPrompt, "a cat");
  assert.equal(result.images[1].src, "https://x/y.png");
  assert.deepEqual(result.usage, { total_tokens: 9 });
  assert.equal(result.error, null);
});

test("上游错误体解析出 message", () => {
  assert.equal(parseImageResponse('{"error":{"message":"bad size"}}').error, "bad size");
});

test("流式：中间帧带序号，最终图没有；最后一行没收全时跳过", () => {
  const raw = [
    "event: image_generation.partial_image",
    `data: ${JSON.stringify({ type: "image_generation.partial_image", partial_image_index: 0, b64_json: PNG })}`,
    "",
    "event: image_generation.completed",
    `data: ${JSON.stringify({ type: "image_generation.completed", b64_json: PNG, usage: { total_tokens: 5 } })}`,
    "",
    'data: {"type":"image_generation.partial_image","b64_json":"iVBO',
  ].join("\n");
  const result = parseImageResponse(raw);

  assert.deepEqual(result.images.map((image) => image.partialIndex), [0, null]);
  assert.deepEqual(result.usage, { total_tokens: 5 });
});

test("完整响应里的长 base64 折成占位，收尾引号缺失的也折", () => {
  const long = "A".repeat(4000);
  assert.equal(collapseBase64(`{"b64_json":"${long}","n":1}`), '{"b64_json":"<base64 2.9 KB>","n":1}');
  assert.equal(collapseBase64(`{"b64_json":"${long}`), '{"b64_json":"<base64 2.9 KB>');
  // 短字符串不动。
  assert.equal(collapseBase64('{"model":"gpt-image"}'), '{"model":"gpt-image"}');
});
