// Request log list, performance formatting, snapshots, and detail dialog.
function renderLogFilterOptions() {
  const selected = logUpstreamFilter.value;
  logUpstreamFilter.innerHTML = '<option value="">全部渠道</option>';
  for (const upstream of upstreams) {
    const option = document.createElement("option");
    option.value = upstream.id;
    option.textContent = `#${upstream.id} ${upstream.name}`;
    logUpstreamFilter.append(option);
  }
  logUpstreamFilter.value = selected;
}

function formatTokens(log) {
  const part = (value) => (value === null || value === undefined ? "-" : value);
  return `
    <span class="token-triple" aria-label="输入 输出 总计 tokens">
      <span><b>${part(log.prompt_tokens)}</b><small>输入</small></span>
      <span><b>${part(log.completion_tokens)}</b><small>输出</small></span>
      <span><b>${part(log.total_tokens)}</b><small>总计</small></span>
    </span>
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

/** Render the server-side count of all requests during the trailing minute. */
function updateLogRpm(recentRpm) {
  if (logRpm) {
    const count = Number(recentRpm);
    logRpm.textContent = `RPM ${Number.isFinite(count) && count >= 0 ? count : "—"}`;
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
    const channel = log.upstream_name
      ? `
        <div class="channel-stack">
          <strong title="${escapeHtml(log.upstream_name)}">${escapeHtml(log.upstream_name)}</strong>
          <span class="muted">#${log.upstream_id}</span>
        </div>
      `
      : "<span class=\"muted\">无（未匹配到渠道）</span>";
    const status = formatStatusBadge(log.status_code);
    const throughput = formatThroughput(log);
    row.innerHTML = `
      <td class="time-cell" data-col="time">
        <span>${escapeHtml(time)}</span>
        <span class="muted">#${log.id}</span>
      </td>
      <td class="channel-cell" data-col="channel">${channel}</td>
      <td class="token-cell" data-col="token">${log.downstream_token_name ? `<span title="#${log.downstream_token_id ?? "-"}">${escapeHtml(log.downstream_token_name)}</span>` : "<span class=\"muted\">-</span>"}</td>
      <td data-col="client"><span class="badge neutral">${escapeHtml(log.client_type || "unknown")}</span></td>
      <td class="model-cell" data-col="model">${log.model ? `<code title="${escapeHtml(log.model)}">${escapeHtml(log.model)}</code>` : "<span class=\"muted\">-</span>"}</td>
      <td class="col-reasoning" data-col="reasoning">
        ${formatReasoningEffort(log.reasoning_effort, log.response_reasoning_effort)}
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

function formatLogDetailMeta(detail) {
  const time = formatLogTimestamp(detail.created_at);
  const channel = detail.upstream_name || "未匹配到渠道";
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
  const tokenParts = [detail.prompt_tokens, detail.completion_tokens, detail.total_tokens]
    .map((value) => (value === null || value === undefined ? "-" : value));
  const reasoning = formatReasoningEffort(detail.reasoning_effort, detail.response_reasoning_effort, { badge: false, fallback: "-" });
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
    <div class="log-detail-meta-card">
      <span class="log-detail-meta-label">时间</span>
      <strong>${escapeHtml(time)}</strong>
      <small>#${detail.id}</small>
    </div>
    <div class="log-detail-meta-card">
      <span class="log-detail-meta-label">路由</span>
      <strong title="${escapeHtml(channel)}">${escapeHtml(channel)}</strong>
      <small title="${escapeHtml(detail.model || "-")}">${escapeHtml(detail.model || "-")}</small>
    </div>
    <div class="log-detail-meta-card">
      <span class="log-detail-meta-label">请求</span>
      <strong>${escapeHtml(detail.method)} /${escapeHtml(detail.path)}</strong>
      <small>${escapeHtml(streamLabel)} · 思考强度 ${reasoning}</small>
    </div>
    <div class="log-detail-meta-card">
      <span class="log-detail-meta-label">状态与耗时</span>
      <strong><span class="log-detail-status ${statusTone}">${escapeHtml(statusText)}</span></strong>
      <small>首字 ${formatFirstTokenTime(detail.first_token_ms)} · 总耗时 ${formatTotalDurationTime(detail)}</small>
      ${statusErrorLine}
    </div>
    <div class="log-detail-meta-card">
      <span class="log-detail-meta-label">Tokens</span>
      <strong>${tokenParts.join(" / ")}</strong>
      <small>输入 / 输出 / 总计</small>
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
    const time = formatLogTimestamp(detail.created_at);
    const channel = detail.upstream_name || "未匹配到渠道";
    const status = detail.status_code === null ? "无响应" : `HTTP ${detail.status_code}`;
    logDetailTitle.textContent = `请求详情 #${detail.id}`;
    logDetailSummary.textContent = `${time} · ${channel} · ${detail.model || "-"} · ${status}`;
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
    const filtersActive = Boolean(upstreamId || search || status);
    const params = new URLSearchParams({
      limit: String(LOG_PAGE_SIZE),
    });
    appendLogPaginationParams(params);
    if (upstreamId) params.set("upstream_id", upstreamId);
    if (search) params.set("search", search);
    if (status) params.set("status", status);

    const page = await api(`/api/admin/logs?${params}`);
    const items = page.items || [];
    logHasMore = Boolean(page.has_more);
    logNextCursor = normalizeLogCursor(page.next_cursor)
      || (logHasMore && items.length > 0 ? normalizeLogCursor(items[items.length - 1]) : null);
    logsLoadedOnce = true;
    renderLogRows(items, {
      noMatch: filtersActive && items.length === 0,
      emptyTitle: "暂无请求日志",
      emptyCopy: filtersActive ? "全库中没有符合当前筛选条件的日志。" : "暂无代理请求记录。",
    });
    const loaded = items.length;
    const pageNo = logCursorStack.length + 1;
    updateLogRpm(page.recent_rpm);
    logStatusBox.textContent = `${filtersActive ? "全库筛选" : "服务端分页"} · 已加载 ${loaded} 条 · 第 ${pageNo} 页 · 自动刷新 5s`;
    logStatusBox.dataset.tone = "neutral";
    logPrevButton.disabled = logCursorStack.length === 0;
    logNextButton.disabled = !logHasMore || !logNextCursor;
    renderUpstreamSummary();
  } catch (error) {
    updateLogRpm(null);
    logStatusBox.textContent = `加载失败：${error.message}`;
    logStatusBox.dataset.tone = "error";
  } finally {
    logsLoading = false;
  }
}
