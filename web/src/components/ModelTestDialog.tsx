import { useEffect, useMemo, useState } from "react";

import { UnauthorizedError, fetchUpstreamModels, listPromptTemplates, testUpstreamModel } from "../api";
import type { ModelTestResult, PromptTemplate, Upstream } from "../types";
import { useToast } from "./feedback";
import { useDialog } from "../useDialog";

/** 三种下游协议。值是后端认的，标签里的客户端名是它们各自的参照实现。 */
const PROTOCOLS = [
  { value: "responses", label: "Responses（codex-tui）" },
  { value: "chat_completions", label: "Chat Completions（opencode）" },
  { value: "messages", label: "Messages（claude-cli）" },
] as const;

/**
 * 渠道已配置的模型。
 *
 * 映射的目标值也算——配了 `fast => gpt-4o-mini` 就说明这个渠道认识
 * gpt-4o-mini，测它是合理的。
 */
function configuredModels(upstream: Upstream): string[] {
  return [
    ...new Set(
      [...(upstream.model_names ?? []), ...Object.values(upstream.model_mappings ?? {})].filter(Boolean),
    ),
  ];
}

function sorted(models: string[]): string[] {
  return [...new Set(models)].sort((a, b) => a.localeCompare(b));
}

/** 按 HTTP 报文的样子排版，照抄旧版 formatHttpRequest。 */
export function formatRequest(request: ModelTestResult["request"]): string {
  if (!request) return "";
  let host = "";
  try {
    host = new URL(request.url).host;
  } catch {
    // URL 坏了就不写 host 行，别让整段排版丢掉。
  }
  const headers: Record<string, string> = host
    ? { host, ...(request.headers ?? {}) }
    : { ...(request.headers ?? {}) };

  let target = request.url;
  try {
    const parsed = new URL(request.url);
    target = `${parsed.pathname}${parsed.search}`;
  } catch {
    // 同上：退回原样。
  }

  const lines = [`POST ${target} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n${JSON.stringify(request.body ?? {}, null, 2)}`;
}

function formatResponse(result: ModelTestResult): string {
  const lines = [`HTTP/1.1 ${result.status_code ?? 0}`];
  for (const [name, value] of Object.entries(result.response_headers ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n${result.preview || result.message || ""}`;
}

/**
 * 模型测试。
 *
 * 和「测试连接」不同：那个只探 /v1/models，这个真的发一次模型请求，所以
 * 会计费、会进日志。请求与响应原文都摊开，因为出问题时要看的正是它们。
 */
export function ModelTestDialog({
  open,
  upstream,
  onClose,
}: {
  open: boolean;
  upstream: Upstream | null;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [protocol, setProtocol] = useState<string>(PROTOCOLS[0].value);
  const [templateId, setTemplateId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<ModelTestResult | null>(null);
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const dialogRef = useDialog(open);
  const toast = useToast();

  useEffect(() => {
    if (!open || !upstream) return;
    const available = sorted(configuredModels(upstream));
    setModels(available);
    setModel(available[0] ?? "");
    setProtocol(PROTOCOLS[0].value);
    setResult(null);

    let cancelled = false;
    listPromptTemplates()
      .then((list) => {
        if (cancelled) return;
        setTemplates(list);
        /* 随机挑一条，和旧版一致。固定第一条的话所有人测的都是同一段文本，
           上游按 prompt 做缓存时会看到一个假的「命中」。 */
        const picked = list[Math.floor(Math.random() * list.length)];
        setTemplateId(picked ? String(picked.id) : "");
        setPrompt(picked?.prompt ?? "");
      })
      .catch((err) => {
        if (cancelled) return;
        if (!(err instanceof UnauthorizedError)) {
          toast(`无法打开模型测试：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, upstream, toast]);

  function pickTemplate(id: string) {
    setTemplateId(id);
    setPrompt(templates.find((item) => String(item.id) === id)?.prompt ?? "");
  }

  /** 从上游重拉一份候选。当前选中的还在列表里就保留。 */
  async function refreshModels() {
    if (!upstream) return;
    setRefreshing(true);
    try {
      const fetched = await fetchUpstreamModels(upstream.id);
      const available = sorted(fetched.models ?? []);
      setModels(available);
      setModel((current) => (available.includes(current) ? current : (available[0] ?? "")));
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        toast(`拉取模型失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
      }
    } finally {
      setRefreshing(false);
    }
  }

  async function send() {
    if (!upstream) return;
    setSending(true);
    setResult(null);
    try {
      const outcome = await testUpstreamModel(upstream.id, {
        model,
        protocol,
        prompt_template_id: Number(templateId),
        prompt: prompt.trim(),
      });
      setResult(outcome);
      // 留空时后端会去模板里取，把它实际用的那段回填，不然框里还是空的。
      if (outcome.prompt) setPrompt(outcome.prompt);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      /* 请求本身失败（网络断了、401 以外的错）也要在结果区说清楚，
         不能只弹一条 toast 就没了——这个窗口存在的意义就是看细节。 */
      setResult({
        ok: false,
        status_code: null,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSending(false);
    }
  }

  const status = useMemo(() => {
    if (!result) return "";
    if (result.ok) return `测试成功 · HTTP ${result.status_code}`;
    return `测试失败${result.status_code ? ` · HTTP ${result.status_code}` : ""}`;
  }, [result]);

  const canSend = model !== "" && templateId !== "" && !sending;

  return (
    <dialog className="upstream-dialog dialog--drawer" ref={dialogRef} onCancel={onClose} aria-label="测试模型">
      <form
        className="upstream-dialog-panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) void send();
        }}
      >
        <div className="modal-head upstream-modal-head">
          <div>
            <h2>{`测试模型：${upstream?.name ?? ""}`}</h2>
            <p>向当前渠道发送一次实际模型请求。</p>
          </div>
          <div className="modal-head-actions">
            <button
              type="button"
              className="secondary ghost icon-close"
              aria-label="关闭"
              title="关闭"
              onClick={onClose}
            >
              <svg className="dialog-icon dialog-icon--close" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4L4 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="upstream-dialog-body">
          <label className="field">
            <span className="field-label">模型</span>
            <select value={model} onChange={(event) => setModel(event.target.value)} required>
              {models.length === 0 ? (
                <option value="" disabled>
                  此渠道尚未配置模型
                </option>
              ) : (
                models.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))
              )}
            </select>
            <span className="field-hint">可使用此渠道配置的模型，或从上游刷新后选择。</span>
          </label>

          <label className="field">
            <span className="field-label">请求协议</span>
            <select value={protocol} onChange={(event) => setProtocol(event.target.value)} required>
              {PROTOCOLS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <span className="field-hint">请求格式和头部由协议决定。</span>
          </label>

          <label className="field">
            <span className="field-label">Prompt 模板</span>
            <select value={templateId} onChange={(event) => pickTemplate(event.target.value)} required>
              {templates.length === 0 ? (
                <option value="" disabled>
                  尚未配置 Prompt 模板
                </option>
              ) : (
                templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="field test-model-prompt">
            <span className="field-label">本次 Prompt</span>
            <textarea
              rows={6}
              maxLength={20000}
              required
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>

          {result ? (
            <div className="test-model-result">
              <div className="test-model-result-head">
                <strong>{status}</strong>
                <span className="muted">{result.content_type ?? ""}</span>
              </div>
              <div className="test-model-response">
                <span className="field-label">模型回复</span>
                <pre>{result.reply || result.preview || result.message || "渠道未返回正文。"}</pre>
              </div>
              <details className="test-model-details">
                <summary>展开完整请求</summary>
                <pre>{formatRequest(result.request)}</pre>
              </details>
              <details className="test-model-details">
                <summary>展开完整响应</summary>
                <pre>{formatResponse(result)}</pre>
              </details>
            </div>
          ) : null}
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="secondary"
            disabled={refreshing}
            onClick={() => void refreshModels()}
          >
            {refreshing ? "刷新中…" : "刷新模型"}
          </button>
          <button type="submit" className="primary" disabled={!canSend}>
            {sending ? "测试中…" : "发送测试"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
