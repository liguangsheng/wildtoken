// Request log list, performance formatting, snapshots, and detail dialog.
const LOG_SENSITIVE_MASK = "******";
let logPageItems = [];
let logPageFiltersActive = false;

function formatLogUpstreamFilterLabel(upstream) {
  const id = upstream?.id;
  const name = String(upstream?.name || "").trim();
  if (logSensitiveHidden && name) {
    return `#${id} · ${LOG_SENSITIVE_MASK}`;
  }
  return name ? `#${id} ${name}` : `#${id}`;
}

function renderLogFilterOptions() {
  const selected = logUpstreamFilter.value;
  logUpstreamFilter.innerHTML = '<option value="">全部渠道</option>';
  for (const upstream of upstreams) {
    const option = document.createElement("option");
    option.value = upstream.id;
    option.textContent = formatLogUpstreamFilterLabel(upstream);
    logUpstreamFilter.append(option);
  }
  logUpstreamFilter.value = selected;
}

/** Plain-text channel label; prefer upstream_id, fall back to name. */
function formatLogChannelLabel(log) {
  const id = log?.upstream_id;
  const name = (log?.upstream_name || "").trim();
  if (id !== null && id !== undefined) {
    if (logSensitiveHidden && name) {
      return `#${id} · ${LOG_SENSITIVE_MASK}`;
    }
    return name ? `#${id} · ${name}` : `#${id}`;
  }
  if (logSensitiveHidden && name) {
    return LOG_SENSITIVE_MASK;
  }
  return name || "未匹配到渠道";
}

/** List-cell channel stack: id primary, name secondary. */
function formatLogChannelStack(log) {
  const id = log?.upstream_id;
  const name = (log?.upstream_name || "").trim();
  const nameHidden = logSensitiveHidden && Boolean(name);
  const displayName = nameHidden ? LOG_SENSITIVE_MASK : name;
  if (id === null || id === undefined) {
    if (name) {
      return `
        <div class="channel-stack">
          <strong${nameHidden ? " class=\"log-sensitive-value\"" : ` title="${escapeHtml(name)}"`}>${escapeHtml(nameHidden ? LOG_SENSITIVE_MASK : name)}</strong>
          <span class="muted">无 ID</span>
        </div>
      `;
    }
    return "<span class=\"muted\">无（未匹配到渠道）</span>";
  }
  const title = name ? `#${id} · ${displayName}` : `#${id}`;
  const nameLine = name
    ? `<span class="muted${nameHidden ? " log-sensitive-value" : ""}"${nameHidden ? "" : ` title="${escapeHtml(name)}"`}>${escapeHtml(displayName)}</span>`
    : "<span class=\"muted\">无名称</span>";
  return `
    <div class="channel-stack">
      <strong title="${escapeHtml(title)}">#${id}</strong>
      ${nameLine}
    </div>
  `;
}

function formatLogToken(log) {
  const name = String(log?.downstream_token_name || "").trim();
  if (!name) {
    return '<span class="muted">-</span>';
  }
  if (logSensitiveHidden) {
    return `<span class="log-sensitive-value">${LOG_SENSITIVE_MASK}</span>`;
  }
  return `<span title="#${log.downstream_token_id ?? "-"}">${escapeHtml(name)}</span>`;
}

function getLogModelRoute(log) {
  const requestModel = String(log.request_model || "").trim();
  const upstreamModel = String(log.upstream_model || "").trim();
  const fallbackModel = String(log.model || "").trim();
  const request = requestModel || fallbackModel;
  const upstream = upstreamModel || (requestModel ? fallbackModel : "");
  const mapped = Boolean(request && upstream && request !== upstream);
  return { request, upstream, mapped };
}

function formatLogModelText(log) {
  const route = getLogModelRoute(log);
  if (route.mapped) {
    return `${route.request} -> ${route.upstream}`;
  }
  return route.request || route.upstream || "-";
}

