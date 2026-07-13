// ── Dashboard ────────────────────────────────────────────

function formatCompactNumber(value) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (Math.abs(value) >= 10_000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(Math.round(value));
}

function tokenUsageCard(label, usage, scopeLabel) {
  const totalTokens = Number(usage?.total_tokens);
  const requestCount = Number(usage?.request_count);
  const safeTotal = Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : 0;
  const safeCount = Number.isFinite(requestCount) && requestCount > 0 ? requestCount : 0;
  return {
    value: formatCompactNumber(safeTotal),
    label,
    hint: safeCount
      ? `${scopeLabel} · ${formatCompactNumber(safeCount)} 条有 token 记录`
      : `${scopeLabel} · 暂无 token 记录`,
    tone: "",
  };
}

function requestCountCard(label, usage, scopeLabel) {
  const requestCount = Number(usage?.all_request_count);
  const safeCount = Number.isFinite(requestCount) && requestCount > 0 ? requestCount : 0;
  return {
    value: formatCompactNumber(safeCount),
    label,
    hint: `${scopeLabel} · 全部日志`,
    tone: "",
  };
}

function renderDashboardKpiCards(container, cards) {
  if (!container) return;
  container.innerHTML = cards.map((card) => `
    <div class="dashboard-kpi ${card.tone}">
      <div class="dashboard-kpi-value">${escapeHtml(card.value)}</div>
      <div class="dashboard-kpi-label">${escapeHtml(card.label)}</div>
      <div class="dashboard-kpi-hint">${escapeHtml(card.hint)}</div>
    </div>
  `).join("");
}

