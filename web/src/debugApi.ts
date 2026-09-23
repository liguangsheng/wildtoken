/* 调试页的流式调用。

   后端不管上游流不流式，一律回事件流：request → response → chunk* →
   done | error。非流式的答复只是一次性到齐的 chunk。 */

import { send } from "./api";
import { parseStreamEvent } from "./useLogStream";

export type DebugProtocol = "responses" | "chat_completions" | "messages" | "images";

export type DebugEvent =
  | { type: "request"; url: string; headers: Record<string, string>; body: unknown }
  | { type: "response"; status_code: number; headers: Record<string, string>; ttfb_ms: number }
  | { type: "chunk"; text: string; elapsed_ms: number }
  | { type: "done"; elapsed_ms: number }
  | { type: "error"; message: string; elapsed_ms: number };

/**
 * 向一个渠道发一次调试请求，事件逐个交给 onEvent。
 *
 * 上游报错走 error 事件，照样 resolve。请求没发出去（校验失败、401）、连接
 * 中途断开、signal 中止才 reject，由调用方区分。
 */
export async function runDebug(
  upstreamId: number,
  payload: { protocol: DebugProtocol; model: string; body: unknown },
  onEvent: (event: DebugEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await send(`/api/admin/upstreams/${upstreamId}/debug`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!response.body) throw new Error("浏览器不支持流式读取");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const drain = () => {
    for (;;) {
      const boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
      if (!boundary) return;
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);

      const { type, data } = parseStreamEvent(frame);
      try {
        onEvent({ type, ...(JSON.parse(data) as object) } as DebugEvent);
      } catch {
        // 坏帧丢掉：后面的帧仍然完整。
        continue;
      }
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drain();
    }
    buffer += decoder.decode();
    drain();
  } finally {
    reader.releaseLock();
  }
}
