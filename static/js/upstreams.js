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
    auto_weight_enabled: !fields.fixedWeightEnabled.checked,
    timeout_seconds: Number(fields.timeoutSeconds.value || 300),
    enabled: fields.enabled.checked,
    extra_headers: extraHeaders,
    rate_limit: fields.rateLimit.value.trim() || null,
    clear_api_key: fields.clearApiKey.checked,
    group_ids: readUpstreamGroupSelection(),
  };
}

/* 编辑/复制渠道时先把该渠道的分组记下来，等 openUpstreamDialog 真正打开弹窗时
   再填进去——填充要等分组列表拉回来，而打开弹窗是同步的。 */
let pendingUpstreamGroupIds = null;

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
  // 分组列表可能在别处被改过，每次开弹窗都重新填一遍。
  fillUpstreamGroupOptions(pendingUpstreamGroupIds);
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
    pendingUpstreamGroupIds = detail.group_ids || null;
    formModelManualInput.value = "";
    fields.modelPrefixes.value = joinList(detail.model_prefixes);
    fields.modelMappings.value = joinModelMappings(detail.model_mappings);
    setFormModels(detail.model_names);
    fields.priority.value = detail.priority;
    fields.weight.value = detail.weight;
    fields.fixedWeightEnabled.checked = !detail.auto_weight_enabled;
    fields.timeoutSeconds.value = detail.timeout_seconds;
    fields.extraHeaders.value = JSON.stringify(detail.extra_headers || {}, null, 2);
    fields.rateLimit.value = detail.rate_limit || "";
    fields.enabled.checked = detail.enabled;
    fields.clearApiKey.checked = false;
    // 限速也在高级设置里，配置过就展开，不然编辑时看不到已有的值。
    setAdvancedSettingsOpen(hasExtraHeaders(detail.extra_headers) || Boolean(detail.rate_limit));
    fetchModelsButton.disabled = false;
    formTitle.textContent = `编辑渠道：${detail.name}`;
    openUpstreamDialog();
  } catch (error) {
    setStatus(`加载渠道配置失败：${error.message}`, "error");
  }
}

function duplicateUpstream(upstream) {
  resetForm();
  pendingUpstreamGroupIds = upstream.group_ids || null;
  fields.name.value = `${upstream.name} 副本`;
  fields.baseUrl.value = upstream.base_url;
  fields.modelPrefixes.value = joinList(upstream.model_prefixes);
  fields.modelMappings.value = joinModelMappings(upstream.model_mappings);
  setFormModels(upstream.model_names);
  fields.priority.value = upstream.priority;
  fields.weight.value = upstream.weight;
  fields.fixedWeightEnabled.checked = !upstream.auto_weight_enabled;
  fields.timeoutSeconds.value = upstream.timeout_seconds;
  fields.extraHeaders.value = JSON.stringify(upstream.extra_headers || {}, null, 2);
  fields.rateLimit.value = upstream.rate_limit || "";
  fields.enabled.checked = upstream.enabled;
  setAdvancedSettingsOpen(hasExtraHeaders(upstream.extra_headers) || Boolean(upstream.rate_limit));
  formTitle.textContent = `复制渠道：${upstream.name}`;
  openUpstreamDialog();
  setStatus("已复制渠道配置，API Key 需要重新填写后再保存。", "ok");
}

function formatUpstreamClipboardText(detail) {
  const baseUrl = String(detail?.base_url || "");
  const apiKey = String(detail?.api_key || "");
  return `baseURL: ${baseUrl}\napiKey: ${apiKey}`;
}

async function copyUpstreamInfo(upstream) {
  try {
    const detail = await api(`/api/admin/upstreams/${upstream.id}`);
    const copied = await copyTextToClipboard(formatUpstreamClipboardText(detail));
    if (!copied) {
      throw new Error("浏览器拒绝复制，请手动复制。");
    }
    setStatus(`渠道「${detail.name || upstream.name}」信息已复制。`, "ok");
  } catch (error) {
    setStatus(`复制渠道信息失败：${error.message}`, "error");
  }
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
  // Retire any in-flight query so its result cannot land in a later dialog.
  balanceQueryToken += 1;
  setBalanceRefreshBusy(false);
  if (balanceDialog.open && typeof balanceDialog.close === "function") {
    balanceDialog.close();
  } else {
    balanceDialog.removeAttribute("open");
  }
}

function formatBalanceAmount(value, unit = "USD") {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  const fixed = Math.abs(value) >= 100 ? value.toFixed(2) : value.toFixed(4);
  const formatted = fixed.replace(/\.?0+$/, "");
  return unit === "USD" ? `$${formatted}` : `${formatted} ${unit}`;
}

function renderBalanceRow(label, value) {
  return `<div class="balance-row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`;
}

function renderBalanceResult(result, provider) {
  const unit = result.unit || "USD";
  if (provider === "sub2api" || result.provider === "sub2api") {
    const rows = [
      renderBalanceRow("余额", formatBalanceAmount(result.remaining_usd, unit)),
      renderBalanceRow("累计实耗", formatBalanceAmount(result.used_usd, unit)),
    ];
    if (result.plan_name) rows.push(renderBalanceRow("计划", result.plan_name));
    if (typeof result.is_valid === "boolean") rows.push(renderBalanceRow("状态", result.is_valid ? "有效" : "无效"));
    if (result.mode) rows.push(renderBalanceRow("模式", result.mode));
    return rows.join("");
  }
  return [
    renderBalanceRow("总额", formatBalanceAmount(result.total_usd, unit)),
    renderBalanceRow("已用", formatBalanceAmount(result.used_usd, unit)),
    renderBalanceRow("剩余", formatBalanceAmount(result.remaining_usd, unit)),
  ].join("");
}