function renderLogModel(log) {
  const route = getLogModelRoute(log);
  if (!route.request && !route.upstream) {
    return '<span class="muted">-</span>';
  }
  if (!route.mapped) {
    const value = route.request || route.upstream;
    return `<span class="model-text model-single" title="${escapeHtml(value)}">${escapeHtml(value)}</span>`;
  }
  const title = `请求模型：${route.request}；上游模型：${route.upstream}`;
  return `
    <span class="model-route" title="${escapeHtml(title)}">
      <span class="model-route-line">
        <span class="model-text model-request">${escapeHtml(route.request)}</span>
      </span>
      <span class="model-route-line model-route-target">
        <span class="model-route-icon" aria-hidden="true">↳</span>
        <span class="model-text model-upstream">${escapeHtml(route.upstream)}</span>
      </span>
    </span>
  `;
}

function getReasoningEffortRoute(log) {
  const request = String(log?.reasoning_effort || "").trim();
  const response = String(log?.response_reasoning_effort || "").trim();
  const mapped = Boolean(request && response && request !== response);
  return { request, response, mapped };
}

function renderLogReasoningEffort(log) {
  const route = getReasoningEffortRoute(log);
  if (!route.request && !route.response) {
    return '<span class="muted">-</span>';
  }
  if (!route.mapped) {
    const value = route.request || route.response;
    return `<span class="model-text model-single" title="${escapeHtml(value)}">${escapeHtml(value)}</span>`;
  }
  const title = `请求强度：${route.request}；响应强度：${route.response}`;
  return `
    <span class="model-route" title="${escapeHtml(title)}">
      <span class="model-route-line">
        <span class="model-text model-request">${escapeHtml(route.request)}</span>
      </span>
      <span class="model-route-line model-route-target">
        <span class="model-route-icon" aria-hidden="true">↳</span>
        <span class="model-text model-upstream">${escapeHtml(route.response)}</span>
      </span>
    </span>
  `;
}

function formatTokens(log) {
  const part = (value) => (value === null || value === undefined ? "-" : value);
  const cacheHitRate = formatCacheHitRate(log);
  const metrics = [
    ["输入", log.prompt_tokens],
    ["输出", log.completion_tokens],
    ["总计", log.total_tokens],
    ["缓存命中", log.prompt_cached_tokens],
    ["缓存率", cacheHitRate],
    ["思考", log.completion_reasoning_tokens],
  ];
  return `
    <span class="token-triple" aria-label="输入 输出 总计 缓存命中 缓存率 思考 tokens">
      ${metrics.map(([label, value]) => `
        <span><b>${escapeHtml(String(part(value)))}</b><small>${escapeHtml(label)}</small></span>
      `).join("")}
    </span>
  `;
}

function formatCacheHitRate(log) {
  const cacheHit = Number(log.prompt_cached_tokens);
  const input = Number(log.prompt_tokens);
  if (
    !Number.isFinite(cacheHit)
    || !Number.isFinite(input)
    || input <= 0
  ) {
    return "-";
  }
  const percent = (cacheHit / input) * 100;
  if (percent === 0) {
    return "0%";
  }
  if (percent < 10) {
    return `${percent.toFixed(1)}%`;
  }
  return `${Math.round(percent)}%`;
}

function formatTokensPerSecondLine(log) {
  const rate = outputTokensPerSecond(log);
  if (rate === null) {
    return "";
  }
  const label = rate >= 100 ? String(Math.round(rate)) : rate.toFixed(1);
  const tone = rate >= 20 ? "ok" : rate >= 8 ? "warn" : "danger";
  return `<small><span class="duration-time ${tone}" title="输出吞吐 ${escapeHtml(label)} tokens/s">${escapeHtml(label)}</span> tokens/s</small>`;
}

function formatTokenDetailPanel(log) {
  const part = (value) => (value === null || value === undefined ? "-" : value);
  const metric = ([label, value, tone]) => `
    <span class="log-detail-token-metric ${escapeHtml(tone)}">
      <small>${escapeHtml(label)}</small>
      <b>${escapeHtml(String(part(value)))}</b>
    </span>
  `;
  const metrics = [
    ["输入", log.prompt_tokens, "input"],
    ["输出", log.completion_tokens, "output"],
    ["总计", log.total_tokens, "total"],
    ["缓存命中", log.prompt_cached_tokens, "cache-read"],
    ["缓存率", formatCacheHitRate(log), "cache-rate"],
    ["思考", log.completion_reasoning_tokens, "reasoning"],
  ];
  return `
    <div class="log-detail-token-panel" aria-label="输入 输出 总计 缓存命中 缓存率 思考 tokens">
      ${metrics.map(metric).join("")}
    </div>
  `;
}