function buildSparklineSvg(values, { width = 240, height = 44 } = {}) {
  if (!values.length) {
    return '<div class="dashboard-chart-empty">暂无耗时数据</div>';
  }
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1);
  const pad = 2;
  const points = values.map((value, index) => {
    const x = pad + (index / Math.max(values.length - 1, 1)) * (width - pad * 2);
    const y = height - pad - ((value - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const area = `${pad},${height - pad} ${points} ${width - pad},${height - pad}`;
  return `
    <svg class="ops-chart-svg dashboard-spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <polyline fill="none" stroke="var(--accent)" stroke-width="1.8" points="${points}" />
      <polygon fill="var(--accent-soft)" points="${area}" opacity="0.75" />
    </svg>
  `;
}

function countStatusBuckets(items) {
  let c2 = 0;
  let c4 = 0;
  let c5 = 0;
  let cOther = 0;
  for (const item of items) {
    const code = item.status_code;
    if (code === null || code === undefined) {
      cOther += 1;
      continue;
    }
    const value = Number(code);
    if (value >= 200 && value < 300) c2 += 1;
    else if (value >= 400 && value < 500) c4 += 1;
    else if (value >= 500) c5 += 1;
    else cOther += 1;
  }
  return { c2, c4, c5, cOther };
}

function topCounts(items, keyFn, limit = 5) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "zh"))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function renderDashboardRankList(container, rows, emptyText) {
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = `<div class="dashboard-chart-empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  const max = Math.max(...rows.map((row) => row.count), 1);
  container.innerHTML = rows.map((row) => {
    const width = Math.max(4, (row.count / max) * 100);
    return `
      <div class="dashboard-rank-row" title="${escapeHtml(row.name)} · ${row.count}">
        <div class="dashboard-rank-head">
          <span class="dashboard-rank-name">${escapeHtml(row.name)}</span>
          <span class="dashboard-rank-count">${row.count}</span>
        </div>
        <div class="dashboard-rank-track" aria-hidden="true">
          <span class="dashboard-rank-fill" style="width:${width.toFixed(1)}%"></span>
        </div>
      </div>
    `;
  }).join("");
}

function renderDashboard() {
  const items = Array.isArray(dashboardLogItems) ? dashboardLogItems : [];
  const n = items.length;
  const totalChannels = upstreams.length;
  const enabledCount = upstreams.filter((item) => item.enabled).length;
  const disabledCount = totalChannels - enabledCount;

  let errorCount = 0;
  let durationSum = 0;
  let durationCount = 0;
  const durations = [];
  for (const item of items) {
    const statusCode = item.status_code;
    if (statusCode === null || statusCode === undefined) {
      errorCount += 1;
    } else {
      const code = Number(statusCode);
      if (!Number.isFinite(code) || code < 200 || code >= 300) {
        errorCount += 1;
      }
    }
    const durationMs = Number(item.duration_ms);
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      durationSum += durationMs;
      durationCount += 1;
      durations.push(durationMs);
    }
  }

  const errorRateLabel = n > 0
    ? `${((errorCount / n) * 100).toFixed(1).replace(/\.0$/, "")}%`
    : "—";
  const avgDurationLabel = durationCount > 0
    ? `${(durationSum / durationCount / 1000).toFixed(1)}s`
    : "—";

  if (dashboardScope) {
    dashboardScope.textContent = n > 0
      ? `基于已加载的近 ${n} 条日志与 ${totalChannels} 个渠道状态 · 非全库实时统计`
      : "基于已加载的近窗日志与渠道状态 · 非全库实时统计";
  }

  const errorTone = n === 0
    ? ""
    : errorCount / n >= 0.2
      ? "tone-danger"
      : errorCount / n >= 0.05
        ? "tone-warn"
        : "tone-ok";
  renderDashboardKpiCards(dashboardKpis, [
    {
      value: String(n),
      label: "近窗请求",
      hint: n ? "已加载日志条数" : "暂无近窗数据",
      tone: "",
    },
    {
      value: errorRateLabel,
      label: "错误率",
      hint: n ? `${errorCount} / ${n} 条失败` : "暂无日志",
      tone: errorTone,
    },
    {
      value: avgDurationLabel,
      label: "平均耗时",
      hint: durationCount ? `有效 ${durationCount} 条` : "暂无耗时",
      tone: "",
    },
    {
      value: `${enabledCount}/${totalChannels}`,
      label: "启用渠道",
      hint: totalChannels ? `停用 ${disabledCount}` : "暂无渠道",
      tone: "",
    },
  ]);
  renderDashboardKpiCards(dashboardTokenKpis, [
    tokenUsageCard("今天 Tokens", dashboardTokenUsage?.today, "本地日累计"),
    tokenUsageCard("1d Tokens", dashboardTokenUsage?.one_day, "最近 24 小时"),
    tokenUsageCard("7d Tokens", dashboardTokenUsage?.seven_days, "最近 7 天"),
    tokenUsageCard("30d Tokens", dashboardTokenUsage?.thirty_days, "最近 30 天"),
  ]);
  renderDashboardKpiCards(dashboardRequestKpis, [
    requestCountCard("今天请求", dashboardTokenUsage?.today, "本地日累计"),
    requestCountCard("1d 请求", dashboardTokenUsage?.one_day, "最近 24 小时"),
    requestCountCard("7d 请求", dashboardTokenUsage?.seven_days, "最近 7 天"),
    requestCountCard("30d 请求", dashboardTokenUsage?.thirty_days, "最近 30 天"),
  ]);

  const { c2, c4, c5, cOther } = countStatusBuckets(items);
  if (dashboardStatusMeta) {
    dashboardStatusMeta.textContent = `近 ${n} 条`;
  }
  if (dashboardStatusChart) {
    if (n === 0) {
      dashboardStatusChart.innerHTML = '<div class="dashboard-chart-empty">暂无近窗日志</div>';
    } else {
      const pct = (count) => (count / n) * 100;
      const barSeg = (cls, count) => {
        const width = pct(count);
        if (width <= 0) return "";
        return `<span class="ops-bar-seg ${cls}" style="width:${width.toFixed(2)}%" title="${count}"></span>`;
      };
      dashboardStatusChart.innerHTML = `
        <div class="ops-bar-track" role="img" aria-label="2xx ${c2} · 4xx ${c4} · 5xx ${c5} · 其他 ${cOther}">
          ${barSeg("ok", c2)}${barSeg("warn", c4)}${barSeg("danger", c5)}${barSeg("muted", cOther)}
        </div>
        <div class="ops-chart-legend">
          <span>2xx ${c2}</span>
          <span>4xx ${c4}</span>
          <span>5xx ${c5}</span>
          <span>其他 ${cOther}</span>
        </div>
      `;
    }
  }

  // sparkline: reverse so oldest is left
  const spark = durations.slice(0, 40).reverse();
  if (dashboardLatencyMeta) {
    dashboardLatencyMeta.textContent = durationCount ? `近窗有效 ${durationCount} 条` : "暂无数据";
  }
  if (dashboardLatencyChart) {
    if (!durationCount) {
      dashboardLatencyChart.innerHTML = '<div class="dashboard-chart-empty">暂无近窗有效耗时</div>';
    } else {
      const latestDuration = durations[0];
      const minDuration = Math.min(...durations);
      const maxDuration = Math.max(...durations);
      const averageDuration = durationSum / durationCount;
      dashboardLatencyChart.innerHTML = `
        ${buildSparklineSvg(spark, { width: 320, height: 100 })}
        <dl class="dashboard-latency-summary" aria-label="已加载近窗 ${durationCount} 条有效耗时的延迟摘要">
          <div><dt>最近</dt><dd>${escapeHtml(formatSeconds(latestDuration))}</dd></div>
          <div><dt>平均</dt><dd>${escapeHtml(formatSeconds(averageDuration))}</dd></div>
          <div><dt>范围</dt><dd>${escapeHtml(formatSeconds(minDuration))}–${escapeHtml(formatSeconds(maxDuration))}</dd></div>
        </dl>
      `;
    }
  }

  const topModels = topCounts(items, (item) => item.model || "", 5);
  const topChannels = topCounts(
    items,
    (item) => item.upstream_name || (item.upstream_id != null ? `#${item.upstream_id}` : ""),
    5,
  );
  if (dashboardModelsMeta) {
    dashboardModelsMeta.textContent = n > 0 ? `按请求数 · Top ${topModels.length || 0}` : "按请求数";
  }
  if (dashboardChannelsMeta) {
    dashboardChannelsMeta.textContent = n > 0 ? `按请求数 · Top ${topChannels.length || 0}` : "按请求数";
  }
  renderDashboardRankList(dashboardTopModels, topModels, "暂无模型请求数据");
  renderDashboardRankList(dashboardTopChannels, topChannels, "暂无渠道请求数据");

  if (dashboardErrorRows) {
    const errors = items
      .filter((item) => {
        const code = item.status_code;
        return code === null || code === undefined || Number(code) >= 400;
      })
      .slice(0, 8);
    if (errors.length === 0) {
      dashboardErrorRows.innerHTML = `
        <tr>
          <td colspan="5" class="empty">
            <span class="muted">${n ? "近窗内暂无 4xx/5xx/无响应记录" : "暂无近窗日志"}</span>
          </td>
        </tr>
      `;
    } else {
      dashboardErrorRows.innerHTML = errors.map((log) => {
        const time = formatLogTimestamp(log.created_at);
        const channel = log.upstream_name
          ? escapeHtml(log.upstream_name)
          : '<span class="muted">未匹配</span>';
        const model = log.model
          ? `<code title="${escapeHtml(log.model)}">${escapeHtml(log.model)}</code>`
          : '<span class="muted">-</span>';
        return `
          <tr class="log-row dashboard-error-row" data-log-id="${log.id}" tabindex="0" title="点击查看请求详情">
            <td class="time-cell"><span>${escapeHtml(time)}</span><span class="muted">#${log.id}</span></td>
            <td class="channel-cell">${channel}</td>
            <td class="model-cell">${model}</td>
            <td>${formatStatusBadge(log.status_code)}</td>
            <td class="duration-cell">${escapeHtml(formatSeconds(log.duration_ms))}</td>
          </tr>
        `;
      }).join("");
    }
  }
}

