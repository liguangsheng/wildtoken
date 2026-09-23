/* 把日志快照里的请求/响应正文解析成会话。
 *
 * 这里的正文几乎总是被截断的：日志正文上限 1MB，而 Claude Code 一轮请求常常
 * 超过它，截断保留开头、丢弃结尾。所以标准 JSON.parse 对绝大多数日志都会失败,
 * 下面这套扫描器的存在意义就是从残缺 JSON 里尽量多地抢救出消息。
 *
 * 生图请求没有 messages，只有 prompt；它的响应是图而不是文字。两者也按会话
 * 摊开：prompt 算用户消息，图算助手回复。
 *
 * 纯函数，不碰 DOM。渲染在 components/Conversation.tsx。 */

// 带 .ts 扩展名：测试用 node 直接加载这个文件，node 的 ESM 不补扩展名。
import { formatBytes, parseImageResponse } from "./imageRequest.ts";

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; name: string; id: string | null; input: unknown }
  | { kind: "tool_result"; id: string | null; isError: boolean; text: string }
  /** 解析层不产这个；由 pairToolCalls 把 tool_use 和它的 tool_result 合成一块。 */
  | {
      kind: "tool_call";
      name: string;
      id: string | null;
      input: unknown;
      result: { isError: boolean; text: string } | null;
    }
  /**
   * src 有值时直接画图（生图的结果）；没有时 text 是一句描述（请求里的图）。
   * download 是服务端存下的文件路径，可直接下载。
   */
  | { kind: "image"; text: string; src?: string; download?: string }
  | { kind: "error"; text: string }
  | { kind: "other"; label: string; input: unknown };

export interface Message {
  role: string;
  blocks: Block[];
}

export interface Conversation {
  kind: "request" | "response";
  model: string | null;
  messages: Message[];
  toolCount: number;
  stopReason: string | null;
  stream: boolean;
  /** 会话本身是否完整。截断发生在别的键上不算。 */
  complete: boolean;
}

/** 正文的形态。cleared 是保留策略清的，missing 是根本没记。 */
export type SnapshotBody =
  | { kind: "text"; text: string; byteLength: number | null; truncated: boolean }
  | { kind: "base64"; base64: string; byteLength: number | null; truncated: boolean }
  | { kind: "cleared" }
  | { kind: "empty" }
  | { kind: "missing" };

type JSONObject = Record<string, unknown>;

/* ── 容错 JSON 扫描 ───────────────────────────────────────── */

/**
 * 从 start 处读出一个完整的 JSON 值。
 *
 * 返回 [值文本, 结束下标]；读到文本末尾仍未闭合（即被截断）时返回 null。
 */
function readJsonValue(text: string, start: number): [string, number] | null {
  const first = text[start];

  if (first === '"') {
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] === '"') return [text.slice(start, i + 1), i + 1];
      i += 1;
    }
    return null;
  }

  if (first === "{" || first === "[") {
    let depth = 0;
    let inString = false;
    let i = start;
    while (i < text.length) {
      const char = text[i];
      if (inString) {
        if (char === "\\") {
          i += 2;
          continue;
        }
        if (char === '"') inString = false;
        i += 1;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) return [text.slice(start, i + 1), i + 1];
      }
      i += 1;
    }
    return null;
  }

  const literal = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(start));
  return literal ? [literal[1], start + literal[1].length] : null;
}

/**
 * 遍历根对象最外层的键值对。
 *
 * 截断时返回已经读到的部分，最后一个键的值会带 complete:false——调用方可以
 * 再对它做元素级抢救。
 */
function scanTopLevelEntries(text: string): Map<string, { text: string; complete: boolean }> {
  const entries = new Map<string, { text: string; complete: boolean }>();
  let i = text.indexOf("{");
  if (i < 0) return entries;
  i += 1;

  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i += 1;
    if (text[i] === "}" || i >= text.length) break;
    if (text[i] !== '"') break;

    const keyRead = readJsonValue(text, i);
    if (!keyRead) break;
    let key: string;
    try {
      key = JSON.parse(keyRead[0]) as string;
    } catch {
      break;
    }
    i = keyRead[1];

    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] !== ":") break;
    i += 1;
    while (i < text.length && /\s/.test(text[i])) i += 1;

    const valueRead = readJsonValue(text, i);
    if (!valueRead) {
      entries.set(key, { text: text.slice(i), complete: false });
      break;
    }
    entries.set(key, { text: valueRead[0], complete: true });
    i = valueRead[1];
  }

  return entries;
}

