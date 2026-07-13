const ADMIN_TOKEN_KEY = "wildtoken_admin_token";
const adminTokenDialog = document.querySelector("#admin-token-dialog");
const adminTokenForm = document.querySelector("#admin-token-form");
const adminTokenInput = document.querySelector("#admin-token-input");
const adminTokenError = document.querySelector("#admin-token-error");
const adminLogoutButton = document.querySelector("#admin-logout");

const balanceDialog = document.querySelector("#balance-dialog");
const balanceTitle = document.querySelector("#balance-title");
const balanceSummary = document.querySelector("#balance-summary");
const balanceBody = document.querySelector("#balance-body");
const balanceClose = document.querySelector("#balance-close");

const toastRegion = document.querySelector("#toast-region");
const upstreamActionMenu = document.querySelector("#upstream-action-menu");
const rows = document.querySelector("#upstream-rows");
const upstreamSummary = document.querySelector("#upstream-summary");
const form = document.querySelector("#upstream-form");
const formTitle = document.querySelector("#form-title");
const newButton = document.querySelector("#new-upstream");
const resetButton = document.querySelector("#reset-form");
const fetchModelsButton = document.querySelector("#fetch-models");
const upstreamDialog = document.querySelector("#upstream-dialog");
const upstreamDialogClose = document.querySelector("#upstream-dialog-close");
const advancedSettings = document.querySelector("#advanced-settings");

const quickImportButton = document.querySelector("#quick-import");
const quickImportDialog = document.querySelector("#quick-import-dialog");
const quickImportClose = document.querySelector("#quick-import-close");
const quickImportCancel = document.querySelector("#quick-import-cancel");
const quickImportText = document.querySelector("#quick-import-text");
const quickImportBaseUrlInput = document.querySelector("#quick-import-baseurl");
const quickImportApiKeyInput = document.querySelector("#quick-import-apikey");
const quickImportFillButton = document.querySelector("#quick-import-fill");

const confirmDialog = document.querySelector("#confirm-dialog");
const confirmTitle = document.querySelector("#confirm-title");
const confirmMessage = document.querySelector("#confirm-message");
const confirmOk = document.querySelector("#confirm-ok");
const confirmCancel = document.querySelector("#confirm-cancel");
const confirmClose = document.querySelector("#confirm-close");

const navLinks = document.querySelectorAll(".nav-link");
const views = document.querySelectorAll(".view");
const FALLBACK_VIEW = "dashboard";
const LOG_TIME_ZONE = "Asia/Singapore";
const logTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: LOG_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

// SQLite datetime('now') returns UTC without an offset. Treat unzoned values
// as UTC explicitly so rendering does not depend on the browser's own timezone.
function parseLogTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) {
    return Number.NaN;
  }
  const normalized = value.trim().replace(" ", "T");
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  return Date.parse(hasOffset ? normalized : `${normalized}Z`);
}

function formatLogTimestamp(value) {
  const timestamp = parseLogTimestamp(value);
  return Number.isFinite(timestamp) ? logTimeFormatter.format(new Date(timestamp)) : "—";
}


const logStatusBox = document.querySelector("#log-status");
const logRpm = document.querySelector("#log-rpm");
const logRows = document.querySelector("#log-rows");
const logUpstreamFilter = document.querySelector("#log-upstream-filter");
const logSearchInput = document.querySelector("#log-search");
const logStatusFilter = document.querySelector("#log-status-filter");
const logRefreshButton = document.querySelector("#log-refresh");
const logPrevButton = document.querySelector("#log-prev");
const logNextButton = document.querySelector("#log-next");
const logDetailDialog = document.querySelector("#log-detail-dialog");
const logDetailTitle = document.querySelector("#log-detail-title");
const logDetailSummary = document.querySelector("#log-detail-summary");
const logDetailMeta = document.querySelector("#log-detail-meta");
const logDetailClose = document.querySelector("#log-detail-close");
const logDetailSections = document.querySelectorAll(".log-detail-section");
const requestDetailGrid = document.querySelector(".request-detail-grid");
let currentLogDetail = null;
const LOG_PAGE_SIZE = 50;
const LOG_REFRESH_KEY = "wildtoken_log_refresh_seconds";
const DEFAULT_HOME_KEY = "wildtoken_default_home";
const DEFAULT_REFRESH_MS = 10000;
const DASHBOARD_REFRESH_MS = 15000;
const DASHBOARD_LOG_LIMIT = 200;
const DENSITY_KEY = "wildtoken_density";
const LOG_COLUMNS_KEY = "wildtoken_log_columns";
const UPSTREAM_COLUMNS_KEY = "wildtoken_upstream_columns";
let logOffset = 0;
let logHasMore = false;
let logRefreshTimer = null;
let logsLoadedOnce = false;
let logsLoading = false;

let dashboardLogItems = [];
let dashboardTokenUsage = null;
let dashboardRefreshTimer = null;
let dashboardLoading = false;
let lastDashboardLoadError = "";

const dashboardScope = document.querySelector("#dashboard-scope");
const dashboardRefreshButton = document.querySelector("#dashboard-refresh");
const dashboardKpis = document.querySelector("#dashboard-kpis");
const dashboardStatusChart = document.querySelector("#dashboard-status-chart");
const dashboardStatusMeta = document.querySelector("#dashboard-status-meta");
const dashboardLatencyChart = document.querySelector("#dashboard-latency-chart");
const dashboardLatencyMeta = document.querySelector("#dashboard-latency-meta");
const dashboardTopModels = document.querySelector("#dashboard-top-models");
const dashboardModelsMeta = document.querySelector("#dashboard-models-meta");
const dashboardTopChannels = document.querySelector("#dashboard-top-channels");
const dashboardChannelsMeta = document.querySelector("#dashboard-channels-meta");
const dashboardErrorRows = document.querySelector("#dashboard-error-rows");

let upstreamRefreshTimer = null;
let upstreamsLoadedOnce = false;
let upstreamsLoading = false;
let upstreamSearchQuery = "";
let upstreamStatusFilterValue = "";
let upstreamSearchTimer = null;

const BACKOFF_TICK_MS = 1000;
const MAX_MODEL_CHIPS = 5;
let backoffTickTimer = null;
let pageVisible = typeof document.visibilityState === "string"
  ? document.visibilityState !== "hidden"
  : true;
const selectedUpstreamIds = new Set();
let lastSummarySignature = "";

const upstreamSearchInput = document.querySelector("#upstream-search");
const liveIndicator = document.querySelector("#live-indicator");
const densityToggle = document.querySelector("#density-toggle");
const batchActionsEl = document.querySelector("#upstream-batch-actions");
const batchEnableBtn = document.querySelector("#batch-enable");
const batchDisableBtn = document.querySelector("#batch-disable");
const upstreamSelectAll = document.querySelector("#upstream-select-all");
const upstreamColMenuBtn = document.querySelector("#upstream-col-menu-btn");
const upstreamColMenu = document.querySelector("#upstream-col-menu");
const logColMenuBtn = document.querySelector("#log-col-menu-btn");
const logColMenu = document.querySelector("#log-col-menu");
const upstreamTable = document.querySelector("#upstream-table");
const logTable = document.querySelector("#log-table");
const upstreamStatusFilter = document.querySelector("#upstream-status-filter");
const tokenSearchInput = document.querySelector("#token-search");
const commandPalette = document.querySelector("#command-palette");
const commandPaletteInput = document.querySelector("#command-palette-input");
const commandPaletteList = document.querySelector("#command-palette-list");
const settingsTheme = document.querySelector("#settings-theme");
const settingsDensity = document.querySelector("#settings-density");
const settingsLogRefresh = document.querySelector("#settings-log-refresh");
const settingsDefaultHome = document.querySelector("#settings-default-home");
const serverSettingsForm = document.querySelector("#server-settings-form");
const settingsBodyKeepCount = document.querySelector("#settings-body-keep-count");
const settingsRetentionDays = document.querySelector("#settings-retention-days");
const settingsBodyMaxBytes = document.querySelector("#settings-body-max-bytes");
const settingsRevision = document.querySelector("#settings-revision");
const serverSettingsStatus = document.querySelector("#server-settings-status");
const rotateAdminTokenButton = document.querySelector("#rotate-admin-token");
const rotateConfirmDialog = document.querySelector("#rotate-confirm-dialog");
const rotateConfirmCheck = document.querySelector("#rotate-confirm-check");
const rotateConfirmCancel = document.querySelector("#rotate-confirm-cancel");
const rotateConfirmSubmit = document.querySelector("#rotate-confirm-submit");
const rotatedTokenDialog = document.querySelector("#rotated-token-dialog");
const rotatedTokenValue = document.querySelector("#rotated-token-value");
const rotatedTokenCopy = document.querySelector("#rotated-token-copy");
const rotatedTokenLogout = document.querySelector("#rotated-token-logout");
const systemRefreshButton = document.querySelector("#system-refresh");
const systemInfoGrid = document.querySelector("#system-info-grid");
const modelTestDialog = document.querySelector("#model-test-dialog");
const modelTestForm = document.querySelector("#model-test-form");
const modelTestTitle = document.querySelector("#model-test-title");
const modelTestSummary = document.querySelector("#model-test-summary");
const modelTestClose = document.querySelector("#model-test-close");
const modelTestModel = document.querySelector("#model-test-model");
const modelTestTemplate = document.querySelector("#model-test-template");
const modelTestPromptTemplate = document.querySelector("#model-test-prompt-template");
const modelTestTemplateHint = document.querySelector("#model-test-template-hint");
const modelTestPrompt = document.querySelector("#model-test-prompt");
const modelTestRefreshModels = document.querySelector("#model-test-refresh-models");
const modelTestSubmit = document.querySelector("#model-test-submit");
const modelTestResult = document.querySelector("#model-test-result");
const modelTestResultStatus = document.querySelector("#model-test-result-status");
const modelTestResultMeta = document.querySelector("#model-test-result-meta");
const modelTestResultBody = document.querySelector("#model-test-result-body");
const modelTestRequestBody = document.querySelector("#model-test-request-body");
const modelTestResponseBody = document.querySelector("#model-test-response-body");
const modelTestTemplateList = document.querySelector("#model-test-template-list");
const newModelTestTemplateButton = document.querySelector("#new-model-test-template");
const modelTestTemplateDialog = document.querySelector("#model-test-template-dialog");
const modelTestTemplateForm = document.querySelector("#model-test-template-form");
const modelTestTemplateClose = document.querySelector("#model-test-template-close");
const modelTestTemplateCancel = document.querySelector("#model-test-template-cancel");
const modelTestTemplateId = document.querySelector("#model-test-template-id");
const modelTestTemplateName = document.querySelector("#model-test-template-name");
const modelTestTemplateKind = document.querySelector("#model-test-template-kind");
const modelTestTemplatePrompt = document.querySelector("#model-test-template-prompt");
let modelTestTemplates = [];
let modelTestPromptTemplates = [];
let modelTestUpstream = null;

const modelDialog = document.querySelector("#model-dialog");
const modelDialogTitle = document.querySelector("#model-dialog-title");
const modelDialogSummary = document.querySelector("#model-dialog-summary");
const modelDialogClose = document.querySelector("#model-dialog-close");
const modelFilter = document.querySelector("#model-filter");
const modelOptions = document.querySelector("#model-options");
const modelSelectAllButton = document.querySelector("#model-select-all");
const modelClearAllButton = document.querySelector("#model-clear-all");
const modelSaveSelectionButton = document.querySelector("#model-save-selection");
const modelCancelSelectionButton = document.querySelector("#model-cancel-selection");

const fields = {
  id: document.querySelector("#upstream-id"),
  name: document.querySelector("#name"),
  baseUrl: document.querySelector("#base-url"),
  apiKey: document.querySelector("#api-key"),
  modelNames: document.querySelector("#model-names"),
  modelPrefixes: document.querySelector("#model-prefixes"),
  modelMappings: document.querySelector("#model-mappings"),
  priority: document.querySelector("#priority"),
  timeoutSeconds: document.querySelector("#timeout-seconds"),
  extraHeaders: document.querySelector("#extra-headers"),
  enabled: document.querySelector("#enabled"),
  clearApiKey: document.querySelector("#clear-api-key"),
};
let persistedFormApiKey = null;

// ── 令牌管理 ────────────────────────────────────────────────
const tokenRows = document.querySelector("#token-rows");
const tokenDialog = document.querySelector("#token-dialog");
const tokenForm = document.querySelector("#token-form");
const tokenFormTitle = document.querySelector("#token-form-title");
const tokenDialogClose = document.querySelector("#token-dialog-close");
const newTokenButton = document.querySelector("#new-token");
const tokenResetButton = document.querySelector("#token-reset-form");
const copyTokenButton = document.querySelector("#copy-token");
const tokenValueRow = document.querySelector("#token-value-row");
const tokenNameInput = document.querySelector("#token-name");
const tokenDescriptionInput = document.querySelector("#token-description");
const tokenCustomRow = document.querySelector("#token-custom-row");
const tokenCustomInput = document.querySelector("#token-custom");
const tokenEnabledCheckbox = document.querySelector("#token-enabled");
const tokenIdInput = document.querySelector("#token-id");
const tokenValueDisplay = document.querySelector("#token-value-display");

let tokenRefreshTimer = null;
let tokens = [];
let tokensLoadedOnce = false;
let tokensLoading = false;
let tokenSearchQuery = "";
let tokenSearchTimer = null;

let upstreams = [];
let activeActionMenuButton = null;
let lastUpstreamLoadError = "";
const modelDialogState = {
  upstream: null,
  mode: "form",
  models: [],
  selected: new Set(),
};


