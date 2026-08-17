// Shared DOM references, mutable view state, and cross-view utilities.
const ADMIN_TOKEN_KEY = "wildtoken_admin_token";
const adminTokenDialog = document.querySelector("#admin-token-dialog");
const adminTokenForm = document.querySelector("#admin-token-form");
const adminTokenInput = document.querySelector("#admin-token-input");
const adminTokenError = document.querySelector("#admin-token-error");
const adminLogoutButton = document.querySelector("#admin-logout");

// A click on a native dialog backdrop is reported after the pointer is released.
// Remember where the gesture began so a text selection that ends outside the
// window cannot be mistaken for a backdrop click and dismiss the dialog.
function dismissOnBackdropClick(dialog, dismiss) {
  let beganOnBackdrop = false;

  dialog?.addEventListener("pointerdown", (event) => {
    beganOnBackdrop = event.button === 0 && event.target === dialog;
  });
  dialog?.addEventListener("pointercancel", () => {
    beganOnBackdrop = false;
  });
  dialog?.addEventListener("click", (event) => {
    const shouldDismiss = beganOnBackdrop && event.target === dialog;
    beganOnBackdrop = false;
    if (shouldDismiss) dismiss();
  });
}

const balanceDialog = document.querySelector("#balance-dialog");
const balanceTitle = document.querySelector("#balance-title");
const balanceSummary = document.querySelector("#balance-summary");
const balanceBody = document.querySelector("#balance-body");
const balanceRefresh = document.querySelector("#balance-refresh");
const balanceClose = document.querySelector("#balance-close");
let activeBalanceQuery = null;
let balanceQueryToken = 0;

const toastRegion = document.querySelector("#toast-region");
const selectPanel = document.querySelector("#select-panel");
const upstreamActionMenu = document.querySelector("#upstream-action-menu");
const rows = document.querySelector("#upstream-rows");
const upstreamSummary = document.querySelector("#upstream-summary");
const upstreamCardsContainer = document.querySelector("#upstream-cards");
const viewGridBtn = document.querySelector("#upstream-view-grid");
const viewListBtn = document.querySelector("#upstream-view-list");
const upstreamTableWrap = document.querySelector(".view[data-view='upstreams'] .table-wrap");
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
const QUICK_IMPORT_DEFAULT_PRIORITY = 999;
const QUICK_IMPORT_FILL_LABEL = "填入并拉取模型";
let quickImportFetchController = null;

const channelExportButton = document.querySelector("#channel-export");
const channelExportDialog = document.querySelector("#channel-export-dialog");
const channelExportClose = document.querySelector("#channel-export-close");
const channelExportCancel = document.querySelector("#channel-export-cancel");
const channelExportConfirm = document.querySelector("#channel-export-confirm");
const channelExportScopeEl = document.querySelector("#channel-export-scope");
const channelExportIncludeKeys = document.querySelector("#channel-export-include-keys");

const channelImportButton = document.querySelector("#channel-import");
const channelImportDialog = document.querySelector("#channel-import-dialog");
const channelImportClose = document.querySelector("#channel-import-close");
const channelImportCancel = document.querySelector("#channel-import-cancel");
const channelImportConfirm = document.querySelector("#channel-import-confirm");
const channelImportFile = document.querySelector("#channel-import-file");
const channelImportText = document.querySelector("#channel-import-text");
const channelImportPreview = document.querySelector("#channel-import-preview");
const CHANNEL_DOCUMENT_KIND = "wildtoken.channels";
const CHANNEL_DOCUMENT_VERSION = 1;
const CHANNEL_IMPORT_MAX_ENTRIES = 500;
// Mirrors the server's request body limit so an oversized paste fails locally
// with a readable message instead of a bare HTTP 413.
const CHANNEL_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
let channelImportParsed = null;

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

/** The console's timestamp fields, as plain numbers, for a given instant. */
function consoleZoneFields(timestamp) {
  const parts = logTimeFormatter.formatToParts(new Date(timestamp));
  const field = (type) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
  };
}

/**
 * Read a wall-clock time in LOG_TIME_ZONE back into a UTC timestamp.
 *
 * The console renders every time in that one zone rather than the browser's,
 * so a time typed into a form has to be read in it too — otherwise what the
 * operator types and what the table shows back differ by the zone's offset.
 *
 * Two passes: the first offset is sampled at the wrong instant, the second at
 * one already within an hour of the answer.
 */
function consoleWallClockToTimestamp(year, month, day, hour, minute, second) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetAt = (timestamp) => {
    const zoned = consoleZoneFields(timestamp);
    return (
      Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second) -
      timestamp
    );
  };
  return naive - offsetAt(naive - offsetAt(naive));
}

/** Format an instant the way the database stores it: UTC, no offset suffix. */
function toStoredTimestamp(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 19).replace("T", " ");
}

