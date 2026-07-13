use std::collections::{HashMap, HashSet};

use crate::{error::AppError, models::upstream::UpstreamRow};

/// Headers that must **not** be forwarded to the upstream.
pub const HOP_BY_HOP_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "transfer-encoding",
    "host",
    "content-length",
    "te",
    "trailer",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
    "x-wildtoken-upstream",
];

/// Credentials accepted from downstream clients but never forwarded as-is.
///
/// Keep these separate from `HOP_BY_HOP_HEADERS`: the selected channel may
/// legitimately inject or override `x-api-key` for an Anthropic upstream.
const DOWNSTREAM_CREDENTIAL_HEADERS: &[&str] = &["authorization", "x-api-key"];

/// Headers whose transport semantics cannot safely be controlled by a channel
/// override. `x-wildtoken-upstream` is internal routing metadata.
const NON_OVERRIDABLE_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "transfer-encoding",
    "host",
    "content-length",
    "te",
    "trailer",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
    "x-wildtoken-upstream",
];

const CLIENT_HEADER_PLACEHOLDER_PREFIX: &str = "{client_header:";

/// Headers whose values should be redacted in logging context.
pub const LOG_REDACTED_HEADERS: &[&str] = &[
    "authorization",
    "api-key",
    "x-api-key",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "proxy-authenticate",
    "x-admin-token",
    "x-auth-token",
    "x-access-token",
    "x-goog-api-key",
    "x-amz-security-token",
];

pub(crate) fn is_sensitive_header_name(name: &str) -> bool {
    if LOG_REDACTED_HEADERS
        .iter()
        .any(|header| name.eq_ignore_ascii_case(header))
    {
        return true;
    }

    name.to_ascii_lowercase().split(['-', '_']).any(|part| {
        matches!(
            part,
            "auth"
                | "authorization"
                | "apikey"
                | "credential"
                | "credentials"
                | "key"
                | "secret"
                | "signature"
                | "token"
                | "cookie"
        )
    })
}

fn parse_client_header_placeholder(value: &str) -> Result<Option<&str>, ()> {
    if let Some(rest) = value.strip_prefix(CLIENT_HEADER_PLACEHOLDER_PREFIX) {
        let source = rest.strip_suffix('}').filter(|source| !source.is_empty());
        return source.map(Some).ok_or(());
    }
    if value.contains(CLIENT_HEADER_PLACEHOLDER_PREFIX) {
        return Err(());
    }
    Ok(None)
}

