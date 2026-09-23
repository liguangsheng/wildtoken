import { useRef, useState } from "react";
import type { ReactNode } from "react";

import type { Block, Conversation as Parsed, Message } from "../conversation";
import { formatByteSize, pairToolCalls } from "../conversation";

const ROLE_LABELS: Record<string, string> = {
  system: "系统",
  user: "用户",
  assistant: "助手",
  tool: "工具",
  developer: "开发者",
};

function formatCharCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万字`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k 字`;
  return `${count} 字`;
}

/** 系统提示词超过这个长度就默认收起。实测里它们是 6 万到 9 万字节。 */
const SYSTEM_FOLD_THRESHOLD = 1500;

/**
 * 折叠控制：null 是各块按自己的默认值，true/false 是「全部展开 / 全部折叠」。
 * version 每改一次加一，当 details 的 key 用：open 是初始属性，重新挂载才会重新应用。
 */
interface Fold {
  force: boolean | null;
  version: number;
}

/**
 * 压掉噪音空白。
 *
 * 会话视图是拿来读的，而正文里成片的空行会把一条消息撑开好几屏——实测工具
 * 结果有接近一半的行是空行。这里压掉行尾空白、连续空行收成一个、去掉首尾。
 * 行内缩进原样保留：代码和 diff 的缩进是有意义的。要逐字节还原就切原始模式。
 */
function tidy(text: string): string {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 工具入参。
 *
 * 流式重组出来的是拼接的 partial_json，能解析就美化。短入参排成一行——把
 * {"path":"a.go"} 缩进成三行纯属浪费高度，而这种一两个字段的调用占多数。
 */
function formatToolInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return input;
    }
  }
  try {
    const compact = JSON.stringify(value);
    if (compact !== undefined && compact.length <= 120) return compact;
  } catch {
    // 转不了就走下面的缩进版本。
  }
  return safeStringify(value);
}

/**
 * 折叠块。
 *
 * 默认开关由调用方定：思考、工具结果这类一条会话里出现几百次的块默认收着，
 * 否则读一段对话要滚几分钟。summary 留着当标签，收着时也能看出这是什么。
 */
function CollapsibleBlock({
  className,
  summary,
  body,
  open,
  fold,
}: {
  className: string;
  summary: ReactNode;
  body: string;
  open: boolean;
  fold: Fold;
}) {
  return (
    <details key={fold.version} className={`conv-block ${className}`} open={fold.force ?? open}>
      <summary>{summary}</summary>
      <pre className="conv-block-body">{body}</pre>
    </details>
  );
}

/**
 * 有标签的块：单行走内联，多行才折叠。
 *
 * 单行内容不值得一个可折叠块——摘要一行、正文一行，两行装一行的东西。
 */
function LabelledBlock({
  className,
  tag,
  meta,
  body,
  open,
  fold,
}: {
  className: string;
  tag: ReactNode;
  meta?: string;
  body: string;
  open: boolean;
  fold: Fold;
}) {
  if (body && !body.includes("\n")) {
    return (
      <div className={`conv-block conv-block--inline ${className}`}>
        {tag}
        <span className="conv-inline-body">{body}</span>
      </div>
    );
  }
  const summary = meta ? (
    <>
      {tag} <span className="conv-block-meta">{meta}</span>
    </>
  ) : (
    tag
  );
  return <CollapsibleBlock className={className} summary={summary} body={body} open={open} fold={fold} />;
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="conv-block-tag">{children}</span>;
}

/** 入参的一行预览，收着时也能看出调的是哪个文件、哪条命令。 */
function previewInput(input: unknown): string {
  const text = formatToolInput(input).replace(/\s+/g, " ").trim();
  return text.length > 96 ? `${text.slice(0, 96)}…` : text;
}

/**
 * 工具调用和它的结果合成一块：标题行是「调了什么 → 结果多大」，展开才看入参全文和结果。
 * 默认收着：一条 agent 会话里这样的块有上百个。
 */
