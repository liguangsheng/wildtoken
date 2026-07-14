use super::{
    build_forward_headers, extract_first_token_ms, extract_usage, prepare_upstream_body,
    proxy_request, sse_bytes_line_is_terminal, validate_header_overrides,
};
use crate::{
    config::Settings,
    models::{
        settings::{AdminCredential, RuntimeSettings},
        upstream::UpstreamRow,
    },
    proxy::matcher::{AutoWeightManager, AutoWeightPolicy},
    state::{init_db, AdminAuthCache, AppState, RuntimeMetrics},
};
use axum::{
    body::to_bytes,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    routing::post,
    Json, Router,
};
use serde_json::json;
use sqlx::sqlite::SqlitePoolOptions;
use std::{
    collections::HashMap,
    sync::{atomic::AtomicI64, Arc},
    time::Instant,
};
use tokio::sync::RwLock;

fn upstream_with_headers(path_base: String, extra_headers: serde_json::Value) -> UpstreamRow {
    UpstreamRow {
        id: 1,
        name: "test-channel".into(),
        base_url: path_base,
        api_key: Some("upstream-secret".into()),
        model_names: "[]".into(),
        model_prefixes: "[]".into(),
        model_mappings: "{}".into(),
        priority: 100,
        weight: 100,
        auto_weight_enabled: 1,
        enabled: 1,
        extra_headers: extra_headers.to_string(),
        timeout_seconds: 30.0,
        created_at: "".into(),
        updated_at: "".into(),
    }
}

async fn test_state() -> AppState {
    let db = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    init_db(&db).await.unwrap();
    let runtime_metrics = Arc::new(RuntimeMetrics::new());
    let log_stats = Arc::new(crate::db::log_stats::LogStatsCache::empty());
    let log_writer = crate::proxy::logging::spawn_log_writer(
        db.clone(),
        runtime_metrics.clone(),
        log_stats.clone(),
        Settings::default().logging.log_queue_capacity,
    );
    AppState {
        db,
        http_client: reqwest::Client::new(),
        settings: Settings::default(),
        auto_weight: Arc::new(AutoWeightManager::new()),
        runtime_settings: Arc::new(RwLock::new(RuntimeSettings::default())),
        admin_credential: Arc::new(RwLock::new(AdminCredential {
            credential_hash: "test".into(),
            credential_version: 1,
        })),
        admin_credential_version: Arc::new(AtomicI64::new(1)),
        admin_auth_cache: Arc::new(AdminAuthCache::new()),
        runtime_metrics,
        log_writer,
        log_stats,
        started_at: Instant::now(),
    }
}

#[test]
fn streaming_chat_request_includes_usage_and_preserves_options() {
    let body = json!({
        "model": "requested-model",
        "stream": true,
        "stream_options": {"include_obfuscation": true}
    });

    let prepared = prepare_upstream_body(
        &serde_json::to_vec(&body).unwrap(),
        Some("upstream-model"),
        "chat/completions",
    );
    let prepared: serde_json::Value = serde_json::from_slice(&prepared).unwrap();

    assert_eq!(prepared["model"], "upstream-model");
    assert_eq!(prepared["stream_options"]["include_usage"], true);
    assert_eq!(prepared["stream_options"]["include_obfuscation"], true);
}

#[test]
fn usage_option_is_not_added_to_other_or_non_streaming_requests() {
    for (path, body) in [
        ("chat/completions", json!({"model": "m", "stream": false})),
        ("responses", json!({"model": "m", "stream": true})),
    ] {
        let prepared = prepare_upstream_body(&serde_json::to_vec(&body).unwrap(), None, path);
        let prepared: serde_json::Value = serde_json::from_slice(&prepared).unwrap();
        assert!(prepared.get("stream_options").is_none());
    }
}

#[test]
fn extracts_usage_from_codex_responses_completion_event() {
    let response = br#"data: {"type":"response.completed","response":{"usage":{"input_tokens":99424,"output_tokens":440,"total_tokens":99864}}}

"#;

    assert_eq!(
        extract_usage(response, "text/event-stream"),
        (Some(99424), Some(440), Some(99864))
    );
}

