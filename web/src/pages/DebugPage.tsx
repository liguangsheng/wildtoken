import { useEffect, useMemo, useState } from "react";

import { UnauthorizedError, listPromptTemplates, listUpstreams } from "../api";
import { Conversation } from "../components/Conversation";
import { ChannelPicker, RunHead, formatResponse, runTone } from "../components/DebugParts";
import { formatRequest } from "../components/ModelTestDialog";
import { parseConversationResponse } from "../conversation";
import type { DebugProtocol } from "../debugApi";
import {
  DEBUG_PROTOCOLS,
  bodyModel,
  candidateModels,
  defaultBody,
  formatBody,
  parseBody,
  withStream,
} from "../debugRequest";
import type { PromptTemplate, Upstream } from "../types";
import { useDebugRuns } from "../useDebugRuns";
import type { Run } from "../useDebugRuns";

/** 模板一条都没配时的兜底 prompt，保证默认请求体能直接发。 */
const FALLBACK_PROMPT = "用一句话介绍你自己。";

/**
 * 调试页。
 *
 * 选一个或多个渠道，编辑原始请求体，并发发出，每个渠道一块结果：状态、首字
 * 耗时、总耗时、重组后的回复，以及完整请求和响应原文。只选一个渠道就是单渠
 * 道调试；多选就是同一请求的横向对比。会计费，会进日志。
 */
