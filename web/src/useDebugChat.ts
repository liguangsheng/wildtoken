import { useRef, useState } from "react";

import { useToast } from "./components/feedback";
import { editDebugBody } from "./debugDraft";
import type { DebugDraft } from "./debugDraft";
import { formatBody, parseBody } from "./debugRequest";
import type { JSONObject } from "./debugRequest";
import { finishChatTurn, newDebugSession, requestWithMessage, sessionID } from "./debugSessions";
import type { ChatTurn } from "./debugSessions";
import { useDebugRuns } from "./useDebugRuns";
import { useDebugSessions } from "./useDebugSessions";

export function useDebugChat(onUnauthorized: (message: string) => void) {
  const saved = useDebugSessions();
  const runner = useDebugRuns(onUnauthorized);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const busy = useRef(false);
  const toast = useToast();
  const session = saved.state.sessions.find((item) => item.id === saved.state.activeId)!;
  const last = session.turns.at(-1);
  const needsContext = Boolean(last && !last.contextResolved && last.runs.length > 0 && last.runs.every((run) => run.phase !== "running"));

  function newSession() {
    const next = newDebugSession(session);
    saved.update((current) => ({ ...current, activeId: next.id, sessions: [next, ...current.sessions] }));
  }

  function removeSession(id: string) {
    if (id === ownerId) runner.stop();
    saved.update((current) => {
      const remaining = current.sessions.filter((item) => item.id !== id);
      const sessions = remaining.length ? remaining : [newDebugSession()];
      return { ...current, sessions, activeId: current.activeId === id ? sessions[0].id : current.activeId };
    });
  }

  function patchBody(patch: (body: JSONObject) => JSONObject) {
    saved.updateSession(session.id, (current) => {
      const body = parseBody(current.draft.bodyText);
      return body ? { ...current, draft: editDebugBody(current.draft, formatBody(patch(body))) } : current;
    });
  }

  async function send(targets: Array<{ id: number; name: string }>, raw = false, retry?: DebugDraft) {
    if (busy.current || targets.length === 0) return;
    if (!raw && !retry && (needsContext || !session.input.trim())) return;
    let request: DebugDraft;
    try {
      request = retry ?? (raw ? session.draft : requestWithMessage(session.draft, session.input.trim()));
      const body = parseBody(request.bodyText);
      if (!body || typeof body.model !== "string" || !body.model.trim()) throw new Error("请先选择模型，并检查请求 JSON。");
      const id = session.id;
      const prompt = retry || raw ? "自定义 JSON 请求" : session.input.trim();
      const turn: ChatTurn = { id: sessionID(), prompt, request, runs: [], contextId: null, contextResolved: false };
      busy.current = true;
      setOwnerId(id);
      saved.updateSession(id, (current) => ({
        ...current, title: current.title === "新会话" ? Array.from(prompt.replace(/\s+/g, " ")).slice(0, 28).join("") : current.title,
        draft: request, input: raw || retry ? current.input : "", turns: [...current.turns, turn],
      }));
      const result = await runner.send(targets, {
        protocol: request.protocol, model: request.model.trim(), body,
        group_id: session.routing === "auto" ? session.groupId : undefined,
      }, (runs) => saved.updateSession(id, (current) => ({ ...current,
        turns: current.turns.map((item) => item.id === turn.id ? { ...item, runs } : item),
      }), true));
      saved.updateSession(id, (current) => finishChatTurn(current, turn.id, result));
    } catch (error) {
      toast(error instanceof Error ? error.message : "发送失败", { tone: "error" });
    } finally {
      busy.current = false;
      setOwnerId(null);
    }
  }

  return { ...saved, session, ownerId, needsContext, newSession, removeSession, patchBody, send, stop: runner.stop, now: runner.now };
}