/** 从一个可能不完整的 JSON 数组文本里，逐个取出能完整解析的元素。 */
function salvageArrayItems(arrayText: string): { items: unknown[]; complete: boolean } {
  const items: unknown[] = [];
  let i = arrayText.indexOf("[");
  if (i < 0) return { items, complete: false };
  i += 1;

  while (i < arrayText.length) {
    while (i < arrayText.length && /[\s,]/.test(arrayText[i])) i += 1;
    if (arrayText[i] === "]") return { items, complete: true };
    const read = readJsonValue(arrayText, i);
    if (!read) return { items, complete: false };
    try {
      items.push(JSON.parse(read[0]));
    } catch {
      return { items, complete: false };
    }
    i = read[1];
  }
  return { items, complete: false };
}

/**
 * 把正文解析成一个浅层对象。
 *
 * 完整正文走标准解析，截断正文逐键抢救；arrayKeys 里的键在自身被截断时还会
 * 做元素级抢救。
 */
function parseLenientRoot(
  text: string,
  arrayKeys: string[],
): { value: JSONObject; complete: boolean; salvagedKeys: Set<string> } | null {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return { value: parsed as JSONObject, complete: true, salvagedKeys: new Set() };
  } catch {
    // 截断，往下走抢救。
  }

  const entries = scanTopLevelEntries(raw);
  if (entries.size === 0) return null;

  const value: JSONObject = {};
  const salvagedKeys = new Set<string>();
  let complete = true;
  for (const [key, entry] of entries) {
    if (entry.complete) {
      try {
        value[key] = JSON.parse(entry.text);
      } catch {
        complete = false;
      }
      continue;
    }
    complete = false;
    if (!arrayKeys.includes(key)) continue;
    const salvaged = salvageArrayItems(entry.text);
    if (salvaged.items.length > 0) {
      value[key] = salvaged.items;
      salvagedKeys.add(key);
    }
  }
  return { value, complete, salvagedKeys };
}

/* ── 正文形态 ─────────────────────────────────────────────── */

/** 快照正文有四种历史形态，全部归一到一个判别联合。 */
export function normalizeSnapshotBody(rawBody: unknown): SnapshotBody {
  if (rawBody === null || rawBody === undefined) return { kind: "missing" };

  // 早期后端直接存 UTF-8 字符串。
  if (typeof rawBody === "string") {
    return {
      kind: "text",
      text: rawBody,
      byteLength: new TextEncoder().encode(rawBody).length,
      truncated: false,
    };
  }
  if (typeof rawBody !== "object") return { kind: "missing" };

  const body = rawBody as JSONObject;
  if (body.cleared) return { kind: "cleared" };

  const byteLength =
    typeof body.byte_length === "number"
      ? body.byte_length
      : typeof body.size === "number"
        ? body.size
        : null;

  if (typeof body.text === "string") {
    return { kind: "text", text: body.text, byteLength, truncated: Boolean(body.truncated) };
  }

  const base64 =
    typeof body.base64 === "string"
      ? body.base64
      : typeof body.base64_truncated === "string"
        ? body.base64_truncated
        : null;
  if (base64 !== null) {
    return {
      kind: "base64",
      base64,
      byteLength,
      truncated: Boolean(body.truncated || body.base64_truncated),
    };
  }

  if (byteLength === 0) return { kind: "empty" };
  return { kind: "missing" };
}

/* ── 请求解析 ─────────────────────────────────────────────── */

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** base64 长度反推原始字节数，够用来说明体积。 */
function formatApproxBytes(length: number): string {
  const bytes = Math.floor((length * 3) / 4);
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

export function formatByteSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function describeImageBlock(block: JSONObject): string {
  const source = (block.source ?? {}) as JSONObject;
  const mediaType = (source.media_type as string) || (source.type as string) || "image";
  if (typeof source.data === "string") {
    return `[图片 ${mediaType}，${formatApproxBytes(source.data.length)}]`;
  }
  if (typeof source.url === "string") return `[图片 ${source.url}]`;
  return `[图片 ${mediaType}]`;
}

function stringifyToolResult(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as JSONObject).text === "string") {
          return (part as JSONObject).text as string;
        }
        return safeStringify(part);
      })
      .join("\n");
  }
  return safeStringify(content);
}

