import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { UnauthorizedError, setAdminToken } from "./api";
import { AdminTokenDialog } from "./components/AdminTokenDialog";
import { CommandPalette } from "./components/CommandPalette";
import type { Command } from "./components/CommandPalette";
import { ConfirmProvider, ToastProvider } from "./components/feedback";
import { Topbar } from "./components/Topbar";
import {
  BUILTIN_THEMES,
  THEME_LABELS,
  THEME_PACKS,
  applyDensity,
  applyTheme,
  currentDensity,
  currentTheme,
} from "./theme";
import { DashboardPage } from "./pages/DashboardPage";
import { DebugPage } from "./pages/DebugPage";
import { GroupsPage } from "./pages/GroupsPage";
import { ImagePage } from "./pages/ImagePage";
import { LogsPage } from "./pages/LogsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TokensPage } from "./pages/TokensPage";
import { UpstreamsPage } from "./pages/UpstreamsPage";
import { getAdminToken } from "./api";

export type ViewId = "dashboard" | "upstreams" | "logs" | "tokens" | "groups" | "debug" | "images" | "settings";

const VIEWS: ViewId[] = ["dashboard", "upstreams", "logs", "tokens", "groups", "debug", "images", "settings"];

/** 默认落地页的偏好键，和旧控制台共用。 */
const DEFAULT_HOME_KEY = "wildtoken_default_home";
const FALLBACK_VIEW: ViewId = "dashboard";

/* 打开过就一直挂着、切走只隐藏的视图。这两页的请求一跑就是几十秒，切去看
   一眼日志回来，表单、结果和还在收流的请求都得还在。 */
const KEEP_ALIVE: readonly ViewId[] = ["debug", "images"];

function isView(value: string | null): value is ViewId {
  return value !== null && (VIEWS as string[]).includes(value);
}

function defaultHome(): ViewId {
  try {
    const saved = localStorage.getItem(DEFAULT_HOME_KEY);
    return isView(saved) ? saved : FALLBACK_VIEW;
  } catch {
    return FALLBACK_VIEW;
  }
}

/**
 * 当前视图看 URL hash。
 *
 * 只存在组件 state 里的话，刷新就回到初始值，浏览器前进后退也不工作，
 * 而且没办法把某一页发给别人。
 */
function viewFromHash(): ViewId {
  const name = window.location.hash.replace("#", "");
  return isView(name) ? name : defaultHome();
}

