import type { LogOverview, TokenUsage, TokenUsageWindow, TopItem, TopStats } from "./types";

/**
 * 看板显示倍率：请求数和 Tokens 数乘上倍率再显示。
 *
 * 只动计数，不动比例和耗时——错误率、缓存率、延迟乘了也不变或没意义。
 * 取整：1.5 × 3 条请求显示 5，不显示 4.5。
 * 例：倍率 2，total_requests 10 → 20，avg_duration_ms 不变。
 */
export function scaleDashboard(
  data: { overview: LogOverview; top: TopStats; usage: TokenUsage },
  multiplier: number,
): { overview: LogOverview; top: TopStats; usage: TokenUsage } {
  // 非法倍率按 1 处理，免得看板全是 NaN。
  const m = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  if (m === 1) return data;

  const n = (value: number) => Math.round(value * m);
  const items = (rows: TopItem[] | null | undefined) =>
    (rows ?? []).map((row) => ({ ...row, count: n(row.count) }));
  const usageWindow = (w: TokenUsageWindow | undefined) =>
    w && {
      total_tokens: n(w.total_tokens),
      prompt_tokens: n(w.prompt_tokens),
      prompt_cached_tokens: n(w.prompt_cached_tokens),
      request_count: n(w.request_count),
      all_request_count: n(w.all_request_count),
    };

  const { overview, top, usage } = data;
  return {
    overview: {
      ...overview,
      total_requests: n(overview.total_requests),
      previous_total: overview.previous_total === null ? null : n(overview.previous_total),
      error_requests: n(overview.error_requests),
      status_2xx: n(overview.status_2xx),
      status_4xx: n(overview.status_4xx),
      status_5xx: n(overview.status_5xx),
      status_other: n(overview.status_other),
      duration_count: n(overview.duration_count),
      latency_series: overview.latency_series.map((b) => ({ ...b, count: n(b.count) })),
      request_series: overview.request_series.map((b) => ({ ...b, count: n(b.count) })),
    },
    top: {
      ...top,
      models: items(top.models),
      channels: items(top.channels),
      model_tokens: items(top.model_tokens),
      channel_tokens: items(top.channel_tokens),
    },
    usage: {
      ...usage,
      today: usageWindow(usage.today)!,
      one_day: usageWindow(usage.one_day)!,
      seven_days: usageWindow(usage.seven_days)!,
      thirty_days: usageWindow(usage.thirty_days)!,
      all_time: usageWindow(usage.all_time)!,
    },
  };
}