function setStatus(message, tone = "neutral", options = {}) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.tone = tone;
  toast.setAttribute("role", tone === "error" ? "alert" : "status");

  const messageBox = document.createElement("div");
  messageBox.className = "toast-message";
  messageBox.textContent = message;

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "toast-close";
  closeButton.setAttribute("aria-label", "关闭消息");
  closeButton.title = "关闭";
  closeButton.textContent = "×";

  let actionButton = null;
  if (options.actionLabel && typeof options.onAction === "function") {
    toast.classList.add("has-action");
    actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.className = "toast-action";
    actionButton.textContent = options.actionLabel;
  }

  if (actionButton) {
    toast.append(messageBox, actionButton, closeButton);
  } else {
    toast.append(messageBox, closeButton);
  }
  toastRegion.append(toast);
  showPopoverLayer(toastRegion, true);

  while (toastRegion.children.length > 4) {
    toastRegion.firstElementChild.remove();
  }

  const duration = typeof options.durationMs === "number"
    ? options.durationMs
    : tone === "error" ? 6000 : tone === "ok" ? 4000 : 3000;
  let dismissTimer = window.setTimeout(() => dismissToast(toast), duration);
  const restartTimer = () => {
    window.clearTimeout(dismissTimer);
    dismissTimer = window.setTimeout(() => dismissToast(toast), duration);
  };

  toast.addEventListener("mouseenter", () => window.clearTimeout(dismissTimer));
  toast.addEventListener("mouseleave", restartTimer);
  closeButton.addEventListener("click", () => {
    window.clearTimeout(dismissTimer);
    dismissToast(toast);
  });
  if (actionButton) {
    actionButton.addEventListener("click", async () => {
      window.clearTimeout(dismissTimer);
      actionButton.disabled = true;
      try {
        await options.onAction();
      } finally {
        dismissToast(toast);
      }
    });
  }
}

function dismissToast(toast) {
  if (!toast.isConnected || toast.classList.contains("is-leaving")) {
    return;
  }
  toast.classList.add("is-leaving");
  window.setTimeout(() => {
    toast.remove();
    if (toastRegion.children.length === 0) {
      hidePopoverLayer(toastRegion);
    }
  }, 180);
}

function requestConfirm({
  title = "确认操作",
  message = "",
  confirmLabel = "删除",
  cancelLabel = "取消",
  danger = true,
} = {}) {
  return new Promise((resolve) => {
    if (!confirmDialog) {
      resolve(window.confirm(message || title));
      return;
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      confirmOk.removeEventListener("click", onOk);
      confirmCancel.removeEventListener("click", onCancel);
      confirmClose.removeEventListener("click", onCancel);
      confirmDialog.removeEventListener("cancel", onCancelEvent);
      confirmDialog.removeEventListener("click", onBackdrop);
      if (confirmDialog.open && typeof confirmDialog.close === "function") {
        confirmDialog.close();
      } else {
        confirmDialog.removeAttribute("open");
      }
      resolve(value);
    };

    const onOk = (event) => {
      event.preventDefault();
      finish(true);
    };
    const onCancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    const onCancelEvent = (event) => {
      event.preventDefault();
      finish(false);
    };
    const onBackdrop = (event) => {
      if (event.target === confirmDialog) {
        finish(false);
      }
    };

    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    confirmOk.textContent = confirmLabel;
    confirmCancel.textContent = cancelLabel;
    confirmOk.classList.toggle("danger", danger);
    confirmOk.classList.toggle("secondary", !danger);

    confirmOk.addEventListener("click", onOk);
    confirmCancel.addEventListener("click", onCancel);
    confirmClose.addEventListener("click", onCancel);
    confirmDialog.addEventListener("cancel", onCancelEvent);
    confirmDialog.addEventListener("click", onBackdrop);

    if (typeof confirmDialog.showModal === "function") {
      confirmDialog.showModal();
    } else {
      confirmDialog.setAttribute("open", "");
    }
    confirmOk.focus();
  });
}

function popoverIsOpen(element) {
  return typeof element.showPopover === "function" && element.matches(":popover-open");
}

function showPopoverLayer(element, bringToFront = false) {
  element.hidden = false;
  if (typeof element.showPopover !== "function") {
    return;
  }
  try {
    if (bringToFront && popoverIsOpen(element)) {
      element.hidePopover();
    }
    if (!popoverIsOpen(element)) {
      element.showPopover();
    }
  } catch {
    // The fixed-position fallback remains visible when Popover API is unavailable.
  }
}

function hidePopoverLayer(element) {
  if (popoverIsOpen(element)) {
    element.hidePopover();
  }
  element.hidden = true;
}

function splitList(value) {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinList(value) {
  return (value || []).join(", ");
}

function parseModelMappings(value) {
  const mappings = {};
  for (const line of value.split(/\n/)) {
    const clean = line.trim();
    if (!clean) {
      continue;
    }
    const match = clean.match(/^(.+?)(?:=>|=|:)(.+)$/);
    if (!match) {
      throw new Error(`模型映射格式错误：${clean}`);
    }
    const downstream = match[1].trim();
    const upstream = match[2].trim();
    if (downstream && upstream) {
      mappings[downstream] = upstream;
    }
  }
  return mappings;
}

function joinModelMappings(value) {
  return Object.entries(value || {})
    .map(([downstream, upstream]) => `${downstream} => ${upstream}`)
    .join("\n");
}

function uniqueList(items) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const clean = String(item).trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
  }
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}

function renderIcon(name) {
  if (name === "copy") {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="9" y="9" width="10" height="10" rx="2"></rect>
        <path d="M5 15V7a2 2 0 0 1 2-2h8"></path>
      </svg>
    `;
  }
  if (name === "open") {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M14 5h5v5"></path>
        <path d="M10 14 19 5"></path>
        <path d="M19 14v3a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3"></path>
      </svg>
    `;
  }
  return "";
}

function renderBaseUrlCell(upstream) {
  const baseUrl = escapeHtml(upstream.base_url);
  const name = escapeHtml(upstream.name);
  return `
    <div class="url-cell-inner">
      <code title="${baseUrl}">${baseUrl}</code>
      <span class="url-cell-actions" aria-label="Base URL 操作">
        <button
          type="button"
          class="secondary ghost url-action"
          data-url-action="copy"
          data-base-url="${baseUrl}"
          aria-label="复制 ${name} 的 Base URL"
          title="复制 Base URL"
        >${renderIcon("copy")}</button>
        <button
          type="button"
          class="secondary ghost url-action"
          data-url-action="open"
          data-base-url="${baseUrl}"
          aria-label="打开 ${name} 的 Base URL"
          title="打开 Base URL"
        >${renderIcon("open")}</button>
      </span>
    </div>
  `;
}

function normalizeHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function modelMatchItems(upstream) {
  return [
    ...Object.entries(upstream.model_mappings || {}).map(([downstream, upstreamModel]) => ({
      label: `${downstream}=>${upstreamModel}`,
      type: "mapping",
    })),
    ...upstream.model_names.map((value) => ({ label: value, type: "name" })),
    ...upstream.model_prefixes.map((value) => ({ label: `${value}*`, type: "prefix" })),
  ];
}

function renderModelMatches(upstream) {
  const items = modelMatchItems(upstream);
  if (items.length === 0) {
    return '<span class="muted">默认候选</span>';
  }
  const visible = items.slice(0, MAX_MODEL_CHIPS);
  const hiddenCount = items.length - visible.length;
  const title = items.map((item) => item.label).join(", ");
  const chips = visible
    .map((item) => (
      `<span class="model-chip ${escapeHtml(item.type)}">${escapeHtml(item.label)}</span>`
    ))
    .join("");
  const more = hiddenCount > 0 ? `<span class="model-chip more">+${hiddenCount}</span>` : "";
  return `<div class="model-chip-list" title="${escapeHtml(title)}">${chips}${more}</div>`;
}

function renderUpstreamSummary() {
  scheduleRenderUpstreamSummary();
}

function renderUpstreamSummaryCore() {
  if (!upstreamSummary) {
    return;
  }
  const total = upstreams.length;
  const enabled = upstreams.filter((upstream) => upstream.enabled).length;
  const disabled = total - enabled;
  const backedOff = upstreams.filter((upstream) => liveBackoffSeconds(upstream) > 0).length;

  const signature = [total, enabled, disabled, backedOff].join("|");
  if (signature === lastSummarySignature) {
    return;
  }
  lastSummarySignature = signature;

  const backoffHint = backedOff > 0
    ? `<span class="summary-hint">退避结束后自动恢复路由</span>`
    : "";

  upstreamSummary.innerHTML = `
    <span><strong>${total}</strong>渠道总数</span>
    <span><strong>${enabled}</strong>启用</span>
    <span><strong>${disabled}</strong>停用</span>
    <span class="${backedOff ? "summary-warn" : ""}"><strong>${backedOff}</strong>退避中${backoffHint}</span>
  `;
}

function debounce(fn, wait = 150) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

// ── Density / column prefs / health / charts ─────────────

const DEFAULT_UPSTREAM_COLUMNS = {
  check: true,
  id: true,
  name: true,
  base_url: true,
  models: true,
  priority: true,
  status: true,
  actions: true,
};

const DEFAULT_LOG_COLUMNS = {
  time: true,
  channel: true,
  token: true,
  client: true,
  model: true,
  reasoning: true,
  status: true,
  duration: true,
  tokens: true,
};

const UPSTREAM_LOCKED_COLS = new Set(["check", "id", "name", "actions"]);
const LOG_LOCKED_COLS = new Set(["time", "status"]);

const UPSTREAM_COL_LABELS = {
  check: "选择",
  id: "ID",
  name: "名称",
  base_url: "Base URL",
  models: "模型匹配",
  priority: "优先级",
  status: "状态",
  actions: "操作",
};

const LOG_COL_LABELS = {
  time: "时间",
  channel: "渠道",
  token: "令牌",
  client: "客户端",
  model: "模型",
  reasoning: "思考强度",
  status: "状态码",
  duration: "耗时",
  tokens: "Tokens",
};

function readJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...fallback };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...fallback };
    return { ...fallback, ...parsed };
  } catch {
    return { ...fallback };
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function getDensity() {
  try {
    const value = localStorage.getItem(DENSITY_KEY);
    return value === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

function applyDensity(density) {
  const next = density === "compact" ? "compact" : "comfortable";
  document.documentElement.setAttribute("data-density", next);
  try {
    localStorage.setItem(DENSITY_KEY, next);
  } catch {
    /* ignore */
  }
  if (densityToggle) {
    densityToggle.setAttribute(
      "aria-label",
      next === "compact" ? "切换到舒适密度" : "切换到紧凑密度",
    );
    densityToggle.title = next === "compact" ? "当前：紧凑 · 点击切换" : "当前：舒适 · 点击切换";
    const label = densityToggle.querySelector(".density-toggle-label");
    if (label) label.textContent = next === "compact" ? "紧凑" : "舒适";
  }
  if (typeof updatePreferenceControls === "function") updatePreferenceControls();
}

function cycleDensity() {
  applyDensity(getDensity() === "compact" ? "comfortable" : "compact");
}

let upstreamColumns = readJsonStorage(UPSTREAM_COLUMNS_KEY, DEFAULT_UPSTREAM_COLUMNS);
let logColumns = readJsonStorage(LOG_COLUMNS_KEY, DEFAULT_LOG_COLUMNS);
let upstreamSort = { key: "priority", direction: "desc" };

function applyColumnVisibility(table, columns, prefix) {
  if (!table) return;
  for (const key of Object.keys(columns)) {
    table.classList.toggle(`col-hide-${key}`, columns[key] === false);
  }
}

function applyAllColumnVisibility() {
  applyColumnVisibility(upstreamTable, upstreamColumns, "upstream");
  applyColumnVisibility(logTable, logColumns, "log");
}

function renderColumnMenu(menu, columns, labels, locked, storageKey, table) {
  if (!menu) return;
  menu.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const [key, label] of Object.entries(labels)) {
    const row = document.createElement("label");
    row.className = locked.has(key) ? "is-locked" : "";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = columns[key] !== false;
    input.disabled = locked.has(key);
    input.dataset.colKey = key;
    const text = document.createElement("span");
    text.textContent = label + (locked.has(key) ? "（固定）" : "");
    row.append(input, text);
    if (!locked.has(key)) {
      input.addEventListener("change", () => {
        columns[key] = input.checked;
        writeJsonStorage(storageKey, columns);
        applyColumnVisibility(table, columns);
      });
    }
    fragment.append(row);
  }
  menu.append(fragment);
}

function closeColMenus() {
  if (upstreamColMenu) {
    upstreamColMenu.hidden = true;
    upstreamColMenuBtn?.setAttribute("aria-expanded", "false");
  }
  if (logColMenu) {
    logColMenu.hidden = true;
    logColMenuBtn?.setAttribute("aria-expanded", "false");
  }
}

function toggleColMenu(menu, button) {
  if (!menu || !button) return;
  const open = menu.hidden;
  closeColMenus();
  if (open) {
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
  }
}

function formatBackoffNote(seconds) {
  if (!seconds) return "";
  return `退避中 · 剩 ${seconds}s · 自动恢复后参与路由`;
}

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

  if (dashboardKpis) {
    const errorTone = n === 0
      ? ""
      : errorCount / n >= 0.2
        ? "tone-danger"
        : errorCount / n >= 0.05
          ? "tone-warn"
          : "tone-ok";
    const tokenUsageCards = [
      tokenUsageCard("今天 Tokens", dashboardTokenUsage?.today, "本地日累计"),
      tokenUsageCard("1d Tokens", dashboardTokenUsage?.one_day, "最近 24 小时"),
      tokenUsageCard("7d Tokens", dashboardTokenUsage?.seven_days, "最近 7 天"),
      tokenUsageCard("30d Tokens", dashboardTokenUsage?.thirty_days, "最近 30 天"),
    ];
    const cards = [
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
      ...tokenUsageCards,
    ];
    dashboardKpis.innerHTML = cards.map((card) => `
      <div class="dashboard-kpi ${card.tone}">
        <div class="dashboard-kpi-value">${escapeHtml(card.value)}</div>
        <div class="dashboard-kpi-label">${escapeHtml(card.label)}</div>
        <div class="dashboard-kpi-hint">${escapeHtml(card.hint)}</div>
      </div>
    `).join("");
  }

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
    if (status === "backoff" && liveBackoffSeconds(upstream) <= 0) return false;
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
  return liveBackoffSeconds(upstream) > 0 ? 1 : 0;
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
  logOffset = 0;
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
  } else {
    stopLogRefresh();
  }
  if (name === "upstreams") {
    loadUpstreams();
    startUpstreamRefresh();
    startBackoffTick();
  } else {
    stopUpstreamRefresh();
    stopBackoffTick();
  }
  if (name === "tokens") {
    loadTokens();
    startTokenRefresh();
  } else {
    stopTokenRefresh();
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
    logRefreshTimer || upstreamRefreshTimer || tokenRefreshTimer || dashboardRefreshTimer,
  );
  liveIndicator.hidden = !active || !pageVisible;
}

