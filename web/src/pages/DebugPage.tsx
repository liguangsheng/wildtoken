import { useEffect, useMemo, useRef, useState } from "react";

import { getAdminToken, listGroupsFull, listPromptTemplates, listUpstreams } from "../api";
import { DebugParameters } from "../components/DebugParameters";
import { DebugRunCard } from "../components/DebugRunCard";
import { DebugSessionList } from "../components/DebugSessionList";
import { LoadError } from "../components/LoadError";
import { ResultBoundary } from "../components/ResultBoundary";
import { useConfirm, useToast } from "../components/feedback";
import { ROUTED_TARGET } from "../debugApi";
import { bodyModel, formatBody, parseBody } from "../debugRequest";
import { chatParameterProblem, encodeDebugSessions, replyText, sessionModels, useTurnContext } from "../debugSessions";
import { downloadJSON } from "../driver/localRecord";
import type { PromptTemplate } from "../types";
import { useDebugChat } from "../useDebugChat";
import { useRemoteResource } from "../useRemoteResource";

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const changed = () => setMatches(media.matches);
    changed();
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, [query]);
  return matches;
}

export function DebugPage({ active, onUnauthorized }: { active: boolean; onUnauthorized: (message: string) => void }) {
  const authenticated = getAdminToken() !== "";
  const chat = useDebugChat(onUnauthorized);
  const { session, state, ownerId } = chat;
  const channels = useRemoteResource(listUpstreams, onUnauthorized, active && authenticated);
  const groups = useRemoteResource(listGroupsFull, onUnauthorized, active && authenticated);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const compact = useMedia("(max-width: 1180px)");
  const mobile = useMedia("(max-width: 820px)");
  const confirm = useConfirm();
  const toast = useToast();
  const thread = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const follow = useRef(true);
  const upstreams = useMemo(() => (channels.data ?? []).filter((item) => !item.archived), [channels.data]);
  const models = useMemo(() => sessionModels(upstreams, session), [upstreams, session]);
  const body = useMemo(() => parseBody(session.draft.bodyText), [session.draft.bodyText]);
  const selected = upstreams.filter((item) => session.channels.includes(item.id));
  const group = groups.data?.find((item) => item.id === session.groupId);
  const targets = session.routing === "auto" ? [{ id: ROUTED_TARGET, name: `自动路由 · ${group?.name ?? "默认分组"}` }]
    : selected.map((item) => ({ id: item.id, name: item.name }));
  const busy = ownerId !== null;
  const ownBusy = ownerId === session.id;
  const invalidGroup = session.routing === "auto" && groups.data !== null && groups.data !== undefined && !group;
  const hasModel = typeof body?.model === "string" && Boolean(body.model.trim());
  const valid = Boolean(body && hasModel && targets.length && !invalidGroup && !busy);
  const parameterError = chatParameterProblem(session.draft);
  const canSend = valid && !parameterError && !chat.needsContext && Boolean(session.input.trim());
  const hint = !hasModel ? "先选择模型。" : invalidGroup ? "所选路由分组已不可用，请重新选择。" : targets.length === 0 ? "请选择指定渠道。"
    : parameterError || (chat.needsContext ? "选择要继续的回复，或明确跳过本轮回复。" : busy ? "生成中；切换会话不会停止请求。"
      : `发送将产生 ${targets.length} 个真实计费请求，并记入日志。`);

  useEffect(() => { if (!authenticated) chat.stop(); }, [authenticated, chat.stop]);
  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    listPromptTemplates().catch(() => [] as PromptTemplate[]).then((items) => { if (!cancelled) setTemplates(items); });
    return () => { cancelled = true; };
  }, [authenticated]);

  useEffect(() => {
    if (!channels.data) return;
    const live = new Set(channels.data.filter((item) => !item.archived).map((item) => item.id));
    chat.update((current) => {
      let changed = false;
      const sessions = current.sessions.map((item) => {
        const chosen = item.channels.filter((id) => live.has(id));
        if (chosen.length === item.channels.length) return item;
        changed = true;
        return { ...item, channels: chosen };
      });
      return changed ? { ...current, sessions } : current;
    });
  }, [channels.data, chat.update]);

  useEffect(() => { follow.current = true; }, [session.id]);
  useEffect(() => {
    if (follow.current && thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [session.id, session.turns]);

  async function remove() {
    if (await confirm({ title: "删除这个会话？", message: ownBusy ? "会停止当前生成，并删除本机记录。" : "只删除本机记录，不删除服务端日志。", confirmLabel: "删除" })) chat.removeSession(session.id);
  }

  async function reset() {
    if (!await confirm({ title: "清空本机会话？", message: "停止生成并清空当前浏览器的全部会话。服务端日志不受影响。", confirmLabel: "清空" })) return;
    chat.stop();
    chat.reset();
  }

  function chooseModel(model: string) {
    chat.updateSession(session.id, (current) => {
      const parsed = parseBody(current.draft.bodyText);
      return parsed ? { ...current, draft: { ...current.draft, model,
        bodyText: formatBody({ ...parsed, model: bodyModel(current.draft.protocol, model.trim()) }),
      } } : current;
    });
  }

  if (!authenticated) return (
    <section className="view" data-view="debug" hidden={!active}>
      <div className="settings-card"><p>会话仍保存在本机，登录后可查看。</p>
        <button type="button" className="secondary" onClick={() => onUnauthorized("请先登录后查看本机会话。")}>登录后查看</button>
      </div>
    </section>
  );

  if (channels.data === null || channels.data === undefined) return (
    <section className="view" data-view="debug" hidden={!active}>
      <LoadError error={channels.error} label="渠道" onRetry={channels.reload} />
      <div className="settings-card"><p>{channels.loading ? "正在验证登录状态…" : "验证登录后显示本机会话。"}</p></div>
    </section>
  );

  return (
    <section className="view" data-view="debug" hidden={!active} onKeyDown={(event) => {
      if (!active || event.repeat || event.nativeEvent.isComposing || event.key !== "Enter" || !(event.ctrlKey || event.metaKey)
        || event.altKey || event.shiftKey) return;
      event.preventDefault();
      if (canSend) form.current?.requestSubmit();
    }}>
      <section className="panel">
        <div className="panel-head"><div><span className="eyebrow">MODEL PLAYGROUND</span><h2>会话调试</h2><p>先选模型。自动路由或指定渠道，在同一会话中连续调试。</p></div></div>
        <LoadError error={channels.error} label="渠道" onRetry={channels.reload} />
        <LoadError error={groups.error} label="分组" onRetry={groups.reload} />
        <div className="debug-workspace">
          <DebugSessionList sessions={state.sessions} activeId={session.id} ownerId={ownerId} compact={compact} error={chat.saveError}
            onSelect={(activeId) => chat.update((current) => current.sessions.some((item) => item.id === activeId) ? { ...current, activeId } : current)} onNew={chat.newSession}
            onRename={(title) => chat.updateSession(session.id, (current) => ({ ...current, title }))} onDelete={() => void remove()}
            onReset={() => void reset()} onExport={() => downloadJSON("wildtoken-conversations.json", encodeDebugSessions(state))} />
          <section className="settings-card debug-chat" aria-label="会话区">
            <div className="debug-chat-head">
              <div><h3 title={session.title}>{session.title}</h3><span className="field-hint">{session.routing === "auto" ? `自动路由 · ${group?.name ?? "默认分组"}` : `指定 ${selected.length} 个渠道`}</span></div>
              <label className="field">
                <span className="field-label">模型</span>
                <input aria-label="模型" list="debug-model-options" autoComplete="off" placeholder="先选择或输入模型" value={session.draft.model}
                  disabled={ownBusy || !body} onChange={(event) => chooseModel(event.target.value)} />
                <datalist id="debug-model-options">{models.map((name) => <option key={name} value={name} />)}</datalist>
              </label>
            </div>
            {busy && !ownBusy && state.sessions.some((item) => item.id === ownerId) ? <div className="debug-bar">
              <span className="field-hint">另一会话正在生成。</span>
              <button type="button" className="ghost small" onClick={() => {
                if (ownerId) chat.update((current) => current.sessions.some((item) => item.id === ownerId) ? { ...current, activeId: ownerId } : current);
              }}>返回生成中的会话</button>
            </div> : null}
            <div className="debug-thread" ref={thread} onScroll={(event) => {
              const element = event.currentTarget;
              follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
            }}>
              {session.turns.length === 0 ? <div className="debug-empty">
                <strong>先选模型，再开始对话</strong>
                <p>默认自动路由；也可以在右侧指定渠道。后续消息会携带会话上下文。</p>
                <button type="button" className="secondary small" onClick={() => chat.updateSession(session.id, (current) => ({ ...current, input: "用一句话介绍你自己。" }))}>试一条简单问题</button>
              </div> : session.turns.map((turn, index) => (
                <article className="debug-turn" key={turn.id}>
                  <div className="debug-user-message"><span>你</span><p>{turn.prompt}</p></div>
                  <div className="debug-result-grid">
                    {turn.runs.map((run) => <ResultBoundary key={run.upstreamId} fallback={<pre>{run.raw || run.error}</pre>}>
                      <DebugRunCard run={run} now={chat.now} />
                    </ResultBoundary>)}
                  </div>
                  {index === session.turns.length - 1 && !busy && !turn.contextResolved && turn.runs.length > 0 ? <div className="debug-context-choice">
                    <p className="field-hint">选择用于后续上下文的回复。工具或多模态回复可在高级 JSON 中补全，也可跳过。</p>
                    <div className="debug-bar">
                      {turn.runs.filter((run) => replyText(run) !== null).map((run) => <button type="button" className="secondary small" key={run.upstreamId}
                        onClick={() => chat.updateSession(session.id, (current) => useTurnContext(current, turn.id, run.upstreamId))}>继续 · {run.name}</button>)}
                      <button type="button" className="ghost small" onClick={() => chat.updateSession(session.id, (current) => useTurnContext(current, turn.id, null))}>不带本轮回复继续</button>
                    </div>
                  </div> : null}
                  {turn.contextId !== null ? <span className="field-hint">已加入上下文 · {turn.runs.find((run) => run.upstreamId === turn.contextId)?.name}</span> : null}
                  {index === session.turns.length - 1 && !busy && turn.runs.length > 0 && turn.runs.every((run) => run.phase === "error" || run.phase === "aborted" || (run.status ?? 500) >= 400)
                    ? <button type="button" className="ghost small" disabled={!valid} title="再次发送本轮请求，会产生真实调用"
                      onClick={() => void chat.send(targets, true, turn.request)}>重试本轮</button> : null}
                </article>
              ))}
            </div>
            <form ref={form} className="debug-compose" onSubmit={(event) => {
              event.preventDefault();
              if (canSend) { follow.current = true; void chat.send(targets); }
            }}>
              <textarea aria-label="发送消息" rows={3} placeholder="输入消息，Ctrl / ⌘ + Enter 发送" value={session.input}
                onChange={(event) => { const input = event.target.value; chat.updateSession(session.id, (current) => ({ ...current, input })); }} />
              <div className="debug-sendbar">
                <p className="field-hint" role={parameterError && hasModel ? "alert" : undefined}>{hint}</p>
                <div className="debug-actions">
                  {busy ? <button type="button" className="secondary" onClick={chat.stop}>停止生成</button> : null}
                  <button type="submit" className="primary" disabled={!canSend} aria-keyshortcuts="Control+Enter Meta+Enter">{ownBusy ? "生成中…" : "发送"}</button>
                </div>
              </div>
            </form>
          </section>
          <DebugParameters session={session} upstreams={upstreams} groups={groups.data ?? []} templates={templates} busy={ownBusy}
            mobile={mobile} loading={channels.loading} canSendJSON={valid} onPatch={chat.patchBody}
            onChange={(patch) => chat.updateSession(session.id, (current) => ({ ...current, ...patch }))}
            onDraft={(draft) => chat.updateSession(session.id, (current) => ({ ...current, draft }))}
            onSendJSON={() => { follow.current = true; void chat.send(targets, true); }}
            onTemplate={(input) => {
              const previous = session.input;
              chat.updateSession(session.id, (current) => ({ ...current, input }));
              toast("已填入输入框，尚未发送。", { actionLabel: "撤销", onAction: () => chat.updateSession(session.id, (current) => ({ ...current, input: previous })) });
            }} />
        </div>
      </section>
    </section>
  );
}
