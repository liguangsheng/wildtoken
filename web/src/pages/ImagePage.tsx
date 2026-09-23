import { useEffect, useMemo, useState } from "react";

import { UnauthorizedError, listUpstreams } from "../api";
import { ChannelPicker, RunHead, formatResponse, runTone } from "../components/DebugParts";
import { formatRequest } from "../components/ModelTestDialog";
import { candidateModels, formatBody, parseBody } from "../debugRequest";
import {
  collapseBase64,
  defaultImageBody,
  formatBytes,
  parseImageResponse,
  setField,
  withImageStream,
} from "../imageRequest";
import type { ImageItem } from "../imageRequest";
import type { Upstream } from "../types";
import { useDebugRuns } from "../useDebugRuns";
import type { Run } from "../useDebugRuns";

const DEFAULT_PROMPT = "一只在窗台上晒太阳的橘猫，柔和的午后光线，写实摄影风格。";

/** 下拉项。空值表示「不传」：字段从请求体里删掉，由上游用默认值。 */
const OPTIONS: Array<{ key: string; label: string; values: string[] }> = [
  { key: "quality", label: "质量", values: ["auto", "low", "medium", "high", "standard", "hd"] },
  { key: "background", label: "背景", values: ["auto", "transparent", "opaque"] },
  { key: "output_format", label: "输出格式", values: ["png", "jpeg", "webp"] },
  { key: "response_format", label: "返回方式", values: ["b64_json", "url"] },
];

const SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792", "512x512"];

/** 请求体里的字段读成字符串给控件用；不存在就是空串。 */
function fieldText(body: Record<string, unknown> | null, key: string): string {
  const value = body?.[key];
  return value === undefined || value === null ? "" : String(value);
}

/**
 * 生图页。
 *
 * 和调试页同一套发送与计时，请求发往渠道的 /v1/images/generations。表单
 * 控件直接读写请求体 JSON，两边永远一致。结果按图展示，流式时先出中间帧。
 * 会计费，会进日志。
 */