function setBalanceRefreshBusy(busy) {
  balanceRefresh.disabled = busy;
  balanceRefresh.classList.toggle("is-busy", busy);
}

/// Re-run the query the balance dialog is currently showing.
async function refreshBalance() {
  if (!activeBalanceQuery) return;
  const { endpoint, provider } = activeBalanceQuery;
  // Refreshing and reopening the dialog both supersede whatever is in flight;
  // a stale response must not overwrite the newer one it loses the race to.
  const token = ++balanceQueryToken;
  balanceSummary.textContent = "正在查询...";
  balanceBody.innerHTML = "";
  setBalanceRefreshBusy(true);

  try {
    const result = await api(endpoint, { method: "POST" });
    if (token !== balanceQueryToken) return;
    if (result.ok) {
      balanceSummary.textContent = "查询成功";
      balanceBody.innerHTML = renderBalanceResult(result, provider);
    } else {
      balanceSummary.textContent = "查询失败";
      balanceBody.innerHTML = `<p class="muted">${escapeHtml(result.message || "未知错误")}</p>`;
    }
  } catch (error) {
    if (token !== balanceQueryToken) return;
    balanceSummary.textContent = "查询失败";
    balanceBody.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  } finally {
    if (token === balanceQueryToken) {
      setBalanceRefreshBusy(false);
    }
  }
}

async function showBalance(upstream, provider = "new-api") {
  const providerName = provider === "sub2api" ? "sub2api" : "new-api";
  activeBalanceQuery = {
    provider,
    endpoint: provider === "sub2api"
      ? `/api/admin/upstreams/${upstream.id}/balance/sub2api`
      : `/api/admin/upstreams/${upstream.id}/balance`,
  };
  balanceTitle.textContent = `${providerName} 余额：${upstream.name}`;
  openBalanceDialog();
  await refreshBalance();
}

function resetForm() {
  form.reset();
  fields.id.value = "";
  persistedFormApiKey = null;
  // 不清掉的话，新建渠道会带上上一次编辑的分组。
  pendingUpstreamGroupIds = null;
  fields.priority.value = 100;
  fields.weight.value = 100;
  fields.timeoutSeconds.value = 300;
  formModelManualInput.value = "";
  fields.modelMappings.value = "";
  setFormModels([]);
  fields.extraHeaders.value = "{}";
  fields.rateLimit.value = "";
  fields.enabled.checked = true;
  fields.fixedWeightEnabled.checked = false;
  setAdvancedSettingsOpen(false);
  fetchModelsButton.disabled = false;
  formTitle.textContent = "新增渠道";
}

function formatEffectiveWeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function isFixedWeight(upstream) {
  return !upstream.auto_weight_enabled;
}

function weightCellMarkup(upstream) {
  const baseWeight = formatEffectiveWeight(upstream.weight);
  if (isFixedWeight(upstream)) {
    return `<strong>${baseWeight}</strong><span>固定权重</span>`;
  }
  return `<strong>${formatEffectiveWeight(upstream.effective_weight)} / ${baseWeight}</strong><span>有效权重 / 基础权重</span>`;
}

function formatZeroWeightNote(upstream, remainingRecovery) {
  if (isFixedWeight(upstream)) return "固定权重 0 · 不参与路由";
  if (Number(upstream.weight) === 0) return "基础权重 0 · 不参与动态路由";
  return formatEffectiveZeroNote(remainingRecovery);
}

// View state: "list" or "grid"
let currentUpstreamView = "list";

// Restore saved view preference
try {
  const saved = localStorage.getItem("wildtoken_upstream_view");
  if (saved === "grid" || saved === "list") {
    currentUpstreamView = saved;
  }
} catch (e) {
  // Ignore storage errors
}

function setUpstreamView(view) {
  currentUpstreamView = view;
  try {
    localStorage.setItem("wildtoken_upstream_view", view);
  } catch (e) {
    // Ignore storage errors
  }

  if (view === "grid") {
    if (upstreamTableWrap) upstreamTableWrap.hidden = true;
    if (upstreamCardsContainer) upstreamCardsContainer.hidden = false;
    if (viewGridBtn) viewGridBtn.setAttribute("aria-pressed", "true");
    if (viewListBtn) viewListBtn.setAttribute("aria-pressed", "false");
    renderCards();
    reanchorUpstreamActionMenu();
  } else {
    if (upstreamTableWrap) upstreamTableWrap.hidden = false;
    if (upstreamCardsContainer) upstreamCardsContainer.hidden = true;
    if (viewGridBtn) viewGridBtn.setAttribute("aria-pressed", "false");
    if (viewListBtn) viewListBtn.setAttribute("aria-pressed", "true");
    reanchorUpstreamActionMenu();
  }
}

function renderRows() {
  const hadOpenMenu = openActionMenuUpstreamId !== null && !upstreamActionMenu.hidden;
  // 锚点节点即将被 innerHTML 清掉，先松开引用，但保留 id 这个事实。
  activeActionMenuButton = null;

  rows.innerHTML = "";
  renderUpstreamSummary();

  // 选择、ID、渠道名、模型匹配、分组、优先级、权重、状态、操作
  const colCount = 9;

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
    const remainingRecovery = liveEffectiveRecoverySeconds(upstream);
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
      <td class="match-cell" data-col="groups">${renderUpstreamGroups(upstream)}</td>
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
          ${weightCellMarkup(upstream)}
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

  // Also update cards if in grid view
  if (currentUpstreamView === "grid") {
    renderCards();
  }
  /* 必须等两个视图都渲染完再锚定。卡片视图下表格是 display:none，
     此时锚到表格里的按钮会拿到全 0 的 rect，菜单被夹到 (8, 8)。 */
  if (hadOpenMenu) {
    reanchorUpstreamActionMenu();
  }
}

