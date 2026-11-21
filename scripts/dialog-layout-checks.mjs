import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const THEMES = ["dark", "light", "ark", "endfield", "gojo"];
const VIEWPORTS = [
  { width: 1440, height: 900, mobile: false },
  { width: 390, height: 844, mobile: true },
  { width: 844, height: 390, mobile: false },
];

async function clickText(page, selector, text) {
  await page.evaluate((scope, label) => {
    const button = [...document.querySelectorAll(`${scope} button`)].find(
      (node) => node.textContent.trim() === label,
    );
    if (!button) throw new Error(`找不到按钮：${label}`);
    button.click();
  }, selector, text);
}

async function closeDialog(page) {
  // 走原生 Esc，连同 React 的关闭状态一起更新。
  await page.cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
  });
  await page.cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27,
  });
  await page.waitFor(() => !document.querySelector("dialog[open]"), { label: "抽屉关闭" });
}

async function clickAt(page, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
}

async function measureDrawer(page) {
  return page.evaluate(async () => {
    const dialog = [...document.querySelectorAll("dialog[open]")].at(-1);
    if (!dialog) throw new Error("没有打开的抽屉");
    await Promise.all(dialog.getAnimations().map((animation) => animation.finished));

    const panel = dialog.firstElementChild;
    const head = panel?.querySelector(":scope > .modal-head");
    const body = panel?.querySelector(":scope > .upstream-dialog-body");
    const footer = panel?.querySelector(":scope > .modal-footer");
    if (!head || !body) throw new Error("缺少独立的标题栏或滚动正文");

    const rect = (node) => {
      const { top, right, bottom, left, width, height } = node.getBoundingClientRect();
      return { top, right, bottom, left, width, height };
    };
    const before = { head: rect(head), footer: footer ? rect(footer) : null };
    body.scrollTop = body.scrollHeight;
    await new Promise(requestAnimationFrame);
    const after = { head: rect(head), footer: footer ? rect(footer) : null };
    const scrollTop = body.scrollTop;
    body.scrollTop = 0;

    const style = getComputedStyle(dialog);
    const fields = [...body.querySelectorAll(".field")];
    const rows = [...body.querySelectorAll(".model-option, .mc-row, .balance-row")];
    const title = head.querySelector("h2");
    const close = head.querySelector(".icon-close");
    const controls = [...body.querySelectorAll("input:not([type=checkbox]), select")];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      dialog: rect(dialog),
      title: title ? rect(title) : null,
      close: close ? rect(close) : null,
      head: rect(head),
      body: rect(body),
      footer: footer ? rect(footer) : null,
      actions: [...(footer?.querySelectorAll("button") ?? [])].map(rect),
      fieldGaps: fields.slice(1).map((field, index) => rect(field).top - rect(fields[index]).bottom),
      controlHeights: controls.map((node) => rect(node).height),
      rowHeights: rows.map((node) => rect(node).height),
      radius: style.borderTopRightRadius,
      borderTop: style.borderTopWidth,
      panelBorder: getComputedStyle(panel).borderTopWidth,
      panelOverflow: panel.scrollWidth - panel.clientWidth,
      bodyOverflow: body.scrollWidth - body.clientWidth,
      outerScroll: dialog.scrollHeight - dialog.clientHeight,
      bodyScrollable: body.scrollHeight > body.clientHeight + 1,
      scrollTop,
      before,
      after,
    };
  });
}

