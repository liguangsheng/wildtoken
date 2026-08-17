import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

/** 取出单个顶层函数体，好在不加载整个模块的情况下单独跑它。 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} 不在源码里`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 的函数体没有闭合`);
}

test("分组页在导航和视图里成对出现", () => {
  const markup = read("static/admin.html");
  assert.match(markup, /data-view="groups">分组<\/button>/);
  assert.match(markup, /<section class="view" data-view="groups" hidden>/);
  // 视图切换靠 data-view 配对，少一边就会点了没反应。
  assert.equal([...markup.matchAll(/data-view="groups"/g)].length, 2);
});

test("分组页的表头与渲染出的单元格列数一致", () => {
  const markup = read("static/admin.html");
  const table = markup.slice(
    markup.indexOf('<table class="admin-table" id="group-table">'),
    markup.indexOf('<tbody id="group-rows">'),
  );
  const headerCount = [...table.matchAll(/<th[\s>]/g)].length;

  const source = read("static/js/groups.js");
  // 名称、描述、渠道数、令牌数、操作
  assert.equal(headerCount, 5);
  assert.match(source, /colspan="5"/);
});

test("新增分组弹框使用完整的头部、底部和紧凑宽度结构", () => {
  const markup = read("static/admin.html");
  const groupId = markup.indexOf('id="group-dialog"');
  const dialogStart = markup.lastIndexOf("<dialog", groupId);
  const dialogEnd = markup.indexOf("</dialog>", dialogStart);
  assert.ok(groupId >= 0 && dialogStart >= 0 && dialogEnd > dialogStart, "分组弹框缺失");
  const dialog = markup.slice(dialogStart, dialogEnd);

  // 头部/底部类名分别驱动内边距、分隔线和移动端按钮布局；类名写错
  // 时标题会贴边、按钮会脱离弹框底栏。
  assert.match(dialog, /class="upstream-dialog group-dialog"/);
  assert.match(dialog, /aria-labelledby="group-dialog-title"/);
  assert.match(dialog, /aria-describedby="group-dialog-description"/);
  assert.match(dialog, /<header class="modal-head upstream-modal-head">/);
  assert.match(dialog, /<footer class="modal-footer">/);

  const styles = read("static/css/forms-dialogs.css");
  assert.match(styles, /\.group-dialog\s*\{[^}]*width:\s*560px;/s);
});

test("渠道表单提交的分组字段名与服务端一致", () => {
  const source = read("static/js/upstreams.js");
  // 服务端读的是 group_ids；名字不一致会被静默忽略，渠道就落回 default。
  assert.match(source, /group_ids: readUpstreamGroupSelection\(\)/);
});

test("令牌表单提交的分组字段名与服务端一致", () => {
  const source = read("static/js/tokens.js");
  assert.match(source, /group_id: Number\(tokenGroupSelect\?\.value\) \|\| 1/);
});

test("未勾选任何分组时读回空数组，交给服务端兜底成 default", () => {
  const source = read("static/js/groups.js");
  const context = vm.createContext({
    upstreamGroupList: { querySelectorAll: () => [] },
    Number,
    JSON,
  });
  vm.runInContext(extractFunction(source, "readUpstreamGroupSelection"), context);
  assert.equal(
    vm.runInContext("JSON.stringify(readUpstreamGroupSelection())", context),
    "[]",
  );
});

test("读回渠道分组勾选时转成数字，避免服务端收到字符串 id", () => {
  const source = read("static/js/groups.js");
  const context = vm.createContext({
    upstreamGroupList: {
      querySelectorAll: () => [{ value: "1" }, { value: "3" }],
    },
    Number,
    JSON,
  });
  vm.runInContext(extractFunction(source, "readUpstreamGroupSelection"), context);
  assert.equal(
    vm.runInContext("JSON.stringify(readUpstreamGroupSelection())", context),
    "[1,3]",
  );
});

test("default 分组不给删除按钮", () => {
  const source = read("static/js/groups.js");
  // 删掉 default 会让引用它的令牌无处可去，所以按钮本身就不该出现。
  assert.match(source, /group\.is_default\s*\n?\s*\?\s*`<button[^`]*data-group-edit/);
  assert.doesNotMatch(
    source.slice(source.indexOf("group.is_default"), source.indexOf("const badge")),
    /is_default\s*\?[^:]*data-group-delete/,
  );
});

test("新建渠道和新建令牌都会清掉上一次的分组残留", () => {
  const upstreams = read("static/js/upstreams.js");
  const tokens = read("static/js/tokens.js");
  // 不清的话，新建时会带上上一次编辑对象的分组。
  assert.match(upstreams, /pendingUpstreamGroupIds = null;/);
  assert.match(tokens, /delete tokenGroupSelect\?\.dataset\.pendingGroupId;/);
});

test("groups.js 在 upstreams.js 与 tokens.js 之后加载", () => {
  const markup = read("static/admin.html");
  const order = ["upstreams.js", "tokens.js", "groups.js"].map((file) =>
    markup.indexOf(`/static/js/${file}`),
  );
  // 经典脚本共享全局作用域，groups.js 里的填充函数要在两者之后定义才拿得到。
  assert.ok(order.every((position) => position > 0), "脚本标签缺失");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("渠道表的分组列在表头、列菜单与行渲染里三处齐全", () => {
  const markup = read("static/admin.html");
  const table = markup.slice(
    markup.indexOf('id="upstream-table"'),
    markup.indexOf('<tbody id="upstream-rows">'),
  );
  const headerCount = [...table.matchAll(/<th[\s>]/g)].length;

  // 选择、ID、渠道名、模型匹配、分组、优先级、权重、状态、操作
  assert.equal(headerCount, 9);
  assert.match(table, /data-col="groups">分组<\/th>/);

  // 空状态和骨架屏的 colspan 跟着表头走，少一列表格就会错位。
  assert.match(read("static/js/upstreams.js"), /const colCount = 9;/);
  assert.match(read("static/js/upstreams.js"), /data-col="groups">\$\{renderUpstreamGroups\(upstream\)\}/);
  // 列菜单靠这两张表驱动，缺一处这列就不能隐藏或没有名字。
  assert.match(read("static/js/bootstrap.js"), /^\s*groups: true,$/m);
  assert.match(read("static/js/bootstrap.js"), /groups: "分组",/);
});

test("分组名未加载时退化成 id，不至于渲染出 undefined", () => {
  const source = read("static/js/bootstrap.js");
  const context = vm.createContext({
    MAX_MODEL_CHIPS: 3,
    escapeHtml: (value) => String(value),
    groupById: () => null,
    Array,
  });
  vm.runInContext(extractFunction(source, "renderUpstreamGroups"), context);

  const html = vm.runInContext(
    "renderUpstreamGroups({ group_ids: [2, 5] })",
    context,
  );
  assert.match(html, /#2/);
  assert.match(html, /#5/);
  assert.doesNotMatch(html, /undefined/);
});

test("渠道不属任何分组时显示占位而不是空白单元格", () => {
  const source = read("static/js/bootstrap.js");
  const context = vm.createContext({
    MAX_MODEL_CHIPS: 3,
    escapeHtml: (value) => String(value),
    groupById: () => null,
    Array,
  });
  vm.runInContext(extractFunction(source, "renderUpstreamGroups"), context);
  assert.match(
    vm.runInContext("renderUpstreamGroups({ group_ids: [] })", context),
    /—/,
  );
});
