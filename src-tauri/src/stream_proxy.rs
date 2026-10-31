use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use axum::{
    body::Body,
    extract::Path,
    http::{header, HeaderMap, StatusCode},
    response::Response,
    routing::get,
    Router,
};
use futures_util::StreamExt;
use reqwest::Client;

const MAX_DIRECT_URLS: usize = 24;

#[derive(Clone)]
pub struct Upstream {
    pub url: String,
    pub user_agent: String,
}

static DIRECT_URLS: OnceLock<Mutex<HashMap<String, Upstream>>> = OnceLock::new();
static PROXY_PORT: OnceLock<u16> = OnceLock::new();
static PROXY_TOKEN: OnceLock<String> = OnceLock::new();
static HTTP: OnceLock<Client> = OnceLock::new();

fn http_client() -> &'static Client {
    HTTP.get_or_init(|| {
        Client::builder()
            .pool_max_idle_per_host(8)
            .timeout(Duration::from_secs(45))
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

/// same client without any proxy: a WPAD/PAC proxy on school networks often lets the
/// youtube pages through but blocks or breaks googlevideo, so the audio request is
/// retried direct. once direct worked it is used first for the rest of the session
static HTTP_DIRECT: OnceLock<Client> = OnceLock::new();
static PREFER_DIRECT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn direct_client() -> &'static Client {
    HTTP_DIRECT.get_or_init(|| {
        Client::builder()
            .pool_max_idle_per_host(8)
            .timeout(Duration::from_secs(45))
            .no_proxy()
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

/// link check through the proxy's own clients: the same request the proxy makes first,
/// and the connection (HTTP/2, the body is dropped as a stream reset) stays in the pool,
/// so the proxy's real request for this track skips the TLS handshake
pub async fn probe_status(url: &str, ua: &str) -> Option<u16> {
    match tokio::time::timeout(
        Duration::from_secs(5),
        send_upstream(url, ua, Some("bytes=0-")),
    )
    .await
    {
        Ok(Ok(r)) => Some(r.status().as_u16()),
        _ => None,
    }
}

/// separate pools for the hedged request, so it really opens a new connection
static HTTP_HEDGE: OnceLock<Client> = OnceLock::new();
static HTTP_HEDGE_DIRECT: OnceLock<Client> = OnceLock::new();

fn hedge_client(direct: bool) -> &'static Client {
    let cell = if direct {
        &HTTP_HEDGE_DIRECT
    } else {
        &HTTP_HEDGE
    };
    cell.get_or_init(|| {
        let mut b = Client::builder()
            .pool_max_idle_per_host(2)
            .timeout(Duration::from_secs(45));
        if direct {
            b = b.no_proxy();
        }
        b.build().unwrap_or_else(|_| Client::new())
    })
}

/// send the upstream request, trying the other route (proxy / direct) on a
/// connection-level error
async fn send_upstream(
    url: &str,
    ua: &str,
    range: Option<&str>,
) -> Result<reqwest::Response, reqwest::Error> {
    use std::sync::atomic::Ordering;
    let build = |c: &Client| {
        let mut r = c
            .get(url)
            .header(header::USER_AGENT, ua)
            .header(header::REFERER, "https://www.youtube.com/")
            .header(header::ORIGIN, "https://www.youtube.com");
        if let Some(v) = range {
            r = r.header(header::RANGE, v);
        }
        r
    };
    let direct_first = PREFER_DIRECT.load(Ordering::Relaxed);
    let (first, second) = if direct_first {
        (direct_client(), http_client())
    } else {
        (http_client(), direct_client())
    };
    // googlevideo normally answers in 0.05-0.15 s; once in a while a connection stalls for
    // many seconds (seen: 8.6 s on a cold track). after 1.2 s without headers the same
    // request goes out once more on a fresh connection and whichever answers first wins
    let first_try = async {
        let one = build(first).send();
        tokio::pin!(one);
        tokio::select! {
            r = &mut one => r,
            _ = tokio::time::sleep(Duration::from_millis(1200)) => {
                crate::timeline::mark("proxy hedge: no headers after 1.2 s, second connection".to_string());
                let two = build(hedge_client(direct_first)).send();
                tokio::pin!(two);
                tokio::select! {
                    r = &mut one => match r { Ok(x) => Ok(x), Err(_) => two.await },
                    r = &mut two => match r {
                        Ok(x) => {
                            crate::timeline::mark("proxy hedge won".to_string());
                            Ok(x)
                        }
                        Err(_) => one.await,
                    },
                }
            }
        }
    };
    match first_try.await {
        Ok(r) => Ok(r),
        Err(e) => {
            eprintln!(
                "[Zenith] upstream route failed ({}), trying the other one",
                e
            );
            match build(second).send().await {
                Ok(r) => {
                    PREFER_DIRECT.store(!direct_first, Ordering::Relaxed);
                    Ok(r)
                }
                Err(e2) => {
                    crate::stream::note_failure("network");
                    Err(e2)
                }
            }
        }
    }
}

fn allowed_upstream(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return false;
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    host == "googlevideo.com"
        || host.ends_with(".googlevideo.com")
        || host == "youtube.com"
        || host.ends_with(".youtube.com")
}

fn url_map() -> &'static Mutex<HashMap<String, Upstream>> {
    DIRECT_URLS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn proxy_token() -> &'static str {
    PROXY_TOKEN.get_or_init(|| {
        let mut bytes = [0u8; 16];
        if getrandom::getrandom(&mut bytes).is_err() {
            let seed = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            bytes[..8].copy_from_slice(&seed.to_le_bytes());
        }
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    })
}

fn evict_oldest(map: &mut HashMap<String, Upstream>) {
    while map.len() > MAX_DIRECT_URLS {
        if let Some(key) = map.keys().next().cloned() {
            map.remove(&key);
        } else {
            break;
        }
    }
}

pub fn store_upstream(video_id: &str, upstream: Upstream) {
    if let Ok(mut map) = url_map().lock() {
        map.insert(video_id.to_string(), upstream);
        evict_oldest(&mut map);
    }
}

pub fn remove_direct_url(video_id: &str) {
    if let Ok(mut map) = url_map().lock() {
        map.remove(video_id);
    }
}

pub fn clear_all_direct_urls() {
    if let Ok(mut map) = url_map().lock() {
        map.clear();
    }
}

/// base url for cached covers, append "<px>/<urlencoded url>"
pub fn cover_base() -> Option<String> {
    let port = PROXY_PORT.get().copied()?;
    Some(format!(
        "http://127.0.0.1:{}/cover/{}/",
        port,
        proxy_token()
    ))
}

async fn proxy_cover(Path((token, px, url)): Path<(String, String, String)>) -> Response {
    let status = |c: u16| {
        Response::builder()
            .status(StatusCode::from_u16(c).unwrap_or(StatusCode::BAD_GATEWAY))
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Body::empty())
            .unwrap_or_default()
    };
    if token != proxy_token() {
        return status(403);
    }
    let Some((px, url)) = crate::cover_cache::parse_path(&format!("/{px}/{url}")) else {
        return status(400);
    };
    match crate::cover_cache::get(px, url).await {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/jpeg")
            .header(header::CACHE_CONTROL, "max-age=604800, immutable")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Body::from(bytes))
            .unwrap_or_default(),
        Err(c) => status(c),
    }
}

