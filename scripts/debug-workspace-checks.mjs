import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function clickText(page, root, label) {
  assert(await page.evaluate((root, label) => {
    const button = [...document.querySelectorAll(`${root} button`)].find((item) => item.textContent.trim() === label);
    if (!button) return false;
    button.click();
    return true;
  }, root, label), `找不到按钮：${label}`);
}

async function choose(page, selector, value) {
  await page.evaluate((selector, value) => {
    const field = document.querySelector(selector);
    field.value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector, value);
}

const bodyOf = (page) => page.evaluate(() => JSON.parse(document.querySelector(".debug-body").value));
const rawBody = (page) => page.evaluate(() => document.querySelector(".debug-body").value);
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("wildtoken_debug_sessions_v1")));
const sent = (page) => page.evaluate(() => window.__test.requests.filter((item) => item.path === "/api/admin/debug" || /\/upstreams\/\d+\/debug$/.test(item.path)));
const input = 'textarea[aria-label="发送消息"]';
const model = 'input[aria-label="模型"]';

async function jsonEditor(page) {
  await page.evaluate(() => { document.querySelector(".debug-system").open = true; });
}

async function settled(page, count) {
  await page.waitFor((count) => document.querySelectorAll(".debug-turn").length === count
    && document.querySelector(".debug-compose button[type=submit]").textContent.trim() === "发送", {}, count);
}

async function setup(page, open) {
  await open("debug");
  await page.waitForSelector(model);
  await page.waitFor(() => window.__test.holds.some((item) => item.path === "templates"));
  await page.evaluate(() => {
    window.__test.holds.find((item) => item.path === "templates").release();
    window.__test.imageBody = JSON.stringify({ model: "test-model", choices: [{ message: { role: "assistant", content: "这是模拟回复。" } }] });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text) => { window.__copied = text; },
    } });
  });
  await page.waitFor(() => document.querySelector(".debug-template").textContent.includes("server-template"));
}