fn connection_nominated_headers(headers: &axum::http::HeaderMap) -> HashSet<String> {
    headers
        .get_all(axum::http::header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

/// Validate a channel Header override map before it is persisted or used by an
/// admin preview request.
pub(crate) fn validate_header_overrides(overrides: &HashMap<String, String>) -> Result<(), String> {
    let mut normalized_names = HashSet::new();

    for (name, value) in overrides {
        let normalized = name.to_ascii_lowercase();
        if axum::http::HeaderName::from_bytes(name.as_bytes()).is_err() {
            return Err(format!("invalid Header name: {name}"));
        }
        match parse_client_header_placeholder(value) {
            Ok(Some(source)) => {
                let source_normalized = source.to_ascii_lowercase();
                if axum::http::HeaderName::from_bytes(source.as_bytes()).is_err() {
                    return Err(format!(
                        "invalid client Header placeholder for {name}: {source}"
                    ));
                }
                if DOWNSTREAM_CREDENTIAL_HEADERS.contains(&source_normalized.as_str()) {
                    return Err(format!(
                        "client credential Header {source} cannot be used in an override"
                    ));
                }
                if NON_OVERRIDABLE_HEADERS.contains(&source_normalized.as_str()) {
                    return Err(format!(
                        "client Header {source} cannot be used in an override"
                    ));
                }
            }
            Ok(None) => {
                if axum::http::HeaderValue::from_bytes(value.as_bytes()).is_err() {
                    return Err(format!("invalid value for Header {name}"));
                }
            }
            Err(()) => {
                return Err(format!(
                    "invalid client Header placeholder for {name}; it must occupy the whole value"
                ));
            }
        }
        if NON_OVERRIDABLE_HEADERS.contains(&normalized.as_str()) {
            return Err(format!("Header {name} cannot be overridden"));
        }
        if !normalized_names.insert(normalized) {
            return Err(format!(
                "duplicate Header name with different casing: {name}"
            ));
        }
    }

    Ok(())
}

/// Apply configured Header overrides last, using HTTP's case-insensitive name
/// semantics. Callers must validate user input before persisting it.
pub(crate) fn apply_header_overrides(
    headers: &mut HashMap<String, String>,
    overrides: &HashMap<String, String>,
    downstream_headers: Option<&axum::http::HeaderMap>,
) {
    let connection_nominated = downstream_headers
        .map(connection_nominated_headers)
        .unwrap_or_default();
    for (name, value) in overrides {
        let resolved = match parse_client_header_placeholder(value) {
            Ok(Some(source)) if !connection_nominated.contains(&source.to_ascii_lowercase()) => {
                downstream_headers
                    .and_then(|downstream| downstream.get(source))
                    .and_then(|value| value.to_str().ok())
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_owned)
            }
            Ok(Some(_)) => None,
            Ok(None) => Some(value.clone()),
            Err(()) => None,
        };
        if let Some(resolved) = resolved {
            headers.insert(name.to_ascii_lowercase(), resolved);
        }
    }
}

/// Build forward headers: filter hop-by-hop, inject api_key, merge extra_headers.
///
/// Header names are normalized to lowercase so we never emit case-duplicate keys
/// (e.g. both `Authorization` and `authorization`), which many reverse proxies
/// reject with a raw HTTP 400 HTML page.
///
/// The downstream client's `Authorization` is intentionally dropped; we inject
/// the upstream key under a single lowercase `authorization` name.
pub fn build_forward_headers(
    downstream_headers: &axum::http::HeaderMap,
    upstream: &UpstreamRow,
    path: &str,
) -> Result<HashMap<String, String>, AppError> {
    let mut out = HashMap::new();
    let connection_nominated = connection_nominated_headers(downstream_headers);

    for (name, value) in downstream_headers.iter() {
        let name_lower = name.as_str().to_lowercase();
        if HOP_BY_HOP_HEADERS.contains(&name_lower.as_str())
            || connection_nominated.contains(&name_lower)
        {
            continue;
        }
        // Never forward the client's credentials; replace them below from the
        // selected channel configuration.
        if DOWNSTREAM_CREDENTIAL_HEADERS.contains(&name_lower.as_str()) {
            continue;
        }
        if let Ok(v) = value.to_str() {
            out.insert(name_lower, v.to_string());
        }
    }

    // Prefer uncompressed responses so we can log usage from body text.
    out.insert("accept-encoding".into(), "identity".into());

    let is_anthropic_messages = path.trim_matches('/') == "messages";

    // Always replace downstream credentials with the selected upstream key.
    if let Some(ref key) = upstream.api_key {
        if !key.is_empty() {
            if is_anthropic_messages {
                out.insert("x-api-key".into(), key.to_string());
                // All supported Anthropic Messages API versions use this value.
                // A configured extra header below can explicitly override it.
                out.entry("anthropic-version".into())
                    .or_insert_with(|| "2023-06-01".into());
            } else {
                out.insert("authorization".into(), format!("Bearer {key}"));
            }
        }
    }

    // Merge extra_headers last so they can override (normalize keys too).
    let extra = serde_json::from_str::<HashMap<String, String>>(&upstream.extra_headers).map_err(
        |error| {
            AppError::UpstreamError(format!(
                "channel {} has invalid Header override JSON: {error}",
                upstream.name
            ))
        },
    )?;
    validate_header_overrides(&extra).map_err(|message| {
        AppError::UpstreamError(format!(
            "channel {} has an invalid Header override: {message}",
            upstream.name
        ))
    })?;
    apply_header_overrides(&mut out, &extra, Some(downstream_headers));

    // A channel override must not reintroduce a field explicitly nominated by
    // the downstream Connection header as hop-by-hop.
    for name in connection_nominated {
        out.remove(&name);
    }

    Ok(out)
}