function startLogRefresh() {
  const interval = getLogRefreshMs();
  if (logRefreshTimer !== null || !pageVisible || interval === 0) {
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

function startBackoffTick() {
  if (backoffTickTimer !== null || !pageVisible) {
    return;
  }
  backoffTickTimer = window.setInterval(updateBackoffNotes, BACKOFF_TICK_MS);
}

function stopBackoffTick() {
  if (backoffTickTimer === null) {
    return;
  }
  window.clearInterval(backoffTickTimer);
  backoffTickTimer = null;
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
  stopUpstreamRefresh();
  stopTokenRefresh();
  stopBackoffTick();
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
  } else if (name === "upstreams") {
    startUpstreamRefresh();
    startBackoffTick();
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

function updatePreferenceControls() {
  const theme = getStoredTheme();
  const density = getDensity();
  settingsTheme?.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.themeChoice === theme);
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme));
  });
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
  settingsRevision.textContent = `修订 ${settings.revision} · ${settings.updated_at || "刚刚更新"}`;
  setSettingsStatus("");
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
    ["近 1 分钟请求", Number(system.recent_one_minute_log_count || 0).toLocaleString("zh-CN")],
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
    const [settings, system, templates] = await Promise.all([api("/api/admin/settings"), api("/api/admin/system"), api("/api/admin/settings/model-test-templates")]);
    fillServerSettings(settings);
    renderSystemInfo(system);
    modelTestTemplates = templates;
    renderModelTestTemplates();
  } catch (error) {
    if (currentViewFromHash() === "settings") {
      setSettingsStatus("无法加载设置，请检查连接后重试。", "error");
      if (systemInfoGrid) systemInfoGrid.innerHTML = `<p class="settings-loading">运行信息暂不可用。</p>`;
    }
  }
}

function templateKindLabel(kind) {
  return kind === "responses" ? "Responses" : "Chat Completions";
}

function renderModelTestTemplates() {
  if (!modelTestTemplateList) return;
  if (modelTestTemplates.length === 0) {
    modelTestTemplateList.innerHTML = `<p class="settings-loading">暂无模板。请新增一个模板后再测试模型。</p>`;
    return;
  }
  modelTestTemplateList.innerHTML = modelTestTemplates.map((template) => `
    <div class="model-test-template-item">
      <div><strong>${escapeHtml(template.name)} <span class="muted">${escapeHtml(templateKindLabel(template.request_kind))}</span></strong><p title="${escapeHtml(template.prompt)}">${escapeHtml(template.prompt)}</p></div>
      <div class="model-test-template-actions"><button type="button" class="secondary small" data-model-template-action="edit" data-template-id="${template.id}">编辑</button><button type="button" class="secondary small danger" data-model-template-action="delete" data-template-id="${template.id}">删除</button></div>
    </div>`).join("");
}

function closeModelTestDialog() {
  modelTestUpstream = null;
  if (modelTestDialog.open && typeof modelTestDialog.close === "function") modelTestDialog.close();
  else modelTestDialog.removeAttribute("open");
}

function renderModelTestTemplateOptions() {
  const current = Number(modelTestTemplate.value);
  modelTestTemplate.innerHTML = modelTestTemplates.map((template) => `<option value="${template.id}">${escapeHtml(template.name)} · ${escapeHtml(templateKindLabel(template.request_kind))}</option>`).join("");
  if (modelTestTemplates.some((template) => template.id === current)) modelTestTemplate.value = String(current);
  updateModelTestTemplateHint();
}

