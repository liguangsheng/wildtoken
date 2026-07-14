// Model selection plus application authentication and initial loading.
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
quickImportDialog.addEventListener("cancel", cancelQuickImportFetch);
quickImportText.addEventListener("input", syncQuickImportFields);
quickImportBaseUrlInput.addEventListener("input", updateQuickImportFillState);
quickImportApiKeyInput.addEventListener("input", updateQuickImportFillState);
quickImportFillButton.addEventListener("click", async () => {
  const baseUrl = quickImportBaseUrlInput.value.trim();
  const apiKey = quickImportApiKeyInput.value.trim();
  let models = [];
  let fetchError = null;

  if (baseUrl) {
    const controller = new AbortController();
    quickImportFetchController = controller;
    setQuickImportInputsDisabled(true);
    quickImportFillButton.textContent = "正在拉取模型";
    updateQuickImportFillState();
    setStatus(`正在从 ${baseUrl} 拉取全部模型...`);
    try {
      const result = await api("/api/admin/upstreams/fetch-models", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          base_url: baseUrl,
          api_key: apiKey || null,
          extra_headers: {},
          timeout_seconds: 300,
        }),
      });
      models = result.models;
    } catch (error) {
      if (error.name === "AbortError") {
        return;
      }
      fetchError = error;
    } finally {
      if (quickImportFetchController === controller) {
        quickImportFetchController = null;
        setQuickImportInputsDisabled(false);
        quickImportFillButton.textContent = QUICK_IMPORT_FILL_LABEL;
        updateQuickImportFillState();
      }
    }
  }

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
  fields.modelNames.value = joinList(models);
  fields.priority.value = QUICK_IMPORT_DEFAULT_PRIORITY;
  closeQuickImportDialog();
  openUpstreamDialog();
  if (fetchError) {
    setStatus(
      `已填入快速导入信息并将优先级设为 ${QUICK_IMPORT_DEFAULT_PRIORITY}；自动拉取模型失败：${fetchError.message}。可在表单中重试。`,
      "error",
    );
  } else if (baseUrl) {
    setStatus(
      `已填入 ${models.length} 个模型，优先级为 ${QUICK_IMPORT_DEFAULT_PRIORITY}。请检查后保存。`,
      "ok",
    );
  } else {
    setStatus(
      `已填入快速导入信息，优先级为 ${QUICK_IMPORT_DEFAULT_PRIORITY}。填写 Base URL 后可拉取模型。`,
      "ok",
    );
  }
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
  resetLogPagination();
  loadLogs();
});
if (logSearchInput) {
  logSearchInput.addEventListener("input", debounce(() => {
    resetLogPagination();
    loadLogs();
  }, 150));
}
if (logStatusFilter) {
  logStatusFilter.addEventListener("change", () => {
    resetLogPagination();
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
  if (logCursorStack.length === 0) return;
  logCurrentCursor = logCursorStack.pop() || null;
  logNextCursor = null;
  logOffset = Math.max(0, logOffset - LOG_PAGE_SIZE);
  loadLogs();
});
logNextButton.addEventListener("click", () => {
  if (!logHasMore || !logNextCursor) return;
  logCursorStack.push(logCurrentCursor);
  logCurrentCursor = logNextCursor;
  logNextCursor = null;
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