#[test]
fn recognizes_sse_protocol_terminal_events() {
    for line in [
        b"data: [DONE]".as_slice(),
        b"event: response.completed".as_slice(),
        b"data: {\"type\":\"response.failed\"}".as_slice(),
        b"event: message_stop".as_slice(),
        b"event: error".as_slice(),
    ] {
        assert!(sse_bytes_line_is_terminal(line));
    }

    assert!(!sse_bytes_line_is_terminal(
        b"event: response.output_item.done"
    ));
}

#[test]
fn anthropic_messages_uses_upstream_x_api_key_and_hides_downstream_key() {
    let mut downstream = HeaderMap::new();
    downstream.insert("x-api-key", HeaderValue::from_static("downstream-secret"));
    let upstream = upstream_with_headers("https://api.anthropic.com".into(), json!({}));

    let headers = build_forward_headers(&downstream, &upstream, "messages").unwrap();
    assert_eq!(
        headers.get("x-api-key"),
        Some(&"upstream-secret".to_string())
    );
    assert_eq!(
        headers.get("anthropic-version"),
        Some(&"2023-06-01".to_string())
    );
    assert!(!headers.contains_key("authorization"));
}

#[test]
fn channel_headers_override_downstream_and_generated_credentials_case_insensitively() {
    let mut downstream = HeaderMap::new();
    downstream.insert("user-agent", HeaderValue::from_static("downstream-agent"));
    downstream.insert("x-request-id", HeaderValue::from_static("request-123"));
    downstream.insert(
        "authorization",
        HeaderValue::from_static("downstream-secret"),
    );
    let upstream = upstream_with_headers(
        "https://example.test".into(),
        json!({
            "UsEr-AgEnT": "channel-agent",
            "AUTHORIZATION": "Token channel-credential",
            "X-Trace-Id": "channel-trace",
            "X-Upstream-Request": "{client_header:X-Request-Id}",
            "X-Missing": "{client_header:X-Not-Present}"
        }),
    );

    let headers = build_forward_headers(&downstream, &upstream, "responses").unwrap();

    assert_eq!(headers.get("user-agent"), Some(&"channel-agent".into()));
    assert_eq!(
        headers.get("authorization"),
        Some(&"Token channel-credential".into())
    );
    assert_eq!(headers.get("x-trace-id"), Some(&"channel-trace".into()));
    assert_eq!(
        headers.get("x-upstream-request"),
        Some(&"request-123".into())
    );
    assert!(!headers.contains_key("x-missing"));
    assert_eq!(
        headers
            .keys()
            .filter(|name| name.eq_ignore_ascii_case("authorization"))
            .count(),
        1
    );
}

#[test]
fn header_override_validation_rejects_ambiguous_or_transport_headers() {
    let duplicate = HashMap::from([
        ("Authorization".into(), "one".into()),
        ("authorization".into(), "two".into()),
    ]);
    assert!(validate_header_overrides(&duplicate)
        .unwrap_err()
        .contains("duplicate Header"));

    for overrides in [
        HashMap::from([("Host".into(), "example.test".into())]),
        HashMap::from([("Connection".into(), "keep-alive".into())]),
        HashMap::from([("X-Test".into(), "one\r\ntwo".into())]),
        HashMap::from([(
            "X-Test".into(),
            "prefix-{client_header:X-Request-Id}".into(),
        )]),
        HashMap::from([("X-Test".into(), "{client_header:Authorization}".into())]),
    ] {
        assert!(validate_header_overrides(&overrides).is_err());
    }
}

#[test]
fn connection_nominated_headers_are_not_forwarded_or_reintroduced() {
    let mut downstream = HeaderMap::new();
    downstream.insert("connection", HeaderValue::from_static("x-hop, keep-alive"));
    downstream.insert("x-hop", HeaderValue::from_static("downstream-value"));
    let upstream = upstream_with_headers(
        "https://example.test".into(),
        json!({
            "X-Hop": "channel-value",
            "X-Remapped-Hop": "{client_header:X-Hop}",
            "X-End-To-End": "kept"
        }),
    );

    let headers = build_forward_headers(&downstream, &upstream, "responses").unwrap();

    assert!(!headers.contains_key("connection"));
    assert!(!headers.contains_key("x-hop"));
    assert!(!headers.contains_key("x-remapped-hop"));
    assert_eq!(headers["x-end-to-end"], "kept");
}

