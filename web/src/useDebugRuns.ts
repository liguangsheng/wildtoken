import { useEffect, useRef, useState } from "react";

import { UnauthorizedError } from "./api";
import { runDebug } from "./debugApi";
import type { DebugEvent, DebugProtocol } from "./debugApi";
import { useTicker } from "./useTicker";

/** 一个渠道的一次调试。字段随事件逐步填上。 */
export interface Run {
  /** 第几次发送。停止后立刻重发时，上一批迟到的回调靠它认出自己、不去改新的一批。 */
  batch: number;
  upstreamId: number;
  name: string;
  phase: "running" | "done" | "error" | "aborted";
  startedAt: number;
  request: { url: string; headers: Record<string, string>; body: unknown } | null;
  status: number | null;
  responseHeaders: Record<string, string>;
  /** 响应头到达。很多上游先回头、过一阵才出第一个 token，所以和首块分开记。 */
  ttfbMs: number | null;
  /** 第一块正文到达。三个耗时都是服务端从发出请求起算的，同一个钟。 */
  firstChunkMs: number | null;
  elapsedMs: number | null;
  /** 响应原文，按到达顺序拼起来。流式时是 SSE 文本。 */
  raw: string;
  error: string;
}

export interface DebugRuns {
  runs: Run[];
  running: boolean;
  /** 运行中每 100ms 跳一次，给卡片算跳动的总耗时。 */
  now: number;
  send: (
    targets: Array<{ id: number; name: string }>,
    payload: { protocol: DebugProtocol; model: string; body: unknown },
  ) => Promise<void>;
  stop: () => void;
}

/**
 * 调试页和生图页共用的发送逻辑：同一请求并发发给多个渠道，每个渠道的事件
 * 落到各自那一条 Run 上。
 */
export function useDebugRuns(onUnauthorized: (message: string) => void): DebugRuns {
  const [runs, setRuns] = useState<Run[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const batchRef = useRef(0);

  // 离开页面时掐掉还在跑的请求，否则流会一直读到上游结束。
  useEffect(() => () => abortRef.current?.abort(), []);

  const running = runs.some((run) => run.phase === "running");
  const now = useTicker(running);

  function patchRun(batch: number, id: number, update: (run: Run) => Run) {
    setRuns((current) => current.map((run) => (run.batch === batch && run.upstreamId === id ? update(run) : run)));
  }

  function applyEvent(batch: number, id: number, event: DebugEvent) {
    patchRun(batch, id, (run) => {
      switch (event.type) {
        case "request":
          return { ...run, request: { url: event.url, headers: event.headers, body: event.body } };
        case "response":
          return { ...run, status: event.status_code, responseHeaders: event.headers, ttfbMs: event.ttfb_ms };
        case "chunk":
          return { ...run, raw: run.raw + event.text, firstChunkMs: run.firstChunkMs ?? event.elapsed_ms };
        case "done":
          return { ...run, phase: "done", elapsedMs: event.elapsed_ms };
        case "error":
          return { ...run, phase: "error", error: event.message, elapsedMs: event.elapsed_ms };
      }
    });
  }

  async function send(
    targets: Array<{ id: number; name: string }>,
    payload: { protocol: DebugProtocol; model: string; body: unknown },
  ) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const batch = ++batchRef.current;
    const startedAt = Date.now();
    setRuns(
      targets.map((target) => ({
        batch,
        upstreamId: target.id,
        name: target.name,
        phase: "running",
        startedAt,
        request: null,
        status: null,
        responseHeaders: {},
        ttfbMs: null,
        firstChunkMs: null,
        elapsedMs: null,
        raw: "",
        error: "",
      })),
    );

    await Promise.all(
      targets.map(async ({ id }) => {
        try {
          await runDebug(id, payload, (event) => applyEvent(batch, id, event), controller.signal);
          // 流关了却没等到 done/error：连接被中间层掐断了。
          patchRun(batch, id, (run) =>
            run.phase === "running"
              ? { ...run, phase: "error", error: "连接提前结束", elapsedMs: Date.now() - run.startedAt }
              : run,
          );
        } catch (err) {
          // 401 照样落成失败，否则这张卡会一直停在「运行中」。
          if (err instanceof UnauthorizedError) onUnauthorized(err.message);
          const aborted = controller.signal.aborted;
          patchRun(batch, id, (run) => ({
            ...run,
            phase: aborted ? "aborted" : "error",
            error: aborted ? "已停止" : err instanceof Error ? err.message : String(err),
            elapsedMs: Date.now() - run.startedAt,
          }));
        }
      }),
    );
  }

  function stop() {
    abortRef.current?.abort();
  }

  return { runs, running, now, send, stop };
}
