use futures::future::{AbortHandle, AbortRegistration, Abortable};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Response, StatusCode};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::str::FromStr;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;
use url::Url;
use uuid::Uuid;

const MODEL_ARTIFACT_MAX_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_HEADER_BYTES: usize = 128 * 1024;
const MAX_HEADER_VALUE_BYTES: usize = 4096;
const MAX_LIVE_HANDLES: usize = 8;
const MAX_PENDING_CANCELLATIONS: usize = 1024;
const PENDING_CANCELLATION_TTL: Duration = Duration::from_secs(60);
const HANDLE_IDLE_TTL: Duration = Duration::from_secs(60);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(240);
const XET_HOST: &str = "us.aws.cdn.hf.co";
const XET_PATH_PREFIX: &str = "/xet-bridge-us/";

const REGISTERED_ARTIFACTS: &[(&str, u64)] = &[
    (
        "https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/model.onnx",
        1_271_365_854,
    ),
    (
        "https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/selected_tags.csv",
        596_868,
    ),
    (
        "https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/preprocess.json",
        557,
    ),
];

const XET_QUERY_KEYS: &[&str] = &[
    "Expires",
    "Key-Pair-Id",
    "Policy",
    "Signature",
    "X-Amz-Algorithm",
    "X-Amz-Credential",
    "X-Amz-Date",
    "X-Amz-Expires",
    "X-Amz-Security-Token",
    "X-Amz-Signature",
    "X-Amz-SignedHeaders",
    "X-Xet-Cas-Uid",
    "response-content-disposition",
    "response-content-type",
    "x-id",
];

fn rejected() -> String {
    "Model artifact request rejected".to_string()
}

fn network_failed() -> String {
    "Model artifact network request failed".to_string()
}

#[derive(Debug, PartialEq, Eq)]
enum ArtifactUrlKind {
    Initial,
    Xet,
}

fn raw_authority(value: &str) -> Result<&str, String> {
    let remainder = value.strip_prefix("https://").ok_or_else(rejected)?;
    let end = remainder
        .find(|character| matches!(character, '/' | '?' | '#'))
        .unwrap_or(remainder.len());
    if end == 0 {
        return Err(rejected());
    }
    Ok(&remainder[..end])
}

