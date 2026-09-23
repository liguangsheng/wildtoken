import { useMemo, useState } from "react";

import type { Upstream } from "../types";
import type { Run } from "../useDebugRuns";
import { formatElapsed } from "../useTicker";

/** 定格的耗时：一秒内给毫秒，调试要看的正是这一段。跳动中的总计仍用 formatElapsed。 */
function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : formatElapsed(ms);
}

/**
 * 目标渠道多选。带搜索，停用的渠道也列出来——调试停用渠道正是常见场景。
 */
export function ChannelPicker({
  upstreams,
  selected,
  onToggle,
}: {
  upstreams: Upstream[];
  selected: number[];
  onToggle: (id: number) => void;
}) {
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return upstreams;
    return upstreams.filter((item) =>
      [item.name, item.base_url, String(item.id), ...(item.model_names ?? [])].join(" ").toLowerCase().includes(q),
    );
  }, [upstreams, query]);

  return (
    <div className="field">
      <span className="field-label">渠道（已选 {selected.length}）</span>
      <input
        type="search"
        autoComplete="off"
        aria-label="搜索渠道"
        placeholder="名称、Base URL、模型…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="debug-channel-list" role="group" aria-label="目标渠道">
        {visible.length === 0 ? (
          <p className="muted">无匹配渠道</p>
        ) : (
          visible.map((item) => (
            <label key={item.id} className="debug-channel">
              <input type="checkbox" checked={selected.includes(item.id)} onChange={() => onToggle(item.id)} />
              <span>{item.name}</span>
              <span className="muted">{item.enabled ? `#${item.id}` : `#${item.id} · 已停用`}</span>
            </label>
          ))
        )}
      </div>
      <span className="field-hint">多选时同一请求并发发给每个渠道，结果并排对比。</span>
    </div>
  );
}

/** 结果卡的头：渠道名、状态和三段耗时。 */
export function RunHead({ run, now }: { run: Run; now: number }) {
  const statusText =
    run.phase === "running"
      ? run.status === null
        ? "等待响应…"
        : `HTTP ${run.status} · 接收中…`
      : run.status !== null
        ? `HTTP ${run.status}`
        : run.phase === "aborted"
          ? "已停止"
          : "请求失败";

  return (
    <>
      <div className="test-model-result-head">
        <strong>{run.name}</strong>
        <span className="debug-run-meta">
          <span>{statusText}</span>
          <span>响应头 {formatLatency(run.ttfbMs)}</span>
          <span>首块 {formatLatency(run.firstChunkMs)}</span>
          <span>总计 {run.elapsedMs === null ? formatElapsed(now - run.startedAt) : formatLatency(run.elapsedMs)}</span>
        </span>
      </div>
      {run.error ? <p className="debug-run-error">{run.error}</p> : null}
    </>
  );
}

/** 卡片边框的色调：失败红、成功绿、进行中不着色。 */
export function runTone(run: Run): "ok" | "error" | undefined {
  if (run.phase === "error" || (run.status !== null && run.status >= 400)) return "error";
  return run.phase === "done" ? "ok" : undefined;
}

/** 响应按 HTTP 报文排版。body 由调用方给：生图页要先把 base64 折叠掉。 */
export function formatResponse(run: Run, body: string): string {
  const lines = [`HTTP/1.1 ${run.status ?? 0}`];
  for (const [name, value] of Object.entries(run.responseHeaders).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}