/* 按渠道 id 把菜单重新绑到当前视图的触发按钮上。渲染会换掉按钮节点，
   所以不能靠旧引用；这个渠道被筛掉或删掉了就关菜单。 */
function reanchorUpstreamActionMenu() {
  if (openActionMenuUpstreamId === null || upstreamActionMenu.hidden) return;
  const scope = currentUpstreamView === "grid" ? upstreamCardsContainer : rows;
  const trigger = scope?.querySelector(
    `button[data-menu-id="${openActionMenuUpstreamId}"]`,
  );
  if (!trigger) {
    closeUpstreamActionMenu();
    return;
  }
  if (activeActionMenuButton && activeActionMenuButton !== trigger) {
    activeActionMenuButton.setAttribute("aria-expanded", "false");
  }
  activeActionMenuButton = trigger;
  trigger.setAttribute("aria-expanded", "true");
  window.requestAnimationFrame(positionUpstreamActionMenu);
}

function formatMetric(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "k";
  return num.toString();
}

const CHANNEL_SPARK_VIEW = { width: 100, height: 40 };

let sparklineGradientSeq = 0;

function renderSparkline(points) {
  if (!points || points.length === 0) {
    /* preserveAspectRatio="none" 让 100 单位的横线拉满整个容器——等比缩放时
       viewBox 只占容器中间一段，虚线看起来就短了一截。虚线段长会随横向拉伸
       放大（约 3~4.5 倍），所以这里用小间距，拉开后正好是普通虚线的密度。 */
    return `
      <svg class="sparkline-svg" viewBox="0 0 100 40" preserveAspectRatio="none"
           role="img" aria-label="近 6 小时无请求">
        <line x1="0" y1="38" x2="100" y2="38" stroke="currentColor" stroke-width="1"
              stroke-dasharray="1.5 1.5" opacity="0.35" vector-effect="non-scaling-stroke"/>
      </svg>
    `;
  }

  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;

  const coords = points.map((p, i) => ({
    // A single bucket would divide by zero; pin it to the left edge instead.
    x: points.length === 1 ? 0 : (i / (points.length - 1)) * 100,
    y: 40 - ((p - min) / range) * 35,
  }));
  // 与看板延迟趋势共用的平滑曲线生成器（bootstrap.js）。
  const { line, area } = buildSmoothSparkPaths(coords, {
    baselineY: 40,
    minY: 0,
    maxY: 40,
  });

  // One id per chart: several cards render at once, and a duplicate id would
  // make every later chart reuse the first card's gradient.
  const gradientId = `sparkline-gradient-${++sparklineGradientSeq}`;

  return `
    <svg class="sparkline-svg" viewBox="0 0 100 40" preserveAspectRatio="none"
         role="img" aria-label="近 6 小时请求量趋势">
      <defs>
        <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="currentColor" stop-opacity="0.25" />
          <stop offset="100%" stop-color="currentColor" stop-opacity="0.04" />
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#${gradientId})" />
      <path d="${line}" fill="none" stroke="currentColor" stroke-width="1.5"
            vector-effect="non-scaling-stroke"/>
      <line class="channel-spark-hover-guide" x1="0" y1="0" x2="0" y2="40" vector-effect="non-scaling-stroke" />
      <circle class="channel-spark-hover-dot" r="2.5" cx="0" cy="0" />
      <rect class="channel-spark-hit-area" x="0" y="0" width="100" height="40" />
    </svg>
    <div class="channel-spark-tooltip" role="status" hidden></div>
  `;
}

function bindChannelSparklineInteraction(container, values) {
  const svg = container?.querySelector(".sparkline-svg");
  const hitArea = svg?.querySelector(".channel-spark-hit-area");
  const guide = svg?.querySelector(".channel-spark-hover-guide");
  const dot = svg?.querySelector(".channel-spark-hover-dot");
  const tooltip = container?.querySelector(".channel-spark-tooltip");
  if (!svg || !hitArea || !guide || !dot || !tooltip || !Array.isArray(values) || values.length < 2) return;
  const { width, height } = CHANNEL_SPARK_VIEW;
  let frameId = null;
  let pendingEvent = null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const update = (event) => {
    pendingEvent = event;
    if (frameId != null) return;
    frameId = window.requestAnimationFrame(() => {
      frameId = null;
      if (!pendingEvent) return;
      const bounds = svg.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const ratio = Math.max(0, Math.min(1, (pendingEvent.clientX - bounds.left) / bounds.width));
      const position = ratio * (values.length - 1);
      const index = Math.min(values.length - 1, Math.floor(position));
      const next = Math.min(values.length - 1, index + 1);
      const progress = next === index ? 0 : position - index;
      const value = values[index] + (values[next] - values[index]) * progress;
      const x = ratio * width;
      const y = height - ((value - min) / range) * (height - 5);
      // 卡片宽度随窗口变化，缩放系数每帧重算，点才一直是圆的。
      const dotScaleX = sparkDotScaleX(bounds, CHANNEL_SPARK_VIEW);
      guide.setAttribute("x1", x);
      guide.setAttribute("x2", x);
      dot.setAttribute("transform", `scale(${dotScaleX} 1)`);
      dot.setAttribute("cx", x / dotScaleX);
      dot.setAttribute("cy", y);
      tooltip.innerHTML = `<strong>请求量 (6h)</strong><span>${formatMetric(Math.round(value))}</span>`;
      tooltip.hidden = false;
      tooltip.style.left = `${Math.min(Math.max(6, x * bounds.width / width + 8), container.clientWidth - tooltip.offsetWidth - 6)}px`;
      tooltip.style.top = `${Math.max(6, y * bounds.height / height - 32)}px`;
    });
  };
  const clear = () => {
    pendingEvent = null;
    if (frameId != null) window.cancelAnimationFrame(frameId);
    frameId = null;
    tooltip.hidden = true;
    svg.removeAttribute("data-hovering");
  };
  hitArea.addEventListener("pointerenter", (event) => {
    svg.dataset.hovering = "true";
    update(event);
  });
  hitArea.addEventListener("pointermove", update);
  hitArea.addEventListener("pointerleave", clear);
}