function updateModelTestTemplateHint() {
  const template = modelTestTemplates.find((item) => item.id === Number(modelTestTemplate.value));
  modelTestTemplateHint.textContent = template ? `${templateKindLabel(template.request_kind)} 请求格式与头部。` : "请选择请求包装。";
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
  modelTestSubmit.disabled = normalized.length === 0 || modelTestTemplates.length === 0;
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
    [modelTestTemplates, modelTestPromptTemplates] = await Promise.all([api("/api/admin/settings/model-test-templates"), api("/api/admin/settings/model-test-prompts")]);
    renderModelTestTemplateOptions();
    modelTestPromptTemplate.innerHTML = modelTestPromptTemplates.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join("");
    updateModelTestTemplateHint();
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

function openModelTestTemplateDialog(template = null) {
  modelTestTemplateForm.reset();
  modelTestTemplateId.value = template?.id || "";
  modelTestTemplateName.value = template?.name || "";
  modelTestTemplateKind.value = template?.request_kind || "responses";
  modelTestTemplatePrompt.value = template?.prompt || "Reply with exactly: WildToken test passed.";
  document.querySelector("#model-test-template-title").textContent = template ? `编辑模板：${template.name}` : "新增测试模板";
  if (typeof modelTestTemplateDialog.showModal === "function") modelTestTemplateDialog.showModal();
  else modelTestTemplateDialog.setAttribute("open", "");
  modelTestTemplateName.focus();
}

function closeModelTestTemplateDialog() {
  if (modelTestTemplateDialog.open && typeof modelTestTemplateDialog.close === "function") modelTestTemplateDialog.close();
  else modelTestTemplateDialog.removeAttribute("open");
}

async function saveServerSettings(event) {
  event.preventDefault();
  if (!loadedServerSettings) return;
  const payload = {
    log_body_keep_count: Number(settingsBodyKeepCount.value),
    log_retention_days: Number(settingsRetentionDays.value),
    log_body_max_bytes: Number(settingsBodyMaxBytes.value),
    revision: loadedServerSettings.revision,
  };
  if (!Number.isInteger(payload.log_body_keep_count) || !Number.isInteger(payload.log_retention_days) || !Number.isInteger(payload.log_body_max_bytes)) {
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

async function rotateAdminToken() {
  const confirmed = await requestRotationConfirm();
  if (!confirmed) return;
  rotateAdminTokenButton.disabled = true;
  try {
    const result = await api("/api/admin/settings/admin-token/rotate", { method: "POST", body: JSON.stringify({ confirm: true }) });
    rotatedTokenValue.textContent = result.token;
    if (typeof rotatedTokenDialog.showModal === "function") rotatedTokenDialog.showModal(); else rotatedTokenDialog.setAttribute("open", "");
    rotatedTokenCopy.focus();
  } catch (error) {
    setStatus(error.status === 409 ? "令牌已被其他操作轮换，请重新登录。" : "轮换失败，请稍后重试。", "error");
  } finally {
    rotateAdminTokenButton.disabled = false;
  }
}

function requestRotationConfirm() {
  return new Promise((resolve) => {
    if (!rotateConfirmDialog) { resolve(false); return; }
    rotateConfirmCheck.checked = false;
    rotateConfirmSubmit.disabled = true;
    const finish = (confirmed) => {
      rotateConfirmSubmit.removeEventListener("click", approve);
      rotateConfirmCancel.removeEventListener("click", cancel);
      rotateConfirmCheck.removeEventListener("change", toggle);
      rotateConfirmDialog.removeEventListener("cancel", cancelEvent);
      if (rotateConfirmDialog.open) rotateConfirmDialog.close();
      resolve(confirmed);
    };
    const approve = () => finish(true);
    const cancel = () => finish(false);
    const cancelEvent = (event) => { event.preventDefault(); finish(false); };
    const toggle = () => { rotateConfirmSubmit.disabled = !rotateConfirmCheck.checked; };
    rotateConfirmSubmit.addEventListener("click", approve);
    rotateConfirmCancel.addEventListener("click", cancel);
    rotateConfirmCheck.addEventListener("change", toggle);
    rotateConfirmDialog.addEventListener("cancel", cancelEvent);
    if (typeof rotateConfirmDialog.showModal === "function") rotateConfirmDialog.showModal(); else rotateConfirmDialog.setAttribute("open", "");
    rotateConfirmCheck.focus();
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

function parseHeaderOverrides(value = fields.extraHeaders.value) {
  let parsed;
  try {
    parsed = JSON.parse(value || "{}");
  } catch (error) {
    setAdvancedSettingsOpen(true);
    fields.extraHeaders.focus();
    throw new Error(`Header 覆盖不是合法 JSON：${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    setAdvancedSettingsOpen(true);
    fields.extraHeaders.focus();
    throw new Error("Header 覆盖必须是由 Header 名和字符串值组成的 JSON 对象。");
  }

  const normalized = Object.create(null);
  for (const [name, headerValue] of Object.entries(parsed)) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      setAdvancedSettingsOpen(true);
      fields.extraHeaders.focus();
      throw new Error(`Header 名无效：${name || "（空）"}`);
    }
    if (typeof headerValue !== "string") {
      setAdvancedSettingsOpen(true);
      fields.extraHeaders.focus();
      throw new Error(`Header ${name} 的值必须是字符串。`);
    }
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(headerValue)) {
      setAdvancedSettingsOpen(true);
      fields.extraHeaders.focus();
      throw new Error(`Header ${name} 的值包含非法控制字符。`);
    }

    const normalizedName = name.toLowerCase();
    if (NON_OVERRIDABLE_CHANNEL_HEADERS.has(normalizedName)) {
      setAdvancedSettingsOpen(true);
      fields.extraHeaders.focus();
      throw new Error(`Header ${name} 属于传输或内部路由头，不能覆盖。`);
    }
    if (Object.prototype.hasOwnProperty.call(normalized, normalizedName)) {
      setAdvancedSettingsOpen(true);
      fields.extraHeaders.focus();
      throw new Error(`Header 名大小写重复：${name}`);
    }

    const placeholder = headerValue.match(CLIENT_HEADER_PLACEHOLDER_PATTERN);
    if (headerValue.includes("{client_header:") && !placeholder) {
      setAdvancedSettingsOpen(true);
      fields.extraHeaders.focus();
      throw new Error(`Header ${name} 的 client_header 占位符必须占满整个值。`);
    }
    if (placeholder) {
      const sourceName = placeholder[1];
      const normalizedSource = sourceName.toLowerCase();
      if (!HEADER_NAME_PATTERN.test(sourceName)) {
        setAdvancedSettingsOpen(true);
        fields.extraHeaders.focus();
        throw new Error(`client_header 来源 Header 名无效：${sourceName}`);
      }
      if (DOWNSTREAM_CREDENTIAL_HEADERS.has(normalizedSource)) {
        setAdvancedSettingsOpen(true);
        fields.extraHeaders.focus();
        throw new Error(`不能通过 client_header 读取下游凭证 Header：${sourceName}`);
      }
      if (NON_OVERRIDABLE_CHANNEL_HEADERS.has(normalizedSource)) {
        setAdvancedSettingsOpen(true);
        fields.extraHeaders.focus();
        throw new Error(`不能通过 client_header 读取传输或内部 Header：${sourceName}`);
      }
    }
    normalized[normalizedName] = headerValue;
  }

  return normalized;
}

function payloadFromForm() {
  const extraHeaders = parseHeaderOverrides();
  const modelMappings = parseModelMappings(fields.modelMappings.value);
  return {
    name: fields.name.value.trim(),
    base_url: fields.baseUrl.value.trim(),
    api_key: fields.apiKey.value.trim() || null,
    model_names: splitList(fields.modelNames.value),
    model_prefixes: splitList(fields.modelPrefixes.value),
    model_mappings: modelMappings,
    priority: Number(fields.priority.value || 100),
    timeout_seconds: Number(fields.timeoutSeconds.value || 300),
    enabled: fields.enabled.checked,
    extra_headers: extraHeaders,
    clear_api_key: fields.clearApiKey.checked,
  };
}

function hasExtraHeaders(headers) {
  return headers
    && typeof headers === "object"
    && !Array.isArray(headers)
    && Object.keys(headers).length > 0;
}

function setAdvancedSettingsOpen(open) {
  if (advancedSettings) {
    advancedSettings.open = open;
  }
}

function openUpstreamDialog() {
  if (typeof upstreamDialog.showModal === "function") {
    upstreamDialog.showModal();
  } else {
    upstreamDialog.setAttribute("open", "");
  }
  fields.name.focus();
}

function closeUpstreamDialog() {
  if (upstreamDialog.open && typeof upstreamDialog.close === "function") {
    upstreamDialog.close();
  } else {
    upstreamDialog.removeAttribute("open");
  }
}

function cancelUpstreamDialog() {
  closeUpstreamDialog();
  resetForm();
}

function parseQuickImport(text) {
  const apiKeyMatches = text.match(/sk-[a-zA-Z0-9_-]{16,}/g) || [];
  const apiKey = [...apiKeyMatches].sort((a, b) => b.length - a.length)[0] || null;

  const urlMatches = text.match(/https?:\/\/[^\s"'<>()\[\]“”，、；]+/g) || [];
  const candidates = urlMatches
    .map((url) => url.replace(/[.,;:)\]}"'，。；、]+$/, ""))
    .filter(Boolean);

  const scoreUrl = (url) => {
    const lower = url.toLowerCase();
    let score = 0;
    if (lower.includes("/v1")) score += 2;
    if (lower.includes("api")) score += 1;
    return score;
  };

  let baseUrl = null;
  if (candidates.length > 0) {
    const ranked = [...candidates].sort((a, b) => scoreUrl(b) - scoreUrl(a));
    try {
      baseUrl = new URL(ranked[0]).origin;
    } catch (_) {
      baseUrl = null;
    }
  }

  return { baseUrl, apiKey };
}

function suggestNameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^api\./, "");
  } catch (_) {
    return "";
  }
}

function updateQuickImportFillState() {
  quickImportFillButton.disabled =
    !quickImportBaseUrlInput.value.trim() && !quickImportApiKeyInput.value.trim();
}

function syncQuickImportFields() {
  const { baseUrl, apiKey } = parseQuickImport(quickImportText.value);
  if (baseUrl) {
    quickImportBaseUrlInput.value = baseUrl;
  }
  if (apiKey) {
    quickImportApiKeyInput.value = apiKey;
  }
  updateQuickImportFillState();
}

function openQuickImportDialog() {
  quickImportText.value = "";
  quickImportBaseUrlInput.value = "";
  quickImportApiKeyInput.value = "";
  updateQuickImportFillState();
  if (typeof quickImportDialog.showModal === "function") {
    quickImportDialog.showModal();
  } else {
    quickImportDialog.setAttribute("open", "");
  }
  quickImportText.focus();
}

function closeQuickImportDialog() {
  if (quickImportDialog.open && typeof quickImportDialog.close === "function") {
    quickImportDialog.close();
  } else {
    quickImportDialog.removeAttribute("open");
  }
}

async function editUpstream(upstream) {
  try {
    const detail = await api(`/api/admin/upstreams/${upstream.id}`);
    fields.id.value = detail.id;
    fields.name.value = detail.name;
    fields.baseUrl.value = detail.base_url;
    fields.apiKey.value = detail.api_key || "";
    persistedFormApiKey = detail.api_key || null;
    fields.modelNames.value = joinList(detail.model_names);
    fields.modelPrefixes.value = joinList(detail.model_prefixes);
    fields.modelMappings.value = joinModelMappings(detail.model_mappings);
    fields.priority.value = detail.priority;
    fields.timeoutSeconds.value = detail.timeout_seconds;
    fields.extraHeaders.value = JSON.stringify(detail.extra_headers || {}, null, 2);
    fields.enabled.checked = detail.enabled;
    fields.clearApiKey.checked = false;
    setAdvancedSettingsOpen(hasExtraHeaders(detail.extra_headers));
    fetchModelsButton.disabled = false;
    formTitle.textContent = `编辑渠道：${detail.name}`;
    openUpstreamDialog();
  } catch (error) {
    setStatus(`加载渠道配置失败：${error.message}`, "error");
  }
}

function duplicateUpstream(upstream) {
  resetForm();
  fields.name.value = `${upstream.name} 副本`;
  fields.baseUrl.value = upstream.base_url;
  fields.modelNames.value = joinList(upstream.model_names);
  fields.modelPrefixes.value = joinList(upstream.model_prefixes);
  fields.modelMappings.value = joinModelMappings(upstream.model_mappings);
  fields.priority.value = upstream.priority;
  fields.timeoutSeconds.value = upstream.timeout_seconds;
  fields.extraHeaders.value = JSON.stringify(upstream.extra_headers || {}, null, 2);
  fields.enabled.checked = upstream.enabled;
  setAdvancedSettingsOpen(hasExtraHeaders(upstream.extra_headers));
  formTitle.textContent = `复制渠道：${upstream.name}`;
  openUpstreamDialog();
  setStatus("已复制渠道配置，API Key 需要重新填写后再保存。", "ok");
}

function openBalanceDialog() {
  if (typeof balanceDialog.showModal === "function") {
    balanceDialog.showModal();
  } else {
    balanceDialog.setAttribute("open", "");
  }
}

function closeBalanceDialog() {
  if (balanceDialog.open && typeof balanceDialog.close === "function") {
    balanceDialog.close();
  } else {
    balanceDialog.removeAttribute("open");
  }
}

function formatUsd(value) {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "-";
}

async function showBalance(upstream) {
  balanceTitle.textContent = `余额查询：${upstream.name}`;
  balanceSummary.textContent = "正在查询...";
  balanceBody.innerHTML = "";
  openBalanceDialog();

  try {
    const result = await api(`/api/admin/upstreams/${upstream.id}/balance`, { method: "POST" });
    if (result.ok) {
      balanceSummary.textContent = "查询成功";
      balanceBody.innerHTML = `
        <div class="balance-row"><span class="label">总额</span><span class="value">${formatUsd(result.total_usd)}</span></div>
        <div class="balance-row"><span class="label">已用</span><span class="value">${formatUsd(result.used_usd)}</span></div>
        <div class="balance-row"><span class="label">剩余</span><span class="value">${formatUsd(result.remaining_usd)}</span></div>
      `;
    } else {
      balanceSummary.textContent = "查询失败";
      balanceBody.innerHTML = `<p class="muted">${escapeHtml(result.message || "未知错误")}</p>`;
    }
  } catch (error) {
    balanceSummary.textContent = "查询失败";
    balanceBody.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

function resetForm() {
  form.reset();
  fields.id.value = "";
  persistedFormApiKey = null;
  fields.priority.value = 100;
  fields.timeoutSeconds.value = 300;
  fields.modelMappings.value = "";
  fields.extraHeaders.value = "{}";
  fields.enabled.checked = true;
  setAdvancedSettingsOpen(false);
  fetchModelsButton.disabled = false;
  formTitle.textContent = "新增渠道";
}

function renderRows() {
  const openMenuId = activeActionMenuButton && !upstreamActionMenu.hidden
    ? Number(activeActionMenuButton.dataset.menuId)
    : null;
  if (activeActionMenuButton) {
    activeActionMenuButton.setAttribute("aria-expanded", "false");
    activeActionMenuButton = null;
  }

  rows.innerHTML = "";
  renderUpstreamSummary();

  const colCount = 8;

  if (upstreamsLoading && !upstreamsLoadedOnce) {
    rows.innerHTML = skeletonRowsMarkup(colCount, 6);
    updateBatchToolbar();
    return;
  }

  if (upstreamsLoadedOnce && upstreams.length === 0 && !upstreamFiltersActive()) {
    closeUpstreamActionMenu();
    rows.innerHTML = emptyStateCell(colCount, {
      title: "暂无渠道",
      copy: "还没有配置上游渠道。创建后即可按优先级与模型规则路由请求。",
      actionLabel: "新增渠道",
      actionId: "new-upstream",
    });
    updateBatchToolbar();
    return;
  }

  const filtered = getFilteredUpstreams();
  if (upstreamsLoadedOnce && filtered.length === 0) {
    closeUpstreamActionMenu();
    rows.innerHTML = noMatchStateCell(colCount, {
      title: "无匹配渠道",
      copy: "当前筛选条件下没有结果。可调整搜索词或状态筛选。",
      actionLabel: "清除筛选",
      actionId: "clear-upstream-filters",
    });
    updateBatchToolbar();
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const upstream of filtered) {
    const row = document.createElement("tr");
    row.className = upstream.enabled ? "" : "row-disabled";
    row.dataset.upstreamId = String(upstream.id);
    const remainingBackoff = liveBackoffSeconds(upstream);
    const checked = selectedUpstreamIds.has(upstream.id) ? "checked" : "";
    row.innerHTML = `
      <td class="col-check" data-col="check">
        <input
          type="checkbox"
          class="upstream-row-check"
          data-upstream-check="${upstream.id}"
          aria-label="选择渠道 ${escapeHtml(upstream.name)}"
          ${checked}
        />
      </td>
      <td class="col-id" data-col="id">${upstream.id}</td>
      <td class="name-cell" data-col="name">
        <div class="name-stack">
          <strong title="${escapeHtml(upstream.name)}">${escapeHtml(upstream.name)}</strong>
          <span class="muted">${upstream.api_key_set ? "API Key 已配置" : "使用下游 Authorization"}</span>
        </div>
      </td>
      <td class="url-cell" data-col="base_url">
        ${renderBaseUrlCell(upstream)}
      </td>
      <td class="match-cell" data-col="models">${renderModelMatches(upstream)}</td>
      <td class="col-priority" data-col="priority">
        <button
          type="button"
          class="priority-value"
          data-priority-edit="${upstream.id}"
          aria-label="修改渠道 ${escapeHtml(upstream.name)} 的优先级"
          title="点击修改优先级"
        >${upstream.priority}</button>
        <input
          type="number"
          class="priority-input"
          data-priority-input="${upstream.id}"
          min="0"
          max="100000"
          step="1"
          value="${upstream.priority}"
          aria-label="渠道 ${escapeHtml(upstream.name)} 的优先级"
          hidden
        />
      </td>
      <td class="col-status" data-col="status">
        <div class="status-stack">
          <button
            type="button"
            class="status-switch ${upstream.enabled ? "on" : "off"}"
            data-action="toggle-enabled"
            data-id="${upstream.id}"
            role="switch"
            aria-checked="${upstream.enabled ? "true" : "false"}"
            aria-label="${upstream.enabled ? "停用" : "启用"}渠道 ${escapeHtml(upstream.name)}"
            title="${upstream.enabled ? "点击停用" : "点击启用"}"
          >
            <span class="status-switch-track" aria-hidden="true">
              <span class="status-switch-thumb"></span>
            </span>
          </button>
        </div>
        <span
          class="backoff-note"
          data-backoff-id="${upstream.id}"
          ${remainingBackoff ? "" : "hidden"}
        >${remainingBackoff ? formatBackoffNote(remainingBackoff) : ""}</span>
      </td>
      <td class="row-actions col-actions" data-col="actions">
        <button
          type="button"
          class="secondary action-menu-trigger"
          data-menu-id="${upstream.id}"
          aria-haspopup="menu"
          aria-expanded="false"
          aria-label="打开 ${escapeHtml(upstream.name)} 的操作菜单"
          title="操作"
        ><span aria-hidden="true">⋮</span></button>
      </td>
    `;
    fragment.append(row);
  }

  rows.append(fragment);
  updateBatchToolbar();
  applyAllColumnVisibility();

  if (openMenuId !== null) {
    const replacement = rows.querySelector(`button[data-menu-id="${openMenuId}"]`);
    if (replacement) {
      activeActionMenuButton = replacement;
      replacement.setAttribute("aria-expanded", "true");
      window.requestAnimationFrame(positionUpstreamActionMenu);
    } else {
      closeUpstreamActionMenu();
    }
  }
}

function updateBatchToolbar() {
  const count = selectedUpstreamIds.size;
  if (batchActionsEl) {
    batchActionsEl.hidden = count === 0;
  }
  if (upstreamSelectAll) {
    const filtered = getFilteredUpstreams();
    const filteredIds = filtered.map((item) => item.id);
    const selectedVisible = filteredIds.filter((id) => selectedUpstreamIds.has(id));
    upstreamSelectAll.checked = filteredIds.length > 0 && selectedVisible.length === filteredIds.length;
    upstreamSelectAll.indeterminate = selectedVisible.length > 0 && selectedVisible.length < filteredIds.length;
  }
}

async function batchSetEnabled(enabled) {
  const ids = [...selectedUpstreamIds];
  if (ids.length === 0) return;
  let ok = 0;
  let fail = 0;
  for (const id of ids) {
    try {
      const updated = await api(`/api/admin/upstreams/${id}/enabled`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      const local = upstreams.find((item) => item.id === id);
      if (local) Object.assign(local, updated);
      ok += 1;
    } catch {
      fail += 1;
    }
  }
  selectedUpstreamIds.clear();
  renderRows();
  await loadUpstreams();
  const action = enabled ? "启用" : "停用";
  if (fail === 0) {
    setStatus(`已批量${action} ${ok} 个渠道。`, "ok");
  } else {
    setStatus(`批量${action}完成：成功 ${ok}，失败 ${fail}。`, fail === ids.length ? "error" : "ok");
  }
}

function liveBackoffSeconds(upstream) {
  if (!upstream.backoffUntilMs) {
    return 0;
  }
  return Math.max(0, Math.ceil((upstream.backoffUntilMs - Date.now()) / 1000));
}

function updateBackoffNotes() {
  for (const note of rows.querySelectorAll("[data-backoff-id]")) {
    const upstream = upstreams.find((item) => item.id === Number(note.dataset.backoffId));
    const remaining = upstream ? liveBackoffSeconds(upstream) : 0;
    note.textContent = remaining ? formatBackoffNote(remaining) : "";
    note.hidden = remaining === 0;
  }
  // Partial update only — avoid re-rendering entire upstream table.
  scheduleRenderUpstreamSummary();
}

function actionMenuMarkup(upstreamId) {
  return `
    <button type="button" role="menuitem" data-action="test-model" data-id="${upstreamId}">测试模型</button>
    <button type="button" role="menuitem" data-action="test" data-id="${upstreamId}">测试连接</button>
    <button type="button" role="menuitem" data-action="balance" data-id="${upstreamId}">查询余额</button>
    <button type="button" role="menuitem" data-action="models" data-id="${upstreamId}">拉取模型</button>
    <div class="action-menu-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="edit" data-id="${upstreamId}">编辑</button>
    <button type="button" role="menuitem" data-action="duplicate" data-id="${upstreamId}">复制</button>
    <div class="action-menu-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="delete" data-id="${upstreamId}" class="danger">删除</button>
  `;
}

function openUpstreamActionMenu(button) {
  if (activeActionMenuButton === button && !upstreamActionMenu.hidden) {
    closeUpstreamActionMenu(true);
    return;
  }

  closeUpstreamActionMenu();
  activeActionMenuButton = button;
  button.setAttribute("aria-expanded", "true");
  upstreamActionMenu.innerHTML = actionMenuMarkup(Number(button.dataset.menuId));
  upstreamActionMenu.style.visibility = "hidden";
  showPopoverLayer(upstreamActionMenu, true);
  window.requestAnimationFrame(() => {
    positionUpstreamActionMenu();
    upstreamActionMenu.style.visibility = "visible";
    upstreamActionMenu.querySelector("button[role='menuitem']")?.focus();
  });
}

function closeUpstreamActionMenu(restoreFocus = false) {
  const button = activeActionMenuButton;
  if (button) {
    button.setAttribute("aria-expanded", "false");
  }
  activeActionMenuButton = null;
  upstreamActionMenu.style.visibility = "";
  hidePopoverLayer(upstreamActionMenu);
  if (restoreFocus && button?.isConnected) {
    button.focus();
  }
}

function positionUpstreamActionMenu() {
  if (!activeActionMenuButton || upstreamActionMenu.hidden) {
    return;
  }
  const triggerRect = activeActionMenuButton.getBoundingClientRect();
  const menuRect = upstreamActionMenu.getBoundingClientRect();
  const viewportGap = 8;
  let left = triggerRect.right - menuRect.width;
  let top = triggerRect.bottom + 6;

  if (top + menuRect.height > window.innerHeight - viewportGap) {
    top = triggerRect.top - menuRect.height - 6;
  }
  left = Math.min(Math.max(viewportGap, left), window.innerWidth - menuRect.width - viewportGap);
  top = Math.min(Math.max(viewportGap, top), window.innerHeight - menuRect.height - viewportGap);
  upstreamActionMenu.style.left = `${Math.round(left)}px`;
  upstreamActionMenu.style.top = `${Math.round(top)}px`;
}

async function loadUpstreams() {
  const showSkeleton = !upstreamsLoadedOnce;
  if (showSkeleton) {
    upstreamsLoading = true;
    if (!priorityEditorIsOpen()) {
      renderRows();
    }
  }
  try {
    upstreams = await api("/api/admin/upstreams");
    for (const upstream of upstreams) {
      upstream.backoffUntilMs = upstream.backoff_remaining_seconds
        ? Date.now() + upstream.backoff_remaining_seconds * 1000
        : null;
    }
    upstreamsLoadedOnce = true;
    lastUpstreamLoadError = "";
    if (!priorityEditorIsOpen()) {
      renderRows();
    } else {
      renderUpstreamSummary();
    }
    renderLogFilterOptions();
  } catch (error) {
    const message = `加载失败：${error.message}`;
    if (message !== lastUpstreamLoadError) {
      setStatus(message, "error");
      lastUpstreamLoadError = message;
    }
  } finally {
    upstreamsLoading = false;
  }
}


function priorityEditorIsOpen() {
  return Boolean(rows.querySelector("input[data-priority-input]:not([hidden])"));
}

function startPriorityEdit(button) {
  const activeInput = rows.querySelector("input[data-priority-input]:not([hidden])");
  if (activeInput) {
    activeInput.focus();
    return;
  }
  const cell = button.closest(".col-priority");
  const input = cell?.querySelector("input[data-priority-input]");
  if (!input) {
    return;
  }
  button.hidden = true;
  input.hidden = false;
  input.value = button.textContent.trim();
  input.focus();
  input.select();
}

function cancelPriorityEdit(input) {
  input.dataset.cancelled = "true";
  const button = input.closest(".col-priority")?.querySelector("button[data-priority-edit]");
  input.hidden = true;
  if (button) {
    button.hidden = false;
    button.focus();
  }
}

async function savePriorityEdit(input) {
  if (input.dataset.cancelled === "true") {
    delete input.dataset.cancelled;
    return;
  }
  if (input.dataset.saving === "true") {
    return;
  }

  const id = Number(input.dataset.priorityInput);
  const upstream = upstreams.find((item) => item.id === id);
  if (!upstream) {
    renderRows();
    setStatus("渠道已不存在，请刷新页面后重试。", "error");
    return;
  }

  const nextPriority = Number(input.value);
  if (!Number.isInteger(nextPriority) || nextPriority < 0 || nextPriority > 100000) {
    setStatus("优先级必须是 0 到 100000 之间的整数。", "error");
    input.focus();
    input.select();
    return;
  }
  if (nextPriority === upstream.priority) {
    renderRows();
    return;
  }

  input.dataset.saving = "true";
  input.disabled = true;
  try {
    const updated = await api(`/api/admin/upstreams/${id}/priority`, {
      method: "PATCH",
      body: JSON.stringify({ priority: nextPriority }),
    });
    Object.assign(upstream, updated);
    renderRows();
    await loadUpstreams();
    setStatus(`渠道 ${updated.name} 的优先级已更新为 ${updated.priority}。`, "ok");
  } catch (error) {
    input.disabled = false;
    delete input.dataset.saving;
    setStatus(`修改优先级失败：${error.message}`, "error");
    input.focus();
    input.select();
  }
}

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

  const completionTokens = Number(log.completion_tokens);
  const firstTokenMs = Number(log.first_token_ms);
  if (Number.isFinite(completionTokens) && completionTokens > 0) {
    let generationMs = durationMs;
    if (Number.isFinite(firstTokenMs) && firstTokenMs >= 0 && firstTokenMs < durationMs) {
      generationMs = durationMs - firstTokenMs;
    }
    const generationSeconds = generationMs / 1000;
    if (generationSeconds > 0) {
      const outputRate = completionTokens / generationSeconds;
      const displayRate = outputRate.toFixed(1).replace(/\.0$/, "");
      const usedFirstToken = generationMs !== durationMs;
      return {
        tone: outputRate >= 20 ? "ok" : outputRate >= 8 ? "warn" : "danger",
        basis: usedFirstToken
          ? `按输出吞吐 ${displayRate} t/s 判定`
          : `按全程输出吞吐 ${displayRate} t/s 判定`,
      };
    }
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
  const completionTokens = Number(log.completion_tokens);
  const durationMs = Number(log.duration_ms);
  if (
    !Number.isFinite(completionTokens)
    || completionTokens <= 0
    || !Number.isFinite(durationMs)
    || durationMs <= 0
  ) {
    return "流，-t/s";
  }

  // Prefer generation time after first token; if TTFT is missing/invalid, use full duration.
  const firstTokenMs = Number(log.first_token_ms);
  let generationMs = durationMs;
  if (Number.isFinite(firstTokenMs) && firstTokenMs >= 0 && firstTokenMs < durationMs) {
    generationMs = durationMs - firstTokenMs;
  }
  if (generationMs <= 0) {
    return "流，-t/s";
  }
  const rate = completionTokens / (generationMs / 1000);
  const displayRate = rate.toFixed(1).replace(/\.0$/, "");
  return `流，${displayRate}t/s`;
}

/** Render the server-side count of matching requests during the trailing minute. */
function updateLogRpm(recentRpm) {
  if (logRpm) {
    const count = Number(recentRpm);
    logRpm.textContent = `RPM ${Number.isFinite(count) && count >= 0 ? count : "—"}`;
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
        <span>${formatFirstTokenTime(log.first_token_ms)} / ${formatTotalDurationTime(log)}</span>
        ${throughput ? `<span class="muted">${throughput}</span>` : ""}
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
      offset: String(logOffset),
    });
    if (upstreamId) params.set("upstream_id", upstreamId);
    if (search) params.set("search", search);
    if (status) params.set("status", status);

    const page = await api(`/api/admin/logs?${params}`);
    const items = page.items || [];
    logHasMore = page.has_more;
    logsLoadedOnce = true;
    renderLogRows(items, {
      noMatch: filtersActive && items.length === 0,
      emptyTitle: "暂无请求日志",
      emptyCopy: filtersActive ? "全库中没有符合当前筛选条件的日志。" : "暂无代理请求记录。",
    });
    const loaded = items.length;
    const pageNo = Math.floor(logOffset / LOG_PAGE_SIZE) + 1;
    updateLogRpm(page.recent_rpm);
    logStatusBox.textContent = `${filtersActive ? "全库筛选" : "服务端分页"} · 已加载 ${loaded} 条 · 第 ${pageNo} 页 · 自动刷新 5s`;
    logStatusBox.dataset.tone = "neutral";
    logPrevButton.disabled = logOffset === 0;
    logNextButton.disabled = !logHasMore;
    renderUpstreamSummary();
  } catch (error) {
    updateLogRpm(null);
    logStatusBox.textContent = `加载失败：${error.message}`;
    logStatusBox.dataset.tone = "error";
  } finally {
    logsLoading = false;
  }
}

function getVisibleDialogModels() {
  const filter = modelFilter.value.trim().toLowerCase();
  if (!filter) {
    return modelDialogState.models;
  }
  return modelDialogState.models.filter((model) => model.toLowerCase().includes(filter));
}

function renderModelOptions() {
  const visibleModels = getVisibleDialogModels();
  modelOptions.innerHTML = "";
  modelDialogSummary.textContent = `已选择 ${modelDialogState.selected.size} / ${modelDialogState.models.length}`;

  if (visibleModels.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "没有匹配的模型。";
    modelOptions.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const model of visibleModels) {
    const label = document.createElement("label");
    label.className = "model-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.model = model;
    checkbox.checked = modelDialogState.selected.has(model);

    const text = document.createElement("span");
    text.textContent = model;

    label.append(checkbox, text);
    fragment.append(label);
  }
  modelOptions.append(fragment);
}

function openModelDialog(upstream, models, selectedNames, mode) {
  const currentSelection = uniqueList(selectedNames || upstream.model_names);
  modelDialogState.upstream = upstream;
  modelDialogState.mode = mode;
  modelDialogState.models = uniqueList([...models, ...currentSelection]);
  modelDialogState.selected = new Set(currentSelection);
  modelDialogTitle.textContent = `选择模型：${upstream.name}`;
  modelFilter.value = "";
  renderModelOptions();
  if (typeof modelDialog.showModal === "function") {
    modelDialog.showModal();
  } else {
    modelDialog.setAttribute("open", "");
  }
  modelFilter.focus();
}

function closeModelDialog() {
  if (modelDialog.open && typeof modelDialog.close === "function") {
    modelDialog.close();
  } else {
    modelDialog.removeAttribute("open");
  }
}

async function fetchModelsForUpstream(upstream, mode, button, selectedNames) {
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "拉取中";
  }
  setStatus(`正在拉取 ${upstream.name} 的模型...`);
  try {
    const result = await api(`/api/admin/upstreams/${upstream.id}/models`, { method: "POST" });
    openModelDialog(upstream, result.models, selectedNames, mode);
    setStatus(`已拉取 ${result.models.length} 个模型。`, "ok");
  } catch (error) {
    setStatus(`拉取模型失败：${error.message}`, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function fetchModelsFromForm() {
  const baseUrl = fields.baseUrl.value.trim();
  if (!baseUrl) {
    setStatus("请先填写 Base URL 再拉取模型。", "error");
    return;
  }

  let extraHeaders;
  try {
    extraHeaders = parseHeaderOverrides();
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }

  const draftUpstream = { name: fields.name.value.trim() || baseUrl, model_names: [] };
  const selectedNames = splitList(fields.modelNames.value);
  const enteredApiKey = fields.apiKey.value.trim();
  const previewApiKey = fields.clearApiKey.checked
    ? null
    : enteredApiKey || persistedFormApiKey;
  const originalText = fetchModelsButton.textContent;
  fetchModelsButton.disabled = true;
  fetchModelsButton.textContent = "拉取中";
  setStatus(`正在拉取 ${draftUpstream.name} 的模型...`);
  try {
    const result = await api("/api/admin/upstreams/fetch-models", {
      method: "POST",
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: previewApiKey || null,
        extra_headers: extraHeaders,
        timeout_seconds: Number(fields.timeoutSeconds.value || 300),
      }),
    });
    openModelDialog(draftUpstream, result.models, selectedNames, "form");
    setStatus(`已拉取 ${result.models.length} 个模型。`, "ok");
  } catch (error) {
    setStatus(`拉取模型失败：${error.message}`, "error");
  } finally {
    fetchModelsButton.disabled = false;
    fetchModelsButton.textContent = originalText;
  }
}

async function saveModelSelection() {
  const upstream = modelDialogState.upstream;
  if (!upstream) {
    closeModelDialog();
    return;
  }

  const selectedModels = modelDialogState.models.filter((model) => modelDialogState.selected.has(model));
  if (modelDialogState.mode === "form") {
    fields.modelNames.value = joinList(selectedModels);
    closeModelDialog();
    setStatus(`已选择 ${selectedModels.length} 个模型，保存渠道后生效。`, "ok");
    return;
  }

  const originalText = modelSaveSelectionButton.textContent;
  modelSaveSelectionButton.disabled = true;
  modelSaveSelectionButton.textContent = "保存中";
  try {
    await api(`/api/admin/upstreams/${upstream.id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: upstream.name,
        base_url: upstream.base_url,
        api_key: null,
        model_names: selectedModels,
        model_prefixes: upstream.model_prefixes,
        model_mappings: upstream.model_mappings || {},
        priority: upstream.priority,
        timeout_seconds: upstream.timeout_seconds,
        enabled: upstream.enabled,
        extra_headers: upstream.extra_headers || {},
        clear_api_key: false,
      }),
    });
    if (fields.id.value === String(upstream.id)) {
      fields.modelNames.value = joinList(selectedModels);
    }
    closeModelDialog();
    await loadUpstreams();
    setStatus(`已保存 ${selectedModels.length} 个模型到 ${upstream.name}。`, "ok");
  } catch (error) {
    setStatus(`保存模型失败：${error.message}`, "error");
  } finally {
    modelSaveSelectionButton.disabled = false;
    modelSaveSelectionButton.textContent = originalText;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = payloadFromForm();
    const id = fields.id.value;
    const path = id ? `/api/admin/upstreams/${id}` : "/api/admin/upstreams";
    await api(path, {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    closeUpstreamDialog();
    resetForm();
    await loadUpstreams();
    setStatus("渠道已保存。", "ok");
  } catch (error) {
    setStatus(`保存失败：${error.message}`, "error");
  }
});

async function handleUpstreamAction(button) {
  const id = Number(button.dataset.id);
  const upstream = upstreams.find((item) => item.id === id);
  if (!upstream) {
    setStatus("渠道已不存在，请刷新页面后重试。", "error");
    return;
  }

  if (button.dataset.action === "edit") {
    await editUpstream(upstream);
    return;
  }

  if (button.dataset.action === "test-model") {
    await openModelTestDialog(upstream);
    return;
  }

  if (button.dataset.action === "duplicate") {
    duplicateUpstream(upstream);
    return;
  }

  if (button.dataset.action === "delete") {
    const confirmed = await requestConfirm({
      title: "删除渠道",
      message: `确定删除渠道「${upstream.name}」？删除后可在数秒内撤销。`,
      confirmLabel: "删除渠道",
    });
    if (!confirmed) return;
    try {
      let recreatePayload = null;
      try {
        const detail = await api(`/api/admin/upstreams/${id}`);
        recreatePayload = {
          name: detail.name,
          base_url: detail.base_url,
          api_key: detail.api_key || null,
          model_names: detail.model_names || [],
          model_prefixes: detail.model_prefixes || [],
          model_mappings: detail.model_mappings || {},
          priority: detail.priority,
          timeout_seconds: detail.timeout_seconds,
          enabled: detail.enabled,
          extra_headers: detail.extra_headers || {},
        };
      } catch {
        recreatePayload = null;
      }
      await api(`/api/admin/upstreams/${id}`, { method: "DELETE" });
      selectedUpstreamIds.delete(id);
      await loadUpstreams();
      if (recreatePayload) {
        setStatus(`渠道「${upstream.name}」已删除。`, "ok", {
          durationMs: 9000,
          actionLabel: "撤销",
          onAction: async () => {
            await api("/api/admin/upstreams", {
              method: "POST",
              body: JSON.stringify(recreatePayload),
            });
            await loadUpstreams();
            setStatus(`已恢复渠道「${recreatePayload.name}」。`, "ok");
          },
        });
      } else {
        setStatus("渠道已删除。", "ok");
      }
    } catch (error) {
      setStatus(`删除失败：${error.message}`, "error");
    }
    return;
  }

  if (button.dataset.action === "models") {
    await fetchModelsForUpstream(upstream, "upstream", button, upstream.model_names);
    return;
  }

  if (button.dataset.action === "toggle-enabled") {
    const nextEnabled = !upstream.enabled;
    const originalMarkup = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.classList.add("is-busy");
    try {
      const updated = await api(`/api/admin/upstreams/${id}/enabled`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      if (fields.id.value === String(id)) {
        fields.enabled.checked = updated.enabled;
      }
      Object.assign(upstream, updated);
      renderRows();
      await loadUpstreams();
      setStatus(`渠道 ${updated.name} 已${updated.enabled ? "启用" : "停用"}。`, "ok");
    } catch (error) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.classList.remove("is-busy");
      button.innerHTML = originalMarkup;
      setStatus(`切换渠道状态失败：${error.message}`, "error");
    }
    return;
  }

  if (button.dataset.action === "test") {
    try {
      const result = await api(`/api/admin/upstreams/${id}/test`, {
        method: "POST",
        body: JSON.stringify({ path: "/v1/models" }),
      });
      setStatus(
        result.ok
          ? `测试完成：HTTP ${result.status_code}`
          : `测试失败：${result.message || "无响应"}`,
        result.ok ? "ok" : "error",
      );
    } catch (error) {
      setStatus(`测试失败：${error.message}`, "error");
    }
    return;
  }

  if (button.dataset.action === "balance") {
    await showBalance(upstream);
  }
}

rows.addEventListener("click", async (event) => {
  if (event.target.closest("input[type='checkbox']")) {
    return;
  }

  const emptyAction = event.target.closest("button[data-empty-action]");
  if (emptyAction) {
    const action = emptyAction.dataset.emptyAction;
    if (action === "new-upstream") {
      resetForm();
      openUpstreamDialog();
    } else if (action === "clear-upstream-filters") {
      clearUpstreamFilters();
    }
    return;
  }

  const urlActionButton = event.target.closest("button[data-url-action]");
  if (urlActionButton) {
    await handleBaseUrlAction(urlActionButton);
    return;
  }

  const priorityButton = event.target.closest("button[data-priority-edit]");
  if (priorityButton) {
    startPriorityEdit(priorityButton);
    return;
  }

  const menuButton = event.target.closest("button[data-menu-id]");
  if (menuButton) {
    openUpstreamActionMenu(menuButton);
    return;
  }

  const actionButton = event.target.closest("button[data-action]");
  if (actionButton) {
    await handleUpstreamAction(actionButton);
  }
});

rows.addEventListener("change", (event) => {
  const check = event.target.closest("input[data-upstream-check]");
  if (!check) return;
  const id = Number(check.dataset.upstreamCheck);
  if (!Number.isFinite(id)) return;
  if (check.checked) {
    selectedUpstreamIds.add(id);
  } else {
    selectedUpstreamIds.delete(id);
  }
  updateBatchToolbar();
});

rows.addEventListener("keydown", (event) => {
  const input = event.target.closest("input[data-priority-input]");
  if (!input) {
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    input.blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelPriorityEdit(input);
  }
});

rows.addEventListener("focusout", (event) => {
  const input = event.target.closest("input[data-priority-input]");
  if (input) {
    savePriorityEdit(input);
  }
});

upstreamActionMenu.addEventListener("click", async (event) => {
  const actionButton = event.target.closest("button[data-action]");
  if (!actionButton) {
    return;
  }
  closeUpstreamActionMenu();
  await handleUpstreamAction(actionButton);
});

upstreamActionMenu.addEventListener("keydown", (event) => {
  const items = [...upstreamActionMenu.querySelectorAll("button[role='menuitem']")];
  const currentIndex = items.indexOf(document.activeElement);
  let nextIndex = null;

  if (event.key === "ArrowDown") {
    nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
  } else if (event.key === "ArrowUp") {
    nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = items.length - 1;
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeUpstreamActionMenu(true);
    return;
  }

  if (nextIndex !== null) {
    event.preventDefault();
    items[nextIndex]?.focus();
  }
});

upstreamActionMenu.addEventListener("focusout", () => {
  window.requestAnimationFrame(() => {
    if (
      activeActionMenuButton
      && !upstreamActionMenu.contains(document.activeElement)
      && document.activeElement !== activeActionMenuButton
    ) {
      closeUpstreamActionMenu();
    }
  });
});

document.addEventListener("click", (event) => {
  if (
    activeActionMenuButton
    && !upstreamActionMenu.contains(event.target)
    && !activeActionMenuButton.contains(event.target)
  ) {
    closeUpstreamActionMenu();
  }
  if (
    upstreamColMenu && !upstreamColMenu.hidden
    && !upstreamColMenu.contains(event.target)
    && !upstreamColMenuBtn?.contains(event.target)
  ) {
    closeColMenus();
  }
  if (
    logColMenu && !logColMenu.hidden
    && !logColMenu.contains(event.target)
    && !logColMenuBtn?.contains(event.target)
  ) {
    closeColMenus();
  }
});

window.addEventListener("resize", () => closeUpstreamActionMenu());
window.addEventListener("scroll", () => closeUpstreamActionMenu(), true);

newButton.addEventListener("click", () => {
  resetForm();
  openUpstreamDialog();
});
resetButton.addEventListener("click", cancelUpstreamDialog);
upstreamDialogClose.addEventListener("click", cancelUpstreamDialog);
upstreamDialog.addEventListener("click", (event) => {
  if (event.target === upstreamDialog) {
    cancelUpstreamDialog();
  }
});
quickImportButton.addEventListener("click", openQuickImportDialog);
quickImportClose.addEventListener("click", closeQuickImportDialog);
quickImportCancel.addEventListener("click", closeQuickImportDialog);
quickImportDialog.addEventListener("click", (event) => {
  if (event.target === quickImportDialog) {
    closeQuickImportDialog();
  }
});
quickImportText.addEventListener("input", syncQuickImportFields);
quickImportBaseUrlInput.addEventListener("input", updateQuickImportFillState);
quickImportApiKeyInput.addEventListener("input", updateQuickImportFillState);
quickImportFillButton.addEventListener("click", () => {
  const baseUrl = quickImportBaseUrlInput.value.trim();
  const apiKey = quickImportApiKeyInput.value.trim();
  resetForm();
  if (baseUrl) {
    fields.baseUrl.value = baseUrl;
    const suggestedName = suggestNameFromUrl(baseUrl);
    if (suggestedName) {
      fields.name.value = suggestedName;
    }
  }
  if (apiKey) {
    fields.apiKey.value = apiKey;
  }
  closeQuickImportDialog();
  openUpstreamDialog();
  setStatus("已从快速导入填入 Base URL / API Key，请检查并补充名称等信息后保存。", "ok");
});

fetchModelsButton.addEventListener("click", async () => {
  await fetchModelsFromForm();
});

modelFilter.addEventListener("input", renderModelOptions);
modelOptions.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[type='checkbox'][data-model]");
  if (!checkbox) return;
  if (checkbox.checked) {
    modelDialogState.selected.add(checkbox.dataset.model);
  } else {
    modelDialogState.selected.delete(checkbox.dataset.model);
  }
  renderModelOptions();
});
modelSelectAllButton.addEventListener("click", () => {
  for (const model of getVisibleDialogModels()) {
    modelDialogState.selected.add(model);
  }
  renderModelOptions();
});
modelClearAllButton.addEventListener("click", () => {
  for (const model of getVisibleDialogModels()) {
    modelDialogState.selected.delete(model);
  }
  renderModelOptions();
});
modelSaveSelectionButton.addEventListener("click", saveModelSelection);
modelCancelSelectionButton.addEventListener("click", closeModelDialog);
modelDialogClose.addEventListener("click", closeModelDialog);
modelDialog.addEventListener("click", (event) => {
  if (event.target === modelDialog) {
    closeModelDialog();
  }
});

for (const link of navLinks) {
  link.addEventListener("click", () => switchView(link.dataset.view));
}
window.addEventListener("hashchange", () => switchView(currentViewFromHash()));

logUpstreamFilter.addEventListener("change", () => {
  logOffset = 0;
  loadLogs();
});
if (logSearchInput) {
  logSearchInput.addEventListener("input", debounce(() => {
    logOffset = 0;
    loadLogs();
  }, 150));
}
if (logStatusFilter) {
  logStatusFilter.addEventListener("change", () => {
    logOffset = 0;
    loadLogs();
  });
}
logRefreshButton.addEventListener("click", async () => {
  logRefreshButton.disabled = true;
  logRefreshButton.setAttribute("aria-busy", "true");
  logRefreshButton.textContent = "刷新中";
  try {
    await loadLogs();
  } finally {
    logRefreshButton.disabled = false;
    logRefreshButton.removeAttribute("aria-busy");
    logRefreshButton.textContent = "刷新";
  }
});
logPrevButton.addEventListener("click", () => {
  logOffset = Math.max(0, logOffset - LOG_PAGE_SIZE);
  loadLogs();
});
logNextButton.addEventListener("click", () => {
  logOffset += LOG_PAGE_SIZE;
  loadLogs();
});
logRows.addEventListener("click", (event) => {
  const emptyAction = event.target.closest("button[data-empty-action]");
  if (emptyAction) {
    const action = emptyAction.dataset.emptyAction;
    if (action === "refresh-logs") {
      loadLogs();
    } else if (action === "clear-log-filters") {
      clearLogFilters();
    }
    return;
  }
  const row = event.target.closest("tr[data-log-id]");
  if (!row) return;
  showLogDetail(row.dataset.logId);
});
logRows.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("tr[data-log-id]");
  if (!row) return;
  event.preventDefault();
  showLogDetail(row.dataset.logId);
});
for (const details of logDetailSections) {
  details.addEventListener("toggle", () => {
    if (details.open) {
      renderLogDetailSection(details);
    }
  });
}
for (const button of document.querySelectorAll(".log-detail-expand")) {
  button.addEventListener("click", () => {
    const section = button.closest(".log-detail-section");
    if (!section || !requestDetailGrid) return;

    const willFocus = !section.classList.contains("is-focused");
    for (const otherSection of logDetailSections) {
      otherSection.classList.toggle("is-focused", willFocus && otherSection === section);
    }
    requestDetailGrid.classList.toggle("is-focused", willFocus);
    button.textContent = willFocus ? "退出放大" : "放大查看";
    button.setAttribute("aria-pressed", String(willFocus));
  });
}
logDetailClose.addEventListener("click", closeLogDetailDialog);
logDetailDialog.addEventListener("click", (event) => {
  if (event.target === logDetailDialog) {
    closeLogDetailDialog();
  }
});

balanceClose.addEventListener("click", closeBalanceDialog);
balanceDialog.addEventListener("click", (event) => {
  if (event.target === balanceDialog) {
    closeBalanceDialog();
  }
});

adminTokenDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
});

adminTokenForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = adminTokenInput.value.trim();
  if (!token) {
    showAdminTokenError("请输入 Token。");
    return;
  }
  setAdminToken(token);
  const submitButton = adminTokenForm.querySelector("button[type='submit']");
  submitButton.disabled = true;
  showAdminTokenError("验证中...");
  try {
    await api("/api/admin/upstreams");
    closeAdminTokenDialog();
    initApp();
  } catch (error) {
    if (adminTokenDialog.open) {
      showAdminTokenError(error.message);
    }
  } finally {
    submitButton.disabled = false;
  }
});

adminLogoutButton.addEventListener("click", () => {
  clearAdminToken();
  location.reload();
});

function initApp() {
  applyDensity(getDensity());
  applyAllColumnVisibility();
  renderColumnMenu(
    upstreamColMenu,
    upstreamColumns,
    UPSTREAM_COL_LABELS,
    UPSTREAM_LOCKED_COLS,
    UPSTREAM_COLUMNS_KEY,
    upstreamTable,
  );
  renderColumnMenu(
    logColMenu,
    logColumns,
    LOG_COL_LABELS,
    LOG_LOCKED_COLS,
    LOG_COLUMNS_KEY,
    logTable,
  );
  resetForm();
  switchView(currentViewFromHash());
  if (currentViewFromHash() === "tokens") {
    loadTokens();
  }
  loadUpstreams();
  // Warm log window for health/charts even when not on logs tab.
  if (currentViewFromHash() !== "logs") {
    loadLogs().catch(() => {});
  }
}

