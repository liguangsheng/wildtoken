# WildToken 主题包

管理界面的深色/浅色两套默认主题在 `static/css/` 里；其余主题都是这个目录下的
CSS-only 主题包。主题包随发布压缩包和 Docker 镜像一起分发，Docker Compose 会把
宿主机 `./themes` 只读挂载到 `/app/themes` 覆盖镜像内的同名目录。

主题目录可用 `APP__THEMES__DIR` 或 `WILDTOKEN_THEME_DIR` 改到别处。

## 目录结构

一个主题包是一个子目录，至少包含清单和样式表两个文件：

```text
themes/
  soul-society/
    theme.json
    theme.css
```

## theme.json

```json
{
  "id": "soul-society",
  "label": "尸魂界",
  "css": "theme.css",
  "swatch": ["#111827", "#f97316"],
  "version": "1.0.0",
  "description": "一句话说明，可省略"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 必须和目录名完全一致；小写字母开头，只能含小写字母、数字和连字符，最长 48 字符 |
| `label` | 否 | 主题菜单里显示的名字，最长 64 字符；留空则回退到 `name` 字段，再空则用 `id` |
| `css` | 是 | 指向包内样式表的相对路径，必须以 `.css` 结尾，可以带子目录（如 `css/theme.css`），不能含 `..` 或绝对路径 |
| `swatch` | 否 | 菜单色块的 `[背景色, 强调色]`，接受 `#RGB`、`#RGBA`、`#RRGGBB`、`#RRGGBBAA`；缺失或非法时回退到 `#f8fafc` 和 `#f97316` |
| `version` | 否 | 自由文本，最长 32 字符 |
| `description` | 否 | 自由文本，最长 160 字符 |

清单不合法的主题包会被跳过，其他主题包不受影响；跳过原因会以 `warn` 级别写进服务日志。
最常见的原因是 `id` 和目录名不一致，或 `css` 指向的文件不存在。

## theme.css

规则统一写在 `html[data-theme="<id>"]` 作用域下 —— 切换主题时前端只会改
`<html>` 的 `data-theme` 属性，并把这个包的样式表插到 `/static/styles.css`
之后，所以覆盖基础样式不需要 `!important`。

主题包只能是 CSS：WildToken 只读取清单、并以同源静态文件的方式加载 `css` 指向的
样式表，不会执行包里的 JavaScript，清单里的其他字段也不会进入页面脚本。

主题的主体工作是重新定义 CSS 变量。完整清单见 `static/css/base.css` 的 `:root`
块，按用途分为这么几组：

- 表面：`--bg`、`--bg-elevated`、`--panel`、`--panel-solid`、`--panel-subtle`、`--panel-muted`、`--panel-elevated`、`--glass`、`--glass-strong`
- 文字：`--text`、`--text-secondary`、`--muted`、`--muted-strong`
- 描边：`--line`、`--line-strong`、`--line-soft`
- 强调色：`--accent`、`--accent-strong`、`--accent-soft`、`--accent-border`、`--accent-glow`、`--accent-on`、`--brand-ink`
- 语义色：`--danger*`、`--ok*`、`--warning*`
- 焦点与阴影：`--focus`、`--focus-ring`、`--shadow-xs|sm|md|lg`、`--glow-accent`
- 代码块：`--code-frame-bg`、`--code-bg`、`--code-text`、`--code-muted`、`--code-border`
- 交互面：`--row-hover`、`--row-disabled`、`--topbar-bg`、`--backdrop`、`--neutral-chip`、`--toast-neutral`
- 背景光晕：`--aurora-a`、`--aurora-b`、`--aurora-c`
- 排版与骨架：`--radius*`、`--space-*`、`--font-sans|mono`、`--text-xs…2xl`、`--topbar-height`、`--control-h`、`--transition`、`--blur`

只覆盖需要改的变量即可，其余会继承深色默认值。别忘了同时声明 `color-scheme`，
它决定滚动条和原生表单控件跟随明还是暗：