/** 把一条消息的 content 归一成统一的块数组，渲染层只认这一种形状。 */
function normalizeContentBlocks(content: unknown): Block[] {
  if (typeof content === "string") {
    return content ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks: Block[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      blocks.push({ kind: "text", text: raw });
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const block = raw as JSONObject;

    switch (block.type) {
      case "text":
      case "input_text":
      case "output_text":
        blocks.push({ kind: "text", text: String(block.text ?? "") });
        break;
      case "thinking":
      case "redacted_thinking":
        blocks.push({ kind: "thinking", text: String(block.thinking ?? block.data ?? "") });
        break;
      case "tool_use":
      case "function_call":
        blocks.push({
          kind: "tool_use",
          name: String(block.name ?? "工具"),
          id: (block.id ?? block.call_id ?? null) as string | null,
          input: block.input ?? block.arguments ?? null,
        });
        break;
      case "tool_result":
      case "function_call_output":
        blocks.push({
          kind: "tool_result",
          id: (block.tool_use_id ?? block.call_id ?? null) as string | null,
          isError: Boolean(block.is_error),
          text: stringifyToolResult(block.content ?? block.output),
        });
        break;
      case "image":
      case "input_image":
        blocks.push({ kind: "image", text: describeImageBlock(block) });
        break;
      default:
        blocks.push({ kind: "other", label: String(block.type ?? "未知块"), input: block });
    }
  }
  return blocks;
}

/** system 可以是字符串，也可以是 [{type:"text"}]（Anthropic 的写法）。 */
function normalizeSystemPrompt(system: unknown, instructions: unknown): Message | null {
  const source = system ?? instructions;
  if (!source) return null;
  const blocks = normalizeContentBlocks(source);
  return blocks.length > 0 ? { role: "system", blocks } : null;
}

/**
 * 把工具调用和它的结果合成一块。
 *
 * 协议上工具调用至少占两条消息，而且两家写法不一样：
 *   - Anthropic：一条 user 消息里装下一轮全部 tool_result。
 *   - OpenAI：一条 assistant 带 N 个 tool_calls，结果分成 N 条连续的 role:tool 消息。
 * 所以不能只看「紧接着的下一条」，要一直吐完后面只装匹配结果的消息。
 *
 * agent 长会话里这种配对占了绝大多数——实测 25 条真实会话里 14703 条消息
 * 含 6848 次调用。拆开显示时读者得自己把调用和结果对上。
 *
 * 遇到带其它内容的消息就停：吸走匹配的结果，剩下的块（比如用户顺手补的
 * 一句话）原位留着。没有 id 的调用（老协议）不配对。
 */
export function pairToolCalls(messages: Message[]): Message[] {
  const out: Message[] = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const pending = new Set<string>();
    for (const block of message.blocks) {
      if (block.kind === "tool_use" && block.id !== null) pending.add(block.id);
    }
    if (pending.size === 0) {
      out.push(message);
      continue;
    }

    const results = new Map<string, { isError: boolean; text: string }>();
    let trailing: Message | null = null;
    let scan = i + 1;

    while (scan < messages.length && pending.size > 0) {
      const candidate = messages[scan];
      const leftover: Block[] = [];
      let matched = 0;

      for (const block of candidate.blocks) {
        if (block.kind === "tool_result" && block.id !== null && pending.has(block.id)) {
          results.set(block.id, { isError: block.isError, text: block.text });
          pending.delete(block.id);
          matched += 1;
        } else {
          leftover.push(block);
        }
      }

      if (matched === 0) break;
      scan += 1;
      if (leftover.length > 0) {
        trailing = { role: candidate.role, blocks: leftover };
        break;
      }
    }

    out.push({
      role: message.role,
      blocks: message.blocks.map((block): Block => {
        if (block.kind !== "tool_use") return block;
        const result = block.id === null ? null : (results.get(block.id) ?? null);
        return { kind: "tool_call", name: block.name, id: block.id, input: block.input, result };
      }),
    });
    if (trailing) out.push(trailing);
    i = scan - 1;
  }

  return out;
}

