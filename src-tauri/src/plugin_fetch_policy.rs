use base64::{engine::general_purpose, Engine as _};
use futures::future::{AbortHandle, Abortable};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, LOCATION};
use reqwest::{Method, StatusCode};
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::str::FromStr;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;
use url::{Host, Url};

const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const MAX_RESPONSE_HEADER_BYTES: usize = 128 * 1024;
const MAX_REDIRECTS: usize = 5;
const MAX_PENDING_CANCELLATIONS: usize = 1024;
const PENDING_CANCELLATION_TTL: Duration = Duration::from_secs(60);
const HOST_OWNED_NETWORK_HOSTS: [&str; 3] = ["risuai.xyz", "risuai.net", "sionyw.com"];

#[derive(Default)]
struct PluginFetchCancellationState {
    active_aborts: HashMap<String, AbortHandle>,
    pending_cancellations: HashMap<String, Instant>,
}

#[derive(Default)]
pub struct PluginFetchState {
    cancellations: Mutex<PluginFetchCancellationState>,
}

enum FetchRegistration {
    Registered,
    Cancelled,
    Conflict,
}

fn prune_pending_cancellations(state: &mut PluginFetchCancellationState, now: Instant) {
    state.pending_cancellations.retain(|_, registered_at| {
        now.checked_duration_since(*registered_at).unwrap_or_default() <= PENDING_CANCELLATION_TTL
    });
}

fn register_or_consume_pending_cancel(
    state: &mut PluginFetchCancellationState,
    request_id: &str,
    abort: AbortHandle,
    now: Instant,
) -> FetchRegistration {
    prune_pending_cancellations(state, now);
    if state.pending_cancellations.remove(request_id).is_some() {
        return FetchRegistration::Cancelled;
    }
    if state.active_aborts.contains_key(request_id) {
        return FetchRegistration::Conflict;
    }
    state.active_aborts.insert(request_id.to_string(), abort);
    FetchRegistration::Registered
}

fn record_cancellation(state: &mut PluginFetchCancellationState, request_id: String, now: Instant) {
    prune_pending_cancellations(state, now);
    if let Some(abort) = state.active_aborts.remove(&request_id) {
        abort.abort();
        return;
    }
    if !state.pending_cancellations.contains_key(&request_id)
        && state.pending_cancellations.len() >= MAX_PENDING_CANCELLATIONS
    {
        if let Some(oldest) = state.pending_cancellations.iter()
            .min_by_key(|(_, registered_at)| **registered_at)
            .map(|(id, _)| id.clone())
        {
            state.pending_cancellations.remove(&oldest);
        }
    }
    state.pending_cancellations.insert(request_id, now);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginFetchRequest {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body_base64: Option<String>,
    allowed_origins: Option<Vec<String>>,
    #[serde(default)]
    secret_header_names: Vec<String>,
    max_redirects: usize,
    max_response_bytes: Option<usize>,
}

fn rejected() -> String { "Plugin fetch destination rejected".to_string() }

fn url_hostname(url: &Url) -> Result<String, String> {
    match url.host().ok_or_else(rejected)? {
        Host::Domain(domain) => Ok(domain.to_string()),
        Host::Ipv4(address) => Ok(address.to_string()),
        Host::Ipv6(address) => Ok(address.to_string()),
    }
}

fn is_forbidden_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    a == 0 || a == 10 || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && (b == 0 || b == 168 || (b == 88 && c == 99)))
        || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
        || (a == 203 && b == 0 && c == 113)
        || a >= 224
}

fn is_forbidden_ipv6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    let well_known_nat64 = segments[0] == 0x0064 && segments[1] == 0xff9b
        && segments[2..6].iter().all(|segment| *segment == 0);
    let embedded_ipv4 = Ipv4Addr::new(
        (segments[6] >> 8) as u8,
        (segments[6] & 0xff) as u8,
        (segments[7] >> 8) as u8,
        (segments[7] & 0xff) as u8,
    );
    address.is_unspecified()
        || address.is_loopback()
        || address.is_multicast()
        || (segments[..5].iter().all(|segment| *segment == 0) && segments[5] == 0xffff)
        || segments[..6].iter().all(|segment| *segment == 0)
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xffc0) == 0xfec0
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || (segments[0] == 0x0100 && segments[1..4].iter().all(|segment| *segment == 0))
        || (segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0010)
        || (segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2] == 0x0001)
        || (well_known_nat64 && is_forbidden_ipv4(embedded_ipv4))
}