/* 统计数据按渠道缓存。渠道列表每 N 秒轮询一次，但统计的变化远没有那么快，
/* 统计数据按渠道缓存。渠道列表每 N 秒轮询一次，但统计的变化远没有那么快，
   而且每张卡一个请求。没有缓存的话，每轮刷新都要等 N 个请求回来才能重建卡片，
   那段空窗就是肉眼看到的闪烁。 */
const upstreamStatsCache = new Map();
const UPSTREAM_STATS_TTL_MS = 60_000;
const EMPTY_UPSTREAM_STATS = {
  sparkline: [],
  totalRequests: 0,
  cacheHitRate: 0,
  avgTokensPer1M: 0,
};

/** 缓存里的统计数据；没有或已过期返回 null。 */
function cachedUpstreamStats(upstreamId) {
  const entry = upstreamStatsCache.get(upstreamId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > UPSTREAM_STATS_TTL_MS) return null;
  return entry.stats;
}

/* 渠道 24h 健康历史（逐小时成功率/延迟）与 stats 同节奏拉取：独立缓存、
   同一个单飞 Promise，避免多一套轮询节奏。 */
const upstreamHealthCache = new Map();

function cachedUpstreamHealth(upstreamId) {
  const entry = upstreamHealthCache.get(upstreamId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > UPSTREAM_STATS_TTL_MS) return null;
  return entry.health;
}

/* 单飞（in-flight 去重）：缓存 60 秒后是所有渠道同时过期，而 renderCards 的
   触发点很密（定时刷新、SSE 事件、操作后重载）。过期瞬间几个触发点挤在一起，
   如果各自发请求，网络面板里就是 渠道数 × 触发次数 的一排 stats 并发。共享
   同一个 Promise 后，同一时刻至多一个批量请求在飞。 */
let statsRefreshPromise = null;

// Uses the shared api() helper so admin-token handling and 401 re-auth match
// the rest of the console. Returns whether the cache actually got refreshed.
async function fetchAllUpstreamStats() {
  try {
    const [payload, healthPayload] = await Promise.all([
      api("/api/admin/upstreams/stats"),
      api("/api/admin/upstreams/health?hours=24").catch(() => null),
    ]);
    const byId = payload && typeof payload.stats === "object" && payload.stats !== null
      ? payload.stats
      : {};
    const healthById = healthPayload && typeof healthPayload.entries === "object"
      ? healthPayload.entries
      : {};
    const fetchedAt = Date.now();
    /* 响应里没出现的渠道（还没有任何日志）也要写进缓存，否则它们永远是
       stale，每一轮渲染都会再触发一次批量请求。 */
    for (const upstream of upstreams) {
      const raw = byId[String(upstream.id)];
      upstreamStatsCache.set(upstream.id, {
        fetchedAt,
        stats: {
          sparkline: Array.isArray(raw?.sparkline) ? raw.sparkline : [],
          totalRequests: Number(raw?.totalRequests) || 0,
          cacheHitRate: Number(raw?.cacheHitRate) || 0,
          avgTokensPer1M: Number(raw?.avgTokensPer1M) || 0,
        },
      });
      const healthRaw = healthById[String(upstream.id)];
      upstreamHealthCache.set(upstream.id, {
        fetchedAt,
        health: {
          total: Number(healthRaw?.total) || 0,
          errors: Number(healthRaw?.errors) || 0,
          successRate: healthRaw && healthRaw.success_rate != null
            ? Number(healthRaw.success_rate)
            : null,
          avgMs: Number(healthRaw?.avg_ms) || 0,
          buckets: Array.isArray(healthRaw?.buckets) ? healthRaw.buckets : [],
        },
      });
    }
    return true;
  } catch (error) {
    /* 拉不到就先用旧缓存/占位显示，下个刷新周期自然重试。 */
    return false;
  }
}

/* 24h 健康迷你条形图：每根是一小时，高度按该小时请求量，颜色按错误占比。
   没有流量的小时不画——留白比一根零高的柱更诚实。 */
