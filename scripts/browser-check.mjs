#!/usr/bin/env node
/**
 * React 控制台的浏览器验证。
 *
 * 为什么要有这个：静态检查和 node 侧测试只证明代码能加载，不证明界面能用。
 * 上一次把控制台改成 ES 模块时，node 加载测试全绿、164 项测试全过，部署后
 * 所有按钮失效——失败模式是「渲染出来了但不响应」，只有真浏览器能看见。
 *
 * 零依赖：Node 24 自带 WebSocket，直接说 CDP，不装 puppeteer。
 *
 * 用法：
 *   node scripts/browser-check.mjs           # 复用已构建的 web/dist
 *   node scripts/browser-check.mjs --build   # 先跑 npm run build
 *
 * 端口另选，不碰 3100 上跑着的部署实例。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { checkDialogLayouts } from "./dialog-layout-checks.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 3105;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = "browser-check-token-0123456789ab";
const CHROME = "google-chrome-stable";

// 假上游。拉取模型、测连接这类动作要真的有个东西应答，否则只能测到失败路径。
/* 端口交给内核分配。固定端口在上一次还没完全退干净时会 EADDRINUSE，
   而那和被测的东西没任何关系。 */
let fakeUpstreamPort = 0;
const FAKE_MODELS = ["gpt-4o", "gpt-4o-mini", "claude-sonnet-5", "grok-4.5"];
const FAKE_REPLY = "假上游的回复。";
/** 请求体里出现这个词，假上游就拖 3 秒再答，留出观测在途行的窗口。 */
const SLOW_MARKER = "__slow__";

// ── CDP ──────────────────────────────────────────────────────────────────────

/** 最小 CDP 客户端：请求应答 + 事件订阅，够这个脚本用。 */
class CDP {
  #ws;
  #nextId = 0;
  #pending = new Map();
  #handlers = new Map();

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`CDP 连接失败: ${url}`)), { once: true });
    });
    const client = new CDP(ws);
    ws.addEventListener("message", (event) => {
      // 坏帧不该炸掉整场验证，但也不能吞——它本身就是个异常信号。
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        console.error(`CDP 收到非 JSON 帧：${String(event.data).slice(0, 200)}`);
        return;
      }
      client.#dispatch(message);
    });
    return client;
  }

  constructor(ws) {
    this.#ws = ws;
  }

  #dispatch(message) {
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    for (const handler of this.#handlers.get(message.method) ?? []) handler(message.params);
  }

  send(method, params = {}) {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.#handlers.has(method)) this.#handlers.set(method, []);
    this.#handlers.get(method).push(handler);
  }

  /* 取消订阅。用完不摘的话，后续用例的请求会继续落进旧数组，
     断言就可能拿到别人的请求。 */
  off(method, handler) {
    const list = this.#handlers.get(method);
    if (!list) return;
    const index = list.indexOf(handler);
    if (index !== -1) list.splice(index, 1);
  }

  close() {
    this.#ws.close();
  }
}

// ── 页面操作 ─────────────────────────────────────────────────────────────────

/**
 * 页面句柄。
 *
 * evaluate 收的是真函数而不是字符串，参数走 JSON 序列化——这样断言写在
 * 脚本里仍然是可读的 JS，编辑器也能看懂。
 */
class Page {
  constructor(cdp) {
    this.cdp = cdp;
  }

  async evaluate(fn, ...args) {
    const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`;
    const result = await this.cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description ?? detail.text ?? "evaluate 抛错");
    }
    return result.result.value;
  }

  async goto(url) {
    const loaded = new Promise((resolve) => this.cdp.on("Page.loadEventFired", resolve));
    await this.cdp.send("Page.navigate", { url });
    await loaded;
  }

  /**
   * 真的重载一次。
   *
   * 不能用 goto 代替：导航到只有 hash 不同的地址是同文档导航，不触发 load
   * 事件，goto 会一直等下去。
   */
  async reload(hash) {
    if (hash !== undefined) {
      await this.evaluate((value) => {
        window.location.hash = value;
      }, hash);
    }
    const loaded = new Promise((resolve) => this.cdp.on("Page.loadEventFired", resolve));
    await this.cdp.send("Page.reload", { ignoreCache: false });
    await loaded;
  }

  /** 轮询直到函数返回真值。超时把最后一次结果一起报出来，省得盲猜。 */
  async waitFor(fn, { timeout = 5000, label = "条件" } = {}, ...args) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(fn, ...args);
      if (last) return last;
      await sleep(50);
    }
    throw new Error(`等待超时（${label}），最后一次取到 ${JSON.stringify(last)}`);
  }

  waitForSelector(selector, options = {}) {
    return this.waitFor(
      (sel) => document.querySelector(sel) !== null,
      { label: selector, ...options },
      selector,
    );
  }

  /** 点击。el.click() 派发的是冒泡的真事件，React 的根委托接得到。 */
  async click(selector) {
    const ok = await this.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.click();
      return true;
    }, selector);
    if (!ok) throw new Error(`点不到 ${selector}`);
    await sleep(60);
  }

  /**
   * 填表单。
   *
   * 受控输入框不能直接赋 value——React 记着上一次的值，input 事件里读到
   * 的还是旧的。得走原型上的原生 setter 再派发事件。
   */
  async fill(selector, value) {
    const ok = await this.evaluate(
      (sel, text) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
        Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      },
      selector,
      value,
    );
    if (!ok) throw new Error(`填不了 ${selector}`);
    await sleep(30);
  }

  async press(key) {
    await this.evaluate((k) => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    }, key);
    await sleep(60);
  }

  /** 带修饰键或指定发送目标的按键。不指定目标就发给 document。 */
  async pressOn(key, { ctrl = false, target = null } = {}) {
    const ok = await this.evaluate(
      (k, useCtrl, selector) => {
        const node = selector ? document.querySelector(selector) : document;
        if (!node) return false;
        node.dispatchEvent(
          new KeyboardEvent("keydown", { key: k, ctrlKey: useCtrl, bubbles: true, cancelable: true }),
        );
        return true;
      },
      key,
      ctrl,
      target,
    );
    if (!ok) throw new Error(`按键发不出去：${target}`);
    await sleep(80);
  }

  text(selector) {
    return this.evaluate((sel) => document.querySelector(sel)?.textContent?.trim() ?? null, selector);
  }

  count(selector) {
    return this.evaluate((sel) => document.querySelectorAll(sel).length, selector);
  }
}

// ── 进程 ─────────────────────────────────────────────────────────────────────

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))));
  });
}

/**
 * 起后端。
 *
 * 先编译成临时二进制再跑：`go run` 会多包一层进程，杀掉父进程时子进程
 * 留着占端口。
 *
 * 日志全收着。服务起不来时先看它自己的日志——上一次浏览器症状是「登录
 * 失败且无任何报错」，真因是端口被占，日志第一行就写着 bind 失败。
 */
async function startServer(dataDir) {
  const binary = join(dataDir, "wildtoken");
  await run("go", ["build", "-o", binary, "./cmd/wildtoken"], { cwd: ROOT });

  const log = [];
  const server = spawn(binary, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      ADMIN_TOKEN,
      APP__SERVER__HOST: "127.0.0.1",
      APP__SERVER__PORT: String(PORT),
      DATABASE_URL: `sqlite:${join(dataDir, "check.db")}?mode=rwc`,
      WILDTOKEN_LOG: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => log.push(String(chunk)));
  server.stderr.on("data", (chunk) => log.push(String(chunk)));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`服务退出（码 ${server.exitCode}）：\n${log.join("")}`);
    }
    try {
      const response = await fetch(`${ORIGIN}/health`);
      if (response.ok) return server;
    } catch {
      // 还没起来，接着等。
    }
    await sleep(200);
  }
  server.kill("SIGKILL");
  throw new Error(`服务 20 秒内没有就绪：\n${log.join("")}`);
}

/**
 * 假上游：只答 GET /v1/models。
 *
 * 没它的话渠道指向 api.example.com，拉取永远超时，模型选择器的主路径
 * 一步都走不到。
 */
function startFakeUpstream() {
  /* 三种协议各自的响应形状。后端按形状抽回复，随便返回一个 200 是测不出
     「回复没抽出来」这类问题的。 */
  const bodies = {
    "/v1/responses": {
      output: [{ content: [{ type: "output_text", text: FAKE_REPLY }] }],
    },
    "/v1/chat/completions": {
      choices: [{ message: { role: "assistant", content: FAKE_REPLY } }],
    },
    "/v1/messages": {
      content: [{ type: "text", text: FAKE_REPLY }],
    },
  };

  /* 计费端点：第一次故意慢，且每次报的总额递增。这样才能制造出「先发的
     后到」，测出陈旧响应会不会盖掉新结果。 */
  let billingCalls = 0;

  const server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0];

    if (path === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: FAKE_MODELS.map((id) => ({ id })) }));
      return;
    }

    if (path === "/v1/dashboard/billing/subscription") {
      const first = billingCalls++ === 0;
      const send = () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ hard_limit_usd: 100 }));
      };
      // 金额恒定，只是第一次慢——让断言不依赖调用次序。
      if (first) setTimeout(send, 1500);
      else send();
      return;
    }

    if (path === "/v1/dashboard/billing/usage") {
      response.writeHead(200, { "content-type": "application/json" });
      // new-api 用分报，后端除 100。
      response.end(JSON.stringify({ total_usage: 2500 }));
      return;
    }

    if (path === "/v1/usage") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          remaining: 12.5,
          usage: { total: { actual_cost: 3.25 } },
          planName: "pro",
          isValid: true,
          mode: "shared",
        }),
      );
      return;
    }

    const body = bodies[path];
    if (!body) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `no route for ${path}` } }));
      return;
    }

    /* 请求体里带 SLOW_MARKER 就慢答。在途行只存在于请求未完成的那段时间里，
       秒回的假上游根本给不出观测窗口。 */
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const delay = raw.includes(SLOW_MARKER) ? 3000 : 0;
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      }, delay);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      fakeUpstreamPort = server.address().port;
      resolve(server);
    });
  });
}

async function launchChrome(profileDir) {
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      /* 显式定视口。默认是 800×600——这个宽度永远落在 max-width:1100px 的媒体
         查询里，等于一直在验证窄屏布局，而控制台实际跑在宽屏上。 */
      "--window-size=1600,900",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      `--user-data-dir=${profileDir}`,
      // 0 让 Chrome 自选端口，写进 DevToolsActivePort，避开固定端口的碰撞。
      "--remote-debugging-port=0",
      "about:blank",
    ],
    /* 自成进程组。Chrome 会 fork 出 renderer / GPU 等子进程，只杀父 PID 的话
       它们还在往配置目录里写，删一半又被重建。 */
    { stdio: ["ignore", "ignore", "ignore"], detached: true },
  );

  const portFile = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const [port] = readFileSync(portFile, "utf8").split("\n");
      if (port) return { chrome, port: Number(port) };
    } catch {
      // 文件还没写出来。
    }
    await sleep(100);
  }
  chrome.kill("SIGKILL");
  throw new Error("Chrome 15 秒内没有开出调试端口");
}

async function attachPage(devtoolsPort) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`).then((r) => r.json());
    const target = targets.find((item) => item.type === "page");
    if (target?.webSocketDebuggerUrl) return CDP.connect(target.webSocketDebuggerUrl);
    await sleep(100);
  }
  throw new Error("找不到可附着的页面目标");
}

// ── 数据准备 ─────────────────────────────────────────────────────────────────

async function adminPost(path, body) {
  const response = await fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} → ${response.status} ${await response.text()}`);
  return response.json();
}

function upstreamPayload(overrides) {
  return {
    name: "channel",
    base_url: "https://api.example.com",
    api_key: "sk-check",
    model_names: [],
    model_prefixes: [],
    model_mappings: {},
    effort_mappings: {},
    priority: 100,
    weight: 100,
    auto_weight_enabled: true,
    enabled: true,
    extra_headers: {},
    timeout_seconds: 300,
    rate_limit: null,
    group_ids: [],
    ...overrides,
  };
}

/**
 * 铺数据。
 *
 * 空库下所有表格都是空态，断言不出列数和格子内容。这里造的形状要覆盖
 * 分支：自动权重开/关、有分组/无分组、启用/停用/归档。
 */
async function seed() {
  const vip = await adminPost("/api/admin/groups", { name: "vip", description: "高优先级" });

  /* 指向假上游，而且已选了一个假上游不返回的模型——「未返回」那条分支
     需要这种形状才能测到，它也是真实世界里最容易静默出错的一种。 */
  const auto = await adminPost(
    "/api/admin/upstreams/",
    upstreamPayload({
      name: "auto-weight-channel",
      base_url: `http://127.0.0.1:${fakeUpstreamPort}`,
      model_names: ["gpt-4o", "retired-model"],
      model_prefixes: ["claude-"],
      model_mappings: { fast: "gpt-4o-mini" },
      group_ids: [vip.id],
      auto_weight_enabled: true,
      weight: 120,
    }),
  );

  await adminPost(
    "/api/admin/upstreams/",
    upstreamPayload({
      name: "fixed-weight-channel",
      auto_weight_enabled: false,
      weight: 40,
      priority: 50,
    }),
  );

  const archived = await adminPost(
    "/api/admin/upstreams/",
    upstreamPayload({ name: "archived-channel", enabled: false }),
  );
  await fetch(`${ORIGIN}/api/admin/upstreams/${archived.id}/archived`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({ archived: true }),
  });

  /* 令牌放进 vip，和假上游那个渠道同组——跨组的话路由压根不会选它。 */
  const token = await adminPost("/api/admin/tokens", {
    name: "check-token",
    description: "验证用",
    enabled: true,
    group_id: vip.id,
  });

  /* 真的走一遍网关，存下一条带四份快照的日志。伪造日志行测不出会话视图：
     它要解析的正是转发时存下来的请求体。 */
  await fetch(`${ORIGIN}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token.token}` },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "你是一个测试助手。" },
        { role: "user", content: "说一句你好。" },
      ],
    }),
  });

  /* 只建一条模板。新版开窗时随机选一条，多于一条的话断言就不确定了。 */
  await adminPost("/api/admin/settings/model-test-prompts", {
    name: "打个招呼",
    prompt: "说一句你好。",
  });

  return { vipId: vip.id, autoId: auto.id, downstreamToken: token.token };
}

// ── 页面上的常见动作 ──────────────────────────────────────────

/** 按渠道名字片段打开那一行的操作菜单。 */
async function openRowMenu(page, nameFragment) {
  const opened = await page.evaluate((fragment) => {
    const rows = [...document.querySelectorAll("table.upstream-table tbody tr")];
    const row = rows.find((r) => r.querySelector("[data-col=name]")?.textContent?.includes(fragment));
    const trigger = row?.querySelector("button.action-menu-trigger");
    if (!trigger) return false;
    trigger.click();
    return true;
  }, nameFragment);
  if (!opened) throw new Error(`找不到 ${nameFragment} 的行菜单`);
  await sleep(60);
}

/** 按键的简写，读起来像一个动作而不是一个方法调用。 */
function pressKey(page, key, options) {
  return page.pressOn(key, options);
}

/** 在页内等一会儿。等的是渲染，所以让浏览器自己计时而不是在这边 sleep。 */
function sleepInPage(page, ms) {
  return page.evaluate((delay) => new Promise((resolve) => setTimeout(resolve, delay)), ms);
}

/* 控制台探测（拉模型、测模型、查余额）也进日志，而且比实际转发晚。靠客户端
   类型把它们排掉，剩下的才是网关真转发过的那条。 */
const PROBE_CLIENT_TYPES = ["model-list", "model-test", "balance"];

/** 点开第一条非探测日志的详情。 */
async function openProxiedLogDetail(page) {
  const opened = await page.evaluate((probes) => {
    const row = [...document.querySelectorAll("table tbody tr")].find((node) => {
      const client = node.querySelector("[data-col=client]")?.textContent?.trim();
      // 整行可点，详情列里是错误信息而不是按钮。
      return client && !probes.includes(client) && node.dataset.logId;
    });
    if (!row) return false;
    row.click();
    return true;
  }, PROBE_CLIENT_TYPES);
  if (!opened) throw new Error("日志里没有非探测的请求");
  await sleep(60);
}

/** 按导航文案切视图，并等那一页的面板出来。 */
async function gotoView(page, label) {
  await page.evaluate((text) => {
    const button = [...document.querySelectorAll(".topbar-nav .nav-link")].find(
      (node) => node.textContent.trim() === text,
    );
    if (!button) throw new Error(`找不到导航项 ${text}`);
    button.click();
  }, label);
  await page.waitForSelector("section.view .panel", { label: `${label}页` });
}

