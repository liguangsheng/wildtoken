import { parseConversationResponse } from "./conversation.ts";
import { createDebugDraft, editDebugBody, outputTokenKey } from "./debugDraft.ts";
import type { DebugDraft, TextMessage } from "./debugDraft.ts";
import { formatBody, parseBody } from "./debugRequest.ts";
import type { JSONObject, TextProtocol } from "./debugRequest.ts";
import type { Upstream } from "./types.ts";
import type { Run } from "./useDebugRuns.ts";

export const DEBUG_SESSIONS_KEY = "wildtoken_debug_sessions_v1";

export interface ChatTurn {
  id: string;
  prompt: string;
  request: DebugDraft;
  runs: Run[];
  contextId: number | null;
  contextResolved: boolean;
}

export interface DebugSession {
  id: string;
  title: string;
  updatedAt: number;
  draft: DebugDraft;
  input: string;
  routing: "auto" | "direct";
  groupId: number;
  channels: number[];
  turns: ChatTurn[];
}

export interface DebugSessionState {
  version: 1;
  activeId: string;
  sessions: DebugSession[];
}

export function sessionID(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function newDebugSession(previous?: DebugSession): DebugSession {
  const draft = previous?.draft ?? createDebugDraft("responses", "", "");
  const body = { ...(parseBody(draft.bodyText) ?? parseBody(createDebugDraft(draft.protocol, draft.model, "").bodyText)!) };
  delete body.previous_response_id;
  if (draft.protocol === "responses") body.input = [];
  else body.messages = [];
  return {
    id: sessionID(), title: "新会话", updatedAt: Date.now(), draft: { ...draft, bodyText: formatBody(body) }, input: "",
    routing: previous?.routing ?? "auto", groupId: previous?.groupId ?? 1, channels: [...(previous?.channels ?? [])], turns: [],
  };
}

export function initialSessionState(): DebugSessionState {
  const session = newDebugSession();
  return { version: 1, activeId: session.id, sessions: [session] };
}

/** 只追加消息，不改已有的图片、工具结果或自定义字段。 */
export function appendChatMessage(protocol: TextProtocol, body: JSONObject, message: TextMessage): JSONObject {
  const key = protocol === "responses" ? "input" : "messages";
  const previous = body[key];
  const messages = protocol === "responses" && typeof previous === "string"
    ? (previous ? [{ role: "user", content: previous }] : []) : previous === undefined ? [] : previous;
  if (!Array.isArray(messages)) throw new Error(`${key} 必须是消息数组${protocol === "responses" ? "或文本" : ""}，请检查高级 JSON。`);
  return { ...body, [key]: [...messages, message] };
}

export function requestWithMessage(draft: DebugDraft, text: string): DebugDraft {
  const body = parseBody(draft.bodyText);
  if (!body) throw new Error("请求体不是合法的 JSON 对象。");
  return editDebugBody(draft, formatBody(appendChatMessage(draft.protocol, body, { role: "user", content: text })));
}

export function successfulRun(run: Run): boolean {
  return run.phase === "done" && run.status !== null && run.status >= 200 && run.status < 300;
}

/** 工具和多模态回复不能只拿文本续接，需在 JSON 中补全或明确跳过。 */
export function replyText(run: Run | undefined): string | null {
  if (!run || !successfulRun(run)) return null;
  try {
    const parsed = parseConversationResponse(run.raw);
    if (!parsed?.complete || parsed.toolCount > 0) return null;
    const blocks = parsed.messages.flatMap((message) => message.blocks);
    if (blocks.some((block) => block.kind !== "text" && block.kind !== "thinking")) return null;
    const text = blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n\n");
    return text.trim() ? text : null;
  } catch { return null; }
}

export function useTurnContext(session: DebugSession, turnId: string, target: number | null): DebugSession {
  const turn = session.turns.at(-1);
  if (!turn || turn.id !== turnId) return session;
  const text = target === null ? null : replyText(turn.runs.find((run) => run.upstreamId === target));
  if (target !== null && !text) return session;
  const base = parseBody(turn.request.bodyText);
  if (!base) return session;
  const key = turn.request.protocol === "responses" ? "input" : "messages";
  const current = { ...(parseBody(session.draft.bodyText) ?? base), [key]: base[key] };
  const body = text ? appendChatMessage(turn.request.protocol, current, { role: "assistant", content: text }) : current;
  return { ...session, draft: { ...session.draft, bodyText: formatBody(body) }, turns: session.turns.map((item) => item.id === turnId
    ? { ...item, contextId: target, contextResolved: true } : item) };
}

export function finishChatTurn(session: DebugSession, turnId: string, runs: Run[]): DebugSession {
  const next = { ...session, turns: session.turns.map((turn) => turn.id === turnId ? { ...turn, runs } : turn) };
  const usable = runs.filter((run) => replyText(run) !== null);
  if (usable.length === 1) return useTurnContext(next, turnId, usable[0].upstreamId);
  if (!runs.some(successfulRun)) return useTurnContext(next, turnId, null);
  return next;
}

export function sessionModels(upstreams: Upstream[], session: DebugSession): string[] {
  const source = upstreams.filter((item) => !item.archived && (session.routing === "auto"
    ? item.enabled && item.group_ids.includes(session.groupId) : session.channels.length === 0 || session.channels.includes(item.id)));
  return [...new Set(source.flatMap((item) => [
    ...(item.model_names ?? []), ...Object.keys(item.model_mappings ?? {}),
    ...(session.routing === "direct" ? Object.values(item.model_mappings ?? {}) : []),
  ]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function chatParameterProblem(draft: DebugDraft): string {
  const body = parseBody(draft.bodyText);
  if (!body) return "请先修正高级 JSON。";
  const limit = body[outputTokenKey(draft.protocol, body)];
  if ((draft.protocol === "messages" && limit === undefined)
    || (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1))) return "输出上限应为正整数。";
  if (body.temperature !== undefined && (typeof body.temperature !== "number" || !Number.isFinite(body.temperature)
    || body.temperature < 0 || body.temperature > (draft.protocol === "messages" ? 1 : 2))) return "温度超出当前协议的范围。";
  return "";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validDraft(value: unknown): value is DebugDraft {
  return record(value) && typeof value.protocol === "string" && ["responses", "chat_completions", "messages"].includes(value.protocol)
    && typeof value.model === "string" && typeof value.bodyText === "string";
}

function validRun(value: unknown): value is Run {
  if (!record(value)) return false;
  return typeof value.phase === "string" && ["running", "done", "error", "aborted"].includes(value.phase)
    && [value.batch, value.upstreamId, value.startedAt].every((item) => typeof item === "number" && Number.isFinite(item))
    && [value.status, value.ttfbMs, value.firstChunkMs, value.elapsedMs].every((item) => item === null || (typeof item === "number" && Number.isFinite(item)))
    && [value.name, value.raw, value.error].every((item) => typeof item === "string");
}

function validTurn(value: unknown): value is ChatTurn {
  return record(value) && typeof value.id === "string" && typeof value.prompt === "string" && validDraft(value.request)
    && typeof value.contextResolved === "boolean" && (value.contextId === null || Number.isInteger(value.contextId))
    && Array.isArray(value.runs) && value.runs.every(validRun);
}

function validSession(value: unknown): value is DebugSession {
  if (!record(value) || !validDraft(value.draft) || !Array.isArray(value.turns) || !value.turns.every(validTurn)) return false;
  return [value.id, value.title, value.input].every((item) => typeof item === "string")
    && typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
    && (value.routing === "auto" || value.routing === "direct") && Number.isInteger(value.groupId) && Number(value.groupId) > 0
    && Array.isArray(value.channels) && value.channels.every((id) => Number.isInteger(id) && id > 0)
    && new Set(value.turns.map((turn) => turn.id)).size === value.turns.length;
}

function localRun(run: Run): Run {
  return {
    batch: run.batch, upstreamId: run.upstreamId, name: run.name, phase: run.phase, startedAt: run.startedAt,
    request: null, responseHeaders: {}, status: run.status, ttfbMs: run.ttfbMs, firstChunkMs: run.firstChunkMs,
    elapsedMs: run.elapsedMs, raw: run.raw, error: run.error,
  };
}

function localDraft(draft: DebugDraft): DebugDraft {
  return { protocol: draft.protocol, model: draft.model, bodyText: draft.bodyText };
}

/** 只持久化消息与参数，不保存请求/响应头或真实请求 URL。 */
export function encodeDebugSessions(state: DebugSessionState): string {
  return JSON.stringify({ version: 1, activeId: state.activeId, sessions: state.sessions.map((session) => ({
    id: session.id, title: session.title, updatedAt: session.updatedAt, draft: localDraft(session.draft), input: session.input,
    routing: session.routing, groupId: session.groupId, channels: session.channels,
    turns: session.turns.map((turn) => ({
      id: turn.id, prompt: turn.prompt, request: localDraft(turn.request), contextId: turn.contextId, contextResolved: turn.contextResolved,
      runs: turn.runs.map(localRun),
    })),
  })) });
}

export function decodeDebugSessions(raw: string): DebugSessionState | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || !Array.isArray(value.sessions) || !value.sessions.every(validSession)) return null;
    if (new Set(value.sessions.map((session) => session.id)).size !== value.sessions.length) return null;
    if (value.sessions.length === 0) return initialSessionState();
    const sessions = value.sessions.map((session) => ({ ...session, turns: session.turns.map((turn) => {
      const runs = turn.runs.map((run) => run.phase === "running" ? {
        ...localRun(run), phase: "aborted" as const, error: "页面已刷新，生成未恢复。", elapsedMs: run.elapsedMs ?? 0,
      } : localRun(run));
      return { ...turn, runs, contextResolved: turn.contextResolved || !runs.some(successfulRun) };
    }) }));
    const activeId = sessions.some((session) => session.id === value.activeId) ? String(value.activeId) : sessions[0].id;
    return { version: 1, activeId, sessions };
  } catch { return null; }
}
