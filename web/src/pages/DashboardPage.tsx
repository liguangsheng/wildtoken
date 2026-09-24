import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { UnauthorizedError, fetchDashboard } from "../api";
import { scaleDashboard } from "../dashboardScale";
import type { LogOverview, RequestLog, TokenUsage, TopItem, TopStats } from "../types";

/* 时间档。值直接进 query，必须是后端 parseDashboardRange 认的词。

   旧版还有一个「对比」档（default），它让 token-usage 返回一组窗口而不是单个
   汇总，形状完全不同。没实现之前不放这个按钮——标一个点了会显示错数的档位，
   比少一个档位糟得多。 */
const RANGES = [
  { key: "today", label: "今天" },
  { key: "1d", label: "24小时" },
  { key: "3d", label: "3天" },
  { key: "7d", label: "7天" },
  { key: "30d", label: "30天" },
  { key: "all", label: "全部" },
] as const;

/* 和旧控制台同一个键，两版之间切换保持选择；默认值也照抄旧版的 30d。 */
const RANGE_KEY = "wildtoken_dashboard_range";
const CUSTOM_RANGE_KEY = "wildtoken_dashboard_custom_range";
const MASK_KEY = "wildtoken_dashboard_channel_name_hidden";
const DEFAULT_RANGE = "30d";

const VALID_RANGES = new Set([...RANGES.map((item) => item.key), "custom"]);

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存不进去不影响当前页面。
  }
}

/**
 * 接受纯日期和带时刻两种。
 *
 * datetime-local 没填秒时交的是 YYYY-MM-DDTHH:MM，填了秒才带上 :SS；
 * 旧的落盘值又是纯日期。三种都要能认，否则老用户的偏好会被当成非法值丢掉。
 */
function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(value);
}

/* 比大小用字典序：这几种写法都是固定宽度的大端格式，字典序和时间序
   一致。但纯日期和带时刻混着比时要补齐，否则 "2026-08-01" 会排在
   "2026-08-01T09:00" 前面——那正是我们要的语义（当天零点）。 */
function sameOrBefore(start: string, end: string): boolean {
  const pad = (value: string) => (value.includes("T") ? value : `${value}T00:00:00`);
  return pad(start) <= pad(end);
}

function readCustomRange(): { start: string; end: string } {
  const saved = readStored(CUSTOM_RANGE_KEY) ?? "";
  const [start, end] = saved.split("~");
  if (isDate(start) && isDate(end) && sameOrBefore(start, end)) return { start, end };
  return { start: "", end: "" };
}

function readRange(): string {
  const raw = readStored(RANGE_KEY) ?? "";
  if (!VALID_RANGES.has(raw)) return DEFAULT_RANGE;
  // 存着 custom 却没有日期时回落，否则看板一打开就发不出请求。
  if (raw === "custom") {
    const custom = readCustomRange();
    if (!custom.start || !custom.end) return DEFAULT_RANGE;
  }
  return raw;
}

/* 和日志页同一套：固定六个星号。按长度变化的遮罩会把名字长度和首尾字符
   泄露出去，那恰恰是遮罩要藏的东西。 */
const SENSITIVE_MASK = "******";

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

/** KPI 卡。hint 放 title，卡面留给数字——照抄旧版 hoverHint 的做法。 */
function Kpi({
  label,
  value,
  hint,
  tone = "",
  denominator,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: string;
  denominator?: string;
}) {
  return (
    <div className={tone ? `dashboard-kpi ${tone}` : "dashboard-kpi"} title={hint}>
      <div className="dashboard-kpi-value">
        <span className="kpi-number">{value}</span>
        {denominator ? <span className="kpi-denominator">{denominator}</span> : null}
      </div>
      <div className="dashboard-kpi-label">{label}</div>
    </div>
  );
}

/** 延迟趋势。JSX 的 <svg> 走 createElementNS，属性齐全且真的会渲染。 */
function Sparkline({ values }: { values: number[] }) {
  const gradientId = useId();
  if (values.length < 2) return <div className="dashboard-chart-empty">所选范围内暂无请求</div>;

  const width = 320;
  const height = 100;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const line = values
    .map((value, index) => {
      const x = index * step;
      const y = height - (value / max) * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      className="ops-chart-svg dashboard-spark"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.25} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0.04} />
        </linearGradient>
      </defs>
      <path
        className="spark-morph-area"
        d={`${line} L${width} ${height} L0 ${height} Z`}
        fill={`url(#${gradientId})`}
      />
      <path className="spark-morph-line" d={line} fill="none" stroke="currentColor" />
    </svg>
  );
}

