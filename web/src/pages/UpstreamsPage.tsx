import { useCallback, useEffect, useState } from "react";

import {
  UnauthorizedError,
  createUpstream,
  deleteUpstream,
  exportUpstreams,
  fetchUpstreamHealth,
  fetchUpstreamModels,
  fetchUpstreamStats,
  getUpstream,
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
import { ActionMenu, MENU_SEPARATOR } from "../components/ActionMenu";
import type { MenuEntry } from "../components/ActionMenu";
import { BalanceDialog } from "../components/BalanceDialog";
import type { BalanceProvider } from "../components/BalanceDialog";
import { ChannelCard } from "../components/ChannelCard";
import {
  ChannelExportDialog,
  ChannelImportDialog,
  QuickImportDialog,
} from "../components/ImportExportDialogs";
import { ModelDialog } from "../components/ModelDialog";
import type { ModelSelection } from "../components/ModelDialog";
import { ModelTestDialog } from "../components/ModelTestDialog";
import { UpstreamDialog } from "../components/UpstreamDialog";
import type { UpstreamPayload } from "../components/UpstreamDialog";
import { useConfirm, useToast } from "../components/feedback";
import {
  UPSTREAM_SORT_KEY,
  compareUpstreams,
  readStoredSort,
} from "../upstreamSort";
import type { SortKey } from "../upstreamSort";
import type {
  ChannelExportDocument,
  ImportResult,
  Upstream,
  UpstreamHealth,
  UpstreamStats,
} from "../types";

type StatusFilter = "" | "enabled" | "disabled" | "effective-zero";

/** 可显隐的列。键名就是 data-col 的值，隐藏靠表格上的 col-hide-{key} 类。 */
const COLUMNS = [
  { key: "check", label: "选择" },
  { key: "id", label: "ID" },
  { key: "name", label: "渠道名" },
  { key: "models", label: "模型匹配" },
  { key: "groups", label: "分组" },
  { key: "priority", label: "优先级" },
  { key: "weight", label: "权重" },
  { key: "status", label: "状态" },
  { key: "actions", label: "操作" },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

/* 固定列不给隐藏：勾选、ID、渠道名、操作一藏，行就认不出或点不了。和旧版一致。 */
const LOCKED_COLUMNS: ReadonlySet<ColumnKey> = new Set(["check", "id", "name", "actions"]);

const COLUMNS_STORAGE_KEY = "wildtoken_upstream_columns";
const VIEW_STORAGE_KEY = "wildtoken_upstream_view";

function readColumns(): Record<ColumnKey, boolean> {
  const fallback = Object.fromEntries(COLUMNS.map((c) => [c.key, true])) as Record<ColumnKey, boolean>;
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (!raw) return fallback;

    // 旧存档里固定列可能是 false，读回时强制显示。
    const stored = { ...fallback, ...(JSON.parse(raw) as Record<string, boolean>) };
    for (const key of LOCKED_COLUMNS) stored[key] = true;
    return stored;
  } catch {
    // 存储不可用或内容坏了：全部显示。
    return fallback;
  }
}

/** 排序时的状态分档：启用 > 有效权重 0 > 停用，和旧版一致。 */


/**
 * 渠道页。
 *
 * 类名照抄旧控制台：主题 CSS 有 138 个类选择器，其中约 38 个由 JS 输出。
 * 照抄这些名字，6215 行主题样式一行不用改。
 */
export function UpstreamsPage({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const [upstreams, setUpstreams] = useState<Upstream[]>([]);
  const [groups, setGroups] = useState<Array<{ id: number; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [pending, setPending] = useState<number | null>(null);
  // 归档区默认收起，和旧版一致。
  const [archivedOpen, setArchivedOpen] = useState(false);
  // null = 关闭；{ upstream: null } = 新增；{ upstream } = 编辑。
  const [editing, setEditing] = useState<{ upstream: Upstream | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>(() => readStoredSort(localStorage));

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
  const [columns, setColumns] = useState<Record<ColumnKey, boolean>>(readColumns);
  const [colMenuOpen, setColMenuOpen] = useState(false);
  // 正在行内编辑优先级的渠道 id。
  const [editingPriority, setEditingPriority] = useState<number | null>(null);
  const [view, setView] = useState<"list" | "grid">(() => {
    try {
      return localStorage.getItem(VIEW_STORAGE_KEY) === "grid" ? "grid" : "list";
    } catch {
      return "list";
    }
  });
  const [stats, setStats] = useState<Record<string, UpstreamStats>>({});
  const [health, setHealth] = useState<Record<string, UpstreamHealth>>({});
  const [exportDoc, setExportDoc] = useState<ChannelExportDocument | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportIncludeKeys, setExportIncludeKeys] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [busyDialog, setBusyDialog] = useState(false);
  /* 模型选择器。catalog 和 selection 必须跟着这一个对象走：它们是弹窗重置
     效应的依赖，每次渲染新造一份的话每敲一下键盘都会把已选清回去。 */
  const [picker, setPicker] = useState<
    { upstream: Upstream; catalog: string[] | null; selection: ModelSelection } | null
  >(null);
  const [pickerSaving, setPickerSaving] = useState(false);
  const [testing, setTesting] = useState<Upstream | null>(null);
  const [balance, setBalance] = useState<{ upstream: Upstream; provider: BalanceProvider } | null>(null);

  const toast = useToast();
  const confirm = useConfirm();

  const reload = useCallback(async () => {
    try {
      setUpstreams(await listUpstreams());
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

  /* 分组只为表单里的多选服务，拿不到不影响列表。 */
  useEffect(() => {
    listGroups()
      .then(setGroups)
      .catch(() => setGroups([]));
  }, []);

  /* 统计和健康只给卡片视图用，列表视图不请求——省两次没人看的往返。 */
  useEffect(() => {
    if (view !== "grid") return;
    fetchUpstreamStats()
      .then(setStats)
      .catch(() => setStats({}));
    fetchUpstreamHealth()
      .then(setHealth)
      .catch(() => setHealth({}));
  }, [view]);

  function switchView(next: "list" | "grid") {
    setView(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // 存储不可用时当前页面仍然生效。
      return;
    }
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

  const filtered = active
    .filter((u) => {
      if (status === "enabled" && !u.enabled) return false;
      if (status === "disabled" && u.enabled) return false;
      if (status === "effective-zero" && u.effective_weight > 0) return false;
      return matchesQuery(u);
    })
    .sort(compareUpstreams(sort));

  /* 选中集只对当前筛选结果有意义：筛掉的行看不见，批量操作不该动它们。 */
  const visibleSelected = filtered.filter((u) => selected.has(u.id));
  const allVisibleSelected = filtered.length > 0 && visibleSelected.length === filtered.length;

  /** 列显隐存 localStorage，和旧版共用一个键，两边切换不丢设置。 */
  function toggleColumn(key: ColumnKey) {
    setColumns((current) => {
      const next = { ...current, [key]: !current[key] };
      try {
        localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // 存储不可用时当前页面仍然生效。
        return next;
      }
      return next;
    });
  }

  /** 批量启停。一条失败不应该把剩下的也停下来，所以逐个跑完再报总数。 */
  async function batchSetEnabled(enabled: boolean) {
    const targets = visibleSelected.filter((u) => u.enabled !== enabled);
    if (targets.length === 0) {
      toast(`选中的渠道已经都是${enabled ? "启用" : "停用"}状态。`);
      return;
    }
    let ok = 0;
    const failures: string[] = [];
    for (const upstream of targets) {
      try {
        const updated = await setUpstreamEnabled(upstream.id, enabled);
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
    if (failures.length === 0) {
      toast(`已${enabled ? "启用" : "停用"} ${ok} 个渠道。`, { tone: "ok" });
    } else {
      toast(`${ok} 个成功，${failures.length} 个失败：${failures.join("、")}`, { tone: "error" });
    }
  }

  /** 优先级行内编辑提交。值没变就不发请求。 */
  async function savePriority(upstream: Upstream, raw: string) {
    setEditingPriority(null);
    const next = Number(raw);
    if (!Number.isFinite(next) || next === upstream.priority) return;
    await mutate(upstream.id, () => setUpstreamPriority(upstream.id, next));
  }

  /**
   * 导出：有勾选就只导选中的，否则全部。
   *
   * 带不带密钥是服务端决定的，所以开关一变就得重新取一份，不能在前端裁。
   */
  async function runExport(includeKeys = exportIncludeKeys) {
    setBusyDialog(true);
    setExportOpen(true);
    try {
      setExportDoc(await exportUpstreams(visibleSelected.map((u) => u.id), includeKeys));
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`导出失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
      setExportOpen(false);
    } finally {
      setBusyDialog(false);
    }
  }

  async function runImport(doc: ChannelExportDocument, mode: "skip" | "overwrite") {
    setBusyDialog(true);
    try {
      const result = await importUpstreams(doc, mode);
      setImportResult(result);
      await reload();
      const tone = result.failed > 0 ? "warn" : "ok";
      toast(`新建 ${result.created} · 更新 ${result.updated} · 跳过 ${result.skipped} · 失败 ${result.failed}`, { tone });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`导入失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
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
        api_key: apiKey,
        /* 表单只用它决定要不要显示「清空 API Key」。草稿还没有已存的密钥，
           给 true 会让那个勾选框冒出来，勾了还会把刚填的 Key 清掉。 */
        api_key_set: false,
        model_names: modelNames,
        model_prefixes: [],
        model_mappings: {},
        effort_mappings: {},
        priority: 999,
        weight: 100,
        auto_weight_enabled: true,
        enabled: true,
        archived: false,
        extra_headers: {},
        timeout_seconds: 300,
        rate_limit: null,
        created_at: "",
        updated_at: "",
        runtime_health_score: 1,
        effective_weight: 100,
        group_ids: [],
      },
    });
  }

  async function mutate(id: number, run: () => Promise<Upstream>) {
    setPending(id);
    try {
      const updated = await run();
      setUpstreams((list) => list.map((u) => (u.id === updated.id ? updated : u)));
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  /** 跑一个只报结果、不改列表的动作（测连接、拉模型、查余额）。 */
  async function runAction(id: number, label: string, run: () => Promise<unknown>) {
    setPending(id);
    try {
      await run();
      toast(`${label}成功。`, { tone: "ok" });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`${label}失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    } finally {
      setPending(null);
    }
  }

  async function saveUpstream(payload: UpstreamPayload) {
    const target = editing?.upstream;
    /* 克隆塞进来的是 id 0 的草稿：按新建保存，而不是 PUT /upstreams/0
       （后端对 0 查不到行，回 404，克隆就永远存不下）。 */
    const isEdit = target != null && target.id > 0;
    setSaving(true);
    try {
      const saved = isEdit ? await updateUpstream(target.id, payload) : await createUpstream(payload);
      setEditing(null);
      await reload();
      toast(`渠道 ${saved.name} 已${isEdit ? "保存" : "创建"}。`, { tone: "ok" });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`保存失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  /**
   * 拉取上游模型列表，然后开选择器。
   *
   * 旧版就是这个顺序：拉到什么就拿什么作为候选，当前已选一并带进去。先重拉
   * 一次渠道，因为保存是整体替换，拿陈旧快照当底会把别人刚改的字段覆回去。
   */
  async function openModelPicker(upstream: Upstream) {
    setPending(upstream.id);
    try {
      const fresh = await getUpstream(upstream.id).catch(() => upstream);
      const result = await fetchUpstreamModels(upstream.id);
      setPicker({
        upstream: fresh,
        catalog: result.models,
        selection: { names: fresh.model_names, mappings: fresh.model_mappings || {} },
      });
      toast(`已拉取 ${result.models.length} 个模型。`, { tone: "ok" });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`拉取模型失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    } finally {
      setPending(null);
    }
  }

  /**
   * 把选择写回渠道。
   *
   * 这个弹窗只改模型，但 PUT 是整体替换：不带的字段会被后端按默认值写回去，
   * 也就是被清空。除了模型本身，其余全部原样回填。
   */
  async function saveModelSelection(next: ModelSelection) {
    if (!picker) return;
    const target = picker.upstream;
    setPickerSaving(true);
    try {
      await updateUpstream(target.id, {
        name: target.name,
        base_url: target.base_url,
        // null 加不清除，意思是「保持原有 Key」。
        api_key: null,
        clear_api_key: false,
        model_names: next.names,
        model_prefixes: target.model_prefixes,
        model_mappings: next.mappings,
        effort_mappings: target.effort_mappings || {},
        priority: target.priority,
        weight: target.weight,
        auto_weight_enabled: target.auto_weight_enabled,
        timeout_seconds: target.timeout_seconds,
        enabled: target.enabled,
        extra_headers: target.extra_headers || {},
        rate_limit: target.rate_limit ?? null,
        group_ids: target.group_ids ?? [],
      });
      setPicker(null);
      await reload();
      toast(`已保存 ${next.names.length} 个模型到 ${target.name}。`, { tone: "ok" });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`保存模型失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    } finally {
      setPickerSaving(false);
    }
  }

  /** 编辑前重拉一次：列表里的那份可能不是最新的。 */
  async function openEditor(upstream: Upstream) {
    try {
      setEditing({ upstream: await getUpstream(upstream.id) });
    } catch {
      setEditing({ upstream });
    }
  }

  /** 复制：拿完整配置开一个新建表单，名字加后缀。API Key 不会回来，得重填。 */
  async function duplicate(upstream: Upstream) {
    const full = await getUpstream(upstream.id).catch(() => upstream);
    setEditing({ upstream: { ...full, id: 0, name: `${full.name}-copy`, api_key_set: false } });
  }

  async function removeUpstream(upstream: Upstream) {
    const confirmed = await confirm({
      title: "删除渠道？",
      message: `「${upstream.name}」将被删除。已产生的日志保留，但不再关联到这个渠道。`,
      confirmLabel: "删除",
    });
    if (!confirmed) return;

    /* 先把配置拿到手，删掉之后才能提供「撤销」——后端没有回收站，
       撤销实际上是用同一份配置重建。API Key 回不来。 */
    const snapshot = await getUpstream(upstream.id).catch(() => null);
    try {
      await deleteUpstream(upstream.id);
      await reload();
      toast(`渠道「${upstream.name}」已删除。`, {
        tone: "ok",
        durationMs: 9000,
        actionLabel: snapshot ? "撤销" : undefined,
        onAction: snapshot
          ? async () => {
              const { id: _id, api_key_set: _set, ...rest } = snapshot;
              await createUpstream(rest);
              await reload();
              toast(`已恢复渠道「${snapshot.name}」，API Key 需重新填写。`, { tone: "ok" });
            }
          : undefined,
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`删除失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    }
  }

  async function copyInfo(upstream: Upstream) {
    const text = [
      `名称: ${upstream.name}`,
      `Base URL: ${upstream.base_url}`,
      `优先级: ${upstream.priority}`,
      `权重: ${upstream.weight}`,
      upstream.model_names.length ? `模型: ${upstream.model_names.join(", ")}` : null,
      upstream.model_prefixes.length ? `前缀: ${upstream.model_prefixes.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await copyText(text);
      toast("渠道信息已复制。", { tone: "ok" });
    } catch {
      toast("复制失败：浏览器拒绝了剪贴板访问。", { tone: "error" });
    }
  }

  /** 归档渠道的菜单不给测试类动作——对不路由的渠道测连接说明不了任何事。 */
  function menuFor(upstream: Upstream): MenuEntry[] {
    if (upstream.archived) {
      return [
        { key: "unarchive", label: "恢复", tone: "primary", onSelect: () => void mutate(upstream.id, () => setUpstreamArchived(upstream.id, false)) },
        { key: "edit", label: "编辑", onSelect: () => void openEditor(upstream) },
        { key: "copy-info", label: "复制渠道信息", onSelect: () => void copyInfo(upstream) },
        MENU_SEPARATOR,
        { key: "delete", label: "删除", tone: "danger", onSelect: () => void removeUpstream(upstream) },
      ];
    }
    return [
      /* 顺序照抄旧版：测试模型在最上面。它是唯一会真的走一遍路由的动作，
         排查渠道能不能用时第一个要点的就是它。 */
      { key: "test-model", label: "测试模型", onSelect: () => setTesting(upstream) },
      { key: "test", label: "测试连接", onSelect: () => void runAction(upstream.id, "测试连接", () => testUpstream(upstream.id)) },
      { key: "models", label: "拉取模型", onSelect: () => void openModelPicker(upstream) },
      { key: "balance", label: "查询 new-api 余额", onSelect: () => setBalance({ upstream, provider: "new-api" }) },
      { key: "balance-sub2api", label: "查询 sub2api 余额", onSelect: () => setBalance({ upstream, provider: "sub2api" }) },
      MENU_SEPARATOR,
      { key: "edit", label: "编辑", onSelect: () => void openEditor(upstream) },
      { key: "duplicate", label: "复制渠道", onSelect: () => void duplicate(upstream) },
      { key: "copy-info", label: "复制渠道信息", onSelect: () => void copyInfo(upstream) },
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
          <Summary label="归档" value={archived.length} />
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
            <button type="button" className="secondary" onClick={() => void batchSetEnabled(true)}>
              批量启用
            </button>
            <button type="button" className="secondary" onClick={() => void batchSetEnabled(false)}>
              批量停用
            </button>
          </div>

          <div className="col-menu-wrap">
            <button
              type="button"
              className="secondary ghost col-menu-btn"
              aria-haspopup="true"
              aria-expanded={colMenuOpen}
              onClick={() => setColMenuOpen((open) => !open)}
            >
              列
            </button>
            <div className="col-menu" hidden={!colMenuOpen} role="menu" aria-label="渠道列显示">
              {COLUMNS.map((column) => {
                const locked = LOCKED_COLUMNS.has(column.key);
                return (
                  <label key={column.key} className={locked ? "is-locked" : undefined}>
                    <input
                      type="checkbox"
                      checked={columns[column.key]}
                      disabled={locked}
                      onChange={() => toggleColumn(column.key)}
                    />
                    <span>{column.label + (locked ? "（固定）" : "")}</span>
                  </label>
                );
              })}
            </div>
          </div>

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
            <button type="button" className="secondary" onClick={() => void reload()}>
              刷新
            </button>
            <button type="button" className="primary" onClick={() => setEditing({ upstream: null })}>
              新增渠道
            </button>
          </div>
        </div>

        {error ? (
          <p className="field-hint" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}

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
                  busy={pending === upstream.id}
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
        <div className="table-wrap">
          {/* 列显隐靠表格上的 col-hide-{key} 类，CSS 负责藏对应的 td/th。 */}
          <table
            className={[
              "admin-table",
              "upstream-table",
              ...COLUMNS.filter((c) => !columns[c.key]).map((c) => `col-hide-${c.key}`),
            ].join(" ")}
          >
            <thead>
              <tr>
                <th className="col-check" data-col="check">
                  <input
                    type="checkbox"
                    aria-label="全选当前筛选渠道"
                    checked={allVisibleSelected}
                    onChange={(event) =>
                      setSelected(event.target.checked ? new Set(filtered.map((u) => u.id)) : new Set())
                    }
                  />
                </th>
                <SortableHeader
                  label="ID"
                  sortKey="id"
                  col="id"
                  className="col-id"
                  sort={sort}
                  onSort={applySort}
                />
                <SortableHeader label="渠道名" sortKey="name" col="name" sort={sort} onSort={applySort} />
                <th data-col="models">模型匹配</th>
                <th data-col="groups">分组</th>
                <SortableHeader
                  label="优先级"
                  sortKey="priority"
                  col="priority"
                  className="col-priority"
                  sort={sort}
                  onSort={applySort}
                />
                <th className="col-weight" data-col="weight">权重</th>
                <SortableHeader
                  label="状态"
                  sortKey="status"
                  col="status"
                  className="col-status"
                  sort={sort}
                  onSort={applySort}
                />
                <th className="col-actions" data-col="actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="muted">加载中…</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="muted">
                    {active.length === 0 ? "暂无渠道" : "无匹配渠道"}
                  </td>
                </tr>
              ) : (
                filtered.map((upstream) => (
                  <UpstreamRow
                    key={upstream.id}
                    upstream={upstream}
                    groups={groups}
                    busy={pending === upstream.id}
                    menu={menuFor(upstream)}
                    checked={selected.has(upstream.id)}
                    onCheck={(next) =>
                      setSelected((current) => {
                        const copy = new Set(current);
                        if (next) copy.add(upstream.id);
                        else copy.delete(upstream.id);
                        return copy;
                      })
                    }
                    editingPriority={editingPriority === upstream.id}
                    onPriorityEdit={() => setEditingPriority(upstream.id)}
                    onPriorityCommit={(raw) => void savePriority(upstream, raw)}
                    onPriorityCancel={() => setEditingPriority(null)}
                    onToggle={() => void mutate(upstream.id, () => setUpstreamEnabled(upstream.id, !upstream.enabled))}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
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
              <div className="table-wrap">
                <table className="admin-table upstream-table">
                  <tbody>
                    {archived.map((upstream) => (
                      <tr key={upstream.id} className="row-archived">
                        <td className="col-id">{upstream.id}</td>
                        <td className="name-cell">
                          <div className="name-stack">
                            <strong title={upstream.name}>{upstream.name}</strong>
                            <span className="url-cell-inner">{upstream.base_url}</span>
                          </div>
                        </td>
                        <td className="col-status">
                          <span className="archived-tag">
                            <span className="archived-tag-dot" aria-hidden="true" />
                            已归档
                          </span>
                        </td>
                        <td className="row-actions col-actions">
                          <ActionMenu
                            label={`${upstream.name} 的操作菜单`}
                            entries={menuFor(upstream)}
                            trigger={({ ref, onClick, expanded }) => (
                              <button
                                ref={ref}
                                type="button"
                                className="secondary action-menu-trigger"
                                aria-haspopup="menu"
                                aria-expanded={expanded}
                                aria-label={`打开 ${upstream.name} 的操作菜单`}
                                title="操作"
                                disabled={pending === upstream.id}
                                onClick={onClick}
                              >
                                <span aria-hidden="true">⋮</span>
                              </button>
                            )}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        ) : null}
      </section>

      <UpstreamDialog
        open={editing !== null}
        upstream={editing?.upstream ?? null}
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
          setExportOpen(false);
          setExportDoc(null);
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

      {picker ? (
        <ModelDialog
          open
          channelName={picker.upstream.name}
          catalog={picker.catalog}
          selection={picker.selection}
          busy={pickerSaving}
          onSave={(next) => void saveModelSelection(next)}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </section>
  );
}

/**
 * 可排序表头。
 *
 * aria-sort 和箭头跟着当前排序状态走，类名照抄旧版的 table-sort-button。
 * 点同一列翻转方向，点别的列从降序开始。
 */
function SortableHeader({
  label,
  sortKey,
  col,
  className,
  sort,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  col: string;
  className?: string;
  sort: { key: SortKey; desc: boolean };
  onSort: (next: { key: SortKey; desc: boolean }) => void;
}) {
  const activeSort = sort.key === sortKey;
  return (
    <th
      className={className}
      data-col={col}
      aria-sort={activeSort ? (sort.desc ? "descending" : "ascending") : "none"}
    >
      <button
        type="button"
        className="table-sort-button"
        onClick={() => onSort({ key: sortKey, desc: activeSort ? !sort.desc : true })}
      >
        {label} <span aria-hidden="true">{activeSort ? (sort.desc ? "↓" : "↑") : ""}</span>
      </button>
    </th>
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

/**
 * 只放行 http(s)。
 *
 * base_url 是管理员填的，不校就把一个 javascript: 开头的值变成了可点击的
 * 脚本执行入口。照抄旧版 normalizeHttpUrl。
 */
function httpUrlOrNull(value: string): string | null {
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

/**
 * Base URL 格。
 *
 * 旧版是 code 加两个按钮：复制、在新标签打开。只渲染纯文本的话，想拿地址
 * 去试一下得自己选中拷贝，而这一格宽度有限、地址常常被截。
 */
function BaseUrlCell({ upstream }: { upstream: Upstream }) {
  const toast = useToast();
  const openable = httpUrlOrNull(upstream.base_url);

  async function copy() {
    try {
      await copyText(upstream.base_url);
      toast("Base URL 已复制。", { tone: "ok" });
    } catch {
      toast("复制失败：浏览器拒绝了剪贴板访问。", { tone: "error" });
    }
  }

  return (
    <div className="url-cell-inner">
      <code title={upstream.base_url}>{upstream.base_url}</code>
      <span className="url-cell-actions" aria-label="Base URL 操作">
        <button
          type="button"
          className="secondary ghost url-action"
          aria-label={`复制 ${upstream.name} 的 Base URL`}
          title="复制 Base URL"
          onClick={() => void copy()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect x="9" y="9" width="10" height="10" rx="2" />
            <path d="M5 15V7a2 2 0 0 1 2-2h8" />
          </svg>
        </button>
        <button
          type="button"
          className="secondary ghost url-action"
          aria-label={`打开 ${upstream.name} 的 Base URL`}
          title={openable ? "打开 Base URL" : "不是可打开的 http(s) 地址"}
          disabled={openable === null}
          onClick={() => {
            /* 只放行 http/https：httpUrlOrNull 已经过一道，这里再卡一道协议，
               不让任何非白名单协议的地址进新标签。 */
            const url = httpUrlOrNull(upstream.base_url);
            if (!url || !/^https?:\/\//i.test(url)) return;
            window.open(url, "_blank", "noopener,noreferrer");
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M14 5h5v5" />
            <path d="M10 14 19 5" />
            <path d="M19 14v3a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3" />
          </svg>
        </button>
      </span>
    </div>
  );
}

/** 有效权重为 0 的原因。自动权重降到 0 时还要说清楚还有多久恢复。 */
function zeroWeightNote(upstream: Upstream): string {
  if (!upstream.auto_weight_enabled) return "固定权重 0 · 不参与路由";
  if (Number(upstream.weight) === 0) return "基础权重 0 · 不参与动态路由";
  const remaining = upstream.health_recovery_remaining_seconds;
  return remaining ? `有效权重 0 · ${remaining}s 后恢复` : "有效权重 0 · 等待恢复周期";
}

/** 整数不带小数点，非整数保留两位再去尾零。照抄旧版 formatEffectiveWeight。 */
function formatWeight(value: number): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number)
    ? String(number)
    : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** 旧版 MAX_MODEL_CHIPS：只显示前几个，剩下的折成 +N。 */
const MAX_MODEL_CHIPS = 5;

type Chip = { label: string; type: string };

/** 芯片列表。容器是 div 不是 span，全量标签放 title，和旧版 modelChipList 一致。 */
function ChipList({ items }: { items: Chip[] }) {
  const visible = items.slice(0, MAX_MODEL_CHIPS);
  const hiddenCount = items.length - visible.length;
  return (
    <div className="model-chip-list" title={items.map((item) => item.label).join(", ")}>
      {visible.map((item, index) => (
        <span key={`${item.type}-${item.label}-${index}`} className={`model-chip ${item.type}`}>
          {item.label}
        </span>
      ))}
      {hiddenCount > 0 ? <span className="model-chip more">{`+${hiddenCount}`}</span> : null}
    </div>
  );
}

/** 映射在前、精确名在中、前缀在后，顺序照抄旧版 modelMatchItems。 */
function modelMatchItems(upstream: Upstream): Chip[] {
  return [
    ...Object.entries(upstream.model_mappings || {}).map(([downstream, target]) => ({
      label: `${downstream}=>${target}`,
      type: "mapping",
    })),
    ...upstream.model_names.map((value) => ({ label: value, type: "name" })),
    ...upstream.model_prefixes.map((value) => ({ label: `${value}*`, type: "prefix" })),
  ];
}

function UpstreamRow({
  upstream,
  groups,
  busy,
  menu,
  checked,
  onCheck,
  editingPriority,
  onPriorityEdit,
  onPriorityCommit,
  onPriorityCancel,
  onToggle,
}: {
  upstream: Upstream;
  groups: Array<{ id: number; name: string }>;
  busy: boolean;
  menu: MenuEntry[];
  checked: boolean;
  onCheck: (next: boolean) => void;
  editingPriority: boolean;
  onPriorityEdit: () => void;
  onPriorityCommit: (raw: string) => void;
  onPriorityCancel: () => void;
  onToggle: () => void;
}) {
  const zeroWeight = upstream.effective_weight <= 0;
  return (
    <tr className={upstream.enabled ? undefined : "row-disabled"}>
      <td className="col-check" data-col="check">
        <input
          type="checkbox"
          className="upstream-row-check"
          aria-label={`选择渠道 ${upstream.name}`}
          checked={checked}
          onChange={(event) => onCheck(event.target.checked)}
        />
      </td>
      <td className="col-id" data-col="id">{upstream.id}</td>
      <td className="name-cell" data-col="name">
        <div className="name-stack">
          <strong title={upstream.name}>{upstream.name}</strong>
          <BaseUrlCell upstream={upstream} />
        </div>
      </td>
      <td className="match-cell" data-col="models">
        {modelMatchItems(upstream).length === 0 ? (
          <span className="muted">默认候选</span>
        ) : (
          <ChipList items={modelMatchItems(upstream)} />
        )}
      </td>

      {/* 分组格。漏了这一格表头 9 列、表体 8 列，其后所有单元格整体左移。 */}
      <td className="match-cell" data-col="groups">
        {upstream.group_ids.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          <ChipList
            items={upstream.group_ids.map((id) => ({
              label: groups.find((group) => group.id === id)?.name ?? `#${id}`,
              type: "group",
            }))}
          />
        )}
      </td>

      <td className="col-priority" data-col="priority">
        {/* 点数字变输入框，和旧版一致。失焦或回车提交，Esc 放弃。 */}
        {editingPriority ? (
          <input
            type="number"
            className="priority-input"
            min={0}
            max={100000}
            step={1}
            defaultValue={upstream.priority}
            autoFocus
            aria-label={`渠道 ${upstream.name} 的优先级`}
            onBlur={(event) => onPriorityCommit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onPriorityCommit(event.currentTarget.value);
              else if (event.key === "Escape") onPriorityCancel();
            }}
          />
        ) : (
          <button
            type="button"
            className="priority-value"
            aria-label={`修改渠道 ${upstream.name} 的优先级`}
            title="点击修改优先级"
            disabled={busy}
            onClick={onPriorityEdit}
          >
            {upstream.priority}
          </button>
        )}
      </td>
      <td className="col-weight" data-col="weight">
        {/* 动态权重显示「有效 / 基础」双值；关掉自动权重时只有基础值，
            此时 effective_weight 不参与路由，拿出来显示会让人误以为它生效。 */}
        <div className="weight-stack">
          {upstream.auto_weight_enabled ? (
            <>
              <strong>{`${formatWeight(upstream.effective_weight)} / ${formatWeight(upstream.weight)}`}</strong>
              <span>有效权重 / 基础权重</span>
            </>
          ) : (
            <>
              <strong>{formatWeight(upstream.weight)}</strong>
              <span>固定权重</span>
            </>
          )}
        </div>
      </td>
      <td className="col-status" data-col="status">
        <div className="status-stack">
          <button
            type="button"
            className={`status-switch ${upstream.enabled ? "on" : "off"}`}
            role="switch"
            aria-checked={upstream.enabled}
            aria-label={`${upstream.enabled ? "停用" : "启用"}渠道 ${upstream.name}`}
            title={upstream.enabled ? "点击停用" : "点击启用"}
            disabled={busy}
            onClick={onToggle}
          >
            <span className="status-switch-track" aria-hidden="true">
              <span className="status-switch-thumb" />
            </span>
          </button>
          {/* 三种 0 要分开说：固定权重 0、基础权重 0、被动态降到 0。
              只说「有效权重为 0」的话，前两种看起来像故障，其实是配的。 */}
          {zeroWeight ? (
            <span className="effective-zero-note">{zeroWeightNote(upstream)}</span>
          ) : null}
        </div>
      </td>
      <td className="row-actions col-actions" data-col="actions">
        <ActionMenu
          label={`${upstream.name} 的操作菜单`}
          entries={menu}
          trigger={({ ref, onClick, expanded }) => (
            <button
              ref={ref}
              type="button"
              className="secondary action-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={expanded}
              aria-label={`打开 ${upstream.name} 的操作菜单`}
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
