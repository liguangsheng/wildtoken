import { useCallback, useEffect, useRef, useState } from "react";

import { UnauthorizedError } from "./api";
import { runDebug } from "./debugApi";
import type { DebugEvent, DebugPayload } from "./debugApi";
import { useTicker } from "./useTicker";

export interface Run {
  batch: number;
  upstreamId: number;
  name: string;
  phase: "running" | "done" | "error" | "aborted";
  startedAt: number;
  request: { url: string; headers: Record<string, string>; body: unknown } | null;
  status: number | null;
  responseHeaders: Record<string, string>;
  ttfbMs: number | null;
  firstChunkMs: number | null;
  elapsedMs: number | null;
  raw: string;
  error: string;
}

export interface DebugRuns {
  runs: Run[];
  running: boolean;
  now: number;
  send: (
    targets: Array<{ id: number; name: string }>,
    payload: DebugPayload,
    onUpdate?: (runs: Run[]) => void,
  ) => Promise<Run[]>;
  stop: () => void;
  clear: () => void;
}

function applyEvent(run: Run, event: DebugEvent): Run {
  switch (event.type) {
    case "request": return { ...run, request: { url: event.url, headers: event.headers, body: event.body } };
    case "response": return { ...run, status: event.status_code, responseHeaders: event.headers, ttfbMs: event.ttfb_ms };
    case "chunk": return { ...run, raw: run.raw + event.text, firstChunkMs: run.firstChunkMs ?? event.elapsed_ms };
    case "done": return { ...run, phase: "done", elapsedMs: event.elapsed_ms };
    case "error": return { ...run, phase: "error", error: event.message, elapsedMs: event.elapsed_ms };
  }
}

export function useDebugRuns(onUnauthorized: (message: string) => void): DebugRuns {
  const [runs, setRuns] = useState<Run[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const batchRef = useRef(0);
  useEffect(() => () => abortRef.current?.abort(), []);
  const running = runs.some((run) => run.phase === "running");
  const now = useTicker(running);

  async function send(targets: Array<{ id: number; name: string }>, payload: DebugPayload, onUpdate?: (runs: Run[]) => void) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const batch = ++batchRef.current;
    const startedAt = Date.now();
    let results: Run[] = targets.map((target) => ({
      batch, upstreamId: target.id, name: target.name, phase: "running", startedAt,
      request: null, status: null, responseHeaders: {}, ttfbMs: null, firstChunkMs: null, elapsedMs: null, raw: "", error: "",
    }));
    const publish = () => {
      if (batch === batchRef.current) setRuns(results);
      onUpdate?.(results);
    };
    const patch = (id: number, update: (run: Run) => Run) => {
      results = results.map((run) => run.upstreamId === id ? update(run) : run);
      publish();
    };
    publish();
    await Promise.all(targets.map(async ({ id }) => {
      try {
        await runDebug(id, payload, (event) => patch(id, (run) => applyEvent(run, event)), controller.signal);
        patch(id, (run) => run.phase === "running"
          ? { ...run, phase: "error", error: "连接提前结束", elapsedMs: Date.now() - startedAt } : run);
      } catch (error) {
        if (error instanceof UnauthorizedError) onUnauthorized(error.message);
        patch(id, (run) => ({
          ...run, phase: controller.signal.aborted ? "aborted" : "error",
          error: controller.signal.aborted ? "已停止" : error instanceof Error ? error.message : String(error),
          elapsedMs: Date.now() - startedAt,
        }));
      }
    }));
    return results;
  }

  const stop = useCallback(() => { abortRef.current?.abort(); }, []);
  function clear() { stop(); batchRef.current += 1; setRuns([]); }
  return { runs, running, now, send, stop, clear };
}