```css
/* themes/soul-society/theme.css */
html[data-theme="soul-society"] {
  color-scheme: dark;

  --bg: #0b0f19;
  --panel: rgb(17 24 39 / 88%);
  --panel-solid: #111827;
  --text: #f8fafc;
  --muted: #94a3b8;
  --line: rgb(148 163 184 / 28%);

  --accent: #f97316;
  --accent-strong: #ea580c;
  --accent-soft: rgb(249 115 22 / 14%);
  --accent-border: rgb(249 115 22 / 45%);
  --accent-on: #0b0f19;
}

/* 变量不够用时再写结构性规则，同样带上作用域前缀 */
html[data-theme="soul-society"] .topbar {
  border-bottom: 2px solid var(--accent);
}
```

要自定义导航和页面布局，可以参考 `ark/`（工业信息风，青色只用来标选中、焦点、进度和主操作）、
`endfield/`（工程现场风，浅工作面 + 信号黄）和 `gojo/`（角色主题，用
`.view[data-view="…"]` 逐视图换一个 `--gojo-view-mark` 汉字水印，由
`.view > .panel::after` 统一渲染）。三者都把横向顶栏改成了左侧竖排导航栏，在变量之外
写了大量结构规则。

改这种侧栏布局要留意一个坑：基础样式给 `html`、`body`、`.app-shell` 都设了
`overflow-x: hidden`，用来挡宽表格横向溢出。而 `overflow-x: hidden` 会让另一根轴隐式
变成 `auto`，三者因此都成了滚动容器，侧栏的 `position: sticky` 就会去贴一个根本不滚动
的 `.app-shell`，跟着页面一起滚走。

仓库里的 rail 主题（`ark/`、`endfield/`、`gojo/`，以及内置的深浅两套）绕开这个坑的办法
是把滚动容器整体下移：桌面断点下让 `html`、`body` 变成 `height: 100%; overflow: hidden`，
`.app-shell` 改成 `height: 100dvh` 的两列 grid 且 `overflow: hidden`，真正滚动的是
`.content`（`overflow-y: auto`）。侧栏成了 grid 的第一列、本身就有满屏高度，于是
sticky 贴谁都无所谓：

```css
@media (min-width: 761px) {
  html[data-theme="soul-society"],
  html[data-theme="soul-society"] body {
    height: 100%;
    overflow: hidden;
  }
}

html[data-theme="soul-society"] .app-shell {
  display: grid;
  grid-template-columns: 128px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  height: 100dvh;
  overflow: hidden;
}

html[data-theme="soul-society"] .content {
  grid-column: 2;
  height: 100dvh;
  overflow-y: auto;
}
```

如果你想保留页面级滚动（滚动条留在窗口上，侧栏靠 sticky 贴住），那就得把那三个元素的
`overflow-x` 换成 `clip`：它同样裁剪横向溢出，但不创建滚动容器，overflow-y 保持
`visible`，sticky 才会去贴视口。

顺带一句，侧栏上的 `backdrop-filter` 要留意：任何非 `none` 的值都会让侧栏成为 fixed 后代
的包含块，于是移动端那个 fixed 导航 dock 会锚到侧栏而不是视口。`ark/`、`endfield/`、
`gojo/` 都在侧栏上直接关掉了它（`endfield/theme.css` 的注释写明了原因）；内置深色主题
保留了桌面端的模糊，但在移动端块里显式清成 `none`，注释同样写了缘由。侧栏里出现过 fixed
元素（基础样式里的 `.select-panel` 就是 `position: fixed`）的包都得处理这一条。

## 覆盖元素选择器时的特异性

`html[data-theme="x"] button` 比基础样式里的 `.nav-link`、`button.secondary`、
`.table-sort-button` 都重——它多了 `html` 和 `button` 两个元素分量。所以给裸
`button`、`input` 这类元素选择器加样式，会连带盖掉基础样式为各个变体准备的
`background: transparent`，表现是排序表头、未选中的导航标签、行内开关全都套上了
主按钮的填充。

