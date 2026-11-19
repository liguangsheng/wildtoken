import { useId, useMemo, useState } from "react";

import { ROUTED_TARGET } from "../debugApi";
import { parseConversationResponse } from "../conversation";
import type { Run } from "../useDebugRuns";
import { Conversation } from "./Conversation";
import { DebugCopyButton, DebugTabs, RunHead, formatResponse, runTone } from "./DebugParts";
import { formatRequest } from "./ModelTestDialog";

const TABS = [
  { value: "reply", label: "回复" },
  { value: "raw", label: "原始响应" },
  { value: "request", label: "请求" },
] as const;

type ResultTab = typeof TABS[number]["value"];

export function DebugRunCard({ run, now, onReuse }: { run: Run; now: number; onReuse?: () => void }) {
  const [tab, setTab] = useState<ResultTab>("reply");
  const id = useId();
  const parsed = useMemo(() => run.raw ? parseConversationResponse(run.raw) : null, [run.raw]);
  const reply = useMemo(() => parsed?.messages.flatMap((message) => message.blocks.flatMap((block) =>
    block.kind === "text" ? [block.text] : [],
  )).join("\n\n") ?? "", [parsed]);
  const request = run.request ? formatRequest(run.request) : run.phase === "running" ? "请求尚未发出。" : "HTTP 请求报文未保存在本机。";
  const response = run.status === null && !run.raw ? "尚无响应。" : formatResponse(run, run.raw);
  const copy = tab === "reply" ? reply : tab === "raw" ? response : request;
  const canCopy = tab === "reply" ? Boolean(reply) : tab === "raw" ? run.status !== null || Boolean(run.raw) : Boolean(run.request);

  return (
    <article className="test-model-result debug-run" data-tone={runTone(run)}>
      <RunHead run={run} now={now} />
      <DebugTabs id={id} label={`${run.name} 的结果视图`} tabs={TABS} value={tab} onChange={setTab} />
      <div role="tabpanel" id={`${id}-panel-reply`} aria-labelledby={`${id}-reply`} hidden={tab !== "reply"} tabIndex={0}>
        <div className="log-conversation debug-run-reply">
          {run.raw ? (
            parsed ? <Conversation parsed={parsed} byteLength={null} capturedLength={null} truncated={false} />
              : <><p className="muted">未识别为模型回复，可查看原始响应。</p><pre>{run.raw}</pre></>
          ) : <p className="muted">{run.phase === "running" ? "等待正文…" : "上游没有返回正文。"}</p>}
        </div>
      </div>
      <div role="tabpanel" id={`${id}-panel-raw`} aria-labelledby={`${id}-raw`} hidden={tab !== "raw"} tabIndex={0}>
        <pre>{response}</pre>
      </div>
      <div role="tabpanel" id={`${id}-panel-request`} aria-labelledby={`${id}-request`} hidden={tab !== "request"} tabIndex={0}>
        {run.upstreamId === ROUTED_TARGET ? <p className="field-hint">网关入口请求；映射后的请求和实际渠道请查看日志。</p> : null}
        <pre>{request}</pre>
      </div>
      <div className="debug-bar">
        <span className="muted">{run.raw.length.toLocaleString()} 字符</span>
        <DebugCopyButton text={copy} label={tab === "reply" ? "复制回复" : tab === "raw" ? "复制响应" : "复制请求"} disabled={!canCopy} />
        {onReuse ? <button type="button" className="ghost small" onClick={onReuse}>复用请求</button> : null}
      </div>
    </article>
  );
}