function formatSeconds(ms) {
  return ms === null || ms === undefined ? "-" : `${(ms / 1000).toFixed(1)}s`;
}

function firstTokenTone(ms) {
  if (ms === null || ms === undefined) {
    return "neutral";
  }
  const value = Number(ms);
  if (!Number.isFinite(value)) {
    return "neutral";
  }
  if (value < 5000) {
    return "ok";
  }
  if (value >= 10000) {
    return "danger";
  }
  return "warn";
}

function formatFirstTokenTime(ms) {
  const label = formatSeconds(ms);
  const tone = firstTokenTone(ms);
  return `<span class="first-token-time ${tone}" title="首字耗时 ${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

function outputTokensPerSecond(log) {
  const completionTokens = Number(log.completion_tokens);
  const durationMs = Number(log.duration_ms);
  if (
    !Number.isFinite(completionTokens)
    || completionTokens <= 0
    || !Number.isFinite(durationMs)
    || durationMs <= 0
  ) {
    return null;
  }
  return completionTokens / (durationMs / 1000);
}

function totalDurationRating(log) {
  const statusCode = Number(log.status_code);
  if (!Number.isFinite(statusCode)) {
    return { tone: "danger", basis: "请求无响应或状态码缺失" };
  }
  if (statusCode < 200 || statusCode >= 300) {
    return { tone: "danger", basis: `HTTP ${statusCode} 错误，优先标红` };
  }

  const durationMs = Number(log.duration_ms);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { tone: "neutral", basis: "总耗时无数据" };
  }

  const outputRate = outputTokensPerSecond(log);
  if (outputRate !== null) {
    const displayRate = outputRate.toFixed(1).replace(/\.0$/, "");
    return {
      tone: outputRate >= 20 ? "ok" : outputRate >= 8 ? "warn" : "danger",
      basis: `按全程输出吞吐 ${displayRate} t/s 判定`,
    };
  }

  const totalTokens = Number(log.total_tokens);
  if (Number.isFinite(totalTokens) && totalTokens > 0) {
    const totalRate = totalTokens / (durationMs / 1000);
    const displayRate = totalRate.toFixed(1).replace(/\.0$/, "");
    return {
      tone: totalRate >= 80 ? "ok" : totalRate >= 20 ? "warn" : "danger",
      basis: `按总吞吐 ${displayRate} t/s 判定`,
    };
  }

  return {
    tone: durationMs < 30000 ? "ok" : durationMs < 60000 ? "warn" : "danger",
    basis: "无 token 数据，按绝对耗时兜底判定",
  };
}

function formatTotalDurationTime(log) {
  const label = formatSeconds(log.duration_ms);
  const rating = totalDurationRating(log);
  return `<span class="duration-time ${rating.tone}" title="总耗时 ${escapeHtml(label)} · ${escapeHtml(rating.basis)}">${escapeHtml(label)}</span>`;
}

function formatThroughput(log) {
  if (!log.stream) {
    return "";
  }
  const rate = outputTokensPerSecond(log);
  const displayRate = rate === null ? "—" : rate.toFixed(1).replace(/\.0$/, "");
  const rateTitle = rate === null ? "暂无输出吞吐数据" : `输出吞吐 ${displayRate} tokens/s`;
  return `
    <span class="stream-throughput" title="${escapeHtml(rateTitle)}" aria-label="流式响应，${escapeHtml(rateTitle)}">
      <span class="stream-state"><span class="stream-state-dot" aria-hidden="true"></span>流式</span>
      <span class="throughput-stat"><small>TPS</small><strong>${escapeHtml(displayRate)}</strong></span>
    </span>
  `;
}

/** Render server-side request and token totals during the trailing minute. */
function updateLogRates(recentRpm, recentTpm) {
  if (logRpm) {
    const rpm = recentRpm === null || recentRpm === undefined ? Number.NaN : Number(recentRpm);
    const tpm = recentTpm === null || recentTpm === undefined ? Number.NaN : Number(recentTpm);
    const displayRpm = Number.isFinite(rpm) && rpm >= 0
      ? rpm.toLocaleString("zh-CN")
      : "—";
    const displayTpm = Number.isFinite(tpm) && tpm >= 0
      ? tpm.toLocaleString("zh-CN")
      : "—";
    logRpm.innerHTML = `
      <span class="log-rpm-window">近 60 秒</span>
      <span class="log-rpm-value">${displayRpm}</span>
      <span class="log-rpm-unit">RPM</span>
      <span class="log-rpm-divider" aria-hidden="true">·</span>
      <span class="log-rpm-value">${displayTpm}</span>
      <span class="log-rpm-unit">TPM</span>
    `;
    const label = displayRpm === "—" || displayTpm === "—"
      ? "最近 60 秒全局请求数或 Token 数暂不可用"
      : `最近 60 秒全局请求数 ${displayRpm} RPM；全局 Token 总数 ${displayTpm} TPM`;
    logRpm.title = `${label}；不受当前筛选和分页影响`;
    logRpm.setAttribute("aria-label", label);
  }
}

function normalizeLogCursor(cursor) {
  if (!cursor || typeof cursor.created_at !== "string") {
    return null;
  }
  const id = Number(cursor.id);
  if (!Number.isFinite(id) || id < 1) {
    return null;
  }
  return {
    created_at: cursor.created_at,
    id,
  };
}

function resetLogPagination() {
  logOffset = 0;
  logHasMore = false;
  logCursorStack = [];
  logCurrentCursor = null;
  logNextCursor = null;
}

function logRenderOptions() {
  return {
    noMatch: logPageFiltersActive && logPageItems.length === 0,
    emptyTitle: "暂无请求日志",
    emptyCopy: logPageFiltersActive ? "全库中没有符合当前筛选条件的日志。" : "暂无代理请求记录。",
  };
}

function renderCurrentLogPage() {
  renderLogRows(logPageItems, logRenderOptions());
}

function updateLogSensitiveToggle() {
  if (!logSensitiveToggle) return;
  const hidden = logSensitiveHidden;
  const label = hidden
    ? "敏感信息已屏蔽，点击显示令牌与渠道名"
    : "敏感信息显示中，点击屏蔽令牌与渠道名";
  logSensitiveToggle.setAttribute("aria-pressed", String(hidden));
  logSensitiveToggle.setAttribute("aria-label", label);
  logSensitiveToggle.title = label;
  logSensitiveToggle.classList.toggle("is-active", hidden);
}

function refreshOpenLogDetail() {
  if (!currentLogDetail || !logDetailDialog?.open) return;
  logDetailSummary.textContent = formatLogDetailSummary(currentLogDetail);
  if (logDetailMeta) {
    logDetailMeta.innerHTML = formatLogDetailMeta(currentLogDetail);
  }
}

function setLogSensitiveHidden(hidden) {
  logSensitiveHidden = Boolean(hidden);
  try {
    localStorage.setItem(LOG_SENSITIVE_HIDDEN_KEY, String(logSensitiveHidden));
  } catch {
    // The current-page preference still applies when storage is unavailable.
  }
  updateLogSensitiveToggle();
  renderLogFilterOptions();
  renderCurrentLogPage();
  refreshOpenLogDetail();
}

function appendLogPaginationParams(params) {
  const cursor = normalizeLogCursor(logCurrentCursor);
  if (cursor) {
    params.set("before_created_at", cursor.created_at);
    params.set("before_id", String(cursor.id));
  } else {
    params.set("offset", String(logOffset));
  }
}

function formatStatusBadge(statusCode) {
  if (statusCode === null || statusCode === undefined) {
    return '<span class="muted">无响应</span>';
  }
  if (statusCode >= 200 && statusCode < 300) {
    return `<span class="badge on">${statusCode}</span>`;
  }
  if (statusCode >= 400) {
    return `<span class="badge danger">${statusCode}</span>`;
  }
  return `<span class="badge neutral">${statusCode}</span>`;
}

function formatReasoningEffort(requestEffort, responseEffort, options = {}) {
  const { badge = true, fallback = '<span class="muted">-</span>' } = options;
  if (!requestEffort && !responseEffort) {
    return fallback;
  }

  const values = requestEffort === responseEffort
    ? [requestEffort]
    : [requestEffort, responseEffort].filter(Boolean);
  const escapedValues = values.map(escapeHtml);
  const value = escapedValues.join(" → ");
  return badge ? `<span class="badge neutral">${value}</span>` : value;
}

function renderLogRows(items, options = {}) {
  const {
    emptyTitle = "暂无请求日志",
    emptyCopy = "当前范围内还没有代理请求记录。",
    emptyActionLabel = "刷新日志",
    emptyActionId = "refresh-logs",
    noMatch = false,
  } = options;

  logRows.innerHTML = "";

  if (logsLoading && !logsLoadedOnce) {
    logRows.innerHTML = skeletonRowsMarkup(9, 6);
    return;
  }

  if (items.length === 0) {
    if (noMatch) {
      logRows.innerHTML = noMatchStateCell(9, {
        title: "无匹配日志",
        copy: "全库中没有符合当前筛选条件的日志。",
        actionLabel: "清除筛选",
        actionId: "clear-log-filters",
      });
    } else {
      logRows.innerHTML = emptyStateCell(9, {
        title: emptyTitle,
        copy: emptyCopy,
        actionLabel: emptyActionLabel,
        actionId: emptyActionId,
      });
    }
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const log of items) {
    const row = document.createElement("tr");
    row.className = "log-row";
    row.dataset.logId = log.id;
    row.tabIndex = 0;
    row.title = log.error || "点击查看请求详情";
    const time = formatLogTimestamp(log.created_at);
    const channel = formatLogChannelStack(log);
    const status = formatStatusBadge(log.status_code);
    const throughput = formatThroughput(log);
    row.innerHTML = `
      <td class="time-cell" data-col="time">
        <span>${escapeHtml(time)}</span>
        <span class="muted">#${log.id}</span>
      </td>
      <td class="channel-cell" data-col="channel">${channel}</td>
      <td class="token-cell" data-col="token">${formatLogToken(log)}</td>
      <td data-col="client"><span class="badge neutral">${escapeHtml(log.client_type || "unknown")}</span></td>
      <td class="model-cell" data-col="model">${renderLogModel(log)}</td>
      <td class="col-reasoning" data-col="reasoning">
        ${renderLogReasoningEffort(log)}
      </td>
      <td data-col="status">${status}</td>
      <td class="duration-cell" data-col="duration">
        <span class="latency-metrics">
          <span class="latency-metric"><small>首字</small>${formatFirstTokenTime(log.first_token_ms)}</span>
          <span class="latency-metric"><small>总耗时</small>${formatTotalDurationTime(log)}</span>
        </span>
        ${throughput}
      </td>
      <td class="tokens-cell" data-col="tokens">${formatTokens(log)}</td>
    `;
    fragment.append(row);
  }
  logRows.append(fragment);
  applyAllColumnVisibility();
}

function formatByteCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "未知大小";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

function prettyBodyText(text) {
  const clean = String(text || "");
  const trimmed = clean.trim();
  if (!trimmed) {
    return "<empty body>";
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch (_) {
    return clean;
  }
}

function formatBodyHeading(body) {
  const parts = ["Body"];
  if (!body || typeof body !== "object") {
    return parts.join(" · ");
  }
  if (body.encoding) {
    parts.push(body.encoding);
  }
  const byteLength = typeof body.byte_length === "number"
    ? body.byte_length
    : (typeof body.size === "number" ? body.size : null);
  if (typeof byteLength === "number") {
    parts.push(formatByteCount(byteLength));
  }
  if (body.truncated) {
    parts.push("已截断");
  }
  return parts.join(" · ");
}

function normalizeSnapshotBody(rawBody) {
  // Retention marker on the whole snapshot is handled by the caller.
  if (rawBody === null || rawBody === undefined) {
    return { kind: "missing" };
  }
  // Legacy backend stored plain UTF-8 string bodies.
  if (typeof rawBody === "string") {
    return {
      kind: "text",
      text: rawBody,
      byte_length: new TextEncoder().encode(rawBody).length,
    };
  }
  if (typeof rawBody !== "object") {
    return { kind: "missing" };
  }
  if (rawBody.cleared) {
    return { kind: "cleared" };
  }
  const byteLength = typeof rawBody.byte_length === "number"
    ? rawBody.byte_length
    : (typeof rawBody.size === "number" ? rawBody.size : null);

  if (typeof rawBody.text === "string") {
    return {
      kind: "text",
      text: rawBody.text,
      byte_length: byteLength,
      encoding: rawBody.encoding,
      truncated: Boolean(rawBody.truncated),
    };
  }

  const base64 = typeof rawBody.base64 === "string"
    ? rawBody.base64
    : (typeof rawBody.base64_truncated === "string" ? rawBody.base64_truncated : null);
  if (base64 !== null) {
    return {
      kind: "base64",
      base64,
      byte_length: byteLength,
      encoding: rawBody.encoding || "base64",
      truncated: Boolean(rawBody.truncated || rawBody.base64_truncated),
    };
  }

  if (byteLength === 0) {
    return { kind: "empty", byte_length: 0 };
  }
  return { kind: "missing" };
}

function compactText(value, maxLength = 360) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function firstErrorMessageFromValue(value) {
  if (!value) return "";
  if (typeof value === "string") return compactText(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = firstErrorMessageFromValue(item);
      if (message) return message;
    }
    return "";
  }
  if (typeof value !== "object") return "";

  if (value.error) {
    const nested = firstErrorMessageFromValue(value.error);
    if (nested) return nested;
  }

  for (const key of ["message", "detail", "error_message", "msg", "reason"]) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return compactText(value[key]);
    }
  }

  if (value.errors) {
    const nested = firstErrorMessageFromValue(value.errors);
    if (nested) return nested;
  }

  return "";
}

function snapshotBodyText(snapshot) {
  const normalized = normalizeSnapshotBody(snapshot?.body);
  if (normalized.kind === "text") {
    return normalized.text || "";
  }
  // Legacy: body stored as plain string at snapshot.body
  if (typeof snapshot?.body === "string") {
    return snapshot.body;
  }
  return "";
}

function errorMessageFromSnapshot(snapshot) {
  const text = snapshotBodyText(snapshot).trim();
  if (!text) return "";

  try {
    const message = firstErrorMessageFromValue(JSON.parse(text));
    if (message) return message;
  } catch (_) {
    // Non-JSON error bodies are handled below.
  }

  const status = snapshot?.status_code ?? snapshot?.status;
  if (status >= 400 && !text.startsWith("<")) {
    return compactText(text);
  }
  return "";
}

function extractLogDetailError(detail) {
  return (
    errorMessageFromSnapshot(detail.downstream_response)
    || errorMessageFromSnapshot(detail.upstream_response)
    || compactText(detail.error)
  );
}

function formatLogDetailSummary(detail) {
  const time = formatLogTimestamp(detail.created_at);
  const channel = formatLogChannelLabel(detail);
  const status = detail.status_code === null || detail.status_code === undefined
    ? "无响应"
    : `HTTP ${detail.status_code}`;
  return `#${detail.id} · ${time} · ${channel} · ${formatLogModelText(detail)} · ${status}`;
}

