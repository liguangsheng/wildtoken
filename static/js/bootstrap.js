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
const balanceClose = document.querySelector("#balance-close");

const toastRegion = document.querySelector("#toast-region");
const selectPanel = document.querySelector("#select-panel");
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
const QUICK_IMPORT_DEFAULT_PRIORITY = 999;
const QUICK_IMPORT_FILL_LABEL = "填入并拉取模型";
let quickImportFetchController = null;

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
const DASHBOARD_TOP_WINDOW_KEY = "wildtoken_dashboard_top_window";
const DASHBOARD_TOP_WINDOW_VALUES = new Set(["today", "1d", "3d", "7d", "30d"]);
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
let dashboardTopWindow = (() => {
  try {
    const saved = localStorage.getItem(DASHBOARD_TOP_WINDOW_KEY);
    return DASHBOARD_TOP_WINDOW_VALUES.has(saved) ? saved : "today";
  } catch {
    return "today";
  }
})();
let dashboardRefreshTimer = null;
let dashboardLoading = false;
let lastDashboardLoadError = "";

const dashboardScope = document.querySelector("#dashboard-scope");
const dashboardRefreshButton = document.querySelector("#dashboard-refresh");
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
const dashboardTopWindowSelect = document.querySelector("#dashboard-top-window");
const dashboardErrorRows = document.querySelector("#dashboard-error-rows");

if (dashboardTopWindowSelect) {
  dashboardTopWindowSelect.value = dashboardTopWindow;
}

let upstreamRefreshTimer = null;
let upstreamsLoadedOnce = false;
let upstreamsLoading = false;
let upstreamSearchQuery = "";
let upstreamStatusFilterValue = "";
let upstreamSearchTimer = null;

const HEALTH_TICK_MS = 1000;
const MAX_MODEL_CHIPS = 5;
let healthTickTimer = null;
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
const modelSelectedOnly = document.querySelector("#model-selected-only");
const modelSelectAllButton = document.querySelector("#model-select-all");
const modelRemoveUnavailableButton = document.querySelector("#model-remove-unavailable");
const modelClearAllButton = document.querySelector("#model-clear-all");
const modelManualInput = document.querySelector("#model-manual-input");
const modelAddManualButton = document.querySelector("#model-add-manual");
const modelSaveSelectionButton = document.querySelector("#model-save-selection");
const modelCancelSelectionButton = document.querySelector("#model-cancel-selection");
const manageModelsButton = document.querySelector("#manage-models");
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
  enabled: document.querySelector("#enabled"),
  autoWeightEnabled: document.querySelector("#auto-weight-enabled"),
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
  available: new Set(),
  catalogLoaded: false,
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
let activeSelect = null;
let selectActiveIndex = -1;
let selectOptionButtons = [];

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

function closeCustomSelect(restoreFocus = false) {
  if (!selectPanel || selectPanel.hidden) {
    activeSelect = null;
    selectActiveIndex = -1;
    selectOptionButtons = [];
    return;
  }
  const select = activeSelect;
  activeSelect = null;
  selectActiveIndex = -1;
  selectOptionButtons = [];
  selectPanel.innerHTML = "";
  selectPanel.style.visibility = "";
  selectPanel.style.width = "";
  selectPanel.style.left = "";
  selectPanel.style.top = "";
  selectPanel.removeAttribute("aria-activedescendant");
  hidePopoverLayer(selectPanel);
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
window.addEventListener("scroll", () => closeCustomSelect(), true);

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
  const zeroEffectiveWeight = upstreams.filter((upstream) => upstream.enabled && Number(upstream.effective_weight) <= 0).length;

  const signature = [total, enabled, disabled, zeroEffectiveWeight].join("|");
  if (signature === lastSummarySignature) {
    return;
  }
  lastSummarySignature = signature;

  const healthHint = zeroEffectiveWeight > 0
    ? `<span class="summary-hint">自动降为 0 的渠道会按恢复周期重新加入</span>`
    : "";

  upstreamSummary.innerHTML = `
    <span><strong>${total}</strong>渠道总数</span>
    <span><strong>${enabled}</strong>启用</span>
    <span><strong>${disabled}</strong>停用</span>
    <span class="${zeroEffectiveWeight ? "summary-warn" : ""}"><strong>${zeroEffectiveWeight}</strong>有效权重为 0${healthHint}</span>
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
  models: true,
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

function formatHealthZeroNote(seconds) {
  if (!seconds) return "健康分 0 · 等待恢复周期";
  return `健康分 0 · ${seconds}s 后恢复`;
}