// ── 令牌 CRUD ────────────────────────────────────────────────

function startTokenRefresh() {
  if (tokenRefreshTimer !== null || !pageVisible) {
    updateLiveIndicator();
    return;
  }
  tokenRefreshTimer = window.setInterval(loadTokens, DEFAULT_REFRESH_MS);
  updateLiveIndicator();
}

function stopTokenRefresh() {
  if (tokenRefreshTimer === null) {
    updateLiveIndicator();
    return;
  }
  window.clearInterval(tokenRefreshTimer);
  tokenRefreshTimer = null;
  updateLiveIndicator();
}

function renderTokenRows() {
  if (tokensLoading && !tokensLoadedOnce) {
    tokenRows.innerHTML = skeletonRowsMarkup(5, 5);
    return;
  }

  if (tokensLoadedOnce && tokens.length === 0 && !tokenFiltersActive()) {
    tokenRows.innerHTML = emptyStateCell(5, {
      title: "暂无令牌",
      copy: "还没有创建下游 API 访问令牌。",
      actionLabel: "新增令牌",
      actionId: "new-token",
    });
    return;
  }

  const filtered = getFilteredTokens();
  if (tokensLoadedOnce && filtered.length === 0) {
    tokenRows.innerHTML = noMatchStateCell(5, {
      title: "无匹配令牌",
      copy: "当前搜索条件下没有结果。",
      actionLabel: "清除筛选",
      actionId: "clear-token-filters",
    });
    return;
  }

  tokenRows.innerHTML = filtered
    .map(
      (t) => `
    <tr>
      <td><strong>${escapeHtml(t.name)}</strong></td>
      <td class="muted">${escapeHtml(t.description || "—")}</td>
      <td>
        <button
          type="button"
          class="token-preview-button"
          data-token-action="copy"
          data-token-id="${t.id}"
          title="点击复制完整令牌"
          aria-label="复制 ${escapeHtml(t.name)} 的完整令牌"
        ><code class="token-preview-code">${escapeHtml(t.token_preview)}</code></button>
      </td>
      <td class="col-status">
        <button
          type="button"
          class="status-switch ${t.enabled ? "on" : "off"}"
          data-token-action="${t.enabled ? "disable" : "enable"}"
          data-token-id="${t.id}"
          role="switch"
          aria-checked="${t.enabled ? "true" : "false"}"
          aria-label="${t.enabled ? "停用" : "启用"}令牌 ${escapeHtml(t.name)}"
          title="${t.enabled ? "点击停用" : "点击启用"}"
        >
          <span class="status-switch-track" aria-hidden="true">
            <span class="status-switch-thumb"></span>
          </span>
        </button>
      </td>
      <td class="action-cell">
        <button type="button" class="secondary small" data-token-action="edit" data-token-id="${t.id}">编辑</button>
        <button type="button" class="secondary small danger" data-token-action="delete" data-token-id="${t.id}">删除</button>
      </td>
    </tr>`,
    )
    .join("");
}

