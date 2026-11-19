import { useCallback, useEffect, useRef, useState } from "react";

import {
  UnauthorizedError,
  createUpstream,
  deleteUpstream,
  exportUpstreams,
  fetchUpstreamHealth,
  fetchUpstreamStats,
  getUpstream,
  revealUpstreamKey,
  importUpstreams,
  listGroups,
  listUpstreams,
  setUpstreamArchived,
  setUpstreamEnabled,
  setUpstreamPriority,
  testUpstream,
  updateUpstream,
} from "../api";
import { copyText } from "../clipboard";
import { MENU_SEPARATOR } from "../components/ActionMenu";
import type { MenuEntry } from "../components/ActionMenu";
import { BalanceDialog } from "../components/BalanceDialog";
import type { BalanceProvider } from "../components/BalanceDialog";
import { ChannelCard } from "../components/ChannelCard";
import { ColumnMenu } from "../components/ColumnMenu";
import {
  ChannelExportDialog,
  ChannelImportDialog,
  QuickImportDialog,
} from "../components/ImportExportDialogs";
import { ModelTestDialog } from "../components/ModelTestDialog";
import { UpstreamDialog } from "../components/UpstreamDialog";
import type { UpstreamPayload } from "../components/UpstreamDialog";
import { ArchivedTable, UPSTREAM_COLUMNS, UpstreamTable } from "../components/UpstreamTable";
import { useConfirm, useToast } from "../components/feedback";
import {
  UPSTREAM_SORT_KEY,
  compareUpstreams,
  readStoredSort,
} from "../upstreamSort";
import type { SortKey } from "../upstreamSort";
import { readStored, writeStored } from "../storage";
import { upstreamCredentialsText } from "../upstreamCopy";
import { useColumns } from "../useColumns";
import { useFailure } from "../useFailure";
import { useKeyedActions } from "../useKeyedActions";
import { useListResource } from "../useListResource";
import { LoadError } from "../components/LoadError";
import type {
  ChannelExportDocument,
  DraftKey,
  ImportResult,
  Upstream,
  UpstreamHealth,
  UpstreamStats,
} from "../types";

type StatusFilter = "" | "enabled" | "disabled" | "effective-zero";

/** 把渠道的每把 key 取回明文：复制和撤销删除要带着它们建新渠道。 */
async function revealAllKeys(upstream: Upstream): Promise<DraftKey[]> {
  const keys = upstream.keys ?? [];
  const credentials = await Promise.all(keys.map((key) => revealUpstreamKey(upstream.id, key.id)));
  return credentials.map((credential, index) => ({
    name: credential.key_name,
    api_key: credential.api_key,
    enabled: keys[index].enabled,
  }));
}

const COLUMNS_STORAGE_KEY = "wildtoken_upstream_columns";
const VIEW_STORAGE_KEY = "wildtoken_upstream_view";

/**
 * 渠道页。
 *
 * 类名照抄旧控制台：主题 CSS 有 138 个类选择器，其中约 38 个由 JS 输出。
 * 照抄这些名字，6215 行主题样式一行不用改。
 */
