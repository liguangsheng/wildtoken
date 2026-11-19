export interface LocalRecord {
  value: string | null;
  error: string;
  save: (value: string) => string;
}

/** 比较读到的版本，避免覆盖另一个标签页刚保存的会话。 */
export function openLocalRecord(key: string, storage?: Pick<Storage, "getItem" | "setItem">): LocalRecord {
  try {
    const target = storage ?? localStorage;
    let expected = target.getItem(key);
    return {
      value: expected, error: "",
      save(value) {
        try {
          if (target.getItem(key) !== expected) return "其他标签页已更新会话，本页暂停保存。请刷新后继续。";
          target.setItem(key, value);
          expected = value;
          return "";
        } catch { return "本机保存失败：浏览器存储不可用或空间不足。记录仍保留在当前页面。"; }
      },
    };
  } catch {
    const error = "浏览器存储不可用，会话仅保留在当前页面。";
    return { value: null, error, save: () => error };
  }
}

export function downloadJSON(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