fn decode_percent_once(value: &str) -> Result<String, String> {
    fn hex(value: u8) -> Option<u8> {
        match value {
            b'0'..=b'9' => Some(value - b'0'),
            b'a'..=b'f' => Some(value - b'a' + 10),
            b'A'..=b'F' => Some(value - b'A' + 10),
            _ => None,
        }
    }

    let source = value.as_bytes();
    let mut decoded = Vec::with_capacity(source.len());
    let mut index = 0;
    while index < source.len() {
        if source[index] == b'%' {
            if index + 2 >= source.len() {
                return Err(rejected());
            }
            let high = hex(source[index + 1]).ok_or_else(rejected)?;
            let low = hex(source[index + 2]).ok_or_else(rejected)?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(source[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| rejected())
}

fn has_path_traversal(value: &str) -> Result<bool, String> {
    let remainder = value.strip_prefix("https://").ok_or_else(rejected)?;
    let path_start = remainder.find('/').unwrap_or(remainder.len());
    let remainder = &remainder[path_start..];
    let path_end = remainder
        .find(|character| matches!(character, '?' | '#'))
        .unwrap_or(remainder.len());
    let path = &remainder[..path_end];
    if path.contains('\\') || path.to_ascii_lowercase().contains("%5c") {
        return Ok(true);
    }
    for segment in path.split('/') {
        let mut decoded = segment.to_string();
        for _ in 0..2 {
            decoded = decode_percent_once(&decoded)?;
            if decoded == "."
                || decoded == ".."
                || decoded.contains('/')
                || decoded.contains('\\')
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn validate_artifact_url(value: &str, max_bytes: u64) -> Result<ArtifactUrlKind, String> {
    if value.is_empty()
        || value.contains('\r')
        || value.contains('\n')
        || max_bytes == 0
        || has_path_traversal(value)?
    {
        return Err(rejected());
    }
    if let Some((_, registered_bytes)) = REGISTERED_ARTIFACTS
        .iter()
        .find(|(registered_url, _)| *registered_url == value)
    {
        return if *registered_bytes == max_bytes {
            Ok(ArtifactUrlKind::Initial)
        } else {
            Err(rejected())
        };
    }
    if !REGISTERED_ARTIFACTS
        .iter()
        .any(|(_, registered_bytes)| *registered_bytes == max_bytes)
    {
        return Err(rejected());
    }

    let parsed = Url::parse(value).map_err(|_| rejected())?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || parsed.as_str() != value
        || raw_authority(value)?.contains(':')
        || parsed.host_str() != Some(XET_HOST)
        || parsed.port().is_some()
        || !parsed.path().starts_with(XET_PATH_PREFIX)
        || parsed.path().len() == XET_PATH_PREFIX.len()
    {
        return Err(rejected());
    }
    let mut seen = HashSet::new();
    for (key, query_value) in parsed.query_pairs() {
        if !XET_QUERY_KEYS.contains(&key.as_ref())
            || query_value.is_empty()
            || !seen.insert(key.into_owned())
        {
            return Err(rejected());
        }
    }
    Ok(ArtifactUrlKind::Xet)
}

struct ValidatedRequestHeaders {
    headers: HeaderMap,
    range_offset: Option<u64>,
}

fn validate_request_headers(
    entries: Vec<(String, String)>,
    max_bytes: u64,
) -> Result<ValidatedRequestHeaders, String> {
    if entries.len() > 2 {
        return Err(rejected());
    }
    let mut headers = HeaderMap::new();
    let mut seen = HashSet::new();
    let mut range_offset = None;
    for (raw_name, value) in entries {
        let normalized = raw_name.to_ascii_lowercase();
        if (normalized != "range" && normalized != "if-range")
            || !seen.insert(normalized.clone())
            || value.is_empty()
            || value.len() > MAX_HEADER_VALUE_BYTES
            || value.contains('\r')
            || value.contains('\n')
        {
            return Err(rejected());
        }
        if normalized == "range" {
            let offset_text = value
                .strip_prefix("bytes=")
                .and_then(|rest| rest.strip_suffix('-'))
                .ok_or_else(rejected)?;
            if offset_text.is_empty()
                || !offset_text.bytes().all(|byte| byte.is_ascii_digit())
                || (offset_text.len() > 1 && offset_text.starts_with('0'))
            {
                return Err(rejected());
            }
            let offset = offset_text.parse::<u64>().map_err(|_| rejected())?;
            if offset >= max_bytes {
                return Err(rejected());
            }
            range_offset = Some(offset);
        }
        let name = HeaderName::from_bytes(normalized.as_bytes()).map_err(|_| rejected())?;
        let value = HeaderValue::from_str(&value).map_err(|_| rejected())?;
        headers.insert(name, value);
    }
    Ok(ValidatedRequestHeaders {
        headers,
        range_offset,
    })
}

fn is_forbidden_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    a == 0
        || a == 10
        || a == 127
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
    let well_known_nat64 = segments[0] == 0x0064
        && segments[1] == 0xff9b
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
        IpAddr::V4(address) => is_forbidden_ipv4(address),
        IpAddr::V6(address) => is_forbidden_ipv6(address),
    }
}

fn validate_dns_answers(addresses: &[SocketAddr]) -> Result<Vec<SocketAddr>, String> {
    if addresses.is_empty() || addresses.iter().any(|address| is_forbidden_ip(address.ip())) {
        return Err(rejected());
    }
    let mut seen = HashSet::new();
    let pinned = addresses
        .iter()
        .copied()
        .filter(|address| seen.insert(*address))
        .collect::<Vec<_>>();
    if pinned.is_empty() {
        Err(rejected())
    } else {
        Ok(pinned)
    }
}

struct ArtifactClientPolicy {
    disable_proxy: bool,
    follow_redirects: bool,
}

const ARTIFACT_CLIENT_POLICY: ArtifactClientPolicy = ArtifactClientPolicy {
    disable_proxy: true,
    follow_redirects: false,
};

fn build_pinned_client(hostname: &str, addresses: &[SocketAddr]) -> Result<reqwest::Client, String> {
    let pinned = validate_dns_answers(addresses)?;
    let mut builder = reqwest::Client::builder();
    if ARTIFACT_CLIENT_POLICY.disable_proxy {
        builder = builder.no_proxy();
    }
    if !ARTIFACT_CLIENT_POLICY.follow_redirects {
        builder = builder.redirect(reqwest::redirect::Policy::none());
    }
    builder
        .resolve_to_addrs(hostname, &pinned)
        .build()
        .map_err(|_| network_failed())
}

fn project_response_headers(response: &Response) -> Result<Vec<(String, String)>, String> {
    let mut total_bytes = 0usize;
    for (name, value) in response.headers() {
        total_bytes = total_bytes
            .checked_add(name.as_str().len())
            .and_then(|total| total.checked_add(value.as_bytes().len()))
            .ok_or_else(rejected)?;
        if total_bytes > MAX_RESPONSE_HEADER_BYTES {
            return Err(rejected());
        }
    }

    let mut projected = Vec::new();
    for (raw_name, output_name) in [
        ("location", "Location"),
        ("etag", "ETag"),
        ("content-range", "Content-Range"),
        ("content-length", "Content-Length"),
    ] {
        let values = response.headers().get_all(raw_name);
        let mut values = values.iter();
        let Some(value) = values.next() else {
            continue;
        };
        if values.next().is_some() {
            return Err(rejected());
        }
        let value = value.to_str().map_err(|_| rejected())?;
        if value.is_empty()
            || value.len() > MAX_HEADER_VALUE_BYTES
            || value.contains('\r')
            || value.contains('\n')
        {
            return Err(rejected());
        }
        projected.push((output_name.to_string(), value.to_string()));
    }
    Ok(projected)
}

struct NetworkOpenResult {
    status: u16,
    headers: Vec<(String, String)>,
    response: Option<Response>,
    remaining_network_bytes: u64,
}

async fn execute_open(
    url: Url,
    headers: HeaderMap,
    range_offset: Option<u64>,
    max_bytes: u64,
) -> Result<NetworkOpenResult, String> {
    let hostname = url.host_str().ok_or_else(rejected)?.to_string();
    let addresses = tokio::net::lookup_host((hostname.as_str(), 443))
        .await
        .map_err(|_| network_failed())?
        .collect::<Vec<_>>();
    let client = build_pinned_client(&hostname, &addresses)?;
    let response = client
        .get(url)
        .headers(headers)
        .timeout(NETWORK_TIMEOUT)
        .send()
        .await
        .map_err(|_| network_failed())?;
    let status = response.status();
    let projected = project_response_headers(&response)?;
    if matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    ) {
        let location = projected
            .iter()
            .find(|(name, _)| name == "Location")
            .map(|(_, value)| value.as_str())
            .ok_or_else(rejected)?;
        if validate_artifact_url(location, max_bytes)? != ArtifactUrlKind::Xet {
            return Err(rejected());
        }
        return Ok(NetworkOpenResult {
            status: status.as_u16(),
            headers: projected,
            response: None,
            remaining_network_bytes: 0,
        });
    }
    if status != StatusCode::OK && status != StatusCode::PARTIAL_CONTENT {
        return Err(network_failed());
    }
    let remaining_network_bytes = if status == StatusCode::PARTIAL_CONTENT {
        max_bytes
            .checked_sub(range_offset.unwrap_or(0))
            .ok_or_else(rejected)?
    } else {
        max_bytes
    };
    if response
        .content_length()
        .is_some_and(|length| length > remaining_network_bytes)
    {
        return Err(rejected());
    }
    Ok(NetworkOpenResult {
        status: status.as_u16(),
        headers: projected,
        response: Some(response),
        remaining_network_bytes,
    })
}

struct HandleBody {
    response: Option<Response>,
    buffered: Vec<u8>,
    buffered_offset: usize,
    remaining_network_bytes: u64,
}

impl HandleBody {
    fn new(response: Response, remaining_network_bytes: u64) -> Self {
        Self {
            response: Some(response),
            buffered: Vec::new(),
            buffered_offset: 0,
            remaining_network_bytes,
        }
    }

    #[cfg(test)]
    fn new_for_test(remaining_network_bytes: u64) -> Self {
        Self {
            response: None,
            buffered: Vec::new(),
            buffered_offset: 0,
            remaining_network_bytes,
        }
    }
}

struct ActiveRead {
    token: u64,
    abort: AbortHandle,
}

struct HandleControl {
    closed: bool,
    last_access: Instant,
    next_read_token: u64,
    active_read: Option<ActiveRead>,
}

struct HandleEntry {
    request_id: String,
    body: AsyncMutex<HandleBody>,
    control: Mutex<HandleControl>,
}

impl HandleEntry {
    fn new(
        request_id: &str,
        now: Instant,
        response: Response,
        remaining_network_bytes: u64,
    ) -> Self {
        Self {
            request_id: request_id.to_string(),
            body: AsyncMutex::new(HandleBody::new(response, remaining_network_bytes)),
            control: Mutex::new(HandleControl {
                closed: false,
                last_access: now,
                next_read_token: 0,
                active_read: None,
            }),
        }
    }

    #[cfg(test)]
    fn new_for_test(request_id: &str, now: Instant, remaining_network_bytes: u64) -> Self {
        Self {
            request_id: request_id.to_string(),
            body: AsyncMutex::new(HandleBody::new_for_test(remaining_network_bytes)),
            control: Mutex::new(HandleControl {
                closed: false,
                last_access: now,
                next_read_token: 0,
                active_read: None,
            }),
        }
    }
}

struct ActiveOpen {
    token: u64,
    abort: AbortHandle,
}

#[derive(Default)]
struct FetchMaps {
    active_opens: HashMap<String, ActiveOpen>,
    pending_cancellations: HashMap<String, Instant>,
    handles: HashMap<String, Arc<HandleEntry>>,
    request_handles: HashMap<String, String>,
    next_open_token: u64,
}

#[derive(Default)]
struct ModelArtifactFetchInner {
    maps: Mutex<FetchMaps>,
}

#[derive(Clone, Default)]
pub struct ModelArtifactFetchState {
    inner: Arc<ModelArtifactFetchInner>,
}

enum OpenRegistration {
    Registered,
    Cancelled,
    Conflict,
    Capacity,
}

enum PublishResult {
    Published,
    Cancelled,
    Conflict,
    Capacity,
}

struct CancelActions {
    open_abort: Option<AbortHandle>,
    entries: Vec<Arc<HandleEntry>>,
}

fn prune_pending_cancellations(maps: &mut FetchMaps, now: Instant) {
    maps.pending_cancellations.retain(|_, registered_at| {
        now.checked_duration_since(*registered_at).unwrap_or_default()
            <= PENDING_CANCELLATION_TTL
    });
}

fn register_open(
    maps: &mut FetchMaps,
    request_id: &str,
    abort: AbortHandle,
    now: Instant,
) -> OpenRegistration {
    prune_pending_cancellations(maps, now);
    if maps.pending_cancellations.remove(request_id).is_some() {
        return OpenRegistration::Cancelled;
    }
    if maps.active_opens.contains_key(request_id) || maps.request_handles.contains_key(request_id) {
        return OpenRegistration::Conflict;
    }
    if maps.handles.len().saturating_add(maps.active_opens.len()) >= MAX_LIVE_HANDLES {
        return OpenRegistration::Capacity;
    }
    let token = maps.next_open_token.wrapping_add(1).max(1);
    maps.next_open_token = token;
    maps.active_opens.insert(
        request_id.to_string(),
        ActiveOpen {
            token,
            abort,
        },
    );
    OpenRegistration::Registered
}

fn active_open_token(maps: &FetchMaps, request_id: &str) -> Option<u64> {
    maps.active_opens.get(request_id).map(|active| active.token)
}

fn remove_active_open(maps: &mut FetchMaps, request_id: &str, token: u64) -> bool {
    if maps
        .active_opens
        .get(request_id)
        .is_some_and(|active| active.token == token)
    {
        maps.active_opens.remove(request_id);
        true
    } else {
        false
    }
}

fn finish_open_without_handle(
    maps: &mut FetchMaps,
    request_id: &str,
    token: u64,
    now: Instant,
) -> bool {
    prune_pending_cancellations(maps, now);
    if maps.pending_cancellations.remove(request_id).is_some() {
        remove_active_open(maps, request_id, token);
        return false;
    }
    remove_active_open(maps, request_id, token)
}

fn publish_handle_with_token(
    maps: &mut FetchMaps,
    request_id: &str,
    handle: String,
    entry: Arc<HandleEntry>,
    token: u64,
    now: Instant,
) -> PublishResult {
    prune_pending_cancellations(maps, now);
    if maps.pending_cancellations.remove(request_id).is_some() {
        remove_active_open(maps, request_id, token);
        return PublishResult::Cancelled;
    }
    if !maps
        .active_opens
        .get(request_id)
        .is_some_and(|active| active.token == token)
    {
        return PublishResult::Cancelled;
    }
    if maps.handles.len() >= MAX_LIVE_HANDLES {
        remove_active_open(maps, request_id, token);
        return PublishResult::Capacity;
    }
    if maps.handles.contains_key(&handle) || maps.request_handles.contains_key(request_id) {
        remove_active_open(maps, request_id, token);
        return PublishResult::Conflict;
    }
    remove_active_open(maps, request_id, token);
    maps.request_handles
        .insert(request_id.to_string(), handle.clone());
    maps.handles.insert(handle, entry);
    PublishResult::Published
}

#[cfg(test)]
fn publish_handle(
    maps: &mut FetchMaps,
    request_id: &str,
    handle: String,
    entry: Arc<HandleEntry>,
    now: Instant,
) -> PublishResult {
    let token = active_open_token(maps, request_id).unwrap_or(0);
    publish_handle_with_token(maps, request_id, handle, entry, token, now)
}

fn remove_matching_handle(
    maps: &mut FetchMaps,
    handle: &str,
    expected: &Arc<HandleEntry>,
) -> Option<Arc<HandleEntry>> {
    if !maps
        .handles
        .get(handle)
        .is_some_and(|entry| Arc::ptr_eq(entry, expected))
    {
        return None;
    }
    let removed = maps.handles.remove(handle)?;
    if maps
        .request_handles
        .get(&removed.request_id)
        .is_some_and(|registered_handle| registered_handle == handle)
    {
        maps.request_handles.remove(&removed.request_id);
    }
    Some(removed)
}

fn is_idle_expired(entry: &Arc<HandleEntry>, now: Instant) -> bool {
    entry.control.lock().map_or(true, |control| {
        !control.closed
            && control.active_read.is_none()
            && now
                .checked_duration_since(control.last_access)
                .unwrap_or_default()
                > HANDLE_IDLE_TTL
    })
}

fn prune_expired_handles(maps: &mut FetchMaps, now: Instant) -> Vec<Arc<HandleEntry>> {
    let expired = maps
        .handles
        .iter()
        .filter(|(_, entry)| is_idle_expired(entry, now))
        .map(|(handle, entry)| (handle.clone(), entry.clone()))
        .collect::<Vec<_>>();
    expired
        .into_iter()
        .filter_map(|(handle, entry)| remove_matching_handle(maps, &handle, &entry))
        .collect()
}

fn close_entry(entry: &Arc<HandleEntry>) {
    let abort = match entry.control.lock() {
        Ok(mut control) => {
            if control.closed {
                None
            } else {
                control.closed = true;
                control.active_read.take().map(|active| active.abort)
            }
        }
        Err(_) => None,
    };
    if let Some(abort) = abort {
        abort.abort();
    }
}

fn apply_cancel_actions(actions: CancelActions) {
    if let Some(abort) = actions.open_abort {
        abort.abort();
    }
    for entry in actions.entries {
        close_entry(&entry);
    }
}

fn insert_pending_cancellation(maps: &mut FetchMaps, request_id: &str, now: Instant) {
    if !maps.pending_cancellations.contains_key(request_id)
        && maps.pending_cancellations.len() >= MAX_PENDING_CANCELLATIONS
    {
        if let Some(oldest) = maps
            .pending_cancellations
            .iter()
            .min_by_key(|(_, registered_at)| **registered_at)
            .map(|(id, _)| id.clone())
        {
            maps.pending_cancellations.remove(&oldest);
        }
    }
    maps.pending_cancellations.insert(request_id.to_string(), now);
}

fn record_cancellation(
    maps: &mut FetchMaps,
    request_id: &str,
    handle: Option<&str>,
    now: Instant,
) -> CancelActions {
    prune_pending_cancellations(maps, now);
    let open_abort = maps.active_opens.remove(request_id).map(|active| active.abort);
    let mut entries = Vec::new();
    if let Some(mapped_handle) = maps.request_handles.get(request_id).cloned() {
        if let Some(entry) = maps.handles.get(&mapped_handle).cloned() {
            if let Some(removed) = remove_matching_handle(maps, &mapped_handle, &entry) {
                entries.push(removed);
            }
        }
    }
    if let Some(handle) = handle {
        if let Some(entry) = maps.handles.get(handle).cloned() {
            if entry.request_id == request_id {
                if let Some(removed) = remove_matching_handle(maps, handle, &entry) {
                    if !entries.iter().any(|existing| Arc::ptr_eq(existing, &removed)) {
                        entries.push(removed);
                    }
                }
            }
        }
    }
    insert_pending_cancellation(maps, request_id, now);
    CancelActions {
        open_abort,
        entries,
    }
}

fn begin_read(entry: &Arc<HandleEntry>, now: Instant) -> Result<(u64, AbortRegistration), String> {
    let mut control = entry.control.lock().map_err(|_| rejected())?;
    if control.closed || control.active_read.is_some() {
        return Err(rejected());
    }
    control.next_read_token = control.next_read_token.wrapping_add(1).max(1);
    let token = control.next_read_token;
    let (abort, registration) = AbortHandle::new_pair();
    control.active_read = Some(ActiveRead { token, abort });
    control.last_access = now;
    Ok((token, registration))
}

fn finish_read(entry: &Arc<HandleEntry>, token: u64, now: Instant) -> bool {
    let Ok(mut control) = entry.control.lock() else {
        return false;
    };
    if !control
        .active_read
        .as_ref()
        .is_some_and(|active| active.token == token)
    {
        return false;
    }
    control.active_read = None;
    if control.closed {
        false
    } else {
        control.last_access = now;
        true
    }
}

fn validate_read_size(max_bytes: usize) -> Result<(), String> {
    if max_bytes == 0 || max_bytes > MODEL_ARTIFACT_MAX_CHUNK_BYTES {
        Err(rejected())
    } else {
        Ok(())
    }
}

fn stage_network_chunk(body: &mut HandleBody, chunk: &[u8]) -> Result<(), String> {
    if chunk.is_empty()
        || chunk.len() > MODEL_ARTIFACT_MAX_CHUNK_BYTES
        || chunk.len() as u64 > body.remaining_network_bytes
        || body.buffered_offset < body.buffered.len()
    {
        return Err(rejected());
    }
    body.buffered.clear();
    body.buffered.extend_from_slice(chunk);
    body.buffered_offset = 0;
    body.remaining_network_bytes -= chunk.len() as u64;
    Ok(())
}

fn take_buffered_chunk(body: &mut HandleBody, max_bytes: usize) -> Option<Vec<u8>> {
    if body.buffered_offset >= body.buffered.len() {
        body.buffered.clear();
        body.buffered_offset = 0;
        return None;
    }
    let end = body
        .buffered_offset
        .saturating_add(max_bytes)
        .min(body.buffered.len());
    let chunk = body.buffered[body.buffered_offset..end].to_vec();
    body.buffered_offset = end;
    if body.buffered_offset == body.buffered.len() {
        body.buffered.clear();
        body.buffered_offset = 0;
    }
    Some(chunk)
}

async fn pull_body_chunk(
    entry: &Arc<HandleEntry>,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, String> {
    let mut body = entry.body.lock().await;
    if let Some(chunk) = take_buffered_chunk(&mut body, max_bytes) {
        return Ok(Some(chunk));
    }
    loop {
        let next = match body.response.as_mut() {
            Some(response) => response.chunk().await.map_err(|_| network_failed())?,
            None => return Ok(None),
        };
        match next {
            Some(chunk) if chunk.is_empty() => continue,
            Some(chunk) => {
                stage_network_chunk(&mut body, chunk.as_ref())?;
                return take_buffered_chunk(&mut body, max_bytes)
                    .map(Some)
                    .ok_or_else(rejected);
            }
            None => {
                body.response = None;
                return Ok(None);
            }
        }
    }
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn valid_handle(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.contains('\r') && !value.contains('\n')
}

async fn reap_idle_handle(
    inner: Arc<ModelArtifactFetchInner>,
    handle: String,
    weak_entry: Weak<HandleEntry>,
) {
    loop {
        let delay = {
            let Some(entry) = weak_entry.upgrade() else {
                return;
            };
            let Ok(control) = entry.control.lock() else {
                return;
            };
            if control.closed {
                return;
            }
            let delay = if control.active_read.is_some() {
                Duration::from_secs(1)
            } else {
                let expires = control.last_access + HANDLE_IDLE_TTL;
                expires.saturating_duration_since(Instant::now())
            };
            drop(control);
            delay
        };
        tokio::time::sleep(delay.max(Duration::from_millis(10))).await;
        let Some(entry) = weak_entry.upgrade() else {
            return;
        };
        let removed = {
            let Ok(mut maps) = inner.maps.lock() else {
                return;
            };
            if is_idle_expired(&entry, Instant::now()) {
                remove_matching_handle(&mut maps, &handle, &entry)
            } else {
                None
            }
        };
        if let Some(removed) = removed {
            close_entry(&removed);
            return;
        }
    }
}

#[derive(Serialize)]
pub struct ModelArtifactOpenResult {
    handle: Option<String>,
    status: u16,
    headers: Vec<(String, String)>,
}

#[derive(Serialize)]
pub struct ModelArtifactReadResult {
    done: bool,
    chunk: Vec<u8>,
}

#[tauri::command]
pub async fn open_model_artifact_fetch(
    request_id: String,
    url: String,
    headers: Vec<(String, String)>,
    max_bytes: u64,
    state: State<'_, ModelArtifactFetchState>,
) -> Result<ModelArtifactOpenResult, String> {
    if !valid_request_id(&request_id) {
        return Err(rejected());
    }
    validate_artifact_url(&url, max_bytes)?;
    let headers = validate_request_headers(headers, max_bytes)?;
    let parsed = Url::parse(&url).map_err(|_| rejected())?;
    let (abort, registration) = AbortHandle::new_pair();
    let now = Instant::now();
    let (registration_result, token, expired) = {
        let mut maps = state.inner.maps.lock().map_err(|_| rejected())?;
        let expired = prune_expired_handles(&mut maps, now);
        let result = register_open(&mut maps, &request_id, abort, now);
        let token = active_open_token(&maps, &request_id);
        (result, token, expired)
    };
    apply_cancel_actions(CancelActions {
        open_abort: None,
        entries: expired,
    });
    match registration_result {
        OpenRegistration::Registered => {}
        OpenRegistration::Cancelled => return Err("Model artifact request cancelled".to_string()),
        OpenRegistration::Conflict | OpenRegistration::Capacity => return Err(rejected()),
    }
    let token = token.ok_or_else(rejected)?;
    let network = Abortable::new(
        execute_open(parsed, headers.headers, headers.range_offset, max_bytes),
        registration,
    )
    .await;
    let opened = match network {
        Ok(Ok(opened)) => opened,
        Ok(Err(error)) => {
            if let Ok(mut maps) = state.inner.maps.lock() {
                remove_active_open(&mut maps, &request_id, token);
            }
            return Err(error);
        }
        Err(_) => {
            if let Ok(mut maps) = state.inner.maps.lock() {
                remove_active_open(&mut maps, &request_id, token);
            }
            return Err("Model artifact request cancelled".to_string());
        }
    };

    let Some(response) = opened.response else {
        let publishable = {
            let mut maps = state.inner.maps.lock().map_err(|_| rejected())?;
            finish_open_without_handle(&mut maps, &request_id, token, Instant::now())
        };
        if !publishable {
            return Err("Model artifact request cancelled".to_string());
        }
        return Ok(ModelArtifactOpenResult {
            handle: None,
            status: opened.status,
            headers: opened.headers,
        });
    };

    let handle = Uuid::new_v4().simple().to_string();
    let entry = Arc::new(HandleEntry::new(
        &request_id,
        Instant::now(),
        response,
        opened.remaining_network_bytes,
    ));
    let published = {
        let mut maps = state.inner.maps.lock().map_err(|_| rejected())?;
        publish_handle_with_token(
            &mut maps,
            &request_id,
            handle.clone(),
            entry.clone(),
            token,
            Instant::now(),
        )
    };
    match published {
        PublishResult::Published => {
            let inner = state.inner.clone();
            let reaper_handle = handle.clone();
            let reaper_entry = Arc::downgrade(&entry);
            tauri::async_runtime::spawn(async move {
                reap_idle_handle(inner, reaper_handle, reaper_entry).await;
            });
            Ok(ModelArtifactOpenResult {
                handle: Some(handle),
                status: opened.status,
                headers: opened.headers,
            })
        }
        PublishResult::Cancelled => {
            close_entry(&entry);
            Err("Model artifact request cancelled".to_string())
        }
        PublishResult::Conflict | PublishResult::Capacity => {
            close_entry(&entry);
            Err(rejected())
        }
    }
}

#[tauri::command]
pub async fn read_model_artifact_fetch(
    handle: String,
    max_bytes: usize,
    state: State<'_, ModelArtifactFetchState>,
) -> Result<ModelArtifactReadResult, String> {
    if !valid_handle(&handle) {
        return Err(rejected());
    }
    validate_read_size(max_bytes)?;
    let entry = {
        let maps = state.inner.maps.lock().map_err(|_| rejected())?;
        maps.handles.get(&handle).cloned().ok_or_else(rejected)?
    };
    let (token, registration) = begin_read(&entry, Instant::now())?;
    let result = Abortable::new(pull_body_chunk(&entry, max_bytes), registration).await;
    let usable = finish_read(&entry, token, Instant::now());
    match result {
        Ok(Ok(Some(chunk))) if usable => Ok(ModelArtifactReadResult { done: false, chunk }),
        Ok(Ok(None)) if usable => {
            let removed = {
                let mut maps = state.inner.maps.lock().map_err(|_| rejected())?;
                remove_matching_handle(&mut maps, &handle, &entry)
            };
            if let Some(removed) = removed {
                close_entry(&removed);
            }
            Ok(ModelArtifactReadResult {
                done: true,
                chunk: Vec::new(),
            })
        }
        Ok(Err(error)) => {
            let removed = {
                let mut maps = state.inner.maps.lock().map_err(|_| rejected())?;
                remove_matching_handle(&mut maps, &handle, &entry)
            };
            if let Some(removed) = removed {
                close_entry(&removed);
            }
            Err(error)
        }
        _ => {
            let removed = {
                let mut maps = state.inner.maps.lock().map_err(|_| rejected())?;
                remove_matching_handle(&mut maps, &handle, &entry)
            };
            if let Some(removed) = removed {
                close_entry(&removed);
            }
            Err("Model artifact request cancelled".to_string())
        }
    }
}

#[tauri::command]
pub fn close_model_artifact_fetch(
    handle: String,
    state: State<'_, ModelArtifactFetchState>,
) -> bool {
    if !valid_handle(&handle) {
        return true;
    }
    let removed = {
        let Ok(mut maps) = state.inner.maps.lock() else {
            return true;
        };
        let Some(entry) = maps.handles.get(&handle).cloned() else {
            return true;
        };
        remove_matching_handle(&mut maps, &handle, &entry)
    };
    if let Some(entry) = removed {
        close_entry(&entry);
    }
    true
}

#[tauri::command]
pub fn cancel_model_artifact_fetch(
    request_id: String,
    handle: Option<String>,
    state: State<'_, ModelArtifactFetchState>,
) -> bool {
    if !valid_request_id(&request_id) {
        return true;
    }
    let selected_handle = handle.as_deref().filter(|value| valid_handle(value));
    let actions = {
        let Ok(mut maps) = state.inner.maps.lock() else {
            return true;
        };
        record_cancellation(&mut maps, &request_id, selected_handle, Instant::now())
    };
    apply_cancel_actions(actions);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::future::{pending, Abortable};

    fn public_socket(address: &str) -> SocketAddr {
        format!("{address}:443").parse().unwrap()
    }

    fn test_entry(request_id: &str, now: Instant, remaining: u64) -> Arc<HandleEntry> {
        Arc::new(HandleEntry::new_for_test(request_id, now, remaining))
    }

    #[test]
    fn accepts_only_registered_initial_and_reviewed_xet_urls() {
        for (url, bytes) in REGISTERED_ARTIFACTS {
            assert_eq!(
                validate_artifact_url(url, *bytes).unwrap(),
                ArtifactUrlKind::Initial,
            );
        }
        let xet = "https://us.aws.cdn.hf.co/xet-bridge-us/abc/model.onnx?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260726T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abc&X-Amz-SignedHeaders=host";
        assert_eq!(
            validate_artifact_url(xet, REGISTERED_ARTIFACTS[0].1).unwrap(),
            ArtifactUrlKind::Xet,
        );

        for rejected_url in [
            "http://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/model.onnx",
            "https://user:pass@huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/model.onnx",
            "https://huggingface.co:443/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/model.onnx",
            "https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/main/model.onnx",
            "https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/model.onnx?download=1",
            "https://huggingface.co/deepghs/pixai-tagger-v0.9-onnx/resolve/d8cf666911a2c3d10d586d7823259192313c7eb7/model.onnx#fragment",
            "https://chat.example/api/resolve-cache/deepghs/pixai-tagger-v0.9-onnx/model.onnx",
            "https://us.aws.cdn.hf.co:443/xet-bridge-us/a",
            "https://us.aws.cdn.hf.co/xet-bridge-us/%2e%2e/a",
            "https://us.aws.cdn.hf.co/xet-bridge-us/safe%252fsecret",
            "https://us.aws.cdn.hf.co/xet-bridge-us/a?redirect=https://evil.example",
            "https://us.aws.cdn.hf.co/xet-bridge-us/a?X-Amz-Date=one&X-Amz-Date=two",
        ] {
            assert!(
                validate_artifact_url(rejected_url, REGISTERED_ARTIFACTS[0].1).is_err(),
                "{rejected_url}",
            );
        }
        assert!(validate_artifact_url(REGISTERED_ARTIFACTS[0].0, 1).is_err());
    }

    #[test]
    fn accepts_only_exact_range_and_if_range_headers() {
        let validated = validate_request_headers(
            vec![
                ("Range".to_string(), "bytes=1-".to_string()),
                ("If-Range".to_string(), "\"fixed\"".to_string()),
            ],
            REGISTERED_ARTIFACTS[0].1,
        )
        .unwrap();
        assert_eq!(validated.range_offset, Some(1));
        assert_eq!(validated.headers.len(), 2);

        for headers in [
            vec![("Authorization".to_string(), "secret".to_string())],
            vec![
                ("Range".to_string(), "bytes=0-".to_string()),
                ("range".to_string(), "bytes=1-".to_string()),
            ],
            vec![("Range".to_string(), "bytes=01-".to_string())],
            vec![("Range".to_string(), "bytes=1-2".to_string())],
            vec![("If-Range".to_string(), "x\r\ny".to_string())],
        ] {
            assert!(
                validate_request_headers(headers, REGISTERED_ARTIFACTS[0].1).is_err()
            );
        }
        assert!(validate_request_headers(
            vec![(
                "Range".to_string(),
                format!("bytes={}-", REGISTERED_ARTIFACTS[0].1),
            )],
            REGISTERED_ARTIFACTS[0].1,
        )
        .is_err());
    }

    #[test]
    fn rejects_private_reserved_mapped_and_mixed_dns_answers() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "100.64.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.168.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fc00::1",
            "fe80::1",
            "fec0::1",
            "ff00::1",
            "2001:db8::1",
            "::127.0.0.1",
            "::ffff:8.8.8.8",
            "64:ff9b:1::8.8.8.8",
            "64:ff9b::127.0.0.1",
        ] {
            assert!(is_forbidden_ip(address.parse().unwrap()), "{address}");
        }
        let public = vec![public_socket("8.8.8.8"), public_socket("1.1.1.1")];
        assert_eq!(validate_dns_answers(&public).unwrap(), public);
        assert!(validate_dns_answers(&[
            public_socket("8.8.8.8"),
            public_socket("127.0.0.1"),
        ])
        .is_err());
        assert!(validate_artifact_url("https://0x7f000001/x", 1).is_err());
    }

    #[test]
    fn pins_every_validated_address_with_manual_no_proxy_policy() {
        assert!(ARTIFACT_CLIENT_POLICY.disable_proxy);
        assert!(!ARTIFACT_CLIENT_POLICY.follow_redirects);
        let addresses = vec![public_socket("8.8.8.8"), public_socket("1.1.1.1")];
        assert!(build_pinned_client("huggingface.co", &addresses).is_ok());
    }

    #[test]
    fn bounds_network_chunks_before_delivery() {
        let mut body = HandleBody::new_for_test(MODEL_ARTIFACT_MAX_CHUNK_BYTES as u64);
        let exact = vec![7; MODEL_ARTIFACT_MAX_CHUNK_BYTES];
        stage_network_chunk(&mut body, &exact).unwrap();
        assert_eq!(
            take_buffered_chunk(&mut body, MODEL_ARTIFACT_MAX_CHUNK_BYTES)
                .unwrap()
                .len(),
            MODEL_ARTIFACT_MAX_CHUNK_BYTES,
        );
        assert_eq!(body.remaining_network_bytes, 0);

        let mut over = HandleBody::new_for_test(MODEL_ARTIFACT_MAX_CHUNK_BYTES as u64);
        assert!(stage_network_chunk(
            &mut over,
            &vec![0; MODEL_ARTIFACT_MAX_CHUNK_BYTES + 1],
        )
        .is_err());
        assert!(validate_read_size(MODEL_ARTIFACT_MAX_CHUNK_BYTES).is_ok());
        assert!(validate_read_size(MODEL_ARTIFACT_MAX_CHUNK_BYTES + 1).is_err());
    }

    #[test]
    fn cancel_before_open_is_consumed_without_registration() {
        let now = Instant::now();
        let mut maps = FetchMaps::default();
        let actions = record_cancellation(&mut maps, "early", None, now);
        apply_cancel_actions(actions);
        let (abort, _registration) = AbortHandle::new_pair();
        assert!(matches!(
            register_open(&mut maps, "early", abort, now),
            OpenRegistration::Cancelled,
        ));
        assert!(maps.active_opens.is_empty());
        assert!(maps.pending_cancellations.is_empty());
    }

    #[test]
    fn cancel_racing_open_prevents_orphan_publication() {
        let now = Instant::now();
        let mut maps = FetchMaps::default();
        let (abort, registration) = AbortHandle::new_pair();
        assert!(matches!(
            register_open(&mut maps, "race", abort, now),
            OpenRegistration::Registered,
        ));
        let actions = record_cancellation(&mut maps, "race", None, now);
        apply_cancel_actions(actions);
        assert!(futures::executor::block_on(Abortable::new(pending::<()>(), registration)).is_err());
        assert!(matches!(
            publish_handle(
                &mut maps,
                "race",
                "late-handle".to_string(),
                test_entry("race", now, 1),
                now,
            ),
            PublishResult::Cancelled,
        ));
        assert!(maps.handles.is_empty());
        assert!(maps.request_handles.is_empty());
    }

    #[test]
    fn cancel_during_read_aborts_and_retires_the_handle() {
        let now = Instant::now();
        let entry = test_entry("read", now, 1);
        let mut maps = FetchMaps::default();
        maps.handles.insert("read-handle".to_string(), entry.clone());
        maps.request_handles
            .insert("read".to_string(), "read-handle".to_string());
        let (_token, registration) = begin_read(&entry, now).unwrap();
        let actions = record_cancellation(
            &mut maps,
            "read",
            Some("read-handle"),
            now,
        );
        apply_cancel_actions(actions);
        assert!(futures::executor::block_on(Abortable::new(pending::<()>(), registration)).is_err());
        assert!(maps.handles.is_empty());
        assert!(maps.request_handles.is_empty());
    }

    #[test]
    fn handle_cap_idle_expiry_eof_and_repeated_close_are_bounded() {
        let now = Instant::now();
        let mut maps = FetchMaps::default();
        for index in 0..MAX_LIVE_HANDLES {
            let request_id = format!("request-{index}");
            let handle = format!("handle-{index}");
            maps.request_handles
                .insert(request_id.clone(), handle.clone());
            maps.handles
                .insert(handle, test_entry(&request_id, now, 1));
        }
        let (abort, _registration) = AbortHandle::new_pair();
        assert!(matches!(
            register_open(&mut maps, "over-cap", abort, now),
            OpenRegistration::Capacity,
        ));

        let idle_handle = "handle-0";
        let idle_entry = maps.handles.get(idle_handle).unwrap().clone();
        assert!(is_idle_expired(
            &idle_entry,
            now + HANDLE_IDLE_TTL + Duration::from_millis(1),
        ));
        let expired = prune_expired_handles(
            &mut maps,
            now + HANDLE_IDLE_TTL + Duration::from_millis(1),
        );
        apply_cancel_actions(CancelActions {
            open_abort: None,
            entries: expired,
        });
        assert!(!maps.handles.contains_key(idle_handle));

        let eof_handle = "eof-handle";
        let eof_entry = test_entry("eof-request", Instant::now(), 1);
        maps.request_handles
            .insert("eof-request".to_string(), eof_handle.to_string());
        maps.handles
            .insert(eof_handle.to_string(), eof_entry.clone());
        assert!(remove_matching_handle(&mut maps, eof_handle, &eof_entry).is_some());
        assert!(remove_matching_handle(&mut maps, eof_handle, &eof_entry).is_none());
        apply_cancel_actions(record_cancellation(
            &mut maps,
            "unknown",
            Some("unknown-handle"),
            now,
        ));
        apply_cancel_actions(record_cancellation(
            &mut maps,
            "unknown",
            Some("unknown-handle"),
            now,
        ));
    }
}