function formatLogDetailMeta(detail) {
  const channel = formatLogChannelLabel(detail);
  const statusText = detail.status_code === null || detail.status_code === undefined
    ? "无响应"
    : `HTTP ${detail.status_code}`;
  const statusTone = detail.status_code === null || detail.status_code === undefined
    ? "neutral"
    : detail.status_code >= 400
      ? "danger"
      : detail.status_code >= 200 && detail.status_code < 300
        ? "ok"
        : "neutral";
  const reasoning = formatReasoningEffort(detail.reasoning_effort, detail.response_reasoning_effort, { badge: false, fallback: "" });
  const modelText = formatLogModelText(detail);
  const modelLine = [escapeHtml(modelText), reasoning].filter(Boolean).join(" · ");
  const streamLabel = detail.stream ? "流式" : "非流式";
  const extractedError = extractLogDetailError(detail);
  const statusErrorLine = extractedError
    ? `<small class="log-detail-status-error" title="${escapeHtml(extractedError)}">错误：${escapeHtml(extractedError)}</small>`
    : "";
  const errorCard = extractedError
    ? `
      <div class="log-detail-meta-card log-detail-error-card">
        <span class="log-detail-meta-label">错误详情</span>
        <strong>${escapeHtml(extractedError)}</strong>
      </div>
    `
    : "";

  return `
    <div class="log-detail-meta-card log-detail-route-card">
      <span class="log-detail-meta-label">请求路由</span>
      <strong title="${escapeHtml(channel)}">${escapeHtml(channel)}</strong>
      <small title="${modelLine}">${modelLine}</small>
      <small class="log-detail-route-request" title="${escapeHtml(detail.method)} /${escapeHtml(detail.path)} · ${escapeHtml(streamLabel)}">
        ${escapeHtml(detail.method)} /${escapeHtml(detail.path)} · ${escapeHtml(streamLabel)}
      </small>
    </div>
    <div class="log-detail-meta-card">
      <span class="log-detail-meta-label">状态与耗时</span>
      <strong><span class="log-detail-status ${statusTone}">${escapeHtml(statusText)}</span></strong>
      <small>首字 ${formatFirstTokenTime(detail.first_token_ms)} · 总耗时 ${formatTotalDurationTime(detail)}</small>
      ${formatTokensPerSecondLine(detail)}
      ${statusErrorLine}
    </div>
    <div class="log-detail-meta-card log-detail-token-card">
      <span class="log-detail-meta-label">Tokens</span>
      ${formatTokenDetailPanel(detail)}
    </div>
    ${errorCard}
  `;
}

