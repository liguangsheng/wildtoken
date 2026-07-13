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