/**
 * 生图请求：prompt 是用户消息，其余参数（尺寸、数量、质量…）排成一行附在
 * 后面——看一条生图日志，最先想知道的就是「画了什么、按什么参数画」。
 */
function parseImageGenerationRequest(body: JSONObject, complete: boolean): Conversation | null {
  if (typeof body.prompt !== "string") return null;

  const params = Object.entries(body)
    .filter(([key]) => key !== "model" && key !== "prompt")
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  const blocks: Block[] = [{ kind: "text", text: body.prompt }];
  if (params.length > 0) blocks.push({ kind: "text", text: `参数：${params.join(" · ")}` });

  return {
    kind: "request",
    model: typeof body.model === "string" ? body.model : null,
    messages: [{ role: "user", blocks }],
    toolCount: 0,
    stopReason: null,
    stream: body.stream === true,
    complete,
  };
}

/** 返回 null 表示这不是一个能识别的会话请求。 */
export function parseConversationRequest(bodyText: string): Conversation | null {
  const root = parseLenientRoot(bodyText, ["messages", "input"]);
  if (!root) return null;

  const body = root.value;
  const rawMessages = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : null;
  if (!rawMessages) return parseImageGenerationRequest(body, root.complete);

  const messages: Message[] = [];
  const system = normalizeSystemPrompt(body.system, body.instructions);
  if (system) messages.push(system);

  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as JSONObject;
    const blocks = normalizeContentBlocks(entry.content);

    // chat/completions 把工具调用放在消息对象上而不是 content 里。
    if (Array.isArray(entry.tool_calls)) {
      for (const item of entry.tool_calls) {
        const call = (item ?? {}) as JSONObject;
        const fn = (call.function ?? {}) as JSONObject;
        blocks.push({
          kind: "tool_use",
          name: String(fn.name ?? call.name ?? "工具"),
          id: (call.id ?? null) as string | null,
          input: fn.arguments ?? call.arguments ?? null,
        });
      }
    }

    // OpenAI 的工具返回是一条 role:tool 的普通消息。
    if (entry.role === "tool" && typeof entry.content === "string") {
      messages.push({
        role: "tool",
        blocks: [
          {
            kind: "tool_result",
            id: (entry.tool_call_id ?? null) as string | null,
            isError: false,
            text: entry.content,
          },
        ],
      });
      continue;
    }

    if (blocks.length === 0) continue;
    messages.push({ role: String(entry.role || "user"), blocks });
  }

  const messagesKey = Array.isArray(body.messages) ? "messages" : "input";
  return {
    kind: "request",
    model: typeof body.model === "string" ? body.model : null,
    messages,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    stopReason: null,
    stream: false,
    /* 会话本身是否完整，取决于消息数组有没有被截断——正文尾部的 tools 之类
       被截掉不影响已经读全的对话。 */
    complete: root.complete || !root.salvagedKeys.has(messagesKey),
  };
}

/* ── 响应解析 ─────────────────────────────────────────────── */

/**
 * 取出 SSE 里每个 data: 行的负载。
 *
 * 事件名不需要——每条负载自己带 type 字段，而且截断的最后一行直接丢掉。
 */
function readSsePayloads(text: string): JSONObject[] {
  const payloads: JSONObject[] = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") payloads.push(parsed as JSONObject);
    } catch {
      // 截断的最后一行，或非 JSON 的心跳，跳过。
    }
  }
  return payloads;
}

interface StreamBlock {
  type: string;
  text: string;
  thinking: string;
  name: string | null;
  id: string | null;
  partialJson: string;
}

function toRenderBlock(block: StreamBlock): Block {
  if (block.type === "thinking" || block.type === "redacted_thinking") {
    return { kind: "thinking", text: block.thinking || block.text };
  }
  if (block.type === "tool_use") {
    return { kind: "tool_use", name: block.name || "工具", id: block.id, input: block.partialJson };
  }
  if (block.type === "error") return { kind: "error", text: block.text };
  return { kind: "text", text: block.text };
}

type Assembled = { blocks: Block[]; stopReason: string | null };

