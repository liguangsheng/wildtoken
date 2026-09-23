/**
 * 生图页的请求体与响应解析。纯函数，不碰 DOM。
 *
 * 请求体是唯一的状态来源：表单控件从它读、往它写，手改 JSON 和点控件是同
 * 一件事。响应按 OpenAI images 的两种形状解析——非流式的 data[]，和流式的
 * image_generation.partial_image / completed 事件。
 *
 * 日志详情也用这里的解析。日志正文有上限（默认 200KB，常见配置 1MB），一张
 * 图的 base64 经常超出，存下来的是截掉尾巴的 JSON；这时从残文里把 base64
 * 捞出来，标成截断。浏览器能画出残缺 PNG 的上半截，总比什么都看不到强。
 *
 * 服务端开了图片存储后，日志里的 b64_json 已换成 "@image:/images/…" 这样的
 * 标记，图在文件里，按路径直接取。
 */

type JSONObject = Record<string, unknown>;

/** 服务端存图后留在 b64_json 里的前缀，后面是图片的下载路径。和 imagestore.Marker 一致。 */
export const STORED_IMAGE_MARKER = "@image:";

export function defaultImageBody(model: string, prompt: string): JSONObject {
  return { model, prompt, n: 1, size: "1024x1024" };
}

/**
 * 设一个字段；值为空串或 undefined 时删掉它。「不传」和「传空值」对上游
 * 不是一回事，很多实现会拒绝不认识或为空的参数。
 */
export function setField(body: JSONObject, key: string, value: unknown): JSONObject {
  const next: JSONObject = { ...body };
  if (value === "" || value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/** 流式开关：partial_images 只在流式下有意义，关掉时一起清。 */
export function withImageStream(body: JSONObject, stream: boolean): JSONObject {
  const next: JSONObject = { ...body };
  if (stream) {
    next.stream = true;
    next.partial_images = next.partial_images ?? 2;
  } else {
    delete next.stream;
    delete next.partial_images;
  }
  return next;
}

export interface ImageItem {
  /** data: URL 或上游给的 http(s) URL，可直接放进 <img src>。 */
  src: string;
  /** 能从 base64 算出来时给字节数；URL 形式未知。 */
  bytes: number | null;
  format: string | null;
  /** 流式中间帧的序号；最终图为 null。 */
  partialIndex: number | null;
  revisedPrompt: string | null;
  /** base64 没收全：日志截断或流还没收完。bytes 是已有的部分。 */
  truncated: boolean;
  /** 服务端已存成文件，src 是它的下载路径。 */
  stored: boolean;
}

export interface ImageResult {
  images: ImageItem[];
  usage: unknown;
  /** 上游报的错误信息，没有则 null。 */
  error: string | null;
}

/** 按文件头判断格式。上游常不写 output_format，靠它给 data: URL 选 MIME。 */
export function sniffFormat(b64: string): string | null {
  if (b64.startsWith("iVBOR")) return "png";
  if (b64.startsWith("/9j/")) return "jpeg";
  if (b64.startsWith("UklGR")) return "webp";
  if (b64.startsWith("R0lGOD")) return "gif";
  return null;
}

function base64Bytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

function fromBase64(
  b64: string,
  partialIndex: number | null,
  revisedPrompt: string | null,
  truncated: boolean,
): ImageItem {
  // 截断的 base64 按 4 字符对齐，否则整段解码失败，连上半截都画不出。
  const usable = truncated ? b64.slice(0, b64.length - (b64.length % 4)) : b64;
  const format = sniffFormat(usable);
  return {
    src: `data:image/${format ?? "png"};base64,${usable}`,
    bytes: base64Bytes(usable),
    format,
    partialIndex,
    revisedPrompt,
    truncated,
    stored: false,
  };
}

/** 已存成文件的图：格式看扩展名，大小不知道。 */
function fromStored(value: string, partialIndex: number | null, revisedPrompt: string | null): ImageItem {
  const src = value.slice(STORED_IMAGE_MARKER.length);
  const extension = /\.([a-z0-9]+)$/i.exec(src)?.[1]?.toLowerCase() ?? null;
  return {
    src,
    bytes: null,
    format: extension === "jpg" ? "jpeg" : extension,
    partialIndex,
    revisedPrompt,
    truncated: false,
    stored: true,
  };
}

function fromEntry(entry: JSONObject, partialIndex: number | null): ImageItem | null {
  const revisedPrompt = typeof entry.revised_prompt === "string" ? entry.revised_prompt : null;

  if (typeof entry.b64_json === "string" && entry.b64_json.startsWith(STORED_IMAGE_MARKER)) {
    return fromStored(entry.b64_json, partialIndex, revisedPrompt);
  }
  if (typeof entry.b64_json === "string" && entry.b64_json) {
    return fromBase64(entry.b64_json, partialIndex, revisedPrompt, false);
  }
  if (typeof entry.url === "string" && entry.url) {
    return { src: entry.url, bytes: null, format: null, partialIndex, revisedPrompt, truncated: false, stored: false };
  }
  return null;
}

/**
 * 从解析不了的残文里捞图：逐个找 "b64_json":"… 和 "url":"…"。没有收尾引号
 * 的 base64 就是被截断的那张；没收全的 url 用不了，丢掉。
 */
function salvageImages(text: string, partialIndex: number | null): ImageItem[] {
  const images: ImageItem[] = [];
  for (const match of text.matchAll(/"(b64_json|url)"\s*:\s*"([^"]*)("?)/g)) {
    const [, key, value, quote] = match;
    if (!value) continue;
    if (key === "b64_json" && value.startsWith(STORED_IMAGE_MARKER)) {
      if (quote) images.push(fromStored(value, partialIndex, null));
    } else if (key === "b64_json") {
      images.push(fromBase64(value, partialIndex, null, quote === ""));
    } else if (quote) {
      images.push({ src: value, bytes: null, format: null, partialIndex, revisedPrompt: null, truncated: false, stored: false });
    }
  }
  return images;
}

function errorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const error = (value as JSONObject).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as JSONObject).message;
    return typeof message === "string" ? message : JSON.stringify(error);
  }
  return null;
}

