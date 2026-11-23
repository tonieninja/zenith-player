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

// to też limit STREAM_CACHE, który usuwa najstarsze razem z tą mapą; usuwanie tutaj trafiało w losowy wpis
pub(crate) const MAX_DIRECT_URLS: usize = 64;

#[derive(Clone)]
pub struct Upstream {
    pub url: String,
    pub user_agent: String,
}

static DIRECT_URLS: OnceLock<Mutex<HashMap<String, Upstream>>> = OnceLock::new();
// teledysk ma osobną mapę: wpis obrazu pod tym samym id nadpisałby albo wyrzucił adres dźwięku
static VIDEO_URLS: OnceLock<Mutex<HashMap<String, (Upstream, u64)>>> = OnceLock::new();
const MAX_VIDEO_URLS: usize = 4;

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Audio,
    Video,
}
static PROXY_PORT: OnceLock<u16> = OnceLock::new();
static PROXY_TOKEN: OnceLock<String> = OnceLock::new();
static HTTP: OnceLock<Client> = OnceLock::new();

// limit dotyczy przerwy w danych, nie całego kawałka: na wolnym łączu 10 MiB nie mieściło się w 45 s
fn http_client() -> Option<&'static Client> {
    cached_client(&HTTP, || {
        crate::win_proxy::wait();
        Client::builder()
            .pool_max_idle_per_host(8)
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            // bajty idą do WebView i silnika 1:1, z oryginalnym Content-Length i zakresami
            .no_gzip()
            .no_brotli()
            .build()
    })
}

// Client::new() pada z tego samego powodu co build() (np. pusty magazyn certyfikatów), więc zamiast paniki jest błąd
pub(crate) fn cached_client(
    cell: &'static OnceLock<Client>,
    build: impl FnOnce() -> reqwest::Result<Client>,
) -> Option<&'static Client> {
    if let Some(c) = cell.get() {
        return Some(c);
    }
    match build() {
        Ok(c) => Some(cell.get_or_init(|| c)),
        Err(e) => {
            // przy zepsutym magazynie certyfikatów nie uda się żaden build, a próbuje każde żądanie
            static LOGGED: std::sync::atomic::AtomicBool =
                std::sync::atomic::AtomicBool::new(false);
            if !LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
                crate::diag::log(format!("[Zenith] http client build failed: {e}"));
            }
            None
        }
    }
}

static HTTP_DIRECT: OnceLock<Client> = OnceLock::new();
static PREFER_DIRECT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn direct_client() -> Option<&'static Client> {
    cached_client(&HTTP_DIRECT, || {
        Client::builder()
            .pool_max_idle_per_host(8)
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .no_gzip()
            .no_brotli()
            .no_proxy()
            .build()
    })
}

static HTTP_HEDGE: OnceLock<Client> = OnceLock::new();
static HTTP_HEDGE_DIRECT: OnceLock<Client> = OnceLock::new();

fn hedge_client(direct: bool) -> Option<&'static Client> {
    let cell = if direct {
        &HTTP_HEDGE_DIRECT
    } else {
        &HTTP_HEDGE
    };
    cached_client(cell, || {
        crate::win_proxy::wait();
        let mut b = Client::builder()
            .pool_max_idle_per_host(2)
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .no_gzip()
            .no_brotli();
        if direct {
            b = b.no_proxy();
        }
        b.build()
    })
}