/** 状态分布：一条按 2xx/4xx/5xx/其他 分段的横条。 */
function StatusBar({ overview }: { overview: LogOverview }) {
  const total = overview.total_requests;
  if (total === 0) return <div className="dashboard-chart-empty">所选范围内暂无请求</div>;

  /* 四档的类名就是 ok/warn/danger/muted，和 .ops-bar-seg 组合出颜色。图例的
     小圆点复用同一组类——几何由 status-legend-dot 压成圆点。 */
  const segments = [
    { tone: "ok", label: "2xx", count: overview.status_2xx },
    { tone: "warn", label: "4xx", count: overview.status_4xx },
    { tone: "danger", label: "5xx", count: overview.status_5xx },
    { tone: "muted", label: "其他", count: overview.status_other },
  ];

  return (
    <>
      <div className="ops-bar-track" role="img" aria-label="状态码分布">
        {segments.map((segment) =>
          segment.count > 0 ? (
            <span
              key={segment.label}
              className={`ops-bar-seg ${segment.tone}`}
              style={{ width: `${((segment.count / total) * 100).toFixed(2)}%` }}
              title={`${segment.label} ${segment.count}`}
            />
          ) : null,
        )}
      </div>
      <div className="status-legend">
        {segments.map((segment) => (
          <span key={segment.label} className="status-legend-item">
            <span className={`status-legend-dot ops-bar-seg ${segment.tone}`} aria-hidden="true" />
            <span className="status-legend-label">{segment.label}</span>
            <span className="status-legend-count">{segment.count}</span>
          </span>
        ))}
      </div>
    </>
  );
}

/**
 * 排行卡。
 *
 * 数值字段就叫 count——请求榜和 Tokens 榜是接口返回的**两组独立数据**，
 * 不是同一组换个字段排序。按 request_count / total_tokens 取到的是 undefined，
 * 算出来全是 NaN。
 */
