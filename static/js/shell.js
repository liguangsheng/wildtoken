// Navigation, dialogs, API access, settings, and model-test workflows.
function isEditableTarget(target) {
  if (!target || !(target instanceof Element)) {
    return false;
  }
  if (target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']")) {
    return true;
  }
  return Boolean(target.isContentEditable);
}

function openDialogs() {
  return [...document.querySelectorAll("dialog[open]")];
}

function topOpenDialog() {
  const dialogs = openDialogs();
  return dialogs.length ? dialogs[dialogs.length - 1] : null;
}

function dialogMaximizeButton(dialog) {
  return dialog?.querySelector?.("[data-dialog-maximize]") || null;
}

function setDialogMaximized(dialog, maximized) {
  if (!dialog) return false;
  const next = Boolean(maximized);
  dialog.classList.toggle("is-maximized", next);
  const button = dialogMaximizeButton(dialog);
  if (button) {
    button.setAttribute("aria-pressed", String(next));
    button.setAttribute("aria-label", next ? "还原" : "最大化");
    button.title = next ? "还原" : "最大化";
  }
  return next;
}

function clearDialogMaximized(dialog) {
  return setDialogMaximized(dialog, false);
}

function toggleDialogMaximized(dialog) {
  if (!dialog) return false;
  return setDialogMaximized(dialog, !dialog.classList.contains("is-maximized"));
}

function closeDialogElement(dialog) {
  if (!dialog) return false;
  if (dialog === commandPalette) {
    closeCommandPalette();
    return true;
  }
  if (dialog === upstreamDialog) {
    cancelUpstreamDialog();
    return true;
  }
  if (dialog === tokenDialog) {
    closeTokenDialog();
    return true;
  }
  if (dialog === quickImportDialog) {
    closeQuickImportDialog();
    return true;
  }
  if (dialog === channelExportDialog) {
    closeChannelExportDialog();
    return true;
  }
  if (dialog === channelImportDialog) {
    closeChannelImportDialog();
    return true;
  }
  if (dialog === modelDialog) {
    closeModelDialog();
    return true;
  }
  if (dialog === logDetailDialog) {
    closeLogDetailDialog();
    return true;
  }
  if (dialog === balanceDialog) {
    closeBalanceDialog();
    return true;
  }
  if (dialog === confirmDialog) {
    clearDialogMaximized(confirmDialog);
    if (typeof confirmDialog.close === "function") {
      confirmDialog.close();
    } else {
      confirmDialog.removeAttribute("open");
    }
    return true;
  }
  if (dialog === adminTokenDialog) {
    return false;
  }
  clearDialogMaximized(dialog);
  if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
  return true;
}

function skeletonRowsMarkup(colspan, count = 5) {
  const widths = ["w-md", "w-lg", "w-sm", "w-xs", "w-md", "w-sm", "w-lg"];
  return Array.from({ length: count }, (_, rowIndex) => {
    const cells = Array.from({ length: colspan }, (__, colIndex) => {
      const width = widths[(rowIndex + colIndex) % widths.length];
      return `<td><span class="skeleton-block ${width}"></span></td>`;
    }).join("");
    return `<tr class="skeleton-row" aria-hidden="true">${cells}</tr>`;
  }).join("");
}

function emptyStateCell(colspan, { title, copy, actionLabel, actionId }) {
  return `
    <tr>
      <td colspan="${colspan}" class="empty empty-state">
        <div class="empty-state-inner">
          <p class="empty-state-title">${escapeHtml(title)}</p>
          <p class="empty-state-copy">${escapeHtml(copy)}</p>
          <div class="empty-state-actions">
            <button type="button" data-empty-action="${escapeHtml(actionId)}">${escapeHtml(actionLabel)}</button>
          </div>
        </div>
      </td>
    </tr>
  `;
}

function noMatchStateCell(colspan, { title, copy, actionLabel, actionId }) {
  return `
    <tr>
      <td colspan="${colspan}" class="empty no-match-state">
        <div class="empty-state-inner">
          <p class="no-match-state-title">${escapeHtml(title)}</p>
          <p class="no-match-state-copy">${escapeHtml(copy)}</p>
          <div class="no-match-state-actions">
            <button type="button" class="secondary" data-empty-action="${escapeHtml(actionId)}">${escapeHtml(actionLabel)}</button>
          </div>
        </div>
      </td>
    </tr>
  `;
}