async function clickMenuItem(page, label) {
  const clicked = await page.evaluate((text) => {
    const item = [...document.querySelectorAll("[role=menu] [role=menuitem]")].find(
      (button) => button.textContent.trim() === text,
    );
    if (!item) return false;
    item.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`菜单里没有「${label}」`);
  await sleep(60);
}

// ── 断言 ─────────────────────────────────────────────────────────────────────

const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ✘ ${name}\n      ${error.message.split("\n").join("\n      ")}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes("--build")) {
    await run("npm", ["run", "build"], { cwd: join(ROOT, "web") });
  }

  const dataDir = mkdtempSync(join(tmpdir(), "wildtoken-check-"));
  const profileDir = mkdtempSync(join(tmpdir(), "wildtoken-chrome-"));
  let server;
  let chrome;
  let cdp;
  let fakeUpstream;

  /* 收拾现场。要能重入：finally 和信号处理可能都会叫到它。 */
  let cleaned = false;
  const killChrome = () => {
    if (!chrome?.pid) return;
    try {
      // 负号 = 整组。detached 起的，组 id 就是它自己的 pid。
      process.kill(-chrome.pid, "SIGKILL");
    } catch {
      // 已经没了就算了。
      chrome.kill("SIGKILL");
    }
  };

  const stopProcesses = () => {
    cdp?.close();
    killChrome();
    server?.kill("SIGKILL");
    // Go 侧的连接池会持一些 keep-alive，只 close 的话进程要等它们超时才能退。
    fakeUpstream?.closeAllConnections?.();
    fakeUpstream?.close();
  };

  const removeDirs = () => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  };

  /** 信号路径：只能同步做，尽力而为。 */
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    stopProcesses();
    removeDirs();
  };

  /**
   * 正常路径：等 Chrome 真的退了再删它的配置目录。
   *
   * SIGKILL 是异步的，紧跟着 rmSync 会赶在 Chrome 写完最后几个文件之前，
   * 删一半又被重建，每跑一次漏一点。
   */
  const cleanupAndWait = async () => {
    if (cleaned) return;
    cleaned = true;
    const exited = chrome
      ? new Promise((resolve) => {
          chrome.once("exit", resolve);
          setTimeout(resolve, 3000);
        })
      : Promise.resolve();
    stopProcesses();
    await exited;
    removeDirs();
  };

  /* 被外部超时杀掉时 finally 不会跑——持续集成里这是常态。不接这两个信号
     的话，每超时一次就漏一份 Chrome 配置目录和一个临时库，实测放了 138M。 */
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      cleanup();
      process.exit(1);
    });
  }

  try {
    console.log("起服务…");
    fakeUpstream = await startFakeUpstream();
    server = await startServer(dataDir);
    const seeded = await seed();

    console.log("起浏览器…");
    const launched = await launchChrome(profileDir);
    chrome = launched.chrome;
    cdp = await attachPage(launched.port);
    const page = new Page(cdp);

    // 收噪音。三条来路各收各的：console.error、未捕获异常、失败请求。
    const noise = { console: [], exceptions: [], requests: [] };
    let collecting = false;

    cdp.on("Runtime.consoleAPICalled", (event) => {
      if (!collecting || event.type !== "error") return;
      noise.console.push(event.args.map((a) => a.description ?? a.value).join(" "));
    });
    cdp.on("Runtime.exceptionThrown", (event) => {
      if (!collecting) return;
      noise.exceptions.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text);
    });
    /* 带着 URL 才能判断一次失败是不是预期的。loadingFailed 本身只给 requestId。 */
    const urlByRequest = new Map();
    /* 收到过响应的请求记在这里。Chrome 对「响应头到了、响应体被丢弃」的请求
       会补报一条 loadingFailed(ERR_ABORTED)——删除渠道后列表刷新就碰得到。
       那种请求没有失败，不能算进噪音。 */
    const responded = new Set();
    cdp.on("Network.requestWillBeSent", (event) =>
      urlByRequest.set(event.requestId, event.request),
    );
    /* 只盯控制台自己的请求。字体走 Google Fonts（和旧版一致），第三方 CDN 抽一下
       就把这条断言打红的话，它会很快被当成噪音忽略。 */
    const ours = (url) => url.startsWith(ORIGIN);
    cdp.on("Network.responseReceived", (event) => {
      responded.add(event.requestId);
      if (!collecting || event.response.status < 400) return;
      if (!ours(event.response.url)) return;
      noise.requests.push(`${event.response.status} ${event.response.url}`);
    });
    cdp.on("Network.loadingFailed", (event) => {
      if (!collecting) return;
      const request = urlByRequest.get(event.requestId);
      const url = request?.url ?? "";
      if (!ours(url)) return;
      // 离开日志页时 SSE 连接是被主动 abort 掉的，不算缺陷。
      if (event.canceled && url.includes("/api/admin/logs/stream")) return;
      if (responded.has(event.requestId)) return;
      noise.requests.push(`失败 ${event.errorText} ${request?.method ?? "?"} ${url}`);
    });

    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");

    // ── 登录 ────────────────────────────────────────────────────────────────
    // 这一段不收噪音：没令牌时各页照常发请求，401 是预期的。
    console.log("\n登录");

    await check("根路径重定向到新控制台", async () => {
      await page.goto(`${ORIGIN}/`);
      const url = await page.evaluate(() => location.pathname);
      assertEqual(url, "/console", "重定向落点");
    });

    await check("无令牌时弹出登录框", async () => {
      await page.waitForSelector("dialog.admin-token-dialog[open]");
      const heading = await page.text("dialog.admin-token-dialog h2");
      assertEqual(heading, "管理员登录", "登录框标题");
    });

    await check("输入令牌后进入控制台", async () => {
      await page.fill("dialog.admin-token-dialog input[type=password]", ADMIN_TOKEN);
      await page.click("dialog.admin-token-dialog button[type=submit]");
      await page.waitFor(
        () => document.querySelector("dialog.admin-token-dialog[open]") === null,
        { label: "登录框关闭" },
      );
      const stored = await page.evaluate(() => localStorage.getItem("wildtoken_admin_token"));
      assertEqual(stored, ADMIN_TOKEN, "令牌落盘");
    });

    // ── 主流程 ──────────────────────────────────────────────────────────────
    // 从这里开始，任何 console 错误、异常、4xx/5xx 都算缺陷。
    collecting = true;
    console.log("\n渠道页");

    /* 落地页是用户偏好（默认看板），不是写死的。后面一大段都在渠道页上，
       显式切过去，别靠“登录完刚好就在这一页”。 */
    await check("渠道表渲染出行", async () => {
      await gotoView(page, "渠道");
      await page.waitFor(() => document.querySelectorAll("table.upstream-table tbody tr").length >= 2, {
        label: "渠道行",
      });
    });

    await check("表头与表体列数一致", async () => {
      const head = await page.count("table.upstream-table thead th");
      const body = await page.evaluate(
        () => document.querySelector("table.upstream-table tbody tr")?.children.length ?? 0,
      );
      assertEqual(head, 9, "表头列数");
      assertEqual(body, 9, "表体格数");
    });

    await check("分组列显示分组名而不是编号", async () => {
      const text = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("table.upstream-table tbody tr")];
        const row = rows.find((r) => r.querySelector("[data-col=name]")?.textContent?.includes("auto-weight"));
        return row?.querySelector("[data-col=groups]")?.textContent?.trim() ?? null;
      });
      assert(text?.includes("vip"), `分组格应含 vip，实际 ${JSON.stringify(text)}`);
    });

    await check("自动权重渠道显示有效/基础双值", async () => {
      const text = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("table.upstream-table tbody tr")];
        const row = rows.find((r) => r.querySelector("[data-col=name]")?.textContent?.includes("auto-weight"));
        return row?.querySelector("[data-col=weight]")?.textContent ?? null;
      });
      assert(text?.includes("/"), `应是「有效 / 基础」，实际 ${JSON.stringify(text)}`);
      assert(text?.includes("有效权重"), `应标注有效权重，实际 ${JSON.stringify(text)}`);
    });

    await check("关掉自动权重的渠道只显示固定权重", async () => {
      const text = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("table.upstream-table tbody tr")];
        const row = rows.find((r) => r.querySelector("[data-col=name]")?.textContent?.includes("fixed-weight"));
        return row?.querySelector("[data-col=weight]")?.textContent ?? null;
      });
      assert(text?.includes("固定权重"), `应标注固定权重，实际 ${JSON.stringify(text)}`);
      assert(!text?.includes("/"), `不该出现有效权重，实际 ${JSON.stringify(text)}`);
    });

    /* 先断言存在再断言状态。只写「hidden 不为 false」的话，归档区根本没渲染
       也能蒙混过关——首跑就是这么蒙过去的。 */
    await check("Base URL 格带复制和打开按钮", async () => {
      const cell = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("table.upstream-table tbody tr")];
        const row = rows.find((r) => r.querySelector("[data-col=name]")?.textContent?.includes("auto-weight"));
        const inner = row?.querySelector(".url-cell-inner");
        return {
          code: inner?.querySelector("code")?.textContent ?? null,
          buttons: [...(inner?.querySelectorAll(".url-action") ?? [])].map((b) => ({
            label: b.getAttribute("aria-label"),
            disabled: b.disabled,
          })),
        };
      });
      assert(cell.code?.startsWith("http"), `Base URL 没放进 code：${cell.code}`);
      assertEqual(cell.buttons.length, 2, "复制 + 打开两个按钮");
      // 种子指向真实 http 地址，打开按钮不该被禁用。
      assert(
        cell.buttons.every((b) => !b.disabled),
        `按钮被禁用了：${JSON.stringify(cell.buttons)}`,
      );
    });

    /* 三种 0 要分开说。fixed-weight-channel 是固定权重，把它改成 0 看文案。 */
    await check("零权重注记说清楚是哪种 0", async () => {
      await page.evaluate(async () => {
        const admin = localStorage.getItem("wildtoken_admin_token");
        const list = await (
          await fetch("/api/admin/upstreams/", { headers: { "x-admin-token": admin } })
        ).json();
        const target = list.find((item) => item.name.includes("fixed-weight"));
        await fetch(`/api/admin/upstreams/${target.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json", "x-admin-token": admin },
          body: JSON.stringify({
            name: target.name,
            base_url: target.base_url,
            api_key: null,
            clear_api_key: false,
            model_names: target.model_names,
            model_prefixes: target.model_prefixes,
            model_mappings: target.model_mappings,
            effort_mappings: target.effort_mappings,
            priority: target.priority,
            weight: 0,
            auto_weight_enabled: false,
            timeout_seconds: target.timeout_seconds,
            enabled: target.enabled,
            extra_headers: target.extra_headers,
            rate_limit: target.rate_limit,
            group_ids: target.group_ids,
          }),
        });
      });
      await gotoView(page, "日志");
      await gotoView(page, "渠道");
      const note = await page.waitFor(
        () => {
          const rows = [...document.querySelectorAll("table.upstream-table tbody tr")];
          const row = rows.find((r) => r.querySelector("[data-col=name]")?.textContent?.includes("fixed-weight"));
          return row?.querySelector(".effective-zero-note")?.textContent ?? false;
        },
        { label: "零权重注记", timeout: 10_000 },
      );
      assertEqual(note, "固定权重 0 · 不参与路由", "固定权重 0 的文案");
    });

    await check("归档区存在且默认收起", async () => {
      await page.waitForSelector(".archived-toggle", { label: "归档区" });
      const hidden = await page.evaluate(
        () => document.querySelector(".archived-body")?.hasAttribute("hidden") ?? null,
      );
      assertEqual(hidden, true, "归档区初始收起");
    });

    await check("归档区可以展开", async () => {
      await page.click(".archived-toggle");
      const hidden = await page.evaluate(
        () => document.querySelector(".archived-body")?.hasAttribute("hidden") ?? null,
      );
      assertEqual(hidden, false, "点击后展开");
      await page.click(".archived-toggle");
    });

    /* 归档开关是个文本折叠控件，不是主操作按钮。gojo / ark 给未列白的
       button 刷实心渐变，刷上去就看不清了。量实际背景而不是看类名：
       白名单漏了类名照样存在，只是规则没命中。 */
    await check("归档开关各主题下都不被刷实心", async () => {
      /* 走界面上的主题菜单，不是直接改 data-theme：主题包是运行时插的
         <link>，只改属性的话 CSS 根本没加载，断言会全绿但什么也没测到。 */
      for (const theme of ["gojo", "ark"]) {
        await page.click(".theme-toggle");
        await page.click(`[data-theme-choice=${theme}]`);

        // 先确认主题包真的生效了，否则后面那条断言没意义。
        const loaded = await page.waitFor(
          (name) => {
            if (document.documentElement.getAttribute("data-theme") !== name) return false;
            const link = [...document.querySelectorAll("link[rel=stylesheet]")].find((node) =>
              node.href.includes(`/theme-packs/${name}/`),
            );
            // sheet.cssRules 能读到，说明它下载并解析完了。
            return link?.sheet?.cssRules?.length ? true : false;
          },
          { label: `${theme} 主题包加载`, timeout: 10_000 },
          theme,
        );
        assertEqual(loaded, true, `${theme} 主题包没加载`);

        const painted = await page.evaluate(() => {
          const style = getComputedStyle(document.querySelector(".archived-toggle"));
          return { image: style.backgroundImage, color: style.backgroundColor };
        });
        assertEqual(painted.image, "none", `${theme} 主题下被刷了渐变`);
        assert(
          /rgba\(0, 0, 0, 0\)|transparent/.test(painted.color),
          `${theme} 主题下有底色：${painted.color}`,
        );
      }

      // 换回默认，别把后续用例留在主题包上。
      await page.click(".theme-toggle");
      await page.click("[data-theme-choice=dark]");
    });

    await check("操作菜单能打开", async () => {
      await page.click("table.upstream-table tbody tr button.action-menu-trigger");
      const items = await page.count("[role=menu] [role=menuitem]");
      assert(items > 0, "菜单项数量为 0");
      await page.press("Escape");
    });

    /* 克隆是「拿完整配置开一个新建表单」。id 0 的草稿一旦被当成编辑，
       标题会写成「编辑渠道 #0」，保存就打 PUT /upstreams/0，后端 404。 */
    await check("克隆对话框按新增打开", async () => {
      await openRowMenu(page, "auto-weight");
      await clickMenuItem(page, "复制渠道");
      await page.waitForSelector("dialog.upstream-dialog[open]", { label: "克隆对话框" });
      const seen = await page.evaluate(() => {
        const dialog = document.querySelector("dialog.upstream-dialog[open]");
        const field = [...dialog.querySelectorAll(".field")].find(
          (node) => node.querySelector(".field-label")?.textContent.trim() === "名称",
        );
        return {
          title: dialog.querySelector(".modal-head h2").textContent.trim(),
          name: field.querySelector("input").value,
        };
      });
      // 先关窗还原，再断言——断言挂掉也不该把对话框留给后面的检查。
      await page.click("dialog.upstream-dialog[open] .icon-close");
      await page.waitFor(() => document.querySelector("dialog.upstream-dialog[open]") === null, {
        label: "克隆对话框关闭",
      });
      assertEqual(seen.title, "新增渠道", `克隆对话框标题：${seen.title}`);
      assertEqual(seen.name, "auto-weight-channel-copy", `克隆预填的名字：${seen.name}`);
    });

    await check("克隆渠道能存成新渠道", async () => {
      await openRowMenu(page, "auto-weight");
      await clickMenuItem(page, "复制渠道");
      await page.waitForSelector("dialog.upstream-dialog[open]", { label: "克隆对话框" });
      await page.click("dialog.upstream-dialog[open] .modal-footer button[type=submit]");
      await page.waitFor(() => document.querySelector("dialog.upstream-dialog[open]") === null, {
        label: "克隆对话框关闭",
      });
      // 表格里要真的多出这一行——关掉对话框本身证明不了保存成功。
      const saved = await page.waitFor(
        () => {
          const rows = [...document.querySelectorAll("table.upstream-table tbody tr")];
          return rows.some((row) =>
            row.querySelector("[data-col=name]")?.textContent?.includes("-copy"),
          );
        },
        { label: "克隆出的新行", timeout: 10_000 },
      );
      assert(saved, "克隆保存后表格里没有新渠道");

      /* 清掉克隆行，后面的检查仍按种子的三条渠道来。走 UI 删除，
         顺便把确认框这条真路径也走一遍。 */
      await openRowMenu(page, "-copy");
      await clickMenuItem(page, "删除");
      await page.waitForSelector("dialog.confirm-dialog[open]", { label: "确认框" });
      await page.evaluate(() => {
        const button = [...document.querySelectorAll("dialog.confirm-dialog[open] button")].find(
          (node) => node.textContent.trim() === "删除",
        );
        button.click();
      });
      await page.waitFor(() => document.querySelector("dialog.confirm-dialog[open]") === null, {
        label: "确认框关闭",
      });
      await page.waitFor(
        () =>
          ![...document.querySelectorAll("table.upstream-table tbody tr")].some((row) =>
            row.querySelector("[data-col=name]")?.textContent?.includes("-copy"),
          ),
        { label: "克隆行消失", timeout: 10_000 },
      );
    });

    /* 内容型弹窗贴右满高。量几何而不是看类名——类挂上了但 CSS 没加载的话，
       类名断言照样会过。 */
    await check("内容型弹窗是右侧抽屉", async () => {
      await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find(
          (node) => node.textContent.trim() === "导出",
        );
        button.click();
      });
      await page.waitForSelector("dialog.quick-import-dialog[open]", { label: "导出窗" });
      const box = await page.evaluate(() => {
        const dialog = document.querySelector("dialog.quick-import-dialog[open]");
        const rect = dialog.getBoundingClientRect();
        return {
          right: Math.round(window.innerWidth - rect.right),
          top: Math.round(rect.top),
          fullHeight: Math.round(rect.height) >= window.innerHeight - 2,
          hasClass: dialog.classList.contains("dialog--drawer"),
        };
      });
      assertEqual(box.hasClass, true, "挂了抽屉类");
      assert(box.right <= 1, `没贴右边，距右 ${box.right}px`);
      assertEqual(box.top, 0, "顶部对齐");
      assertEqual(box.fullHeight, true, "没有满高");
      await page.evaluate(() => {
        const dialog = document.querySelector("dialog.quick-import-dialog[open]");
        dialog.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await page.waitFor(() => document.querySelector("dialog.quick-import-dialog[open]") === null, {
        label: "导出窗关闭",
      });
    });

    /* 确认框不该变成抽屉——一句话的确认占整面侧边很荒唐。 */
    await check("确认框仍居中", async () => {
      // 用主列表的行：归档区那张表没有 data-col，openRowMenu 找不到。
      await openRowMenu(page, "fixed-weight");
      await clickMenuItem(page, "删除");
      await page.waitForSelector("dialog.confirm-dialog[open]", { label: "确认框" });
      const box = await page.evaluate(() => {
        const dialog = document.querySelector("dialog.confirm-dialog[open]");
        const rect = dialog.getBoundingClientRect();
        const leftGap = rect.left;
        const rightGap = window.innerWidth - rect.right;
        return {
          drawer: dialog.classList.contains("dialog--drawer"),
          centered: Math.abs(leftGap - rightGap) <= 2,
          fullHeight: Math.round(rect.height) >= window.innerHeight - 2,
        };
      });
      assertEqual(box.drawer, false, "确认框不该挂抽屉类");
      assertEqual(box.centered, true, "确认框应水平居中");
      assertEqual(box.fullHeight, false, "确认框不该满高");
      // 取消，别真删了。
      await page.evaluate(() => {
        const button = [...document.querySelectorAll("dialog.confirm-dialog[open] button")].find(
          (node) => node.textContent.trim() === "取消",
        );
        button.click();
      });
      await page.waitFor(() => document.querySelector("dialog.confirm-dialog[open]") === null, {
        label: "确认框关闭",
      });
    });

    /* 点遮罩关窗。旧版十个对话框有这个行为，但登录框、分组框、模型测试窗
       故意没有——后者里面是你刚改过的 prompt。两侧都要测。 */
    await check("点遮罩关导出窗", async () => {
      await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find(
          (node) => node.textContent.trim() === "导出",
        );
        button.click();
      });
      await page.waitForSelector("dialog.quick-import-dialog[open]", { label: "导出窗" });
      // 在 dialog 本体（即遮罩）上完成一次按下→抬起。
      await page.evaluate(() => {
        const dialog = document.querySelector("dialog.quick-import-dialog[open]");
        dialog.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await page.waitFor(() => document.querySelector("dialog.quick-import-dialog[open]") === null, {
        label: "导出窗被遮罩关掉",
      });
    });

    await check("模型测试窗不被遮罩关掉", async () => {
      await openRowMenu(page, "auto-weight");
      await clickMenuItem(page, "测试模型");
      await page.waitForSelector("dialog[aria-label=测试模型][open]", { label: "测试窗" });
      await page.evaluate(() => {
        const dialog = document.querySelector("dialog[aria-label=测试模型][open]");
        dialog.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await sleepInPage(page, 300);
      assertEqual(
        await page.evaluate(
          () => document.querySelector("dialog[aria-label=测试模型][open]") !== null,
        ),
        true,
        "里面有改过的 prompt，不该被遮罩关掉",
      );
      await page.click("dialog[aria-label=测试模型] .icon-close");
      await page.waitFor(
        () => document.querySelector("dialog[aria-label=测试模型][open]") === null,
        { label: "测试窗关闭" },
      );
    });

    /* 快速导入：拉模型、显示、全选，建出来的渠道要带上选中的模型和 999 优先级。
       这三件事各自都能坏掉而不报错：拉不到只是列表空、默认漏勾就是少几个模型、
       优先级退回 100 则完全看不出来。 */
    await check("快速导入拉模型后填进表单而不落库", async () => {
      const dialog = "dialog.quick-import-dialog[open]";
      await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find(
          (node) => node.textContent.trim() === "快速导入",
        );
        if (!button) throw new Error("找不到快速导入按钮");
        button.click();
      });
      await page.waitForSelector(dialog, { label: "快速导入窗" });

      // 真实粘贴的样子：面板地址、密钥、备用地址混在一起，都要被认出来。
      const key = "sk-quick-import-0123456789abcdef";
      await page.fill(
        `${dialog} textarea`,
        `面板：http://127.0.0.1:${fakeUpstreamPort}/v1\n密钥 ${key}\n备用 https://backup.example.com`,
      );

      const pulled = await page.evaluate(async (scope) => {
        const button = [...document.querySelectorAll(`${scope} button`)].find(
          (node) => node.textContent.trim() === "拉取模型",
        );
        if (!button) throw new Error("找不到拉取模型按钮");
        button.click();
        return true;
      }, dialog);
      assert(pulled, "拉取按钮点不到");

      const names = await page.waitFor(
        (scope) => {
          const list = [...document.querySelectorAll(`${scope} .quick-import-models .model-option-name`)].map(
            (node) => node.textContent,
          );
          return list.length > 0 ? list : false;
        },
        { label: "拉取到的模型列表", timeout: 10_000 },
        dialog,
      );
      assertEqual(names.join(","), FAKE_MODELS.join(","), "显示出来的模型");

      // 拉回来就默认全选，否则等于没拉。
      const allChecked = await page.evaluate(
        (scope) =>
          [...document.querySelectorAll(`${scope} .quick-import-models input`)].every(
            (input) => input.checked,
          ),
        dialog,
      );
      assertEqual(allChecked, true, "拉到的模型应默认全选");

      // 摘掉一个，看它会不会跟着渠道存进去。
      await page.evaluate((scope) => {
        const input = [...document.querySelectorAll(`${scope} .quick-import-models input`)][1];
        input.click();
      }, dialog);

      /* 名称框：原始文本框下面、Base URL 上面那个。按顺序数比按 placeholder
         数稳——自适应识别会把名称填成 api-example。 */
      const name = `quick-import-${Date.now()}`;
      await page.evaluate(
        (scope, value) => {
          const input = document.querySelectorAll(`${scope} .field input`)[0];
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          setter.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        },
        dialog,
        name,
      );

      await page.evaluate((scope) => {
        const button = [...document.querySelectorAll(`${scope} .modal-footer button`)].find(
          (node) => node.textContent.trim() === "填入表单",
        );
        if (!button) throw new Error("找不到填入表单按钮");
        button.click();
      }, dialog);

      /* 关键：这一步不该落库，只该把值交给新增表单。等编辑抽屉出现，
         同时确认快速导入窗已经让位。 */
      await page.waitForSelector("dialog.upstream-dialog[open]", {
        label: "新增渠道表单",
        timeout: 10_000,
      });
      assertEqual(
        await page.count("dialog.quick-import-dialog[open]"),
        0,
        "填入表单后快速导入窗该关掉",
      );

      const form = await page.evaluate(() => {
        const dialog = document.querySelector("dialog.upstream-dialog[open]");
        const value = (label) => {
          const field = [...dialog.querySelectorAll(".field")].find(
            (node) => node.querySelector(".field-label")?.textContent?.trim() === label,
          );
          return field?.querySelector("input")?.value ?? null;
        };
        return {
          title: dialog.querySelector(".modal-head h2")?.textContent?.trim() ?? "",
          name: value("名称"),
          baseUrl: value("Base URL"),
          apiKey: value("API Key"),
          priority: value("优先级"),
          chips: [...dialog.querySelectorAll(".model-selection-chip-name")].map(
            (node) => node.textContent,
          ),
          // 草稿没有已存密钥，这个勾选框不该出现——勾了会把刚填的 Key 清掉。
          hasClearKey: dialog.textContent.includes("清空 API Key"),
        };
      });

      // id 0 的草稿要按新建对待，标题写「编辑渠道 #0」就说明走错了分支。
      assertEqual(form.title, "新增渠道", "草稿应按新建对待");
      assertEqual(form.name, name, "名称带进表单");
      assertEqual(form.baseUrl, `http://127.0.0.1:${fakeUpstreamPort}`, "Base URL 带进表单");
      assertEqual(form.apiKey, key, "API Key 带进表单");
      assertEqual(form.priority, "999", "优先级预填 999");
      assertEqual(form.hasClearKey, false, "草稿不该出现清空 API Key");
      assert(
        form.chips.includes(FAKE_MODELS[0]),
        `留下的 ${FAKE_MODELS[0]} 应该在已选模型里：${form.chips}`,
      );
      assert(
        !form.chips.includes(FAKE_MODELS[1]),
        `被摘掉的 ${FAKE_MODELS[1]} 不该在已选模型里：${form.chips}`,
      );

      /* 没保存就关掉：这条只验预填，不该往库里留东西。顺便确认真的没建——
         「不落库」是这次改动的全部意义，光看表单填对了证明不了。 */
      await page.click("dialog.upstream-dialog[open] .icon-close");
      await page.waitFor(() => document.querySelector("dialog.upstream-dialog[open]") === null, {
        label: "表单关闭",
      });
      await page.evaluate(() => {
        const button = [...document.querySelectorAll(".view-toolbar button")].find(
          (node) => node.textContent.trim() === "刷新",
        );
        if (!button) throw new Error("找不到刷新按钮");
        button.click();
      });
      const leaked = await page.evaluate(
        (fragment) =>
          [...document.querySelectorAll("table.upstream-table tbody tr")].some((node) =>
            node.querySelector("[data-col=name]")?.textContent?.includes(fragment),
          ),
        name,
      );
      assertEqual(leaked, false, "只填表单不该建出渠道");
    });

    /* 不带密钥的备份看着完整，导回去每个渠道都要重填。直接比导出文本里
       有没有密钥字段，不看开关勾没勾。 */
    await check("导出默认带密钥，关掉后不带", async () => {
      await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find(
          (node) => node.textContent.trim() === "导出",
        );
        if (!button) throw new Error("找不到导出按钮");
        button.click();
      });
      await page.waitForSelector("dialog.quick-import-dialog[open]", { label: "导出窗" });

      const withKeys = await page.waitFor(
        () => {
          const text = document.querySelector("dialog.quick-import-dialog[open] textarea")?.value ?? "";
          return text.includes("channels") ? text : false;
        },
        { label: "导出文本", timeout: 10_000 },
      );
      assert(withKeys.includes("api_key"), "默认导出应带密钥字段");

      // 关掉开关要重新取一份，而不是在前端裁。
      await page.click("dialog.quick-import-dialog[open] .toggle-row input[type=checkbox]");
      const withoutKeys = await page.waitFor(
        () => {
          const text = document.querySelector("dialog.quick-import-dialog[open] textarea")?.value ?? "";
          return text.includes("channels") && !text.includes("api_key") ? text : false;
        },
        { label: "不带密钥的导出", timeout: 10_000 },
      );
      assert(!withoutKeys.includes("api_key"), "关掉后不该还有密钥字段");

      await page.evaluate(() => {
        const button = [...document.querySelectorAll("dialog.quick-import-dialog[open] button")].find(
          (node) => node.textContent.trim() === "关闭",
        );
        button.click();
      });
      await page.waitFor(() => document.querySelector("dialog.quick-import-dialog[open]") === null, {
        label: "导出窗关闭",
      });
    });

    // ── 卡片视图 ────────────────────────────────────────────
    console.log("\n卡片视图");

    // 视图切换是图标按钮，文案在 aria-label 里。
    await check("切到卡片视图", async () => {
      await page.click("button[aria-label='卡片视图']");
      await page.waitForSelector(".channel-card", { label: "渠道卡片", timeout: 10_000 });
    });

    /* 统计接口返回的是 {"stats":{...}} 而不是裸 map。把整个响应当 map 用的话
       stats[id] 恒为 undefined，指标全是破折号而且不报错。这条专测那个。 */
    await check("卡片指标不是一片破折号", async () => {
      const values = await page.waitFor(
        () => {
          const card = [...document.querySelectorAll(".channel-card")].find((node) =>
            node.textContent.includes("auto-weight"),
          );
          if (!card) return false;
          const tiles = [...card.querySelectorAll(".metric-tile")].map((tile) => ({
            label: tile.querySelector(".metric-label")?.textContent,
            value: tile.querySelector(".metric-value")?.textContent,
          }));
          return tiles.length > 0 ? tiles : false;
        },
        { label: "卡片指标", timeout: 10_000 },
      );
      assertEqual(values.length, 3, "指标格数（旧版三格）");
      const total = values.find((tile) => tile.label === "总请求");
      assert(total !== undefined, `没有总请求格：${JSON.stringify(values)}`);
      assert(total.value !== "—", "总请求是破折号，统计没拿到");
      assert(
        values.some((tile) => tile.label === "平均 Token / 千次请求"),
        `平均 Token 格标签不对：${JSON.stringify(values)}`,
      );
    });

    await check("24h 健康区渲染出来", async () => {
      const health = await page.evaluate(() => {
        const card = [...document.querySelectorAll(".channel-card")].find((node) =>
          node.textContent.includes("auto-weight"),
        );
        const block = card?.querySelector(".channel-card-health");
        return {
          exists: block !== null && block !== undefined,
          stats: [...(block?.querySelectorAll(".health-stat") ?? [])].map((n) => n.textContent),
          bars: block?.querySelectorAll(".health-bar").length ?? 0,
          empty: block?.querySelector(".health-bars-empty") !== null,
        };
      });
      assertEqual(health.exists, true, "健康区存在");
      assertEqual(health.stats.length, 2, "在线率 + 均延迟两项");
      assert(health.stats[0].startsWith("在线率"), `第一项应是在线率：${health.stats}`);
      // 种子里走过一遍网关，这个渠道 24h 内有请求，应该有柱而不是空态。
      assert(health.bars > 0 || health.empty, "健康条既没柱也没空态");
    });

    await check("查看详情按钮开编辑框", async () => {
      await page.evaluate(() => {
        const card = [...document.querySelectorAll(".channel-card")].find((node) =>
          node.textContent.includes("auto-weight"),
        );
        card.querySelector(".channel-card-action").click();
      });
      await page.waitForSelector("dialog.upstream-dialog[open]", { label: "编辑对话框" });
      await page.click("dialog.upstream-dialog[open] .icon-close");
      await page.waitFor(() => document.querySelector("dialog.upstream-dialog[open]") === null, {
        label: "编辑对话框关闭",
      });
      // 换回列表视图，后面的检查都按表格写的。
      await page.click("button[aria-label='列表视图']");
      await page.waitForSelector("table.upstream-table", { label: "表格视图" });
    });

    // ── 模型选择器 ──────────────────────────────────────────
    console.log("\n模型选择器");

    await check("菜单拉取模型后开出选择器", async () => {
      await openRowMenu(page, "auto-weight");
      await clickMenuItem(page, "拉取模型");
      await page.waitForSelector("dialog.model-dialog[open]", { label: "选择器", timeout: 10_000 });
      const summary = await page.text("dialog.model-dialog .modal-head p");
      assert(summary?.includes(`上游返回 ${FAKE_MODELS.length}`), `摘要不对：${summary}`);
      assert(summary?.includes("1 个未由上游返回"), `应数出未返回的：${summary}`);
    });

    await check("已选但上游没返回的模型标出来", async () => {
      const marked = await page.evaluate(() =>
        [...document.querySelectorAll("dialog.model-dialog .model-option")]
          .filter((option) => option.querySelector(".model-option-state"))
          .map((option) => option.querySelector(".model-option-name")?.textContent),
      );
      assertEqual(marked.join(","), "retired-model", "标为未返回的模型");
    });

    await check("映射单独成行且默认选中", async () => {
      const mapping = await page.evaluate(() => {
        const option = document.querySelector("dialog.model-dialog .model-option.is-mapping");
        return {
          text: option?.querySelector(".model-option-name")?.textContent ?? null,
          checked: option?.querySelector("input")?.checked ?? null,
        };
      });
      assertEqual(mapping.text, "fast => gpt-4o-mini", "映射行文本");
      assertEqual(mapping.checked, true, "映射默认勾选");
    });

    await check("筛选只留匹配项", async () => {
      await page.fill("dialog.model-dialog input[type=search]", "mini");
      const names = await page.evaluate(() =>
        [...document.querySelectorAll("dialog.model-dialog .model-option-name")].map((n) => n.textContent),
      );
      assertEqual(names.join(","), "fast => gpt-4o-mini,gpt-4o-mini", "筛选结果");
    });

    await check("全选只作用于可见项", async () => {
      await page.click("dialog.model-dialog .model-toolbar-actions button:nth-of-type(1)");
      await page.fill("dialog.model-dialog input[type=search]", "");
      const checked = await page.evaluate(() =>
        [...document.querySelectorAll("dialog.model-dialog .model-option")]
          .filter((option) => option.querySelector("input")?.checked)
          .map((option) => option.querySelector(".model-option-name")?.textContent),
      );
      // 原本选中 gpt-4o / retired-model / 映射，筛出 mini 后全选只该多出 gpt-4o-mini。
      assert(checked.includes("gpt-4o-mini"), `可见项没被选中：${checked}`);
      assert(!checked.includes("claude-sonnet-5"), `不可见项被误选：${checked}`);
    });

    await check("移除未返回只去掉那一个", async () => {
      await page.evaluate(() => {
        const button = [...document.querySelectorAll("dialog.model-dialog .model-toolbar-actions button")]
          .find((b) => b.textContent.trim() === "移除未返回");
        if (!button) throw new Error("找不到移除未返回按钮");
        button.click();
      });
      const summary = await page.text("dialog.model-dialog .modal-head p");
      assert(!summary?.includes("未由上游返回"), `还剩着未返回项：${summary}`);
    });

    await check("手动输入带箭头的登记为映射", async () => {
      await page.fill("dialog.model-dialog .model-manual-entry input", "cheap => gpt-4o-mini");
      await page.click("dialog.model-dialog .model-manual-entry button");
      const mappings = await page.evaluate(() =>
        [...document.querySelectorAll("dialog.model-dialog .model-option.is-mapping .model-option-name")]
          .map((n) => n.textContent),
      );
      assert(mappings.includes("cheap => gpt-4o-mini"), `映射没登记上：${mappings}`);
    });

    await check("保存选择后回写到渠道", async () => {
      await page.evaluate(() => {
        const button = [...document.querySelectorAll("dialog.model-dialog .modal-footer button")]
          .find((b) => b.textContent.trim().startsWith("保存"));
        if (!button) throw new Error("找不到保存按钮");
        button.click();
      });
      await page.waitFor(() => document.querySelector("dialog.model-dialog[open]") === null, {
        label: "选择器关闭",
        timeout: 10_000,
      });
      const cell = await page.waitFor(
        () => {
          const rows = [...document.querySelectorAll("table.upstream-table tbody tr")];
          const row = rows.find((r) => r.querySelector("[data-col=name]")?.textContent?.includes("auto-weight"));
          const text = row?.querySelector("[data-col=models]")?.textContent ?? "";
          return text.includes("cheap=>gpt-4o-mini") ? text : false;
        },
        { label: "模型匹配格更新" },
      );
      assert(!cell.includes("retired-model"), `移除的模型还在：${cell}`);
    });

    // ── 测试模型 ──────────────────────────────────────────────
    console.log("\n测试模型");

    await check("菜单第一项就是测试模型", async () => {
      await openRowMenu(page, "auto-weight");
      const first = await page.evaluate(() =>
        document.querySelector("[role=menu] [role=menuitem]")?.textContent?.trim() ?? null,
      );
      assertEqual(first, "测试模型", "菜单首项");
    });

    await check("开窗后模型与 Prompt 都预填了", async () => {
      await clickMenuItem(page, "测试模型");
      await page.waitForSelector("dialog[aria-label=测试模型][open]", { label: "测试窗" });
      const state = await page.waitFor(
        () => {
          const dialog = document.querySelector("dialog[aria-label=测试模型]");
          const selects = dialog?.querySelectorAll("select");
          const prompt = dialog?.querySelector("textarea")?.value ?? "";
          if (!selects || !prompt) return false;
          return { model: selects[0].value, protocol: selects[1].value, prompt };
        },
        { label: "预填值" },
      );
      assertEqual(state.protocol, "responses", "默认协议");
      assert(state.model !== "", "模型下拉没预填");
      assert(state.prompt !== "", "Prompt 没预填");

      /* 开窗时是随机挑一条模板，所以不能对死文本。要验的是另一件事：
         预填的正文确实是当前选中那条模板的，而不是别人的。 */
      const matched = await page.evaluate(async () => {
        const dialog = document.querySelector("dialog[aria-label=测试模型]");
        const id = Number(dialog.querySelectorAll("select")[2].value);
        const response = await fetch("/api/admin/settings/model-test-prompts", {
          headers: { "x-admin-token": localStorage.getItem("wildtoken_admin_token") },
        });
        const list = await response.json();
        return list.find((item) => item.id === id)?.prompt === dialog.querySelector("textarea").value;
      });
      assertEqual(matched, true, "预填正文与选中模板一致");
    });

    await check("换模板时 Prompt 跟着换", async () => {
      const changed = await page.evaluate(() => {
        const dialog = document.querySelector("dialog[aria-label=测试模型]");
        const select = dialog.querySelectorAll("select")[2];
        const before = dialog.querySelector("textarea").value;
        const other = [...select.options].find((option) => option.value !== select.value);
        if (!other) return "only-one";
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(select, other.value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return { before, label: other.textContent };
      });
      assert(changed !== "only-one", "只有一条模板，这条断言没意义");
      const after = await page.evaluate(
        () => document.querySelector("dialog[aria-label=测试模型] textarea").value,
      );
      assert(after !== changed.before, `换了模板「${changed.label}」Prompt 没变`);
    });

    await check("发送测试抽出模型回复", async () => {
      await page.evaluate(() => {
        const dialog = document.querySelector("dialog[aria-label=测试模型]");
        dialog.querySelector(".modal-footer button[type=submit]").click();
      });
      const status = await page.waitFor(
        () =>
          document.querySelector("dialog[aria-label=测试模型] .test-model-result-head strong")
            ?.textContent ?? false,
        { label: "测试结果", timeout: 15_000 },
      );
      assertEqual(status, "测试成功 · HTTP 200", "结果状态行");
      const reply = await page.text("dialog[aria-label=测试模型] .test-model-response pre");
      assertEqual(reply, "假上游的回复。", "模型回复");
    });

    await check("请求与响应原文都摊开了", async () => {
      const bodies = await page.evaluate(() =>
        [...document.querySelectorAll("dialog[aria-label=测试模型] .test-model-details pre")].map(
          (pre) => pre.textContent ?? "",
        ),
      );
      assertEqual(bodies.length, 2, "两个折叠区");
      assert(bodies[0].startsWith("POST /v1/responses"), `请求首行：${bodies[0].slice(0, 60)}`);
      assert(bodies[0].includes("host: 127.0.0.1:"), "请求头里应有 host");
      assert(bodies[1].startsWith("HTTP/1.1 200"), `响应首行：${bodies[1].slice(0, 60)}`);
    });

    await check("切协议后打到对应路径", async () => {
      await page.evaluate(() => {
        const select = document.querySelectorAll("dialog[aria-label=测试模型] select")[1];
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(select, "messages");
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.evaluate(() => {
        const dialog = document.querySelector("dialog[aria-label=测试模型]");
        dialog.querySelector(".modal-footer button[type=submit]").click();
      });
      const request = await page.waitFor(
        () => {
          const pre = document.querySelector("dialog[aria-label=测试模型] .test-model-details pre");
          const text = pre?.textContent ?? "";
          return text.startsWith("POST /v1/messages") ? text : false;
        },
        { label: "messages 协议请求", timeout: 15_000 },
      );
      // claude-cli 会带这个参数，旧版照实发。
      assert(request.includes("beta=true"), "messages 应带 beta=true");
    });

    await check("关掉测试窗", async () => {
      await page.click("dialog[aria-label=测试模型] .icon-close");
      await page.waitFor(() => document.querySelector("dialog[aria-label=测试模型][open]") === null, {
        label: "测试窗关闭",
      });
    });

    // ── 余额查询 ──────────────────────────────────────────────
    console.log("\n余额查询");

    /* 假上游的第一次计费请求慢 1.5 秒。趁它在途中关窗并换查 sub2api，先发的
       new-api 必然后到。没有作废机制的话，它会落进一个已经换了主题的窗口，
       界面上就出现另一家的数字。

       注意不能拿「点刷新」构造竞态：查询期间刷新按钮是禁用的，那条路压根不
       存在。 */
    await check("关窗作废在途查询，不串到下一个窗口", async () => {
      await openRowMenu(page, "auto-weight");
      await clickMenuItem(page, "查询 new-api 余额");
      await page.waitForSelector("dialog.balance-dialog[open]", { label: "余额窗" });
      await page.click("dialog.balance-dialog .icon-close");
      await openRowMenu(page, "auto-weight");
      await clickMenuItem(page, "查询 sub2api 余额");

      await page.waitFor(
        () =>
          [...document.querySelectorAll("dialog.balance-dialog .balance-row .label")].some(
            (label) => label.textContent === "计划",
          ),
        { label: "sub2api 结果", timeout: 10_000 },
      );

      // 等慢的那个 new-api 响应回来，再看一眼窗里是不是还是 sub2api。
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 2000)));
      const labels = await page.evaluate(() =>
        [...document.querySelectorAll("dialog.balance-dialog .balance-row .label")].map(
          (label) => label.textContent,
        ),
      );
      assert(labels.includes("计划"), `窗里不再是 sub2api：${labels}`);
      assert(!labels.includes("总额"), `new-api 的结果串进来了：${labels}`);
    });

    await check("sub2api 换一套字段", async () => {
      const rows = await page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll("dialog.balance-dialog .balance-row")].map((row) => [
            row.querySelector(".label")?.textContent,
            row.querySelector(".value")?.textContent,
          ]),
        ),
      );
      assertEqual(rows["余额"], "$12.5", "余额");
      assertEqual(rows["累计实耗"], "$3.25", "累计实耗");
      assertEqual(rows["计划"], "pro", "计划");
      assertEqual(rows["状态"], "有效", "状态");
      assertEqual(rows["模式"], "shared", "模式");
    });

    await check("new-api 算出剩余", async () => {
      await page.click("dialog.balance-dialog .icon-close");
      await page.waitFor(() => document.querySelector("dialog.balance-dialog[open]") === null, {
        label: "余额窗关闭",
      });
      await openRowMenu(page, "auto-weight");
      await clickMenuItem(page, "查询 new-api 余额");
      const rows = await page.waitFor(
        () => {
          const entries = [...document.querySelectorAll("dialog.balance-dialog .balance-row")];
          if (entries.length === 0) return false;
          return Object.fromEntries(
            entries.map((row) => [
              row.querySelector(".label")?.textContent,
              row.querySelector(".value")?.textContent,
            ]),
          );
        },
        { label: "new-api 余额行", timeout: 10_000 },
      );
      assertEqual(rows["总额"], "$100", "总额");
      assertEqual(rows["已用"], "$25", "已用（后端把分除以 100）");
      assertEqual(rows["剩余"], "$75", "剩余 = 总额 - 已用");
      await page.click("dialog.balance-dialog .icon-close");
    });

    // ── 渠道编辑表单 ─────────────────────────────────────────
    console.log("\n渠道编辑表单");

    await check("分四节，高级区可折叠", async () => {
      await openRowMenu(page, "auto-weight");
      await clickMenuItem(page, "编辑");
      await page.waitForSelector("dialog.upstream-dialog[open]", { label: "编辑对话框" });
      const heads = await page.evaluate(() =>
        [...document.querySelectorAll("dialog.upstream-dialog[open] .form-section-head h3")].map(
          (h) => h.textContent,
        ),
      );
      assertEqual(heads.join(","), "基础信息,模型路由,运行设置", "分节标题");
      const collapsible = await page.count("dialog.upstream-dialog[open] details.form-section-collapsible");
      assertEqual(collapsible, 1, "可折叠的高级区");
    });

    await check("所属分组预勾上", async () => {
      const checked = await page.evaluate(() =>
        [...document.querySelectorAll("dialog.upstream-dialog[open] .group-checkbox")]
          .filter((label) => label.querySelector("input")?.checked)
          .map((label) => label.querySelector("span")?.textContent),
      );
      assertEqual(checked.join(","), "vip", "已勾分组");
    });

    /* 模型名是芯片，映射单独一个多行文本框，每行一条 `a => b`。
       高级区是 details，所以 section 里的 textarea 只有映射这一个。 */
    const MAPPINGS_TEXTAREA = "dialog.upstream-dialog[open] section.form-section textarea";

    await check("已选模型渲染成芯片，映射不在芯片里", async () => {
      const chips = await page.evaluate(() =>
        [...document.querySelectorAll("dialog.upstream-dialog[open] .model-selection-chip-name")].map(
          (chip) => chip.textContent,
        ),
      );
      assert(chips.includes("gpt-4o"), `模型名没渲染成芯片：${chips}`);
      assert(!chips.some((chip) => chip.includes("=>")), `映射混进了芯片：${chips}`);
    });

    await check("映射回填到自己的文本框", async () => {
      const lines = await page.evaluate(
        (sel) => document.querySelector(sel).value.split("\n").filter(Boolean),
        MAPPINGS_TEXTAREA,
      );
      assertEqual(lines.join("|"), "fast => gpt-4o-mini", "映射文本框内容");
    });

    await check("芯片可以就地摘掉", async () => {
      const before = await page.count("dialog.upstream-dialog[open] .model-selection-chip");
      await page.click("dialog.upstream-dialog[open] .model-selection-remove");
      const after = await page.count("dialog.upstream-dialog[open] .model-selection-chip");
      assertEqual(after, before - 1, "摘掉一个后的芯片数");
    });

    /* 第二条入口：渠道编辑表单里的两个按钮。它走的是另一个接口（探一个还没
       存下来的 Base URL），也不碰服务端，和行菜单那条没有任何共用逻辑。 */
    await check("编辑表单里管理模型不拉取", async () => {
      await page.evaluate(() => {
        const button = [
          ...document.querySelectorAll("dialog.upstream-dialog[open] .form-section-head-actions button"),
        ].find((b) => b.textContent.trim() === "管理模型");
        if (!button) throw new Error("找不到管理模型按钮");
        button.click();
      });
      await page.waitForSelector("dialog.model-dialog[open]", { label: "选择器" });
      const summary = await page.text("dialog.model-dialog .modal-head p");
      assert(summary?.includes("列表"), `没拉取时该报列表数：${summary}`);
      assert(!summary?.includes("上游返回"), `没拉取却声称上游返回：${summary}`);
      // 没拉过就没有判断依据，这个按钮不该出现。
      const hasRemove = await page.evaluate(() =>
        [...document.querySelectorAll("dialog.model-dialog .model-toolbar-actions button")]
          .some((b) => b.textContent.trim() === "移除未返回"),
      );
      assertEqual(hasRemove, false, "未拉取时的移除未返回按钮");
    });

    await check("选择器写回表单而不是直接存库", async () => {
      await page.fill("dialog.model-dialog .model-manual-entry input", "draft-only");
      await page.click("dialog.model-dialog .model-manual-entry button");
      await page.evaluate(() => {
        const button = [...document.querySelectorAll("dialog.model-dialog .modal-footer button")]
          .find((b) => b.textContent.trim().startsWith("保存"));
        button.click();
      });
      await page.waitFor(() => document.querySelector("dialog.model-dialog[open]") === null, {
        label: "选择器关闭",
      });
      const chips = await page.evaluate(() =>
        [...document.querySelectorAll("dialog.upstream-dialog[open] .model-selection-chip-name")].map(
          (chip) => chip.textContent,
        ),
      );
      assert(chips.includes("draft-only"), `没写回芯片：${chips}`);
      // 表单没提交，库里不该有这个名字。
      const stored = await page.evaluate(async () => {
        const response = await fetch("/api/admin/upstreams/", {
          headers: { "x-admin-token": localStorage.getItem("wildtoken_admin_token") },
        });
        const list = await response.json();
        return list.some((item) => item.model_names.includes("draft-only"));
      });
      assertEqual(stored, false, "未保存的选择不该落库");
    });

    await check("表单里拉取模型走预览接口", async () => {
      await page.evaluate(() => {
        const button = [
          ...document.querySelectorAll("dialog.upstream-dialog[open] .form-section-head-actions button"),
        ].find((b) => b.textContent.trim() === "拉取模型");
        if (!button) throw new Error("找不到拉取模型按钮");
        button.click();
      });
      await page.waitForSelector("dialog.model-dialog[open]", { label: "选择器", timeout: 10_000 });
      const summary = await page.text("dialog.model-dialog .modal-head p");
      assert(summary?.includes(`上游返回 ${FAKE_MODELS.length}`), `摘要不对：${summary}`);
      await page.click("dialog.model-dialog .modal-footer button.secondary");
    });

    /* 旧控制台把映射显示成 `a => b`。从那边复制过来的内容必须能原样吃下；
       只找第一个 `=` 的写法会把它切成 `a` 和 `> b`，而且不报错。 */
    await check("思考强度映射吃得下箭头写法", async () => {
      await page.evaluate(() => {
        const details = document.querySelector("dialog.upstream-dialog[open] details.form-section");
        details.open = true;
      });
      await page.evaluate(() => {
        const areas = [...document.querySelectorAll("dialog.upstream-dialog[open] details textarea")];
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setter.call(areas[1], "max => xhigh");
        areas[1].dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.evaluate(() => {
        document
          .querySelector("dialog.upstream-dialog[open] .modal-footer button[type=submit]")
          .click();
      });
      await page.waitFor(() => document.querySelector("dialog.upstream-dialog[open]") === null, {
        label: "编辑对话框关闭",
        timeout: 10_000,
      });
      const stored = await page.evaluate(async () => {
        const response = await fetch("/api/admin/upstreams/", {
          headers: { "x-admin-token": localStorage.getItem("wildtoken_admin_token") },
        });
        const list = await response.json();
        return list.find((item) => item.name.includes("auto-weight"))?.effort_mappings ?? null;
      });
      assertEqual(JSON.stringify(stored), '{"max":"xhigh"}', "落库的思考强度映射");
    });

    /* 后端也拦，但报回来只是一条 400。在这里拦能直接指出是哪一个头。 */
    await check("不可覆盖的传输头被点名拦下", async () => {
      await openRowMenu(page, "auto-weight");
      await clickMenuItem(page, "编辑");
      await page.waitForSelector("dialog.upstream-dialog[open]", { label: "编辑对话框" });
      await page.evaluate(() => {
        const details = document.querySelector("dialog.upstream-dialog[open] details.form-section");
        details.open = true;
        const areas = [...document.querySelectorAll("dialog.upstream-dialog[open] details textarea")];
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setter.call(areas[0], '{"Host":"evil.example"}');
        areas[0].dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.evaluate(() => {
        document.querySelector("dialog.upstream-dialog[open] .modal-footer button[type=submit]").click();
      });
      await sleepInPage(page, 300);
      const toast = await page.evaluate(() => {
        const node = [...document.querySelectorAll(".toast")].find((n) =>
          n.textContent.includes("Host"),
        );
        return node?.textContent ?? null;
      });
      assert(toast?.includes("不能覆盖"), `没点名 Host：${toast}`);
      assertEqual(
        await page.evaluate(() => document.querySelector("dialog.upstream-dialog[open]") !== null),
        true,
        "拦下时对话框应留着",
      );
      await page.click("dialog.upstream-dialog[open] .icon-close");
      await page.waitFor(() => document.querySelector("dialog.upstream-dialog[open]") === null, {
        label: "编辑对话框关闭",
      });
    });

    /* 标准报文写法：从 curl -v 或浏览器网络面板拷出来直接粘。重点测两件事——
       值里的冒号不能被切，回显要是每行一条而不是 JSON。 */
    await check("Header 收报文写法且回显成行", async () => {
      await openRowMenu(page, "auto-weight");
      await clickMenuItem(page, "编辑");
      await page.waitForSelector("dialog.upstream-dialog[open]", { label: "编辑对话框" });
      await page.evaluate(() => {
        const details = document.querySelector("dialog.upstream-dialog[open] details.form-section");
        details.open = true;
        const areas = [...document.querySelectorAll("dialog.upstream-dialog[open] details textarea")];
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        // 第二条的值里带冒号，只能按第一个切。
        setter.call(areas[0], "X-Tenant: acme\nX-Origin: https://a.example:8443/v1");
        areas[0].dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.evaluate(() => {
        document.querySelector("dialog.upstream-dialog[open] .modal-footer button[type=submit]").click();
      });
      await page.waitFor(() => document.querySelector("dialog.upstream-dialog[open]") === null, {
        label: "编辑对话框关闭",
        timeout: 10_000,
      });

      const stored = await page.evaluate(async () => {
        const admin = localStorage.getItem("wildtoken_admin_token");
        const list = await (
          await fetch("/api/admin/upstreams/", { headers: { "x-admin-token": admin } })
        ).json();
        return list.find((item) => item.name.includes("auto-weight"))?.extra_headers ?? null;
      });
      assertEqual(stored["x-tenant"], "acme", "第一条落库");
      assertEqual(
        stored["x-origin"],
        "https://a.example:8443/v1",
        "值里的冒号不该被切断",
      );

      // 重新打开：回显要是每行一条，不是 JSON。
      await openRowMenu(page, "auto-weight");
      await clickMenuItem(page, "编辑");
      await page.waitForSelector("dialog.upstream-dialog[open]", { label: "编辑对话框" });
      const shown = await page.evaluate(() => {
        const details = document.querySelector("dialog.upstream-dialog[open] details.form-section");
        details.open = true;
        return document.querySelectorAll("dialog.upstream-dialog[open] details textarea")[0].value;
      });
      assert(!shown.includes("{"), `回显成了 JSON：${shown}`);
      assert(shown.includes("x-tenant: acme"), `回显不是报文写法：${shown}`);
    });

    await check("仍然收旧的 JSON 写法", async () => {
      await page.evaluate(() => {
        const areas = [...document.querySelectorAll("dialog.upstream-dialog[open] details textarea")];
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setter.call(areas[0], '{"X-Legacy":"kept"}');
        areas[0].dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.evaluate(() => {
        document.querySelector("dialog.upstream-dialog[open] .modal-footer button[type=submit]").click();
      });
      await page.waitFor(() => document.querySelector("dialog.upstream-dialog[open]") === null, {
        label: "编辑对话框关闭",
        timeout: 10_000,
      });
      const stored = await page.evaluate(async () => {
        const admin = localStorage.getItem("wildtoken_admin_token");
        const list = await (
          await fetch("/api/admin/upstreams/", { headers: { "x-admin-token": admin } })
        ).json();
        return list.find((item) => item.name.includes("auto-weight"))?.extra_headers ?? null;
      });
      assertEqual(stored["x-legacy"], "kept", "JSON 写法仍然能存");
    });

    await check("Header 不是合法 JSON 就不保存", async () => {
      await openRowMenu(page, "auto-weight");
      await clickMenuItem(page, "编辑");
      await page.waitForSelector("dialog.upstream-dialog[open]", { label: "编辑对话框" });
      await page.evaluate(() => {
        const details = document.querySelector("dialog.upstream-dialog[open] details.form-section");
        details.open = true;
        const areas = [...document.querySelectorAll("dialog.upstream-dialog[open] details textarea")];
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setter.call(areas[0], "{not json");
        areas[0].dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.evaluate(() => {
        document
          .querySelector("dialog.upstream-dialog[open] .modal-footer button[type=submit]")
          .click();
      });
      await sleepInPage(page, 300);
      const stillOpen = await page.evaluate(
        () => document.querySelector("dialog.upstream-dialog[open]") !== null,
      );
      assertEqual(stillOpen, true, "解析失败时对话框应留着");
      // 以 { 开头会走 JSON 分支，文案是「看起来是 JSON 但解析失败」。
      const toasted = await page.evaluate(() =>
        [...document.querySelectorAll(".toast")].some((node) =>
          node.textContent.includes("解析失败"),
        ),
      );
      assertEqual(toasted, true, "应提示解析失败");
      await page.click("dialog.upstream-dialog[open] .icon-close");
      await page.waitFor(() => document.querySelector("dialog.upstream-dialog[open]") === null, {
        label: "编辑对话框关闭",
      });
    });

    // ── 日志详情与会话视图 ─────────────────────────────────────
    console.log("\n日志详情");

    await check("日志页有那条真实请求", async () => {
      await gotoView(page, "日志");
      const clients = await page.waitFor(
        () => {
          const rows = [...document.querySelectorAll("table tbody tr [data-col=client]")];
          return rows.length > 0 ? rows.map((node) => node.textContent.trim()) : false;
        },
        { label: "日志行", timeout: 10_000 },
      );
      // 整行能被键盘达到，否则只能鼠标用。
      const focusable = await page.evaluate(
        () => document.querySelector("table.log-table tbody tr.log-row")?.tabIndex ?? -1,
      );
      assertEqual(focusable, 0, "日志行的 tabIndex");
      assert(
        clients.some((client) => !["model-list", "model-test", "balance"].includes(client)),
        `只有探测日志：${clients}`,
      );
    });

    /* 渠道格是上下两行：#ID 在上，渠道名在下。写成一行的话，同名不同 ID 的渠道
       在日志里分不出来。 */
    /* 不能盲取第一行：表单里的「拉取模型」探的是一个还没存下来的 URL，那条日志
       本来就没有渠道，显示「无（未匹配到渠道）」是对的。找一行真有渠道的。 */
    await check("渠道格是 #ID 加渠道名两行", async () => {
      const stack = await page.evaluate(() => {
        const node = document.querySelector("table.log-table tbody tr .channel-stack");
        if (!node) return null;
        return {
          id: node.querySelector("strong")?.textContent ?? "",
          name: node.querySelector("span")?.textContent ?? "",
        };
      });
      assert(stack !== null, "一行 channel-stack 都没有，还是单行");
      assert(/^#\d+$/.test(stack.id), `上行应是 #ID，实际 ${JSON.stringify(stack.id)}`);
      assert(stack.name !== "", "下行渠道名为空");
    });

    await check("遮罩后不泄露长度和首尾字符", async () => {
      await page.click(".log-toolbar .log-sensitive-toggle");
      const masked = await page.evaluate(() => {
        const node = document.querySelector("table.log-table tbody tr .channel-stack");
        return {
          channel: node?.querySelector(".log-sensitive-value")?.textContent ?? null,
          id: node?.querySelector("strong")?.textContent ?? null,
        };
      });
      assertEqual(masked.channel, "******", "渠道名遮罩为固定星号");
      // ID 不是敏感信息，遮了就没法对号了。
      assert(/^#\d+$/.test(masked.id ?? ""), `ID 不该被遮：${masked.id}`);
      await page.click(".log-toolbar .log-sensitive-toggle");
    });

    /* 这一列的重点是颜色：CSS 里 ok/warn/danger 各有规则。写死成 neutral 的话
       数字照样显示，只是永远是灰的——扫一眼看不出哪条慢。 */
    await check("响应性能列带评级色调且用秒", async () => {
      const cells = await page.waitFor(
        () => {
          const rows = [...document.querySelectorAll("table.log-table tbody tr")];
          const found = rows
            .map((row) => {
              const first = row.querySelector(".first-token-time");
              const total = row.querySelector(".duration-time");
              if (!first || !total) return null;
              return {
                firstClass: first.className,
                firstText: first.textContent ?? "",
                totalClass: total.className,
                totalText: total.textContent ?? "",
                totalTitle: total.getAttribute("title") ?? "",
              };
            })
            .filter(Boolean);
          return found.length > 0 ? found : false;
        },
        { label: "响应性能格", timeout: 10_000 },
      );

      // 数值用秒：要么是破折号，要么是 0.3s 这种形式，不能是 312ms。
      for (const cell of cells) {
        assert(
          cell.totalText === "-" || /^\d+\.\ds$/.test(cell.totalText),
          `总耗时不是秒格式：${cell.totalText}`,
        );
        assert(
          cell.firstText === "-" || /^\d+\.\ds$/.test(cell.firstText),
          `首字不是秒格式：${cell.firstText}`,
        );
      }

      // 至少有一行拿到了非 neutral 的评级，否则等于色调根本没生效。
      const toned = cells.filter((cell) => !cell.totalClass.includes("neutral"));
      assert(toned.length > 0, `所有行的总耗时都是 neutral：${cells.length} 行`);
      // title 要说清楚凭什么判的。
      assert(
        toned[0].totalTitle.includes("总耗时") && toned[0].totalTitle.includes("判定"),
        `title 没说明判定依据：${toned[0].totalTitle}`,
      );
    });

    /* 非 2xx 优先标红。一个 3 秒就返回 500 的请求，按吞吐算会是绿的——
       快失败也是失败。 */
    await check("失败请求的总耗时标红", async () => {
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll("table.log-table tbody tr")]
          .map((row) => ({
            status: row.querySelector("[data-col=status]")?.textContent?.trim() ?? "",
            tone: row.querySelector(".duration-time")?.className ?? "",
          }))
          .filter((row) => /^[45]\d\d$/.test(row.status)),
      );
      if (rows.length === 0) return; // 这一页没失败请求，不强求。
      assert(
        rows.every((row) => row.tone.includes("danger")),
        `失败请求没标红：${JSON.stringify(rows)}`,
      );
    });

    /* 详情列是错误信息，不是按钮。放按钮的话列表里看不出错在哪，
       每行都得点开才知道。 */
    await check("详情列直接显示错误信息", async () => {
      const cells = await page.evaluate(() =>
        [...document.querySelectorAll("table.log-table tbody tr")].map((row) => ({
          hasButton: row.querySelector("[data-col=detail] button") !== null,
          error: row.querySelector("[data-col=detail] .log-error-detail")?.textContent ?? null,
          title: row.querySelector("[data-col=detail] .log-error-detail")?.getAttribute("title") ?? null,
        })),
      );
      assert(cells.length > 0, "一行都没有");
      assert(
        cells.every((cell) => !cell.hasButton),
        "详情列还是按钮",
      );
      const withError = cells.find((cell) => cell.error);
      if (withError) {
        // 截断后全文要留在 title 里。
        assert(withError.title.length >= withError.error.length, "title 没存全文");
      }
    });

    await check("Tokens 列的精确值放在 title 里", async () => {
      const io = await page.evaluate(() => {
        const node = document.querySelector("table.log-table tbody tr .token-io");
        return {
          label: node?.getAttribute("aria-label") ?? null,
          inTitle: node?.querySelector(".token-io-in")?.getAttribute("title") ?? null,
        };
      });
      assert(io.label?.includes("tokens"), `token-io 缺 aria-label：${io.label}`);
      assert(io.inTitle?.startsWith("输入"), `输入行缺 title：${io.inTitle}`);
    });

    /* 速率胶囊那行必须是 <p>：CSS 选择器是 .panel p.log-rate-pills，换成 div
       那条规则一条都不匹配。量实际间距而不是看标签名。 */
    await check("速率行与筛选行的间距生效", async () => {
      const layout = await page.evaluate(() => {
        const pills = document.querySelector(".log-rate-pills");
        const toolbar = document.querySelector(".log-toolbar");
        if (!pills || !toolbar) return null;
        const style = getComputedStyle(pills);
        return {
          tag: pills.tagName,
          display: style.display,
          gap: style.gap,
          marginTop: style.marginTop,
          // 间距来自 panel-head 的 padding-bottom + margin-bottom，所以必须在它里面。
          insideHead: pills.closest(".panel-head") !== null,
          // 胶囊底部到筛选行顶部的实际距离。
          gapToToolbar: Math.round(
            toolbar.getBoundingClientRect().top - pills.getBoundingClientRect().bottom,
          ),
          pillCount: pills.querySelectorAll(".log-rate-pill").length,
        };
      });
      assert(layout !== null, "速率行或筛选行不在");
      assertEqual(layout.tag, "P", "速率行必须是 p，否则 CSS 不匹配");
      assertEqual(layout.display, "flex", "三个胶囊应并排");
      assertEqual(layout.gap, "6px", "胶囊间距");
      assertEqual(layout.marginTop, "8px", "速率行上边距");
      assertEqual(layout.pillCount, 3, "RPM / TPM / 并发");
      assertEqual(layout.insideHead, true, "速率行要在 panel-head 里，否则吃不到它的下边距");
      /* panel-head 的 padding-bottom 14 + border 1 + margin-bottom 14 = 29。
         卡范围而不是精确值：要拦的是「两行贴在一起」，不是边框粗了一像素。 */
      assert(
        layout.gapToToolbar >= 24 && layout.gapToToolbar <= 34,
        `速率行到筛选行的间距 ${layout.gapToToolbar}px 不对`,
      );
    });

    await check("表头与表体均为 11 列", async () => {
      const head = await page.count("table.log-table thead th");
      const body = await page.evaluate(
        () => document.querySelector("table.log-table tbody tr")?.children.length ?? 0,
      );
      assertEqual(head, 11, "表头列数");
      assertEqual(body, 11, "表体格数");
      const reasoning = await page.count("table.log-table thead th[data-col=reasoning]");
      assertEqual(reasoning, 1, "思考强度表头");
    });

    /* 窄到什么程度要量，不能只看 CSS 里的数字；同时要确认时间戳没因为变窄
       而折成两行——折行比宽一点难看得多。 */
    await check("时间与渠道列不占宽且不折行", async () => {
      const measured = await page.waitFor(
        () => {
          const row = document.querySelector("table.log-table tbody tr");
          const time = row?.querySelector("[data-col=time]");
          const channel = row?.querySelector("[data-col=channel]");
          if (!time || !channel) return false;
          const stamp = time.querySelector("span");
          const style = getComputedStyle(stamp);
          return {
            timeWidth: Math.round(time.getBoundingClientRect().width),
            channelWidth: Math.round(channel.getBoundingClientRect().width),
            // 单行高 ≈ lineHeight；明显高于它就是折了行。
            stampHeight: Math.round(stamp.getBoundingClientRect().height),
            lineHeight: Math.round(parseFloat(style.lineHeight) || 0),
            nowrap: style.whiteSpace,
          };
        },
        { label: "日志表首行", timeout: 10_000 },
      );
      assertEqual(measured.nowrap, "nowrap", "时间戳要钉成一行");
      assert(
        measured.lineHeight === 0 || measured.stampHeight <= measured.lineHeight + 2,
        `时间戳折行了：高 ${measured.stampHeight} vs 行高 ${measured.lineHeight}`,
      );
      assert(measured.timeWidth <= 190, `时间列 ${measured.timeWidth}px，太宽`);
      assert(measured.channelWidth <= 210, `渠道列 ${measured.channelWidth}px，太宽`);
    });

    await check("客户端档位是固定清单而不是从当前页凑", async () => {
      const options = await page.evaluate(() => {
        const select = [...document.querySelectorAll(".log-toolbar select")].find((node) =>
          node.textContent.includes("全部客户端"),
        );
        return [...select.options].map((option) => option.value);
      });
      // 当前页肯定没有 channel-test 这类探测，但档位必须在。
      assert(options.includes("channel-test"), `档位不全：${options}`);
      assertEqual(options.length, 12, "客户端档位数（含全部）");
    });

    /* 筛选必须回服务端。前端过滤当前页的话，选 5xx 看到的是「这几十行里的
       5xx」，翻页每页各筛各的。这里直接盯请求里有没有那个参数。 */
    await check("筛选发回服务端而不是前端过滤", async () => {
      const seen = [];
      const collect = (event) => seen.push(event.request.url);
      cdp.on("Network.requestWillBeSent", collect);

      await page.evaluate(() => {
        const select = [...document.querySelectorAll(".log-toolbar select")].find((node) =>
          node.textContent.includes("全部状态"),
        );
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(select, "5xx");
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await sleepInPage(page, 600);

      const hit = seen.some((url) => url.includes("/api/admin/logs/") && url.includes("status=5xx"));
      assert(hit, `没发出带 status=5xx 的请求：${seen.filter((u) => u.includes("logs/")).slice(-3)}`);

      // 换回全部，别把后续检查留在空结果上。
      await page.evaluate(() => {
        const select = [...document.querySelectorAll(".log-toolbar select")].find((node) =>
          node.textContent.includes("全部状态"),
        );
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(select, "");
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await sleepInPage(page, 600);
    });

    await check("搜索框防抖后带上 search 参数", async () => {
      const seen = [];
      cdp.on("Network.requestWillBeSent", (event) => seen.push(event.request.url));
      await page.fill("#log-search", "gpt-4o");
      await sleepInPage(page, 900);
      const hits = seen.filter((url) => url.includes("/api/admin/logs/") && url.includes("search="));
      assert(hits.length > 0, "没发出带 search 的请求");
      // 防抖生效：六个字符不该打出六次查询。
      assert(hits.length <= 2, `防抖没生效，发了 ${hits.length} 次`);
      await page.fill("#log-search", "");
      await sleepInPage(page, 900);
    });

    await check("渠道筛选列出全量渠道", async () => {
      const names = await page.evaluate(() => {
        const select = document.querySelector(".log-filter-channel select");
        return [...select.options].map((option) => option.textContent);
      });
      assert(names.includes("archived-channel"), `渠道不全：${names}`);
    });


    await check("打开详情不拉报文，点页签才拉", async () => {
      const seen = [];
      const collect = (event) => seen.push(event.request.url);
      cdp.on("Network.requestWillBeSent", collect);
      try {
        await openProxiedLogDetail(page);
        await page.waitForSelector("dialog.log-detail-dialog[open]", { label: "详情窗" });
        await sleepInPage(page, 300);
        const selected = await page.evaluate(
          () =>
            document.querySelector("dialog.log-detail-dialog [role=tab][aria-selected=true]")
              ?.dataset.logTab,
        );
        assertEqual(selected, "meta", "默认页签");
        assertEqual(seen.filter((url) => url.includes("/snapshots/")).length, 0, "打开时就拉了报文");

        await page.click("dialog.log-detail-dialog [data-log-tab=downstream_request]");
        await page.waitForSelector(
          "dialog.log-detail-dialog [data-field=downstream_request] .log-detail-code-frame",
          { label: "下游请求" },
        );
        const fetched = seen.filter((url) => url.includes("/snapshots/"));
        assertEqual(fetched.length, 1, `报文请求数：${fetched}`);
        assert(fetched[0].endsWith("/snapshots/downstream_request"), `拉错了报文：${fetched[0]}`);
      } finally {
        cdp.off("Network.requestWillBeSent", collect);
      }
    });

    /* 元信息页签是「左 key 右 value」的一列行。类名挂没挂上证明不了排版，
       所以量几何：每行 key 都在 value 左边且不重叠，且所有行左右边缘各自对齐。 */
    await check("元信息是两列表：左表头右内容", async () => {
      await openProxiedLogDetail(page);
      await page.waitForSelector("dialog.log-detail-dialog[open]", { label: "详情窗" });
      // 上一条检查把页签留在了报文上，元信息面板不在 DOM 里，先显式切回来。
      await page.click("dialog.log-detail-dialog [data-log-tab=meta]");
      await page.waitForSelector(".log-detail-tabpanel--meta .log-detail-meta", { label: "元信息面板" });
      /* 卡片是 display:contents，自身没有盒子，所以量两个格子。 */
      const rows = await page.evaluate(() => {
        const panel = document.querySelector(".log-detail-tabpanel--meta .log-detail-meta");
        if (!panel) return null;
        return [...panel.querySelectorAll(".log-detail-meta-card")].map((row) => {
          const labelEl = row.querySelector(".log-detail-meta-label");
          const valueEl = row.querySelector("strong");
          const label = labelEl.getBoundingClientRect();
          const value = valueEl.getBoundingClientRect();
          return {
            text: row.textContent,
            labelLeft: Math.round(label.left),
            labelRight: Math.round(label.right),
            valueLeft: Math.round(value.left),
            valueTop: Math.round(value.top),
            valueBottom: Math.round(value.bottom),
            borderTop: getComputedStyle(valueEl).borderTopWidth,
            /* 竖线与表头底色都在 label 格子上。 */
            borderRight: getComputedStyle(labelEl).borderRightWidth,
            labelBg: getComputedStyle(labelEl).backgroundColor,
            valueBg: getComputedStyle(valueEl).backgroundColor,
          };
        });
      });
      // 先把状态还原成后续检查预期的样子，断言失败也不至于连锁。
      await page.click("dialog.log-detail-dialog [data-log-tab=downstream_request]");
      await page.waitForSelector(
        "dialog.log-detail-dialog [data-field=downstream_request] .log-detail-code-frame",
        { label: "下游请求" },
      );
      assert(rows !== null, "没有元信息面板");
      assert(rows.length >= 5, `元信息行数：${rows.length}`);
      for (const row of rows) {
        assert(row.labelRight <= row.valueLeft, `key 和 value 重叠：${row.text}`);
        // 两列连成一块：格子紧邻（中间只有竖线），表头列有底色。
        assert(row.valueLeft - row.labelRight <= 1, `两列之间有空隙：${row.text}`);
        assert(parseFloat(row.borderRight) > 0, `没有竖线：${row.text}`);
        assert(row.labelBg !== row.valueBg, `表头列没有自己的底色：${row.text}`);
      }
      // 表头一列、内容一列：两列各自左边缘对齐。
        assertEqual(new Set(rows.map((row) => row.labelLeft)).size, 1, "key 列左边缘没对齐");
        assertEqual(new Set(rows.map((row) => row.valueLeft)).size, 1, "value 列左边缘没对齐");
      for (let i = 1; i < rows.length; i += 1) {
        assert(rows[i].valueTop >= rows[i - 1].valueBottom, `第 ${i} 行压住了上一行`);
        assert(parseFloat(rows[i].borderTop) > 0, `第 ${i} 行没有分隔线`);
      }
    });

    /* 页签要像「贴在面板上的盖子」，不是一排文字加下划线。量几何：选中项有
       上/左边框、圆角只在上方、底色与面板一致，且底边盖住接缝。 */
    await check("选中的页签和面板连成一块", async () => {
      const seen = await page.evaluate(() => {
        const tab = document.querySelector(
          "dialog.log-detail-dialog [role=tab][aria-selected=true]",
        );
        const panel = document.querySelector(".log-detail-tabpanel");
        if (!tab || !panel) return null;
        const style = getComputedStyle(tab);
        const panelStyle = getComputedStyle(panel);
        const tabBox = tab.getBoundingClientRect();
        const panelBox = panel.getBoundingClientRect();
        return {
          topBorder: style.borderTopWidth,
          leftBorder: style.borderLeftWidth,
          bottomBorder: style.borderBottomWidth,
          topRadius: style.borderTopLeftRadius,
          bottomRadius: style.borderBottomLeftRadius,
          tabBg: style.backgroundColor,
          panelBg: panelStyle.backgroundColor,
          /* 页签底边与面板顶边的距离：贴住时应为 0。 */
          gap: Math.round(panelBox.top - tabBox.bottom),
          leftAligned: Math.round(panelBox.left - tabBox.left),
        };
      });
      assert(seen !== null, "找不到选中的页签或面板");
      assert(parseFloat(seen.topBorder) > 0, "选中页签没有上边框");
      assert(parseFloat(seen.leftBorder) > 0, "选中页签没有左边框");
      assertEqual(seen.bottomBorder, "0px", "选中页签不该有下边框");
      assert(parseFloat(seen.topRadius) > 0, "选中页签上方没有圆角");
      assertEqual(seen.bottomRadius, "0px", "选中页签下方不该有圆角");
      assertEqual(seen.tabBg, seen.panelBg, "选中页签底色和面板不一致");
      assert(seen.gap <= 0, `页签和面板之间有缝：${seen.gap}px`);
      assertEqual(seen.leftAligned, 0, "页签左边缘和面板没对齐");
    });

    await check("会话模式把请求体还原成对话", async () => {
      // 模式是落盘的，上一次跑可能留在原始，先摆回会话。
      await page.click("dialog.log-detail-dialog [data-log-view-mode=conversation]");
      const roles = await page.waitFor(
        () => {
          const list = document.querySelector(
            "dialog.log-detail-dialog [data-field=downstream_request] .conv-list",
          );
          if (!list) return false;
          return [...list.querySelectorAll(".conv-role-name")].map((node) => node.textContent);
        },
        { label: "会话消息", timeout: 10_000 },
      );
      assertEqual(roles.join(","), "系统,用户", "下游请求里的角色");
    });

    await check("响应侧抽出助手回复", async () => {
      await page.click("dialog.log-detail-dialog [data-log-tab=downstream_response]");
      const text = await page.waitFor(
        () =>
          document.querySelector(
            "dialog.log-detail-dialog [data-field=downstream_response] .conv-block--text .conv-block-body",
          )?.textContent ?? false,
        { label: "助手回复", timeout: 10_000 },
      );
      assertEqual(text, FAKE_REPLY, "助手回复");
    });

    await check("切到原始模式看报文", async () => {
      await page.click("dialog.log-detail-dialog [data-log-tab=downstream_request]");
      await page.click("dialog.log-detail-dialog [data-log-view-mode=raw]");
      const first = await page.waitFor(
        () => {
          const pre = document.querySelector(
            "dialog.log-detail-dialog [data-field=downstream_request] .log-detail-code-frame pre",
          );
          return pre?.textContent?.split("\n")[0] ?? false;
        },
        { label: "原始报文" },
      );
      assert(first.startsWith("POST /v1/chat/completions"), `报文首行：${first}`);
      const stored = await page.evaluate(() => localStorage.getItem("wildtoken.logViewMode"));
      assertEqual(stored, "raw", "查看模式落盘");
      // 会话节点在原始模式下不该还在。
      assertEqual(await page.count("dialog.log-detail-dialog .conv-list"), 0, "残留的会话列表");
    });

    await check("拉过的报文切回来不再请求，且一次只渲染一个面板", async () => {
      const seen = [];
      const collect = (event) => seen.push(event.request.url);
      cdp.on("Network.requestWillBeSent", collect);
      try {
        await page.click("dialog.log-detail-dialog [data-log-tab=downstream_response]");
        await page.waitForSelector(
          "dialog.log-detail-dialog [data-field=downstream_response] .log-detail-code-frame",
          { label: "下游响应" },
        );
        await sleepInPage(page, 200);
        assertEqual(seen.filter((url) => url.includes("/snapshots/")).length, 0, "重复请求");
        assertEqual(await page.count("dialog.log-detail-dialog [role=tabpanel]"), 1, "同时渲染的面板数");
      } finally {
        cdp.off("Network.requestWillBeSent", collect);
      }
    });

    await check("重开详情回到元信息页签", async () => {
      await page.click("dialog.log-detail-dialog .icon-close");
      await page.waitFor(() => document.querySelector("dialog.log-detail-dialog[open]") === null, {
        label: "详情窗关闭",
      });
      await openProxiedLogDetail(page);
      await page.waitForSelector("dialog.log-detail-dialog[open]", { label: "详情窗" });
      const selected = await page.evaluate(
        () =>
          document.querySelector("dialog.log-detail-dialog [role=tab][aria-selected=true]")
            ?.dataset.logTab,
      );
      assertEqual(selected, "meta", "重开后的页签");
      assertEqual(await page.count("dialog.log-detail-dialog [data-field]"), 0, "残留的报文面板");
      // 模式落盘了，摆回会话，别把后面的检查留在原始模式。
      await page.click("dialog.log-detail-dialog [data-log-tab=downstream_request]");
      await page.click("dialog.log-detail-dialog [data-log-view-mode=conversation]");
      await page.click("dialog.log-detail-dialog .icon-close");
    });

    /* SSE 推送是日志页的核心：不刷新页面，新请求要自己出现。之前只测过
       「日志页能渲染」，那证明不了流还活着。 */
    await check("SSE 把新请求推到表里，不靠刷新", async () => {
      const before = await page.count("table.log-table tbody tr");
      const navBefore = await page.evaluate(
        () => performance.getEntriesByType("navigation").length,
      );

      // 从页面里直接走一遍网关，产生一条真日志。
      await page.evaluate(async (token) => {
        await fetch("/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [{ role: "user", content: "sse 探活" }],
          }),
        });
      }, seeded.downstreamToken);

      const after = await page.waitFor(
        (count) => {
          const rows = document.querySelectorAll("table.log-table tbody tr").length;
          return rows > count ? rows : false;
        },
        { label: "SSE 推来的新行", timeout: 15_000 },
        before,
      );
      assert(after > before, `行数没增加：${before} → ${after}`);

      // 要是页面重载了，那新行不能算 SSE 的功劳。
      const navAfter = await page.evaluate(
        () => performance.getEntriesByType("navigation").length,
      );
      assertEqual(navAfter, navBefore, "期间发生了整页重载");
    });

    /* 在途行只存在于请求未完成的那几秒里。计时坏掉的话，行会出来但数字
       冻住，而“出来了”本身不能证明计时活着。 */
    await check("在途行出现且已用时在走", async () => {
      // 不等它返回，请求在背景飞着。
      await page.evaluate((token) => {
        void fetch("/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            model: "gpt-4o",
            messages: [{ role: "user", content: "__slow__ 在途探活" }],
          }),
        });
      }, seeded.downstreamToken);

      /* 「进行中」在状态格，不在时间格——时间格和已完成的行同形（时间 + 注解）。 */
      const first = await page.waitFor(
        () => {
          const row = document.querySelector("tr.log-row--active");
          if (!row) return false;
          const status = row.querySelector("[data-col=status] .status-active")?.textContent?.trim();
          const elapsed = row.querySelector("[data-col=duration]")?.textContent ?? "";
          return status === "进行中" ? elapsed : false;
        },
        { label: "在途行", timeout: 10_000 },
      );

      // 在途行也得是 10 格，否则它和已完成的行错一列。
      const cells = await page.evaluate(
        () => document.querySelector("tr.log-row--active")?.children.length ?? 0,
      );
      assertEqual(cells, 11, "在途行格数");

      /* 一开始就用秒。一秒内显毫秒的话，这一格会在 312ms 和 1.3s 之间突然
         换单位，逐秒刷新看上去像倒退了。 */
      const shown = first.replace("已用时", "").trim();
      assert(!shown.includes("ms"), `在途计时不该出现毫秒：${shown}`);
      assert(/^\d+\.\ds$|^\d+m\d{2}s$/.test(shown), `不是秒格式：${shown}`);

      await sleepInPage(page, 1200);
      const second = await page.evaluate(
        () => document.querySelector("tr.log-row--active")?.querySelector("[data-col=duration]")
          ?.textContent ?? null,
      );
      /* 请求可能已经结束（行没了），那也算数——说明它确实走完了一轮。
         只有「行还在且数字一模一样」才是计时死了。 */
      assert(second === null || second !== first, `已用时冻住在 ${first}`);
    });

    /* IP 列放在日志段最后：它要新打一条请求，而这条会顶到列表第一行。
       前面的会话视图等用例都拿第一行，放在它们之前会把它们带歪。 */
    await check("IP 列落库且排在详情左边", async () => {
      await gotoView(page, "日志");
      const layout = await page.evaluate(() => {
        const heads = [...document.querySelectorAll("table thead th")].map(
          (node) => node.getAttribute("data-col"),
        );
        return { ipIndex: heads.indexOf("ip"), detailIndex: heads.indexOf("detail") };
      });
      assert(layout.ipIndex !== -1, "表头没有 IP 列");
      assertEqual(layout.detailIndex, layout.ipIndex + 1, "IP 应紧靠详情左边");

      /* 从 Node 发而不是浏览器：这一条要指定 X-Forwarded-For，而浏览器对
         请求头有自己的一套限制，不是可靠的发送端。 */
      const marker = "198.51.100.7";
      const forwarded = await fetch(`${ORIGIN}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${seeded.downstreamToken}`,
          // 两跳：左边是客户端，右边是反代。取左边那个。
          "x-forwarded-for": `${marker}, 10.0.0.1`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: "IP 列验证" }],
        }),
      });

      /* 分两步等，而不是一个条件里同时要求接口和 DOM：合在一起的话，
         超时只会说“没找到”，分不清是后端没记还是前端没渲染。 */
      const api = await page.waitFor(
        async () => {
          const admin = localStorage.getItem("wildtoken_admin_token");
          const listed = await (
            await fetch("/api/admin/logs/?limit=20", { headers: { "x-admin-token": admin } })
          ).json();
          const items = listed.items ?? [];
          const hit = items.find((item) => item.client_ip === "198.51.100.7");
          return hit ? { id: hit.id, ip: hit.client_ip } : false;
        },
        {
          label: `接口里带 ${marker} 的日志（转发响应 ${forwarded.status}）`,
          timeout: 20_000,
        },
      ).catch(async (err) => {
        const dump = await page.evaluate(async () => {
          const admin = localStorage.getItem("wildtoken_admin_token");
          const listed = await (
            await fetch("/api/admin/logs/?limit=5", { headers: { "x-admin-token": admin } })
          ).json();
          return (listed.items ?? []).map((item) => ({
            id: item.id,
            ip: item.client_ip,
            status: item.status_code,
            model: item.model,
          }));
        });
        throw new Error(`${err.message}\n最近 5 条：${JSON.stringify(dump)}`);
      });

      assertEqual(api.ip, marker, "应取 XFF 最左跳，而不是反代地址");

      const shown = await page.waitFor(
        (logID) => {
          const cell = document.querySelector(`tr[data-log-id='${logID}'] [data-col='ip']`);
          return cell ? cell.textContent.trim() : false;
        },
        { label: `表里 id=${api.id} 那一行的 IP 格`, timeout: 15_000 },
        api.id,
      );
      assertEqual(shown, marker, "屏上的 IP 要和接口一致");
    });

    // ── 看板页 ──────────────────────────────────────────────
    console.log("\n看板页");

    await check("指标卡打散成一片", async () => {
      await gotoView(page, "看板");
      const flat = await page.waitFor(
        () => {
          const grid = document.querySelector(".dashboard-kpis--flat");
          if (!grid) return false;
          const cards = [...grid.querySelectorAll(".dashboard-kpi")];
          if (cards.length < 11) return false;
          return {
            count: cards.length,
            labels: cards.map((card) => card.querySelector(".dashboard-kpi-label")?.textContent),
            columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
            // 分区标题和外框都要没了。
            sections: document.querySelectorAll(".dashboard-layout .dashboard-metric-head").length,
            boards: document.querySelectorAll(".dashboard-ops.wt-board").length,
          };
        },
        { label: "打散的指标网格", timeout: 10_000 },
      );
      assertEqual(flat.count, 11, "四区共 11 张卡全进同一网格");
      assertEqual(flat.sections, 0, "分区标题要去掉");
      assertEqual(flat.boards, 0, "分区外框要去掉");
      assert(
        flat.columns >= 4 && flat.columns <= 6,
        `每行应 4–6 列，实际 ${flat.columns}`,
      );
      // 四个区的卡一张不能丢。
      for (const label of ["请求数", "错误率", "启用渠道", "Tokens", "缓存率", "活跃流", "清理任务"]) {
        assert(flat.labels.includes(label), `丢了卡片：${label}`);
      }
      assertEqual(await page.count(".wt-page-body.dashboard-layout"), 1, "页体容器");
    });

    await check("核心指标读到真数", async () => {
      /* 卡片带着「—」占位符立刻就在，等它“存在”等于没等。要等真数据落到。 */
      const kpis = await page.waitFor(
        () => {
          const cards = [...document.querySelectorAll(".dashboard-kpis .dashboard-kpi")];
          if (cards.length === 0) return false;
          const entries = Object.fromEntries(
            cards.map((card) => [
              card.querySelector(".dashboard-kpi-label")?.textContent,
              card.querySelector(".dashboard-kpi-value")?.textContent,
            ]),
          );
          return entries["启用渠道"] && entries["启用渠道"] !== "—" ? entries : false;
        },
        { label: "核心指标拿到数据", timeout: 15_000 },
      );
      // 种子里三个渠道，其中一个已归档——归档的不进分母。
      assertEqual(kpis["启用渠道"], "2/2", "启用渠道（归档不计）");
      assert(kpis["请求数"] !== undefined, "请求数卡缺失");
      assert(kpis["错误率"] !== undefined, "错误率卡缺失");
    });

    await check("状态分布按四档分段", async () => {
      // 同理：图表区先渲染空壳，等图例真的出来。
      const legend = await page.waitFor(
        () => {
          const labels = [...document.querySelectorAll(".status-legend .status-legend-label")].map(
            (node) => node.textContent,
          );
          return labels.length === 4 ? labels : false;
        },
        { label: "状态分布图例", timeout: 15_000 },
      );
      assertEqual(legend.join(","), "2xx,4xx,5xx,其他", "图例档位");
      const segs = await page.evaluate(() =>
        [...document.querySelectorAll(".ops-bar-track .ops-bar-seg")].map((node) => ({
          tone: node.className.replace("ops-bar-seg ", ""),
          width: node.style.width,
        })),
      );
      assert(segs.length > 0, "一段都没画出来");
      assert(
        segs.every((seg) => seg.width.endsWith("%")),
        `段宽不是百分比：${JSON.stringify(segs)}`,
      );
    });

    await check("四张排行卡且模型排行不被遮罩", async () => {
      assertEqual(await page.count(".dashboard-rank-grid .dashboard-card"), 4, "排行卡数");
      const titles = await page.evaluate(() =>
        [...document.querySelectorAll(".dashboard-rank-grid .dashboard-card-head h3")].map(
          (node) => node.textContent,
        ),
      );
      assertEqual(
        titles.join(","),
        "Top 渠道请求,Top 渠道 Tokens,Top 模型请求,Top 模型 Tokens",
        "排行卡标题",
      );

      /* 排行项的数值字段叫 count。按 request_count / total_tokens 取到 undefined，
         整面板会渲染成 NaN——要盯真数，不能只看行在不在。 */
      const rankValues = await page.waitFor(
        () => {
          const nodes = [...document.querySelectorAll(".dashboard-rank-count")];
          if (nodes.length === 0) return false;
          return nodes.map((node) => node.textContent);
        },
        { label: "排行数值", timeout: 15_000 },
      );
      for (const value of rankValues) {
        assert(!/nan/i.test(value), `排行值是 NaN：${value}`);
        assert(/[0-9]/.test(value), `排行值不是数：${value}`);
      }
      // 四个榜是四组独立数据：Tokens 榜的量级应远大于请求次数。
      const perCard = await page.evaluate(() =>
        [...document.querySelectorAll(".dashboard-rank-grid .dashboard-card")].map(
          (card) => card.querySelector(".dashboard-rank-count")?.textContent ?? "",
        ),
      );
      assert(
        perCard[1] !== perCard[0] || perCard[1] === "",
        `Tokens 榜和请求榜数值完全一致，可能喟错了数组：${perCard.join(" / ")}`,
      );

      // 屏蔽按钮只留图标，说明走 aria-label。
      const eye = await page.evaluate(() => {
        const btn = document.querySelector(".dashboard-ranking-controls .log-sensitive-toggle");
        return {
          text: btn.textContent.trim(),
          label: btn.getAttribute("aria-label"),
          svg: btn.querySelectorAll("svg").length,
        };
      });
      assertEqual(eye.text, "", "按钮不该有文案");
      assertEqual(eye.svg, 1, "要有眼睛图标");
      assert(eye.label && eye.label.includes("渠道名"), `aria-label 缺失：${eye.label}`);

      await page.click(".dashboard-ranking-controls .log-sensitive-toggle");
      const masked = await page.evaluate(() => {
        const cards = [...document.querySelectorAll(".dashboard-rank-grid .dashboard-card")];
        const nameIn = (card) =>
          card?.querySelector(".dashboard-rank-name")?.textContent ?? null;
        return { channel: nameIn(cards[0]), model: nameIn(cards[2]) };
      });
      // 遮罩只管渠道名，模型名不是敏感信息。遮罩值和日志页同一个常量。
      assert(
        masked.channel === null || masked.channel === "******",
        `渠道名没遮：${masked.channel}`,
      );
      assert(
        masked.model === null || masked.model !== "******",
        `模型名不该遮：${masked.model}`,
      );
      await page.click(".dashboard-ranking-controls .log-sensitive-toggle");
    });

    /* 自定义时间段。量 opacity 而不是看类名：基线规则就是 opacity 0，类挂上了
       但规则没生效的话，类名断言照样会过。 */
    await check("自定义时间段真的展开并生效", async () => {
      await page.click("[data-dashboard-range='custom']");
      const opened = await page.waitFor(
        () => {
          const panel = document.querySelector(".dashboard-custom-range");
          if (!panel || panel.hidden) return false;
          const style = getComputedStyle(panel);
          return Number(style.opacity) > 0.9 ? { opacity: Number(style.opacity) } : false;
        },
        { label: "自定义面板展开", timeout: 5000 },
      );
      assert(opened.opacity > 0.9, `面板仍然透明：${opened.opacity}`);
      // 内部元素另有一道同样的门，输入框真看得见才算展开。
      const inner = await page.evaluate(() => {
        const node = document.querySelector(".dashboard-custom-range-inner > *");
        return node ? Number(getComputedStyle(node).opacity) : null;
      });
      assert(inner !== null && inner > 0.9, `面板内元素透明：${inner}`);

      // 换回普通档：下一条用例要验“未填日期时按钮禁用”，不能给它留下日期。
      await page.click("[data-dashboard-range='today']");
    });

    await check("切档重新取数且落盘", async () => {
      await page.click("[data-dashboard-range='7d']");
      const state = await page.waitFor(
        () => {
          // 打散后 dashboard-hero 没了，时间范围标签看状态分布卡那一个。
          const meta = document.querySelector(".dashboard-insight .wt-meta")?.textContent ?? "";
          return meta.includes("7") ? { meta, stored: localStorage.getItem("wildtoken_dashboard_range") } : false;
        },
        { label: "范围标签", timeout: 10_000 },
      );
      assertEqual(state.stored, "7d", "范围落盘");
      const pressed = await page.evaluate(
        () =>
          document.querySelector("[data-dashboard-range='7d']")?.getAttribute("aria-pressed") ?? null,
      );
      assertEqual(pressed, "true", "按下态");
    });

    /* 自定义区间要额外带 start_date / end_date。没带的话后端直接 400，
       而界面上只会看到一片破折号。 */
    await check("自定义区间带上日期才发请求", async () => {
      await page.click("[data-dashboard-range='custom']");
      const visible = await page.evaluate(
        () => document.querySelector(".dashboard-custom-range")?.hasAttribute("hidden") === false,
      );
      assertEqual(visible, true, "自定义区展开");
      // 日期没填齐时应用按钮是禁用的。
      const disabledBefore = await page.evaluate(
        () => document.querySelector(".dashboard-apply-custom")?.disabled ?? null,
      );
      assertEqual(disabledBefore, true, "未填日期时的应用按钮");

      /* datetime-local 收的是带时刻的值，纯日期它不认（设进去就是空）。
         这里故意给同一天的两个时刻，把「时分秒能选」一并验了——旧逻辑下
         同一天根本表达不出来。 */
      await page.fill(
        ".dashboard-custom-range input[aria-label='开始时间']",
        "2020-01-01T09:30:15",
      );
      await page.fill(
        ".dashboard-custom-range input[aria-label='结束时间']",
        "2020-01-01T17:45:30",
      );

      /* 订阅要赶在第一次点击之前。应用过一次后状态就不再变，再点一下
         React 不会重新取数，什么请求也抓不到。 */
      const requests = [];
      const collectCustom = (event) => requests.push(event.request.url);
      cdp.on("Network.requestWillBeSent", collectCustom);
      await page.click(".dashboard-apply-custom");
      const stored = await page.waitFor(
        () => {
          const value = localStorage.getItem("wildtoken_dashboard_custom_range");
          return value ? value : false;
        },
        { label: "自定义区间落盘" },
      );
      assertEqual(stored, "2020-01-01T09:30:15~2020-01-01T17:45:30", "区间落盘");
      await sleepInPage(page, 1200);
      cdp.off("Network.requestWillBeSent", collectCustom);

      // 落盘了但请求没拼参数的话，只看 localStorage 照样能过。

      const custom = requests.filter((url) => url.includes("range=custom"));
      assert(custom.length > 0, "没有一个请求带 range=custom");
      assert(
        custom.some((url) => url.includes(`start_date=${encodeURIComponent("2020-01-01T09:30:15")}`)),
        `请求里没带起始时刻：${custom[0]}`,
      );
      assert(
        custom.some((url) => url.includes(`end_date=${encodeURIComponent("2020-01-01T17:45:30")}`)),
        `请求里没带结束时刻：${custom[0]}`,
      );

      // 换回一个普通档，别把后续检查留在空区间上。
      await page.click("[data-dashboard-range='30d']");
    });

    // ── 设置页 ──────────────────────────────────────────────
    console.log("\n设置页");

    await check("八张设置卡齐全", async () => {
      await gotoView(page, "设置");
      /* 等满 8 张再比。三张服务端卡要等设置读回来才渲染，只等「大于 0」的话
         会在只有 5 张时就截下来。 */
      const titles = await page.waitFor(
        () => {
          const heads = [...document.querySelectorAll(".settings-stack .settings-card-head h3")];
          return heads.length >= 8 ? heads.map((node) => node.textContent) : false;
        },
        { label: "设置卡", timeout: 10_000 },
      );
      assertEqual(
        titles.join(","),
        "控制台偏好,日志与存储,路由、有效权重与重试,出站代理,模型测试 Prompt,网关默认值,安全,运行信息",
        "设置卡标题",
      );
    });

    await check("运行信息读到真数据", async () => {
      const items = await page.waitFor(
        () => {
          const nodes = [...document.querySelectorAll(".system-info-grid .system-info-item")];
          if (nodes.length === 0) return false;
          return Object.fromEntries(
            nodes.map((node) => [
              node.querySelector("span")?.textContent,
              node.querySelector("strong")?.textContent,
            ]),
          );
        },
        { label: "运行信息", timeout: 10_000 },
      );
      assertEqual(items["服务"], "WildToken", "服务名");
      assertEqual(items["数据库"], "连接正常", "数据库状态");
      // 前面真的走了一遍网关，日志总数不应为 0。
      assert(items["日志总数"] !== "0", `日志总数为 ${items["日志总数"]}`);
      assertEqual(items["启用渠道"], "2 / 3", "启用渠道 / 总数");
    });

    await check("路由规则四步写在字段旁边", async () => {
      assertEqual(await page.count(".routing-rule-guide .routing-rule-steps li"), 4, "路由规则条数");
      assertEqual(await page.count(".routing-settings-grid .field"), 6, "路由字段数");
    });

    await check("保存日志策略后修订号前进", async () => {
      const before = await page.evaluate(
        () => document.querySelector(".settings-revision")?.textContent ?? "",
      );
      await page.evaluate(() => {
        const input = document.querySelector(".settings-fields-grid input[type=number]");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, "120");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.evaluate(() => {
        const button = [...document.querySelectorAll(".settings-save-row button")].find((node) =>
          node.textContent.includes("保存日志策略"),
        );
        button.click();
      });
      const after = await page.waitFor(
        (previous) => {
          const text = document.querySelector(".settings-revision")?.textContent ?? "";
          return text && text !== previous ? text : false;
        },
        { label: "修订号更新", timeout: 10_000 },
        before,
      );
      assert(
        Number(after.replace(/\D/g, "")) > Number(before.replace(/\D/g, "")),
        `修订号没前进：${before} → ${after}`,
      );
    });

    await check("密度分段控件改 html 属性", async () => {
      const before = await page.evaluate(() => document.documentElement.getAttribute("data-density"));
      const target = before === "compact" ? "comfortable" : "compact";
      await page.click(`.segmented-control [data-density-choice=${target}]`);
      const state = await page.evaluate(() => ({
        attr: document.documentElement.getAttribute("data-density"),
        stored: localStorage.getItem("wildtoken_density"),
      }));
      assertEqual(state.attr, target, "html data-density");
      assertEqual(state.stored, target, "密度落盘");
    });

    await check("Prompt 模板列出来了", async () => {
      assert(
        (await page.count(".model-test-template-list .model-test-template-item")) > 0,
        "一条 Prompt 模板都没列出",
      );
    });

    // ── 令牌与分组页的格 ──────────────────────────────────────
    console.log("\n令牌与分组");

    await check("描述格在 desc-cell 里且文本包在 muted 中", async () => {
      await gotoView(page, "令牌");
      await page.waitFor(
        () => document.querySelector("table tbody tr td.desc-cell") !== null,
        { label: "描述格", timeout: 10_000 },
      );
      const hasMuted = await page.evaluate(
        () => document.querySelector("table tbody tr td.desc-cell .muted") !== null,
      );
      assertEqual(hasMuted, true, "描述文本应包在 muted 里");
    });

    /* 预览是前 4 后 4，≤ 8 全显。比对真的明文而不是看格式像不像——否则
       截错位置也能“看着对”。 */
    await check("令牌预览前4后4", async () => {
      await gotoView(page, "令牌");
      const rows = await page.waitFor(
        async () => {
          const codes = [...document.querySelectorAll("table tbody tr .token-preview-code")];
          if (codes.length === 0) return false;
          const admin = localStorage.getItem("wildtoken_admin_token");
          const list = await (
            await fetch("/api/admin/tokens/", { headers: { "x-admin-token": admin } })
          ).json();
          const items = Array.isArray(list) ? list : (list.items ?? []);
          if (items.length === 0) return false;
          return items.slice(0, codes.length).map((item, index) => ({
            plain: item.token ?? "",
            shown: codes[index].textContent,
          }));
        },
        { label: "令牌预览", timeout: 10_000 },
      );

      let checkedLong = 0;
      for (const row of rows) {
        if (!row.plain) continue;
        const chars = [...row.plain];
        if (chars.length <= 8) {
          assertEqual(row.shown, row.plain, "不超八位应全显");
          continue;
        }
        const want = `${chars.slice(0, 4).join("")}****${chars.slice(-4).join("")}`;
        assertEqual(row.shown, want, `预览应为前4后4：${row.plain}`);
        checkedLong += 1;
      }
      assert(checkedLong > 0, "没有一条长令牌可比对，断言等于没跑");
    });

    /* 后端严格解码，多一个字段整个请求就 400。走界面真建一条，并核对限额
       真的落库——只看“对话框关了”的话，限额没存上也看不出来。 */
    await check("新增令牌能建成且限额落库", async () => {
      await gotoView(page, "令牌");
      await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find(
          (node) => node.textContent.trim() === "新增令牌",
        );
        button.click();
      });
      await page.waitForSelector("dialog.upstream-dialog[open]", { label: "令牌对话框" });

      /* 满高抽屉里页脚要钉底。用 modal-actions 而不是 modal-footer 的话，按钮跟着
         正文走，字段一多就滚到可视区外面了。 */
      const layout = await page.evaluate(() => {
        const dialog = document.querySelector("dialog.upstream-dialog[open]");
        const body = dialog.querySelector(".upstream-dialog-body");
        const footer = dialog.querySelector(".modal-footer");
        if (!body || !footer) return null;
        const box = dialog.getBoundingClientRect();
        const foot = footer.getBoundingClientRect();
        return {
          sections: dialog.querySelectorAll(".form-section").length,
          bodyScrolls: getComputedStyle(body).overflow === "auto",
          footerAtBottom: Math.abs(box.bottom - foot.bottom) <= 2,
          footerVisible: foot.bottom <= window.innerHeight + 1,
        };
      });
      assert(layout !== null, "缺正文层或页脚层");
      assertEqual(layout.sections, 3, "分三节：基础信息 / 配额限速 / 有效期状态");
      assertEqual(layout.bodyScrolls, true, "正文要能独立滚动");
      assertEqual(layout.footerAtBottom, true, "页脚要钉在抽屉底部");
      assertEqual(layout.footerVisible, true, "页脚不能被推出可视区");

      await page.fill("dialog.upstream-dialog[open] input[autocomplete=off]", "quota-token");
      await page.fill("dialog.upstream-dialog[open] input[placeholder^='留空则不限额']", "100M");
      await page.evaluate(() => {
        document.querySelector("dialog.upstream-dialog[open] button[type=submit]").click();
      });
      await page.waitFor(() => document.querySelector("dialog.upstream-dialog[open]") === null, {
        label: "令牌对话框关闭",
        timeout: 10_000,
      });

      const stored = await page.evaluate(async () => {
        const admin = localStorage.getItem("wildtoken_admin_token");
        const list = await (
          await fetch("/api/admin/tokens/", { headers: { "x-admin-token": admin } })
        ).json();
        return list.find((item) => item.name === "quota-token")?.quota ?? null;
      });
      assert(stored !== null, "令牌没建成");
      assertEqual(stored.limit_expression, "100M", "限额表达式落库");
      assertEqual(stored.limit_tokens, 100_000_000, "后端解析出的限额数值");
    });

    /* 创建和更新收两个不同的结构体：更新不收 enabled（启用状态走开关接口）。
       把新建的载荷原样发去会被严格解码拒掉整个请求。走界面真改一次，
       并核对改动真的落库——只看“对话框关了”的话，400 也看不出来。 */
    await check("编辑令牌能保存且改动落库", async () => {
      await gotoView(page, "令牌");
      /* 令牌表是 token-table，行里也没有 data-col，openRowMenu 那套选择器
         （upstream-table + data-col=name）在这里定位不到。 */
      const menuOpened = await page.waitFor(
        () => {
          const row = [...document.querySelectorAll("table.token-table tbody tr")].find((node) =>
            node.textContent.includes("quota-token"),
          );
          const trigger = row?.querySelector("button.action-menu-trigger");
          if (!trigger) return false;
          trigger.click();
          return true;
        },
        { label: "quota-token 的行菜单", timeout: 10_000 },
      );
      assertEqual(menuOpened, true, "没找到 quota-token 的行");
      await sleepInPage(page, 80);
      await clickMenuItem(page, "编辑");
      await page.waitForSelector("dialog.upstream-dialog[open]", { label: "编辑对话框" });

      // 按字段标签找，不按位置：加一个字段就会把下标错开。
      await page.evaluate(() => {
        const field = [...document.querySelectorAll("dialog.upstream-dialog[open] .field")].find(
          (node) => node.querySelector(".field-label")?.textContent === "描述",
        );
        const input = field.querySelector("input");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, "编辑后的描述");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.evaluate(() => {
        document.querySelector("dialog.upstream-dialog[open] button[type=submit]").click();
      });

      const closed = await page
        .waitFor(() => document.querySelector("dialog.upstream-dialog[open]") === null, {
          label: "编辑对话框关闭",
          timeout: 10_000,
        })
        .catch(() => false);
      if (!closed) {
        const toast = await page.evaluate(
          () => [...document.querySelectorAll(".toast")].map((n) => n.textContent).join(" | "),
        );
        throw new Error(`保存没成功，提示：${toast}`);
      }

      const saved = await page.evaluate(async () => {
        const admin = localStorage.getItem("wildtoken_admin_token");
        const list = await (
          await fetch("/api/admin/tokens/", { headers: { "x-admin-token": admin } })
        ).json();
        return list.find((item) => item.name === "quota-token") ?? null;
      });
      assert(saved !== null, "令牌不见了");
      assertEqual(saved.description, "编辑后的描述", "描述没落库");
      // 限额不在这次编辑里，不该被顺手清掉。
      assertEqual(saved.quota.limit_expression, "100M", "编辑把限额弄丢了");
    });

    /* 一串日期看不出快到期了。旧版旁边跟一个徐章说距今多久，那才是重点。 */
    await check("有效期带距今徐章且不是 UTC 原文", async () => {
      const created = await page.evaluate(async () => {
        const admin = localStorage.getItem("wildtoken_admin_token");
        const soon = new Date(Date.now() + 3 * 24 * 3600 * 1000)
          .toISOString()
          .slice(0, 19)
          .replace("T", " ");
        const response = await fetch("/api/admin/tokens", {
          method: "POST",
          headers: { "content-type": "application/json", "x-admin-token": admin },
          body: JSON.stringify({
            name: "expiring-token",
            description: "快到期",
            enabled: true,
            expires_at: soon,
          }),
        });
        return response.ok;
      });
      assert(created, "建不出带过期时间的令牌");

      // 离开再回来，逼它重新取数。
      await gotoView(page, "分组");
      await gotoView(page, "令牌");
      const expiry = await page.waitFor(
        () => {
          const rows = [...document.querySelectorAll("table tbody tr")];
          const row = rows.find((node) => node.textContent.includes("expiring-token"));
          const cell = row?.querySelector(".col-expiry .token-expiry");
          if (!cell) return false;
          return {
            time: cell.querySelector(".token-expiry-time")?.textContent ?? "",
            badge: cell.querySelector(".badge")?.textContent ?? "",
            tone: cell.querySelector(".badge")?.className ?? "",
          };
        },
        { label: "有效期格", timeout: 10_000 },
      );
      assert(expiry.badge.endsWith("后"), `徐章应是「N 天后」，实际 ${expiry.badge}`);
      // 3 天内算快到期，走 neutral 而不是 on。
      assert(expiry.tone.includes("neutral"), `徐章色调不对：${expiry.tone}`);
      // slice(0,16) 的话会留着 "2026-09-21T12:34" 里的 T。
      assert(!expiry.time.includes("T"), `时间没格式化，还是原文：${expiry.time}`);
    });

    /* 只给预设下拉的话设不了 1d3h 或某个具体时刻。 */
    await check("有效期收时长表达式并实时预览", async () => {
      await gotoView(page, "令牌");
      await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find(
          (node) => node.textContent.trim() === "新增令牌",
        );
        button.click();
      });
      await page.waitForSelector("dialog.upstream-dialog[open]", { label: "令牌对话框" });

      const field = "dialog.upstream-dialog[open] .expiry-presets";
      assertEqual(await page.count(`${field} button`), 4, "快捷档数量");

      await page.fill("dialog.upstream-dialog[open] input[placeholder^='留空则永不过期']", "1d3h");
      const preview = await page.evaluate(() => {
        const hints = [...document.querySelectorAll("dialog.upstream-dialog[open] .field-hint")];
        return hints.map((node) => node.textContent).find((text) => text.startsWith("到期时间")) ?? null;
      });
      assert(preview !== null, "没有到期时间预览");
      assert(!preview.includes("永不过期"), `1d3h 不该算成永不过期：${preview}`);
    });

    await check("看不懂的有效期不提交", async () => {
      await page.fill("dialog.upstream-dialog[open] input[placeholder^='留空则永不过期']", "明天");
      const state = await page.evaluate(() => {
        const hint = [...document.querySelectorAll("dialog.upstream-dialog[open] .field-hint")].find(
          (node) => node.className.includes("field-hint-error"),
        );
        return hint?.textContent ?? null;
      });
      assert(state?.includes("看不懂"), `没报错：${state}`);

      // 填上名字后点保存，对话框应该留着而不是静默存成永不过期。
      await page.fill("dialog.upstream-dialog[open] input[autocomplete=off]", "bad-expiry");
      await page.evaluate(() => {
        document.querySelector("dialog.upstream-dialog[open] button[type=submit]")?.click();
      });
      await sleepInPage(page, 300);
      const stillOpen = await page.evaluate(
        () => document.querySelector("dialog.upstream-dialog[open]") !== null,
      );
      assertEqual(stillOpen, true, "解析失败时对话框应留着");
      await page.click("dialog.upstream-dialog[open] .icon-close");
      await page.waitFor(() => document.querySelector("dialog.upstream-dialog[open]") === null, {
        label: "令牌对话框关闭",
      });
    });

    await check("分组页描述格同形", async () => {
      await gotoView(page, "分组");
      const shape = await page.waitFor(
        () => {
          const node = document.querySelector("table tbody tr td.desc-cell");
          return node ? node.innerHTML : false;
        },
        { label: "分组描述格", timeout: 10_000 },
      );
      assert(shape.includes("muted"), `描述格缺 muted：${shape}`);
    });

    // ── 顶栏 ────────────────────────────────────────────────────────────────
    console.log("\n顶栏");

    await check("导航项齐全", async () => {
      const labels = await page.evaluate(() =>
        [...document.querySelectorAll(".topbar-nav .nav-link")].map((b) => b.textContent.trim()),
      );
      assert(labels.length === 6, `导航项应 6 个，实际 ${labels.length}`);
      assertEqual(labels.join(","), "看板,渠道,日志,令牌,分组,设置", "导航顺序");
    });

    await check("主题菜单能开且能选", async () => {
      await page.click(".theme-toggle");
      const open = await page.evaluate(() => !document.querySelector(".theme-menu").hidden);
      assertEqual(open, true, "菜单展开");
      await page.click("[data-theme-choice=light]");
      const applied = await page.evaluate(() => ({
        attr: document.documentElement.getAttribute("data-theme"),
        stored: localStorage.getItem("wildtoken_theme"),
        closed: document.querySelector(".theme-menu").hidden,
      }));
      assertEqual(applied.attr, "light", "html data-theme");
      assertEqual(applied.stored, "light", "主题落盘");
      assertEqual(applied.closed, true, "选完收起");
    });

    await check("Esc 收起主题菜单", async () => {
      await page.click(".theme-toggle");
      await page.press("Escape");
      const hidden = await page.evaluate(() => document.querySelector(".theme-menu").hidden);
      assertEqual(hidden, true, "Esc 后收起");
    });

    await check("密度切换改 html 属性并落盘", async () => {
      const before = await page.evaluate(() => document.documentElement.getAttribute("data-density"));
      await page.click(".density-toggle");
      const after = await page.evaluate(() => ({
        attr: document.documentElement.getAttribute("data-density"),
        stored: localStorage.getItem("wildtoken_density"),
      }));
      assert(after.attr !== before, `密度没变，仍是 ${after.attr}`);
      assertEqual(after.stored, after.attr, "密度落盘与属性一致");
    });

    // ── 各视图 ──────────────────────────────────────────────────────────────
    console.log("\n视图切换");

    const views = [
      { id: "dashboard", label: "看板" },
      { id: "logs", label: "日志" },
      { id: "tokens", label: "令牌" },
      { id: "groups", label: "分组" },
      { id: "settings", label: "设置" },
      { id: "upstreams", label: "渠道" },
    ];

    for (const view of views) {
      await check(`${view.label}页能渲染`, async () => {
        await page.evaluate((label) => {
          const button = [...document.querySelectorAll(".topbar-nav .nav-link")].find(
            (b) => b.textContent.trim() === label,
          );
          if (!button) throw new Error(`找不到导航项 ${label}`);
          button.click();
        }, view.label);
        await page.waitForSelector(`section.view[data-view=${view.id}] .panel`, {
          label: `${view.label}页面板`,
        });
        const active = await page.evaluate(
          (label) =>
            [...document.querySelectorAll(".topbar-nav .nav-link")]
              .find((b) => b.textContent.trim() === label)
              ?.classList.contains("active") ?? false,
          view.label,
        );
        assertEqual(active, true, `${view.label} 导航项高亮`);
      });
    }

    await check("视图切换是客户端路由，没有整页重载", async () => {
      const navigations = await page.evaluate(() => performance.getEntriesByType("navigation").length);
      assertEqual(navigations, 1, "导航条目数");
    });

    await check("切视图写进地址栏", async () => {
      await gotoView(page, "令牌");
      const hash = await page.evaluate(() => location.hash);
      assertEqual(hash, "#tokens", "地址栏 hash");
    });

    /* 视图只存在组件 state 里的话，刷新必然回到初始值。这条直接重载页面。 */
    await check("刷新后停在同一页", async () => {
      await page.reload("#tokens");
      await page.waitForSelector("section.view[data-view=tokens] .panel", {
        label: "令牌页",
        timeout: 10_000,
      });
      const active = await page.evaluate(
        () => document.querySelector(".topbar-nav .nav-link.active")?.textContent?.trim() ?? null,
      );
      assertEqual(active, "令牌", "刷新后的当前视图");
    });

    await check("浏览器后退回上一页", async () => {
      await gotoView(page, "分组");
      await page.evaluate(() => history.back());
      await page.waitFor(
        () =>
          document.querySelector(".topbar-nav .nav-link.active")?.textContent?.trim() === "令牌",
        { label: "后退到令牌页" },
      );
    });

    /* 地址栏没锚点时走默认首页偏好，而不是写死的某一页。 */
    await check("无锚点时走默认首页偏好", async () => {
      await page.evaluate(() => {
        localStorage.setItem("wildtoken_default_home", "groups");
        // 清掉锚点，否则走不到偏好那条分支。
        history.replaceState(null, "", location.pathname);
      });
      await page.reload();
      await page.waitForSelector("section.view[data-view=groups] .panel", {
        label: "分组页",
        timeout: 10_000,
      });
      // 落地后地址栏要被补上，否则再刷新一次又是无锚点。
      const hash = await page.evaluate(() => location.hash);
      assertEqual(hash, "#groups", "落地后的 hash");

      await page.evaluate(() => {
        localStorage.removeItem("wildtoken_default_home");
        history.replaceState(null, "", location.pathname);
      });
      await page.reload();
      await page.waitForSelector("section.view[data-view=dashboard] .panel", {
        label: "看板页（兜底）",
        timeout: 10_000,
      });
    });

    // ── 命令面板 ────────────────────────────────────────────
    console.log("\n命令面板");

    await check("命令面板仍是居中形制", async () => {
      await pressKey(page, "k", { ctrl: true });
      await page.waitForSelector("dialog.command-palette-dialog[open]", { label: "命令面板" });
      const box = await page.evaluate(() => {
        const dialog = document.querySelector("dialog.command-palette-dialog[open]");
        const rect = dialog.getBoundingClientRect();
        return {
          drawer: dialog.classList.contains("dialog--drawer"),
          centered: Math.abs(rect.left - (window.innerWidth - rect.right)) <= 2,
        };
      });
      assertEqual(box.drawer, false, "命令面板不该挂抽屉类");
      assertEqual(box.centered, true, "命令面板应水平居中");
      await pressKey(page, "Escape");
      await page.waitFor(
        () => document.querySelector("dialog.command-palette-dialog[open]") === null,
        { label: "面板关闭" },
      );
    });

    await check("Ctrl+K 唤起且再按收起", async () => {
      await pressKey(page, "k", { ctrl: true });
      await page.waitForSelector("dialog.command-palette-dialog[open]", { label: "命令面板" });
      await pressKey(page, "k", { ctrl: true });
      await page.waitFor(() => document.querySelector("dialog.command-palette-dialog[open]") === null, {
        label: "面板收起",
      });
    });

    await check("筛选后只剩匹配项", async () => {
      await pressKey(page, "k", { ctrl: true });
      await page.waitForSelector("dialog.command-palette-dialog[open]", { label: "命令面板" });
      const all = await page.count(".command-palette-item");
      assert(all >= 10, `命令数太少：${all}`);
      await page.fill("dialog.command-palette-dialog input", "日志");
      const titles = await page.evaluate(() =>
        [...document.querySelectorAll(".command-palette-item-title")].map((n) => n.textContent),
      );
      assertEqual(titles.join(","), "切换到日志", "筛选结果");
    });

    await check("回车执行高亮项", async () => {
      await pressKey(page, "Enter", { target: "dialog.command-palette-dialog input" });
      await page.waitFor(() => document.querySelector("dialog.command-palette-dialog[open]") === null, {
        label: "面板关闭",
      });
      await page.waitForSelector("section.view[data-view=logs] .panel", { label: "日志页" });
      const active = await page.evaluate(
        () => document.querySelector(".topbar-nav .nav-link.active")?.textContent?.trim() ?? null,
      );
      assertEqual(active, "日志", "执行后的当前视图");
    });

    await check("方向键移动高亮", async () => {
      await pressKey(page, "k", { ctrl: true });
      await page.waitForSelector("dialog.command-palette-dialog[open]", { label: "命令面板" });
      const first = await page.evaluate(
        () => document.querySelector(".command-palette-item.is-active")?.dataset.commandId ?? null,
      );
      await pressKey(page, "ArrowDown", { target: "dialog.command-palette-dialog input" });
      const second = await page.evaluate(
        () => document.querySelector(".command-palette-item.is-active")?.dataset.commandId ?? null,
      );
      assert(first !== null && second !== null && first !== second, `高亮没动：${first} → ${second}`);
    });

    await check("切换密度命令真的改了属性", async () => {
      const before = await page.evaluate(() => document.documentElement.getAttribute("data-density"));
      await page.evaluate(() => {
        document.querySelector("[data-command-id=density]").click();
      });
      const after = await page.evaluate(() => ({
        attr: document.documentElement.getAttribute("data-density"),
        open: document.querySelector("dialog.command-palette-dialog[open]") !== null,
      }));
      assert(after.attr !== before, `密度没变，仍是 ${after.attr}`);
      assertEqual(after.open, false, "执行后面板应关闭");
    });

    /* 面板开在其他对话框之上时，Esc 只能关最上面那一层。不拦的话一下子
       关两层，正在看的日志详情一起没了。 */
    await check("Esc 关面板不连带关底下的对话框", async () => {
      await gotoView(page, "日志");
      await openProxiedLogDetail(page);
      await page.waitForSelector("dialog.log-detail-dialog[open]", { label: "详情窗" });
      await pressKey(page, "k", { ctrl: true });
      await page.waitForSelector("dialog.command-palette-dialog[open]", { label: "命令面板" });
      await pressKey(page, "Escape");
      await page.waitFor(() => document.querySelector("dialog.command-palette-dialog[open]") === null, {
        label: "面板关闭",
      });
      const detailStillOpen = await page.evaluate(
        () => document.querySelector("dialog.log-detail-dialog[open]") !== null,
      );
      assertEqual(detailStillOpen, true, "详情窗被连带关掉了");
      await page.click("dialog.log-detail-dialog .icon-close");
    });

    console.log("\n抽屉布局");
    await checkDialogLayouts({ page, check, gotoView, openRowMenu, clickMenuItem });

    // ── 退出 ────────────────────────────────────────────────────────────────
    console.log("\n退出");

    await check("退出清掉令牌并弹回登录框", async () => {
      await page.click(".nav-logout");
      await page.waitForSelector("dialog.admin-token-dialog[open]", { label: "登录框重现" });
      const stored = await page.evaluate(() => localStorage.getItem("wildtoken_admin_token"));
      assertEqual(stored, "", "退出后令牌应清空");
    });

    // ── 噪音 ────────────────────────────────────────────────────────────────
    console.log("\n噪音");

    await check("零 console 错误", () => {
      assert(noise.console.length === 0, noise.console.join("\n"));
    });
    await check("零未捕获异常", () => {
      assert(noise.exceptions.length === 0, noise.exceptions.join("\n"));
    });
    await check("零失败请求", () => {
      assert(noise.requests.length === 0, noise.requests.join("\n"));
    });

    void seeded;
  } finally {
    await cleanupAndWait();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