/** Anthropic 流式：按 index 累积 content_block，delta 往上拼。 */
function reassembleAnthropicStream(payloads: JSONObject[]): Assembled | null {
  const blocks = new Map<number, StreamBlock>();
  let stopReason: string | null = null;
  let sawStream = false;

  const ensure = (index: number, seed: StreamBlock) => {
    if (!blocks.has(index)) blocks.set(index, seed);
    return blocks.get(index) as StreamBlock;
  };
  const blank = (): StreamBlock => ({
    type: "text",
    text: "",
    thinking: "",
    name: null,
    id: null,
    partialJson: "",
  });

  for (const event of payloads) {
    const type = event.type;
    if (type === "content_block_start") {
      sawStream = true;
      const start = (event.content_block ?? {}) as JSONObject;
      ensure(event.index as number, {
        ...blank(),
        type: (start.type as string) || "text",
        text: typeof start.text === "string" ? start.text : "",
        thinking: typeof start.thinking === "string" ? start.thinking : "",
        name: (start.name as string) || null,
        id: (start.id as string) || null,
      });
    } else if (type === "content_block_delta") {
      sawStream = true;
      const block = ensure(event.index as number, blank());
      const delta = (event.delta ?? {}) as JSONObject;
      if (typeof delta.text === "string") block.text += delta.text;
      if (typeof delta.thinking === "string") block.thinking += delta.thinking;
      if (typeof delta.partial_json === "string") block.partialJson += delta.partial_json;
    } else if (type === "message_delta") {
      const delta = (event.delta ?? {}) as JSONObject;
      if (delta.stop_reason) stopReason = String(delta.stop_reason);
    } else if (type === "error" && event.error) {
      sawStream = true;
      const error = event.error as JSONObject;
      ensure(-1, {
        ...blank(),
        type: "error",
        text: String(error.message || error.type || "上游返回错误"),
      });
    }
  }
  if (!sawStream) return null;

  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
  return { blocks: ordered.map(toRenderBlock), stopReason };
}

/** OpenAI 流式：把 choices[].delta 累积起来。 */
function reassembleOpenAIStream(payloads: JSONObject[]): Assembled | null {
  let text = "";
  const toolCalls = new Map<string | number, { name: string; id: string | null; args: string }>();
  let finishReason: string | null = null;
  let sawStream = false;

  for (const event of payloads) {
    const choice = Array.isArray(event.choices) ? (event.choices[0] as JSONObject) : null;
    if (!choice) continue;
    sawStream = true;
    if (choice.finish_reason) finishReason = String(choice.finish_reason);
    const delta = (choice.delta ?? {}) as JSONObject;
    if (typeof delta.content === "string") text += delta.content;
    if (typeof delta.reasoning_content === "string") text += delta.reasoning_content;

    for (const item of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const call = (item ?? {}) as JSONObject;
      const fn = (call.function ?? {}) as JSONObject;
      const key = (call.index ?? call.id ?? toolCalls.size) as string | number;
      const existing = toolCalls.get(key) ?? { name: "", id: (call.id as string) || null, args: "" };
      if (fn.name) existing.name = String(fn.name);
      if (call.id) existing.id = String(call.id);
      if (typeof fn.arguments === "string") existing.args += fn.arguments;
      toolCalls.set(key, existing);
    }
  }
  if (!sawStream) return null;

  const blocks: Block[] = [];
  if (text) blocks.push({ kind: "text", text });
  for (const call of toolCalls.values()) {
    blocks.push({ kind: "tool_use", name: call.name || "工具", id: call.id, input: call.args });
  }
  return { blocks, stopReason: finishReason };
}

/** Responses API 流式：增量事件带 delta 字符串。 */
function reassembleResponsesStream(payloads: JSONObject[]): Assembled | null {
  let text = "";
  let sawStream = false;
  for (const event of payloads) {
    if (typeof event.type !== "string" || !event.type.startsWith("response.")) continue;
    if (typeof event.delta === "string") {
      sawStream = true;
      text += event.delta;
    }
  }
  return sawStream ? { blocks: text ? [{ kind: "text", text }] : [], stopReason: null } : null;
}