async fn send_upstream(
    url: &str,
    ua: &str,
    range: Option<&str>,
) -> Result<reqwest::Response, String> {
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
    let pair = if direct_first {
        direct_client().zip(http_client())
    } else {
        http_client().zip(direct_client())
    };
    let Some((first, second)) = pair else {
        return Err("no http client".to_string());
    };
    let first_try = async {
        let one = build(first).send();
        tokio::pin!(one);
        tokio::select! {
            r = &mut one => r,
            _ = tokio::time::sleep(Duration::from_millis(1200)) => {
                let Some(hedge) = hedge_client(direct_first) else {
                    return one.await;
                };
                crate::mark("proxy hedge: no headers after 1.2 s, second connection".to_string());
                let two = build(hedge).send();
                tokio::pin!(two);
                tokio::select! {
                    r = &mut one => match r { Ok(x) => Ok(x), Err(_) => two.await },
                    r = &mut two => match r {
                        Ok(x) => {
                            crate::mark("proxy hedge won".to_string());
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
            crate::diag::log(format!(
                "[Zenith] upstream route failed ({}), trying the other one",
                e
            ));
            match build(second).send().await {
                Ok(r) => {
                    PREFER_DIRECT.store(!direct_first, Ordering::Relaxed);
                    Ok(r)
                }
                Err(e2) => {
                    crate::stream::note_network_failure();
                    Err(e2.to_string())
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

fn video_map() -> &'static Mutex<HashMap<String, (Upstream, u64)>> {
    VIDEO_URLS.get_or_init(Default::default)
}

pub fn store_video(video_id: &str, upstream: Upstream, fetched_at: u64) {
    let mut map = video_map().lock().unwrap_or_else(|e| e.into_inner());
    map.insert(video_id.to_string(), (upstream, fetched_at));
    while map.len() > MAX_VIDEO_URLS {
        let Some(k) = map
            .iter()
            .min_by_key(|(_, (_, at))| *at)
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        map.remove(&k);
    }
}

pub fn video_upstream(video_id: &str) -> Option<(Upstream, u64)> {
    video_map().lock().ok()?.get(video_id).cloned()
}

pub fn video_url(video_id: &str) -> Option<String> {
    let port = PROXY_PORT.get().copied()?;
    Some(format!(
        "http://127.0.0.1:{}/zvideo/{}/{}",
        port,
        proxy_token(),
        video_id
    ))
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
                    .route("/zvideo/{token}/{id}", get(proxy_video))
                    .route("/cover/{token}/{px}/{*url}", get(proxy_cover))
                    .route("/offline/{token}/{id}", get(serve_offline))
                    .with_state(());

                println!("[Zenith] stream proxy on 127.0.0.1:{}", port);

                tokio::spawn(async move {
                    if let Err(e) = axum::serve(listener, app).await {
                        crate::diag::log(format!("[Zenith] stream proxy error: {}", e));
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
    crate::diag::log(format!("[Zenith] stream proxy bind failed: {last_err}"));
}

async fn proxy_stream(
    Path((token, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    check_path(&token, &id)?;
    // adres /zenith/ z prefetchu żyje dłużej niż moment pobrania utworu; bez sieci musi grać z dysku
    if crate::downloads::is_downloaded(&id) {
        return serve_offline(Path((token, id)), headers).await;
    }

    let known = url_map()
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .get(&id)
        .cloned();
    let upstream = match known {
        Some(u) => u,
        None => crate::stream::upstream_on_demand(id.clone())
            .await
            .ok_or(StatusCode::NOT_FOUND)?,
    };
    if !allowed_upstream(&upstream.url) {
        crate::diag::log(format!("[Zenith] refused non-YouTube upstream for {}", id));
        remove_direct_url(&id);
        return Err(StatusCode::BAD_GATEWAY);
    }
    serve(id, upstream, headers, Kind::Audio).await
}

fn check_path(token: &str, id: &str) -> Result<(), StatusCode> {
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
    Ok(())
}

// bez plików offline i bez rozwiązywania na żądanie: obraz istnieje tylko po zvideo_stream
async fn proxy_video(
    Path((token, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    check_path(&token, &id)?;
    let (upstream, _) = video_upstream(&id).ok_or(StatusCode::NOT_FOUND)?;
    if !allowed_upstream(&upstream.url) {
        return Err(StatusCode::BAD_GATEWAY);
    }
    serve(id, upstream, headers, Kind::Video).await
}

async fn serve(
    id: String,
    upstream: Upstream,
    headers: HeaderMap,
    kind: Kind,
) -> Result<Response, StatusCode> {
    crate::mark(format!(
        "proxy request {id} range={:?}",
        headers.get(header::RANGE).and_then(|v| v.to_str().ok())
    ));
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());
    let mut upstream = upstream;
    let mut attempt = 0usize;
    let want = range.as_deref().and_then(parse_range);
    let first = want.map(|(s, e)| format!("bytes={s}-{}", chunk_last(s, e)));
    let upstream_res = fetch_upstream(
        kind,
        &id,
        &mut upstream,
        &mut attempt,
        first.as_deref().or(range.as_deref()),
    )
    .await?;
    let status = upstream_res.status();
    crate::mark(format!("proxy upstream headers {id} {}", status.as_u16()));
    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");

    let span = want
        .zip(content_range(&upstream_res))
        .and_then(|((start, end), (a, b, total))| {
            let last = end.unwrap_or(u64::MAX).min(total.saturating_sub(1));
            (status == StatusCode::PARTIAL_CONTENT && a == start && b < last)
                .then_some((start, b, last, total))
        });
    let copied: &[header::HeaderName] = if span.is_some() {
        &[
            header::CONTENT_TYPE,
            header::ACCEPT_RANGES,
            header::CACHE_CONTROL,
        ]
    } else {
        &[
            header::CONTENT_TYPE,
            header::CONTENT_LENGTH,
            header::ACCEPT_RANGES,
            header::CONTENT_RANGE,
            header::CACHE_CONTROL,
        ]
    };
    for key in copied {
        if let Some(v) = upstream_res.headers().get(key) {
            builder = builder.header(key, v);
        }
    }

    let first = upstream_res
        .bytes_stream()
        .map(|chunk| chunk.map_err(std::io::Error::other));
    let Some((start, got, last, total)) = span else {
        return builder
            .body(Body::from_stream(first))
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    };
    crate::mark(format!("proxy chunked {id} {start}-{last}/{total}"));
    let rest = futures_util::stream::unfold(
        Some((id, upstream, attempt, got + 1)),
        move |state| async move {
            let (id, mut upstream, mut attempt, next) = state?;
            if next > last {
                return None;
            }
            let range = format!("bytes={next}-{}", chunk_last(next, Some(last)));
            let res = fetch_upstream(kind, &id, &mut upstream, &mut attempt, Some(&range)).await;
            let piece = res.ok().and_then(|r| {
                let (a, b, t) = content_range(&r)?;
                // odświeżony link może wskazać inny format; inny rozmiar to błąd, nie cichy zlepek
                (r.status() == StatusCode::PARTIAL_CONTENT && a == next && t == total)
                    .then_some((r, b))
            });
            match piece {
                Some((r, b)) => {
                    let body = r.bytes_stream().map(|c| c.map_err(std::io::Error::other));
                    Some((body.boxed(), Some((id, upstream, attempt, b + 1))))
                }
                None => {
                    let err = std::io::Error::other(format!("upstream chunk at {next} failed"));
                    Some((futures_util::stream::once(async { Err(err) }).boxed(), None))
                }
            }
        },
    )
    .flatten();
    builder
        .status(StatusCode::PARTIAL_CONTENT)
        .header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{last}/{total}"),
        )
        .header(header::CONTENT_LENGTH, last - start + 1)
        .body(Body::from_stream(first.chain(rest)))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

// googlevideo dławi długie odpowiedzi do tempa odtwarzania; kawałki po 10 MiB jak w yt-dlp tego unikają
const CHUNK: u64 = 10 * 1024 * 1024;

fn chunk_last(start: u64, end: Option<u64>) -> u64 {
    (start + CHUNK - 1).min(end.unwrap_or(u64::MAX))
}

fn parse_range(v: &str) -> Option<(u64, Option<u64>)> {
    let (a, b) = v.trim().strip_prefix("bytes=")?.split_once('-')?;
    let start = a.trim().parse().ok()?;
    let end = match b.trim() {
        "" => None,
        e => Some(e.parse().ok().filter(|e| *e >= start)?),
    };
    Some((start, end))
}

fn content_range(r: &reqwest::Response) -> Option<(u64, u64, u64)> {
    parse_content_range(r.headers().get(header::CONTENT_RANGE)?.to_str().ok()?)
}

pub(crate) fn parse_content_range(v: &str) -> Option<(u64, u64, u64)> {
    let (span, total) = v.trim().strip_prefix("bytes ")?.split_once('/')?;
    let (a, b) = span.split_once('-')?;
    Some((a.parse().ok()?, b.parse().ok()?, total.parse().ok()?))
}

async fn fetch_upstream(
    kind: Kind,
    id: &str,
    upstream: &mut Upstream,
    attempt: &mut usize,
    range: Option<&str>,
) -> Result<reqwest::Response, StatusCode> {
    // wygasły link (403/410) odświeżamy; 429 oddajemy od razu, bo kolejne rozwiązania tylko pogłębiają limit IP
    loop {
        let mut res = send_upstream(&upstream.url, &upstream.user_agent, range).await;
        // zerwane połączenie to sieć, nie wygasły link: ten sam adres jeszcze dwa razy, bez nowego /player
        for wait in TRANSPORT_RETRY_MS {
            if res.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(wait)).await;
            res = send_upstream(&upstream.url, &upstream.user_agent, range).await;
        }
        let refused = match &res {
            Ok(r) => matches!(r.status().as_u16(), 403 | 410),
            Err(_) => false,
        };
        if !refused {
            if let Err(e) = &res {
                crate::diag::log(format!("[Zenith] proxy upstream error ({}): {}", id, e));
            }
            return res.map_err(|_| StatusCode::BAD_GATEWAY);
        }
        if let Ok(r) = &res {
            crate::diag::log(format!(
                "[Zenith] proxy {} from googlevideo for {}",
                r.status().as_u16(),
                id
            ));
        }
        let failed_url = upstream.url.clone();
        // obraz odświeża tylko siebie i najwyżej raz: ścieżka dźwięku ani jego pamięć podręczna nie są ruszane
        if kind == Kind::Video {
            let next = if *attempt == 0 {
                *attempt = 1;
                crate::stream::recover_video(id, &failed_url).await
            } else {
                None
            };
            match next.filter(|u| allowed_upstream(&u.url)) {
                Some(u) => {
                    *upstream = u;
                    continue;
                }
                None => {
                    video_map()
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(id);
                    return res.map_err(|_| StatusCode::BAD_GATEWAY);
                }
            }
        }
        remove_direct_url(id);
        crate::stream::evict_cached_url(id);
        let mut recovered = None;
        while *attempt < crate::stream::RECOVERY_ATTEMPTS && recovered.is_none() {
            if *attempt > 0 {
                continue_recovery_delay(*attempt).await;
            }
            recovered = crate::stream::recover_upstream(id, *attempt, &failed_url)
                .await
                .filter(|u| allowed_upstream(&u.url));
            *attempt += 1;
        }
        if let Some(next) = recovered {
            *upstream = next;
            continue;
        }
        match res {
            Ok(r) => return Ok(r),
            Err(_) => return Err(StatusCode::BAD_GATEWAY),
        }
    }
}

const TRANSPORT_RETRY_MS: [u64; 2] = [500, 1500];

async fn continue_recovery_delay(attempt: usize) {
    tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
}

pub fn current_upstream(id: &str) -> Option<Upstream> {
    url_map().lock().ok()?.get(id).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_map_keeps_every_cached_track() {
        let mut map = HashMap::new();
        for i in 0..MAX_DIRECT_URLS {
            map.insert(
                format!("id{i}"),
                Upstream {
                    url: format!("https://a.googlevideo.com/{i}"),
                    user_agent: "ua".into(),
                },
            );
            evict_oldest(&mut map);
        }
        assert_eq!(map.len(), MAX_DIRECT_URLS);
        assert!((0..MAX_DIRECT_URLS).all(|i| map.contains_key(&format!("id{i}"))));
    }

    #[test]
    fn video_map_leaves_audio_alone() {
        let up = |u: &str| Upstream {
            url: u.into(),
            user_agent: "ua".into(),
        };
        store_upstream("aaaaaaaaaaa", up("https://a.googlevideo.com/audio"));
        for (i, id) in [
            "aaaaaaaaaaa",
            "bbbbbbbbbbb",
            "ccccccccccc",
            "ddddddddddd",
            "eeeeeeeeeee",
        ]
        .iter()
        .enumerate()
        {
            store_video(id, up("https://a.googlevideo.com/video"), i as u64);
        }
        let audio = current_upstream("aaaaaaaaaaa").map(|u| u.url);
        assert_eq!(audio.as_deref(), Some("https://a.googlevideo.com/audio"));
        assert!(
            video_upstream("aaaaaaaaaaa").is_none(),
            "oldest video evicted"
        );
        assert_eq!(video_upstream("eeeeeeeeeee").map(|v| v.1), Some(4));
        assert_eq!(video_map().lock().unwrap().len(), MAX_VIDEO_URLS);
    }

    #[test]
    fn ranges_split_into_chunks() {
        assert_eq!(parse_range("bytes=0-"), Some((0, None)));
        assert_eq!(parse_range("bytes=100-199"), Some((100, Some(199))));
        assert_eq!(parse_range("bytes=5-1"), None);
        assert_eq!(parse_range("bytes=0-1,5-9"), None);
        assert_eq!(parse_range("bytes=-500"), None);
        assert_eq!(chunk_last(0, None), CHUNK - 1);
        assert_eq!(chunk_last(CHUNK, Some(CHUNK + 9)), CHUNK + 9);
        assert_eq!(parse_content_range("bytes 0-99/4000"), Some((0, 99, 4000)));
        assert_eq!(parse_content_range("bytes */4000"), None);
    }
}
