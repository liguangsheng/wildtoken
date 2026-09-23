// 抽屉是 showModal 打开的，在浏览器顶层。提示要进顶层才看得见，要挂进对话框里
// 才点得动——对话框之外的文档是 inert，点提示的 × 会落到抽屉的关闭按钮上。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("提示区是 popover，新消息到来时重新弹到最上层", () => {
  const source = read("web/src/components/feedback.tsx");
  assert.match(source, /className="toast-region" ref=\{regionRef\} popover="manual"/);
  assert.match(source, /region\.hidePopover\(\);\s*\n\s*if \(newestId > 0\) region\.showPopover\(\);/);
});

test("有模态对话框时提示区挂进最上层那个对话框", () => {
  const source = read("web/src/components/feedback.tsx");
  assert.match(source, /dialog\.matches\(":modal"\)/);
  assert.match(source, /host \?\? document\.body,\s*\n\s*\)\}/);
});

test("popover 的 UA 颜色要改回继承", () => {
  const css = read("static/css/tables.css");
  const rule = css.match(/\.toast-region \{[^}]+\}/)[0];
  assert.match(rule, /color: inherit;/);
});