async function loadTokens() {
  const showSkeleton = !tokensLoadedOnce;
  if (showSkeleton) {
    tokensLoading = true;
    renderTokenRows();
  }
  try {
    tokens = await api("/api/admin/tokens");
    tokensLoadedOnce = true;
    renderTokenRows();
  } catch (error) {
    setStatus(`加载令牌失败：${error.message}`, "error");
  } finally {
    tokensLoading = false;
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the textarea fallback below.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

async function handleBaseUrlAction(button) {
  const baseUrl = button.dataset.baseUrl || "";
  if (button.dataset.urlAction === "copy") {
    try {
      const copied = await copyTextToClipboard(baseUrl);
      if (!copied) throw new Error("clipboard unavailable");
      button.classList.add("is-confirmed");
      window.setTimeout(() => button.classList.remove("is-confirmed"), 1200);
      setStatus("Base URL 已复制。", "ok");
    } catch (error) {
      setStatus(`复制 Base URL 失败：${error.message}`, "error");
    }
    return;
  }

  if (button.dataset.urlAction === "open") {
    const url = normalizeHttpUrl(baseUrl);
    if (!url) {
      setStatus("Base URL 不是可打开的 HTTP 地址。", "error");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function resetTokenForm() {
  tokenIdInput.value = "";
  tokenNameInput.value = "";
  tokenDescriptionInput.value = "";
  tokenCustomInput.value = "";
  tokenCustomRow.hidden = false;
  tokenEnabledCheckbox.checked = true;
  tokenValueRow.hidden = true;
  tokenValueDisplay.textContent = "";
  tokenFormTitle.textContent = "新增令牌";
}

function openTokenDialog(mode = "new") {
  if (mode === "new") {
    resetTokenForm();
  }
  if (typeof tokenDialog.showModal === "function") {
    tokenDialog.showModal();
  } else {
    tokenDialog.setAttribute("open", "");
  }
  tokenNameInput.focus();
}

function closeTokenDialog() {
  if (tokenDialog.open && typeof tokenDialog.close === "function") {
    tokenDialog.close();
  } else {
    tokenDialog.removeAttribute("open");
  }
  resetTokenForm();
}

async function editToken(token) {
  tokenIdInput.value = token.id;
  tokenNameInput.value = token.name;
  tokenDescriptionInput.value = token.description || "";
  tokenCustomInput.value = "";
  tokenCustomRow.hidden = true;
  tokenEnabledCheckbox.checked = token.enabled;
  tokenValueRow.hidden = true;
  tokenFormTitle.textContent = `编辑令牌：${token.name}`;
  openTokenDialog("edit");
}

async function handleTokenAction(button) {
  const id = Number(button.dataset.tokenId);
  const token = tokens.find((t) => t.id === id);
  if (!token && button.dataset.tokenAction !== "delete") {
    setStatus("令牌已不存在，请刷新页面后重试。", "error");
    return;
  }

  if (button.dataset.tokenAction === "edit") {
    await editToken(token);
    return;
  }

  if (button.dataset.tokenAction === "copy") {
    button.disabled = true;
    try {
      const detail = await api(`/api/admin/tokens/${id}`);
      const copied = await copyTextToClipboard(detail.token);
      if (!copied) {
        throw new Error("浏览器拒绝复制，请手动复制。");
      }
      button.classList.add("copied");
      window.setTimeout(() => button.classList.remove("copied"), 1200);
      setStatus(`令牌 ${detail.name} 已复制。`, "ok");
    } catch (error) {
      setStatus(`复制失败：${error.message}`, "error");
    } finally {
      button.disabled = false;
    }
    return;
  }

  if (button.dataset.tokenAction === "enable" || button.dataset.tokenAction === "disable") {
    const nextEnabled = button.dataset.tokenAction === "enable";
    const originalMarkup = button.innerHTML;
    button.disabled = true;
    button.classList.add("is-busy");
    try {
      const updated = await api(`/api/admin/tokens/${id}/enabled`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      Object.assign(token, updated);
      renderTokenRows();
      setStatus(`令牌 ${escapeHtml(updated.name)} 已${updated.enabled ? "启用" : "停用"}。`, "ok");
    } catch (error) {
      button.disabled = false;
      button.classList.remove("is-busy");
      button.innerHTML = originalMarkup;
      setStatus(`切换令牌状态失败：${error.message}`, "error");
    }
    return;
  }

  if (button.dataset.tokenAction === "delete") {
    const name = token ? token.name : String(id);
    const confirmed = await requestConfirm({
      title: "删除令牌",
      message: `确定删除令牌「${name}」？若可读取完整令牌将支持撤销。`,
      confirmLabel: "删除令牌",
    });
    if (!confirmed) return;
    try {
      let recreatePayload = null;
      try {
        const detail = await api(`/api/admin/tokens/${id}`);
        if (detail?.token) {
          recreatePayload = {
            name: detail.name,
            description: detail.description || "",
            token: detail.token,
            enabled: detail.enabled,
          };
        }
      } catch {
        recreatePayload = null;
      }
      await api(`/api/admin/tokens/${id}`, { method: "DELETE" });
      await loadTokens();
      if (recreatePayload) {
        setStatus(`令牌「${name}」已删除。`, "ok", {
          durationMs: 9000,
          actionLabel: "撤销",
          onAction: async () => {
            const created = await api("/api/admin/tokens", {
              method: "POST",
              body: JSON.stringify({
                name: recreatePayload.name,
                description: recreatePayload.description || "",
                token: recreatePayload.token,
              }),
            });
            if (created?.id != null && recreatePayload.enabled === false) {
              await api(`/api/admin/tokens/${created.id}/enabled`, {
                method: "PATCH",
                body: JSON.stringify({ enabled: false }),
              });
            }
            await loadTokens();
            setStatus(`已恢复令牌「${recreatePayload.name}」。`, "ok");
          },
        });
      } else {
        setStatus("令牌已删除。", "ok");
      }
    } catch (error) {
      setStatus(`删除失败：${error.message}`, "error");
    }
    return;
  }
}

// ── Token events ──────────────────────────────────────────

tokenRows.addEventListener("click", (event) => {
  const emptyAction = event.target.closest("button[data-empty-action]");
  if (emptyAction) {
    const action = emptyAction.dataset.emptyAction;
    if (action === "new-token") {
      openTokenDialog("new");
    } else if (action === "clear-token-filters") {
      clearTokenFilters();
    }
    return;
  }
  const button = event.target.closest("button[data-token-action]");
  if (!button) return;
  handleTokenAction(button);
});

tokenDialog.addEventListener("click", (event) => {
  if (event.target === tokenDialog) closeTokenDialog();
});

newTokenButton.addEventListener("click", () => openTokenDialog("new"));

tokenDialogClose.addEventListener("click", closeTokenDialog);
tokenResetButton.addEventListener("click", closeTokenDialog);

copyTokenButton.addEventListener("click", async () => {
  const text = tokenValueDisplay.textContent;
  if (!text) return;
  try {
    const copied = await copyTextToClipboard(text);
    if (!copied) {
      throw new Error("浏览器拒绝复制，请手动复制。");
    }
    copyTokenButton.textContent = "已复制";
    setTimeout(() => { copyTokenButton.textContent = "复制"; }, 2000);
  } catch (error) {
    setStatus(`复制失败：${error.message}`, "error");
  }
});

tokenForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = tokenIdInput.value;
  const payload = {
    name: tokenNameInput.value.trim(),
    description: tokenDescriptionInput.value.trim(),
  };
  if (id) {
    // 编辑时不要 enabled（由单独的 enabled toggle 控制）
    payload.enabled = undefined;
  } else {
    payload.enabled = tokenEnabledCheckbox.checked;
    payload.token = tokenCustomInput.value.trim() || null;
  }

  try {
    let result;
    if (id) {
      result = await api(`/api/admin/tokens/${id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      // 同步 enabled 状态
      if (tokenEnabledCheckbox.checked !== result.enabled) {
        await api(`/api/admin/tokens/${id}/enabled`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: tokenEnabledCheckbox.checked }),
        });
      }
    } else {
      result = await api("/api/admin/tokens", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      // 新建成功后展示完整 token
      tokenValueDisplay.textContent = result.token;
      tokenValueRow.hidden = false;
      tokenIdInput.value = result.id;
      tokenFormTitle.textContent = `令牌已创建：${result.name}`;
      // 不关闭弹窗，让用户复制
      await loadTokens();
      setStatus("令牌已创建。请复制保存。", "ok");
      return;
    }
    closeTokenDialog();
    await loadTokens();
    setStatus("令牌已保存。", "ok");
  } catch (error) {
    setStatus(`保存失败：${error.message}`, "error");
  }
});

if (getAdminToken()) {
  initApp();
} else {
  openAdminTokenDialog();
}


// ── Theme toggle (dark default / light) ───────────────────
const THEME_KEY = "wildtoken_theme";
const themeToggle = document.querySelector("#theme-toggle");

function getStoredTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore quota / private mode */
  }
  if (themeToggle) {
    const toLight = next === "dark";
    themeToggle.setAttribute("aria-label", toLight ? "切换到浅色主题" : "切换到深色主题");
    themeToggle.title = toLight ? "切换到浅色" : "切换到深色";
  }
  if (typeof updatePreferenceControls === "function") updatePreferenceControls();
}

function cycleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || getStoredTheme();
  applyTheme(current === "dark" ? "light" : "dark");
}

applyTheme(getStoredTheme());
if (themeToggle) {
  themeToggle.addEventListener("click", cycleTheme);
}

// ── Density toggle ───────────────────────────────────────
applyDensity(getDensity());
if (densityToggle) {
  densityToggle.addEventListener("click", cycleDensity);
}

settingsTheme?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-theme-choice]");
  if (!button) return;
  applyTheme(button.dataset.themeChoice);
  updatePreferenceControls();
});
settingsDensity?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-density-choice]");
  if (!button) return;
  applyDensity(button.dataset.densityChoice);
  updatePreferenceControls();
});
settingsLogRefresh?.addEventListener("change", () => {
  try { localStorage.setItem(LOG_REFRESH_KEY, settingsLogRefresh.value); } catch { /* ignore */ }
  stopLogRefresh();
  if (currentViewFromHash() === "logs") startLogRefresh();
});
settingsDefaultHome?.addEventListener("change", () => {
  try { localStorage.setItem(DEFAULT_HOME_KEY, settingsDefaultHome.value); } catch { /* ignore */ }
});
serverSettingsForm?.addEventListener("submit", saveServerSettings);
newModelTestTemplateButton?.addEventListener("click", () => openModelTestTemplateDialog());
modelTestTemplateList?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-model-template-action]");
  if (!button) return;
  const template = modelTestTemplates.find((item) => item.id === Number(button.dataset.templateId));
  if (!template) return;
  if (button.dataset.modelTemplateAction === "edit") {
    openModelTestTemplateDialog(template);
    return;
  }
  const confirmed = await requestConfirm({ title: "删除测试模板", message: `确定删除模板「${template.name}」？`, confirmLabel: "删除模板", danger: true });
  if (!confirmed) return;
  try {
    await api(`/api/admin/settings/model-test-templates/${template.id}`, { method: "DELETE" });
    modelTestTemplates = modelTestTemplates.filter((item) => item.id !== template.id);
    renderModelTestTemplates();
    setStatus("测试模板已删除。", "ok");
  } catch (error) {
    setStatus(`删除模板失败：${error.message}`, "error");
  }
});
modelTestTemplateForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = modelTestTemplateId.value;
  const payload = {
    name: modelTestTemplateName.value.trim(),
    request_kind: modelTestTemplateKind.value,
    prompt: modelTestTemplatePrompt.value.trim(),
  };
  try {
    const saved = await api(id ? `/api/admin/settings/model-test-templates/${id}` : "/api/admin/settings/model-test-templates", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    });
    modelTestTemplates = id
      ? modelTestTemplates.map((item) => item.id === saved.id ? saved : item)
      : [...modelTestTemplates, saved];
    renderModelTestTemplates();
    closeModelTestTemplateDialog();
    setStatus("测试模板已保存。", "ok");
  } catch (error) {
    setStatus(`保存模板失败：${error.message}`, "error");
  }
});
modelTestTemplateClose?.addEventListener("click", closeModelTestTemplateDialog);
modelTestTemplateCancel?.addEventListener("click", closeModelTestTemplateDialog);
modelTestTemplateDialog?.addEventListener("click", (event) => {
  if (event.target === modelTestTemplateDialog) closeModelTestTemplateDialog();
});
modelTestTemplate?.addEventListener("change", updateModelTestTemplateHint);
modelTestPromptTemplate?.addEventListener("change", updateModelTestTemplateHint);
modelTestClose?.addEventListener("click", closeModelTestDialog);
modelTestRefreshModels?.addEventListener("click", refreshModelTestModels);
modelTestForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!modelTestUpstream) return;
  modelTestSubmit.disabled = true;
  modelTestSubmit.textContent = "测试中";
  modelTestResult.hidden = true;
  try {
    const result = await api(`/api/admin/upstreams/${modelTestUpstream.id}/test-model`, {
      method: "POST",
      body: JSON.stringify({ model: modelTestModel.value, wrapper_id: Number(modelTestTemplate.value), prompt_template_id: Number(modelTestPromptTemplate.value), prompt: modelTestPrompt.value.trim() }),
    });
    modelTestResult.hidden = false;
    modelTestResultStatus.textContent = result.ok ? `测试成功 · HTTP ${result.status_code}` : `测试失败${result.status_code ? ` · HTTP ${result.status_code}` : ""}`;
    modelTestResultMeta.textContent = result.content_type || "";
    modelTestPrompt.value = result.prompt || modelTestPrompt.value;
    modelTestResultBody.textContent = result.reply || result.preview || result.message || "渠道未返回正文。";
    modelTestRequestBody.textContent = formatHttpRequest(result.request || { url: "http://invalid/", headers: {}, body: {} });
    modelTestResponseBody.textContent = formatHttpResponse(result);
  } catch (error) {
    modelTestResult.hidden = false;
    modelTestResultStatus.textContent = "测试失败";
    modelTestResultMeta.textContent = "";
    modelTestResultBody.textContent = error.message;
    modelTestRequestBody.textContent = "";
    modelTestResponseBody.textContent = "";
  } finally {
    modelTestSubmit.disabled = false;
    modelTestSubmit.textContent = "发送测试";
  }
});
systemRefreshButton?.addEventListener("click", async () => {
  systemRefreshButton.disabled = true;
  try { await loadSettingsPage(); } finally { systemRefreshButton.disabled = false; }
});
rotateAdminTokenButton?.addEventListener("click", rotateAdminToken);
rotatedTokenCopy?.addEventListener("click", async () => {
  const copied = await copyTextToClipboard(rotatedTokenValue.textContent);
  if (copied) {
    rotatedTokenCopy.textContent = "已复制";
    window.setTimeout(() => { rotatedTokenCopy.textContent = "复制"; }, 1800);
  } else {
    setStatus("浏览器拒绝复制，请手动复制后再退出。", "error");
  }
});
rotatedTokenLogout?.addEventListener("click", () => {
  rotatedTokenValue.textContent = "";
  clearAdminToken();
  location.reload();
});
rotatedTokenDialog?.addEventListener("cancel", (event) => event.preventDefault());
rotatedTokenDialog?.addEventListener("click", (event) => {
  if (event.target === rotatedTokenDialog) event.preventDefault();
});

// ── Dashboard controls ───────────────────────────────────
if (dashboardRefreshButton) {
  dashboardRefreshButton.addEventListener("click", () => {
    loadDashboardData();
  });
}
if (dashboardErrorRows) {
  dashboardErrorRows.addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-log-id]");
    if (!row) return;
    showLogDetail(row.dataset.logId);
  });
  dashboardErrorRows.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("tr[data-log-id]");
    if (!row) return;
    event.preventDefault();
    showLogDetail(row.dataset.logId);
  });
}

// ── Column menus ─────────────────────────────────────────
if (upstreamColMenuBtn) {
  upstreamColMenuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleColMenu(upstreamColMenu, upstreamColMenuBtn);
  });
}
if (logColMenuBtn) {
  logColMenuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleColMenu(logColMenu, logColMenuBtn);
  });
}
applyAllColumnVisibility();
updateUpstreamSortControls();
upstreamTable?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-upstream-sort]");
  if (button) setUpstreamSort(button.dataset.upstreamSort);
});

// ── Batch enable/disable ─────────────────────────────────
if (upstreamSelectAll) {
  upstreamSelectAll.addEventListener("change", () => {
    const filtered = getFilteredUpstreams();
    if (upstreamSelectAll.checked) {
      for (const item of filtered) {
        selectedUpstreamIds.add(item.id);
      }
    } else {
      for (const item of filtered) {
        selectedUpstreamIds.delete(item.id);
      }
    }
    // Sync visible checkboxes without full re-render when possible
    for (const input of rows.querySelectorAll("input[data-upstream-check]")) {
      const id = Number(input.dataset.upstreamCheck);
      input.checked = selectedUpstreamIds.has(id);
    }
    updateBatchToolbar();
  });
}
if (batchEnableBtn) {
  batchEnableBtn.addEventListener("click", () => batchSetEnabled(true));
}
if (batchDisableBtn) {
  batchDisableBtn.addEventListener("click", () => batchSetEnabled(false));
}

// ── Page Visibility smart polling ────────────────────────
document.addEventListener("visibilitychange", () => {
  pageVisible = document.visibilityState !== "hidden";
  if (pageVisible) {
    resumeAutoRefreshForCurrentView();
    refreshCurrentView();
  } else {
    pauseAllAutoRefresh();
  }
});

// ── Filters: upstreams / tokens ───────────────────────────
if (upstreamSearchInput) {
  upstreamSearchInput.addEventListener(
    "input",
    debounce(() => {
      upstreamSearchQuery = upstreamSearchInput.value || "";
      if (!priorityEditorIsOpen()) {
        renderRows();
      }
    }, 150),
  );
}
if (upstreamStatusFilter) {
  upstreamStatusFilter.addEventListener("change", () => {
    upstreamStatusFilterValue = upstreamStatusFilter.value || "";
    if (!priorityEditorIsOpen()) {
      renderRows();
    }
  });
}
if (tokenSearchInput) {
  tokenSearchInput.addEventListener(
    "input",
    debounce(() => {
      tokenSearchQuery = tokenSearchInput.value || "";
      renderTokenRows();
    }, 150),
  );
}

// ── Command palette + keyboard shortcuts ─────────────────
let commandPaletteActiveIndex = 0;
let commandPaletteVisible = [];

function commandDefinitions() {
  return [
    {
      id: "view-dashboard",
      title: "切换到看板",
      subtitle: "查看运营概览与近窗指标",
      keys: "G D",
      run: () => switchView("dashboard"),
    },
    {
      id: "view-upstreams",
      title: "切换到渠道",
      subtitle: "查看与管理上游渠道",
      keys: "G C",
      run: () => switchView("upstreams"),
    },
    {
      id: "view-logs",
      title: "切换到日志",
      subtitle: "查看代理请求日志",
      keys: "G L",
      run: () => switchView("logs"),
    },
    {
      id: "view-tokens",
      title: "切换到令牌",
      subtitle: "管理下游 API 令牌",
      keys: "G T",
      run: () => switchView("tokens"),
    },
    {
      id: "view-settings",
      title: "切换到设置",
      subtitle: "管理控制台偏好与网关策略",
      keys: "G S",
      run: () => switchView("settings"),
    },
    {
      id: "refresh-dashboard",
      title: "刷新看板",
      subtitle: "重新加载近窗日志与渠道快照",
      keys: "",
      run: () => {
        switchView("dashboard");
        loadDashboardData();
      },
    },
    {
      id: "new-upstream",
      title: "新增渠道",
      subtitle: "打开渠道创建表单",
      keys: "N",
      run: () => {
        switchView("upstreams");
        resetForm();
        openUpstreamDialog();
      },
    },
    {
      id: "new-token",
      title: "新增令牌",
      subtitle: "打开令牌创建表单",
      keys: "N",
      run: () => {
        switchView("tokens");
        openTokenDialog("new");
      },
    },
    {
      id: "refresh",
      title: "刷新当前视图",
      subtitle: "重新加载当前页数据",
      keys: "R",
      run: () => refreshCurrentView(),
    },
    {
      id: "theme",
      title: "切换主题",
      subtitle: "深色 / 浅色",
      keys: "",
      run: () => cycleTheme(),
    },
    {
      id: "density",
      title: "切换密度",
      subtitle: "舒适 / 紧凑",
      keys: "",
      run: () => cycleDensity(),
    },
    {
      id: "focus-search",
      title: "聚焦搜索",
      subtitle: "跳到当前视图搜索框",
      keys: "/",
      run: () => focusCurrentSearch(),
    },
    {
      id: "logout",
      title: "退出登录",
      subtitle: "清除 Admin Token 并刷新",
      keys: "",
      run: () => {
        clearAdminToken();
        location.reload();
      },
    },
  ];
}

function renderCommandPaletteList(query = "") {
  if (!commandPaletteList) return;
  const q = query.trim().toLowerCase();
  commandPaletteVisible = commandDefinitions().filter((cmd) => {
    if (!q) return true;
    return `${cmd.title} ${cmd.subtitle} ${cmd.id}`.toLowerCase().includes(q);
  });
  if (commandPaletteActiveIndex >= commandPaletteVisible.length) {
    commandPaletteActiveIndex = Math.max(0, commandPaletteVisible.length - 1);
  }
  if (commandPaletteVisible.length === 0) {
    commandPaletteList.innerHTML = `<div class="command-palette-empty">无匹配命令</div>`;
    return;
  }
  commandPaletteList.innerHTML = commandPaletteVisible
    .map((cmd, index) => `
      <button
        type="button"
        class="command-palette-item${index === commandPaletteActiveIndex ? " is-active" : ""}"
        role="option"
        data-command-id="${escapeHtml(cmd.id)}"
        aria-selected="${index === commandPaletteActiveIndex}"
      >
        <span class="command-palette-item-title">${escapeHtml(cmd.title)}</span>
        ${cmd.keys ? `<span class="command-palette-item-keys">${escapeHtml(cmd.keys)}</span>` : "<span></span>"}
        <span class="command-palette-item-subtitle">${escapeHtml(cmd.subtitle)}</span>
      </button>
    `)
    .join("");
}

function openCommandPalette() {
  if (!commandPalette) return;
  commandPaletteActiveIndex = 0;
  if (commandPaletteInput) {
    commandPaletteInput.value = "";
  }
  renderCommandPaletteList("");
  if (typeof commandPalette.showModal === "function") {
    if (!commandPalette.open) {
      commandPalette.showModal();
    }
  } else {
    commandPalette.setAttribute("open", "");
  }
  commandPaletteInput?.focus();
}

function closeCommandPalette() {
  if (!commandPalette) return;
  if (commandPalette.open && typeof commandPalette.close === "function") {
    commandPalette.close();
  } else {
    commandPalette.removeAttribute("open");
  }
}

function runCommandById(id) {
  const cmd = commandDefinitions().find((item) => item.id === id);
  if (!cmd) return;
  closeCommandPalette();
  cmd.run();
}

function runActiveCommand() {
  const cmd = commandPaletteVisible[commandPaletteActiveIndex];
  if (!cmd) return;
  runCommandById(cmd.id);
}

if (commandPaletteList) {
  commandPaletteList.addEventListener("click", (event) => {
    const item = event.target.closest("[data-command-id]");
    if (!item) return;
    runCommandById(item.dataset.commandId);
  });
}
if (commandPaletteInput) {
  commandPaletteInput.addEventListener("input", () => {
    commandPaletteActiveIndex = 0;
    renderCommandPaletteList(commandPaletteInput.value);
  });
  commandPaletteInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!commandPaletteVisible.length) return;
      commandPaletteActiveIndex = (commandPaletteActiveIndex + 1) % commandPaletteVisible.length;
      renderCommandPaletteList(commandPaletteInput.value);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!commandPaletteVisible.length) return;
      commandPaletteActiveIndex =
        (commandPaletteActiveIndex - 1 + commandPaletteVisible.length) % commandPaletteVisible.length;
      renderCommandPaletteList(commandPaletteInput.value);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runActiveCommand();
    }
  });
}
if (commandPalette) {
  commandPalette.addEventListener("click", (event) => {
    if (event.target === commandPalette) {
      closeCommandPalette();
    }
  });
  commandPalette.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeCommandPalette();
  });
}

document.addEventListener("keydown", (event) => {
  const key = event.key;
  const meta = event.metaKey || event.ctrlKey;
  const target = event.target;

  if (meta && (key === "k" || key === "K")) {
    event.preventDefault();
    if (commandPalette?.open) {
      closeCommandPalette();
    } else {
      openCommandPalette();
    }
    return;
  }

  if (key === "Escape") {
    if (commandPalette?.open) {
      event.preventDefault();
      closeCommandPalette();
      return;
    }
    if (rotatedTokenDialog?.open) {
      event.preventDefault();
      return;
    }
    const top = topOpenDialog();
    if (top) {
      const closed = closeDialogElement(top);
      if (closed) {
        event.preventDefault();
      }
      return;
    }
    if (activeActionMenuButton && !upstreamActionMenu.hidden) {
      event.preventDefault();
      closeUpstreamActionMenu(true);
    }
    return;
  }

  if (commandPalette?.open) {
    return;
  }

  if (isEditableTarget(target) || openDialogs().length > 0) {
    return;
  }

  if (key === "/") {
    event.preventDefault();
    focusCurrentSearch();
    return;
  }

  if (key === "n" || key === "N") {
    const view = currentViewName();
    if (view === "tokens") {
      event.preventDefault();
      openTokenDialog("new");
    } else if (view === "upstreams") {
      event.preventDefault();
      resetForm();
      openUpstreamDialog();
    }
  }
});
