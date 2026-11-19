import { useMemo, useState } from "react";

import { copyText } from "../clipboard";
import { useToast } from "./feedback";
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
  onSelect,
  loading = false,
}: {
  upstreams: Upstream[];
  selected: number[];
  onToggle: (id: number) => void;
  onSelect?: (ids: number[]) => void;
  loading?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return upstreams.filter((item) =>
      (!onlySelected || selected.includes(item.id))
      && (!q || [item.name, item.base_url, String(item.id), ...(item.model_names ?? [])].join(" ").toLowerCase().includes(q)),
    );
  }, [upstreams, query, onlySelected, selected]);

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
      {onSelect ? (
        <div className="debug-picker-actions">
          <button type="button" className="ghost small" disabled={loading || visible.length === 0 || visible.every((item) => selected.includes(item.id))}
            onClick={() => onSelect([...new Set([...selected, ...visible.map((item) => item.id)])])}>全选结果</button>
          <button type="button" className="ghost small" aria-pressed={onlySelected} onClick={() => setOnlySelected(!onlySelected)}>仅已选</button>
          <button type="button" className="ghost small" disabled={selected.length === 0} onClick={() => onSelect([])}>清空</button>
        </div>
      ) : null}
      <div className="debug-channel-list" role="group" aria-label="目标渠道">
        {loading ? (
          <p className="muted">加载渠道…</p>
        ) : visible.length === 0 ? (
          <p className="muted">无匹配渠道</p>
        ) : (
          visible.map((item) => (
            <label key={item.id} className="debug-channel" title={`${item.name}\n${item.base_url}`}>
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
      : run.phase === "aborted"
        ? `${run.status === null ? "" : `HTTP ${run.status} · `}已停止`
        : run.phase === "error"
          ? `${run.status === null ? "" : `HTTP ${run.status} · `}请求失败`
          : run.status !== null ? `HTTP ${run.status}` : "请求失败";

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

export function DebugCopyButton({ text, label, disabled = false }: { text: string; label: string; disabled?: boolean }) {
  const toast = useToast();
  return <button type="button" className="ghost small" disabled={disabled} onClick={async () => {
    try {
      await copyText(text);
      toast("已复制", { tone: "ok" });
    } catch (error) {
      toast(error instanceof Error ? error.message : "复制失败", { tone: "error" });
    }
  }}>{label}</button>;
}

export function DebugTabs<T extends string>({ id, label, tabs, value, onChange }: {
  id: string;
  label: string;
  tabs: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="debug-tabs" role="tablist" aria-label={label} onKeyDown={(event) => {
      const index = tabs.findIndex((tab) => tab.value === value);
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
        : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
          : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      onChange(tabs[next].value);
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
    }}>
      {tabs.map((tab) => (
        <button key={tab.value} type="button" role="tab" id={`${id}-${tab.value}`} aria-controls={`${id}-panel-${tab.value}`}
          aria-selected={value === tab.value} tabIndex={value === tab.value ? 0 : -1} onClick={() => onChange(tab.value)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** 响应按 HTTP 报文排版。body 由调用方给：生图页要先把 base64 折叠掉。 */
export function formatResponse(run: Run, body: string): string {
  const lines = [`HTTP/1.1 ${run.status ?? 0}`];
  for (const [name, value] of Object.entries(run.responseHeaders).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}