/**
 * 从响应原文里取出图片。流式时每个完整的事件都会解析，所以接收过程中就能
 * 看到中间帧；最后一行还没收全时跳过它，等下一块。
 */
export function parseImageResponse(raw: string): ImageResult {
  const text = raw.trim();
  const result: ImageResult = { images: [], usage: null, error: null };
  if (!text) return result;

  if (/^(data|event):/m.test(text) && !text.startsWith("{")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      let event: JSONObject;
      try {
        event = JSON.parse(data) as JSONObject;
      } catch {
        // 还没收全的最后一行：流还在收，或者日志把它截断了。能捞就捞。
        const partial = /"type"\s*:\s*"image_generation\.partial_image"/.test(data);
        const index = Number(/"partial_image_index"\s*:\s*(\d+)/.exec(data)?.[1] ?? 0);
        result.images.push(...salvageImages(data, partial ? index : null));
        continue;
      }

      result.error = errorMessage(event) ?? result.error;
      if (event.usage) result.usage = event.usage;
      const partial = event.type === "image_generation.partial_image";
      const index = typeof event.partial_image_index === "number" ? event.partial_image_index : null;
      const item = fromEntry(event, partial ? index : null);
      if (item) result.images.push(item);
    }
    return result;
  }

  let body: JSONObject;
  try {
    body = JSON.parse(text) as JSONObject;
  } catch {
    result.images = salvageImages(text, null);
    return result;
  }
  result.error = errorMessage(body);
  result.usage = body.usage ?? null;
  if (Array.isArray(body.data)) {
    for (const entry of body.data) {
      const item = entry && typeof entry === "object" ? fromEntry(entry as JSONObject, null) : null;
      if (item) result.images.push(item);
    }
  }
  return result;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 把原文里的长 base64 折成占位，给「完整响应」看。一张图的 base64 动辄几
 * MB，原样塞进 <pre> 会把页面拖死，也没人读得了。还没收全、没有收尾引号的
 * 那一段同样折掉。
 */
export function collapseBase64(raw: string): string {
  return raw.replace(/"([A-Za-z0-9+/=]{200,})("|$)/g, (_match, b64: string, quote: string) =>
    `"<base64 ${formatBytes(base64Bytes(b64))}>${quote}`,
  );
}
