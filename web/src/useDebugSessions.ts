import { useCallback, useEffect, useRef, useState } from "react";

import { DEBUG_SESSIONS_KEY, decodeDebugSessions, encodeDebugSessions, initialSessionState } from "./debugSessions";
import type { DebugSession, DebugSessionState } from "./debugSessions";
import { openLocalRecord } from "./driver/localRecord";

export function useDebugSessions() {
  const [initial] = useState(() => {
    const store = openLocalRecord(DEBUG_SESSIONS_KEY);
    const restored = store.value === null ? null : decodeDebugSessions(store.value);
    const blocked = store.value !== null && !restored;
    return { store, state: restored ?? initialSessionState(), blocked,
      error: blocked ? "本机会话无法读取，原记录未覆盖。可导出当前会话后重置本机记录。" : store.error };
  });
  const [state, setState] = useState(initial.state);
  const [saveError, setSaveError] = useState(initial.error);
  const latest = useRef(state);
  const store = useRef(initial.store);
  const blocked = useRef(initial.blocked);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const dirty = useRef(false);

  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (blocked.current || !dirty.current) return;
    const error = store.current.save(encodeDebugSessions(latest.current));
    if (!error) dirty.current = false;
    if (alive.current) setSaveError(error);
  }, []);

  useEffect(() => {
    alive.current = true;
    flush();
    window.addEventListener("pagehide", flush);
    return () => {
      alive.current = false;
      flush();
      window.removeEventListener("pagehide", flush);
    };
  }, [flush]);

  const update = useCallback((change: (state: DebugSessionState) => DebugSessionState, streaming = false) => {
    if (!alive.current) return;
    const next = change(latest.current);
    if (next === latest.current) return;
    latest.current = next;
    dirty.current = true;
    setState(next);
    if (streaming) {
      if (timer.current === null) timer.current = setTimeout(flush, 500);
    } else flush();
  }, [flush]);

  function updateSession(id: string, change: (session: DebugSession) => DebugSession, streaming = false) {
    update((current) => ({ ...current, sessions: current.sessions.map((session) => session.id === id
      ? { ...change(session), updatedAt: Date.now() } : session) }), streaming);
  }

  function reset() {
    store.current = openLocalRecord(DEBUG_SESSIONS_KEY);
    blocked.current = false;
    update(() => initialSessionState());
  }

  return { state, saveError, update, updateSession, reset };
}