/** 非流式响应：Anthropic 的 content[]，OpenAI 的 choices[].message。 */
function parseNonStreamResponse(body: JSONObject): Assembled | null {
  if (Array.isArray(body.content)) {
    return {
      blocks: normalizeContentBlocks(body.content),
      stopReason: (body.stop_reason as string) ?? null,
    };
  }

  const choice = Array.isArray(body.choices) ? (body.choices[0] as JSONObject) : null;
  if (choice && choice.message) {
    const message = choice.message as JSONObject;
    const blocks = normalizeContentBlocks(message.content);
    for (const item of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const call = (item ?? {}) as JSONObject;
      const fn = (call.function ?? {}) as JSONObject;
      blocks.push({
        kind: "tool_use",
        name: String(fn.name ?? "工具"),
        id: (call.id ?? null) as string | null,
        input: fn.arguments ?? null,
      });
    }
    return { blocks, stopReason: (choice.finish_reason as string) ?? null };
  }

  if (Array.isArray(body.output)) {
    const blocks: Block[] = [];
    for (const item of body.output) {
      blocks.push(...normalizeContentBlocks((item as JSONObject)?.content));
    }
    return { blocks, stopReason: (body.status as string) ?? null };
  }

  if (body.error) {
    const error = body.error as JSONObject;
    return {
      blocks: [{ kind: "error", text: String(error.message || error.type || "上游返回错误") }],
      stopReason: null,
    };
  }
  return null;
}

/**
 * 生图响应：每张图一个图片块，附格式、大小；日志截断了的标出来，免得把只剩
 * 上半截的图当成出图有问题。
 */
function parseImageGenerationResponse(raw: string): Conversation | null {
  // 先粗筛，别让每条对话日志都过一遍图片解析。
  if (!/"b64_json"|image_generation\.|"data"\s*:\s*\[\s*\{\s*"url"/.test(raw)) return null;

  const result = parseImageResponse(raw);
  if (result.images.length === 0) return null;

  const blocks: Block[] = [];
  for (const image of result.images) {
    const caption = [
      image.format?.toUpperCase() ?? "图片",
      image.bytes !== null ? formatBytes(image.bytes) : null,
      image.partialIndex !== null ? `中间帧 #${image.partialIndex}` : null,
      image.stored ? "已存为文件" : null,
      image.truncated ? "日志正文被截断，只存下了这张图的前一部分，缺的部分显示为空白" : null,
    ].filter(Boolean);
    blocks.push({
      kind: "image",
      text: caption.join(" · "),
      src: image.src,
      ...(image.stored ? { download: image.src } : {}),
    });
    if (image.revisedPrompt) blocks.push({ kind: "text", text: `改写后的 prompt：${image.revisedPrompt}` });
  }

  return {
    kind: "response",
    model: null,
    messages: [{ role: "assistant", blocks }],
    toolCount: 0,
    stopReason: null,
    stream: /^data:/m.test(raw),
    complete: !result.images.some((image) => image.truncated),
  };
}

/** 返回 null 表示识别不了。 */
export function parseConversationResponse(bodyText: string): Conversation | null {
  const raw = String(bodyText || "").trim();
  if (!raw) return null;

  const images = parseImageGenerationResponse(raw);
  if (images) return images;

  if (/^data:/m.test(raw)) {
    const payloads = readSsePayloads(raw);
    if (payloads.length === 0) return null;
    const assembled =
      reassembleAnthropicStream(payloads) ??
      reassembleOpenAIStream(payloads) ??
      reassembleResponsesStream(payloads);
    if (!assembled) return null;
    return {
      kind: "response",
      model: null,
      messages: assembled.blocks.length > 0 ? [{ role: "assistant", blocks: assembled.blocks }] : [],
      toolCount: 0,
      stopReason: assembled.stopReason,
      stream: true,
      // 流式正文按行解析，截断只会丢掉最后一行，前面重组出的内容依然可信。
      complete: true,
    };
  }

  const root = parseLenientRoot(raw, ["content", "choices", "output"]);
  if (!root) return null;
  const assembled = parseNonStreamResponse(root.value);
  if (!assembled) return null;
  return {
    kind: "response",
    model: null,
    messages: assembled.blocks.length > 0 ? [{ role: "assistant", blocks: assembled.blocks }] : [],
    toolCount: 0,
    stopReason: assembled.stopReason,
    stream: false,
    complete: root.complete,
  };
}