fn is_forbidden_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ipv4) => is_forbidden_ipv4(ipv4),
        IpAddr::V6(ipv6) => is_forbidden_ipv6(ipv6),
    }
}

fn canonical_public_https_url(input: &str) -> Result<Url, String> {
    if input.is_empty() || input.chars().any(|character| character == '\r' || character == '\n') { return Err(rejected()); }
    let mut url = Url::parse(input).map_err(|_| rejected())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(rejected());
    }
    let raw_hostname = url_hostname(&url)?;
    let hostname = raw_hostname.trim_end_matches('.').to_string();
    if hostname.is_empty() { return Err(rejected()); }
    let special_use = hostname == "localhost" || hostname.ends_with(".localhost")
        || hostname == "local" || hostname.ends_with(".local")
        || hostname == "home.arpa" || hostname.ends_with(".home.arpa");
    let host_owned = HOST_OWNED_NETWORK_HOSTS.iter()
        .any(|blocked| hostname == *blocked || hostname.ends_with(&format!(".{blocked}")));
    if special_use || host_owned { return Err(rejected()); }
    if hostname.contains('*') { return Err(rejected()); }
    if hostname != raw_hostname { url.set_host(Some(&hostname)).map_err(|_| rejected())?; }
    if let Ok(address) = IpAddr::from_str(&hostname) {
        if is_forbidden_ip(address) { return Err(rejected()); }
    }
    Ok(url)
}

fn validate_dns_answers(addresses: &[IpAddr]) -> Result<IpAddr, String> {
    if addresses.is_empty() || addresses.iter().any(|address| is_forbidden_ip(*address)) {
        return Err(rejected());
    }
    Ok(addresses[0])
}

fn check_redirect_count(current: usize, maximum: usize) -> Result<(), String> {
    if current >= maximum { Err("Plugin fetch redirect limit exceeded".to_string()) } else { Ok(()) }
}

fn canonical_allowed_origins(input: Option<Vec<String>>) -> Result<Option<HashSet<String>>, String> {
    let Some(origins) = input else { return Ok(None); };
    if origins.is_empty() { return Err("Plugin fetch origin policy rejected".to_string()); }
    let mut canonical = HashSet::new();
    for origin in origins {
        let parsed = canonical_public_https_url(&origin)?;
        if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some()
            || parsed.origin().ascii_serialization() != origin
        {
            return Err("Plugin fetch origin policy rejected".to_string());
        }
        if !canonical.insert(origin) { return Err("Plugin fetch origin policy rejected".to_string()); }
    }
    Ok(Some(canonical))
}

fn build_headers(entries: Vec<(String, String)>) -> Result<HeaderMap, String> {
    let forbidden = [
        "accept-charset", "accept-encoding", "access-control-request-headers",
        "access-control-request-method", "connection", "content-length", "cookie",
        "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin",
        "permissions-policy", "proxy-authorization", "proxy-connection", "referer",
        "set-cookie", "te", "trailer", "transfer-encoding", "upgrade", "via",
    ];
    let mut headers = HeaderMap::new();
    for (name, value) in entries {
        if value.chars().any(|character| character == '\r' || character == '\n') { return Err("Plugin fetch headers rejected".to_string()); }
        let normalized = name.to_ascii_lowercase();
        if forbidden.contains(&normalized.as_str()) || normalized.starts_with("sec-") {
            return Err("Plugin fetch headers rejected".to_string());
        }
        let header_name = HeaderName::from_bytes(normalized.as_bytes()).map_err(|_| "Plugin fetch headers rejected".to_string())?;
        let header_value = HeaderValue::from_str(&value).map_err(|_| "Plugin fetch headers rejected".to_string())?;
        headers.append(header_name, header_value);
    }
    Ok(headers)
}