#[tokio::test]
async fn anthropic_channel_overrides_reach_the_upstream_on_the_wire() {
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route(
        "/v1/messages",
        post(move |headers: HeaderMap| {
            let sent = sent.clone();
            async move {
                sent.send(headers).unwrap();
                Json(json!({"ok": true}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let state = test_state().await;
    let upstream = upstream_with_headers(
        format!("http://{address}"),
        json!({
            "X-API-Key": "overridden-upstream-key",
            "Anthropic-Version": "2025-01-01",
            "User-Agent": "channel-agent",
            "X-Client-Request": "{client_header:X-Request-Id}"
        }),
    );
    let mut downstream = HeaderMap::new();
    downstream.insert("x-api-key", HeaderValue::from_static("downstream-secret"));
    downstream.insert("user-agent", HeaderValue::from_static("downstream-agent"));
    downstream.insert("x-request-id", HeaderValue::from_static("request-456"));

    let result = proxy_request(
        &state,
        AutoWeightPolicy::from(&RuntimeSettings::default()),
        &upstream,
        1,
        "test-token",
        "test-client",
        None,
        "POST",
        "messages",
        None,
        &downstream,
        br#"{"model":"test"}"#,
    )
    .await
    .unwrap();
    assert_eq!(result.status, axum::http::StatusCode::OK);

    let headers = received.recv().await.unwrap();
    assert_eq!(headers["x-api-key"], "overridden-upstream-key");
    assert_eq!(headers["anthropic-version"], "2025-01-01");
    assert_eq!(headers["user-agent"], "channel-agent");
    assert_eq!(headers["x-client-request"], "request-456");
    assert_eq!(headers["accept-encoding"], "identity");
    assert!(headers.get("authorization").is_none());

    server.abort();
}

#[tokio::test]
async fn authentication_and_payment_responses_do_not_disable_the_channel() {
    let app = Router::new().route(
        "/v1/responses",
        post(|headers: HeaderMap| async move {
            let status = headers
                .get("x-test-status")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u16>().ok())
                .and_then(|value| StatusCode::from_u16(value).ok())
                .unwrap();
            let is_sse = headers.contains_key("x-test-sse");
            let content_type = if is_sse {
                "text/event-stream"
            } else {
                "application/json"
            };
            let body = if is_sse {
                "data: [DONE]\n\n"
            } else {
                r#"{"error":"test"}"#
            };
            (status, [(header::CONTENT_TYPE, content_type)], body)
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let state = test_state().await;
    sqlx::query(
        r#"INSERT INTO upstreams
            (id, name, base_url, model_names, enabled, timeout_seconds)
           VALUES (1, 'test-channel', ?, '[]', 1, 30)"#,
    )
    .bind(format!("http://{address}"))
    .execute(&state.db)
    .await
    .unwrap();
    let upstream = upstream_with_headers(format!("http://{address}"), json!({}));

    for (status, is_sse) in [(401, false), (402, false), (403, false), (401, true)] {
        let mut downstream = HeaderMap::new();
        downstream.insert(
            "x-test-status",
            HeaderValue::from_str(&status.to_string()).unwrap(),
        );
        if is_sse {
            downstream.insert("x-test-sse", HeaderValue::from_static("1"));
        }

        let result = proxy_request(
            &state,
            AutoWeightPolicy::from(&RuntimeSettings::default()),
            &upstream,
            1,
            "test-token",
            "test-client",
            None,
            "POST",
            "responses",
            None,
            &downstream,
            br#"{"model":"test"}"#,
        )
        .await
        .unwrap();
        assert_eq!(result.status.as_u16(), status);
        let _ = to_bytes(result.body, usize::MAX).await.unwrap();

        let enabled: i64 = sqlx::query_scalar("SELECT enabled FROM upstreams WHERE id = 1")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(enabled, 1, "status {status} must not disable the channel");
        assert_eq!(
            state
                .auto_weight
                .snapshot(
                    upstream.id,
                    upstream.weight,
                    true,
                    AutoWeightPolicy::from(&RuntimeSettings::default()),
                )
                .score,
            80
        );
        state.auto_weight.reset(upstream.id);
    }

    server.abort();
}

#[test]
fn anthropic_content_delta_counts_as_first_token() {
    let event = b"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n";
    assert_eq!(extract_first_token_ms(event), Some(0));
}

#[test]
fn responses_custom_tool_call_delta_counts_as_first_token() {
    let event =
        b"data: {\"type\":\"response.custom_tool_call_input.delta\",\"delta\":\"const\"}\n\n";
    assert_eq!(extract_first_token_ms(event), Some(0));
}