function assertDrawer(box, { footer = true, compact = false, list = false, transfer = false } = {}) {
  const { dialog, viewport } = box;
  assert.ok(Math.abs(dialog.top) <= 1 && Math.abs(dialog.right - viewport.width) <= 1, "抽屉没有贴右上角");
  assert.ok(Math.abs(dialog.height - viewport.height) <= 1, "抽屉没有撑满视口");
  assert.ok(dialog.left >= -1, "抽屉超出左边界");
  assert.equal(box.radius, "0px", "主题圆角覆盖了抽屉几何");
  assert.equal(box.borderTop, "0px", "抽屉顶部多了一条边框");
  assert.equal(box.panelBorder, "0px", "面板出现双层边框");
  assert.ok(box.panelOverflow <= 1 && box.bodyOverflow <= 1, "正文横向溢出");
  assert.ok(box.outerScroll <= 1, "抽屉外层出现第二根滚动条");
  assert.ok(box.title && box.title.left - dialog.left >= 12, "标题贴边");
  assert.ok(box.close && box.close.right <= dialog.right - 12, "关闭按钮缺失或贴边");
  assert.ok(box.close.top >= box.head.top && box.close.bottom <= box.head.bottom, "关闭按钮脱离标题栏");
  assert.ok(box.body.height > 40, "正文被挤没了");
  assert.equal(box.before.head.top, box.after.head.top, "滚动带走了标题栏");
  if (box.bodyScrollable) assert.ok(box.scrollTop > 0, "长内容无法滚动到底");

  if (footer) {
    assert.ok(box.footer, "缺少独立底栏");
    assert.ok(Math.abs(box.footer.bottom - dialog.bottom) <= 1, "按钮没有固定在底部");
    assert.equal(box.before.footer.top, box.after.footer.top, "滚动带走了底栏");
    assert.ok(box.body.bottom <= box.footer.top + 1, "正文遮住底栏");
    for (const action of box.actions) {
      assert.ok(action.left >= dialog.left && action.right <= dialog.right, "底栏按钮横向溢出");
      assert.ok(action.top >= box.footer.top && action.bottom <= box.footer.bottom, "底栏按钮被裁掉");
    }
  }
  if (compact) assert.ok(box.controlHeights.every((height) => height <= 52), "短表单的输入框被拉高");
  if (list) {
    assert.ok(box.rowHeights.length > 0, "没有可验证的数据行");
    assert.ok(box.rowHeights.every((height) => height <= 80), "少量数据行被拉满整屏");
  }
  if (transfer) assert.ok(box.fieldGaps.every((gap) => gap >= 10), "导入字段之间缺少间距");
}

