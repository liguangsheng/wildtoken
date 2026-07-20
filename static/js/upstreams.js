// Channel form, validation, table rendering, and channel operations.
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
    model_names: getFormModels(),
    model_prefixes: splitList(fields.modelPrefixes.value),
    model_mappings: modelMappings,
    priority: Number(fields.priority.value || 100),
    weight: Number(fields.weight.value),
    auto_weight_enabled: fields.autoWeightEnabled.checked,
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
  clearDialogMaximized(upstreamDialog);
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
    Boolean(quickImportFetchController)
    || (!quickImportBaseUrlInput.value.trim() && !quickImportApiKeyInput.value.trim());
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
  cancelQuickImportFetch();
  quickImportText.value = "";
  quickImportBaseUrlInput.value = "";
  quickImportApiKeyInput.value = "";
  quickImportFillButton.textContent = QUICK_IMPORT_FILL_LABEL;
  updateQuickImportFillState();
  if (typeof quickImportDialog.showModal === "function") {
    quickImportDialog.showModal();
  } else {
    quickImportDialog.setAttribute("open", "");
  }
  quickImportText.focus();
}

function setQuickImportInputsDisabled(disabled) {
  quickImportText.disabled = disabled;
  quickImportBaseUrlInput.disabled = disabled;
  quickImportApiKeyInput.disabled = disabled;
}

function cancelQuickImportFetch() {
  if (quickImportFetchController) {
    quickImportFetchController.abort();
    quickImportFetchController = null;
  }
  setQuickImportInputsDisabled(false);
  quickImportFillButton.textContent = QUICK_IMPORT_FILL_LABEL;
  updateQuickImportFillState();
}

function closeQuickImportDialog() {
  cancelQuickImportFetch();
  clearDialogMaximized(quickImportDialog);
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
    setFormModels(detail.model_names);
    fields.modelPrefixes.value = joinList(detail.model_prefixes);
    fields.modelMappings.value = joinModelMappings(detail.model_mappings);
    fields.priority.value = detail.priority;
    fields.weight.value = detail.weight;
    fields.autoWeightEnabled.checked = detail.auto_weight_enabled;
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
  setFormModels(upstream.model_names);
  fields.modelPrefixes.value = joinList(upstream.model_prefixes);
  fields.modelMappings.value = joinModelMappings(upstream.model_mappings);
  fields.priority.value = upstream.priority;
  fields.weight.value = upstream.weight;
  fields.autoWeightEnabled.checked = upstream.auto_weight_enabled;
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
  clearDialogMaximized(balanceDialog);
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
  fields.weight.value = 100;
  fields.timeoutSeconds.value = 300;
  setFormModels([]);
  fields.modelMappings.value = "";
  fields.extraHeaders.value = "{}";
  fields.enabled.checked = true;
  fields.autoWeightEnabled.checked = true;
  setAdvancedSettingsOpen(false);
  fetchModelsButton.disabled = false;
  formTitle.textContent = "新增渠道";
}

function formatEffectiveWeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatZeroWeightNote(upstream, remainingRecovery) {
  if (Number(upstream.weight) === 0) return "基础权重 0 · 不参与自动路由";
  return formatHealthZeroNote(remainingRecovery);
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
    const remainingRecovery = liveHealthRecoverySeconds(upstream);
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
          ${renderBaseUrlCell(upstream)}
        </div>
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
      <td class="col-weight" data-col="weight">
        <div class="weight-stack">
          <strong>${formatEffectiveWeight(upstream.effective_weight)}</strong>
          <span>${upstream.auto_weight_enabled ? `基础 ${upstream.weight} · 健康 ${upstream.runtime_health_score}` : `基础 ${upstream.weight} · 固定`}</span>
        </div>
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
          class="effective-zero-note"
          data-effective-zero-id="${upstream.id}"
          ${Number(upstream.effective_weight) <= 0 ? "" : "hidden"}
        >${Number(upstream.effective_weight) <= 0 ? formatZeroWeightNote(upstream, remainingRecovery) : ""}</span>
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

function liveHealthRecoverySeconds(upstream) {
  if (!upstream.healthRecoveryAtMs) {
    return 0;
  }
  return Math.max(0, Math.ceil((upstream.healthRecoveryAtMs - Date.now()) / 1000));
}

function updateHealthNotes() {
  for (const note of rows.querySelectorAll("[data-effective-zero-id]")) {
    const upstream = upstreams.find((item) => item.id === Number(note.dataset.effectiveZeroId));
    const remaining = upstream ? liveHealthRecoverySeconds(upstream) : 0;
    note.textContent = upstream ? formatZeroWeightNote(upstream, remaining) : "";
    note.hidden = !upstream || Number(upstream.effective_weight) > 0;
  }
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
      upstream.healthRecoveryAtMs = upstream.health_recovery_remaining_seconds
        ? Date.now() + upstream.health_recovery_remaining_seconds * 1000
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
