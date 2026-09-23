/**
 * 调试页的请求体。
 *
 * 默认体照抄后端 modelTestRequest 的三种形状，再按「流式」开关补字段。只是
 * 起点：生成后用户随便改，发出去的是改完的原文。
 */

import type { DebugProtocol } from "./debugApi";
import type { Upstream } from "./types";

export const DEBUG_PROTOCOLS: ReadonlyArray<{ value: DebugProtocol; label: string }> = [
  { value: "responses", label: "Responses（codex-tui）" },
  { value: "chat_completions", label: "Chat Completions（opencode）" },
  { value: "messages", label: "Messages（claude-cli）" },
];

type JSONObject = Record<string, unknown>;

/** [1m] 是 CLI 侧的 1M 上下文别名，只影响请求头；上游只认去掉后缀的 id。 */
function stripContext1M(model: string): string {
  return model.toLowerCase().endsWith("[1m]") ? model.slice(0, -4) : model;
}

/** 请求体里的模型名。messages 协议要去掉 [1m]，和后端一致。 */
export function bodyModel(protocol: DebugProtocol, model: string): string {
  return protocol === "messages" ? stripContext1M(model) : model;
}

export function defaultBody(protocol: DebugProtocol, model: string, prompt: string, stream: boolean): JSONObject {
  const name = bodyModel(protocol, model);
  const body: JSONObject =
    protocol === "responses"
      ? { model: name, input: prompt, max_output_tokens: 1000 }
      : protocol === "chat_completions"
        ? { model: name, messages: [{ role: "user", content: prompt }], max_tokens: 1000 }
        : { model: name, max_tokens: 1000, messages: [{ role: "user", content: prompt }] };
  return withStream(protocol, body, stream);
}

/**
 * 按开关设置 stream。chat_completions 流式默认不带用量，得显式要
 * include_usage，否则日志里这一条 token 数是 0。
 */
export function withStream(protocol: DebugProtocol, body: JSONObject, stream: boolean): JSONObject {
  const next: JSONObject = { ...body };
  if (stream) next.stream = true;
  else delete next.stream;

  if (protocol === "chat_completions") {
    if (stream) next.stream_options = { include_usage: true };
    else delete next.stream_options;
  }
  return next;
}

/** 解析编辑框里的文本。只接受对象，和后端校验一致；不合格返回 null。 */
export function parseBody(text: string): JSONObject | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JSONObject) : null;
  } catch {
    return null;
  }
}

export function formatBody(body: JSONObject): string {
  return JSON.stringify(body, null, 2);
}

/**
 * 模型候选：已选渠道配置的模型取并集，没选就给全部。映射目标也算，和测试
 * 模型对话框同一口径。
 */
export function candidateModels(
  upstreams: Array<Pick<Upstream, "id" | "model_names" | "model_mappings">>,
  selected: number[],
): string[] {
  const source = selected.length > 0 ? upstreams.filter((item) => selected.includes(item.id)) : upstreams;
  const names = source.flatMap((item) => [
    ...(item.model_names ?? []),
    ...Object.values(item.model_mappings ?? {}),
  ]);
  return [...new Set(names.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