function ToolCallBlock({
  block,
  fold,
}: {
  block: Extract<Block, { kind: "tool_call" }>;
  fold: Fold;
}) {
  const input = formatToolInput(block.input);
  const longInput = input.includes("\n") || input.length > 96;
  const result = block.result ? tidy(block.result.text) : null;
  const isError = Boolean(block.result?.isError);

  return (
    <details
      key={fold.version}
      className={isError ? "conv-block conv-block--tool-call is-error" : "conv-block conv-block--tool-call"}
      open={fold.force ?? false}
    >
      <summary>
        <Tag>调用</Tag> {block.name || "工具"}
        {input ? <span className="conv-tool-input-preview">{previewInput(block.input)}</span> : null}
        <span className="conv-block-meta">
          {block.result === null
            ? "→ 未记录结果"
            : `→ ${isError ? "报错" : "结果"} ${formatCharCount(result?.length ?? 0)}`}
        </span>
      </summary>
      {longInput ? (
        <>
          <div className="conv-tool-section">入参</div>
          <pre className="conv-block-body">{input}</pre>
        </>
      ) : null}
      {result !== null ? (
        <>
          <div className="conv-tool-section">{isError ? "报错" : "结果"}</div>
          <pre className="conv-block-body conv-tool-result">{result || "(空)"}</pre>
        </>
      ) : null}
    </details>
  );
}

function ConversationBlock({ block, role, fold }: { block: Block; role: string; fold: Fold }) {
  switch (block.kind) {
    case "text": {
      const text = tidy(block.text);
      if (!text) return null;
      // 系统提示词动辄几万字，默认收起；标题行露首行，知道是哪套提示词。
      if (role === "system" && text.length > SYSTEM_FOLD_THRESHOLD) {
        const firstLine = text.split("\n", 1)[0];
        return (
          <CollapsibleBlock
            className="conv-block--system"
            summary={
              <>
                <Tag>系统提示词</Tag> <span className="conv-block-meta">{formatCharCount(text.length)}</span>
                <span className="conv-tool-input-preview">
                  {firstLine.length > 96 ? `${firstLine.slice(0, 96)}…` : firstLine}
                </span>
              </>
            }
            body={text}
            open={false}
            fold={fold}
          />
        );
      }
      // 正文一律平铺，不折叠。
      return (
        <div className="conv-block conv-block--text">
          <pre className="conv-block-body">{text}</pre>
        </div>
      );
    }
    case "thinking": {
      const text = tidy(block.text);
      if (!text) return null;
      return (
        <LabelledBlock
          className="conv-block--thinking"
          tag={<Tag>思考</Tag>}
          meta={formatCharCount(text.length)}
          body={text}
          open={false}
          fold={fold}
        />
      );
    }
    case "tool_call":
      return <ToolCallBlock block={block} fold={fold} />;
    case "tool_use":
      return (
        <LabelledBlock
          className="conv-block--tool-use"
          tag={
            <>
              <Tag>调用</Tag> {block.name || "工具"}
            </>
          }
          body={formatToolInput(block.input)}
          open={false}
          fold={fold}
        />
      );
    case "tool_result": {
      const text = tidy(block.text);
      return (
        <LabelledBlock
          className={block.isError ? "conv-block--tool-result is-error" : "conv-block--tool-result"}
          tag={<Tag>{block.isError ? "工具报错" : "工具结果"}</Tag>}
          meta={formatCharCount(text.length)}
          body={text}
          open={false}
          fold={fold}
        />
      );
    }
    case "image":
      if (block.src) {
        return (
          <figure className="conv-block conv-block--image conv-image">
            <img src={block.src} alt={block.text} loading="lazy" />
            <figcaption>{block.text}</figcaption>
          </figure>
        );
      }
      return <div className="conv-block conv-block--image">{block.text || "[图片]"}</div>;
    case "error":
      return <div className="conv-block conv-block--error">{block.text || "错误"}</div>;
    default:
      return (
        <CollapsibleBlock
          className="conv-block--other"
          summary={<Tag>{block.label || "其他"}</Tag>}
          body={safeStringify(block.input)}
          open={false}
          fold={fold}
        />
      );
  }
}

