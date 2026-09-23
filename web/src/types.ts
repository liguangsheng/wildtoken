/* API 类型。字段名对着 internal/models 里的 json tag 抄，不是猜的——
   改后端时这里的编译错误就是提示。 */

export interface Upstream {
  id: number;
  name: string;
  base_url: string;
  api_key_set: boolean;
  /* 只有详情接口带回来，列表接口没有。编辑渠道时明文回显到输入框，
     便于核对当前用的是哪把 Key；探上游也用它。 */
  api_key?: string | null;
  model_names: string[];
  model_prefixes: string[];
  model_mappings: Record<string, string>;
  effort_mappings: Record<string, string>;
  priority: number;
  weight: number;
  auto_weight_enabled: boolean;
  enabled: boolean;
  /** 归档渠道同时读作停用：归档会把 enabled 置 0。 */
  archived: boolean;
  extra_headers: Record<string, string>;
  timeout_seconds: number;
  rate_limit: string | null;
  created_at: string;
  updated_at: string;
  runtime_health_score: number;
  effective_weight: number;
  health_recovery_remaining_seconds?: number;
  group_ids: number[];
}

/**
 * 渠道 24 小时健康。
 *
 * success_rate 可以是 null——没流量时「成功率」没有定义，不能当 0 用。
 */
export interface UpstreamHealth {
  total: number;
  errors: number;
  success_rate: number | null;
  avg_ms: number;
  buckets: Array<{ bucket_epoch: number; total: number; errors: number }>;
}

/** 卡片视图的每渠道统计。一次请求拿全部，按 id 开。 */
export interface UpstreamStats {
  sparkline: Array<{ bucket: string; count: number }>;
  totalRequests: number;
  cacheHitRate: number;
  /** 每百万请求的平均 Token 消耗——本项目不存单价，这是成本的代理指标。 */
  avgTokensPer1M: number;
}

/* 日志行。指针字段在 Go 那边是 *T，这里就是 T | null——不要写成
   可选属性，否则分不清「字段缺失」和「值为空」。 */
export interface RequestLog {
  id: number;
  created_at: string;
  method: string;
  path: string;
  downstream_token_id: number | null;
  downstream_token_name: string | null;
  /** 建列之前的旧行是 null。*/
  client_ip: string | null;
  client_type: string;
  upstream_id: number | null;
  upstream_name: string | null;
  model: string | null;
  request_model: string | null;
  upstream_model: string | null;
  reasoning_effort: string | null;
  upstream_reasoning_effort: string | null;
  response_reasoning_effort: string | null;
  stream: number;
  status_code: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  prompt_cached_tokens: number | null;
  cache_creation_tokens: number | null;
  completion_reasoning_tokens: number | null;
  duration_ms: number | null;
  first_token_ms: number | null;
  error: string | null;
}

/** 在途请求。没有游标位置，所以只随最新一页和 SSE 快照来。 */
export interface ActiveRequest {
  id: number;
  started_at: string;
  elapsed_ms: number;
  method: string;
  path: string;
  downstream_token_id: number | null;
  downstream_token_name: string | null;
  /** 建列之前的旧行是 null。*/
  client_ip: string | null;
  client_type: string;
  upstream_id: number | null;
  upstream_name: string | null;
  model: string | null;
  request_model: string | null;
  upstream_model: string | null;
  reasoning_effort: string | null;
  upstream_reasoning_effort: string | null;
  /** 路由换过几个渠道。没选中渠道前是 0。 */
  attempt: number;
}

export interface RequestLogPage {
  items: RequestLog[];
  has_more: boolean;
  /** 只在最新一页填。 */
  active?: ActiveRequest[];
  /** 并发数读这个而不是 active.length——后者有上限截断。 */
  active_total: number;
  recent_rpm: number;
  recent_tpm: number;
}

/** 导出文档里的一条渠道。字段和 Go 的 ChannelExportItem 对齐。 */
export interface ChannelExportItem {
  name: string;
  base_url: string;
  api_key?: string | null;
  model_names: string[];
  model_prefixes: string[];
  model_mappings: Record<string, string>;
  effort_mappings?: Record<string, string>;
  priority: number;
  weight: number;
  auto_weight_enabled: boolean;
  enabled: boolean;
  extra_headers: Record<string, string>;
  timeout_seconds: number;
  rate_limit?: string | null;
  group_ids: number[];
}

/** 导出/导入的文档包装。kind 和 version 用于拒掉不相干的 JSON。 */
export interface ChannelExportDocument {
  kind: string;
  version: number;
  channels: ChannelExportItem[];
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  items: Array<{ name: string; action: string; message?: string }>;
}

/** 一条日志的四份快照。详情窗按页签逐份拉，正文可能被保留策略清空。 */
export type LogSnapshotField =
  | "downstream_request"
  | "upstream_request"
  | "upstream_response"
  | "downstream_response";

/** 额度状态。计数养在令牌行上，不从日志聚合——日志会被保留策略删掉。 */
export interface QuotaState {
  used_tokens: number;
  /** null 表示不限。 */
  limit_tokens: number | null;
  limit_expression: string;
  remaining_tokens: number | null;
  exhausted: boolean;
}

/** 看板概览。字段对着 internal/db/logoverview.go 的 json tag 写。 */
export interface LogOverview {
  range: string;
  range_label: string;
  total_requests: number;
  previous_total: number | null;
  error_requests: number;
  status_2xx: number;
  status_4xx: number;
  status_5xx: number;
  status_other: number;
  duration_count: number;
  avg_duration_ms: number;
  min_duration_ms: number;
  max_duration_ms: number;
  p50_duration_ms: number | null;
  p95_duration_ms: number | null;
  p99_duration_ms: number | null;
  bucket_seconds: number;
  latency_series: Array<{ bucket_epoch: number; avg_ms: number; count: number }>;
  request_series: Array<{ bucket_epoch: number; count: number }>;
}