function renderHealthBars(health) {
  const buckets = Array.isArray(health?.buckets) ? health.buckets : [];
  if (!buckets.length) {
    return '<div class="health-bars-empty">24h 无请求</div>';
  }
  const maxTotal = Math.max(...buckets.map((bucket) => Number(bucket.total) || 0), 1);
  const bars = buckets.map((bucket) => {
    const total = Number(bucket.total) || 0;
    const errors = Number(bucket.errors) || 0;
    const height = Math.max(12, Math.round((total / maxTotal) * 100));
    const errorRatio = total > 0 ? errors / total : 1;
    const tone = errorRatio === 0 ? "ok" : errorRatio < 0.5 ? "warn" : "bad";
    const hour = new Date(Number(bucket.bucket_epoch) * 1000);
    const label = `${String(hour.getHours()).padStart(2, "0")}:00 · ${total} 请求`
      + (errors > 0 ? ` · 失败 ${errors}` : "");
    return `<span class="health-bar health-bar--${tone}" style="height:${height}%" title="${escapeHtml(label)}"></span>`;
  }).join("");
  return `<div class="health-bars" role="img" aria-label="24 小时逐小时健康，共 ${health.total} 请求，失败 ${health.errors}">${bars}</div>`;
}

/* 同步渲染：统计只从缓存读。缓存是空的就先出骨架，等后台补齐后单独替换这张卡，
   这样整个网格不会为了等统计而空掉。 */
function createChannelCard(upstream) {
  const card = document.createElement("div");
  card.className = "channel-card";
  if (!upstream.enabled) card.classList.add("channel-card--disabled");
  card.dataset.cardUpstreamId = String(upstream.id);

  const statusClass = upstream.enabled ? "live" : "offline";

  const stats = cachedUpstreamStats(upstream.id);
  const pending = stats === null;
  const resolved = stats || EMPTY_UPSTREAM_STATS;
  const sparklineData = resolved.sparkline.map(p => p.count);
  const totalRequests = pending ? "—" : formatMetric(resolved.totalRequests);
  const cacheHit = pending ? "—" : `${resolved.cacheHitRate.toFixed(1)}%`;
  // 本项目没有存储任何单价/费用字段，所以这里给的是每千次请求的平均
  // Token 消耗，作为成本的代理指标，而不是真实金额。
  const avgTokens = pending ? "—" : formatMetric(Math.round(resolved.avgTokensPer1M));
  const sixHourTotal = pending
    ? "—"
    : formatMetric(sparklineData.reduce((sum, n) => sum + n, 0));

  // 24h 健康：在线率 + 平均耗时 + 逐小时条形。stats 未到时同样先出骨架。
  const health = cachedUpstreamHealth(upstream.id);
  const healthPending = health === null;
  const hasTraffic = !healthPending && health.total > 0;
  const successLabel = healthPending || health.successRate == null
    ? "—"
    : `${(health.successRate * 100).toFixed(1)}%`;
  const successTone = healthPending || health.successRate == null
    ? ""
    : health.successRate >= 0.99 ? " is-ok" : health.successRate >= 0.9 ? " is-warn" : " is-bad";
  const healthLatency = healthPending || !hasTraffic || !health.avgMs
    ? "—"
    : formatSeconds(health.avgMs);

  card.innerHTML = `
    <div class="channel-card-header">
      <div class="channel-card-title">
        <span class="status-dot status-dot--${statusClass}"></span>
        <h3 title="${escapeHtml(upstream.name)}">${escapeHtml(upstream.name)}</h3>
      </div>
      <div class="channel-card-header-actions">
        <span class="channel-card-badge">优先级 ${upstream.priority}</span>
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
        <button
          type="button"
          class="secondary action-menu-trigger"
          data-menu-id="${upstream.id}"
          aria-haspopup="menu"
          aria-expanded="false"
          aria-label="打开 ${escapeHtml(upstream.name)} 的操作菜单"
          title="操作"
        ><span aria-hidden="true">⋮</span></button>
      </div>
    </div>
    <div class="channel-card-sparkline">
      <div class="sparkline-header">
        <span class="sparkline-label">请求量 (6h)</span>
        <span class="sparkline-value">${sixHourTotal}</span>
      </div>
      ${renderSparkline(sparklineData)}
    </div>
    <div class="channel-card-health">
      <div class="sparkline-header">
        <span class="sparkline-label">24h 健康</span>
        <span class="health-summary">
          <span class="health-stat${successTone}" title="24 小时成功率">在线率 ${successLabel}</span>
          <span class="health-stat" title="24 小时平均耗时">均延迟 ${healthLatency}</span>
        </span>
      </div>
      ${renderHealthBars(healthPending ? null : health)}
    </div>
    <div class="channel-card-metrics">
      <div class="metric-tile">
        <span class="metric-label">总请求</span>
        <span class="metric-value">${totalRequests}</span>
      </div>
      <div class="metric-tile">
        <span class="metric-label">缓存命中</span>
        <span class="metric-value">${cacheHit}</span>
      </div>
      <div class="metric-tile metric-tile--wide" title="项目未存储价格数据，此处为每千次请求的平均 Token 消耗">
        <span class="metric-label">平均 Token / 千次请求</span>
        <span class="metric-value">${avgTokens}</span>
      </div>
    </div>
    <button type="button" class="channel-card-action" data-card-detail="${upstream.id}">
      查看详情 →
    </button>
  `;
  bindChannelSparklineInteraction(card.querySelector(".channel-card-sparkline"), sparklineData);

  return card;
}

