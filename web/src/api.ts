/* 后端调用。认证方式和旧控制台一致：localStorage 里的
   wildtoken_admin_token，走 x-admin-token 头。同一个浏览器里两版
   共用一份令牌，切过去不用重新登录。 */

import type {
  APIToken,
  BalanceResult,
  ChannelExportDocument,
  Group,
  ImportResult,
  LogOverview,
  LogSnapshotField,
  ModelTestResult,
  PromptTemplate,
  RequestLogPage,
  RuntimeSettings,
  SystemInfo,
  TokenUsage,
  TopStats,
  Upstream,
  UpstreamHealth,
  UpstreamStats,
} from "./types";

const ADMIN_TOKEN_KEY = "wildtoken_admin_token";

export function getAdminToken(): string {
  return localStorage.getItem(ADMIN_TOKEN_KEY) ?? "";
}

export function setAdminToken(token: string): void {
  localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
}

/** 401 时抛这个，让调用方能弹出登录框而不是显示一条普通错误。 */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * 401 往上一处报。
 *
 * 旧控制台是在 api() 里直接开弹窗；这里改成广播，由 App 集中接住。
 * 好处是各页面不必各自处理认证，也就不可能漏掉一处。
 */
function reportUnauthorized(message: string): void {
  window.dispatchEvent(new CustomEvent<string>("console:unauthorized", { detail: message }));
}

/**
 * 发请求、带令牌、把非 2xx 变成异常。返回原始 Response，读法由调用方定——
 * JSON 走 api()，事件流由调用方自己逐块读。
 */
export async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const token = getAdminToken();
  if (token) headers.set("x-admin-token", token);

  const response = await fetch(path, { ...init, headers });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      message = data.detail || data.error?.message || data.error || message;
    } catch {
      // 非 JSON 错误体，保留 HTTP 状态说明。
    }
    if (response.status === 401) {
      clearAdminToken();
      reportUnauthorized(message);
      throw new UnauthorizedError(message);
    }
    throw new Error(message);
  }
  return response;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await send(path, init);
  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

export function listUpstreams(): Promise<Upstream[]> {
  return api<Upstream[]>("/api/admin/upstreams/");
}