仓库里的做法是排除法：主按钮那条规则用 `:not(:where(…))` 把所有自带状态的按钮变体
按名字排掉。`:where()` 里的东西权重为零，所以整条规则的权重和 `html[data-theme] button`
一样，不会再往上叠。`ark/`、`gojo/`（列表写在 `:where()` 里）和 `endfield/`（链式
`:not()`）都是这么写的：

```css
/* 先把裸 button 上会漏出去的装饰清掉 */
html[data-theme="soul-society"] button {
  border-radius: 0;
  box-shadow: none;
}

/* 再只给「真正的主操作按钮」上填充 */
html[data-theme="soul-society"] button:not(:where(
  .secondary,
  .danger,
  .ghost,
  .nav-link,
  .table-sort-button,
  .status-switch,
  .priority-value,
  .token-preview-button,
  .toast-close,
  .url-action,
  .icon-close,
  .icon-maximize,
  .icon-refresh,
  .segmented-control > button,
  [role="option"],
  [role="menuitem"],
  [role="menuitemradio"]
)) {
  background: var(--accent);
  box-shadow: 4px 4px 0 #000;
}
```

排除清单没法在多条规则间复用（`:is()`/`:not()` 只能写在选择器里），所以 rest、
`:hover` 每个状态都得原样重复一遍——`gojo/theme.css` 的注释里注明了这一点，别当成可以
合并的冗余。

另一条路是把主题作用域包进 `:where()`，让作用域的权重归零，选择器退回成基础样式用
的那个（`.nav-link`、`button.secondary` 这些类选择器就又压得住它了）：

```css
:where(html[data-theme="soul-society"]) button {
  background: var(--accent);
}
```

代价是这只挡得住基础样式**声明过**的属性。`.nav-link` 写了 `box-shadow: none`，但
`.table-sort-button`、`.url-action`、`.icon-close`、`.icon-refresh` 的静态态都没写，
所以主按钮的立体高光仍会漏到它们身上，还得在主题里逐个显式重置。上面的排除法从一开始
就不给它们套上填充，少一轮补救，仓库里的包因此都选了排除法。

## 同权重规则互相覆盖

媒体查询不增加特异性。如果包里有个响应式布局块（比如 `@media (min-width: 761px)`
里的整套侧栏规则），而别处又用**同样的选择器**写了一遍，那么在文件里后写的那条
赢——不管它在不在媒体查询里。rail 主题尤其容易撞上：`.topbar`、`.nav-link`、
`.topbar-nav` 这些选择器在一个包里往往出现两三次（桌面竖排一次、移动端 dock 一次），
顺序一乱，侧栏就会穿上横向顶栏的底色，或者在列底部拖着一条本该去掉的
`border-bottom`。所以仓库里的包都把移动端块放在文件末尾。

这个坑跨文件时更隐蔽。`static/css/console-rail.css` 里就留了实例：内置深浅主题各自
在移动端块里把 `.live-indicator`、`.density-toggle` 藏掉了，但 `console-rail.css`
的页脚规则权重更高、又加载在两个主题文件之后，媒体查询救不了它——最后只能在
`console-rail.css` 自己的移动端块里再藏一遍，文件里的注释写明了原因。

排查时别只看选择器，用 DevTools 看**实际生效**的那条。修法是给需要赢的选择器多加一层
真实存在的类（`.app-shell .topbar`、`.topbar-brand .brand-text h1` 都是 DOM 里真有的
层级），并在注释里写明这一层是为了权重而不是为了范围，否则下一个人会把它当冗余删掉。

另外，基础样式里少数属性带了 `!important`（例如 `.dashboard-card-sub` 的
`color`），那是主题包再怎么提权都赢不了的，只能同样用 `!important`。

## 调试

`/api/themes` 每次请求都会重新扫描主题目录，主题包的 CSS 也带了禁用缓存的响应头，
所以新增主题包或修改样式后刷新浏览器即可生效，不需要重启服务。

主题菜单里的顺序是：深色、浅色，然后是随仓库分发的自带包，最后是你新增的包。
如果新包的 `id` 和某个自带包重名，磁盘上的版本会顶掉自带的那个。