/* 把缓存里没有的统计补齐，回来后只替换对应那张卡。 */
async function hydrateVisibleCardStats(upstreamList) {
  if (!upstreamList.some((item) => cachedUpstreamStats(item.id) === null)) return;

  if (!statsRefreshPromise) {
    statsRefreshPromise = fetchAllUpstreamStats().finally(() => {
      statsRefreshPromise = null;
    });
  }
  const refreshed = await statsRefreshPromise;
  /* 失败时不重渲染也不递归重试——缓存仍是 stale，下一次 renderCards（定时
     刷新触发）自然会再拉一次；在这里重试会变成失败循环。 */
  if (!refreshed) return;
  // 期间可能已经切回列表视图。
  if (currentUpstreamView !== "grid" || !upstreamCardsContainer) return;

  for (const upstream of getFilteredUpstreams()) {
    const existing = upstreamCardsContainer.querySelector(
      `[data-card-upstream-id="${upstream.id}"]`,
    );
    if (!existing) continue;
    // 菜单开在这张卡上时先不动它，否则菜单会失去锚点。
    if (upstream.id === openActionMenuUpstreamId) continue;
    existing.replaceWith(createChannelCard(upstream));
  }
}

/* 就地对齐已有卡片，不整体重建。渠道列表每 N 秒轮询，整体重建会让网格闪一下，
   而且会打断正在打开的操作菜单。 */
