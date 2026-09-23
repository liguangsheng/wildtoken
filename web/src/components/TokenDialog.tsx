import { useEffect, useState } from "react";

import { expiryInputValue, parseExpiry, toUtcStamp } from "../expiry";
import type { APIToken } from "../types";
import { useDialog } from "../useDialog";

export interface TokenPayload {
  name: string;
  description: string;
  enabled: boolean;
  expires_at: string | null;
  group_id: number;
  /** “100M”“1B”这类表达式，空串表示不限额。后端负责解析。 */
  limit_expression: string;
  rate_limit: string | null;
  /** 空数组表示不限模型。 */
  allowed_models: string[];
  /** 只在新建时允许，留空由后端生成。 */
  token?: string | null;
}

/** 逗号或换行分隔，去空去重。大小写去重交给后端。 */
function splitModels(value: string): string[] {
  const seen = new Set<string>();
  for (const part of value.split(/[,\n]/)) {
    const trimmed = part.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/** 快捷档。填进输入框而不是替代它——填完还能接着改。 */
const EXPIRY_PRESETS = [
  { label: "7 天", value: "7d" },
  { label: "30 天", value: "30d" },
  { label: "90 天", value: "90d" },
  { label: "永不过期", value: "" },
];



/* 限额按表达式原样传，不在前端折成数字。

   后端收的是 limit_expression（“100M”“1B”这类字符串），它自己解析并算出
   最短表达式存回来。前端折成数字再发一个 limit_tokens 字段，会被严格解码
   直接拒掉：“unknown field limit_tokens”。 */

/* 有效期三态：具体天数 / 永不过期 / 不修改。
   编辑时默认落在 keep——原值是绝对时间，硬塞进「N 天」会在保存时
   把到期日往后推。 */


export function TokenDialog({
  open,
  token,
  groups,
  busy,
  onSubmit,
  onClose,
}: {
  open: boolean;
  /** null 表示新建。 */
  token: APIToken | null;
  groups: Array<{ id: number; name: string }>;
  busy: boolean;
  onSubmit: (payload: TokenPayload) => void;
  onClose: () => void;
}) {
  const ref = useDialog(open, onClose);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [expires, setExpires] = useState("");
  const [groupId, setGroupId] = useState(1);
  const [limit, setLimit] = useState("");
  const [rateLimit, setRateLimit] = useState("");
  const [allowedModels, setAllowedModels] = useState("");
  const [custom, setCustom] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(token?.name ?? "");
    setDescription(token?.description ?? "");
    setEnabled(token?.enabled ?? true);
    setGroupId(token?.group_id ?? groups[0]?.id ?? 1);
    // 回填服务端算好的最短表达式，这样不动表单再保存不会改变限额。
    setLimit(token?.quota.limit_expression ?? "");
    setRateLimit(token?.rate_limit ?? "");
    setAllowedModels((token?.allowed_models ?? []).join("\n"));
    setCustom("");
    // 编辑时把现有到期时间填回输入框，保存时原样解回去，不动就不会变。
    setExpires(expiryInputValue(token?.expires_at ?? null));
  }, [open, token, groups]);

  /* 边输边算，看得见结果才敢填 1d3h 这种写法。 */
  const parsedExpiry = parseExpiry(expires, Date.now());
  const expiryPreview = !parsedExpiry.ok
    ? parsedExpiry.error
    : parsedExpiry.expiresAtMs === null
      ? "永不过期"
      : new Date(parsedExpiry.expiresAtMs).toLocaleString("zh-CN", { hour12: false });

  return (
    <dialog className="upstream-dialog dialog--drawer" ref={ref} onCancel={onClose}>
      <form
        className="upstream-dialog-panel"
        onSubmit={(event) => {
          event.preventDefault();
          // 有效期解析不过就不提交，否则会静默地存成永不过期。
          if (busy || !name.trim() || !parsedExpiry.ok) return;
          onSubmit({
            name: name.trim(),
            description: description.trim(),
            enabled,
            expires_at:
              parsedExpiry.expiresAtMs === null
                ? null
                : toUtcStamp(new Date(parsedExpiry.expiresAtMs)),
            group_id: groupId,
            limit_expression: limit.trim(),
            rate_limit: rateLimit.trim() || null,
            allowed_models: splitModels(allowedModels),
            ...(token ? {} : { token: custom.trim() || null }),
          });
        }}
      >
        <div className="modal-head upstream-modal-head">
          <div>
            <h2>{token ? `编辑令牌 #${token.id}` : "新增令牌"}</h2>
            <p>下游调用凭证。限额与有效期都可以留空表示不限。</p>
          </div>
          {/* 和其他对话框同形：icon-close 加 SVG，不是一个字符×。 */}
          <div className="modal-head-actions">
            <button
              type="button"
              className="secondary ghost icon-close"
              aria-label="关闭"
              title="关闭"
              onClick={onClose}
            >
              <svg className="dialog-icon dialog-icon--close" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4L4 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* 三段：头、可滚动的正文、钉底的页脚。upstream-dialog-panel 本来就是
            grid-template-rows: auto minmax(0,1fr) auto，缺了中间那层的话，满高抽屉里
            按钮不钉底，要滚到最下面才够得着。 */}
        <div className="upstream-dialog-body">
          <section className="form-section">
            <div className="form-section-head">
              <div>
                <h3>基础信息</h3>
                <p>名称、描述与所属分组。</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="field">
                <span className="field-label">名称</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={80}
                  autoComplete="off"
                />
              </label>

              <label className="field">
                <span className="field-label">描述</span>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  autoComplete="off"
                />
              </label>

              <label className="field span-2">
                <span className="field-label">分组</span>
                <select value={groupId} onChange={(e) => setGroupId(Number(e.target.value))}>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
                <span className="field-hint">令牌只能访问所属分组里的渠道。</span>
              </label>

              {token ? null : (
                <label className="field span-2">
                  <span className="field-label">自定义令牌（可选）</span>
                  <input
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                    placeholder="留空自动生成"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="field-hint">填了就用这个值，创建后不能再改。</span>
                </label>
              )}
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-head">
              <div>
                <h3>配额与限速</h3>
                <p>两项都留空就是不限。</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="field">
                <span className="field-label">限额（可选）</span>
                <input
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  placeholder="留空则不限额，如 100M、1B、1000K"
                  maxLength={24}
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="field-hint">
                  按累计 token 总量计算，不会自动重置。支持 K/M/B/T 后缀。
                </span>
              </label>

              <label className="field">
                <span className="field-label">限速（可选）</span>
                <input
                  value={rateLimit}
                  onChange={(e) => setRateLimit(e.target.value)}
                  placeholder="留空则不限速，如 100/m、1000/h"
                  maxLength={24}
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="field-hint">按请求次数限速，单位支持 s/m/h/d。</span>
              </label>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-head">
              <div>
                <h3>模型限制</h3>
                <p>留空则可以请求分组内的任意模型。</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="field span-2">
                <span className="field-label">允许的模型（可选）</span>
                <textarea
                  rows={4}
                  spellCheck={false}
                  value={allowedModels}
                  onChange={(e) => setAllowedModels(e.target.value)}
                  placeholder={"gpt-4o\nclaude-*"}
                />
                <span className="field-hint">
                  每行或逗号分隔一个，不区分大小写；结尾加 * 按前缀匹配。不在列表里的模型会被 403 拒绝，/v1/models 也只列出允许的。
                </span>
              </label>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-head">
              <div>
                <h3>有效期与状态</h3>
                <p>留空则永不过期。</p>
              </div>
            </div>
            <div className="form-grid">
              {/* 自由输入加快捷档。只给下拉的话设不了 1d3h 或某个具体时刻。 */}
              <div className="field span-2">
                <span className="field-label">有效期（可选）</span>
                <input
                  value={expires}
                  onChange={(event) => setExpires(event.target.value)}
                  placeholder="留空则永不过期，如 30d、1d3h"
                  maxLength={40}
                  autoComplete="off"
                  spellCheck={false}
                />
                <div className="expiry-presets">
                  {EXPIRY_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className="secondary small"
                      onClick={() => setExpires(preset.value)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <span className={parsedExpiry.ok ? "field-hint" : "field-hint field-hint-error"}>
                  {parsedExpiry.ok ? `到期时间：${expiryPreview}` : expiryPreview}
                </span>
              </div>

              {/* 和渠道抽屉同形：toggle-row 带一句说明，不是裸复选框。 */}
              <div className="toggle-list span-2">
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                  />
                  <span>
                    <strong>启用</strong>
                    <small>停用后这个令牌的请求会被直接拒掉。</small>
                  </span>
                </label>
              </div>
            </div>
          </section>
        </div>

        {/* modal-footer 而不是 modal-actions：面板的第三行是钉底的，满高抽屉里
            按钮不该跟着正文滚到看不见的地方。 */}
        <div className="modal-footer">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" disabled={busy || !name.trim()}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
