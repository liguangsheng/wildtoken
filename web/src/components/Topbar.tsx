import { useEffect, useRef, useState } from "react";

import type { ViewId } from "../App";
import { setAdminToken } from "../api";
import {
  APPEARANCE_EVENT,
  BUILTIN_THEMES,
  THEME_LABELS,
  THEME_PACKS,
  THEME_SWATCHES,
  applyDensity,
  applyTheme,
  currentDensity,
  currentTheme,
} from "../theme";

const NAV: Array<{ id: ViewId; label: string }> = [
  { id: "dashboard", label: "看板" },
  { id: "upstreams", label: "渠道" },
  { id: "logs", label: "日志" },
  { id: "tokens", label: "令牌" },
  { id: "groups", label: "分组" },
  { id: "debug", label: "调试" },
  { id: "images", label: "生图" },
  { id: "settings", label: "设置" },
];

const THEME_IDS = [...BUILTIN_THEMES, ...Object.keys(THEME_PACKS)];

/**
 * 顶栏。类名照抄旧控制台——主题 CSS 里 138 个类选择器，靠的就是这些名字。
 * 组件内部怎么组织随意，往外发的 class 必须一致。
 */
export function Topbar({
  view,
  onNavigate,
}: {
  view: ViewId;
  onNavigate: (view: ViewId) => void;
}) {
  const [theme, setTheme] = useState(currentTheme);
  const [density, setDensity] = useState(currentDensity);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeWrapRef = useRef<HTMLDivElement>(null);

  /* 设置页也能改外观。不跟着重读的话，这里会拿着旧值，下一次点切换
     看上去没反应。 */
  useEffect(() => {
    const sync = () => {
      setTheme(currentTheme());
      setDensity(currentDensity());
    };
    window.addEventListener(APPEARANCE_EVENT, sync);
    return () => window.removeEventListener(APPEARANCE_EVENT, sync);
  }, []);

  // 点菜单外面或按 Esc 收起，和旧版行为一致。
  useEffect(() => {
    if (!themeMenuOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!themeWrapRef.current?.contains(event.target as Node)) setThemeMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setThemeMenuOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [themeMenuOpen]);

  function chooseTheme(next: string) {
    applyTheme(next);
    setTheme(next);
    setThemeMenuOpen(false);
  }

  function toggleDensity() {
    const next = density === "compact" ? "comfortable" : "compact";
    applyDensity(next);
    setDensity(next);
  }

  function logout() {
    // 清掉令牌后复用 401 那条通路，让 App 弹登录框——不另造一套。
    setAdminToken("");
    window.dispatchEvent(
      new CustomEvent<string>("console:unauthorized", { detail: "已退出，请重新输入管理员令牌。" }),
    );
  }

  const compact = density === "compact";

  return (
    <nav className="topbar">
      <div className="topbar-brand">
        <span className="brand-mark" aria-hidden="true">
          <BrandMark />
        </span>
        <div className="brand-text">
          <h1>WildToken</h1>
          <span className="brand-label">Admin</span>
        </div>
      </div>

      <div className="topbar-nav" role="tablist" aria-label="主导航">
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            /* 高亮认 .nav-link.active——base.css 和每个主题包都只写了这个选择器，
               光发 aria-selected 的话当前页在任何主题下都不会亮。 */
            className={view === item.id ? "nav-link active" : "nav-link"}
            role="tab"
            aria-selected={view === item.id}
            data-view={item.id}
            onClick={() => onNavigate(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="topbar-actions">
        {/* 自动刷新指示。旧版默认收起，只在轮询期间露出。 */}
        <span className="live-indicator" hidden title="自动刷新中">
          <span className="live-dot" aria-hidden="true" />
          <span className="live-label">实时</span>
        </span>

        <button
          type="button"
          className="secondary ghost density-toggle"
          aria-label={compact ? "切换到舒适密度" : "切换到紧凑密度"}
          title={compact ? "当前：紧凑 · 点击切换" : "当前：舒适 · 点击切换"}
          onClick={toggleDensity}
        >
          <span className="density-toggle-label">{compact ? "紧凑" : "舒适"}</span>
        </button>

        <div className="theme-menu-wrap" ref={themeWrapRef}>
          <button
            type="button"
            className="secondary ghost theme-toggle"
            aria-label="选择主题"
            title="选择主题"
            aria-haspopup="menu"
            aria-expanded={themeMenuOpen}
            onClick={() => setThemeMenuOpen((open) => !open)}
          >
            <span className="theme-toggle-icon" aria-hidden="true" />
          </button>
          <div className="theme-menu" role="menu" aria-label="主题列表" hidden={!themeMenuOpen}>
            {THEME_IDS.map((id) => {
              const swatch = THEME_SWATCHES[id] ?? ["#000000", "#ffffff"];
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={theme === id}
                  data-theme-choice={id}
                  onClick={() => chooseTheme(id)}
                >
                  <span
                    className="theme-swatch"
                    aria-hidden="true"
                    style={
                      {
                        "--swatch-bg": swatch[0],
                        "--swatch-accent": swatch[1],
                      } as React.CSSProperties
                    }
                  />
                  <span>{THEME_LABELS[id] ?? id}</span>
                </button>
              );
            })}
          </div>
        </div>

        <button type="button" className="secondary ghost nav-logout" onClick={logout}>
          退出
        </button>
      </div>
    </nav>
  );
}

function BrandMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="currentColor" />
      <path
        d="M32 14v18M32 32l15 10M32 32L17 42"
        stroke="var(--brand-ink)"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle cx="32" cy="14" r="4.5" fill="var(--brand-ink)" />
      <circle cx="47" cy="42" r="4.5" fill="var(--brand-ink)" />
      <circle cx="17" cy="42" r="4.5" fill="var(--brand-ink)" />
      <circle cx="32" cy="32" r="7" fill="var(--brand-ink)" />
      <circle cx="32" cy="32" r="3" fill="currentColor" />
    </svg>
  );
}