export function UpstreamsPage({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const { items: upstreams, update: setUpstreams, loading, error, refreshing, reload } = useListResource(listUpstreams, onUnauthorized);
  const [groups, setGroups] = useState<Array<{ id: number; name: string }>>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const { pendingIds, run: runRowAction } = useKeyedActions<number>();
  const { pendingIds: pendingBatches, run: runBatch } = useKeyedActions<"enabled">();
  // 归档区默认收起，和旧版一致。
  const [archivedOpen, setArchivedOpen] = useState(false);
  // null = 关闭；{ upstream: null } = 新增；{ upstream } = 编辑。
  const [editing, setEditing] = useState<
    { upstream: Upstream | null; draftKeys?: DraftKey[]; startInModels?: boolean } | null
  >(null);
  const { pendingIds: pendingSaves, run: runSave } = useKeyedActions<"save">();
  const saving = pendingSaves.has("save");
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  // 站点存储被禁用时，取 localStorage 这个全局本身就会抛错。
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>(() => {
    try {
      return readStoredSort(localStorage);
    } catch {
      return readStoredSort(undefined);
    }
  });

  /* 排序偏好跟着列显隐一起落 localStorage：切页、刷新、换标签页都不丢，换设备
     归默认。写不进存储时当前页面仍然生效。 */
  const applySort = useCallback((next: { key: SortKey; desc: boolean }) => {
    setSort(next);
    try {
      localStorage.setItem(UPSTREAM_SORT_KEY, JSON.stringify(next));
    } catch {
      // 存储不可用时当前页面仍然生效。
    }
  }, []);
  // 列显隐和旧版共用一个存储键，两边切换不丢设置。
  const columns = useColumns(COLUMNS_STORAGE_KEY, UPSTREAM_COLUMNS);
  const [view, setView] = useState<"list" | "grid">(() => (readStored(VIEW_STORAGE_KEY) === "grid" ? "grid" : "list"));
  const [stats, setStats] = useState<Record<string, UpstreamStats>>({});
  const [health, setHealth] = useState<Record<string, UpstreamHealth>>({});
  const [exportDoc, setExportDoc] = useState<ChannelExportDocument | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportIncludeKeys, setExportIncludeKeys] = useState(true);
  /* 每次导出一个序号，只收最新那次的结果。带 Key 的导出要逐个查渠道、更慢，
     快速切换时它可能最后到，勾选框写着不含 Key，文件里却有。 */
  const exportRequest = useRef(0);
  const [importOpen, setImportOpen] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [busyDialog, setBusyDialog] = useState(false);
  const [testing, setTesting] = useState<Upstream | null>(null);
  const [balance, setBalance] = useState<{ upstream: Upstream; provider: BalanceProvider } | null>(null);

  const toast = useToast();
  const confirm = useConfirm();
  const fail = useFailure(onUnauthorized);

  /* 分组只为表单里的多选服务，拿不到不影响列表。 */
  useEffect(() => {
    listGroups()
      .then(setGroups)
      .catch(() => setGroups([]));
  }, []);

  /* 统计和健康只给卡片视图用，列表视图不请求——省两次没人看的往返。 */
  const reloadCards = useCallback(() => {
    fetchUpstreamStats()
      .then(setStats)
      .catch(() => setStats({}));
    fetchUpstreamHealth()
      .then(setHealth)
      .catch(() => setHealth({}));
  }, []);

  useEffect(() => {
    if (view === "grid") reloadCards();
  }, [view, reloadCards]);

  /** 「刷新」按钮：卡片视图下连统计和健康一起重拉。 */
  function refresh() {
    void reload();
    if (view === "grid") reloadCards();
  }

  function switchView(next: "list" | "grid") {
    setView(next);
    writeStored(VIEW_STORAGE_KEY, next);
  }

  /* 归档渠道走折叠区，不在主列表——和旧版一致。 */
  const active = upstreams.filter((u) => !u.archived);

  const matchesQuery = (upstream: Upstream) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [
      upstream.name,
      upstream.base_url,
      String(upstream.id),
      ...upstream.model_names,
      ...upstream.model_prefixes,
    ]
      .join(" ")
      .toLowerCase()
      .includes(q);
  };

  /* 归档区只吃搜索词：状态筛选描述的是路由状态，而归档渠道本就不参与
     路由，拿它去筛只会把折叠区筛成空的。 */
  const archived = upstreams.filter((u) => u.archived && matchesQuery(u));
  // 摘要里的归档数是总数，和「渠道」「启用」一样不随搜索词变。
  const archivedTotal = upstreams.length - active.length;

  const filtered = active
    .filter((u) => {
      if (status === "enabled" && !u.enabled) return false;
      if (status === "disabled" && u.enabled) return false;
      if (status === "effective-zero" && u.effective_weight > 0) return false;
      return matchesQuery(u);
    })
    .sort(compareUpstreams(sort));

  /* 选中集只对看得见勾选框的行有意义：筛掉的行、卡片视图里的卡片都没有勾选框，
     批量操作和导出不该动它们。 */
  const visibleSelected = view === "list" ? filtered.filter((u) => selected.has(u.id)) : [];

  /** 批量启停。一条失败不应该把剩下的也停下来，所以逐个跑完再报总数。 */
  async function batchSetEnabled(enabled: boolean) {
    await runBatch("enabled", async () => {
      const targets = visibleSelected.filter((u) => u.enabled !== enabled);
      if (targets.length === 0) {
        toast(`选中的渠道已经都是${enabled ? "启用" : "停用"}状态。`);
        return;
      }
      let ok = 0;
      let skipped = 0;
      const failures: string[] = [];
      for (const upstream of targets) {
        try {
          const result = await runRowAction(upstream.id, () => setUpstreamEnabled(upstream.id, enabled));
          if (!result.started) { skipped += 1; continue; }
          const updated = result.value;
          setUpstreams((list) => list.map((u) => (u.id === updated.id ? updated : u)));
          ok += 1;
        } catch (err) {
          if (err instanceof UnauthorizedError) {
            onUnauthorized(err.message);
            return;
          }
          failures.push(upstream.name);
        }
      }
      const note = skipped ? `；${skipped} 个正在操作，已跳过` : "";
      if (failures.length === 0) {
        toast(`已${enabled ? "启用" : "停用"} ${ok} 个渠道${note}。`, { tone: skipped ? "warn" : "ok" });
      } else {
        toast(`${ok} 个成功，${failures.length} 个失败：${failures.join("、")}${note}`, { tone: "error" });
      }
    });
  }

  /** 优先级行内编辑提交。值没变就不发请求。 */
  async function savePriority(upstream: Upstream, raw: string) {
    // 清空是放弃编辑，不是 0：Number("") 为 0，失焦就把渠道静默降到最低层。
    if (raw.trim() === "") return;
    const next = Number(raw);
    if (!Number.isInteger(next) || next === upstream.priority) return;
    // 和编辑抽屉同一范围。超出的值行内存得进去，之后抽屉却因为它保存不了。
    if (next < 0 || next > 100000) {
      toast("优先级需在 0 到 100000 之间。", { tone: "error" });
      return;
    }
    await mutate(upstream.id, () => setUpstreamPriority(upstream.id, next));
  }

  /**
   * 导出：有勾选就只导选中的，否则全部。
   *
   * 带不带密钥是服务端决定的，所以开关一变就得重新取一份，不能在前端裁。
   */
  async function runExport(includeKeys = exportIncludeKeys) {
    const request = ++exportRequest.current;
    setBusyDialog(true);
    setExportOpen(true);
    // 新文档回来之前旧的不能再下载：切掉「包含 API Key」后拿到的还是带 Key 的那份。
    setExportDoc(null);
    try {
      const doc = await exportUpstreams(visibleSelected.map((u) => u.id), includeKeys);
      if (request === exportRequest.current) setExportDoc(doc);
    } catch (err) {
      if (request !== exportRequest.current) return;
      fail(err, { prefix: "导出失败" });
      setExportOpen(false);
    } finally {
      if (request === exportRequest.current) setBusyDialog(false);
    }
  }

  async function runImport(doc: ChannelExportDocument, mode: "skip" | "overwrite") {
    setBusyDialog(true);
    try {
      const result = await importUpstreams(doc, mode);
      setImportResult(result);
      await reload();
      // 导入可能按名字新建了分组；不重拉的话分组列显示成 #id，编辑时也选不到。
      void listGroups()
        .then(setGroups)
        .catch(() => undefined);
      const tone = result.failed > 0 ? "warn" : "ok";
      toast(`新建 ${result.created} · 更新 ${result.updated} · 跳过 ${result.skipped} · 失败 ${result.failed}`, { tone });
    } catch (err) {
      fail(err, { prefix: "导入失败" });
    } finally {
      setBusyDialog(false);
    }
  }

  /**
   * 快速导入：不建渠道，只把识别到的值填进新增表单，由用户过一眼再保存。
   *
   * 走克隆那条已验证的路径——id 0 的草稿在表单里按新建对待。这样识别错了
   * 还能就地改，也能顺手配分组和高级项，而不是先落库再回头编辑。
   * 优先级给 999 而不是目录默认的 100：快速导入建的多是临时/测试渠道，
   * 要压过手工配的；它只是预填，用户可以改。
   */
  function runQuickImport(
    name: string,
    baseUrl: string,
    apiKey: string | null,
    modelNames: string[],
  ) {
    setQuickOpen(false);
    setEditing({
      upstream: {
        id: 0,
        name,
        base_url: baseUrl,
        api_key_set: false,
        key_count: 0,
        enabled_key_count: 0,
        keys: [],
        model_names: modelNames,
        model_prefixes: [],
        model_mappings: {},
        effort_mappings: {},
        priority: 999,
        weight: 100,
        auto_weight_enabled: false,
        enabled: true,
        archived: false,
        extra_headers: {},
        // 0 让表单留空，保存时按设置页的默认超时落库。
        timeout_seconds: 0,
        rate_limit: null,
        created_at: "",
        updated_at: "",
        runtime_health_score: 1,
        effective_weight: 100,
        group_ids: [],
      },
      draftKeys: apiKey ? [{ name: "", api_key: apiKey, enabled: true }] : undefined,
    });
  }

  async function mutate(id: number, run: () => Promise<Upstream>) {
    await runRowAction(id, async () => {
      try {
        const updated = await run();
        setUpstreams((list) => list.map((u) => (u.id === updated.id ? updated : u)));
      } catch (err) {
        fail(err, { prefix: "操作失败" });
      }
    });
  }

  /** 跑一个只报结果、不改列表的动作（测连接、拉模型、查余额）。 */
  async function runAction(id: number, label: string, run: () => Promise<unknown>) {
    await runRowAction(id, async () => {
      try {
        await run();
        toast(`${label}成功。`, { tone: "ok" });
      } catch (err) {
        fail(err, { prefix: `${label}失败` });
      }
    });
  }

  async function saveUpstream(payload: UpstreamPayload) {
    const target = editing?.upstream;
    /* 克隆塞进来的是 id 0 的草稿：按新建保存，而不是 PUT /upstreams/0
       （后端对 0 查不到行，回 404，克隆就永远存不下）。 */
    const isEdit = target != null && target.id > 0;
    await runSave("save", async () => {
      try {
        const saved = isEdit ? await updateUpstream(target.id, payload) : await createUpstream(payload);
        setEditing(null);
        await reload();
        const existing = upstreams.find((u) => u.id === saved.id);
        const action = isEdit ? "保存" : existing?.archived ? "恢复并更新" : existing ? "覆盖" : "创建";
        toast(`渠道 ${saved.name} 已${action}。`, { tone: "ok" });
      } catch (err) {
        fail(err, { prefix: "保存失败" });
      }
    });
  }

  /**
   * 编辑前重拉一次：列表里的那份可能不是最新的。
   *
   * 「拉取模型」也走这里，带 startInModels：抽屉直接落在管理模型并拉目录。
   */
  async function openEditor(upstream: Upstream, extra: { startInModels?: boolean } = {}) {
    try {
      setEditing({ upstream: await getUpstream(upstream.id), ...extra });
    } catch (err) {
      fail(err, { prefix: "读取渠道失败" });
    }
  }

  /** 复制：拿完整配置开一个新建表单，名字加后缀，key 逐把取回来作为新 key 预填。 */
  async function duplicate(upstream: Upstream) {
    const full = await getUpstream(upstream.id).catch(() => upstream);
    let draftKeys: DraftKey[] | undefined;
    try {
      draftKeys = await revealAllKeys(full);
    } catch (err) {
      if (err instanceof UnauthorizedError) return onUnauthorized(err.message);
      toast("取 Key 失败，副本里的 Key 需要重填。", { tone: "error" });
    }
    setEditing({ upstream: { ...full, id: 0, name: `${full.name}-copy`, api_key_set: false, keys: [] }, draftKeys });
  }

  async function removeUpstream(upstream: Upstream) {
    const confirmed = await confirm({
      title: "删除渠道？",
      message: `「${upstream.name}」将被删除。已产生的日志保留，但不再关联到这个渠道。`,
      confirmLabel: "删除",
    });
    if (!confirmed) return;
    await runRowAction(upstream.id, () => deleteWithUndo(upstream));
  }

  async function deleteWithUndo(upstream: Upstream) {
    /* 先把配置和每把 key 拿到手，删掉之后才能提供「撤销」——后端没有回收站，
       撤销实际上是用同一份配置重建。取 key 失败就不给撤销：重建出来没有 key
       的渠道，不算撤销。 */
    let snapshot: Upstream | null = null;
    let snapshotKeys: DraftKey[] = [];
    try {
      snapshot = await getUpstream(upstream.id);
      snapshotKeys = await revealAllKeys(snapshot);
    } catch {
      snapshot = null;
    }
    try {
      await deleteUpstream(upstream.id);
      await reload();
      toast(`渠道「${upstream.name}」已删除。`, {
        tone: "ok",
        durationMs: 9000,
        actionLabel: snapshot ? "撤销" : undefined,
        onAction: snapshot
          ? async () => {
              /* 快照来自详情，key 是删之前取回的明文，按新 key 重建。归档的渠道
                 带上归档状态和归档前的启用状态，后端在同一个事务里重建并归档，
                 恢复出来还在归档区。 */
              const { id: _id, api_key_set: _set, ...rest } = snapshot;
              try {
                await createUpstream({
                  ...rest,
                  keys: snapshotKeys.map((key) => ({ id: 0, ...key })),
                  enabled: snapshot.archived ? Boolean(snapshot.enabled_before_archive) : snapshot.enabled,
                });
                await reload();
                toast(`已恢复渠道「${snapshot.name}」。`, { tone: "ok" });
              } catch (err) {
                // 提示条的按钮不接异常，这里不报的话，失败时提示条直接消失。
                fail(err, { prefix: "恢复失败" });
              }
            }
          : undefined,
      });
    } catch (err) {
      fail(err, { prefix: "删除失败" });
    }
  }

  async function copyCredentials(upstream: Upstream) {
    try {
      const full = await getUpstream(upstream.id);
      const keys = await revealAllKeys(full);
      await copyText(upstreamCredentialsText(full.base_url, keys));
      toast(keys.length ? "渠道地址和 API Key 已复制。" : "渠道地址已复制，未配置 API Key。", { tone: "ok" });
    } catch (err) {
      fail(err, { prefix: "复制失败" });
    }
  }

  /** 归档渠道的菜单不给测试类动作——对不路由的渠道测连接说明不了任何事。 */
  function menuFor(upstream: Upstream): MenuEntry[] {
    if (upstream.archived) {
      return [
        { key: "unarchive", label: "恢复", tone: "primary", onSelect: () => void mutate(upstream.id, () => setUpstreamArchived(upstream.id, false)) },
        { key: "edit", label: "编辑", onSelect: () => void openEditor(upstream) },
        { key: "copy-credentials", label: "复制地址和 API Key", onSelect: () => void copyCredentials(upstream) },
        MENU_SEPARATOR,
        { key: "delete", label: "删除", tone: "danger", onSelect: () => void removeUpstream(upstream) },
      ];
    }
    return [
      /* 顺序照抄旧版：测试模型在最上面。它是唯一会真的走一遍路由的动作，
         排查渠道能不能用时第一个要点的就是它。 */
      { key: "test-model", label: "测试模型", onSelect: () => setTesting(upstream) },
      { key: "test", label: "测试连接", onSelect: () => void runAction(upstream.id, "测试连接", () => testUpstream(upstream.id)) },
      { key: "models", label: "拉取模型", onSelect: () => void openEditor(upstream, { startInModels: true }) },
      { key: "balance", label: "查询 new-api 余额", onSelect: () => setBalance({ upstream, provider: "new-api" }) },
      { key: "balance-sub2api", label: "查询 sub2api 余额", onSelect: () => setBalance({ upstream, provider: "sub2api" }) },
      MENU_SEPARATOR,
      { key: "edit", label: "编辑", onSelect: () => void openEditor(upstream) },
      { key: "duplicate", label: "复制渠道", onSelect: () => void duplicate(upstream) },
      { key: "copy-credentials", label: "复制地址和 API Key", onSelect: () => void copyCredentials(upstream) },
      MENU_SEPARATOR,
      { key: "archive", label: "归档", onSelect: () => void mutate(upstream.id, () => setUpstreamArchived(upstream.id, true)) },
      { key: "delete", label: "删除", tone: "danger", onSelect: () => void removeUpstream(upstream) },
    ];
  }

  return (
    <section className="view" data-view="upstreams">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">UPSTREAM ROUTING</span>
            <h2>渠道</h2>
            <p>按模型匹配、硬优先级和有效权重路由上游请求。</p>
          </div>
        </div>

        <div id="upstream-summary" className="summary-strip" aria-live="polite">
          <Summary label="渠道" value={active.length} />
          <Summary label="启用" value={active.filter((u) => u.enabled).length} />
          <Summary label="归档" value={archivedTotal} />
        </div>

        <div className="view-toolbar upstream-toolbar">
          <label className="filter-field">
            <input
              type="search"
              autoComplete="off"
              aria-label="搜索渠道"
              placeholder="名称、Base URL、模型…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="filter-field">
            <select
              aria-label="按状态筛选渠道"
              value={status}
              onChange={(event) => setStatus(event.target.value as StatusFilter)}
            >
              <option value="">全部</option>
              <option value="enabled">启用</option>
              <option value="disabled">停用</option>
              <option value="effective-zero">有效权重为 0</option>
            </select>
          </label>
          {/* 批量条只在有选中时出现，和旧版一致。 */}
          <div className="toolbar-batch" hidden={visibleSelected.length === 0}>
            <button type="button" className="secondary" disabled={pendingBatches.has("enabled")} onClick={() => void batchSetEnabled(true)}>
              批量启用
            </button>
            <button type="button" className="secondary" disabled={pendingBatches.has("enabled")} onClick={() => void batchSetEnabled(false)}>
              批量停用
            </button>
          </div>

          {view === "list" ? (
            <ColumnMenu
              label="渠道列显示"
              columns={UPSTREAM_COLUMNS}
              visible={columns.visible}
              onToggle={columns.toggle}
            />
          ) : null}

          <div className="view-toggle-wrap">
            <button
              type="button"
              className="secondary ghost view-toggle-btn"
              aria-pressed={view === "list"}
              aria-label="列表视图"
              title="列表视图"
              onClick={() => switchView("list")}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="18" x2="20" y2="18" />
              </svg>
            </button>
            <button
              type="button"
              className="secondary ghost view-toggle-btn"
              aria-pressed={view === "grid"}
              aria-label="卡片视图"
              title="卡片视图"
              onClick={() => switchView("grid")}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </button>
          </div>

          <div className="actions toolbar-actions">
            <button type="button" className="secondary" onClick={() => void runExport()}>
              导出
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setImportResult(null);
                setImportOpen(true);
              }}
            >
              导入
            </button>
            <button type="button" className="secondary" onClick={() => setQuickOpen(true)}>
              快速导入
            </button>
            <button type="button" className="secondary" onClick={refresh}>
              {refreshing ? "刷新中…" : "刷新"}
            </button>
            <button type="button" className="primary" onClick={() => setEditing({ upstream: null })}>
              新增渠道
            </button>
          </div>
        </div>

        <LoadError error={error} label="渠道" onRetry={refresh} />

        {/* 卡片视图和表格视图二选一。两边用同一份 filtered，筛选和排序不分家。 */}
        {view === "grid" ? (
          <div className="upstream-cards-grid">
            {loading ? (
              <div className="cards-loading">加载中…</div>
            ) : filtered.length === 0 ? (
              <div className="cards-empty">
                <p>{active.length === 0 ? "暂无渠道" : "无匹配渠道"}</p>
                <p className="cards-empty-sub">
                  {active.length === 0
                    ? "还没有配置上游渠道。创建后即可按优先级与模型规则路由请求。"
                    : "当前筛选条件下没有结果。可调整搜索词或状态筛选。"}
                </p>
              </div>
            ) : (
              filtered.map((upstream) => (
                <ChannelCard
                  key={upstream.id}
                  upstream={upstream}
                  stats={stats[String(upstream.id)] ?? null}
                  health={health[String(upstream.id)] ?? null}
                  busy={pendingIds.has(upstream.id)}
                  menu={menuFor(upstream)}
                  onToggle={() =>
                    void mutate(upstream.id, () => setUpstreamEnabled(upstream.id, !upstream.enabled))
                  }
                  onOpenDetail={() => void openEditor(upstream)}
                />
              ))
            )}
          </div>
        ) : (
          <UpstreamTable
            rows={filtered}
            groups={groups}
            loading={loading}
            emptyText={active.length === 0 ? "暂无渠道" : "无匹配渠道"}
            hiddenClasses={columns.hiddenClasses}
            pendingIds={pendingIds}
            selected={selected}
            onSelect={setSelected}
            sort={sort}
            onSort={applySort}
            menuFor={menuFor}
            onPriority={(upstream, raw) => void savePriority(upstream, raw)}
            onToggle={(upstream) => void mutate(upstream.id, () => setUpstreamEnabled(upstream.id, !upstream.enabled))}
          />
        )}

        {archived.length > 0 ? (
          <section className="archived-panel">
            {/* 默认收起。归档渠道是「暂时不用但不想删」的，日常不该占着视线；
                展开状态不持久化，刷新回到收起，和旧版一致。 */}
            <button
              type="button"
              className={`archived-toggle${archivedOpen ? " is-open" : ""}`}
              aria-expanded={archivedOpen}
              onClick={() => setArchivedOpen((open) => !open)}
            >
              <span className="archived-chevron" aria-hidden="true">
                ▸
              </span>
              <span className="archived-title">已归档渠道</span>
              <span className="archived-count">{archived.length}</span>
              <span className="archived-hint">不参与路由</span>
            </button>
            <div className="archived-body" hidden={!archivedOpen}>
              <ArchivedTable rows={archived} pendingIds={pendingIds} menuFor={menuFor} />
            </div>
          </section>
        ) : null}
      </section>

      <UpstreamDialog
        open={editing !== null}
        upstream={editing?.upstream ?? null}
        draftKeys={editing?.draftKeys}
        startInModels={editing?.startInModels}
        groups={groups}
        busy={saving}
        onSubmit={(payload) => void saveUpstream(payload)}
        onClose={() => setEditing(null)}
      />

      <ChannelExportDialog
        open={exportOpen}
        document={exportDoc}
        includeKeys={exportIncludeKeys}
        onToggleKeys={(next) => {
          setExportIncludeKeys(next);
          void runExport(next);
        }}
        onClose={() => {
          // 关窗后晚到的结果不该再写进下一次打开的窗口。
          exportRequest.current += 1;
          setExportOpen(false);
          setExportDoc(null);
          setBusyDialog(false);
        }}
      />

      <ChannelImportDialog
        open={importOpen}
        busy={busyDialog}
        result={importResult}
        onImport={(doc, mode) => void runImport(doc, mode)}
        onClose={() => setImportOpen(false)}
      />

      <QuickImportDialog
        open={quickOpen}
        onSubmit={(name, baseUrl, apiKey, modelNames) =>
          runQuickImport(name, baseUrl, apiKey, modelNames)
        }
        onClose={() => setQuickOpen(false)}
        onUnauthorized={onUnauthorized}
      />

      <ModelTestDialog open={testing !== null} upstream={testing} onClose={() => setTesting(null)} />

      <BalanceDialog
        open={balance !== null}
        upstream={balance?.upstream ?? null}
        provider={balance?.provider ?? "new-api"}
        onClose={() => setBalance(null)}
      />

    </section>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  /* 旧版的摘要格就是 <span><strong>值</strong>标签</span>，内部没有类名——
     样式靠 .summary-strip > span 定位。自己编 summary-item 那一套一个都不存在。 */
  return (
    <span>
      <strong>{value}</strong>
      {label}
    </span>
  );
}

