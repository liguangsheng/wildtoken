// ── Themes (registry-driven; switching saves immediately) ──
const THEME_KEY = "wildtoken_theme";
const themeToggle = document.querySelector("#theme-toggle");
const themeMenu = document.querySelector("#theme-menu");

// 新增主题时同步三处：此注册表、admin.html 头部内联白名单、base.css 变量块
const THEMES = [
  { id: "dark", label: "深色", swatch: ["#020617", "#22d3ee"] },
  { id: "light", label: "浅色", swatch: ["#f4f6fb", "#0891b2"] },
  { id: "win95", label: "Win95", swatch: ["#c0c0c0", "#000080"] },
  { id: "animal-island", label: "动物岛", swatch: ["#f8f8f0", "#19c8b9"] },
];

// 旧 id "animal" 迁移为 "animal-island"
function normalizeThemeId(value) {
  return value === "animal" ? "animal-island" : value;
}

function isKnownTheme(value) {
  return THEMES.some((theme) => theme.id === normalizeThemeId(value));
}

function themeLabel(id) {
  return THEMES.find((theme) => theme.id === id)?.label || id;
}

function themeMenuChoices() {
  return Array.from(themeMenu?.querySelectorAll("[data-theme-choice]") || []);
}

function focusThemeMenuChoice(position = "selected") {
  const choices = themeMenuChoices();
  if (!choices.length) return;
  const selectedIndex = Math.max(0, choices.findIndex((button) => button.classList.contains("is-selected")));
  const index = position === "first"
    ? 0
    : position === "last"
      ? choices.length - 1
      : selectedIndex;
  choices[index]?.focus();
}

function getStoredTheme() {
  try {
    const value = normalizeThemeId(localStorage.getItem(THEME_KEY));
    return isKnownTheme(value) ? value : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme) {
  const next = isKnownTheme(theme) ? normalizeThemeId(theme) : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore quota / private mode */
  }
  if (themeToggle) {
    const label = `选择主题（当前：${themeLabel(next)}）`;
    themeToggle.setAttribute("aria-label", label);
    themeToggle.title = label;
  }
  themeMenuChoices().forEach((button) => {
    const selected = button.dataset.themeChoice === next;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-checked", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  if (typeof updatePreferenceControls === "function") updatePreferenceControls();
}

function cycleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || getStoredTheme();
  const index = THEMES.findIndex((theme) => theme.id === current);
  applyTheme(THEMES[(index + 1) % THEMES.length].id);
}

function renderThemeChoices() {
  if (themeMenu) {
    themeMenu.innerHTML = THEMES.map(
      (theme) => `
      <button type="button" role="menuitemradio" aria-checked="false" data-theme-choice="${theme.id}">
        <span class="theme-swatch" style="--swatch-bg:${theme.swatch[0]};--swatch-accent:${theme.swatch[1]}" aria-hidden="true"></span>
        <span>${theme.label}</span>
      </button>`,
    ).join("");
  }
  if (settingsTheme) {
    settingsTheme.innerHTML = THEMES.map(
      (theme) => `<button type="button" data-theme-choice="${theme.id}">${theme.label}</button>`,
    ).join("");
  }
}

function setThemeMenuOpen(open, { focus = false, position = "selected" } = {}) {
  if (!themeMenu || !themeToggle) return;
  themeMenu.hidden = !open;
  themeToggle.setAttribute("aria-expanded", String(open));
  if (open && focus) focusThemeMenuChoice(position);
}

renderThemeChoices();
applyTheme(getStoredTheme());
if (themeToggle) {
  themeToggle.addEventListener("click", () => setThemeMenuOpen(Boolean(themeMenu?.hidden), { focus: true }));
  themeToggle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setThemeMenuOpen(true, { focus: true, position: event.key === "ArrowUp" ? "last" : "first" });
  });
}
themeMenu?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-theme-choice]");
  if (!button) return;
  applyTheme(button.dataset.themeChoice);
  setThemeMenuOpen(false);
  themeToggle?.focus();
});
themeMenu?.addEventListener("keydown", (event) => {
  const choices = themeMenuChoices();
  if (!choices.length) return;
  const currentIndex = Math.max(0, choices.indexOf(document.activeElement));
  let nextIndex = null;
  if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % choices.length;
  if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + choices.length) % choices.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = choices.length - 1;
  if (nextIndex !== null) {
    event.preventDefault();
    choices[nextIndex].focus();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    setThemeMenuOpen(false);
    themeToggle?.focus();
  }
});
themeMenu?.addEventListener("focusout", () => {
  window.setTimeout(() => {
    const active = document.activeElement;
    if (!themeMenu?.contains(active) && !themeToggle?.contains(active)) setThemeMenuOpen(false);
  }, 0);
});
document.addEventListener("click", (event) => {
  if (
    themeMenu && !themeMenu.hidden
    && !themeMenu.contains(event.target)
    && !themeToggle?.contains(event.target)
  ) {
    setThemeMenuOpen(false);
  }
});

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
routingSettingsForm?.addEventListener("submit", saveRoutingSettings);
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
dismissOnBackdropClick(modelTestTemplateDialog, closeModelTestTemplateDialog);
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

// ── Dashboard controls ───────────────────────────────────
if (dashboardRefreshButton) {
  dashboardRefreshButton.addEventListener("click", () => {
    loadDashboardData();
  });
}
if (dashboardTopWindowSelect) {
  dashboardTopWindowSelect.addEventListener("change", () => {
    const nextWindow = DASHBOARD_TOP_WINDOW_VALUES.has(dashboardTopWindowSelect.value)
      ? dashboardTopWindowSelect.value
      : "today";
    dashboardTopWindow = nextWindow;
    dashboardTopWindowSelect.value = nextWindow;
    try {
      localStorage.setItem(DASHBOARD_TOP_WINDOW_KEY, nextWindow);
    } catch {
      // Ignore storage failures; the selection still applies to the current page.
    }
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
      subtitle: THEMES.map((theme) => theme.label).join(" / "),
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
  dismissOnBackdropClick(commandPalette, closeCommandPalette);
  commandPalette.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeCommandPalette();
  });
}

document.addEventListener("keydown", (event) => {
  const key = event.key;
  const meta = event.metaKey || event.ctrlKey;
  const target = event.target;

  if (themeMenu && !themeMenu.hidden) {
    if (key === "Escape") {
      event.preventDefault();
      setThemeMenuOpen(false);
      themeToggle?.focus();
    }
    return;
  }

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

// Dialog maximize / restore (shared chrome next to close buttons).
document.addEventListener("click", (event) => {
  const button = event.target?.closest?.("[data-dialog-maximize]");
  if (!button) return;
  const dialog = button.closest("dialog");
  if (!dialog) return;
  event.preventDefault();
  toggleDialogMaximized(dialog);
});

// Start only after every classic script has registered its globals and listeners.
if (getAdminToken()) {
  initApp();
} else {
  openAdminTokenDialog();
}
