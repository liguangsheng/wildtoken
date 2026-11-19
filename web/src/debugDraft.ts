import { bodyModel, defaultBody, formatBody, parseBody } from "./debugRequest.ts";
import type { JSONObject, TextProtocol } from "./debugRequest.ts";

export const FALLBACK_PROMPT = "用一句话介绍你自己。";

export interface DebugDraft {
  protocol: TextProtocol;
  model: string;
  bodyText: string;
}

export interface TextMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SimpleRequest {
  system: string;
  messages: TextMessage[];
}

function textMessage(value: unknown): value is { role: string; content: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as JSONObject;
  return typeof item.role === "string" && typeof item.content === "string"
    && Object.keys(item).every((key) => key === "role" || key === "content");
}

/** 只接管纯文本消息；带图片、工具调用或额外字段的消息留在 JSON 中。 */
export function simpleRequest(protocol: TextProtocol, body: JSONObject): SimpleRequest | null {
  let system = protocol === "responses" ? body.instructions : protocol === "messages" ? body.system : "";
  const input = protocol === "responses" ? body.input : body.messages;
  const raw = protocol === "responses" && typeof input === "string" ? [{ role: "user", content: input }] : input;
  if (!Array.isArray(raw) || !raw.every(textMessage)) return null;
  let messages = raw;
  if (protocol === "chat_completions" && messages[0]?.role === "system") {
    system = messages[0].content;
    messages = messages.slice(1);
  }
  if (system !== undefined && typeof system !== "string") return null;
  if (!messages.every((message) => message.role === "user" || message.role === "assistant")) return null;
  if (protocol === "chat_completions" && "max_tokens" in body && "max_completion_tokens" in body) return null;
  if ([body[outputTokenKey(protocol, body)], body.temperature].some((value) => value !== undefined
    && (typeof value !== "number" || !Number.isFinite(value)))) return null;
  return { system: system ?? "", messages: messages as TextMessage[] };
}

export function withMessages(protocol: TextProtocol, body: JSONObject, messages: TextMessage[]): JSONObject {
  if (protocol === "responses") {
    const input = typeof body.input === "string" && messages.length === 1 && messages[0].role === "user"
      ? messages[0].content : messages;
    return { ...body, input };
  }
  const previous = body.messages;
  const system = protocol === "chat_completions" && Array.isArray(previous)
    && textMessage(previous[0]) && previous[0].role === "system" ? [previous[0]] : [];
  return { ...body, messages: [...system, ...messages] };
}

export function withSystem(protocol: TextProtocol, body: JSONObject, system: string): JSONObject {
  const simple = simpleRequest(protocol, body);
  if (!simple) return body;
  if (protocol === "chat_completions") {
    return { ...body, messages: [...(system ? [{ role: "system", content: system }] : []), ...simple.messages] };
  }
  const key = protocol === "responses" ? "instructions" : "system";
  const next = { ...body };
  if (system) next[key] = system;
  else delete next[key];
  return next;
}

export function withPrompt(protocol: TextProtocol, body: JSONObject, prompt: string): JSONObject {
  const simple = simpleRequest(protocol, body);
  if (!simple) return body;
  const messages = [...simple.messages];
  const index = messages.map((message) => message.role).lastIndexOf("user");
  if (index < 0) messages.push({ role: "user", content: prompt });
  else messages[index] = { ...messages[index], content: prompt };
  return withMessages(protocol, body, messages);
}

export function outputTokenKey(protocol: TextProtocol, body: JSONObject): string {
  if (protocol === "responses") return "max_output_tokens";
  return protocol === "chat_completions" && "max_completion_tokens" in body ? "max_completion_tokens" : "max_tokens";
}

export function createDebugDraft(
  protocol: TextProtocol = "responses",
  model = "",
  prompt = FALLBACK_PROMPT,
  stream = true,
): DebugDraft {
  return { protocol, model, bodyText: formatBody(defaultBody(protocol, model.trim(), prompt, stream)) };
}

/** JSON 是正文的唯一来源；仅保留与正文模型匹配的 Messages [1m] 头部别名。 */
export function editDebugBody(draft: DebugDraft, bodyText: string): DebugDraft {
  const body = parseBody(bodyText);
  if (!body) return { ...draft, bodyText };
  const name = typeof body.model === "string" ? body.model : "";
  const keepAlias = draft.protocol === "messages" && draft.model.trim().toLowerCase().endsWith("[1m]")
    && bodyModel(draft.protocol, draft.model.trim()) === name.trim();
  return { ...draft, bodyText, model: keepAlias ? draft.model : name };
}

/** 首次打开另一协议只带入通用字段；原协议的完整草稿由调用方保留。 */
export function draftForProtocol(draft: DebugDraft, protocol: TextProtocol): DebugDraft {
  const previous = parseBody(draft.bodyText);
  const next = createDebugDraft(protocol, draft.model, FALLBACK_PROMPT, previous?.stream === true);
  const simple = previous && simpleRequest(draft.protocol, previous);
  if (!previous || !simple) return next;
  let body = parseBody(next.bodyText)!;
  body = withMessages(protocol, body, simple.messages);
  body = withSystem(protocol, body, simple.system);
  const limit = previous[outputTokenKey(draft.protocol, previous)];
  if (typeof limit === "number") body[outputTokenKey(protocol, body)] = limit;
  if (typeof previous.temperature === "number") body.temperature = previous.temperature;
  return { ...next, bodyText: formatBody(body) };
}

export function bodyProblem(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? "" : "请求体必须是 JSON 对象。";
  } catch (error) {
    return `JSON 格式有误：${error instanceof Error ? error.message : "无法解析"}`;
  }
}