async fn execute_policy_fetch(request: PluginFetchRequest) -> Result<serde_json::Value, String> {
    if request.max_redirects > MAX_REDIRECTS { return Err("Plugin fetch redirect policy rejected".to_string()); }
    let max_response_bytes = request.max_response_bytes.unwrap_or(MAX_RESPONSE_BYTES).min(MAX_RESPONSE_BYTES);
    let allowed_origins = canonical_allowed_origins(request.allowed_origins)?;
    let secret_header_names = request.secret_header_names.into_iter().map(|name| name.to_ascii_lowercase()).collect::<HashSet<_>>();
    let mut current = canonical_public_https_url(&request.url)?;
    let mut method = Method::from_bytes(request.method.to_ascii_uppercase().as_bytes())
        .map_err(|_| "Plugin fetch method rejected".to_string())?;
    if ![Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::PATCH, Method::HEAD].contains(&method) {
        return Err("Plugin fetch method rejected".to_string());
    }
    let mut headers = build_headers(request.headers)?;
    let mut body = match request.body_base64 {
        Some(encoded) => {
            if encoded.len() > 90 * 1024 * 1024 { return Err("Plugin fetch body rejected".to_string()); }
            let decoded = general_purpose::STANDARD.decode(encoded).map_err(|_| "Plugin fetch body rejected".to_string())?;
            if decoded.len() > MAX_BODY_BYTES { return Err("Plugin fetch body rejected".to_string()); }
            Some(decoded)
        }
        None => None,
    };
    let mut redirects = 0usize;

    loop {
        let origin = current.origin().ascii_serialization();
        if allowed_origins.as_ref().is_some_and(|allowed| !allowed.contains(&origin)) {
            return Err("Plugin fetch redirect origin rejected".to_string());
        }
        let hostname = url_hostname(&current)?;
        let port = current.port_or_known_default().ok_or_else(rejected)?;
        let addresses = tokio::net::lookup_host((hostname.as_str(), port)).await
            .map_err(|_| "Plugin fetch destination resolution failed".to_string())?
            .map(|socket| socket.ip()).collect::<Vec<_>>();
        let pinned = validate_dns_answers(&addresses)?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .resolve(&hostname, SocketAddr::new(pinned, port))
            .build().map_err(|_| "Plugin fetch network failure".to_string())?;
        let mut builder = client.request(method.clone(), current.clone()).headers(headers.clone())
            .timeout(Duration::from_secs(240));
        if let Some(bytes) = body.as_ref() { builder = builder.body(bytes.clone()); }
        let mut response = builder.send().await.map_err(|_| "Plugin fetch network failure".to_string())?;
        let status = response.status();
        if matches!(status, StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND | StatusCode::SEE_OTHER | StatusCode::TEMPORARY_REDIRECT | StatusCode::PERMANENT_REDIRECT) {
            check_redirect_count(redirects, request.max_redirects)?;
            let location = response.headers().get(LOCATION).and_then(|value| value.to_str().ok())
                .ok_or_else(|| "Plugin fetch redirect omitted Location".to_string())?;
            let next = canonical_public_https_url(current.join(location).map_err(|_| rejected())?.as_str())?;
            let next_origin = next.origin().ascii_serialization();
            if allowed_origins.as_ref().is_some_and(|allowed| !allowed.contains(&next_origin)) {
                return Err("Plugin fetch redirect origin rejected".to_string());
            }
            if next_origin != origin {
                for credential in ["authorization", "proxy-authorization", "cookie", "x-api-key"] {
                    if !secret_header_names.contains(credential) { headers.remove(credential); }
                }
            }
            if status == StatusCode::SEE_OTHER
                || ((status == StatusCode::MOVED_PERMANENTLY || status == StatusCode::FOUND) && method == Method::POST)
            {
                method = Method::GET;
                body = None;
                headers.remove("content-type");
                headers.remove("content-length");
            }
            current = next;
            redirects += 1;
            continue;
        }

        if response.content_length().is_some_and(|length| length > max_response_bytes as u64) {
            return Err("Plugin fetch response limit exceeded".to_string());
        }
        let mut response_headers = serde_json::Map::new();
        let mut response_header_bytes = 0usize;
        for (name, value) in response.headers() {
            let Ok(value) = value.to_str() else { continue; };
            response_header_bytes = response_header_bytes.saturating_add(name.as_str().len() + value.len());
            if response_header_bytes > MAX_RESPONSE_HEADER_BYTES { return Err("Plugin fetch response headers rejected".to_string()); }
            response_headers.insert(name.as_str().to_string(), json!(value));
        }
        let mut result = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "Plugin fetch response failed".to_string())? {
            if result.len().saturating_add(chunk.len()) > max_response_bytes {
                return Err("Plugin fetch response limit exceeded".to_string());
            }
            result.extend_from_slice(&chunk);
        }
        return Ok(json!({
            "success": true,
            "status": status.as_u16(),
            "headers": response_headers,
            "bodyBase64": general_purpose::STANDARD.encode(result),
        }));
    }
}

