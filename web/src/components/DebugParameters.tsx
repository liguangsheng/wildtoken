import { useState } from "react";

import { bodyProblem, draftForProtocol, editDebugBody, outputTokenKey, simpleRequest, withSystem } from "../debugDraft";
import type { DebugDraft } from "../debugDraft";
import { DEBUG_PROTOCOLS, formatBody, parseBody, withStream } from "../debugRequest";
import type { JSONObject, TextProtocol } from "../debugRequest";
import type { DebugSession } from "../debugSessions";
import type { Group, PromptTemplate, Upstream } from "../types";
import { ChannelPicker, DebugCopyButton } from "./DebugParts";
import { useConfirm } from "./feedback";

export function DebugParameters({ session, upstreams, groups, templates, busy, mobile, loading, canSendJSON, onChange, onDraft, onPatch, onTemplate, onSendJSON }: {
  session: DebugSession;
  upstreams: Upstream[];
  groups: Group[];
  templates: PromptTemplate[];
  busy: boolean;
  mobile: boolean;
  loading: boolean;
  canSendJSON: boolean;
  onChange: (patch: Partial<DebugSession>) => void;
  onDraft: (draft: DebugDraft) => void;
  onPatch: (patch: (body: JSONObject) => JSONObject) => void;
  onTemplate: (prompt: string) => void;
  onSendJSON: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const confirm = useConfirm();
  const [templateId, setTemplateId] = useState("");
  const { draft } = session;
  const { protocol, bodyText } = draft;
  const body = parseBody(bodyText);
  const simple = body && simpleRequest(protocol, body);
  const tokenKey = outputTokenKey(protocol, body ?? {});
  const template = templates.find((item) => String(item.id) === (templateId || String(templates[0]?.id)));
  const number = (key: string, value: string) => onPatch((current) => {
    const next = { ...current };
    if (value === "") delete next[key];
    else next[key] = Number(value);
    return next;
  });

  return (
    <aside className="settings-card debug-params" aria-label="会话参数">
      <div className="debug-bar">
        <h3>参数</h3>
        {mobile ? <button type="button" className="secondary small" aria-expanded={expanded} aria-controls="debug-parameter-fields"
          onClick={() => setExpanded(!expanded)}>{expanded ? "收起参数" : "调整参数"}</button> : <span className="muted">下一次发送生效</span>}
      </div>
      <fieldset id="debug-parameter-fields" disabled={busy} hidden={mobile && !expanded}>
        <label className="field">
          <span className="field-label">API 协议</span>
          <select aria-label="API 协议" value={protocol} disabled={session.turns.length > 0}
            onChange={async (event) => {
              const next = event.target.value as TextProtocol;
              const portable = new Set(["model", "input", "messages", "system", "instructions", "stream", "stream_options", "max_tokens", "max_output_tokens", "max_completion_tokens", "temperature"]);
              if ((!simple || Object.keys(body ?? {}).some((key) => !portable.has(key)))
                && !await confirm({ title: "切换 API 协议？", message: "只保留模型、文本消息和常用参数。复杂内容及额外 JSON 字段会重置。", confirmLabel: "切换", danger: false })) return;
              onDraft(draftForProtocol(draft, next));
            }}>
            {DEBUG_PROTOCOLS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <span className="field-hint">{session.turns.length ? "已有消息的会话保持协议不变；更换协议请新建会话。" : DEBUG_PROTOCOLS.find((item) => item.value === protocol)?.path}</span>
        </label>
        <label className="field">
          <span className="field-label">发送方式</span>
          <select aria-label="发送方式" value={session.routing} onChange={(event) => onChange({ routing: event.target.value as DebugSession["routing"] })}>
            <option value="auto">自动路由</option>
            <option value="direct">指定渠道</option>
          </select>
        </label>
        {session.routing === "auto" ? <label className="field">
          <span className="field-label">路由分组</span>
          <select aria-label="路由分组" value={session.groupId} onChange={(event) => onChange({ groupId: Number(event.target.value) })}>
            {!groups.some((item) => item.id === session.groupId) ? <option value={session.groupId}>{session.groupId === 1 ? "默认分组" : `不可用分组 #${session.groupId}`}</option> : null}
            {groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <span className="field-hint">按模型、分组和权重路由，沿用映射与重试；不占用下游令牌额度。</span>
        </label> : <ChannelPicker upstreams={upstreams} selected={session.channels} loading={loading}
          onToggle={(id) => onChange({ channels: session.channels.includes(id) ? session.channels.filter((item) => item !== id) : [...session.channels, id] })}
          onSelect={(channels) => onChange({ channels })} />}
        <label className="debug-stream-toggle">
          <input type="checkbox" checked={body?.stream === true} disabled={!body} onChange={(event) => {
            const stream = event.target.checked;
            onPatch((current) => withStream(protocol, current, stream));
          }} />
          <span>流式输出</span>
        </label>
        <div className="debug-options">
          <label className="field">
            <span className="field-label">输出上限</span>
            <input aria-label="输出 Token 上限" type="number" min={1} step={1} placeholder="默认" disabled={!body}
              value={typeof body?.[tokenKey] === "number" ? body[tokenKey] : ""} onChange={(event) => number(tokenKey, event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">温度</span>
            <input aria-label="温度" type="number" min={0} max={protocol === "messages" ? 1 : 2} step="any" placeholder="不指定" disabled={!body}
              value={typeof body?.temperature === "number" ? body.temperature : ""} onChange={(event) => number("temperature", event.target.value)} />
          </label>
        </div>
        <label className="field">
          <span className="field-label">系统提示词</span>
          <textarea aria-label="系统提示词" rows={3} disabled={!simple} value={simple?.system ?? ""}
            placeholder={simple ? "角色、回答风格或约束…" : "复杂消息请在 JSON 中编辑"} onChange={(event) => {
              const value = event.target.value;
              onPatch((current) => withSystem(protocol, current, value));
            }} />
        </label>
        <div className="debug-template">
          <label className="field">
            <span className="field-label">Prompt 模板</span>
            <select aria-label="Prompt 模板" disabled={!templates.length} value={template ? String(template.id) : ""} onChange={(event) => setTemplateId(event.target.value)}>
              {!templates.length ? <option value="">未配置模板</option> : null}
              {templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <button type="button" className="secondary small" disabled={!template} onClick={() => { if (template) onTemplate(template.prompt); }}>填入</button>
        </div>
        <details className="debug-system">
          <summary>高级 JSON</summary>
          <label className="field">
            <span className="field-hint">含当前上下文。聊天输入会追加用户消息，也可直接发送此请求体。</span>
            <textarea className="debug-body" aria-label="请求 JSON" rows={14} spellCheck={false} value={bodyText}
              aria-invalid={!body} onChange={(event) => onDraft(editDebugBody(draft, event.target.value))} />
          </label>
          {!body ? <p className="field-hint" role="alert">{bodyProblem(bodyText)}</p> : null}
          <div className="debug-bar">
            <button type="button" className="ghost small" disabled={!body} onClick={() => { if (body) onDraft({ ...draft, bodyText: formatBody(body) }); }}>格式化</button>
            <DebugCopyButton label="复制 JSON" text={bodyText} />
            <button type="button" className="secondary small" disabled={!canSendJSON} onClick={onSendJSON}>发送 JSON</button>
          </div>
        </details>
      </fieldset>
    </aside>
  );
}