function RankCard({
  title,
  meta,
  rows,
  maskNames,
}: {
  title: string;
  meta: string;
  rows: TopItem[];
  maskNames: boolean;
}) {
  // 后端已经排好序，这里不再排；只防一下非法值。
  const valueOf = (row: TopItem) => (Number.isFinite(row.count) ? row.count : 0);
  const sorted = rows;
  const max = Math.max(...sorted.map(valueOf), 1);

  return (
    <article className="dashboard-card wt-card">
      <div className="dashboard-card-head wt-card-head">
        <h3>{title}</h3>
        <span className="dashboard-card-meta wt-meta">{meta}</span>
      </div>
      <div className="dashboard-list">
        {sorted.length === 0 ? (
          <div className="dashboard-chart-empty">暂无数据</div>
        ) : (
          sorted.map((row) => {
            const display = maskNames ? SENSITIVE_MASK : row.name;
            return (
              <div
                key={row.name}
                className="dashboard-rank-row"
                title={`${display} · ${compact(valueOf(row))}`}
              >
                <div className="dashboard-rank-head">
                  <span className={maskNames ? "dashboard-rank-name is-masked" : "dashboard-rank-name"}>
                    {display}
                  </span>
                  <span className="dashboard-rank-count">{compact(valueOf(row))}</span>
                </div>
                <div className="dashboard-rank-track" aria-hidden="true">
                  <span
                    className="dashboard-rank-fill"
                    style={{ width: `${((valueOf(row) / max) * 100).toFixed(1)}%` }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </article>
  );
}

export function DashboardPage({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const [range, setRange] = useState(readRange);
  const [custom, setCustom] = useState(readCustomRange);
  /* 草稿和已生效的区间分开。日期框每改一下就发请求的话，输到一半的月份会
     打出一堆没人要的查询。点「应用」才落到 custom。 */
  const [draft, setDraft] = useState(readCustomRange);
  const [maskChannels, setMaskChannels] = useState(() => readStored(MASK_KEY) === "true");
  const [overview, setOverview] = useState<LogOverview | null>(null);
  const [top, setTop] = useState<TopStats | null>(null);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [recent, setRecent] = useState<RequestLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /* 选了自定义但日期还没填齐时不发请求。点一下那个档位就能打出三个
     start_date= 空值的 400，而界面上只会变成一片破折号。 */
  const pending = range === "custom" && !(isDate(custom.start) && isDate(custom.end));

  const load = useCallback(async () => {
    if (pending) {
      setLoading(false);
      return;
    }
    try {
      const raw = await fetchDashboard(range, custom);
      // 全局设置里的显示倍率，所有计数在这里统一乘上。
      const data = { ...raw, ...scaleDashboard(raw, raw.multiplier) };
      setOverview(data.overview);
      setTop(data.top);
      setUsage(data.usage);
      // 最近失败只取有错或非 2xx 的行。
      setRecent(
        (data.recent.items ?? []).filter(
          (log) => log.error !== null || log.status_code === null || log.status_code >= 400,
        ),
      );
      setError("");
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [range, custom, pending, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  function switchRange(next: string) {
    setRange(next);
    writeStored(RANGE_KEY, next);
  }

  function applyCustom() {
    if (!isDate(draft.start) || !isDate(draft.end)) return;
    if (!sameOrBefore(draft.start, draft.end) || draft.start === draft.end) return;
    setCustom(draft);
    setRange("custom");
    writeStored(RANGE_KEY, "custom");
    writeStored(CUSTOM_RANGE_KEY, `${draft.start}~${draft.end}`);
  }

  function toggleMask() {
    setMaskChannels((current) => {
      const next = !current;
      writeStored(MASK_KEY, String(next));
      return next;
    });
  }

  const rangeLabel = overview?.range_label ?? "";
  const total = overview?.total_requests ?? 0;
  const errorRate =
    overview && total > 0 ? ((overview.error_requests / total) * 100).toFixed(1) : null;
  const errorTone =
    errorRate === null ? "" : Number(errorRate) >= 10 ? "tone-danger" : Number(errorRate) >= 2 ? "tone-warn" : "";
  /* 响应总是嵌套的：选了具体时间窗时，服务端把该窗的聚合值塞进 today。
     按扁平结构取字段全是 undefined，卡片渲染成 NaN。 */
  /* 滑块要量选中那个按钮的实际几何。用 layout effect 是为了在浏览器绘制前
     就定位，否则切档时能看见它从旧位置跳过去。 */
  const segRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const thumb = thumbRef.current;
    const active = segRef.current?.querySelector<HTMLElement>("[data-dashboard-range].is-active");
    if (!thumb) return;
    if (!active) {
      thumb.style.opacity = "0";
      return;
    }
    thumb.style.width = `${active.offsetWidth}px`;
    thumb.style.height = `${active.offsetHeight}px`;
    thumb.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    thumb.style.opacity = "1";
  }, [range]);

  // 不叫 window：会遮蔽全局对象。
  const usageWindow = usage?.today;
  const cacheRate =
    usageWindow && usageWindow.prompt_tokens > 0
      ? `${((usageWindow.prompt_cached_tokens / usageWindow.prompt_tokens) * 100).toFixed(1)}%`
      : "—";

  return (
    <section className="view" data-view="dashboard">
      <section className="panel dashboard-panel wt-page" data-dashboard-window="single">
        <div className="panel-head wt-page-head">
          <div className="wt-page-copy">
            <span className="eyebrow">TRAFFIC OVERVIEW</span>
            <h2>数据看板</h2>
            <p>近窗图表基于已加载日志；Top 排行按所选周期查询日志库</p>
          </div>

          <div className="dashboard-time-filter wt-toolbar">
            <div className="wt-seg" role="group" aria-label="看板统计时间范围" ref={segRef}>
              {/* 滑块基线是 opacity 0，尺寸和位置全靠脚本算——只放个空 span 的话
                  它永远不显示。 */}
              <span className="wt-seg-thumb" aria-hidden="true" ref={thumbRef} />
              {RANGES.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  /* is-active 是选中态的唯一凭据：CSS 里没有任何规则看 aria-pressed，
                     只设无障碍属性的话屏上看不出选中了哪个档。 */
                  className={range === item.key ? "wt-seg-btn is-active" : "wt-seg-btn"}
                  data-dashboard-range={item.key}
                  aria-pressed={range === item.key}
                  onClick={() => switchRange(item.key)}
                >
                  {item.label}
                </button>
              ))}
              <button
                type="button"
                className={
                  range === "custom"
                    ? "wt-seg-btn dashboard-custom-chip is-active"
                    : "wt-seg-btn dashboard-custom-chip"
                }
                data-dashboard-range="custom"
                aria-pressed={range === "custom"}
                onClick={() => switchRange("custom")}
              >
                自定义
              </button>
            </div>

            {/* is-open 是可见性开关，不是装饰：基线规则是 opacity 0，只拿掉 hidden
                面板仍然全透明，点“自定义”像没反应。内部元素还有同样一道门。 */}
            <div
              className={
                range === "custom"
                  ? "dashboard-custom-range is-open"
                  : "dashboard-custom-range"
              }
              hidden={range !== "custom"}
              aria-hidden={range !== "custom"}
            >
              <div className="dashboard-custom-range-inner">
                {/* step=1 才会出秒位；不给的话控件只到分钟。 */}
                <label className="dashboard-date-field">
                  <span className="dashboard-date-text">开始</span>
                  <input
                    type="datetime-local"
                    step="1"
                    aria-label="开始时间"
                    value={draft.start}
                    onChange={(event) => setDraft({ ...draft, start: event.target.value })}
                  />
                </label>
                <span className="dashboard-date-sep">至</span>
                <label className="dashboard-date-field">
                  <span className="dashboard-date-text">结束</span>
                  <input
                    type="datetime-local"
                    step="1"
                    aria-label="结束时间"
                    value={draft.end}
                    onChange={(event) => setDraft({ ...draft, end: event.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="secondary dashboard-apply-custom"
                  /* 起止相等也不行：空区间选不出任何东西，后端也会 400。 */
                  disabled={
                    !isDate(draft.start) ||
                    !isDate(draft.end) ||
                    !sameOrBefore(draft.start, draft.end) ||
                    draft.start === draft.end
                  }
                  onClick={applyCustom}
                >
                  应用
                </button>
              </div>
            </div>
          </div>
        </div>

        {error ? (
          <p className="settings-inline-status" role="alert">
            {error}
          </p>
        ) : null}

        <div className="wt-page-body dashboard-layout">
          {/* 四个度量区打散成一片：去掉标题和外框，卡片直接进同一个网格。
              每张卡自带标签和注解，分组标题只是多一层边框。 */}
          <div className="dashboard-kpis wt-metric-grid kpi-flip dashboard-kpis--flat">
            <Kpi
                label="请求数"
                value={compact(total)}
                hint={total ? `${rangeLabel} · 共 ${total} 条` : `${rangeLabel} · 暂无请求`}
              />
              <Kpi
                label="错误率"
                value={errorRate === null ? "—" : `${errorRate}%`}
                hint={total ? `${overview?.error_requests ?? 0} / ${total} 条失败` : "暂无日志"}
                tone={errorTone}
              />
              <Kpi
                label="平均耗时"
                value={overview ? formatMs(overview.avg_duration_ms) : "—"}
                hint={overview?.duration_count ? `有效 ${overview.duration_count} 条` : "暂无耗时"}
              />
            <Kpi
              label="Tokens"
              value={usageWindow ? compact(usageWindow.total_tokens) : "—"}
              hint={`${rangeLabel} · 输入 ${compact(usageWindow?.prompt_tokens ?? 0)}`}
            />
            <Kpi
              label="缓存率"
              value={cacheRate}
              hint={`命中 ${compact(usageWindow?.prompt_cached_tokens ?? 0)} / 输入 ${compact(usageWindow?.prompt_tokens ?? 0)}`}
            />
            <Kpi
              label="请求（全部）"
              value={usageWindow ? compact(usageWindow.all_request_count) : "—"}
              hint={`计入用量 ${compact(usageWindow?.request_count ?? 0)} 条`}
            />
          </div>

          <div className="dashboard-grid dashboard-insight">
            <article className="dashboard-card wt-card">
              <div className="dashboard-card-head wt-card-head">
                <h3>状态分布</h3>
                <span className="dashboard-card-meta wt-meta">{rangeLabel}</span>
              </div>
              <div className="dashboard-chart">
                {overview ? <StatusBar overview={overview} /> : null}
              </div>
            </article>

            <article className="dashboard-card wt-card">
              <div className="dashboard-card-head wt-card-head">
                <h3>延迟趋势</h3>
                <span className="dashboard-card-meta wt-meta">
                  {overview ? `P95 ${formatMs(overview.p95_duration_ms)}` : ""}
                </span>
              </div>
              <div className="dashboard-chart">
                <Sparkline values={overview?.request_series.map((bucket) => bucket.count) ?? []} />
              </div>
            </article>
          </div>

          <section className="wt-section dashboard-rankings">
            <div className="dashboard-ranking-toolbar wt-section-head">
              <div className="wt-section-copy">
                <h3>Top 排行</h3>
                <p className="dashboard-card-sub wt-sub">
                  渠道请求、渠道 Tokens、模型请求、模型 Tokens 按所选周期统计；模型按实际转发给上游的名称归类
                </p>
              </div>
              <div className="dashboard-ranking-controls">
                <button
                  type="button"
                  className={
                    maskChannels
                      ? "secondary ghost log-sensitive-toggle is-active"
                      : "secondary ghost log-sensitive-toggle"
                  }
                  aria-pressed={maskChannels}
                  /* 只留图标，说明走 title 和 aria-label——和日志页的同类按钮一致。 */
                  aria-label={maskChannels ? "显示渠道名" : "屏蔽渠道名"}
                  title={maskChannels ? "渠道名已屏蔽，点击显示" : "点击屏蔽渠道名"}
                  onClick={toggleMask}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      className="log-sensitive-eye"
                      d="M2.5 12s3.4-5.5 9.5-5.5S21.5 12 21.5 12 18.1 17.5 12 17.5 2.5 12 2.5 12Z"
                    />
                    {maskChannels ? <path className="log-sensitive-slash" d="m4 4 16 16" /> : null}
                  </svg>
                </button>
                <button type="button" className="secondary" onClick={() => void load()}>
                  刷新
                </button>
              </div>
            </div>

            <div className="dashboard-grid dashboard-rank-grid">
              <RankCard
                title="Top 渠道请求"
                meta={rangeLabel}
                rows={top?.channels ?? []}
                maskNames={maskChannels}
              />
              {/* Tokens 榜走 channel_tokens，不是把请求榜换个字段重排。 */}
              <RankCard
                title="Top 渠道 Tokens"
                meta={rangeLabel}
                rows={top?.channel_tokens ?? []}
                maskNames={maskChannels}
              />
              <RankCard
                title="Top 模型请求"
                meta={rangeLabel}
                rows={top?.models ?? []}
                maskNames={false}
              />
              <RankCard
                title="Top 模型 Tokens"
                meta={rangeLabel}
                rows={top?.model_tokens ?? []}
                maskNames={false}
              />
            </div>
          </section>

          <article className="dashboard-card dashboard-card-wide wt-card">
            <div className="panel-head dashboard-card-head wt-card-head">
              <div>
                <h3>最近失败</h3>
                <p className="dashboard-card-sub wt-sub">近窗内 4xx/5xx/无响应</p>
              </div>
            </div>
            <div className="table-wrap">
              <table className="admin-table dashboard-error-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>渠道</th>
                    <th>模型</th>
                    <th>状态</th>
                    <th>耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={5} className="muted">加载中…</td>
                    </tr>
                  ) : recent.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="muted">近窗内没有失败请求</td>
                    </tr>
                  ) : (
                    recent.map((log) => (
                      <tr key={log.id} className="dashboard-error-row">
                        <td>{log.created_at.slice(11, 19)}</td>
                        <td>
                          {log.upstream_name
                            ? maskChannels
                              ? SENSITIVE_MASK
                              : log.upstream_name
                            : "-"}
                        </td>
                        <td>{log.upstream_model ?? log.model ?? "-"}</td>
                        <td>
                          {log.status_code === null ? (
                            <span className="muted">无响应</span>
                          ) : (
                            <span className="badge danger">{log.status_code}</span>
                          )}
                        </td>
                        <td>{log.duration_ms === null ? "-" : formatMs(log.duration_ms)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </article>
        </div>
      </section>
    </section>
  );
}
