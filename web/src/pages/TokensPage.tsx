import { useCallback, useEffect, useState } from "react";

import {
  UnauthorizedError,
  createToken,
  deleteToken,
  listGroups,
  listTokens,
  resetTokenUsage,
  setTokenEnabled,
  updateToken,
} from "../api";
import { copyText } from "../clipboard";
import { ActionMenu, MENU_SEPARATOR } from "../components/ActionMenu";
import type { MenuEntry } from "../components/ActionMenu";
import { TokenDialog } from "../components/TokenDialog";
import type { TokenPayload } from "../components/TokenDialog";
import { useConfirm, useToast } from "../components/feedback";
import {
  expiryDistance,
  expiryTone,
  formatCount,
  quotaTone,
  tokenPreview,
} from "../tokenFormat";
import type { APIToken } from "../types";

/** 创建于明文保存启用之前的令牌，完整值已经取不回来了。 */
const SEALED_TITLE = "这个令牌创建于明文保存启用之前，完整值已经无法恢复。需要完整令牌只能删除后重建。";

/** 大数字缩写，和限额输入框接受的写法对称。四级与旧版 formatTokenCount 一致。 */
/**
 * 配额单元格。嵌套照抄旧版 quotaCell：限速注记在 quota-cell 外面并列，
 * 不在里面。两个分隔符把已用 / 剩余 / 限额 隔开。
 */
function QuotaCell({ token }: { token: APIToken }) {
  const quota = token.quota;
  const used = Number(quota.used_tokens) || 0;
  const allowed = token.allowed_models ?? [];
  const rateNote = (
    <>
      {token.rate_limit ? (
        <span className="muted quota-rate-note" title={`限速 ${token.rate_limit}`}>
          {token.rate_limit}
        </span>
      ) : null}
      {allowed.length > 0 ? (
        <span className="muted quota-rate-note" title={`允许的模型：\n${allowed.join("\n")}`}>
          {allowed.length} 个模型
        </span>
      ) : null}
    </>
  );

  if (quota.limit_tokens === null || quota.limit_tokens === undefined) {
    return (
      <>
        <span className="quota-cell" title={`已用 ${used.toLocaleString()} tokens，未设限额`}>
          <span className="quota-used">{formatCount(used)}</span>
          <span className="quota-sep">/</span>
          <span className="muted">不限</span>
        </span>
        {rateNote}
      </>
    );
  }

  const limit = Number(quota.limit_tokens) || 0;
  const remaining = Number(quota.remaining_tokens) || 0;
  // 用尽标红、接近用尽标黄，好在一列里扫出该处理哪个。
  const toneName = quotaTone({ exhausted: quota.exhausted, used, limit });
  const tone = toneName ? ` ${toneName}` : "";

  return (
    <>
      <span
        className={`quota-cell${tone}`}
        title={`已用 ${used.toLocaleString()} / 剩余 ${remaining.toLocaleString()} / 限额 ${limit.toLocaleString()} tokens`}
      >
        <span className="quota-used">{formatCount(used)}</span>
        <span className="quota-sep">/</span>
        <span className="quota-remaining">{formatCount(remaining)}</span>
        <span className="quota-sep">/</span>
        <span className="quota-limit">{quota.limit_expression || formatCount(limit)}</span>
      </span>
      {rateNote}
    </>
  );
}