export function ImagePage({
  active,
  onUnauthorized,
}: {
  /** 切到别的视图时页面不卸载，只隐藏：表单、结果和进行中的请求都保留。 */
  active: boolean;
  onUnauthorized: (message: string) => void;
}) {
  const [upstreams, setUpstreams] = useState<Upstream[]>([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [bodyText, setBodyText] = useState(() => formatBody(defaultImageBody("", DEFAULT_PROMPT)));
  const { runs, running, now, send, stop } = useDebugRuns(onUnauthorized);

  useEffect(() => {
    let cancelled = false;
    listUpstreams()
      .then((channels) => {
        if (!cancelled) setUpstreams(channels.filter((item) => !item.archived));
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
  const body = useMemo(() => parseBody(bodyText), [bodyText]);

  /** 控件改请求体。请求体坏了时控件是禁用的，这里不会被调到。 */
  function patch(update: (current: Record<string, unknown>) => Record<string, unknown>) {
    if (body) setBodyText(formatBody(update(body)));
  }

  function toggleChannel(id: number) {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  function sendAll() {
    if (!body || selected.length === 0) return;
    const names = new Map(upstreams.map((item) => [item.id, item.name]));
    void send(
      selected.map((id) => ({ id, name: names.get(id) ?? `#${id}` })),
      { protocol: "images", model: fieldText(body, "model").trim(), body },
    );
  }

  const canSend = body !== null && selected.length > 0 && !running;
  const locked = body === null;

  return (
    <section className="view" data-view="images" hidden={!active}>
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">IMAGE DEBUG</span>
            <h2>生图</h2>
            <p>向一个或多个渠道发送生图请求，对比出图、耗时与原始响应。请求真实计费，并记入日志。</p>
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

                <div className="debug-params-side">
                  <label className="field">
                    <span className="field-label">Prompt</span>
                    <textarea
                      rows={4}
                      disabled={locked}
                      value={fieldText(body, "prompt")}
                      onChange={(event) => patch((current) => ({ ...current, prompt: event.target.value }))}
                    />
                  </label>

                  <div className="debug-options">
                    <label className="field">
                      <span className="field-label">模型</span>
                      <input
                        list="image-model-options"
                        autoComplete="off"
                        placeholder="选择或输入模型名"
                        disabled={locked}
                        value={fieldText(body, "model")}
                        onChange={(event) => patch((current) => ({ ...current, model: event.target.value.trim() }))}
                      />
                      <datalist id="image-model-options">
                        {modelOptions.map((name) => (
                          <option key={name} value={name} />
                        ))}
                      </datalist>
                    </label>

                    <label className="field">
                      <span className="field-label">尺寸</span>
                      <input
                        list="image-size-options"
                        autoComplete="off"
                        placeholder="不传"
                        disabled={locked}
                        value={fieldText(body, "size")}
                        onChange={(event) => patch((current) => setField(current, "size", event.target.value.trim()))}
                      />
                      <datalist id="image-size-options">
                        {SIZES.map((size) => (
                          <option key={size} value={size} />
                        ))}
                      </datalist>
                    </label>

                    <label className="field">
                      <span className="field-label">数量</span>
                      <input
                        type="number"
                        min={1}
                        max={10}
                        placeholder="不传"
                        disabled={locked}
                        value={fieldText(body, "n")}
                        onChange={(event) =>
                          patch((current) =>
                            setField(current, "n", event.target.value === "" ? "" : Number(event.target.value)),
                          )
                        }
                      />
                    </label>

                    {OPTIONS.map((option) => (
                      <label key={option.key} className="field">
                        <span className="field-label">{option.label}</span>
                        <select
                          disabled={locked}
                          value={fieldText(body, option.key)}
                          onChange={(event) => patch((current) => setField(current, option.key, event.target.value))}
                        >
                          <option value="">不传</option>
                          {option.values.map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}

                    <label className="debug-stream-toggle">
                      <input
                        type="checkbox"
                        disabled={locked}
                        checked={body?.stream === true}
                        onChange={(event) => patch((current) => withImageStream(current, event.target.checked))}
                      />
                      <span>流式（中间帧）</span>
                    </label>
                  </div>
                </div>
              </div>

              <div className="debug-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setBodyText(formatBody(defaultImageBody(fieldText(body, "model"), DEFAULT_PROMPT)))}
                >
                  重置请求体
                </button>
                {running ? (
                  <button type="button" className="secondary" onClick={stop}>
                    停止
                  </button>
                ) : null}
                <button type="submit" className="primary" disabled={!canSend}>
                  {running ? "生成中…" : selected.length > 1 ? `发送到 ${selected.length} 个渠道` : "生成"}
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
                  aria-invalid={locked}
                  onChange={(event) => setBodyText(event.target.value)}
                />
                <span className="field-hint">
                  {locked
                    ? "不是合法的 JSON 对象，改好前不能发送，左边的控件也暂时锁住。"
                    : "原样发给上游的 /v1/images/generations。控件和这里改的是同一份。"}
                </span>
              </label>
            </div>
          </form>

          <div className="debug-results">
            {runs.length === 0 ? (
              <div className="settings-card debug-empty">
                <p>选渠道、写 prompt，生成后图片出现在这里。</p>
              </div>
            ) : (
              runs.map((run) => <ImageRunCard key={run.upstreamId} run={run} now={now} />)
            )}
          </div>
        </div>
      </section>
    </section>
  );
}

function ImageRunCard({ run, now }: { run: Run; now: number }) {
  /* 非流式的响应是一整个 JSON，收全之前解析不出东西，也不必每块都试；流式
     的每个事件自成一体，边收边解析才能看到中间帧。 */
  const streaming = /^(data|event):/.test(run.raw);
  const parsed = useMemo(
    () => (run.raw && (streaming || run.phase !== "running") ? parseImageResponse(run.raw) : null),
    [run.raw, run.phase, streaming],
  );
  const shownResponse = useMemo(() => collapseBase64(run.raw), [run.raw]);

  // 有最终图就只看最终图；还在出中间帧时只看最新一帧。
  const finals = parsed?.images.filter((image) => image.partialIndex === null) ?? [];
  const partials = parsed?.images.filter((image) => image.partialIndex !== null) ?? [];
  const images = finals.length > 0 ? finals : partials.slice(-1);

  return (
    <article className="test-model-result debug-run" data-tone={runTone(run)}>
      <RunHead run={run} now={now} />

      <div className="debug-run-reply">
        {parsed?.error ? <p className="debug-run-error">{parsed.error}</p> : null}
        {images.length > 0 ? (
          <div className="image-gallery">
            {images.map((image, index) => (
              <ImageFigure key={`${image.partialIndex ?? "final"}-${index}`} image={image} name={run.name} index={index} />
            ))}
          </div>
        ) : parsed?.error ? null : (
          <p className="muted">{run.phase === "running" ? "生成中…" : "响应里没有图片。"}</p>
        )}
        {parsed?.usage ? <pre className="image-usage">{JSON.stringify(parsed.usage, null, 2)}</pre> : null}
      </div>

      <details className="test-model-details">
        <summary>完整请求</summary>
        <pre>{run.request ? formatRequest(run.request) : "请求尚未发出。"}</pre>
      </details>
      <details className="test-model-details">
        <summary>完整响应（base64 已折叠）</summary>
        <pre>{run.status === null && !run.raw ? "尚无响应。" : formatResponse(run, shownResponse)}</pre>
      </details>
    </article>
  );
}

function ImageFigure({ image, name, index }: { image: ImageItem; name: string; index: number }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const meta = [
    size ? `${size.width}×${size.height}` : null,
    image.format?.toUpperCase() ?? null,
    image.bytes !== null ? formatBytes(image.bytes) : null,
    image.partialIndex !== null ? `中间帧 #${image.partialIndex}` : null,
  ].filter(Boolean);

  const img = (
    <img
      src={image.src}
      alt={`${name} 第 ${index + 1} 张`}
      onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
    />
  );

  /* 只有上游给的 http 链接才包成「新标签打开」：浏览器禁止顶层导航到
     data: URL，包了也点不开。base64 图走下面的下载。 */
  return (
    <figure className="image-figure">
      {image.src.startsWith("http") ? (
        <a href={image.src} target="_blank" rel="noreferrer">
          {img}
        </a>
      ) : (
        img
      )}
      <figcaption>
        <span>{meta.join(" · ")}</span>
        {image.partialIndex === null ? (
          <a href={image.src} download={`${name}-${index + 1}.${image.format ?? "png"}`}>
            下载
          </a>
        ) : null}
      </figcaption>
      {image.revisedPrompt ? <p className="field-hint">改写后的 prompt：{image.revisedPrompt}</p> : null}
    </figure>
  );
}