function ConversationMessage({ message, index, fold }: { message: Message; index: number; fold: Fold }) {
  const role = String(message.role || "user");
  const blocks = message.blocks
    .map((block, position) => <ConversationBlock key={position} block={block} role={role} fold={fold} />)
    .filter(Boolean);
  if (blocks.every((node) => node === null)) return null;

  return (
    /* 角色放在左侧窄栏而不是单独一行：26% 的消息内容只有一两行，一个专门的
       标题行等于把它们的高度翻倍。 */
    <li className={`conv-msg conv-msg--${role}`}>
      <div className="conv-msg-role">
        <span className="conv-role-name">{ROLE_LABELS[role] ?? role}</span>
        <span className="conv-msg-index">{index + 1}</span>
      </div>
      <div className="conv-msg-blocks">{blocks}</div>
    </li>
  );
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="conv-empty">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

/** meta 来自 normalizeSnapshotBody：正文被截断时要说清楚丢了什么。 */
export function Conversation({
  parsed,
  byteLength,
  capturedLength,
  truncated,
}: {
  parsed: Parsed | null;
  byteLength: number | null;
  capturedLength: number | null;
  truncated: boolean;
}) {
  const [fold, setFold] = useState<Fold>({ force: null, version: 0 });
  const listRef = useRef<HTMLOListElement>(null);

  if (!parsed) {
    return (
      <Empty
        title="这段正文无法解析成会话"
        detail="可能不是对话请求，或上游返回的不是 JSON（例如网关的 HTML 错误页）。切换到原始模式查看完整内容。"
      />
    );
  }

  const messages = pairToolCalls(parsed.messages).filter((message) => message.blocks.length > 0);
  if (messages.length === 0) {
    return (
      <Empty
        title="没有可显示的消息"
        detail="正文解析成功，但其中不含消息内容。切换到原始模式查看完整内容。"
      />
    );
  }

  // 数一下有多少块是收着的，读者才知道「全部展开」会展开什么。
  let toolCalls = 0;
  let thoughts = 0;
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind === "tool_call" || block.kind === "tool_use") toolCalls += 1;
      else if (block.kind === "thinking") thoughts += 1;
    }
  }

  const summary: string[] = [];
  if (parsed.model) summary.push(parsed.model);
  summary.push(`${messages.length} 轮`);
  if (toolCalls > 0) summary.push(`${toolCalls} 次工具调用`);
  if (thoughts > 0) summary.push(`${thoughts} 段思考`);
  if (parsed.stopReason) summary.push(`结束原因 ${parsed.stopReason}`);
  if (parsed.stream) summary.push("流式重组");

  // 正文被截断时说清楚恢复了多少、丢了多少，避免把残缺的会话误当成全部。
  const incomplete = !parsed.complete || truncated;
  const notice: string[] = [`已恢复 ${parsed.messages.length} 条消息`];
  const original = formatByteSize(byteLength);
  const captured = formatByteSize(capturedLength);
  if (original && captured && original !== captured) {
    notice.push(`原始正文 ${original}，日志仅记录前 ${captured}`);
  } else if (original) {
    notice.push(`原始正文 ${original}`);
  }

  function setAll(force: boolean | null) {
    setFold((current) => ({ force, version: current.version + 1 }));
  }

  function jumpToEnd() {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "end" });
  }

  return (
    <>
      <div className="conv-summary">
        <span>{summary.join(" · ")}</span>
        <span className="conv-summary-actions">
          <button type="button" className="conv-fold-all" onClick={() => setAll(true)}>
            全部展开
          </button>
          <button type="button" className="conv-fold-all" onClick={() => setAll(false)}>
            全部折叠
          </button>
          <button type="button" className="conv-fold-all" onClick={jumpToEnd}>
            跳到末尾
          </button>
        </span>
      </div>
      <ol className="conv-list" ref={listRef}>
        {messages.map((message, index) => (
          <ConversationMessage key={index} message={message} index={index} fold={fold} />
        ))}
      </ol>
      {incomplete ? (
        <div className="conv-truncated">
          <strong>正文被截断，末尾的消息已丢失</strong>
          <span>{notice.join(" · ")}</span>
        </div>
      ) : null}
    </>
  );
}