// A modal <dialog> is promoted to the top layer and the rest of the document
// goes inert behind it, so a scratch node parked on <body> can never hold a
// selection and execCommand finds nothing to copy. Hand the fallback the
// topmost modal instead. This is the common path, not the rare one: the async
// Clipboard API is gated on secure contexts, and this console is usually
// reached over plain http on a LAN address.
function clipboardScratchHost() {
  let openModals;
  try {
    openModals = document.querySelectorAll("dialog[open]:modal");
  } catch {
    openModals = document.querySelectorAll("dialog[open]");
  }
  return openModals[openModals.length - 1] || document.body;
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

  const previouslyFocused = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  clipboardScratchHost().append(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  textarea.remove();
  // Removing the scratch node drops focus to the document; put it back so the
  // caller's button keeps the keyboard.
  previouslyFocused?.focus?.({ preventScroll: true });
  return copied;
}


const logRpm = document.querySelector("#log-rpm");
const logRows = document.querySelector("#log-rows");
const logUpstreamFilter = document.querySelector("#log-upstream-filter");
const logSearchInput = document.querySelector("#log-search");
const logStatusFilter = document.querySelector("#log-status-filter");
const logClientFilter = document.querySelector("#log-client-filter");
const logSensitiveToggle = document.querySelector("#log-sensitive-toggle");
const logRefreshButton = document.querySelector("#log-refresh");
const logNewEntriesNotice = document.querySelector("#log-new-entries-notice");
const logNewEntriesButton = document.querySelector("#log-return-latest");
const logFirstButton = document.querySelector("#log-first");
const logPrevButton = document.querySelector("#log-prev");
const logNextButton = document.querySelector("#log-next");
const logPageMeta = document.querySelector("#log-page-meta");
const logPageSizeSelect = document.querySelector("#log-page-size");
const logDetailDialog = document.querySelector("#log-detail-dialog");
const logDetailTitle = document.querySelector("#log-detail-title");
const logDetailSummary = document.querySelector("#log-detail-summary");
const logDetailMeta = document.querySelector("#log-detail-meta");
const logDetailClose = document.querySelector("#log-detail-close");
const logDetailSections = document.querySelectorAll(".log-detail-section");
const requestDetailGrid = document.querySelector(".request-detail-grid");
let currentLogDetail = null;
const LOG_PAGE_SIZE_KEY = "wildtoken_log_page_size";
const LOG_PAGE_SIZE_VALUES = new Set([20, 50, 100, 200]);
const LOG_REFRESH_KEY = "wildtoken_log_refresh_seconds";
const DEFAULT_HOME_KEY = "wildtoken_default_home";
const DEFAULT_REFRESH_MS = 10000;
const DASHBOARD_REFRESH_MS = 15000;
const DASHBOARD_LOG_LIMIT = 200;
const DASHBOARD_TOP_LIMIT = 10;
// Legacy key, read once so an existing ranking-period preference carries over.
const DASHBOARD_TOP_WINDOW_KEY = "wildtoken_dashboard_top_window";
const DASHBOARD_RANGE_KEY = "wildtoken_dashboard_range";
const DASHBOARD_CUSTOM_RANGE_KEY = "wildtoken_dashboard_custom_range";
// "default" is the multi-window comparison; the rest are single windows. Must
// stay in step with DashboardRange::from_query on the server.
const DASHBOARD_RANGE_VALUES = new Set([
  "today",
  "1d",
  "3d",
  "7d",
  "30d",
  "all",
  "default",
  "custom",
]);
const DASHBOARD_DEFAULT_RANGE = "30d";
const DASHBOARD_MAX_CUSTOM_RANGE_DAYS = 366;
const DASHBOARD_CHANNEL_NAME_HIDDEN_KEY = "wildtoken_dashboard_channel_name_hidden";

function isDashboardDateValue(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
const DENSITY_KEY = "wildtoken_density";
const LOG_COLUMNS_KEY = "wildtoken_log_columns";
const UPSTREAM_COLUMNS_KEY = "wildtoken_upstream_columns";
const LOG_SENSITIVE_HIDDEN_KEY = "wildtoken_log_sensitive_hidden";
function readStoredLogPageSize() {
  try {
    const value = Number(localStorage.getItem(LOG_PAGE_SIZE_KEY));
    if (LOG_PAGE_SIZE_VALUES.has(value)) return value;
  } catch {
    /* ignore quota / private mode */
  }
  return 50;
}
let logPageSize = readStoredLogPageSize();
if (logPageSizeSelect) {
  logPageSizeSelect.value = String(logPageSize);
}
let logOffset = 0;
let logHasMore = false;
let logCursorStack = [];
let logCurrentCursor = null;
let logNextCursor = null;
let logRefreshTimer = null;
let logsLoadedOnce = false;
let logsLoading = false;
let logSensitiveHidden = (() => {
  try {
    return localStorage.getItem(LOG_SENSITIVE_HIDDEN_KEY) !== "false";
  } catch {
    return true;
  }
})();

let dashboardLogItems = [];
let dashboardTokenUsage = null;
let dashboardRuntimeMetrics = null;
let dashboardTopStats = null;
// 按所选时间范围的服务端聚合（KPI 卡、状态分布、延迟趋势的数据源）。
let dashboardOverview = null;
// One range drives the token cards, the request cards, and the Top rankings.
let dashboardTimeRange = (() => {
  try {
    const saved = localStorage.getItem(DASHBOARD_RANGE_KEY)
      // Migrate the old ranking-only preference; its values are all still valid.
      || localStorage.getItem(DASHBOARD_TOP_WINDOW_KEY);
    return DASHBOARD_RANGE_VALUES.has(saved) ? saved : DASHBOARD_DEFAULT_RANGE;
  } catch {
    return DASHBOARD_DEFAULT_RANGE;
  }
})();
let dashboardCustomStartDate = null;
let dashboardCustomEndDate = null;
(() => {
  try {
    const saved = localStorage.getItem(DASHBOARD_CUSTOM_RANGE_KEY);
    if (!saved) return;
    const [start, end] = saved.split("~");
    if (isDashboardDateValue(start) && isDashboardDateValue(end) && start <= end) {
      dashboardCustomStartDate = start;
      dashboardCustomEndDate = end;
    }
  } catch {
    // A missing custom range just leaves the pickers empty.
  }
})();
// A stored "custom" needs its dates; without them fall back to a preset so the
// dashboard never opens in a state it cannot query.
if (dashboardTimeRange === "custom" && !(dashboardCustomStartDate && dashboardCustomEndDate)) {
  dashboardTimeRange = DASHBOARD_DEFAULT_RANGE;
}
let dashboardRefreshTimer = null;
let dashboardLoading = false;
let lastDashboardLoadError = "";

const dashboardPanel = document.querySelector(".dashboard-panel");
const dashboardScope = document.querySelector("#dashboard-scope");
const dashboardKpis = document.querySelector("#dashboard-kpis");
const dashboardTokenKpis = document.querySelector("#dashboard-token-kpis");
const dashboardRequestKpis = document.querySelector("#dashboard-request-kpis");
const dashboardRuntimeKpis = document.querySelector("#dashboard-runtime-kpis");
const dashboardStatusChart = document.querySelector("#dashboard-status-chart");
const dashboardStatusMeta = document.querySelector("#dashboard-status-meta");
const dashboardLatencyChart = document.querySelector("#dashboard-latency-chart");
const dashboardLatencyMeta = document.querySelector("#dashboard-latency-meta");
const dashboardTopModels = document.querySelector("#dashboard-top-models");
const dashboardModelsMeta = document.querySelector("#dashboard-models-meta");
const dashboardTopModelTokens = document.querySelector("#dashboard-top-model-tokens");
const dashboardModelTokensMeta = document.querySelector("#dashboard-model-tokens-meta");
const dashboardTopChannels = document.querySelector("#dashboard-top-channels");
const dashboardChannelsMeta = document.querySelector("#dashboard-channels-meta");
const dashboardTopChannelTokens = document.querySelector("#dashboard-top-channel-tokens");
const dashboardChannelTokensMeta = document.querySelector("#dashboard-channel-tokens-meta");
const dashboardChannelNameToggle = document.querySelector("#dashboard-channel-name-toggle");
const dashboardErrorRows = document.querySelector("#dashboard-error-rows");
const dashboardTokenRangeMeta = document.querySelector("#dashboard-token-range");
const dashboardSelectedRangeMeta = document.querySelector("#dashboard-selected-range");
const dashboardTimePreset = document.querySelector("#dashboard-time-preset");
const dashboardCustomRange = document.querySelector("#dashboard-custom-range");
const dashboardStartDate = document.querySelector("#dashboard-start-date");
const dashboardEndDate = document.querySelector("#dashboard-end-date");
const dashboardApplyCustom = document.querySelector("#dashboard-apply-custom");

// Reflect the restored range in the control before the first paint, so the
// dropdown, the label, and the query all agree from the start.
if (dashboardTimePreset) {
  dashboardTimePreset.value = dashboardTimeRange;
}
if (dashboardStartDate && dashboardCustomStartDate) {
  dashboardStartDate.value = dashboardCustomStartDate;
}
if (dashboardEndDate && dashboardCustomEndDate) {
  dashboardEndDate.value = dashboardCustomEndDate;
}
if (dashboardCustomRange) {
  dashboardCustomRange.hidden = dashboardTimeRange !== "custom";
}

let dashboardChannelNameHidden = (() => {
  try {
    return localStorage.getItem(DASHBOARD_CHANNEL_NAME_HIDDEN_KEY) === "true";
  } catch {
    return false;
  }
})();

let upstreamRefreshTimer = null;
let upstreamsLoadedOnce = false;
let upstreamsLoading = false;
let upstreamSearchQuery = "";
let upstreamStatusFilterValue = "";
let upstreamSearchTimer = null;

const EFFECTIVE_WEIGHT_TICK_MS = 1000;
const MAX_MODEL_CHIPS = 5;
let effectiveWeightTickTimer = null;
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
const routingSettingsForm = document.querySelector("#routing-settings-form");
const settingsMaxRetries = document.querySelector("#settings-max-retries");
const settingsSameUpstreamRetryMs = document.querySelector("#settings-same-upstream-retry-ms");
const settingsFailurePenalty = document.querySelector("#settings-failure-penalty");
const settingsSuccessIncrement = document.querySelector("#settings-success-increment");
const settingsRecoveryIncrement = document.querySelector("#settings-recovery-increment");
const settingsRecoveryInterval = document.querySelector("#settings-recovery-interval");
const routingSettingsStatus = document.querySelector("#routing-settings-status");
const proxySettingsForm = document.querySelector("#proxy-settings-form");
const settingsProxyEnabled = document.querySelector("#settings-proxy-enabled");
const settingsProxyUrl = document.querySelector("#settings-proxy-url");
const proxySettingsStatus = document.querySelector("#proxy-settings-status");
const settingsRevision = document.querySelector("#settings-revision");
const serverSettingsStatus = document.querySelector("#server-settings-status");
const rotateAdminTokenButton = document.querySelector("#rotate-admin-token");
const rotateConfirmDialog = document.querySelector("#rotate-confirm-dialog");
const rotateAdminTokenForm = document.querySelector("#rotate-admin-token-form");
const rotateAdminTokenInput = document.querySelector("#rotate-admin-token-input");
const rotateConfirmCheck = document.querySelector("#rotate-confirm-check");
const rotateConfirmCancel = document.querySelector("#rotate-confirm-cancel");
const rotateConfirmSubmit = document.querySelector("#rotate-confirm-submit");
const systemRefreshButton = document.querySelector("#system-refresh");
const systemInfoGrid = document.querySelector("#system-info-grid");
const modelTestDialog = document.querySelector("#model-test-dialog");
const modelTestForm = document.querySelector("#model-test-form");
const modelTestTitle = document.querySelector("#model-test-title");
const modelTestSummary = document.querySelector("#model-test-summary");
const modelTestClose = document.querySelector("#model-test-close");
const modelTestModel = document.querySelector("#model-test-model");
const modelTestProtocol = document.querySelector("#model-test-protocol");
const modelTestPromptTemplate = document.querySelector("#model-test-prompt-template");
const modelTestPrompt = document.querySelector("#model-test-prompt");
const modelTestRefreshModels = document.querySelector("#model-test-refresh-models");
const modelTestSubmit = document.querySelector("#model-test-submit");
const modelTestResult = document.querySelector("#model-test-result");
const modelTestResultStatus = document.querySelector("#model-test-result-status");
const modelTestResultMeta = document.querySelector("#model-test-result-meta");
const modelTestResultBody = document.querySelector("#model-test-result-body");
const modelTestRequestBody = document.querySelector("#model-test-request-body");
const modelTestResponseBody = document.querySelector("#model-test-response-body");
const modelTestPromptList = document.querySelector("#model-test-prompt-list");
const newModelTestPromptButton = document.querySelector("#new-model-test-prompt");
const modelTestPromptDialog = document.querySelector("#model-test-prompt-dialog");
const modelTestPromptForm = document.querySelector("#model-test-prompt-form");
const modelTestPromptClose = document.querySelector("#model-test-prompt-close");
const modelTestPromptCancel = document.querySelector("#model-test-prompt-cancel");
const modelTestPromptId = document.querySelector("#model-test-prompt-id");
const modelTestPromptName = document.querySelector("#model-test-prompt-name");
const modelTestPromptContent = document.querySelector("#model-test-prompt-content");
let modelTestPromptTemplates = [];
let modelTestUpstream = null;

const modelDialog = document.querySelector("#model-dialog");
const modelDialogTitle = document.querySelector("#model-dialog-title");
const modelDialogSummary = document.querySelector("#model-dialog-summary");
const modelDialogClose = document.querySelector("#model-dialog-close");
const modelFilter = document.querySelector("#model-filter");
const modelOptions = document.querySelector("#model-options");
const modelSelectedOnly = document.querySelector("#model-selected-only");
const modelSelectAllButton = document.querySelector("#model-select-all");
const modelRemoveUnavailableButton = document.querySelector("#model-remove-unavailable");
const modelClearAllButton = document.querySelector("#model-clear-all");
const modelManualInput = document.querySelector("#model-manual-input");
const modelAddManualButton = document.querySelector("#model-add-manual");
const modelSaveSelectionButton = document.querySelector("#model-save-selection");
const modelCancelSelectionButton = document.querySelector("#model-cancel-selection");
const manageModelsButton = document.querySelector("#manage-models");
const formModelManualInput = document.querySelector("#form-model-manual-input");
const formModelAddManualButton = document.querySelector("#form-model-add-manual");
const modelSelectionPreview = document.querySelector("#model-selection-preview");
const modelSelectionCount = document.querySelector("#model-selection-count");

const fields = {
  id: document.querySelector("#upstream-id"),
  name: document.querySelector("#name"),
  baseUrl: document.querySelector("#base-url"),
  apiKey: document.querySelector("#api-key"),
  modelNames: document.querySelector("#model-names"),
  modelPrefixes: document.querySelector("#model-prefixes"),
  modelMappings: document.querySelector("#model-mappings"),
  priority: document.querySelector("#priority"),
  weight: document.querySelector("#weight"),
  timeoutSeconds: document.querySelector("#timeout-seconds"),
  extraHeaders: document.querySelector("#extra-headers"),
  rateLimit: document.querySelector("#upstream-rate-limit"),
  enabled: document.querySelector("#enabled"),
  fixedWeightEnabled: document.querySelector("#auto-weight-enabled"),
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
const tokenNameInput = document.querySelector("#token-name");
const tokenDescriptionInput = document.querySelector("#token-description");
const tokenCustomLabel = document.querySelector("#token-custom-label");
const tokenCustomInput = document.querySelector("#token-custom");
const tokenCustomHint = document.querySelector("#token-custom-hint");
const tokenCustomCopy = document.querySelector("#token-custom-copy");
const tokenExpiresInput = document.querySelector("#token-expires");
const tokenLimitInput = document.querySelector("#token-limit");
const tokenRateLimitInput = document.querySelector("#token-rate-limit");
const tokenExpiresPresets = document.querySelector("#token-expires-presets");
const tokenExpiresPreview = document.querySelector("#token-expires-preview");
const tokenEnabledCheckbox = document.querySelector("#token-enabled");
const tokenIdInput = document.querySelector("#token-id");

let tokenRefreshTimer = null;
let tokens = [];
let tokensLoadedOnce = false;
let tokensLoading = false;
let tokenSearchQuery = "";
let tokenSearchTimer = null;

let upstreams = [];
let activeActionMenuButton = null;
let openActionMenuUpstreamId = null;
let lastUpstreamLoadError = "";
const modelDialogState = {
  upstream: null,
  mode: "form",
  models: [],
  selected: new Set(),
  available: new Set(),
  catalogLoaded: false,
  mappings: {},
  selectedMappings: new Set(),
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
    let beganOnBackdrop = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      confirmOk.removeEventListener("click", onOk);
      confirmCancel.removeEventListener("click", onCancel);
      confirmClose.removeEventListener("click", onCancel);
      confirmDialog.removeEventListener("cancel", onCancelEvent);
      confirmDialog.removeEventListener("pointerdown", onPointerDown);
      confirmDialog.removeEventListener("pointercancel", onPointerCancel);
      confirmDialog.removeEventListener("click", onBackdrop);
      if (typeof clearDialogMaximized === "function") {
        clearDialogMaximized(confirmDialog);
      } else {
        confirmDialog.classList.remove("is-maximized");
      }
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
    const onPointerDown = (event) => {
      beganOnBackdrop = event.button === 0 && event.target === confirmDialog;
    };
    const onPointerCancel = () => {
      beganOnBackdrop = false;
    };
    const onBackdrop = (event) => {
      const shouldDismiss = beganOnBackdrop && event.target === confirmDialog;
      beganOnBackdrop = false;
      if (shouldDismiss) {
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
    confirmDialog.addEventListener("pointerdown", onPointerDown);
    confirmDialog.addEventListener("pointercancel", onPointerCancel);
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

// Native <select> listboxes ignore CSS (border-radius especially). Intercept
// opens and render options into #select-panel so the popup follows the theme.
//
// Modal <dialog> makes the rest of the document inert. A popover that is only a
// sibling of the dialog can paint above it in the top layer but still receive no
// pointer events (clicks pass through). Host the panel inside the open modal
// when the trigger lives there so it escapes inertness.
let activeSelect = null;
let selectActiveIndex = -1;
let selectOptionButtons = [];
const selectPanelHome = selectPanel?.parentElement || null;

function isNativeSelect(element) {
  return element instanceof HTMLSelectElement
    && !element.disabled
    && !element.multiple
    && !element.size;
}

function selectOptionEntries(select) {
  return Array.from(select.options || []).map((option, index) => ({
    option,
    index,
    value: option.value,
    label: option.label || option.textContent || "",
    disabled: option.disabled,
    selected: option.selected || select.selectedIndex === index,
  }));
}

function modalDialogForSelect(select) {
  const dialog = select?.closest?.("dialog");
  if (!(dialog instanceof HTMLDialogElement) || !dialog.open) return null;
  try {
    if (dialog.matches(":modal")) return dialog;
  } catch {
    // :modal may be unsupported; treat any open dialog as the host.
  }
  return dialog;
}

function placeSelectPanelFor(select) {
  if (!selectPanel) return;
  const host = modalDialogForSelect(select) || selectPanelHome;
  if (!host || selectPanel.parentElement === host) return;
  if (popoverIsOpen(selectPanel)) {
    selectPanel.hidePopover();
  }
  host.append(selectPanel);
}

function restoreSelectPanelHost() {
  if (!selectPanel || !selectPanelHome || selectPanel.parentElement === selectPanelHome) return;
  if (popoverIsOpen(selectPanel)) {
    selectPanel.hidePopover();
  }
  selectPanelHome.append(selectPanel);
}

function closeCustomSelect(restoreFocus = false) {
  const select = activeSelect;
  activeSelect = null;
  selectActiveIndex = -1;
  selectOptionButtons = [];
  if (selectPanel && !selectPanel.hidden) {
    selectPanel.innerHTML = "";
    selectPanel.style.visibility = "";
    selectPanel.style.width = "";
    selectPanel.style.left = "";
    selectPanel.style.top = "";
    selectPanel.removeAttribute("aria-activedescendant");
    hidePopoverLayer(selectPanel);
  }
  restoreSelectPanelHost();
  if (restoreFocus && select?.isConnected) {
    select.focus();
  }
}

function setSelectActiveIndex(nextIndex) {
  if (!selectOptionButtons.length) {
    selectActiveIndex = -1;
    return;
  }
  const clamped = Math.max(0, Math.min(selectOptionButtons.length - 1, nextIndex));
  selectActiveIndex = clamped;
  selectOptionButtons.forEach((button, index) => {
    const active = index === clamped;
    button.classList.toggle("is-active", active);
    button.tabIndex = active ? 0 : -1;
    if (active) {
      selectPanel?.setAttribute("aria-activedescendant", button.id);
      button.scrollIntoView({ block: "nearest" });
    }
  });
}

function chooseCustomSelectOption(index) {
  if (!activeSelect || !Number.isInteger(index)) return;
  const option = activeSelect.options[index];
  if (!option || option.disabled) return;
  if (activeSelect.selectedIndex !== index || activeSelect.value !== option.value) {
    activeSelect.selectedIndex = index;
    activeSelect.dispatchEvent(new Event("input", { bubbles: true }));
    activeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }
  closeCustomSelect(true);
}

function positionCustomSelect() {
  if (!activeSelect || !selectPanel || selectPanel.hidden) return;
  const triggerRect = activeSelect.getBoundingClientRect();
  const menuRect = selectPanel.getBoundingClientRect();
  const gap = 6;
  const viewportGap = 8;
  let left = triggerRect.left;
  let top = triggerRect.bottom + gap;
  const width = Math.max(triggerRect.width, menuRect.width);

  if (left + width > window.innerWidth - viewportGap) {
    left = Math.max(viewportGap, window.innerWidth - width - viewportGap);
  }
  left = Math.max(viewportGap, left);

  if (top + menuRect.height > window.innerHeight - viewportGap) {
    top = triggerRect.top - menuRect.height - gap;
  }
  if (top < viewportGap) {
    top = viewportGap;
  }

  selectPanel.style.left = `${Math.round(left)}px`;
  selectPanel.style.top = `${Math.round(top)}px`;
  selectPanel.style.width = `${Math.round(width)}px`;
}

function openCustomSelect(select) {
  if (!selectPanel || !isNativeSelect(select)) return;
  if (activeSelect === select && !selectPanel.hidden) {
    closeCustomSelect(true);
    return;
  }

  if (typeof closeUpstreamActionMenu === "function") closeUpstreamActionMenu();
  if (typeof closeColMenus === "function") closeColMenus();
  if (typeof setThemeMenuOpen === "function") setThemeMenuOpen(false);

  closeCustomSelect();
  activeSelect = select;
  select.focus({ preventScroll: true });
  const entries = selectOptionEntries(select);
  selectPanel.innerHTML = "";
  selectOptionButtons = [];

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "select-panel-empty";
    empty.textContent = "无可选项";
    selectPanel.append(empty);
  } else {
    const fragment = document.createDocumentFragment();
    entries.forEach((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.id = `select-option-${entry.index}`;
      button.setAttribute("role", "option");
      button.dataset.optionIndex = String(entry.index);
      button.textContent = entry.label;
      button.disabled = entry.disabled;
      button.classList.toggle("is-selected", entry.selected);
      button.setAttribute("aria-selected", String(entry.selected));
      button.tabIndex = -1;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        chooseCustomSelectOption(entry.index);
      });
      fragment.append(button);
      if (!entry.disabled) selectOptionButtons.push(button);
    });
    selectPanel.append(fragment);
  }

  selectPanel.style.visibility = "hidden";
  placeSelectPanelFor(select);
  showPopoverLayer(selectPanel, true);
  window.requestAnimationFrame(() => {
    if (activeSelect !== select) return;
    positionCustomSelect();
    selectPanel.style.visibility = "visible";
    const selectedPos = selectOptionButtons.findIndex((button) => button.classList.contains("is-selected"));
    setSelectActiveIndex(selectedPos >= 0 ? selectedPos : 0);
  });
}

function handleSelectKeydown(event) {
  if (!activeSelect || selectPanel?.hidden) return false;
  const key = event.key;
  if (key === "Escape") {
    event.preventDefault();
    closeCustomSelect(true);
    return true;
  }
  if (key === "ArrowDown") {
    event.preventDefault();
    setSelectActiveIndex(selectActiveIndex < 0 ? 0 : selectActiveIndex + 1);
    return true;
  }
  if (key === "ArrowUp") {
    event.preventDefault();
    setSelectActiveIndex(selectActiveIndex < 0 ? selectOptionButtons.length - 1 : selectActiveIndex - 1);
    return true;
  }
  if (key === "Home") {
    event.preventDefault();
    setSelectActiveIndex(0);
    return true;
  }
  if (key === "End") {
    event.preventDefault();
    setSelectActiveIndex(selectOptionButtons.length - 1);
    return true;
  }
  if (key === "Enter" || key === " ") {
    event.preventDefault();
    if (selectActiveIndex >= 0) {
      const button = selectOptionButtons[selectActiveIndex];
      const index = Number(button?.dataset.optionIndex);
      chooseCustomSelectOption(index);
    }
    return true;
  }
  if (key === "Tab") {
    closeCustomSelect();
    return false;
  }
  return false;
}

document.addEventListener("mousedown", (event) => {
  const select = event.target?.closest?.("select");
  if (isNativeSelect(select)) {
    // Block the native listbox; we render a themed panel instead.
    event.preventDefault();
    openCustomSelect(select);
    return;
  }
  if (
    activeSelect
    && selectPanel
    && !selectPanel.hidden
    && !selectPanel.contains(event.target)
    && event.target !== activeSelect
  ) {
    closeCustomSelect();
  }
}, true);

// Some browsers still open the native list on click even after mousedown preventDefault.
document.addEventListener("click", (event) => {
  if (isNativeSelect(event.target?.closest?.("select"))) {
    event.preventDefault();
  }
}, true);

document.addEventListener("keydown", (event) => {
  if (handleSelectKeydown(event)) return;
  const select = event.target;
  if (!isNativeSelect(select) || !selectPanel?.hidden) return;
  if (event.key === " " || event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    openCustomSelect(select);
  }
});

window.addEventListener("resize", () => closeCustomSelect());
window.addEventListener("scroll", (event) => {
  // Scroll events capture from the listbox too. Its own scrollbar must not
  // be treated as a page scroll, otherwise a long option list closes at once.
  if (selectPanel?.contains(event.target)) return;
  closeCustomSelect();
}, true);
// Dialog close leaves the select trigger gone; drop the panel and restore its home node.
document.addEventListener("close", (event) => {
  if (event.target instanceof HTMLDialogElement) closeCustomSelect();
}, true);

function splitList(value) {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// Manual model entry: newlines and commas separate entries; within one entry
// an `=>` marks a model mapping (downstream => channel model), everything else
// is whitespace-separated plain model names. Returns { names, mappings }.
function parseManualModelEntry(value) {
  const names = [];
  const mappings = {};
  for (const segment of String(value || "").split(/[,，\n]/)) {
    const clean = segment.trim();
    if (!clean) {
      continue;
    }
    const arrow = clean.indexOf("=>");
    if (arrow !== -1) {
      const downstream = clean.slice(0, arrow).trim();
      const upstream = clean.slice(arrow + 2).trim();
      if (downstream && upstream) {
        mappings[downstream] = upstream;
      }
      continue;
    }
    for (const name of clean.split(/\s+/)) {
      const trimmed = name.trim();
      if (trimmed) {
        names.push(trimmed);
      }
    }
  }
  return { names: uniqueList(names), mappings };
}

// Read mappings from the textarea without throwing, for live chip preview.
// Strict validation still runs on submit via parseModelMappings.
function readModelMappingsLenient(value) {
  const mappings = {};
  for (const line of String(value || "").split(/\n/)) {
    const clean = line.trim();
    if (!clean) {
      continue;
    }
    const match = clean.match(/^(.+?)(?:=>|=|:)(.+)$/);
    if (!match) {
      continue;
    }
    const downstream = match[1].trim();
    const upstream = match[2].trim();
    if (downstream && upstream) {
      mappings[downstream] = upstream;
    }
  }
  return mappings;
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

/* 迷你图统一用 preserveAspectRatio="none"：曲线要铺满整宽，横纵缩放比例
   因此不同（例如 viewBox 100×40 画在 260×48px 上，横向 2.6 倍、纵向 1.2
   倍）。<circle> 会跟着被横向拉扁成椭圆，补偿办法是给它反向的横向缩放，
   再把 cx 除以同一个系数抵消位移。系数 = 纵向缩放 / 横向缩放。
   bounds 是 svg 的 getBoundingClientRect()，view 是 {width, height} 的
   viewBox 尺寸。 */
function sparkDotScaleX(bounds, view) {
  return (bounds.height * view.width) / Math.max(bounds.width * view.height, 1);
}

/* Catmull-Rom 转三次贝塞尔的平滑折线，渠道卡片的 6h 请求量和看板的延迟趋势
   共用这一个生成器，曲线手感才一致。coords 是已经换算到 SVG 坐标系的
   {x, y} 数组；返回描边路径和向 baselineY 封口的面积路径。控制点的 y 会被
   夹在 [minY, maxY] 里——Catmull-Rom 在陡峭拐点会过冲，不夹的话面积填充
   可能戳破基线或顶出视口。 */
function buildSmoothSparkPaths(coords, { baselineY, minY = -Infinity, maxY = Infinity } = {}) {
  if (!coords.length) return { line: "", area: "" };
  const fmt = (value) => value.toFixed(2);
  if (coords.length === 1) {
    const only = coords[0];
    const line = `M ${fmt(only.x)} ${fmt(only.y)}`;
    return { line, area: `${line} L ${fmt(only.x)} ${fmt(baselineY)} Z` };
  }
  const clampY = (value) => Math.min(Math.max(value, minY), maxY);
  let line = `M ${fmt(coords[0].x)} ${fmt(coords[0].y)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i - 1] || coords[i];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = clampY(p1.y + (p2.y - p0.y) / 6);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = clampY(p2.y - (p3.y - p1.y) / 6);
    line += ` C ${fmt(c1x)} ${fmt(c1y)}, ${fmt(c2x)} ${fmt(c2y)}, ${fmt(p2.x)} ${fmt(p2.y)}`;
  }
  const first = coords[0];
  const last = coords[coords.length - 1];
  const area = `${line} L ${fmt(last.x)} ${fmt(baselineY)} L ${fmt(first.x)} ${fmt(baselineY)} Z`;
  return { line, area };
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

/* 渠道所属分组。分组名要靠 groupCache 翻译，那份缓存由 groups.js 维护——列表
   页首次渲染可能还没拉回来，这时只显示 id，等分组页访问过就自动带上名字。 */
function renderUpstreamGroups(upstream) {
  const ids = Array.isArray(upstream.group_ids) ? upstream.group_ids : [];
  if (ids.length === 0) {
    return '<span class="muted">—</span>';
  }
  const labels = ids.map((id) => {
    const group = typeof groupById === "function" ? groupById(id) : null;
    return group ? group.name : `#${id}`;
  });
  const visible = labels.slice(0, MAX_MODEL_CHIPS);
  const hiddenCount = labels.length - visible.length;
  const chips = visible
    .map((label) => `<span class="model-chip group">${escapeHtml(label)}</span>`)
    .join("");
  const more = hiddenCount > 0 ? `<span class="model-chip more">+${hiddenCount}</span>` : "";
  return `<div class="model-chip-list" title="${escapeHtml(labels.join(", "))}">${chips}${more}</div>`;
}

/* 分组表和令牌表的描述列共用这一个渲染。`.muted` 必须挂在内层 span 上：
   tables.css 给 .muted 设了 display: block，落在 td 上会把单元格从表格布局里
   摘出去，那一格就不再参与行高、vertical-align 也失效，看着跟同行对不齐。
   描述服务端限 200 字且拒控制符，一定是单行，所以截断比换行更贴表格的节奏，
   全文放 title 里。空值单独标 is-empty，让占位符比真描述更淡。 */
function renderDescriptionCell(description) {
  const text = String(description || "").trim();
  if (!text) {
    return '<td class="desc-cell"><span class="muted is-empty">—</span></td>';
  }
  const safe = escapeHtml(text);
  return `<td class="desc-cell"><span class="muted" title="${safe}">${safe}</span></td>`;
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
  const zeroEffectiveWeight = upstreams.filter((upstream) => upstream.enabled && Number(upstream.effective_weight) <= 0).length;

  const signature = [total, enabled, disabled, zeroEffectiveWeight].join("|");
  if (signature === lastSummarySignature) {
    return;
  }
  lastSummarySignature = signature;

  const effectiveWeightHint = zeroEffectiveWeight > 0
    ? `<span class="summary-hint">有效权重为 0 的动态渠道会按恢复周期重新加入</span>`
    : "";

  upstreamSummary.innerHTML = `
    <span><strong>${total}</strong>渠道总数</span>
    <span><strong>${enabled}</strong>启用</span>
    <span><strong>${disabled}</strong>停用</span>
    <span class="${zeroEffectiveWeight ? "summary-warn" : ""}"><strong>${zeroEffectiveWeight}</strong>有效权重为 0${effectiveWeightHint}</span>
  `;
}

function debounce(fn, wait = 150) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

// ── Density / column prefs / effective weight / charts ─────────────

const DEFAULT_UPSTREAM_COLUMNS = {
  check: true,
  id: true,
  name: true,
  models: true,
  groups: true,
  priority: true,
  weight: true,
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
  name: "渠道名",
  models: "模型匹配",
  groups: "分组",
  priority: "优先级",
  weight: "权重",
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

function formatEffectiveZeroNote(seconds) {
  if (!seconds) return "有效权重 0 · 等待恢复周期";
  return `有效权重 0 · ${seconds}s 后恢复`;
}