function formatHttpSnapshot(snapshot) {
  if (!snapshot) {
    return "未记录\n\n这条历史日志没有保存这一项请求或响应详情。";
  }

  // Retention cleanup may replace the whole snapshot with { cleared: true }.
  if (snapshot.cleared && !snapshot.method && snapshot.status_code == null && snapshot.status == null) {
    return "日志正文已按保留策略清理，仅保留元数据。请查看较新的日志以获得完整请求/响应。";
  }

  const status = snapshot.status_code ?? snapshot.status;
  const headers = { ...(snapshot.headers || {}) };
  let firstLine;

  if (snapshot.method) {
    let target = snapshot.url || "/";
    try {
      const url = new URL(snapshot.url);
      target = `${url.pathname || "/"}${url.search}`;
      if (!Object.keys(headers).some((name) => name.toLowerCase() === "host")) {
        headers.host = url.host;
      }
    } catch {
      // Older logs may have a non-absolute URL. Keep the recorded target intact.
    }
    firstLine = `${snapshot.method} ${target} HTTP/1.1`;
  } else {
    const reason = {
      200: "OK",
      201: "Created",
      202: "Accepted",
      204: "No Content",
      400: "Bad Request",
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not Found",
      429: "Too Many Requests",
      500: "Internal Server Error",
      502: "Bad Gateway",
      503: "Service Unavailable",
      504: "Gateway Timeout",
    }[status];
    firstLine = `HTTP/1.1 ${status ?? "-"}${reason ? ` ${reason}` : ""}`;
  }

  const lines = [firstLine];
  for (const [name, value] of Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${name}: ${value}`);
  }
  lines.push("");

  const normalized = normalizeSnapshotBody(snapshot.body);
  if (normalized.kind === "cleared") {
    lines.push("[Body cleared by retention policy]");
  } else if (normalized.kind === "missing") {
    // No content follows the HTTP header terminator.
  } else if (normalized.kind === "empty") {
    // No content follows the HTTP header terminator.
  } else if (normalized.kind === "base64") {
    lines.push(`[Binary body encoded as base64; ${normalized.byte_length ?? 0} bytes captured]`);
    lines.push(normalized.base64 || "");
  } else {
    lines.push(prettyBodyText(normalized.text || ""));
  }
  if (normalized.truncated) {
    lines.push("");
    lines.push(`[Body truncated; original length: ${normalized.byte_length ?? "unknown"} bytes]`);
  }
  return lines.join("\n");
}

function closeLogDetailDialog() {
  requestDetailGrid?.classList.remove("is-focused");
  for (const button of document.querySelectorAll(".log-detail-expand")) {
    button.textContent = "放大查看";
    button.setAttribute("aria-pressed", "false");
  }
  if (logDetailDialog.open && typeof logDetailDialog.close === "function") {
    logDetailDialog.close();
  } else {
    logDetailDialog.removeAttribute("open");
  }
}

function openLogDetailDialog() {
  if (typeof logDetailDialog.showModal === "function") {
    logDetailDialog.showModal();
  } else {
    logDetailDialog.setAttribute("open", "");
  }
}

function renderLogDetailSection(details) {
  const pre = details.querySelector("pre");
  pre.textContent = currentLogDetail ? formatHttpSnapshot(currentLogDetail[details.dataset.field]) : "";
}

async function showLogDetail(logId) {
  currentLogDetail = null;
  logDetailTitle.textContent = "请求详情";
  logDetailSummary.textContent = "正在加载...";
  if (logDetailMeta) {
    logDetailMeta.innerHTML = `
      <div class="log-detail-meta-card log-detail-loading-card">
        <span class="log-detail-meta-label">加载中</span>
        <strong>正在读取日志详情</strong>
        <small>请求 / 响应快照会在展开卡片时渲染。</small>
      </div>
    `;
  }
  for (const details of logDetailSections) {
    details.open = false;
    details.querySelector("pre").textContent = "";
  }
  requestDetailGrid?.classList.remove("is-focused");
  for (const button of document.querySelectorAll(".log-detail-expand")) {
    button.textContent = "放大查看";
    button.setAttribute("aria-pressed", "false");
  }
  openLogDetailDialog();

  try {
    const detail = await api(`/api/admin/logs/${logId}`);
    currentLogDetail = detail;
    logDetailTitle.textContent = "请求详情";
    logDetailSummary.textContent = formatLogDetailSummary(detail);
    if (logDetailMeta) {
      logDetailMeta.innerHTML = formatLogDetailMeta(detail);
    }
    for (const details of logDetailSections) {
      if (details.open) {
        renderLogDetailSection(details);
      }
    }
  } catch (error) {
    logDetailSummary.textContent = `加载失败：${error.message}`;
    if (logDetailMeta) {
      logDetailMeta.innerHTML = `
        <div class="log-detail-meta-card log-detail-error-card">
          <span class="log-detail-meta-label">加载失败</span>
          <strong>${escapeHtml(error.message)}</strong>
          <small>请稍后重试或刷新日志列表。</small>
        </div>
      `;
    }
  }
}

async function loadLogs() {
  const showSkeleton = !logsLoadedOnce;
  if (showSkeleton) {
    logsLoading = true;
    renderLogRows([]);
  }

  try {
    const upstreamId = logUpstreamFilter.value;
    const search = (logSearchInput?.value || "").trim();
    const status = logStatusFilter?.value || "";
    const clientType = logClientFilter?.value || "";
    const filtersActive = Boolean(upstreamId || search || status || clientType);
    const params = new URLSearchParams({
      limit: String(LOG_PAGE_SIZE),
    });
    appendLogPaginationParams(params);
    if (upstreamId) params.set("upstream_id", upstreamId);
    if (search) params.set("search", search);
    if (status) params.set("status", status);
    if (clientType) params.set("client_type", clientType);

    const page = await api(`/api/admin/logs?${params}`);
    const items = page.items || [];
    logHasMore = Boolean(page.has_more);
    logNextCursor = normalizeLogCursor(page.next_cursor)
      || (logHasMore && items.length > 0 ? normalizeLogCursor(items[items.length - 1]) : null);
    logsLoadedOnce = true;
    logPageItems = items;
    logPageFiltersActive = filtersActive;
    renderCurrentLogPage();
    updateLogRates(page.recent_rpm, page.recent_tpm);
    logPrevButton.disabled = logCursorStack.length === 0;
    logNextButton.disabled = !logHasMore || !logNextCursor;
    renderUpstreamSummary();
  } catch (error) {
    updateLogRates(null, null);
    setStatus(`加载日志失败：${error.message}`, "error");
  } finally {
    logsLoading = false;
  }
}

updateLogSensitiveToggle();