export function App() {
  const [view, setViewState] = useState<ViewId>(viewFromHash);
  const [needsToken, setNeedsToken] = useState(() => getAdminToken() === "");
  const [tokenError, setTokenError] = useState("");
  /* 页面的 key。自增一次就把页面重挂载一遍，它自己会重新取数，页面不必知道
     为什么。

     contentEpoch 管全部：登录成功时用（401 那一刻页面已经取数失败并停在空态，
     光关掉登录框界面会一直空着）。viewEpochs 只管一页：命令面板的「刷新当前
     视图」用——在日志页刷新，不该连带重置后台还挂着的调试页。 */
  const [contentEpoch, setContentEpoch] = useState(0);
  const [viewEpochs, setViewEpochs] = useState<Partial<Record<ViewId, number>>>({});
  const [keptAlive, setKeptAlive] = useState<ReadonlySet<ViewId>>(() => new Set());

  // 命令是 useMemo 里一次建好的，要靠 ref 读到当前视图。
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    if (!KEEP_ALIVE.includes(view)) return;
    setKeptAlive((current) => (current.has(view) ? current : new Set([...current, view])));
  }, [view]);

  const pageKey = (id: ViewId) => `${id}-${contentEpoch}-${viewEpochs[id] ?? 0}`;
  // 当前视图也算：effect 还没把它记进集合的那一帧，页面不能空着。
  const alive = (id: ViewId) => keptAlive.has(id) || view === id;

  /* 401 从任何请求里冒出来时统一处理：清掉令牌、弹登录框。旧控制台是在
     api() 里直接开弹窗，这里改成往上抛，由一处集中接住——组件不需要知道
     认证这回事。 */
  const handleUnauthorized = useCallback((message: string) => {
    setTokenError(message);
    setNeedsToken(true);
  }, []);

  useEffect(() => {
    const onUnauthorized = (event: Event) => {
      handleUnauthorized((event as CustomEvent<string>).detail);
    };
    window.addEventListener("console:unauthorized", onUnauthorized);
    return () => window.removeEventListener("console:unauthorized", onUnauthorized);
  }, [handleUnauthorized]);

  /* 切视图就写 hash，让浏览器历史记住它。写回 state 的活交给下面那个
     hashchange 监听，这样点导航和按浏览器后退走的是同一条路。 */
  const setView = useCallback((next: ViewId) => {
    if (window.location.hash === `#${next}`) {
      setViewState(next);
      return;
    }
    window.location.hash = next;
  }, []);

  useEffect(() => {
    const onHashChange = () => setViewState(viewFromHash());
    window.addEventListener("hashchange", onHashChange);
    // 进来时 hash 可能是空的，把当前落地页补回地址栏。
    if (!isView(window.location.hash.replace("#", ""))) {
      window.history.replaceState(null, "", `#${view}`);
    }
    return () => window.removeEventListener("hashchange", onHashChange);
    // 只在挂载时跑一次；view 只用于补地址栏的初始值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 只放真的能执行的命令。旧版面板里那些「G D」「R」标签从来没绑过键，
     标一个按下去没反应的快捷键比不标更糟。 */
  const commands = useMemo<Command[]>(() => {
    const views: Array<{ id: ViewId; label: string; hint: string }> = [
      { id: "dashboard", label: "看板", hint: "请求量、延时与错误汇总" },
      { id: "upstreams", label: "渠道", hint: "查看与管理上游渠道" },
      { id: "logs", label: "日志", hint: "查看代理请求日志" },
      { id: "tokens", label: "令牌", hint: "管理下游 API 令牌" },
      { id: "groups", label: "分组", hint: "隔离令牌可访问的渠道范围" },
      { id: "debug", label: "调试", hint: "向渠道发送自定义请求并对比响应" },
      { id: "images", label: "生图", hint: "向渠道发送生图请求并对比出图" },
      { id: "settings", label: "设置", hint: "控制台偏好与网关策略" },
    ];
    const themeIds = [...BUILTIN_THEMES, ...Object.keys(THEME_PACKS)];

    return [
      ...views.map((item) => ({
        id: `view-${item.id}`,
        title: `切换到${item.label}`,
        subtitle: item.hint,
        run: () => setView(item.id),
      })),
      {
        id: "refresh",
        title: "刷新当前视图",
        subtitle: "重新加载当前页数据",
        run: () => {
          const current = viewRef.current;
          setViewEpochs((epochs) => ({ ...epochs, [current]: (epochs[current] ?? 0) + 1 }));
        },
      },
      {
        id: "theme",
        title: "切换主题",
        subtitle: themeIds.map((id) => THEME_LABELS[id] ?? id).join(" / "),
        run: () => {
          const next = themeIds[(themeIds.indexOf(currentTheme()) + 1) % themeIds.length];
          applyTheme(next);
        },
      },
      {
        id: "density",
        title: "切换密度",
        subtitle: "舒适 / 紧凑",
        run: () => applyDensity(currentDensity() === "compact" ? "comfortable" : "compact"),
      },
      {
        id: "logout",
        title: "退出登录",
        subtitle: "清除 Admin Token 并重新登录",
        run: () => {
          setAdminToken("");
          broadcastUnauthorized("已退出，请重新输入管理员令牌。");
        },
      },
    ];
  }, []);

  return (
    <ToastProvider>
      <ConfirmProvider>
        <div className="app-shell">
          <Topbar view={view} onNavigate={setView} />
          <main className="content">
            {alive("debug") ? (
              <DebugPage key={pageKey("debug")} active={view === "debug"} onUnauthorized={handleUnauthorized} />
            ) : null}
            {alive("images") ? (
              <ImagePage key={pageKey("images")} active={view === "images"} onUnauthorized={handleUnauthorized} />
            ) : null}
            {/* key 带前缀：和上面常驻页同处一层，裸用 pageKey(view) 会跟它们撞 key。 */}
            <Fragment key={`routed-${pageKey(view)}`}>
              {KEEP_ALIVE.includes(view) ? null : view === "upstreams" ? (
                <UpstreamsPage onUnauthorized={handleUnauthorized} />
              ) : view === "logs" ? (
                <LogsPage onUnauthorized={handleUnauthorized} />
              ) : view === "tokens" ? (
                <TokensPage onUnauthorized={handleUnauthorized} />
              ) : view === "groups" ? (
                <GroupsPage onUnauthorized={handleUnauthorized} />
              ) : view === "settings" ? (
                <SettingsPage onUnauthorized={handleUnauthorized} />
              ) : view === "dashboard" ? (
                <DashboardPage onUnauthorized={handleUnauthorized} />
              ) : (
                <NotImplemented view={view} />
              )}
            </Fragment>
          </main>
          <AdminTokenDialog
            open={needsToken}
            error={tokenError}
            onClose={() => setNeedsToken(false)}
            onSubmitted={() => {
              setNeedsToken(false);
              setTokenError("");
              setContentEpoch((epoch) => epoch + 1);
            }}
          />

          <CommandPalette commands={commands} />
        </div>
      </ConfirmProvider>
    </ToastProvider>
  );
}

/**
 * 探针阶段只做渠道页。其余视图留个明确的占位，而不是空白——
 * 空白看起来像坏了。
 */
function NotImplemented({ view }: { view: ViewId }) {
  return (
    <section className="view" data-view={view}>
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">NOT PORTED YET</span>
            <h2>这个视图还没搬到新控制台</h2>
            <p>
              新控制台目前只实现了渠道页和日志页。旧版仍在 <a href="/admin">/admin</a> 上可用。
            </p>
          </div>
        </div>
      </section>
    </section>
  );
}

/** 供请求层在 401 时广播，App 统一接住。 */
export function broadcastUnauthorized(message: string): void {
  window.dispatchEvent(new CustomEvent("console:unauthorized", { detail: message }));
}

export { UnauthorizedError };