/** 真浏览器验证几何；只检查类名看不见网格拉伸和主题覆盖。 */
export async function checkDialogLayouts({ page, check, gotoView, openRowMenu, clickMenuItem }) {
  const screenshots = process.env.WILDTOKEN_DIALOG_SCREENSHOTS;
  if (screenshots) mkdirSync(screenshots, { recursive: true });

  const original = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    density: document.documentElement.dataset.density,
  }));

  try {
    await page.evaluate(() => { document.documentElement.dataset.density = "comfortable"; });
    for (const theme of THEMES) {
      await page.cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORTS[0], deviceScaleFactor: 1 });
      await page.click(".theme-toggle");
      await page.click(`[data-theme-choice=${theme}]`);
      await page.waitFor((name) => {
        if (document.documentElement.dataset.theme !== name) return false;
        if (name === "dark" || name === "light") return true;
        return [...document.querySelectorAll("link[rel=stylesheet]")].some(
          (link) => link.href.includes(`/theme-packs/${name}/`) && link.sheet?.cssRules?.length,
        );
      }, { label: `${theme} 主题加载` }, theme);

      for (const viewport of VIEWPORTS) {
        await page.cdp.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1 });
        const cases = [
          ...["快速导入", "导入", "导出"].map((label) => ({
            label,
            view: "渠道",
            open: () => clickText(page, ".view-toolbar", label),
            options: { transfer: true, compact: true },
          })),
          { label: "新增渠道", view: "渠道", open: () => clickText(page, ".view-toolbar", "新增渠道") },
          { label: "新增令牌", view: "令牌", open: () => clickText(page, ".view-toolbar", "新增令牌") },
          { label: "新增分组", view: "分组", open: () => clickText(page, ".view-toolbar", "新增分组"), options: { compact: true } },
          ...["拉取模型", "测试模型", "查询 new-api 余额"].map((label) => ({
            label,
            view: "渠道",
            open: async () => {
              await page.waitFor(() => [...document.querySelectorAll("[data-col=name]")].some(
                (node) => node.textContent.includes("auto-weight"),
              ), { label: "渠道行加载" });
              await openRowMenu(page, "auto-weight");
              await clickMenuItem(page, label);
              if (label === "查询 new-api 余额") await page.waitForSelector(".balance-row");
            },
            options: { footer: label !== "查询 new-api 余额", list: label !== "测试模型", compact: true },
          })),
          {
            label: "请求详情", view: "日志", options: { footer: false },
            open: async () => {
              await page.waitForSelector("tr[data-log-id]");
              await page.click("tr[data-log-id]");
            },
          },
        ];

        for (const item of cases) {
          await check(`${theme} ${viewport.width}×${viewport.height} ${item.label}布局`, async () => {
            try {
              await gotoView(page, item.view);
              await item.open();
              await page.waitForSelector("dialog.dialog--drawer[open]");
              if (screenshots && theme === "dark" && ["快速导入", "新增分组", "拉取模型", "查询 new-api 余额"].includes(item.label)) {
                await page.evaluate(async () => {
                  const dialog = document.querySelector("dialog[open]");
                  await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
                });
                const image = await page.cdp.send("Page.captureScreenshot", { format: "png" });
                writeFileSync(join(screenshots, `${viewport.width}-${item.label}.png`), Buffer.from(image.data, "base64"));
              }
              assertDrawer(await measureDrawer(page), item.options);
            } finally {
              if (await page.count("dialog[open]")) await closeDialog(page);
              if (await page.count("[role=menu]")) await page.press("Escape");
            }
          });
        }
      }
    }

    await check("快速导入保留识别、焦点和关闭行为", async () => {
      const selector = "dialog.quick-import-dialog[open]";
      try {
        await gotoView(page, "渠道");
        await clickText(page, ".view-toolbar", "快速导入");
        await page.waitForSelector(selector);
        await clickText(page, selector, "清空重来");
        await page.waitFor(() => document.activeElement === document.getElementById("quick-import-source"), { label: "原文输入焦点" });
        const key = "sk-layout-check-0123456789abcdef";
        await page.paste(`${selector} #quick-import-source`, `https://api.example.com/v1 ${key}`);
        const values = await page.waitFor(() => {
          const fields = ["quick-import-name", "quick-import-url", "quick-import-apikey"].map((id) => document.getElementById(id)?.value);
          return fields[2] === "sk-layout-check-0123456789abcdef" ? fields : false;
        }, { label: "粘贴识别回填" });
        assert.deepEqual(values, ["example", "https://api.example.com/v1", key], "识别不得丢失接口路径或 Key");

        const box = await measureDrawer(page);
        await clickAt(page, box.body.left + 6, box.body.top + 6);
        assert.equal(await page.count(selector), 1, "点击正文留白误关抽屉");
        await page.click(`${selector} .icon-close`);
        await page.waitFor(() => !document.querySelector("dialog[open]"));

        await clickText(page, ".view-toolbar", "快速导入");
        await page.waitForSelector(selector);
        const draft = await page.evaluate(() => ({
          fields: ["quick-import-name", "quick-import-url", "quick-import-apikey"].map((id) => document.getElementById(id)?.value),
          hidden: document.getElementById("quick-import-source").hidden,
          password: document.getElementById("quick-import-apikey").type,
          focused: document.activeElement === document.getElementById("quick-import-name"),
        }));
        assert.deepEqual(draft.fields, values, "关闭重开应保留尚未提交的草稿");
        assert.ok(draft.hidden && draft.password === "password" && draft.focused, "重开应隐藏原文、遮住 Key 并聚焦名称");
        await clickText(page, selector, "清空重来");
        await page.waitFor(() => ["quick-import-name", "quick-import-url", "quick-import-apikey", "quick-import-source"]
          .every((id) => document.getElementById(id).value === ""), { label: "清空快速导入草稿" });
        const reopened = await measureDrawer(page);
        if (reopened.dialog.left > 12) {
          await clickAt(page, reopened.dialog.left - 12, 40);
          await page.waitFor(() => !document.querySelector("dialog[open]"), { label: "遮罩关闭快速导入" });
        } else {
          assert.ok(Math.abs(reopened.dialog.left) <= 1, "无遮罩区域时抽屉应贴住左边缘");
          await page.click(`${selector} .icon-close`);
          await page.waitFor(() => !document.querySelector("dialog[open]"), { label: "关闭全宽快速导入" });
        }
      } finally {
        if (await page.count("dialog[open]")) await closeDialog(page);
      }
    });

    await check("导入错误不挤走底部操作", async () => {
      const selector = "dialog.quick-import-dialog[open]";
      try {
        await clickText(page, ".view-toolbar", "导入");
        await page.waitForSelector(selector);
        await page.fill(`${selector} textarea`, "{not-json");
        await clickText(page, `${selector} .modal-footer`, "导入");
        await page.waitForSelector(`${selector} [role=alert]`);
        assertDrawer(await measureDrawer(page), { transfer: true, compact: true });
        await clickText(page, `${selector} .modal-footer`, "关闭");
        await page.waitFor(() => !document.querySelector("dialog[open]"));
      } finally {
        if (await page.count("dialog[open]")) await closeDialog(page);
      }
    });
  } finally {
    await page.cdp.send("Emulation.clearDeviceMetricsOverride");
    await page.click(".theme-toggle");
    await page.click(`[data-theme-choice=${original.theme}]`);
    await page.evaluate((density) => { document.documentElement.dataset.density = density; }, original.density);
  }
}