#[tauri::command]
pub async fn plugin_policy_fetch(
    request_id: String,
    request_json: String,
    state: State<'_, PluginFetchState>,
) -> String {
    if request_id.is_empty() || request_id.len() > 128 || request_id.chars().any(|character| character == '\r' || character == '\n') {
        return json!({ "success": false, "error": "invalid-request" }).to_string();
    }
    let request = match serde_json::from_str::<PluginFetchRequest>(&request_json) {
        Ok(request) => request,
        Err(_) => return json!({ "success": false, "error": "invalid-request" }).to_string(),
    };
    let (abort, registration) = AbortHandle::new_pair();
    {
        let Ok(mut cancellations) = state.cancellations.lock() else {
            return json!({ "success": false, "error": "unavailable" }).to_string();
        };
        match register_or_consume_pending_cancel(&mut cancellations, &request_id, abort, Instant::now()) {
            FetchRegistration::Registered => {}
            FetchRegistration::Cancelled => {
                return json!({ "success": false, "error": "aborted" }).to_string();
            }
            FetchRegistration::Conflict => {
                return json!({ "success": false, "error": "conflict" }).to_string();
            }
        }
    }
    let result = Abortable::new(execute_policy_fetch(request), registration).await;
    if let Ok(mut cancellations) = state.cancellations.lock() {
        cancellations.active_aborts.remove(&request_id);
    }
    match result {
        Ok(Ok(value)) => value.to_string(),
        Ok(Err(_)) => json!({ "success": false, "error": "network" }).to_string(),
        Err(_) => json!({ "success": false, "error": "aborted" }).to_string(),
    }
}