/** Top 排行。模型和渠道各一组。 */
/** 排行项。数值字段就叫 count——请求榜是次数，Tokens 榜是 token 数。 */
export interface TopItem {
  name: string;
  count: number;
  /** 渠道榜按 upstream_id 分组时带上。 */
  id?: number;
  avg_duration_ms?: number;
  error_rate?: number;
}

/* 四个榜是四个独立数组，不是同一组数据换个字段排序。 */
export interface TopStats {
  window: string;
  models: TopItem[];
  channels: TopItem[];
  model_tokens: TopItem[];
  channel_tokens: TopItem[];
}

export interface TokenUsageWindow {
  total_tokens: number;
  prompt_tokens: number;
  prompt_cached_tokens: number;
  /** 只统计记录了 token 总量的请求。 */
  request_count: number;
  /** 全部请求，含报错和没有用量的。 */
  all_request_count: number;
}

/**
 * token-usage 接口的响应**总是嵌套的**，没有扁平形态。
 *
 * 选了具体时间窗时，服务端把该窗的聚合值塞进 today（不管问的是哪个窗）；
 * default 档才是五个窗各自有值。按扁平结构取 total_tokens 永远是 undefined。
 */
export interface TokenUsage {
  today: TokenUsageWindow;
  one_day: TokenUsageWindow;
  seven_days: TokenUsageWindow;
  thirty_days: TokenUsageWindow;
  all_time: TokenUsageWindow;
  range?: string;
  range_label?: string;
}

/** 运行时设置。revision 是乐观锁，保存时原样带回去。 */
export interface RuntimeSettings {
  log_body_keep_count: number;
  log_retention_days: number;
  log_body_max_bytes: number;
  max_retries: number;
  same_upstream_retry_interval_ms: number;
  auto_weight_failure_penalty: number;
  auto_weight_success_increment: number;
  auto_weight_recovery_increment: number;
  auto_weight_recovery_interval_seconds: number;
  proxy_enabled: boolean;
  proxy_url: string;
  /** 0 表示沿用启动配置（SystemInfo.default_upstream_timeout_seconds）。 */
  default_upstream_timeout_seconds: number;
  /** 生图结果另存为文件的目录上限，单位 MB。0 = 不保存并清空。 */
  image_storage_max_mb: number;
  revision: number;
  updated_at: string;
}

export interface PromptTemplate {
  id: number;
  name: string;
  prompt: string;
  created_at: string;
  updated_at: string;
}

/** 运行信息。只有服务状态与汇总计数，不含环境路径或秘密。 */
export interface SystemInfo {
  service: string;
  version: string;
  default_upstream_timeout_seconds: number;
  uptime_seconds: number;
  current_server_time: string;
  database_ok: boolean;
  database_allocated_bytes?: number | null;
  total_log_count: number;
  log_count_24h: number;
  enabled_upstream_count: number;
  total_upstream_count: number;
  recent_one_minute_log_count: number;
  runtime_metrics: {
    active_sse_streams: number;
    sse_client_disconnects_total: number;
    sse_recent_disconnects_10m: number;
    sse_upstream_errors_total: number;
    log_queue_depth: number;
    log_written_total: number;
    log_write_batches_total: number;
    log_dropped_total: number;
    log_write_failures_total: number;
    slow_db_operations_total: number;
    cleanup: {
      active: boolean;
      current_rows_cleared: number;
      current_batches: number;
      last_rows_cleared?: number;
      last_duration_ms?: number | null;
    };
  };
}

/**
 * 余额查询结果。
 *
 * 和模型测试一样，接口总是 200，成败看 ok。三个金额字段都可能为 null：
 * 有些渠道只报剩余，有些只报总额。
 */
export interface BalanceResult {
  ok: boolean;
  provider?: string;
  total_usd?: number | null;
  used_usd?: number | null;
  remaining_usd?: number | null;
  unit?: string;
  /** 以下四项只有 sub2api 会给。 */
  plan_name?: string | null;
  is_valid?: boolean;
  mode?: string | null;
  message?: string;
}

/**
 * 模型测试结果。
 *
 * 接口总是 200，成败看 ok。连不上上游时 status_code 为 null 且只有 message。
 */
export interface ModelTestResult {
  ok: boolean;
  status_code: number | null;
  content_type?: string | null;
  response_headers?: Record<string, string>;
  /** 后端解析后的实际 prompt——留空时它会去模板里取。 */
  prompt?: string;
  request?: { url: string; headers: Record<string, string>; body: unknown };
  /** 从响应里抽出的模型回复。抽不出就是空串。 */
  reply?: string;
  preview?: string;
  message?: string;
}

/** 分组。计数由后端给，不用前端聚合。 */
export interface Group {
  id: number;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  upstream_count: number;
  token_count: number;
  /** 默认分组不可删除也不可改名——令牌掉进空分组就什么渠道都访问不了。 */
  is_default: boolean;
}

export interface APIToken {
  id: number;
  name: string;
  description: string;
  /** 明文。开启明文保存之前创建的行是 ""，那些恢复不了。 */
  token: string;
  token_preview: string;
  enabled: boolean;
  /** null 表示永不过期。 */
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  group_id: number;
  group_name: string;
  quota: QuotaState;
  rate_limit: string | null;
  /** 空数组表示不限模型。结尾的 * 按前缀匹配。 */
  allowed_models: string[];
}
