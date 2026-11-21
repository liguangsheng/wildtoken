/* 主题切换。和旧控制台共用 localStorage 键，两版之间切换保持选择。

   注意这里不注入任何 CSS：主题包由 index.html 的 document.write 加载，
   级联顺序必须和旧版一致。运行时再插 <link> 会落在它后面，把主题盖掉。 */

export const THEME_KEY = "wildtoken_theme";
export const THEME_CSS_KEY = "wildtoken_theme_css";
export const THEME_CSS_ID_KEY = "wildtoken_theme_css_id";

/** 主题包由后端 /theme-packs 提供，键是 id，值是 CSS 路径。 */
export const THEME_PACKS: Record<string, string> = {
  ark: "/theme-packs/ark/theme.css",
  endfield: "/theme-packs/endfield/theme.css",
  gojo: "/theme-packs/gojo/theme.css",
};

/** 内置主题不是主题包，没有额外 CSS 可加载。 */
export const BUILTIN_THEMES = ["dark", "light"] as const;

export const THEME_LABELS: Record<string, string> = {
  dark: "深色",
  light: "浅色",
  ark: "Ark",
  endfield: "Endfield",
  gojo: "Gojo",
};

/** 色板取自旧版 THEMES：[底色, 强调色]，给主题菜单的小方块用。 */
export const THEME_SWATCHES: Record<string, [string, string]> = {
  dark: ["#020617", "#22d3ee"],
  light: ["#f4f6fb", "#0891b2"],
  ark: ["#080a0b", "#18d1ff"],
  endfield: ["#f2f2f0", "#fffa00"],
  gojo: ["#070910", "#63dcff"],
};

export const DENSITY_KEY = "wildtoken_density";

/**
 * 外观变了就广播一声。
 *
 * 主题和密度有两个入口（顶栏和设置页），两边各存一份状态的话，在设置页改完
 * 回到顶栏，那个按钮还拿着旧值——点一下看上去没反应。真正的状态在
 * documentElement 上，这条事件只是告诉大家重新去读。
 */
export const APPEARANCE_EVENT = "console:appearance";

function announce(): void {
  window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT));
}

export function currentDensity(): string {
  return document.documentElement.getAttribute("data-density") === "compact"
    ? "compact"
    : "comfortable";
}

/** 密度和主题一样和旧控制台共用键，两版之间切换保持选择。 */
export function applyDensity(density: string): void {
  const next = density === "compact" ? "compact" : "comfortable";
  document.documentElement.setAttribute("data-density", next);
  try {
    localStorage.setItem(DENSITY_KEY, next);
  } catch {
    // 存不进去不影响当前页面。
  }
  announce();
}

const SAFE_THEME_ID = /^[a-z][a-z0-9-]{0,47}$/;
const SAFE_THEME_CSS = /^\/theme-packs\/[a-z][a-z0-9-]{0,47}\/[A-Za-z0-9._/-]+\.css$/;

/**
 * 写 localStorage，返回是否成功。
 *
 * 隐私模式或配额满时 setItem 会抛异常。写不进去不影响当前页面——主题
 * 已经落在 documentElement 上了，只是下次打开不会记得。集中在这里说明
 * 一次，调用方不必各自处理。
 */
function persist(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    // 见上：忽略，当前页面照常。
    return false;
  }
}

export function resolveTheme(stored: string | null): string {
  if (!stored || !SAFE_THEME_ID.test(stored)) return "dark";
  if (BUILTIN_THEMES.includes(stored as (typeof BUILTIN_THEMES)[number])) return stored;
  return THEME_PACKS[stored] ? stored : "dark";
}

export function currentTheme(): string {
  return resolveTheme(document.documentElement.getAttribute("data-theme"));
}

/**
 * 换主题。
 *
 * 主题包那个 <link> 必须留在 styles.css 之后——同名特异性下靠顺序取胜。
 * 所以这里是替换既有的 #theme-pack-css，而不是往 head 末尾追加。
 */
export function applyTheme(theme: string): void {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;

  root.setAttribute("data-theme", resolved);
  if (resolved === "ark" || resolved === "endfield") {
    root.setAttribute("data-ark-theme", resolved);
    root.setAttribute("data-ark-depth", "complex");
  } else {
    root.removeAttribute("data-ark-theme");
    root.removeAttribute("data-ark-depth");
  }

  const css = THEME_PACKS[resolved];
  if (css && SAFE_THEME_CSS.test(css)) {
    let link = document.getElementById("theme-pack-css") as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.id = "theme-pack-css";
      link.rel = "stylesheet";
      document.head.append(link);
    }
    link.href = css;
    root.setAttribute("data-theme-pack-css", css);
    persist(THEME_CSS_ID_KEY, resolved);
    persist(THEME_CSS_KEY, css);
  } else {
    document.getElementById("theme-pack-css")?.remove();
    root.removeAttribute("data-theme-pack-css");
    persist(THEME_CSS_ID_KEY, null);
    persist(THEME_CSS_KEY, null);
  }

  persist(THEME_KEY, resolved);
  announce();
}