async function loadDashboardData() {
  if (dashboardLoading) return;
  dashboardLoading = true;
  try {
    if (!upstreamsLoadedOnce) {
      await loadUpstreams();
    } else {
      // Refresh upstream snapshot for backoff/enabled counts without blocking on full table render paths.
      try {
        const list = await api("/api/admin/upstreams");
        upstreams = list;
        for (const upstream of upstreams) {
          upstream.backoffUntilMs = upstream.backoff_remaining_seconds
            ? Date.now() + upstream.backoff_remaining_seconds * 1000
            : null;
        }
        upstreamsLoadedOnce = true;
      } catch {
        // Keep previous upstreams cache if refresh fails.
      }
    }

    const params = new URLSearchParams({
      limit: String(DASHBOARD_LOG_LIMIT),
      offset: "0",
    });
    const [page, tokenUsage] = await Promise.all([
      api(`/api/admin/logs?${params}`),
      api("/api/admin/logs/token-usage"),
    ]);
    dashboardLogItems = page.items || [];
    dashboardTokenUsage = tokenUsage;
    lastDashboardLoadError = "";
    renderDashboard();
  } catch (error) {
    const message = `看板加载失败：${error.message}`;
    if (message !== lastDashboardLoadError) {
      setStatus(message, "error");
      lastDashboardLoadError = message;
    }
    if (dashboardScope) {
      dashboardScope.textContent = message;
    }
  } finally {
    dashboardLoading = false;
  }
}

const scheduleRenderUpstreamSummary = debounce(() => {
  renderUpstreamSummaryCore();
}, 120);