#[tauri::command]
pub fn cancel_plugin_policy_fetch(request_id: String, state: State<'_, PluginFetchState>) -> bool {
    if request_id.is_empty() || request_id.len() > 128
        || request_id.chars().any(|character| character == '\r' || character == '\n')
    {
        return false;
    }
    let Ok(mut cancellations) = state.cancellations.lock() else { return false; };
    record_cancellation(&mut cancellations, request_id, Instant::now());
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    #[test]
    fn rejects_private_reserved_multicast_and_mapped_addresses() {
        for address in [
            "127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.1.1", "172.16.0.1",
            "192.168.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
            "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fe80::1",
            "ff00::1", "2001:db8::1", "::127.0.0.1", "::ffff:8.8.8.8",
            "fec0::1", "64:ff9b:1::8.8.8.8", "64:ff9b:1::127.0.0.1",
            "64:ff9b::127.0.0.1",
        ] {
            assert!(is_forbidden_ip(address.parse::<IpAddr>().unwrap()), "{address}");
        }
        assert!(!is_forbidden_ip("8.8.8.8".parse().unwrap()));
        assert!(!is_forbidden_ip("2606:4700:4700::1111".parse().unwrap()));
        assert!(!is_forbidden_ip("64:ff9b::8.8.8.8".parse().unwrap()));
        assert!(!is_forbidden_ip("64:ff9b:2::8.8.8.8".parse().unwrap()));
        for address in ["192.88.98.1", "198.51.101.1", "203.0.114.1"] {
            assert!(!is_forbidden_ip(address.parse().unwrap()), "{address}");
        }
    }

    #[test]
    fn canonicalizes_public_https_and_rejects_unsafe_destinations() {
        assert_eq!(canonical_public_https_url("https://BÜCHER.example:443/path").unwrap().origin().ascii_serialization(), "https://xn--bcher-kva.example");
        assert_eq!(canonical_public_https_url("https://0x08080808/path").unwrap().host_str(), Some("8.8.8.8"));
        assert_eq!(canonical_public_https_url("https://EXAMPLE.com.:443/path").unwrap().origin().ascii_serialization(), "https://example.com");
        assert!(canonical_public_https_url("https://[2606:4700:4700::1111]/path").is_ok());
        for unsafe_url in [
            "http://example.com", "file:///tmp/x", "data:text/plain,x", "blob:https://example.com/x",
            "https://user:pass@example.com", "https://127.1", "https://[::127.0.0.1]", "https://[::ffff:8.8.8.8]",
            "https://[fec0::1]", "https://[64:ff9b:1::8.8.8.8]", "https://[64:ff9b:1::127.0.0.1]",
            "https://[64:ff9b::127.0.0.1]",
            "https://localhost", "https://sub.localhost", "https://printer.local", "https://home.arpa",
            "https://risuai.xyz/api", "https://api.risuai.net", "https://sionyw.com/",
        ] {
            assert!(canonical_public_https_url(unsafe_url).is_err(), "{unsafe_url}");
        }
    }

    #[test]
    fn rejects_any_forbidden_dns_answer_and_redirect_six() {
        assert!(validate_dns_answers(&[
            "8.8.8.8".parse().unwrap(), "127.0.0.1".parse().unwrap(),
        ]).is_err());
        assert_eq!(validate_dns_answers(&[
            "8.8.8.8".parse().unwrap(), "1.1.1.1".parse().unwrap(),
        ]).unwrap(), "8.8.8.8".parse::<IpAddr>().unwrap());
        assert!(check_redirect_count(4, 5).is_ok());
        assert!(check_redirect_count(5, 5).is_err());
    }

    #[test]
    fn rejects_caller_controlled_routing_and_framing_headers() {
        assert!(build_headers(vec![("host".to_string(), "internal.example".to_string())]).is_err());
        assert!(build_headers(vec![("content-length".to_string(), "1".to_string())]).is_err());
    }

    #[test]
    fn consumes_a_cancel_that_arrives_before_registration() {
        let now = Instant::now();
        let mut state = PluginFetchCancellationState::default();
        record_cancellation(&mut state, "early".to_string(), now);
        let (abort, _registration) = AbortHandle::new_pair();
        assert!(matches!(
            register_or_consume_pending_cancel(&mut state, "early", abort, now),
            FetchRegistration::Cancelled,
        ));
        assert!(state.pending_cancellations.is_empty());
        assert!(state.active_aborts.is_empty());
    }

    #[test]
    fn bounds_and_expires_pending_cancellations() {
        let now = Instant::now();
        let mut state = PluginFetchCancellationState::default();
        for index in 0..=MAX_PENDING_CANCELLATIONS {
            record_cancellation(
                &mut state,
                format!("pending-{index}"),
                now + Duration::from_nanos(index as u64),
            );
        }
        assert_eq!(state.pending_cancellations.len(), MAX_PENDING_CANCELLATIONS);
        assert!(!state.pending_cancellations.contains_key("pending-0"));
        prune_pending_cancellations(&mut state, now + PENDING_CANCELLATION_TTL + Duration::from_secs(1));
        assert!(state.pending_cancellations.is_empty());
    }
}
