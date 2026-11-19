import { useState } from "react";

import type { DebugSession } from "../debugSessions";

export function DebugSessionList({ sessions, activeId, ownerId, compact, error, onSelect, onNew, onRename, onDelete, onExport, onReset }: {
  sessions: DebugSession[];
  activeId: string;
  ownerId: string | null;
  compact: boolean;
  error: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onExport: () => void;
  onReset: () => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [rename, setRename] = useState<string | null>(null);
  const visible = sessions.filter((item) => `${item.title} ${item.draft.model}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <aside className="settings-card debug-sidebar" aria-label="会话列表">
      <div className="debug-bar">
        {compact ? <button type="button" className="ghost small" aria-expanded={expanded} aria-controls="debug-session-list"
          onClick={() => setExpanded(!expanded)}>会话 · {sessions.length}</button> : <h3>会话</h3>}
        <button type="button" className="primary small" onClick={() => { onNew(); setRename(null); }}>新会话</button>
      </div>
      <div className="debug-history" id="debug-session-list" hidden={compact && !expanded}>
        <input type="search" aria-label="搜索会话" placeholder="搜索会话或模型…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="debug-session-items">
          {visible.length === 0 ? <p className="muted">没有匹配的会话</p> : visible.map((item) => (
            <button type="button" className="debug-recent-item" key={item.id} aria-current={item.id === activeId ? "true" : undefined}
              title={item.title} onClick={() => { onSelect(item.id); setRename(null); setExpanded(false); }}>
              <strong>{item.title}</strong>
              <span>{ownerId === item.id ? "生成中 · " : ""}{item.draft.model || "未选模型"}</span>
              <span>{item.turns.length} 轮 · {new Date(item.updatedAt).toLocaleDateString()}</span>
            </button>
          ))}
        </div>
        {rename !== null ? <form className="debug-bar" onSubmit={(event) => {
          event.preventDefault();
          if (rename.trim()) { onRename(rename.trim()); setRename(null); }
        }}>
          <input aria-label="会话名称" autoFocus required maxLength={80} value={rename} onChange={(event) => setRename(event.target.value)} />
          <button type="submit" className="secondary small">保存名称</button>
          <button type="button" className="ghost small" onClick={() => setRename(null)}>取消</button>
        </form> : <div className="debug-bar">
          <button type="button" className="ghost small" onClick={() => setRename(sessions.find((item) => item.id === activeId)?.title ?? "")}>重命名</button>
          <button type="button" className="ghost small" onClick={onDelete}>删除会话</button>
        </div>}
        <div className="debug-bar">
          <button type="button" className="ghost small" onClick={onExport}>导出会话</button>
          <button type="button" className="ghost small" onClick={onReset}>{error ? "重置本机记录" : "清空会话"}</button>
        </div>
      </div>
      <p className="field-hint" role={error ? "alert" : undefined}>{error || "消息与参数自动保存到本机，不保存鉴权头。"}</p>
    </aside>
  );
}