export function DebugPage({
  active,
  onUnauthorized,
}: {
  /** 切到别的视图时页面不卸载，只隐藏：表单、结果和进行中的请求都保留。 */
  active: boolean;
  onUnauthorized: (message: string) => void;
}) {
  const [upstreams, setUpstreams] = useState<Upstream[]>([]);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [protocol, setProtocol] = useState<DebugProtocol>(DEBUG_PROTOCOLS[0].value);
  const [model, setModel] = useState("");
  const [stream, setStream] = useState(true);
  const [templateId, setTemplateId] = useState("");
  const [bodyText, setBodyText] = useState(() => formatBody(defaultBody(DEBUG_PROTOCOLS[0].value, "", FALLBACK_PROMPT, true)));
  const { runs, running, now, send, stop } = useDebugRuns(onUnauthorized);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listUpstreams(), listPromptTemplates().catch(() => [] as PromptTemplate[])])
      .then(([channels, prompts]) => {
        if (cancelled) return;
        setUpstreams(channels.filter((item) => !item.archived));
        setTemplates(prompts);
        if (prompts[0]) {
          setTemplateId(String(prompts[0].id));
          setBodyText(formatBody(defaultBody(DEBUG_PROTOCOLS[0].value, "", prompts[0].prompt, true)));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) onUnauthorized(err.message);
        else setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  const modelOptions = useMemo(() => candidateModels(upstreams, selected), [upstreams, selected]);
  const parsedBody = useMemo(() => parseBody(bodyText), [bodyText]);

  function currentPrompt(): string {
    return templates.find((item) => String(item.id) === templateId)?.prompt ?? FALLBACK_PROMPT;
  }

  /** 改了协议或模板：按新形状重建请求体，手改的内容会被覆盖。 */
  function rebuild(nextProtocol: DebugProtocol, prompt: string) {
    setBodyText(formatBody(defaultBody(nextProtocol, model, prompt, stream)));
  }

  /** 模型和流式只改对应字段，保留手改的其余部分。请求体坏了就不动它。 */
  function patchBody(patch: (body: Record<string, unknown>) => Record<string, unknown>) {
    const body = parseBody(bodyText);
    if (body) setBodyText(formatBody(patch(body)));
  }

  function toggleChannel(id: number) {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  function sendAll() {
    if (!parsedBody || selected.length === 0) return;
    const names = new Map(upstreams.map((item) => [item.id, item.name]));
    void send(
      selected.map((id) => ({ id, name: names.get(id) ?? `#${id}` })),
      { protocol, model: model.trim(), body: parsedBody },
    );
  }

  const canSend = parsedBody !== null && selected.length > 0 && !running;

  return (
    <section className="view" data-view="debug" hidden={!active}>
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">CHANNEL DEBUG</span>
            <h2>调试</h2>
            <p>向一个或多个渠道发送自定义请求，逐块查看响应。请求真实计费，并记入日志。</p>
          </div>
        </div>

        {error ? (
          <p className="settings-inline-status" data-tone="error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="debug-layout">
          <form
            className="debug-compose"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSend) sendAll();
            }}
          >
            <div className="settings-card debug-params">
              <div className="debug-params-grid">
                <ChannelPicker upstreams={upstreams} selected={selected} onToggle={toggleChannel} />

                <div className="debug-options">
                  <label className="field">
                    <span className="field-label">协议</span>
                    <select
                      value={protocol}
                      onChange={(event) => {
                        const next = event.target.value as DebugProtocol;
                        setProtocol(next);
                        rebuild(next, currentPrompt());
                      }}
                    >
                      {DEBUG_PROTOCOLS.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="field">
                    <span className="field-label">模型</span>
                    <input
                      list="debug-model-options"
                      autoComplete="off"
                      placeholder="选择或输入模型名"
                      value={model}
                      onChange={(event) => {
                        const next = event.target.value;
                        setModel(next);
                        patchBody((body) => ({ ...body, model: bodyModel(protocol, next.trim()) }));
                      }}
                    />
                    <datalist id="debug-model-options">
                      {modelOptions.map((name) => (
                        <option key={name} value={name} />
                      ))}
                    </datalist>
                  </label>

                  <label className="field">
                    <span className="field-label">Prompt 模板</span>
                    <select
                      value={templateId}
                      onChange={(event) => {
                        setTemplateId(event.target.value);
                        const prompt = templates.find((item) => String(item.id) === event.target.value)?.prompt;
                        rebuild(protocol, prompt ?? FALLBACK_PROMPT);
                      }}
                    >
                      {templates.length === 0 ? <option value="">未配置模板</option> : null}
                      {templates.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="debug-stream-toggle">
                    <input
                      type="checkbox"
                      checked={stream}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setStream(next);
                        patchBody((body) => withStream(protocol, body, next));
                      }}
                    />
                    <span>流式输出</span>
                  </label>
                </div>
              </div>

              <div className="debug-actions">
                <button type="button" className="secondary" onClick={() => rebuild(protocol, currentPrompt())}>
                  重置请求体
                </button>
                {running ? (
                  <button type="button" className="secondary" onClick={stop}>
                    停止
                  </button>
                ) : null}
                <button type="submit" className="primary" disabled={!canSend}>
                  {running ? "发送中…" : selected.length > 1 ? `发送到 ${selected.length} 个渠道` : "发送"}
                </button>
              </div>
            </div>

            <div className="settings-card debug-body-card">
              <label className="field">
                <span className="field-label">请求体</span>
                <textarea
                  className="debug-body"
                  spellCheck={false}
                  rows={10}
                  value={bodyText}
                  aria-invalid={parsedBody === null}
                  onChange={(event) => setBodyText(event.target.value)}
                />
                <span className="field-hint">
                  {parsedBody === null
                    ? "不是合法的 JSON 对象，改好前不能发送。"
                    : "原样发给上游。切换协议或模板会重建请求体。"}
                </span>
              </label>
            </div>
          </form>

          <div className="debug-results">
            {runs.length === 0 ? (
              <div className="settings-card debug-empty">
                <p>选渠道、改请求体，发送后结果出现在这里。</p>
              </div>
            ) : (
              runs.map((run) => <RunCard key={run.upstreamId} run={run} now={now} />)
            )}
          </div>
        </div>
      </section>
    </section>
  );
}

function RunCard({ run, now }: { run: Run; now: number }) {
  /* 回复按原文重组：流式和非流式、三种协议都认。每来一块重算一次，调试页
     的量级承受得起。 */
  const parsed = useMemo(() => (run.raw ? parseConversationResponse(run.raw) : null), [run.raw]);

  return (
    <article className="test-model-result debug-run" data-tone={runTone(run)}>
      <RunHead run={run} now={now} />

      <div className="log-conversation debug-run-reply">
        {run.raw ? (
          <Conversation parsed={parsed} byteLength={null} capturedLength={null} truncated={false} />
        ) : (
          <p className="muted">{run.phase === "running" ? "等待正文…" : "上游没有返回正文。"}</p>
        )}
      </div>

      <details className="test-model-details">
        <summary>完整请求</summary>
        <pre>{run.request ? formatRequest(run.request) : "请求尚未发出。"}</pre>
      </details>
      <details className="test-model-details">
        <summary>完整响应</summary>
        <pre>{run.status === null && !run.raw ? "尚无响应。" : formatResponse(run, run.raw)}</pre>
      </details>
    </article>
  );
}