pub fn offline_url(video_id: &str) -> Option<String> {
    let port = PROXY_PORT.get().copied()?;
    Some(format!(
        "http://127.0.0.1:{}/offline/{}/{}",
        port,
        proxy_token(),
        video_id
    ))
}

/// a downloaded track straight from disk, with range support for seeking
async fn serve_offline(
    Path((token, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    if token != proxy_token() {
        return Err(StatusCode::FORBIDDEN);
    }
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());
    let slice =
        tokio::task::spawn_blocking(move || crate::downloads::read_slice(&id, range.as_deref()))
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .ok_or(StatusCode::NOT_FOUND)?;
    let (status, buf, start, end, len, mime) = slice;
    let mut b = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, buf.len().to_string())
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if status == 206 {
        b = b.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    b.body(Body::from(buf))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub fn proxy_url(video_id: &str) -> Option<String> {
    let port = PROXY_PORT.get().copied()?;
    Some(format!(
        "http://127.0.0.1:{}/zenith/{}/{}",
        port,
        proxy_token(),
        video_id
    ))
}

/// wait until the local stream proxy is actually listening, first play can race setup
pub async fn ensure_ready() -> Result<u16, String> {
    if let Some(port) = PROXY_PORT.get().copied() {
        return Ok(port);
    }
    start_background().await;
    for _ in 0..80 {
        if let Some(port) = PROXY_PORT.get().copied() {
            return Ok(port);
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    Err("stream proxy not ready".into())
}

pub async fn start_background() {
    if PROXY_PORT.get().is_some() {
        return;
    }

    let mut last_err = "bind failed".to_string();
    for attempt in 0..8u64 {
        match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => {
                let port = match listener.local_addr() {
                    Ok(addr) => addr.port(),
                    Err(e) => {
                        last_err = e.to_string();
                        tokio::time::sleep(std::time::Duration::from_millis(40 * (attempt + 1)))
                            .await;
                        continue;
                    }
                };
                if PROXY_PORT.set(port).is_err() {
                    return;
                }

                let app = Router::new()
                    .route("/zenith/{token}/{id}", get(proxy_stream))
                    .route("/cover/{token}/{px}/{*url}", get(proxy_cover))
                    .route("/offline/{token}/{id}", get(serve_offline))
                    .with_state(());

                println!("[Zenith] stream proxy on 127.0.0.1:{}", port);

                tokio::spawn(async move {
                    if let Err(e) = axum::serve(listener, app).await {
                        eprintln!("[Zenith] stream proxy error: {}", e);
                    }
                });
                return;
            }
            Err(e) => {
                last_err = e.to_string();
                tokio::time::sleep(std::time::Duration::from_millis(40 * (attempt + 1))).await;
            }
        }
    }
    eprintln!("[Zenith] stream proxy bind failed: {last_err}");
}

async fn proxy_stream(
    Path((token, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    if token != proxy_token() {
        return Err(StatusCode::FORBIDDEN);
    }
    if id.len() != 11
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(StatusCode::BAD_REQUEST);
    }

    let upstream = {
        let map = url_map()
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        map.get(&id).cloned().ok_or(StatusCode::NOT_FOUND)?
    };
    if !allowed_upstream(&upstream.url) {
        eprintln!("[Zenith] refused non-YouTube upstream for {}", id);
        remove_direct_url(&id);
        return Err(StatusCode::BAD_GATEWAY);
    }

    crate::timeline::mark(format!(
        "proxy request {id} range={:?}",
        headers.get(header::RANGE).and_then(|v| v.to_str().ok())
    ));
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());
    let mut upstream = upstream;
    let mut attempt = 0usize;
    let upstream_res = loop {
        let res = send_upstream(&upstream.url, &upstream.user_agent, range.as_deref()).await;
        let refused = match &res {
            Ok(r) => matches!(r.status().as_u16(), 403 | 410 | 429),
            Err(_) => true,
        };
        if !refused {
            break res.map_err(|_| StatusCode::BAD_GATEWAY)?;
        }
        match &res {
            Ok(r) => eprintln!(
                "[Zenith] proxy {} from googlevideo for {}",
                r.status().as_u16(),
                id
            ),
            Err(e) => eprintln!("[Zenith] proxy upstream error ({}): {}", id, e),
        }
        let failed_url = upstream.url.clone();
        remove_direct_url(&id);
        crate::stream::evict_cached_url(&id);
        // transparent recovery: re-resolve with another player client and retry, so a
        // refused url doesn't surface as a media error (which skipped the track)
        let mut recovered = None;
        while attempt < crate::stream::RECOVERY_ATTEMPTS && recovered.is_none() {
            if attempt > 0 {
                continue_recovery_delay(attempt).await;
            }
            recovered = crate::stream::recover_upstream(&id, attempt, &failed_url)
                .await
                .filter(|u| allowed_upstream(&u.url));
            attempt += 1;
        }
        if let Some(next) = recovered {
            upstream = next;
            continue;
        }
        match res {
            Ok(r) => break r,
            Err(_) => return Err(StatusCode::BAD_GATEWAY),
        }
    };

    let status = upstream_res.status();
    crate::timeline::mark(format!("proxy upstream headers {id} {}", status.as_u16()));
    // CORS so the equalizer / normalization (Web Audio, crossOrigin=anonymous) can read the
    // samples; the url is token-protected and loopback-only either way
    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");

    for key in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::ACCEPT_RANGES,
        header::CONTENT_RANGE,
        header::CACHE_CONTROL,
    ] {
        if let Some(v) = upstream_res.headers().get(&key) {
            builder = builder.header(key, v);
        }
    }

    let stream = upstream_res
        .bytes_stream()
        .map(|chunk| chunk.map_err(std::io::Error::other));

    builder
        .body(Body::from_stream(stream))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

/// small pause between recovery attempts so a refused burst doesn't hammer youtube
async fn continue_recovery_delay(attempt: usize) {
    tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
}

/// current upstream for an id (used to share one recovery between parallel range requests)
pub fn current_upstream(id: &str) -> Option<Upstream> {
    url_map().lock().ok()?.get(id).cloned()
}