export function addDebugCases(addCase) {
  addCase("debug-model-routing", async (page, open) => {
    await setup(page, open);
    assert.equal(await page.count(".debug-channel input"), 0, "默认先选模型，不要求选渠道");
    assert.equal(await page.evaluate(() => document.querySelector('select[aria-label="发送方式"]').value), "auto");
    await page.fill(model, "manual-model");
    await page.fill(input, "第一问");
    await page.pressOn("Enter", { ctrl: true, target: input });
    await settled(page, 1);
    const first = (await sent(page))[0];
    assert.equal(first.path, "/api/admin/debug");
    assert.equal(JSON.parse(first.body).group_id, 1);
    assert.deepEqual(JSON.parse(first.body).body.input, [{ role: "user", content: "第一问" }]);
    assert.match(await page.text(".debug-turn"), /这是模拟回复/);
    assert.equal((await bodyOf(page)).input.at(-1).role, "assistant");
    assert.equal(await page.evaluate(() => document.querySelector('select[aria-label="API 协议"]').disabled), true);
    await page.fill(input, "接着解释");
    await page.click(".debug-compose button[type=submit]");
    await settled(page, 2);
    assert.deepEqual(JSON.parse((await sent(page))[1].body).body.input.map((item) => item.role), ["user", "assistant", "user"]);
    await clickText(page, ".debug-turn:first-child", "复制回复");
    assert.equal(await page.evaluate(() => window.__copied), "这是模拟回复。");
    await choose(page, 'select[aria-label="发送方式"]', "direct");
    await page.waitForSelector(".debug-channel input");
    await page.click(".debug-channel input");
    await page.fill(input, "指定渠道继续");
    await page.click(".debug-compose button[type=submit]");
    await settled(page, 3);
    const direct = (await sent(page)).at(-1);
    assert.equal(direct.path, "/api/admin/upstreams/1/debug");
    assert.equal("group_id" in JSON.parse(direct.body), false);
    assert.equal(JSON.parse(direct.body).body.input.length, 5);
    assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
  });

  addCase("debug-chat-json", async (page, open) => {
    await setup(page, open);
    await page.fill(model, "test-model");
    await page.fill(input, "还没发送的草稿");
    await choose(page, '.debug-template select', "2");
    assert.equal(await page.evaluate((selector) => document.querySelector(selector).value, input), "还没发送的草稿");
    await clickText(page, ".debug-template", "填入");
    assert.equal(await page.evaluate((selector) => document.querySelector(selector).value, input), "alternate-prompt");
    await clickText(page, ".toast-region", "撤销");
    assert.equal(await page.evaluate((selector) => document.querySelector(selector).value, input), "还没发送的草稿");
    await jsonEditor(page);
    const custom = { model: "json-model", input: [{ role: "user", content: [{ type: "input_text", text: "复杂消息" }] }], stream: false, metadata: { keep: 1 } };
    await page.fill(".debug-body", JSON.stringify(custom));
    assert.equal(await page.evaluate((selector) => document.querySelector(selector).value, model), "json-model");
    assert.equal(await page.evaluate(() => document.querySelector(".debug-stream-toggle input").checked), false);
    await choose(page, 'select[aria-label="API 协议"]', "messages");
    await page.waitForSelector(".confirm-dialog[open]");
    await clickText(page, ".confirm-dialog", "取消");
    assert.deepEqual(await bodyOf(page), custom, "取消协议转换不能丢复杂 JSON");
    await clickText(page, ".debug-system", "复制 JSON");
    assert.deepEqual(JSON.parse(await page.evaluate(() => window.__copied)), custom);
    await clickText(page, ".debug-system", "发送 JSON");
    await settled(page, 1);
    assert.deepEqual(JSON.parse((await sent(page))[0].body).body, custom);
    assert.equal(await page.evaluate((selector) => document.querySelector(selector).value, input), "还没发送的草稿", "直接发送 JSON 不清掉未提交的聊天输入");
    assert.deepEqual((await bodyOf(page)).metadata, { keep: 1 });
    assert.deepEqual((await bodyOf(page)).input[0], custom.input[0]);
    await page.fill(".debug-body", '{"model":');
    assert.equal(await page.evaluate(() => document.querySelector(".debug-body").getAttribute("aria-invalid")), "true");
    assert.equal(await page.evaluate(() => document.querySelector(".debug-compose button[type=submit]").disabled), true);
    assert.equal(await page.evaluate((selector) => document.querySelector(selector).disabled, model), true);
    assert.equal((await sent(page)).length, 1);
    assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
  });
  addCase("debug-session-storage", async (page, open) => {
    await setup(page, open);
    await choose(page, 'select[aria-label="API 协议"]', "messages");
    await page.fill(model, "claude-custom[1m]");
    await page.fill(input, "保留这一轮");
    await page.click(".debug-compose button[type=submit]");
    await settled(page, 1);
    assert.equal(JSON.parse((await sent(page))[0].body).body.model, "claude-custom");
    const firstId = (await saved(page)).activeId;
    await clickText(page, ".debug-sidebar", "新会话");
    assert.equal(await page.count(".debug-turn"), 0);
    assert.deepEqual((await bodyOf(page)).messages, [], "新会话不能带入上一会话消息");
    await page.fill(model, "second-model");
    await page.fill(input, "第二个会话的草稿");
    await page.click(".debug-recent-item:nth-child(2)");
    assert.equal((await saved(page)).activeId, firstId);
    assert.equal(await page.count(".debug-turn"), 1);
    await clickText(page, ".debug-sidebar", "重命名");
    await page.fill('input[aria-label="会话名称"]', "会话 A");
    await clickText(page, ".debug-sidebar", "保存名称");
    assert.equal(await page.text('.debug-recent-item[aria-current="true"] strong'), "会话 A");
    const serialized = await page.evaluate(() => localStorage.getItem("wildtoken_debug_sessions_v1"));
    assert.doesNotMatch(serialized, /authorization|redacted|fake\.invalid/);
    await page.reload();
    await page.waitForSelector(".debug-turn");
    assert.equal(await page.evaluate((selector) => document.querySelector(selector).value, model), "claude-custom[1m]");
    assert.match(await page.text(".debug-turn"), /保留这一轮[\s\S]*模拟回复/);
    assert.equal((await sent(page)).length, 0, "刷新不能重新发送请求");
    await clickText(page, ".debug-sidebar", "删除会话");
    await page.waitForSelector(".confirm-dialog[open]");
    await clickText(page, ".confirm-dialog", "取消");
    assert.equal((await saved(page)).sessions.length, 2);
    await clickText(page, ".debug-sidebar", "删除会话");
    await page.waitForSelector(".confirm-dialog[open]");
    await clickText(page, ".confirm-dialog", "删除");
    assert.equal((await saved(page)).sessions.length, 1);
    assert.equal(await page.evaluate((selector) => document.querySelector(selector).value, input), "第二个会话的草稿");
    await page.fill('input[aria-label="搜索会话"]', "no-such-session");
    assert.equal(await page.count(".debug-recent-item"), 0);
    assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
  });

  addCase("debug-storage-errors", async (page, open) => {
    await setup(page, open);
    await page.evaluate(() => {
      window.__nativeStore = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === "wildtoken_debug_sessions_v1") throw new DOMException("full", "QuotaExceededError");
        return window.__nativeStore.call(this, key, value);
      };
    });
    await page.fill(input, "存不下也不能丢的草稿");
    assert.match(await page.text(".debug-sidebar"), /保存失败/);
    assert.equal(await page.evaluate((selector) => document.querySelector(selector).value, input), "存不下也不能丢的草稿");
    await page.evaluate(() => {
      Storage.prototype.setItem = window.__nativeStore;
      localStorage.setItem("wildtoken_debug_sessions_v1", '{"version":1,"activeId":"","sessions":[]}');
    });
    await page.fill(input, "另一个标签页已经更新");
    assert.match(await page.text(".debug-sidebar"), /其他标签页/);
    assert.equal((await saved(page)).sessions.length, 0, "不能覆盖另一标签页的记录");
    await page.evaluate(() => localStorage.setItem("wildtoken_debug_sessions_v1", "{corrupt"));
    await page.reload();
    await page.waitForSelector(".debug-sidebar");
    assert.match(await page.text(".debug-sidebar"), /原记录未覆盖/);
    await page.fill(input, "恢复前的临时草稿");
    assert.equal(await page.evaluate(() => localStorage.getItem("wildtoken_debug_sessions_v1")), "{corrupt");
    await clickText(page, ".debug-sidebar", "重置本机记录");
    await page.waitForSelector(".confirm-dialog[open]");
    await clickText(page, ".confirm-dialog", "清空");
    assert.equal((await saved(page)).version, 1);
    assert.equal((await saved(page)).sessions.length, 1);
    assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
  });
  addCase("debug-compare", async (page, open) => {
    await setup(page, open);
    await page.fill(model, "test-model");
    await choose(page, 'select[aria-label="发送方式"]', "direct");
    await clickText(page, ".debug-picker-actions", "全选结果");
    await page.evaluate(() => {
      window.__test.debugResponses = Object.fromEntries([1, 2].map((id) => [id, { body: JSON.stringify({ choices: [{ message: { role: "assistant", content: `reply-${id}` } }] }) }]));
    });
    await page.fill(input, "比较两条渠道");
    await page.evaluate(() => {
      const button = document.querySelector(".debug-compose button[type=submit]");
      button.click(); button.click();
    });
    await settled(page, 1);
    assert.equal((await sent(page)).length, 2, "同一轮重复点击只能发送一批");
    assert.equal(await page.count(".debug-run"), 2);
    await page.fill(input, "继续");
    assert.equal(await page.evaluate(() => document.querySelector(".debug-compose button[type=submit]").disabled), true);
    await page.fill('input[aria-label="温度"]', "0.25");
    await clickText(page, ".debug-context-choice", "继续 · test-channel-2");
    assert.equal((await bodyOf(page)).input.at(-1).content, "reply-2");
    assert.equal((await bodyOf(page)).temperature, 0.25);
    await page.click(".debug-compose button[type=submit]");
    await settled(page, 2);
    const second = JSON.parse((await sent(page))[2].body).body;
    assert.deepEqual(second.input.map((item) => item.content), ["比较两条渠道", "reply-2", "继续"]);
    await clickText(page, ".debug-context-choice", "不带本轮回复继续");
    assert.equal((await saved(page)).sessions[0].turns[1].contextResolved, true);
    await clickText(page, ".debug-turn:first-child .debug-run:first-child", "原始响应");
    await clickText(page, ".debug-turn:first-child .debug-run:first-child", "复制响应");
    assert.match(await page.evaluate(() => window.__copied), /HTTP\/1\.1 200[\s\S]*reply-1/);
    assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
  });

  addCase("debug-stream", async (page, open) => {
    await setup(page, open);
    await page.fill(model, "stream-model");
    await page.fill(input, "流式问题");
    await page.evaluate((selector) => {
      window.__test.holdDebug = true;
      window.__test.imageBody = 'data: {"choices":[{"delta":{"content":"逐块返回的回复"}}]}\n\n';
      for (const extra of [{ repeat: true }, { isComposing: true }]) document.querySelector(selector)
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, ...extra }));
    }, input);
    assert.equal((await sent(page)).length, 0);
    await page.pressOn("Enter", { ctrl: true, target: input });
    await page.waitFor(() => document.querySelector(".debug-run-meta")?.textContent.includes("接收中"));
    const owner = (await saved(page)).activeId;
    await clickText(page, ".debug-sidebar", "新会话");
    await page.fill(input, "另一会话草稿");
    assert.equal(await page.evaluate(() => document.querySelector(".debug-compose button[type=submit]").disabled), true);
    await clickText(page, ".debug-chat", "返回生成中的会话");
    assert.equal((await saved(page)).activeId, owner);
    await page.click('.topbar-nav [data-view="groups"]');
    await page.pressOn("Enter", { ctrl: true, target: input });
    assert.equal((await sent(page)).length, 1, "隐藏的调试页不能触发快捷发送");
    await page.evaluate(() => window.__test.holds.find((item) => item.path === "debug:0").release());
    await page.click('.topbar-nav [data-view="debug"]');
    await settled(page, 1);
    assert.equal((await bodyOf(page)).input.at(-1).content, "逐块返回的回复");
    await page.fill(input, "停止这次生成");
    await page.click(".debug-compose button[type=submit]");
    await page.waitFor(() => document.querySelectorAll(".debug-turn").length === 2 && document.querySelector(".debug-turn:last-child").textContent.includes("接收中"));
    await clickText(page, ".debug-compose", "停止生成");
    await settled(page, 2);
    assert.match(await page.text(".debug-turn:last-child"), /已停止/);
    await page.evaluate(() => {
      window.__test.holds.filter((item) => item.path.startsWith("debug:")).forEach((item) => item.release());
      window.__test.holdDebug = false;
      window.__test.imageBody = JSON.stringify({ choices: [{ message: { role: "assistant", content: "新的回复" } }] });
    });
    await page.fill(input, "再试一次");
    await page.click(".debug-compose button[type=submit]");
    await settled(page, 3);
    assert.match(await page.text(".debug-turn:last-child"), /新的回复/);
    await page.evaluate(() => { window.__test.holdDebug = true; });
    await page.fill(input, "刷新时仍在生成");
    await page.click(".debug-compose button[type=submit]");
    await page.waitFor(() => {
      const state = JSON.parse(localStorage.getItem("wildtoken_debug_sessions_v1"));
      return state.sessions.find((item) => item.id === state.activeId).turns.at(-1).runs.some((run) => run.phase === "running");
    });
    await page.reload();
    await page.waitForSelector(".debug-turn");
    assert.match(await page.text(".debug-turn:last-child"), /页面已刷新/);
    assert.equal((await sent(page)).length, 0);
    assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
  });
  addCase("debug-session-boundaries", async (page, open) => {
    await setup(page, open);
    await page.fill(model, "test-model");
    await page.fill(input, "删除生成中的会话");
    await page.evaluate(() => { window.__test.holdDebug = true; });
    await page.click(".debug-compose button[type=submit]");
    await page.waitFor(() => document.querySelector(".debug-run-meta")?.textContent.includes("接收中"));
    const deleted = (await saved(page)).activeId;
    await clickText(page, ".debug-sidebar", "删除会话");
    await page.waitForSelector(".confirm-dialog[open]");
    await clickText(page, ".confirm-dialog", "删除");
    await page.waitFor(() => document.querySelector(".debug-compose button[type=submit]").textContent.trim() === "发送");
    const state = await saved(page);
    assert(state.sessions.some((item) => item.id === state.activeId));
    assert(!state.sessions.some((item) => item.id === deleted));
    assert.equal(await page.count(".debug-turn"), 0);
    await page.evaluate(() => { window.__test.holdDebug = false; });
    await page.fill(model, "test-model");
    await page.fill(input, "本地隐私记录");
    await page.click(".debug-compose button[type=submit]");
    await settled(page, 1);
    const count = (await sent(page)).length;
    await page.evaluate(() => {
      localStorage.removeItem("wildtoken_admin_token");
      window.dispatchEvent(new CustomEvent("console:unauthorized", { detail: "已退出" }));
    });
    await page.waitFor(() => !document.querySelector(".debug-chat"));
    assert.doesNotMatch(await page.text('section[data-view="debug"]'), /本地隐私记录/);
    assert.match(await page.evaluate(() => localStorage.getItem("wildtoken_debug_sessions_v1")), /本地隐私记录/);
    await page.evaluate(() => document.querySelector(".admin-token-dialog").dispatchEvent(new Event("cancel", { bubbles: true })));
    await page.waitFor(() => !document.querySelector(".admin-token-dialog").open);
    assert.equal(await page.count(".debug-turn"), 0, "关闭登录框也不能展示本机记录");
    await clickText(page, 'section[data-view="debug"]', "登录后查看");
    await page.waitForSelector(".admin-token-dialog[open]");
    await page.fill('input[aria-label="Admin Token"]', "frontend-state-check-token");
    await page.evaluate(() => { window.__test.holdLists = true; });
    await clickText(page, ".admin-token-dialog", "进入");
    await page.waitFor(() => window.__test.holds.some((item) => item.path === "/api/admin/upstreams/"));
    assert.equal(await page.count(".debug-turn"), 0, "验证后台登录前不能展示本机记录");
    await page.evaluate(() => {
      window.__test.holdLists = false;
      window.__test.holds.filter((item) => item.path.startsWith("/api/admin/")).forEach((item) => item.release());
    });
    await page.waitForSelector(".debug-turn");
    assert.match(await page.text(".debug-turn"), /本地隐私记录/);
    assert.equal((await sent(page)).length, count);
    assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
  });

  addCase("debug-layout", async (page, open) => {
    await setup(page, open);
    await page.fill(model, "gpt-4.1");
    await page.evaluate(() => {
      window.__test.imageBody = JSON.stringify({ model: "gpt-4.1", choices: [{ message: { role: "assistant", content: "流式响应会逐块返回内容，不必等待整段生成结束。\n客户端可以边接收边展示，缩短用户感知的等待时间。\n调试时建议分别观察响应头、首块和总耗时。" } }] });
    });
    await page.fill(input, "请用三句话解释流式响应，并给出一条调试建议。");
    await page.click(".debug-compose button[type=submit]");
    await settled(page, 1);
    await clickText(page, ".debug-sidebar", "新会话");
    await clickText(page, ".debug-sidebar", "重命名");
    await page.fill('input[aria-label="会话名称"]', "工具调用验证");
    await clickText(page, ".debug-sidebar", "保存名称");
    await page.click(".debug-recent-item:nth-child(2)");
    const directory = process.env.WILDTOKEN_DEBUG_SCREENSHOTS;
    if (directory) mkdirSync(directory, { recursive: true });
    const capture = async (name) => {
      if (!directory) return;
      const { data } = await page.cdp.send("Page.captureScreenshot", { format: "png" });
      const path = join(directory, `${name}.png`);
      writeFileSync(path, Buffer.from(data, "base64"));
      console.log(`截图：${path}`);
    };
    const applyTheme = (theme) => page.evaluate(async (theme) => {
      document.documentElement.dataset.theme = theme;
      document.getElementById("theme-pack-css")?.remove();
      if (!["dark", "light"].includes(theme)) await new Promise((resolve, reject) => {
        const link = document.createElement("link");
        link.id = "theme-pack-css"; link.rel = "stylesheet"; link.href = `/theme-packs/${theme}/theme.css`;
        link.onload = resolve; link.onerror = reject; document.head.append(link);
      });
      window.dispatchEvent(new CustomEvent("console:appearance"));
    }, theme);
    const viewport = (width) => page.cdp.send("Emulation.setDeviceMetricsOverride", { width, height: width < 600 ? 844 : 900, deviceScaleFactor: 1, mobile: false });
    for (const theme of ["dark", "light", "ark", "endfield", "gojo"]) {
      await applyTheme(theme);
      for (const width of [1600, 1280, 1024, 820, 390, 320]) {
        await viewport(width);
        await page.waitFor((width) => document.querySelector("#debug-parameter-fields").hidden === (width <= 820)
          && document.querySelector("#debug-session-list").hidden === (width <= 1180), {}, width);
        const geometry = await page.evaluate(async () => {
          document.querySelector(".content").scrollTop = 0;
          window.scrollTo(0, 0);
          await new Promise(requestAnimationFrame);
          const rect = (selector) => {
            const item = document.querySelector(selector);
            const box = item.getBoundingClientRect();
            return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, client: item.clientWidth, scroll: item.scrollWidth };
          };
          return { viewport: innerWidth, document: document.documentElement.scrollWidth,
            workspace: rect(".debug-workspace"), sessions: rect(".debug-sidebar"), chat: rect(".debug-chat"), parameters: rect(".debug-params") };
        });
        assert(geometry.document <= geometry.viewport + 1, `${theme}/${width} 页面横向溢出`);
        for (const key of ["workspace", "sessions", "chat", "parameters"]) {
          if (geometry[key].scroll > geometry[key].client + 1) {
            console.log("溢出控件：", await page.evaluate(() => {
              const chat = document.querySelector(".debug-chat").getBoundingClientRect();
              return [...document.querySelectorAll(".debug-chat *")].map((item) => {
                const box = item.getBoundingClientRect();
                return { tag: item.tagName, class: item.className, right: box.right, width: box.width };
              }).filter((item) => item.width > 0 && item.right > chat.right + 1).slice(0, 12);
            }));
            await capture(`overflow-${theme}-${width}`);
          }
          assert(geometry[key].scroll <= geometry[key].client + 1, `${theme}/${width} ${key} 溢出：${JSON.stringify(geometry[key])}`);
        }
        if (width >= 1280) {
          assert(geometry.sessions.right <= geometry.chat.x && geometry.chat.right <= geometry.parameters.x, `${theme}/${width} 应按会话、聊天、参数排列`);
        } else if (width > 820) {
          assert(geometry.sessions.bottom <= geometry.chat.y && geometry.chat.right <= geometry.parameters.x, `${theme}/${width} 应保留聊天和参数双栏`);
        } else {
          assert(geometry.sessions.bottom <= geometry.parameters.y && geometry.parameters.bottom <= geometry.chat.y, `${theme}/${width} 应折叠侧栏后展示聊天`);
        }
        if (theme === "light" && width === 390) {
          await page.evaluate(() => document.querySelector(".debug-chat").scrollIntoView({ block: "start" }));
          const bars = await page.evaluate(() => ({
            top: document.querySelector(".debug-chat").getBoundingClientRect().top,
            header: document.querySelector(".topbar").getBoundingClientRect().bottom,
            send: document.querySelector(".debug-sendbar").getBoundingClientRect().bottom,
            nav: document.querySelector(".topbar-nav").getBoundingClientRect().top,
          }));
          assert(bars.top >= bars.header && bars.send <= bars.nav, `手机聊天控件被遮挡：${JSON.stringify(bars)}`);
        }
        if ((theme === "dark" && width === 1600) || (theme === "light" && width === 390) || (theme === "endfield" && width === 1024)) await capture(`chat-${theme}-${width}`);
      }
    }
    await viewport(1600);
    await applyTheme("dark");
    await choose(page, 'select[aria-label="发送方式"]', "direct");
    await clickText(page, ".debug-picker-actions", "全选结果");
    await page.fill(input, "比较两条渠道的回答");
    await page.click(".debug-compose button[type=submit]");
    await settled(page, 2);
    await capture("chat-compare");
    assert.deepEqual(await page.evaluate(() => window.__test.errors), []);
  });
}