function getFilteredUpstreams() {
  const query = upstreamSearchQuery.trim().toLowerCase();
  const status = upstreamStatusFilterValue;
  return upstreams.filter((upstream) => {
    if (status === "enabled" && !upstream.enabled) return false;
    if (status === "disabled" && upstream.enabled) return false;
    if (status === "effective-zero" && Number(upstream.effective_weight) > 0) return false;
    if (!query) return true;
    const haystack = [
      upstream.name,
      upstream.base_url,
      String(upstream.id),
      ...(upstream.model_names || []),
      ...(upstream.model_prefixes || []),
      ...Object.keys(upstream.model_mappings || {}),
      ...Object.values(upstream.model_mappings || {}),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  }).sort(compareUpstreams);
}

function upstreamStatusRank(upstream) {
  if (!upstream.enabled) return 2;
  return Number(upstream.effective_weight) <= 0 ? 1 : 0;
}

function compareUpstreams(left, right) {
  let comparison;
  switch (upstreamSort.key) {
    case "id":
      comparison = left.id - right.id;
      break;
    case "name":
      comparison = String(left.name || "").localeCompare(String(right.name || ""), "zh-CN");
      break;
    case "status":
      comparison = upstreamStatusRank(left) - upstreamStatusRank(right);
      break;
    case "priority":
    default:
      comparison = left.priority - right.priority;
      break;
  }
  if (comparison !== 0) {
    return upstreamSort.direction === "asc" ? comparison : -comparison;
  }
  return left.id - right.id;
}

function updateUpstreamSortControls() {
  if (!upstreamTable) return;
  for (const button of upstreamTable.querySelectorAll("button[data-upstream-sort]")) {
    const key = button.dataset.upstreamSort;
    const direction = key === upstreamSort.key ? upstreamSort.direction : null;
    button.closest("th")?.setAttribute(
      "aria-sort",
      direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none",
    );
    const indicator = button.querySelector("span");
    if (indicator) indicator.textContent = direction === "asc" ? "↑" : direction === "desc" ? "↓" : "";
  }
}

function setUpstreamSort(key) {
  upstreamSort = {
    key,
    direction: upstreamSort.key === key && upstreamSort.direction === "asc" ? "desc" : "asc",
  };
  updateUpstreamSortControls();
  renderRows();
}

function upstreamFiltersActive() {
  return Boolean(upstreamSearchQuery.trim() || upstreamStatusFilterValue);
}

function getFilteredTokens() {
  const query = tokenSearchQuery.trim().toLowerCase();
  if (!query) return tokens;
  return tokens.filter((token) => {
    const haystack = [
      token.name,
      token.description || "",
      token.token_preview || "",
      String(token.id),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function tokenFiltersActive() {
  return Boolean(tokenSearchQuery.trim());
}

function clearUpstreamFilters() {
  if (upstreamSearchInput) upstreamSearchInput.value = "";
  if (upstreamStatusFilter) upstreamStatusFilter.value = "";
  upstreamSearchQuery = "";
  upstreamStatusFilterValue = "";
  renderRows();
}

function clearTokenFilters() {
  if (tokenSearchInput) tokenSearchInput.value = "";
  tokenSearchQuery = "";
  renderTokenRows();
}

function clearLogFilters() {
  if (logSearchInput) logSearchInput.value = "";
  if (logStatusFilter) logStatusFilter.value = "";
  if (logClientFilter) logClientFilter.value = "";
  resetLogPagination();
  loadLogs();
}

function currentViewName() {
  return currentViewFromHash();
}

function focusCurrentSearch() {
  const view = currentViewName();
  if (view === "upstreams" && upstreamSearchInput) {
    upstreamSearchInput.focus();
    upstreamSearchInput.select?.();
    return;
  }
  if (view === "logs" && logSearchInput) {
    logSearchInput.focus();
    logSearchInput.select?.();
    return;
  }
  if (view === "tokens" && tokenSearchInput) {
    tokenSearchInput.focus();
    tokenSearchInput.select?.();
  }
}

function refreshCurrentView() {
  const view = currentViewName();
  if (view === "dashboard") {
    loadDashboardData();
  } else if (view === "logs") {
    loadLogs();
  } else if (view === "tokens") {
    loadTokens();
  } else if (view === "settings") {
    loadSettingsPage();
  } else {
    loadUpstreams();
  }
}


function validView(value) {
  return [...views].some((view) => view.dataset.view === value);
}

function getDefaultHome() {
  try {
    const value = localStorage.getItem(DEFAULT_HOME_KEY);
    return validView(value) ? value : FALLBACK_VIEW;
  } catch {
    return FALLBACK_VIEW;
  }
}

function getLogRefreshMs() {
  try {
    const seconds = Number(localStorage.getItem(LOG_REFRESH_KEY) || "5");
    return [0, 5, 10, 30].includes(seconds) ? seconds * 1000 : 5000;
  } catch {
    return 5000;
  }
}

function currentViewFromHash() {
  const name = location.hash.replace("#", "");
  return validView(name) ? name : getDefaultHome();
}

function switchView(name) {
  for (const view of views) {
    view.hidden = view.dataset.view !== name;
  }
  for (const link of navLinks) {
    link.classList.toggle("active", link.dataset.view === name);
  }
  if (document.documentElement.dataset.theme === "endfield" && window.matchMedia("(min-width: 761px)").matches) {
    document.querySelector(".content")?.scrollTo({ top: 0, behavior: "auto" });
  }
  if (location.hash !== `#${name}`) {
    location.hash = name;
  }
  if (name === "dashboard") {
    loadDashboardData();
    startDashboardRefresh();
  } else {
    stopDashboardRefresh();
  }
  if (name === "logs") {
    loadLogs();
    startLogRefresh();
    startLogStream();
  } else {
    stopLogRefresh();
    stopLogStream();
  }
  if (name === "upstreams") {
    loadUpstreams();
    startUpstreamRefresh();
    startEffectiveWeightTick();
  } else {
    stopUpstreamRefresh();
    stopEffectiveWeightTick();
  }
  if (name === "tokens") {
    loadTokens();
    startTokenRefresh();
  } else {
    stopTokenRefresh();
  }
  if (name === "groups") {
    loadGroups();
  }
  if (name === "settings") {
    loadSettingsPage();
    startSystemUptimeTicker();
  } else {
    stopSystemUptimeTicker();
  }
}

function updateLiveIndicator() {
  if (!liveIndicator) return;
  const active = Boolean(
    logRefreshTimer
      || logStreamController
      || logStreamReconnectTimer
      || upstreamRefreshTimer
      || tokenRefreshTimer
      || dashboardRefreshTimer,
  );
  liveIndicator.hidden = !active || !pageVisible;
}

function startLogRefresh() {
  const interval = getLogRefreshMs();
  if (
    logRefreshTimer !== null
    || !pageVisible
    || interval === 0
    || logStreamController !== null
  ) {
    updateLiveIndicator();
    return;
  }
  logRefreshTimer = window.setInterval(loadLogs, interval);
  updateLiveIndicator();
}

function startUpstreamRefresh() {
  if (upstreamRefreshTimer !== null || !pageVisible) {
    updateLiveIndicator();
    return;
  }
  upstreamRefreshTimer = window.setInterval(loadUpstreams, DEFAULT_REFRESH_MS);
  updateLiveIndicator();
}

function stopUpstreamRefresh() {
  if (upstreamRefreshTimer === null) {
    updateLiveIndicator();
    return;
  }
  window.clearInterval(upstreamRefreshTimer);
  upstreamRefreshTimer = null;
  updateLiveIndicator();
}

function startEffectiveWeightTick() {
  if (effectiveWeightTickTimer !== null || !pageVisible) {
    return;
  }
  effectiveWeightTickTimer = window.setInterval(updateEffectiveWeightNotes, EFFECTIVE_WEIGHT_TICK_MS);
}

function stopEffectiveWeightTick() {
  if (effectiveWeightTickTimer === null) {
    return;
  }
  window.clearInterval(effectiveWeightTickTimer);
  effectiveWeightTickTimer = null;
}

function stopLogRefresh() {
  if (logRefreshTimer === null) {
    updateLiveIndicator();
    return;
  }
  window.clearInterval(logRefreshTimer);
  logRefreshTimer = null;
  updateLiveIndicator();
}

function startDashboardRefresh() {
  if (dashboardRefreshTimer !== null || !pageVisible) {
    updateLiveIndicator();
    return;
  }
  dashboardRefreshTimer = window.setInterval(loadDashboardData, DASHBOARD_REFRESH_MS);
  updateLiveIndicator();
}

function stopDashboardRefresh() {
  if (dashboardRefreshTimer === null) {
    updateLiveIndicator();
    return;
  }
  window.clearInterval(dashboardRefreshTimer);
  dashboardRefreshTimer = null;
  updateLiveIndicator();
}

function pauseAllAutoRefresh() {
  stopLogRefresh();
  stopLogStream();
  stopUpstreamRefresh();
  stopTokenRefresh();
  stopEffectiveWeightTick();
  stopDashboardRefresh();
  stopSystemUptimeTicker();
  updateLiveIndicator();
}

function resumeAutoRefreshForCurrentView() {
  if (!pageVisible) {
    updateLiveIndicator();
    return;
  }
  const name = currentViewFromHash();
  if (name === "dashboard") {
    startDashboardRefresh();
  } else if (name === "logs") {
    startLogRefresh();
    startLogStream();
  } else if (name === "upstreams") {
    startUpstreamRefresh();
    startEffectiveWeightTick();
  } else if (name === "tokens") {
    startTokenRefresh();
  } else if (name === "settings") {
    startSystemUptimeTicker();
  }
  updateLiveIndicator();
}

function getAdminToken() {
  return localStorage.getItem(ADMIN_TOKEN_KEY) || "";
}

function setAdminToken(token) {
  localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

function clearAdminToken() {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
}

function showAdminTokenError(message) {
  adminTokenError.textContent = message;
}

function openAdminTokenDialog() {
  if (!adminTokenDialog.open) {
    if (typeof adminTokenDialog.showModal === "function") {
      adminTokenDialog.showModal();
    } else {
      adminTokenDialog.setAttribute("open", "");
    }
  }
  adminTokenInput.focus();
}

function closeAdminTokenDialog() {
  if (adminTokenDialog.open && typeof adminTokenDialog.close === "function") {
    adminTokenDialog.close();
  } else {
    adminTokenDialog.removeAttribute("open");
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const token = getAdminToken();
  if (token) {
    headers.set("x-admin-token", token);
  }
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      message = data.detail || data.error?.message || data.error || message;
    } catch (_) {
      // Keep the HTTP status message.
    }
    if (response.status === 401) {
      clearAdminToken();
      showAdminTokenError(message);
      openAdminTokenDialog();
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

let loadedServerSettings = null;
let systemUptimeBaseSeconds = null;
let systemUptimeSyncedAt = 0;
let systemUptimeTimer = null;
let systemServerTimeBaseMs = null;
let systemServerTimeOffsetMinutes = 0;

function setSettingsStatus(message = "", tone = "") {
  if (!serverSettingsStatus) return;
  serverSettingsStatus.textContent = message;
  serverSettingsStatus.dataset.tone = tone;
}

function setRoutingSettingsStatus(message = "", tone = "") {
  if (!routingSettingsStatus) return;
  routingSettingsStatus.textContent = message;
  routingSettingsStatus.dataset.tone = tone;
}

function setProxySettingsStatus(message = "", tone = "") {
  if (!proxySettingsStatus) return;
  proxySettingsStatus.textContent = message;
  proxySettingsStatus.dataset.tone = tone;
}

function updatePreferenceControls() {
  const theme = document.documentElement.getAttribute("data-theme") || getStoredTheme();
  const density = getDensity();
  if (settingsTheme) settingsTheme.value = theme;
  settingsDensity?.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.densityChoice === density);
    button.setAttribute("aria-pressed", String(button.dataset.densityChoice === density));
  });
  if (settingsLogRefresh) settingsLogRefresh.value = String(getLogRefreshMs() / 1000);
  if (settingsDefaultHome) settingsDefaultHome.value = getDefaultHome();
}

function fillServerSettings(settings) {
  loadedServerSettings = settings;
  settingsBodyKeepCount.value = settings.log_body_keep_count;
  settingsRetentionDays.value = settings.log_retention_days;
  settingsBodyMaxBytes.value = settings.log_body_max_bytes;
  settingsMaxRetries.value = settings.max_retries;
  settingsSameUpstreamRetryMs.value = settings.same_upstream_retry_interval_ms;
  settingsFailurePenalty.value = settings.auto_weight_failure_penalty;
  settingsSuccessIncrement.value = settings.auto_weight_success_increment;
  settingsRecoveryIncrement.value = settings.auto_weight_recovery_increment;
  settingsRecoveryInterval.value = settings.auto_weight_recovery_interval_seconds;
  if (settingsProxyEnabled) settingsProxyEnabled.checked = Boolean(settings.proxy_enabled);
  if (settingsProxyUrl) settingsProxyUrl.value = settings.proxy_url || "";
  settingsRevision.textContent = `修订 ${settings.revision} · ${settings.updated_at || "刚刚更新"}`;
  setSettingsStatus("");
  setRoutingSettingsStatus("");
  setProxySettingsStatus("");
}

function formatBytes(value) {
  if (!Number.isFinite(Number(value))) return "—";
  const bytes = Number(value);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatUptime(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainderSeconds = Math.floor(seconds % 60);
  return `${days ? `${days} 天 ` : ""}${hours} 小时 ${minutes} 分钟 ${remainderSeconds} 秒`;
}

function currentSystemUptimeSeconds() {
  if (!Number.isFinite(systemUptimeBaseSeconds)) return null;
  return systemUptimeBaseSeconds + Math.max(0, Math.floor((Date.now() - systemUptimeSyncedAt) / 1000));
}

function parseRfc3339OffsetMinutes(value) {
  const match = String(value || "").match(/([+-])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const minutes = (Number(match[2]) * 60) + Number(match[3]);
  return match[1] === "+" ? minutes : -minutes;
}

function formatServerRfc3339(timestampMs, offsetMinutes) {
  const date = new Date(timestampMs + (offsetMinutes * 60_000));
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offset = Math.abs(offsetMinutes);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
}

function refreshSystemUptime() {
  const value = currentSystemUptimeSeconds();
  const uptimeValue = systemInfoGrid?.querySelector("[data-system-uptime]");
  if (uptimeValue && value !== null) {
    uptimeValue.textContent = formatUptime(value);
  }
  const serverTimeValue = systemInfoGrid?.querySelector("[data-system-server-time]");
  if (serverTimeValue && Number.isFinite(systemServerTimeBaseMs)) {
    const elapsedMs = Math.max(0, Date.now() - systemUptimeSyncedAt);
    serverTimeValue.textContent = formatServerRfc3339(
      systemServerTimeBaseMs + elapsedMs,
      systemServerTimeOffsetMinutes,
    );
  }
}

function formatMetricDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}s`;
}

function startSystemUptimeTicker() {
  if (systemUptimeTimer !== null || currentViewFromHash() !== "settings" || !pageVisible) return;
  systemUptimeTimer = window.setInterval(refreshSystemUptime, 1000);
}

function stopSystemUptimeTicker() {
  if (systemUptimeTimer === null) return;
  window.clearInterval(systemUptimeTimer);
  systemUptimeTimer = null;
}

function renderSystemInfo(system) {
  const uptimeSeconds = Number(system.uptime_seconds);
  systemUptimeBaseSeconds = Number.isFinite(uptimeSeconds) ? Math.max(0, uptimeSeconds) : null;
  systemUptimeSyncedAt = Date.now();
  const serverTimeMs = Date.parse(system.current_server_time || "");
  systemServerTimeBaseMs = Number.isFinite(serverTimeMs) ? serverTimeMs : null;
  systemServerTimeOffsetMinutes = parseRfc3339OffsetMinutes(system.current_server_time);
  const metrics = system.runtime_metrics || {};
  const cleanup = metrics.cleanup || {};
  const entries = [
    ["服务", system.service || "WildToken"],
    ["版本", system.version || "—"],
    ["运行时长", formatUptime(systemUptimeBaseSeconds)],
    ["当前服务器时间", system.current_server_time || "—"],
    ["数据库", system.database_ok ? "连接正常" : "不可用"],
    ["数据库已分配", system.database_allocated_bytes == null ? "—" : formatBytes(system.database_allocated_bytes)],
    ["日志总数", Number(system.total_log_count || 0).toLocaleString("zh-CN")],
    ["近 24 小时日志", Number(system.log_count_24h || 0).toLocaleString("zh-CN")],
    ["启用渠道", `${system.enabled_upstream_count || 0} / ${system.total_upstream_count || 0}`],
    ["近 1 分钟成功请求", Number(system.recent_one_minute_log_count || 0).toLocaleString("zh-CN")],
    ["活跃 SSE", Number(metrics.active_sse_streams || 0).toLocaleString("zh-CN")],
    ["10 分钟 SSE 断连", Number(metrics.sse_recent_disconnects_10m || 0).toLocaleString("zh-CN")],
    ["SSE 断连总数", Number(metrics.sse_client_disconnects_total || 0).toLocaleString("zh-CN")],
    ["SSE 上游错误", Number(metrics.sse_upstream_errors_total || 0).toLocaleString("zh-CN")],
    ["日志队列", Number(metrics.log_queue_depth || 0).toLocaleString("zh-CN")],
    ["日志写入", Number(metrics.log_written_total || 0).toLocaleString("zh-CN")],
    ["日志写批次", Number(metrics.log_write_batches_total || 0).toLocaleString("zh-CN")],
    ["日志丢弃", Number(metrics.log_dropped_total || 0).toLocaleString("zh-CN")],
    ["日志写失败", Number(metrics.log_write_failures_total || 0).toLocaleString("zh-CN")],
    ["慢 DB 操作", Number(metrics.slow_db_operations_total || 0).toLocaleString("zh-CN")],
    ["清理任务", cleanup.active ? "运行中" : "空闲"],
    ["清理进度", cleanup.active
      ? `${Number(cleanup.current_rows_cleared || 0).toLocaleString("zh-CN")} 行 / ${Number(cleanup.current_batches || 0).toLocaleString("zh-CN")} 批`
      : `${Number(cleanup.last_rows_cleared || 0).toLocaleString("zh-CN")} 行 · ${formatMetricDuration(cleanup.last_duration_ms)}`],
  ];
  systemInfoGrid.innerHTML = entries.map(([label, value]) => `<div class="system-info-item"><span>${escapeHtml(label)}</span><strong${label === "运行时长" ? " data-system-uptime" : ""}${label === "当前服务器时间" ? " data-system-server-time" : ""}>${escapeHtml(String(value))}</strong></div>`).join("");
  const timeout = Number(system.default_upstream_timeout_seconds);
  const timeoutEl = document.querySelector("#settings-default-timeout");
  if (timeoutEl && Number.isFinite(timeout)) timeoutEl.textContent = `${timeout} 秒`;
  refreshSystemUptime();
  startSystemUptimeTicker();
}

async function loadSettingsPage() {
  updatePreferenceControls();
  try {
    const [settings, system, prompts] = await Promise.all([
      api("/api/admin/settings"),
      api("/api/admin/system"),
      api("/api/admin/settings/model-test-prompts"),
    ]);
    fillServerSettings(settings);
    renderSystemInfo(system);
    modelTestPromptTemplates = prompts;
    renderModelTestPromptList();
  } catch (error) {
    if (currentViewFromHash() === "settings") {
      setSettingsStatus("无法加载设置，请检查连接后重试。", "error");
      setRoutingSettingsStatus("无法加载路由策略，请检查连接后重试。", "error");
      if (systemInfoGrid) systemInfoGrid.innerHTML = `<p class="settings-loading">运行信息暂不可用。</p>`;
    }
  }
}

function closeModelTestDialog() {
  modelTestUpstream = null;
  clearDialogMaximized(modelTestDialog);
  if (modelTestDialog.open && typeof modelTestDialog.close === "function") modelTestDialog.close();
  else modelTestDialog.removeAttribute("open");
}

function renderModelTestPromptTemplateOptions() {
  const randomTemplate = modelTestPromptTemplates[Math.floor(Math.random() * modelTestPromptTemplates.length)];
  modelTestPromptTemplate.innerHTML = modelTestPromptTemplates.map((template) => `<option value="${template.id}">${escapeHtml(template.name)}</option>`).join("");
  if (randomTemplate) modelTestPromptTemplate.value = String(randomTemplate.id);
}

function syncModelTestPrompt() {
  const prompt = modelTestPromptTemplates.find((item) => item.id === Number(modelTestPromptTemplate.value));
  modelTestPrompt.value = prompt?.prompt || "";
}

function formatHttpRequest(request) {
  const url = new URL(request.url);
  const headers = { host: url.host, ...(request.headers || {}) };
  const lines = [`POST ${url.pathname}${url.search} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n${JSON.stringify(request.body || {}, null, 2)}`;
}

function formatHttpResponse(result) {
  const status = result.status_code || 0;
  const lines = [`HTTP/1.1 ${status}`];
  for (const [name, value] of Object.entries(result.response_headers || {}).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n${result.preview || result.message || ""}`;
}

function configuredModels(upstream) {
  return [...new Set([
    ...(upstream.model_names || []),
    ...Object.values(upstream.model_mappings || {}),
  ].filter(Boolean))];
}

function renderModelTestModelOptions(models, selected = "") {
  const normalized = [...new Set(models)].sort((a, b) => a.localeCompare(b));
  modelTestModel.innerHTML = normalized.length
    ? normalized.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join("")
    : `<option value="" disabled selected>此渠道尚未配置模型</option>`;
  if (selected && normalized.includes(selected)) modelTestModel.value = selected;
  modelTestSubmit.disabled = normalized.length === 0;
}

async function openModelTestDialog(upstream) {
  modelTestUpstream = upstream;
  modelTestTitle.textContent = `测试模型：${upstream.name}`;
  modelTestSummary.textContent = "向当前渠道发送一次实际模型请求。";
  modelTestResult.hidden = true;
  modelTestResultBody.textContent = "";
  modelTestRequestBody.textContent = "";
  modelTestResponseBody.textContent = "";
  try {
    modelTestPromptTemplates = await api("/api/admin/settings/model-test-prompts");
    renderModelTestPromptTemplateOptions();
    syncModelTestPrompt();
    renderModelTestModelOptions(configuredModels(upstream));
    if (typeof modelTestDialog.showModal === "function") modelTestDialog.showModal();
    else modelTestDialog.setAttribute("open", "");
    if (configuredModels(upstream).length > 0) modelTestModel.focus();
  } catch (error) {
    setStatus(`无法打开模型测试：${error.message}`, "error");
  }
}

async function refreshModelTestModels() {
  if (!modelTestUpstream) return;
  const previous = modelTestModel.value;
  modelTestRefreshModels.disabled = true;
  modelTestRefreshModels.textContent = "刷新中";
  try {
    const result = await api(`/api/admin/upstreams/${modelTestUpstream.id}/models`, { method: "POST" });
    renderModelTestModelOptions(result.models || [], previous);
  } catch (error) {
    setStatus(`拉取模型失败：${error.message}`, "error");
  } finally {
    modelTestRefreshModels.disabled = false;
    modelTestRefreshModels.textContent = "刷新模型";
  }
}

function renderModelTestPromptList() {
  if (!modelTestPromptList) return;
  if (modelTestPromptTemplates.length === 0) {
    modelTestPromptList.innerHTML = `<p class="settings-loading">暂无 Prompt。</p>`;
    return;
  }
  modelTestPromptList.innerHTML = modelTestPromptTemplates.map((template) => `
    <div class="model-test-template-item">
      <div><strong>${escapeHtml(template.name)}</strong><p title="${escapeHtml(template.prompt)}">${escapeHtml(template.prompt)}</p></div>
      <div class="model-test-template-actions"><button type="button" class="secondary small" data-model-prompt-action="edit" data-prompt-id="${template.id}">编辑</button><button type="button" class="secondary small danger" data-model-prompt-action="delete" data-prompt-id="${template.id}">删除</button></div>
    </div>`).join("");
}

function openModelTestPromptDialog(template = null) {
  modelTestPromptForm.reset();
  modelTestPromptId.value = template?.id || "";
  modelTestPromptName.value = template?.name || "";
  modelTestPromptContent.value = template?.prompt || "";
  document.querySelector("#model-test-prompt-title").textContent = template ? `编辑 Prompt：${template.name}` : "新增 Prompt";
  if (typeof modelTestPromptDialog.showModal === "function") modelTestPromptDialog.showModal();
  else modelTestPromptDialog.setAttribute("open", "");
  modelTestPromptName.focus();
}

function closeModelTestPromptDialog() {
  clearDialogMaximized(modelTestPromptDialog);
  if (modelTestPromptDialog.open && typeof modelTestPromptDialog.close === "function") modelTestPromptDialog.close();
  else modelTestPromptDialog.removeAttribute("open");
}

/* 测试窗口的 Prompt 下拉只在打开时填一次，所以设置页改完要主动同步一遍，
   否则窗口还开着的人会选到一个已经改名或删掉的模板。 */
async function refreshModelTestPromptDropdown() {
  modelTestPromptTemplates = await api("/api/admin/settings/model-test-prompts");
  renderModelTestPromptList();
  if (!modelTestPromptTemplate) return;
  const previous = Number(modelTestPromptTemplate.value);
  modelTestPromptTemplate.innerHTML = modelTestPromptTemplates.map((template) => `<option value="${template.id}">${escapeHtml(template.name)}</option>`).join("");
  // 原来选的还在就留着，不打断正在编辑的一次测试；没了才让浏览器落到第一项。
  if (modelTestPromptTemplates.some((template) => template.id === previous)) {
    modelTestPromptTemplate.value = String(previous);
  }
  // 选中项的正文可能刚被改过，正文框跟着走一遍。
  if (modelTestDialog?.open) syncModelTestPrompt();
}

function runtimeSettingsPayload() {
  return {
    log_body_keep_count: Number(settingsBodyKeepCount.value),
    log_retention_days: Number(settingsRetentionDays.value),
    log_body_max_bytes: Number(settingsBodyMaxBytes.value),
    max_retries: Number(settingsMaxRetries.value),
    same_upstream_retry_interval_ms: Number(settingsSameUpstreamRetryMs.value),
    auto_weight_failure_penalty: Number(settingsFailurePenalty.value),
    auto_weight_success_increment: Number(settingsSuccessIncrement.value),
    auto_weight_recovery_increment: Number(settingsRecoveryIncrement.value),
    auto_weight_recovery_interval_seconds: Number(settingsRecoveryInterval.value),
    proxy_enabled: Boolean(settingsProxyEnabled?.checked),
    proxy_url: (settingsProxyUrl?.value || "").trim(),
    revision: loadedServerSettings.revision,
  };
}

const nonIntegerSettingsKeys = new Set(["revision", "proxy_enabled", "proxy_url"]);

function runtimeSettingsAreIntegers(payload) {
  return Object.entries(payload).every(([key, value]) => nonIntegerSettingsKeys.has(key) || Number.isInteger(value));
}

async function saveServerSettings(event) {
  event.preventDefault();
  if (!loadedServerSettings) return;
  const payload = runtimeSettingsPayload();
  if (!runtimeSettingsAreIntegers(payload)) {
    setSettingsStatus("请填写有效的整数。", "error");
    return;
  }
  const lowersRetention = payload.log_body_keep_count < loadedServerSettings.log_body_keep_count || payload.log_retention_days < loadedServerSettings.log_retention_days;
  if (lowersRetention && !await requestConfirm({ title: "确认缩短日志保留", message: "降低正文保留数量或日志保留天数会在下一轮清理周期移除更多历史内容，且不能恢复。", confirmLabel: "确认保存", danger: true })) return;
  const saveButton = document.querySelector("#server-settings-save");
  saveButton.disabled = true;
  setSettingsStatus("正在保存…");
  try {
    const updated = await api("/api/admin/settings", { method: "PUT", body: JSON.stringify(payload) });
    fillServerSettings(updated);
    setSettingsStatus("日志策略已保存。", "ok");
  } catch (error) {
    if (error.status === 409) {
      await loadSettingsPage();
      setSettingsStatus("设置已被其他操作更新，已重新加载最新值；请确认后再保存。", "error");
    } else {
      setSettingsStatus("保存失败，请稍后重试。", "error");
    }
  } finally {
    saveButton.disabled = false;
  }
}

async function saveRoutingSettings(event) {
  event.preventDefault();
  if (!loadedServerSettings) return;
  const payload = runtimeSettingsPayload();
  if (!runtimeSettingsAreIntegers(payload)) {
    setRoutingSettingsStatus("请填写有效的整数。", "error");
    return;
  }
  const saveButton = document.querySelector("#routing-settings-save");
  saveButton.disabled = true;
  setRoutingSettingsStatus("正在保存…");
  try {
    const updated = await api("/api/admin/settings", { method: "PUT", body: JSON.stringify(payload) });
    fillServerSettings(updated);
    setRoutingSettingsStatus("路由策略已保存。", "ok");
    await loadUpstreams();
  } catch (error) {
    if (error.status === 409) {
      await loadSettingsPage();
      setRoutingSettingsStatus("设置已被其他操作更新，已重新加载最新值；请确认后再保存。", "error");
    } else {
      setRoutingSettingsStatus("保存失败，请检查参数后重试。", "error");
    }
  } finally {
    saveButton.disabled = false;
  }
}

async function saveProxySettings(event) {
  event.preventDefault();
  if (!loadedServerSettings) return;
  const payload = runtimeSettingsPayload();
  if (payload.proxy_enabled && !payload.proxy_url) {
    setProxySettingsStatus("启用代理时必须填写代理地址。", "error");
    return;
  }
  if (payload.proxy_url && !/^(https?|socks5h?):\/\/.+/i.test(payload.proxy_url)) {
    setProxySettingsStatus("代理地址必须以 http://、https://、socks5:// 或 socks5h:// 开头。", "error");
    return;
  }
  const saveButton = document.querySelector("#proxy-settings-save");
  saveButton.disabled = true;
  setProxySettingsStatus("正在保存…");
  try {
    const updated = await api("/api/admin/settings", { method: "PUT", body: JSON.stringify(payload) });
    fillServerSettings(updated);
    setProxySettingsStatus(updated.proxy_enabled ? "代理设置已保存，出站请求将经过代理。" : "代理设置已保存，出站请求不走代理。", "ok");
  } catch (error) {
    if (error.status === 409) {
      await loadSettingsPage();
      setProxySettingsStatus("设置已被其他操作更新，已重新加载最新值；请确认后再保存。", "error");
    } else {
      setProxySettingsStatus("保存失败，请检查代理地址后重试。", "error");
    }
  } finally {
    saveButton.disabled = false;
  }
}

async function rotateAdminToken() {
  const token = await requestRotationConfirm();
  if (!token) return;
  rotateAdminTokenButton.disabled = true;
  try {
    await api("/api/admin/settings/admin-token/rotate", {
      method: "POST",
      body: JSON.stringify({ confirm: true, token }),
    });
    setAdminToken(token);
    setStatus("管理员令牌已更换，当前控制台已改用新令牌。", "ok");
  } catch (error) {
    setStatus(error.status === 409 ? "令牌已被其他操作轮换，请重新登录。" : "轮换失败，请稍后重试。", "error");
  } finally {
    rotateAdminTokenButton.disabled = false;
  }
}

function requestRotationConfirm() {
  return new Promise((resolve) => {
    if (!rotateConfirmDialog) { resolve(null); return; }
    rotateAdminTokenInput.value = "";
    rotateConfirmCheck.checked = false;
    rotateConfirmSubmit.disabled = true;
    const finish = (token) => {
      rotateAdminTokenForm.removeEventListener("submit", approve);
      rotateConfirmCancel.removeEventListener("click", cancel);
      rotateConfirmCheck.removeEventListener("change", toggle);
      rotateAdminTokenInput.removeEventListener("input", toggle);
      rotateConfirmDialog.removeEventListener("cancel", cancelEvent);
      if (rotateConfirmDialog.open) rotateConfirmDialog.close();
      resolve(token);
    };
    const validToken = () => /^[\x21-\x7E]{8,256}$/.test(rotateAdminTokenInput.value.trim());
    const approve = (event) => {
      event.preventDefault();
      const token = rotateAdminTokenInput.value.trim();
      if (!rotateConfirmCheck.checked || !validToken()) {
        rotateAdminTokenInput.reportValidity();
        return;
      }
      finish(token);
    };
    const cancel = () => finish(null);
    const cancelEvent = (event) => { event.preventDefault(); finish(null); };
    const toggle = () => { rotateConfirmSubmit.disabled = !rotateConfirmCheck.checked || !validToken(); };
    rotateAdminTokenForm.addEventListener("submit", approve);
    rotateConfirmCancel.addEventListener("click", cancel);
    rotateConfirmCheck.addEventListener("change", toggle);
    rotateAdminTokenInput.addEventListener("input", toggle);
    rotateConfirmDialog.addEventListener("cancel", cancelEvent);
    if (typeof rotateConfirmDialog.showModal === "function") rotateConfirmDialog.showModal(); else rotateConfirmDialog.setAttribute("open", "");
    rotateAdminTokenInput.focus();
  });
}

const NON_OVERRIDABLE_CHANNEL_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "host",
  "content-length",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "x-wildtoken-upstream",
]);
const DOWNSTREAM_CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key"]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CLIENT_HEADER_PLACEHOLDER_PATTERN = /^\{client_header:([^{}]+)\}$/;