function renderCards() {
  if (!upstreamCardsContainer) return;

  const filtered = getFilteredUpstreams();

  if (upstreamsLoading && !upstreamsLoadedOnce) {
    upstreamCardsContainer.innerHTML = '<div class="cards-loading">加载中…</div>';
    return;
  }

  if (upstreamsLoadedOnce && upstreams.length === 0 && !upstreamFiltersActive()) {
    upstreamCardsContainer.innerHTML = `
      <div class="cards-empty">
        <p>暂无渠道</p>
        <p class="cards-empty-sub">还没有配置上游渠道。创建后即可按优先级与模型规则路由请求。</p>
        <button type="button" class="secondary" data-empty-action="new-upstream">新增渠道</button>
      </div>
    `;
    return;
  }

  if (upstreamsLoadedOnce && filtered.length === 0) {
    upstreamCardsContainer.innerHTML = `
      <div class="cards-empty">
        <p>无匹配渠道</p>
        <p class="cards-empty-sub">当前筛选条件下没有结果。可调整搜索词或状态筛选。</p>
        <button type="button" class="secondary" data-empty-action="clear-upstream-filters">清除筛选</button>
      </div>
    `;
    return;
  }

  // 上一次留下的加载中/空状态占位要先清掉。
  const placeholder = upstreamCardsContainer.querySelector(".cards-loading, .cards-empty");
  if (placeholder) upstreamCardsContainer.innerHTML = "";

  const existingCards = new Map();
  for (const card of upstreamCardsContainer.querySelectorAll("[data-card-upstream-id]")) {
    existingCards.set(Number(card.dataset.cardUpstreamId), card);
  }

  let position = null;
  for (const upstream of filtered) {
    const existing = existingCards.get(upstream.id);
    existingCards.delete(upstream.id);

    let card;
    if (existing && Number(existing.dataset.cardUpstreamId) === openActionMenuUpstreamId) {
      // 菜单开在这张卡上，保持这个节点，替换会让菜单丢掉锚点。
      card = existing;
    } else {
      card = createChannelCard(upstream);
      if (existing) {
        existing.replaceWith(card);
      }
    }

    // 按筛选顺序把卡片排好。位置已经正确时 insertBefore 不会触发重排。
    const expectedNext = position ? position.nextSibling : upstreamCardsContainer.firstChild;
    if (card !== expectedNext) {
      upstreamCardsContainer.insertBefore(card, expectedNext);
    }
    position = card;
  }

  // 已被筛掉或删除的卡片。
  for (const orphan of existingCards.values()) {
    orphan.remove();
  }

  void hydrateVisibleCardStats(filtered);
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

function liveEffectiveRecoverySeconds(upstream) {
  if (!upstream.effectiveRecoveryAtMs) {
    return 0;
  }
  return Math.max(0, Math.ceil((upstream.effectiveRecoveryAtMs - Date.now()) / 1000));
}

function updateEffectiveWeightNotes() {
  for (const note of rows.querySelectorAll("[data-effective-zero-id]")) {
    const upstream = upstreams.find((item) => item.id === Number(note.dataset.effectiveZeroId));
    const remaining = upstream ? liveEffectiveRecoverySeconds(upstream) : 0;
    note.textContent = upstream ? formatZeroWeightNote(upstream, remaining) : "";
    note.hidden = !upstream || Number(upstream.effective_weight) > 0;
  }
  scheduleRenderUpstreamSummary();
}

function actionMenuMarkup(upstreamId) {
  return `
    <button type="button" role="menuitem" data-action="test-model" data-id="${upstreamId}">测试模型</button>
    <button type="button" role="menuitem" data-action="test" data-id="${upstreamId}">测试连接</button>
    <button type="button" role="menuitem" data-action="balance" data-id="${upstreamId}">查询 new-api 余额</button>
    <button type="button" role="menuitem" data-action="balance-sub2api" data-id="${upstreamId}">查询 sub2api 余额</button>
    <button type="button" role="menuitem" data-action="models" data-id="${upstreamId}">拉取模型</button>
    <div class="action-menu-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="edit" data-id="${upstreamId}">编辑</button>
    <button type="button" role="menuitem" data-action="duplicate" data-id="${upstreamId}">复制渠道</button>
    <button type="button" role="menuitem" data-action="copy-info" data-id="${upstreamId}">复制渠道信息</button>
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
  openActionMenuUpstreamId = Number(button.dataset.menuId);
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
  openActionMenuUpstreamId = null;
  upstreamActionMenu.style.removeProperty("left");
  upstreamActionMenu.style.removeProperty("top");
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
  /* 锚点脱离文档或落在 display:none 子树里时 rect 全为 0，按它算会把菜单
     夹到视口角落。宁可关掉，也不要画在错误位置。 */
  if (!activeActionMenuButton.isConnected || (!triggerRect.width && !triggerRect.height)) {
    closeUpstreamActionMenu();
    return;
  }
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
      upstream.effectiveRecoveryAtMs = upstream.health_recovery_remaining_seconds
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

// ── 渠道导入导出 ──────────────────────────────────────────────

/// Checked rows win; with no selection the whole list is exported.
function channelExportScope() {
  const ids = [...selectedUpstreamIds];
  if (ids.length > 0) {
    return { ids, count: ids.length, all: false };
  }
  return { ids: null, count: upstreams.length, all: true };
}

function buildChannelExportFilename(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `wildtoken-channels-${stamp}.json`;
}

function renderChannelExportScope() {
  if (!channelExportScopeEl) return;
  const scope = channelExportScope();
  const detail = scope.all
    ? `将导出全部 ${scope.count} 个渠道。勾选表格行可只导出选中的渠道。`
    : `将导出已勾选的 ${scope.count} 个渠道。`;
  channelExportScopeEl.textContent = detail;
}

function openChannelExportDialog() {
  renderChannelExportScope();
  if (typeof channelExportDialog.showModal === "function") {
    channelExportDialog.showModal();
  } else {
    channelExportDialog.setAttribute("open", "");
  }
  channelExportConfirm.focus();
}

function closeChannelExportDialog() {
  clearDialogMaximized(channelExportDialog);
  if (channelExportDialog.open && typeof channelExportDialog.close === "function") {
    channelExportDialog.close();
  } else {
    channelExportDialog.removeAttribute("open");
  }
}

function downloadJsonFile(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // Give the navigation a tick before reclaiming the object URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function runChannelExport() {
  const scope = channelExportScope();
  if (scope.count === 0) {
    setStatus("没有可导出的渠道。", "error");
    return;
  }
  const includeKeys = Boolean(channelExportIncludeKeys?.checked);
  channelExportConfirm.disabled = true;
  try {
    const document_ = await api("/api/admin/upstreams/export", {
      method: "POST",
      body: JSON.stringify({ ids: scope.ids, include_api_keys: includeKeys }),
    });
    const count = Array.isArray(document_.channels) ? document_.channels.length : 0;
    downloadJsonFile(buildChannelExportFilename(), JSON.stringify(document_, null, 2));
    closeChannelExportDialog();
    setStatus(
      `已导出 ${count} 个渠道${includeKeys ? "（含 API Key）" : "（不含 API Key）"}。`,
      "ok",
    );
  } catch (error) {
    setStatus(`导出失败：${error.message}`, "error");
  } finally {
    channelExportConfirm.disabled = false;
  }
}

/// Parse and shape-check a pasted or uploaded document. Throws a Chinese
/// message so the caller can surface it directly.
function parseChannelImportDocument(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    throw new Error("请选择文件或粘贴 JSON 内容。");
  }
  if (raw.length > CHANNEL_IMPORT_MAX_BYTES) {
    throw new Error("文档过大，请拆分后再导入。");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`不是合法 JSON：${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("文档顶层必须是一个 JSON 对象。");
  }
  if (parsed.kind !== undefined && parsed.kind !== CHANNEL_DOCUMENT_KIND) {
    throw new Error(`不是渠道导出文件：kind 应为 ${CHANNEL_DOCUMENT_KIND}。`);
  }
  if (typeof parsed.version === "number" && parsed.version > CHANNEL_DOCUMENT_VERSION) {
    throw new Error(`文档版本 ${parsed.version} 高于当前支持的 ${CHANNEL_DOCUMENT_VERSION}。`);
  }
  if (!Array.isArray(parsed.channels)) {
    throw new Error("文档缺少 channels 数组。");
  }
  if (parsed.channels.length === 0) {
    throw new Error("文档里没有渠道。");
  }
  if (parsed.channels.length > CHANNEL_IMPORT_MAX_ENTRIES) {
    throw new Error(`一次最多导入 ${CHANNEL_IMPORT_MAX_ENTRIES} 个渠道。`);
  }
  for (const [index, channel] of parsed.channels.entries()) {
    if (!channel || typeof channel !== "object" || Array.isArray(channel)) {
      throw new Error(`第 ${index + 1} 个渠道不是对象。`);
    }
    if (typeof channel.name !== "string" || !channel.name.trim()) {
      throw new Error(`第 ${index + 1} 个渠道缺少 name。`);
    }
    if (typeof channel.base_url !== "string" || !channel.base_url.trim()) {
      throw new Error(`渠道「${channel.name}」缺少 base_url。`);
    }
  }
  return parsed;
}

function selectedChannelImportMode() {
  const checked = channelImportDialog?.querySelector(
    "input[name='channel-import-mode']:checked",
  );
  return checked?.value === "overwrite" ? "overwrite" : "skip";
}

function renderChannelImportPreview(message = "", tone = "") {
  if (!channelImportPreview) return;
  channelImportPreview.dataset.tone = tone;
  channelImportPreview.textContent = message;
}

/// Re-parse whatever is in the textarea and reflect it in the preview and the
/// confirm button's enabled state.
function refreshChannelImportPreview() {
  const raw = channelImportText.value.trim();
  if (!raw) {
    channelImportParsed = null;
    channelImportConfirm.disabled = true;
    renderChannelImportPreview();
    return;
  }
  try {
    channelImportParsed = parseChannelImportDocument(raw);
    const channels = channelImportParsed.channels;
    const withKeys = channels.filter((channel) => typeof channel.api_key === "string" && channel.api_key).length;
    const existing = channels.filter(
      (channel) => upstreams.some((item) => item.name === String(channel.name).trim()),
    ).length;
    const parts = [`共 ${channels.length} 个渠道`];
    parts.push(withKeys > 0 ? `${withKeys} 个带 API Key` : "均不含 API Key");
    if (existing > 0) {
      const mode = selectedChannelImportMode();
      parts.push(`${existing} 个与现有渠道同名，将被${mode === "overwrite" ? "覆盖" : "跳过"}`);
    }
    renderChannelImportPreview(`${parts.join("；")}。`, "ok");
    channelImportConfirm.disabled = false;
  } catch (error) {
    channelImportParsed = null;
    channelImportConfirm.disabled = true;
    renderChannelImportPreview(error.message, "error");
  }
}

function openChannelImportDialog() {
  channelImportParsed = null;
  channelImportText.value = "";
  if (channelImportFile) {
    channelImportFile.value = "";
  }
  const skipRadio = channelImportDialog?.querySelector(
    "input[name='channel-import-mode'][value='skip']",
  );
  if (skipRadio) {
    skipRadio.checked = true;
  }
  channelImportConfirm.disabled = true;
  renderChannelImportPreview();
  if (typeof channelImportDialog.showModal === "function") {
    channelImportDialog.showModal();
  } else {
    channelImportDialog.setAttribute("open", "");
  }
  channelImportFile?.focus();
}

function closeChannelImportDialog() {
  clearDialogMaximized(channelImportDialog);
  if (channelImportDialog.open && typeof channelImportDialog.close === "function") {
    channelImportDialog.close();
  } else {
    channelImportDialog.removeAttribute("open");
  }
}

async function loadChannelImportFile(file) {
  if (!file) return;
  if (file.size > CHANNEL_IMPORT_MAX_BYTES) {
    renderChannelImportPreview("文件过大，请拆分后再导入。", "error");
    channelImportConfirm.disabled = true;
    return;
  }
  try {
    channelImportText.value = await file.text();
    refreshChannelImportPreview();
  } catch (error) {
    renderChannelImportPreview(`读取文件失败：${error.message}`, "error");
    channelImportConfirm.disabled = true;
  }
}

function formatChannelImportResult(result) {
  const parts = [];
  if (result.created) parts.push(`新增 ${result.created}`);
  if (result.updated) parts.push(`覆盖 ${result.updated}`);
  if (result.skipped) parts.push(`跳过 ${result.skipped}`);
  if (result.failed) parts.push(`失败 ${result.failed}`);
  return parts.length > 0 ? parts.join("，") : "没有变更";
}

async function runChannelImport() {
  if (!channelImportParsed) {
    refreshChannelImportPreview();
    return;
  }
  const mode = selectedChannelImportMode();
  channelImportConfirm.disabled = true;
  const originalLabel = channelImportConfirm.textContent;
  channelImportConfirm.textContent = "正在导入";
  try {
    const result = await api("/api/admin/upstreams/import", {
      method: "POST",
      body: JSON.stringify({
        kind: channelImportParsed.kind,
        version: channelImportParsed.version,
        channels: channelImportParsed.channels,
        mode,
      }),
    });
    await loadUpstreams();
    const summary = formatChannelImportResult(result);
    if (result.failed > 0) {
      const firstFailure = (result.items || []).find((item) => item.action === "failed");
      const reason = firstFailure ? `：${firstFailure.name} ${firstFailure.message || ""}`.trim() : "";
      renderChannelImportPreview(`导入完成，${summary}${reason}`, "error");
      setStatus(`导入完成：${summary}。`, "error");
    } else {
      closeChannelImportDialog();
      setStatus(`导入完成：${summary}。`, "ok");
    }
  } catch (error) {
    renderChannelImportPreview(`导入失败：${error.message}`, "error");
    setStatus(`导入失败：${error.message}`, "error");
  } finally {
    channelImportConfirm.textContent = originalLabel;
    channelImportConfirm.disabled = !channelImportParsed;
  }
}

// View toggle event listeners
if (viewGridBtn) {
  viewGridBtn.addEventListener("click", () => setUpstreamView("grid"));
}

if (viewListBtn) {
  viewListBtn.addEventListener("click", () => setUpstreamView("list"));
}

/* 卡片视图的点击代理。走的是列表视图那一套 openUpstreamActionMenu /
   handleUpstreamAction，所以查余额、拉取模型、测试连接这些操作在两个视图里
   行为完全一致。 */
if (upstreamCardsContainer) {
  upstreamCardsContainer.addEventListener("click", async (event) => {
    const emptyAction = event.target.closest("button[data-empty-action]");
    if (emptyAction) {
      if (emptyAction.dataset.emptyAction === "new-upstream") {
        resetForm();
        openUpstreamDialog();
      } else if (emptyAction.dataset.emptyAction === "clear-upstream-filters") {
        clearUpstreamFilters();
      }
      return;
    }

    const menuButton = event.target.closest("button[data-menu-id]");
    if (menuButton) {
      openUpstreamActionMenu(menuButton);
      return;
    }

    const detailBtn = event.target.closest("[data-card-detail]");
    if (detailBtn) {
      const upstream = upstreams.find((item) => item.id === Number(detailBtn.dataset.cardDetail));
      if (upstream) await editUpstream(upstream);
      return;
    }

    const actionButton = event.target.closest("button[data-action]");
    if (actionButton) {
      await handleUpstreamAction(actionButton);
    }
  });
}

// Initialize view on page load
if (currentUpstreamView === "grid") {
  setUpstreamView("grid");
}