export function createUpstream(payload: unknown): Promise<Upstream> {
  return api<Upstream>("/api/admin/upstreams/", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateUpstream(id: number, payload: unknown): Promise<Upstream> {
  return api<Upstream>(`/api/admin/upstreams/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteUpstream(id: number): Promise<null> {
  return api<null>(`/api/admin/upstreams/${id}`, { method: "DELETE" });
}

/** 返回完整渠道（含 api_key 与否），编辑和复制都需要。 */
export function getUpstream(id: number): Promise<Upstream> {
  return api<Upstream>(`/api/admin/upstreams/${id}`);
}

export function testUpstream(id: number, path = "/v1/models"): Promise<unknown> {
  return api<unknown>(`/api/admin/upstreams/${id}/test`, {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export function fetchUpstreamModels(id: number): Promise<{ models: string[] }> {
  return api<{ models: string[] }>(`/api/admin/upstreams/${id}/models`, { method: "POST" });
}

/**
 * 向渠道发一次真实模型请求。
 *
 * 上游报错不会让这个调用失败——后端把结果包成 200，成败看 ok 字段。
 * 要的就是这个：上游返回 500 也得把请求和响应原样展出来供排查。
 */
export function testUpstreamModel(
  id: number,
  body: { model: string; protocol: string; prompt_template_id: number; prompt: string },
): Promise<ModelTestResult> {
  return api<ModelTestResult>(`/api/admin/upstreams/${id}/test-model`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** new-api 与 sub2api 两种余额接口，路径不同。 */
export function fetchUpstreamBalance(
  id: number,
  provider: "new-api" | "sub2api",
): Promise<BalanceResult> {
  const path = provider === "sub2api"
    ? `/api/admin/upstreams/${id}/balance/sub2api`
    : `/api/admin/upstreams/${id}/balance`;
  return api<BalanceResult>(path, { method: "POST" });
}

export function listGroups(): Promise<Array<{ id: number; name: string }>> {
  return api<Array<{ id: number; name: string }>>("/api/admin/groups/");
}

/** 带计数的完整分组列表，分组页用。 */
export function listGroupsFull(): Promise<Group[]> {
  return api<Group[]>("/api/admin/groups/");
}

export function createGroup(payload: { name: string; description: string }): Promise<Group> {
  return api<Group>("/api/admin/groups/", { method: "POST", body: JSON.stringify(payload) });
}

export function updateGroup(
  id: number,
  payload: { name: string; description: string },
): Promise<Group> {
  return api<Group>(`/api/admin/groups/${id}`, { method: "PUT", body: JSON.stringify(payload) });
}

export function deleteGroup(id: number): Promise<null> {
  return api<null>(`/api/admin/groups/${id}`, { method: "DELETE" });
}

export function getSettings(): Promise<RuntimeSettings> {
  return api<RuntimeSettings>("/api/admin/settings/");
}

/** 保存设置。revision 要原样带回去，后端靠它拒掉过期的写入。 */
/**
 * 保存运行时设置。
 *
 * 逐字段拼，不能把读回来的整个对象发回去：后端是严格解码，多一个
 * updated_at 就整请求 400。revision 要原样带上，它是乐观锁。
 */
export function saveSettings(payload: RuntimeSettings): Promise<RuntimeSettings> {
  return api<RuntimeSettings>("/api/admin/settings/", {
    method: "PUT",
    body: JSON.stringify({
      log_body_keep_count: payload.log_body_keep_count,
      log_retention_days: payload.log_retention_days,
      log_body_max_bytes: payload.log_body_max_bytes,
      max_retries: payload.max_retries,
      same_upstream_retry_interval_ms: payload.same_upstream_retry_interval_ms,
      auto_weight_failure_penalty: payload.auto_weight_failure_penalty,
      auto_weight_success_increment: payload.auto_weight_success_increment,
      auto_weight_recovery_increment: payload.auto_weight_recovery_increment,
      auto_weight_recovery_interval_seconds: payload.auto_weight_recovery_interval_seconds,
      proxy_enabled: payload.proxy_enabled,
      proxy_url: payload.proxy_url,
      revision: payload.revision,
    }),
  });
}

/** 轮换管理员令牌。新值只在响应里出现一次。 */
export function rotateAdminToken(): Promise<{ token: string }> {
  return api<{ token: string }>("/api/admin/settings/admin-token/rotate", { method: "POST" });
}

export function getSystemInfo(): Promise<SystemInfo> {
  return api<SystemInfo>("/api/admin/system");
}

export function listPromptTemplates(): Promise<PromptTemplate[]> {
  return api<PromptTemplate[]>("/api/admin/settings/model-test-prompts");
}

export function createPromptTemplate(payload: {
  name: string;
  prompt: string;
}): Promise<PromptTemplate> {
  return api<PromptTemplate>("/api/admin/settings/model-test-prompts", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updatePromptTemplate(
  id: number,
  payload: { name: string; prompt: string },
): Promise<PromptTemplate> {
  return api<PromptTemplate>(`/api/admin/settings/model-test-prompts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deletePromptTemplate(id: number): Promise<null> {
  return api<null>(`/api/admin/settings/model-test-prompts/${id}`, { method: "DELETE" });
}

/**
 * 看板数据。
 *
 * 四个接口并发拉：概览、Top 排行、Token 用量、最近失败。
 * /logs/top 的参数叫 window 而不是 range，且没有多窗口模式。
 */
/**
 * 看板的四个接口并发拉。
 *
 * custom 范围要额外带日期；其余档位后端自己算区间。三个日志接口的参数名
 * 不一样（range / window），这是后端的实情，不是笔误。
 */
export function fetchDashboard(
  range: string,
  custom?: { start: string; end: string },
): Promise<{
  overview: LogOverview;
  top: TopStats;
  usage: TokenUsage;
  recent: RequestLogPage;
}> {
  const dates =
    range === "custom" && custom
      ? `&start_date=${encodeURIComponent(custom.start)}&end_date=${encodeURIComponent(custom.end)}`
      : "";
  return Promise.all([
    api<LogOverview>(`/api/admin/logs/overview?range=${range}${dates}`),
    api<TopStats>(`/api/admin/logs/top?window=${range}&limit=5${dates}`),
    api<TokenUsage>(`/api/admin/logs/token-usage?range=${range}${dates}`),
    api<RequestLogPage>("/api/admin/logs/?limit=20"),
  ]).then(([overview, top, usage, recent]) => ({ overview, top, usage, recent }));
}

export function listTokens(): Promise<APIToken[]> {
  return api<APIToken[]>("/api/admin/tokens/");
}

export function createToken(payload: unknown): Promise<APIToken> {
  return api<APIToken>("/api/admin/tokens/", { method: "POST", body: JSON.stringify(payload) });
}

export function updateToken(id: number, payload: unknown): Promise<APIToken> {
  return api<APIToken>(`/api/admin/tokens/${id}`, { method: "PUT", body: JSON.stringify(payload) });
}

export function deleteToken(id: number): Promise<null> {
  return api<null>(`/api/admin/tokens/${id}`, { method: "DELETE" });
}

export function setTokenEnabled(id: number, enabled: boolean): Promise<APIToken> {
  return api<APIToken>(`/api/admin/tokens/${id}/enabled`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

/** 额度用完后手动清零。计数养在令牌行上，不会随日志过期自动回落。 */
export function resetTokenUsage(id: number): Promise<APIToken> {
  return api<APIToken>(`/api/admin/tokens/${id}/usage/reset`, { method: "POST" });
}

/** 一份快照。元信息列表行里已经有了，报文按页签逐份拉，没存过的返回 null。 */
export function getLogSnapshot(id: number, field: LogSnapshotField): Promise<unknown> {
  return api<unknown>(`/api/admin/logs/${id}/snapshots/${field}`);
}

/**
 * 日志列表。
 *
 * 游标优先：before_created_at + before_id 才能在持续写入时稳住分页，
 * 纯 offset 会因为新行插到头部而重复或漏行。
 */
/**
 * 取一页日志。
 *
 * 筛选全部回服务端。在前端过滤当前页的话，选 5xx 看到的是「这 50 行里的
 * 5xx」而不是全库的，翻页时每页各筛各的，分页计数也对不上。
 */
export function listLogs(params: {
  limit: number;
  beforeCreatedAt?: string;
  beforeId?: number;
  search?: string;
  clientType?: string;
  status?: string;
  upstreamId?: string;
}): Promise<RequestLogPage> {
  const query = new URLSearchParams({ limit: String(params.limit) });
  if (params.beforeCreatedAt && params.beforeId !== undefined) {
    query.set("before_created_at", params.beforeCreatedAt);
    query.set("before_id", String(params.beforeId));
  }
  if (params.search?.trim()) query.set("search", params.search.trim());
  if (params.clientType) query.set("client_type", params.clientType);
  if (params.status) query.set("status", params.status);
  if (params.upstreamId) query.set("upstream_id", params.upstreamId);
  return api<RequestLogPage>(`/api/admin/logs/?${query}`);
}

/** 卡片视图的统计，一次拿全部渠道——按渠道逐个请求会变成 N 次往返。 */
/**
 * 卡片视图的每渠道统计。
 *
 * 响应是 {"stats": {...}} 而不是裸 map。把整个响应当 map 用的话，stats[id]
 * 恒为 undefined——指标全是破折号，而且不报错。
 */
export function fetchUpstreamStats(): Promise<Record<string, UpstreamStats>> {
  return api<{ stats: Record<string, UpstreamStats> }>("/api/admin/upstreams/stats").then(
    (payload) => payload.stats ?? {},
  );
}

/** 24 小时逐小时健康，同样是一次拿全部。 */
export function fetchUpstreamHealth(): Promise<Record<string, UpstreamHealth>> {
  return api<{ entries: Record<string, UpstreamHealth> }>(
    "/api/admin/upstreams/health?hours=24",
  ).then((payload) => payload.entries ?? {});
}

/** 导出文档。后端返回的是带 kind/version 的包装，直接存成文件。 */
/**
 * 导出渠道配置。
 *
 * includeApiKeys 默认开——不带密钥的备份看着完整，导回去每个渠道都要重填。
 * 要把文件给别人时才关掉它。
 */
export function exportUpstreams(
  ids?: number[],
  includeApiKeys = true,
): Promise<ChannelExportDocument> {
  return api<ChannelExportDocument>("/api/admin/upstreams/export", {
    method: "POST",
    body: JSON.stringify({
      ...(ids?.length ? { ids } : {}),
      include_api_keys: includeApiKeys,
    }),
  });
}

export function importUpstreams(
  document: ChannelExportDocument,
  mode: "skip" | "overwrite",
): Promise<ImportResult> {
  return api<ImportResult>("/api/admin/upstreams/import", {
    method: "POST",
    body: JSON.stringify({ ...document, mode }),
  });
}

/**
 * 问一个还没存下来的 Base URL 要模型列表。
 *
 * 快速导入和渠道表单里的「拉取模型」都走这条。表单那边要带上额外请求头和
 * 超时——有些上游没那个头就不返回模型，不带的话拉回来的列表和实际路由时看
 * 到的不是同一份。
 */
export function fetchModelsPreview(
  baseUrl: string,
  apiKey: string | null,
  options: { extraHeaders?: Record<string, string>; timeoutSeconds?: number } = {},
): Promise<{ models: string[] }> {
  return api<{ models: string[] }>("/api/admin/upstreams/fetch-models", {
    method: "POST",
    body: JSON.stringify({
      base_url: baseUrl,
      api_key: apiKey,
      extra_headers: options.extraHeaders ?? {},
      timeout_seconds: options.timeoutSeconds ?? null,
    }),
  });
}

export function setUpstreamArchived(id: number, archived: boolean): Promise<Upstream> {
  return api<Upstream>(`/api/admin/upstreams/${id}/archived`, {
    method: "PATCH",
    body: JSON.stringify({ archived }),
  });
}

export function setUpstreamEnabled(id: number, enabled: boolean): Promise<Upstream> {
  return api<Upstream>(`/api/admin/upstreams/${id}/enabled`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export function setUpstreamPriority(id: number, priority: number): Promise<Upstream> {
  return api<Upstream>(`/api/admin/upstreams/${id}/priority`, {
    method: "PATCH",
    body: JSON.stringify({ priority }),
  });
}