export function TokensPage({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const [tokens, setTokens] = useState<APIToken[]>([]);
  const [groups, setGroups] = useState<Array<{ id: number; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ token: APIToken | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const toast = useToast();
  const confirm = useConfirm();

  const reload = useCallback(async () => {
    try {
      setTokens(await listTokens());
      setError("");
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    listGroups()
      .then(setGroups)
      .catch(() => setGroups([]));
  }, []);

  const filtered = tokens.filter((token) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    // 按看得见的那串匹配：屏上显示的已经不是后端那个前缀预览了。
    return [
      token.name,
      token.description,
      tokenPreview(token.token, token.token_preview),
      token.group_name,
    ]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });

  async function mutate(id: number, run: () => Promise<APIToken>) {
    setPending(id);
    try {
      const updated = await run();
      setTokens((list) => list.map((t) => (t.id === updated.id ? updated : t)));
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(err instanceof Error ? err.message : String(err), { tone: "error" });
    } finally {
      setPending(null);
    }
  }

  async function save(payload: TokenPayload) {
    const target = editing?.token;
    setSaving(true);
    try {
      /* 更新不收 enabled：启用状态走独立的开关接口，发过去会被严格解码
         拒掉整个请求（unknown field "enabled"）。新建才要带。 */
      const { enabled: _enabled, ...updatePayload } = payload;
      const saved = target
        ? await updateToken(target.id, updatePayload)
        : await createToken(payload);
      setEditing(null);
      await reload();
      toast(`令牌 ${saved.name} 已${target ? "保存" : "创建"}。`, { tone: "ok" });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`保存失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function remove(token: APIToken) {
    const ok = await confirm({
      title: "删除令牌？",
      message: `「${token.name}」将被删除，使用它的客户端会立刻失去访问。`,
      confirmLabel: "删除",
    });
    if (!ok) return;
    try {
      await deleteToken(token.id);
      await reload();
      toast(`令牌「${token.name}」已删除。`, { tone: "ok" });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`删除失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    }
  }

  /** 复制完整令牌。封存的行没有明文可复制。 */
  async function copyToken(token: APIToken) {
    if (!token.token) {
      toast(SEALED_TITLE, { tone: "warn", durationMs: 6000 });
      return;
    }
    try {
      await copyText(token.token);
      setCopiedId(token.id);
      window.setTimeout(() => setCopiedId((id) => (id === token.id ? null : id)), 2000);
      toast("完整令牌已复制。", { tone: "ok" });
    } catch {
      toast("复制失败：浏览器拒绝了剪贴板访问。", { tone: "error" });
    }
  }

  async function resetUsage(token: APIToken) {
    const ok = await confirm({
      title: "清零已用额度？",
      message: `「${token.name}」的累计用量将归零。这个计数养在令牌行上，不会随日志过期自动回落。`,
      confirmLabel: "清零",
      danger: false,
    });
    if (!ok) return;
    await mutate(token.id, () => resetTokenUsage(token.id));
    toast("已用额度已清零。", { tone: "ok" });
  }

  function menuFor(token: APIToken): MenuEntry[] {
    /* 显式标注：直接在字面量上接 .filter 会把 tone 的字面量类型放宽成 string。 */
    const entries: (MenuEntry | null)[] = [
      { key: "edit", label: "编辑", onSelect: () => setEditing({ token }) },
      { key: "copy", label: "复制完整令牌", onSelect: () => void copyToken(token) },
      /* 没设限额时不给这一项：计数本身不拦任何请求，清零没有意义。 */
      token.quota.limit_tokens === null || token.quota.limit_tokens === undefined
        ? null
        : { key: "reset", label: "清零已用额度", onSelect: () => void resetUsage(token) },
      MENU_SEPARATOR,
      { key: "delete", label: "删除", tone: "danger", onSelect: () => void remove(token) },
    ];
    return entries.filter((entry) => entry !== null);
  }

  return (
    <section className="view" data-view="tokens">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">DOWNSTREAM ACCESS</span>
            <h2>令牌</h2>
            <p>下游 API 访问凭证。</p>
          </div>
        </div>

        <div className="view-toolbar token-toolbar">
          <label className="filter-field">
            <input
              type="search"
              autoComplete="off"
              aria-label="搜索令牌"
              placeholder="名称、描述、预览…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="actions toolbar-actions">
            <button type="button" className="secondary" onClick={() => void reload()}>
              刷新
            </button>
            <button type="button" className="primary" onClick={() => setEditing({ token: null })}>
              新增令牌
            </button>
          </div>
        </div>

        {error ? (
          <p className="field-hint" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}

        <div className="table-wrap">
          <table className="admin-table token-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>描述</th>
                <th>令牌预览</th>
                <th>分组</th>
                <th className="col-quota">限额</th>
                <th className="col-expiry">有效期</th>
                <th className="col-status">状态</th>
                <th className="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="muted">加载中…</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="muted">
                    {tokens.length === 0 ? "暂无令牌" : "无匹配令牌"}
                  </td>
                </tr>
              ) : (
                filtered.map((token) => (
                  <TokenRow
                    key={token.id}
                    token={token}
                    busy={pending === token.id}
                    copied={copiedId === token.id}
                    menu={menuFor(token)}
                    onCopy={() => void copyToken(token)}
                    onToggle={() =>
                      void mutate(token.id, () => setTokenEnabled(token.id, !token.enabled))
                    }
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <TokenDialog
        open={editing !== null}
        token={editing?.token ?? null}
        groups={groups}
        busy={saving}
        onSubmit={(payload) => void save(payload)}
        onClose={() => setEditing(null)}
      />
    </section>
  );
}

/** 描述格。空值用破折号而不是连字符，有值时带 title 供悬停看全文。 */
function DescriptionCell({ text }: { text: string }) {
  const value = (text ?? "").trim();
  return (
    <td className="desc-cell">
      {value ? (
        <span className="muted" title={value}>
          {value}
        </span>
      ) : (
        <span className="muted is-empty">—</span>
      )}
    </td>
  );
}



/** 距今多久。旧版分钟/小时/天三档，过期直说已过期。 */
/**
 * 有效期格。
 *
 * 后端存的是不带时区标记的 UTC，直接 slice 字符串会把 UTC 当本地时间显示，
 * 差一个时区。旁边的徐章才是重点：一串日期看不出快到期了。
 */
function ExpiryCell({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return <span className="muted">永不过期</span>;

  const normalized = expiresAt.includes("T") ? expiresAt : expiresAt.replace(" ", "T");
  const withZone = /[Z+]|-\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`;
  const at = new Date(withZone);
  if (Number.isNaN(at.getTime())) return <span className="muted">—</span>;

  const delta = at.getTime() - Date.now();
  const tone = expiryTone(delta);
  return (
    <div className="token-expiry">
      <span className="token-expiry-time">{at.toLocaleString("zh-CN", { hour12: false })}</span>
      <span className={`badge ${tone}`}>{expiryDistance(delta)}</span>
    </div>
  );
}

/** 复制图标。必须是函数：每次调用产新节点，常量节点会被前一行偷走。 */
const copyGlyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="9" y="9" width="10" height="10" rx="2" />
    <path d="M5 15V7a2 2 0 0 1 2-2h8" />
  </svg>
);

const sealedGlyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);

/**
 * 预览：前 4 后 4，总长 ≤ 8 直接全显。
 *
 * 后端存的 token_preview 只有前缀，分辨不了同前缀的两把钥匙；带上尾部才能在
 * 列表里一眼区分。明文拿不到时（开明文保存之前建的行）退回后端那个。
 *
 * 用 Array.from 而不是 slice：按码元切会把超出 BMP 的字符斬成半个。
 */
function TokenRow({
  token,
  busy,
  copied,
  menu,
  onCopy,
  onToggle,
}: {
  token: APIToken;
  busy: boolean;
  copied: boolean;
  menu: MenuEntry[];
  onCopy: () => void;
  onToggle: () => void;
}) {
  const sealed = !token.token;

  return (
    <tr className={token.enabled ? undefined : "row-disabled"}>
      <td>
        <strong title={token.name}>{token.name}</strong>
      </td>
      <DescriptionCell text={token.description} />

      <td>
        {/* 预览片段本身就是复制按钮：表格已经八列，再塞一个独立按钮会挤掉别的列。 */}
        <button
          type="button"
          className={`token-preview-button${copied ? " is-confirmed" : ""}`}
          aria-disabled={sealed || undefined}
          aria-label={sealed ? `令牌 ${token.name} 的完整值不可复制` : `复制令牌 ${token.name} 的完整值`}
          title={sealed ? SEALED_TITLE : "复制完整令牌"}
          onClick={onCopy}
        >
          <code className="token-preview-code">
            {tokenPreview(token.token, token.token_preview)}
          </code>
          <span className="token-preview-icon" aria-hidden="true">
            {sealed ? sealedGlyph() : copyGlyph()}
          </span>
        </button>
      </td>

      {/* 纯文本，和旧版一致。做成徐章会和状态列里的徐章抢注意力，
          而分组只是归属，不是状态。 */}
      <td>{token.group_name || "default"}</td>

      <td className="col-quota">
        <QuotaCell token={token} />
      </td>

      <td className="col-expiry">
        <ExpiryCell expiresAt={token.expires_at} />
      </td>

      <td className="col-status">
        <button
          type="button"
          className={`status-switch ${token.enabled ? "on" : "off"}`}
          role="switch"
          aria-checked={token.enabled}
          aria-label={`${token.enabled ? "停用" : "启用"}令牌 ${token.name}`}
          title={token.enabled ? "点击停用" : "点击启用"}
          disabled={busy}
          onClick={onToggle}
        >
          <span className="status-switch-track" aria-hidden="true">
            <span className="status-switch-thumb" />
          </span>
        </button>
      </td>

      <td className="action-cell col-actions">
        <ActionMenu
          label={`${token.name} 的操作菜单`}
          entries={menu}
          trigger={({ ref, onClick, expanded }) => (
            <button
              ref={ref}
              type="button"
              className="secondary action-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={expanded}
              aria-label={`打开 ${token.name} 的操作菜单`}
              title="操作"
              disabled={busy}
              onClick={onClick}
            >
              <span aria-hidden="true">⋮</span>
            </button>
          )}
        />
      </td>
    </tr>
  );
}
