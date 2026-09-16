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

    let mut req = http_client()
        .get(&upstream.url)
        .header(header::USER_AGENT, &upstream.user_agent)
        .header(header::REFERER, "https://www.youtube.com/")
        .header(header::ORIGIN, "https://www.youtube.com");

    if let Some(range) = headers.get(header::RANGE) {
        if let Ok(v) = range.to_str() {
            req = req.header(header::RANGE, v);
        }
    }

    let upstream_res = req.send().await.map_err(|e| {
        eprintln!("[Zenith] proxy upstream error ({}): {}", id, e);
        StatusCode::BAD_GATEWAY
    })?;

    let status = upstream_res.status();
    if status.as_u16() == 403 || status.as_u16() == 429 {
        eprintln!(
            "[Zenith] proxy {} from googlevideo for {}",
            status.as_u16(),
            id
        );
        remove_direct_url(&id);
        crate::stream::evict_cached_url(&id);
    }
    let mut builder = Response::builder().status(status);

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
