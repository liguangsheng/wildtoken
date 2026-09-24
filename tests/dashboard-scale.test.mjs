// 看板显示倍率：计数乘倍率取整，比例和耗时不动。
import assert from "node:assert/strict";
import test from "node:test";

import { scaleDashboard } from "../web/src/dashboardScale.ts";

const usageWindow = { total_tokens: 1000, prompt_tokens: 800, prompt_cached_tokens: 200, request_count: 3, all_request_count: 4 };

function sample() {
  return {
    overview: {
      range: "7d", range_label: "7天", total_requests: 3, previous_total: null, error_requests: 1,
      status_2xx: 2, status_4xx: 1, status_5xx: 0, status_other: 0, duration_count: 3,
      avg_duration_ms: 120, min_duration_ms: 50, max_duration_ms: 200,
      p50_duration_ms: 100, p95_duration_ms: 190, p99_duration_ms: 200, bucket_seconds: 60,
      latency_series: [{ bucket_epoch: 1, avg_ms: 120, count: 3 }],
      request_series: [{ bucket_epoch: 1, count: 3 }],
    },
    top: {
      window: "7d",
      models: [{ name: "m", count: 3 }], channels: [{ name: "c", count: 3, id: 1 }],
      model_tokens: [{ name: "m", count: 1000 }], channel_tokens: [{ name: "c", count: 1000 }],
    },
    usage: { today: usageWindow, one_day: usageWindow, seven_days: usageWindow, thirty_days: usageWindow, all_time: usageWindow },
  };
}

test("倍率 1 原样返回", () => {
  const data = sample();
  assert.equal(scaleDashboard(data, 1), data);
});

test("计数乘倍率并取整", () => {
  const out = scaleDashboard(sample(), 1.5);
  assert.equal(out.overview.total_requests, 5); // 4.5 → 5
  assert.equal(out.overview.error_requests, 2); // 1.5 → 2
  assert.equal(out.overview.status_2xx, 3);
  assert.equal(out.overview.request_series[0].count, 5);
  assert.equal(out.top.channels[0].count, 5);
  assert.equal(out.top.channels[0].id, 1);
  assert.equal(out.top.model_tokens[0].count, 1500);
  assert.deepEqual(out.usage.today, {
    total_tokens: 1500, prompt_tokens: 1200, prompt_cached_tokens: 300, request_count: 5, all_request_count: 6,
  });
});

test("耗时和空值不动", () => {
  const out = scaleDashboard(sample(), 2);
  assert.equal(out.overview.avg_duration_ms, 120);
  assert.equal(out.overview.p95_duration_ms, 190);
  assert.equal(out.overview.latency_series[0].avg_ms, 120);
  assert.equal(out.overview.previous_total, null);
});

test("非法倍率按 1 处理", () => {
  for (const m of [0, -2, NaN, undefined]) {
    assert.equal(scaleDashboard(sample(), m).overview.total_requests, 3);
  }
});
