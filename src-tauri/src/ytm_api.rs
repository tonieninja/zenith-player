//! youtube music innertube on the rust side, hard timeouts so home doesnt hang forever
use std::fs;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use tauri::{AppHandle, Manager};

const YTM_KEY_FALLBACK: &str = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";
const YTM_BROWSE: &str = "https://music.youtube.com/youtubei/v1/browse";
const YTM_HOME: &str = "https://music.youtube.com/";

static COOKIE_CACHE: Mutex<Option<(String, Instant)>> = Mutex::new(None);
const COOKIE_TTL: std::time::Duration = std::time::Duration::from_secs(120);

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct InnertubeConfig {
    pub client_version: String,
    #[serde(default)]
    pub api_key: String,
}

#[derive(Clone)]
pub struct InnertubeRefresh {
    pub client_version: String,
    pub api_key: String,
    pub updated: bool,
}

static INNERTUBE: Mutex<InnertubeConfig> = Mutex::new(InnertubeConfig {
    client_version: String::new(),
    api_key: String::new(),
});

fn date_client_version() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86400;
    let mut y = 1970i32;
    let mut rem = days as i32;
    loop {
        let diy = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
            366
        } else {
            365
        };
        if rem < diy {
            break;
        }
        rem -= diy;
        y += 1;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let months = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut m = 1;
    for dim in months {
        if rem < dim {
            break;
        }
        rem -= dim;
        m += 1;
    }
    let d = rem + 1;
    format!("1.{y:04}{m:02}{d:02}.01.00")
}

fn looks_like_client_version(s: &str) -> bool {
    let s = s.trim();
    if s.len() < 12 || !s.starts_with("1.") {
        return false;
    }
    s.chars().all(|c| c.is_ascii_digit() || c == '.')
}

fn looks_like_api_key(s: &str) -> bool {
    s.starts_with("AIza") && s.len() >= 20 && s.len() < 80
}

fn extract_quoted_field(html: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let i = html.find(&needle)?;
    let rest = html[i + needle.len()..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    let val = rest[..end].trim();
    if val.is_empty() {
        None
    } else {
        Some(val.to_string())
    }
}

fn innertube_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join("innertube.json"))
}

fn store_innertube(cfg: InnertubeConfig) {
    if let Ok(mut g) = INNERTUBE.lock() {
        if !cfg.client_version.is_empty() {
            g.client_version = cfg.client_version;
        }
        if !cfg.api_key.is_empty() {
            g.api_key = cfg.api_key;
        }
    }
}

pub fn current_innertube() -> InnertubeConfig {
    let mut cfg = INNERTUBE.lock().map(|g| g.clone()).unwrap_or_default();
    if cfg.client_version.is_empty() {
        cfg.client_version = date_client_version();
    }
    if cfg.api_key.is_empty() {
        cfg.api_key = YTM_KEY_FALLBACK.to_string();
    }
    cfg
}

fn persist_innertube(app: &AppHandle, cfg: &InnertubeConfig) {
    let Some(path) = innertube_path(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(cfg) {
        let _ = fs::write(path, json);
    }
}

pub fn hydrate_innertube(app: &AppHandle) {
    let Some(path) = innertube_path(app) else {
        return;
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return;
    };
    let Ok(cfg) = serde_json::from_str::<InnertubeConfig>(&raw) else {
        return;
    };
    store_innertube(cfg);
}

fn scrape_innertube_html(html: &str) -> InnertubeConfig {
    let mut cfg = InnertubeConfig::default();
    if let Some(v) = extract_quoted_field(html, "INNERTUBE_CLIENT_VERSION") {
        if looks_like_client_version(&v) {
            cfg.client_version = v;
        }
    }
    if cfg.client_version.is_empty() {
        if let Some(v) = extract_quoted_field(html, "clientVersion") {
            if looks_like_client_version(&v) {
                cfg.client_version = v;
            }
        }
    }
    if let Some(k) = extract_quoted_field(html, "INNERTUBE_API_KEY") {
        if looks_like_api_key(&k) {
            cfg.api_key = k;
        }
    }
    cfg
}

pub fn refresh_innertube(app: &AppHandle) -> InnertubeRefresh {
    hydrate_innertube(app);
    let before = current_innertube();
    let fetched = (|| -> Option<InnertubeConfig> {
        let client = reqwest::blocking::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
            .timeout(Duration::from_secs(18))
            .redirect(reqwest::redirect::Policy::limited(8))
            .build()
            .ok()?;
        let html = client
            .get(YTM_HOME)
            .header("Accept-Language", "en-US,en;q=0.9")
            .send()
            .ok()?
            .error_for_status()
            .ok()?
            .text()
            .ok()?;
        let scraped = scrape_innertube_html(&html);
        if scraped.client_version.is_empty() && scraped.api_key.is_empty() {
            None
        } else {
            Some(scraped)
        }
    })();

    let mut updated = false;
    if let Some(scraped) = fetched {
        let mut next = before.clone();
        if !scraped.client_version.is_empty() && scraped.client_version != before.client_version {
            next.client_version = scraped.client_version;
            updated = true;
        }
        if !scraped.api_key.is_empty() && scraped.api_key != before.api_key {
            next.api_key = scraped.api_key;
            updated = true;
        }
        if next.client_version.is_empty() {
            next.client_version = date_client_version();
        }
        if next.api_key.is_empty() {
            next.api_key = YTM_KEY_FALLBACK.to_string();
        }
        store_innertube(next.clone());
        persist_innertube(app, &next);
        if updated {
            eprintln!(
                "[Zenith] innertube client {} key {}",
                next.client_version, "ok"
            );
        }
        return InnertubeRefresh {
            client_version: next.client_version,
            api_key: next.api_key,
            updated,
        };
    }

    InnertubeRefresh {
        client_version: before.client_version,
        api_key: before.api_key,
        updated: false,
    }
}

fn client_version() -> String {
    current_innertube().client_version
}

fn innertube_api_key() -> String {
    current_innertube().api_key
}

fn extract_sapisid(cookie: &str) -> Option<String> {
    for part in cookie.split(';') {
        let p = part.trim();
        if let Some(v) = p.strip_prefix("SAPISID=") {
            return Some(v.to_string());
        }
        if let Some(v) = p.strip_prefix("__Secure-3PAPISID=") {
            return Some(v.to_string());
        }
    }
    None
}

fn sapisidhash(sapisid: &str) -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let origin = "https://music.youtube.com";
    let raw = format!("{ts} {sapisid} {origin}");
    let mut hasher = Sha1::new();
    hasher.update(raw.as_bytes());
    let hash = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    format!("SAPISIDHASH {ts}_{hash}")
}

fn cookies_from_session_file(app: &AppHandle) -> String {
    let Ok(dir) = app.path().app_data_dir() else {
        return String::new();
    };
    let path = dir.join("ytm_session.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let Ok(list) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) else {
        return String::new();
    };
    list.iter()
        .filter_map(|c| {
            let name = c.get("name")?.as_str()?;
            let value = c.get("value")?.as_str()?;
            Some(format!("{name}={value}"))
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn merge_cookie_headers(a: &str, b: &str) -> String {
    use std::collections::HashMap;
    let mut map: HashMap<&str, &str> = HashMap::new();
    for header in [a, b] {
        for part in header.split(';') {
            let part = part.trim();
            if let Some((k, v)) = part.split_once('=') {
                let k = k.trim();
                let v = v.trim();
                if !k.is_empty() && !v.is_empty() {
                    map.insert(k, v);
                }
            }
        }
    }
    map.into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// grab cookies without poking the webview thread, that deadlocks tauri ipc
fn resolve_cookies(app: &AppHandle) -> String {
    let from_file = cookies_from_session_file(app);
    let cached = if let Ok(guard) = COOKIE_CACHE.lock() {
        guard.as_ref().map(|(c, _)| c.clone()).unwrap_or_default()
    } else {
        String::new()
    };

    let merged = merge_cookie_headers(&from_file, &cached);
    if !merged.is_empty() {
        if let Ok(mut guard) = COOKIE_CACHE.lock() {
            *guard = Some((merged.clone(), Instant::now()));
        }
        return merged;
    }

    if let Ok(guard) = COOKIE_CACHE.lock() {
        if let Some((cookie, at)) = guard.as_ref() {
            if at.elapsed() < COOKIE_TTL && !cookie.is_empty() {
                return cookie.clone();
            }
        }
        if let Some((cookie, _)) = guard.as_ref() {
            if !cookie.is_empty() {
                return cookie.clone();
            }
        }
    }
    String::new()
}

/// stuff cookies into the ram cache right after login capture
pub fn warm_cookie_cache(cookie_header: String) {
    if cookie_header.is_empty() {
        return;
    }
    let has_auth = cookie_header.contains("SAPISID=")
        || cookie_header.contains("__Secure-3PAPISID=")
        || cookie_header.contains("__Secure-1PAPISID=")
        || cookie_header.contains("__Secure-1PSID=")
        || cookie_header.contains("__Secure-3PSID=");
    if !has_auth {
        return;
    }
    if let Ok(mut guard) = COOKIE_CACHE.lock() {
        *guard = Some((cookie_header, Instant::now()));
    }
}

static COOKIE_COLLECT_LOCK: Mutex<()> = Mutex::new(());

/// pull cookies from the webview, login/sync only, never from browse or home freezes
pub fn refresh_cookie_cache_from_webview(app: &AppHandle) {
    let _guard = match COOKIE_COLLECT_LOCK.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let cookie = collect_cookies_sync(app);
    warm_cookie_cache(cookie);
}

fn collect_cookies_sync(app: &AppHandle) -> String {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let urls: Vec<tauri::Url> = [
            "https://music.youtube.com/",
            "https://www.youtube.com/",
            "https://youtube.com/",
            "https://accounts.google.com/",
            "https://www.google.com/",
        ]
        .iter()
        .filter_map(|s| s.parse().ok())
        .collect();
        let mut best_auth = String::new();
        let mut best_other = String::new();
        let mut login_auth = String::new();
        for (label, webview) in handle.webview_windows() {
            let mut joined_parts: Vec<String> = Vec::new();
            if let Ok(all) = webview.cookies() {
                for c in all {
                    joined_parts.push(format!("{}={}", c.name(), c.value()));
                }
            }
            if joined_parts.is_empty() {
                for url in &urls {
                    if let Ok(cookies) = webview.cookies_for_url(url.clone()) {
                        for c in cookies {
                            joined_parts.push(format!("{}={}", c.name(), c.value()));
                        }
                    }
                }
            }
            if joined_parts.is_empty() {
                continue;
            }
            let joined = joined_parts.join("; ");
            let has_auth = joined.contains("SAPISID=")
                || joined.contains("__Secure-3PAPISID=")
                || joined.contains("__Secure-1PAPISID=");
            if has_auth {
                if label == "google-login" && joined.len() > login_auth.len() {
                    login_auth = joined.clone();
                }
                if joined.len() > best_auth.len() {
                    best_auth = joined;
                }
            } else if joined.len() > best_other.len() {
                best_other = joined;
            }
        }
        let best = if !login_auth.is_empty() {
            login_auth
        } else if !best_auth.is_empty() {
            best_auth
        } else {
            best_other
        };
        let _ = tx.send(best);
    });
    rx.recv_timeout(std::time::Duration::from_millis(2000))
        .unwrap_or_default()
}

fn runs_text(node: &Value) -> String {
    if let Some(runs) = node.get("runs").and_then(|r| r.as_array()) {
        return runs
            .iter()
            .filter_map(|r| r.get("text").and_then(|t| t.as_str()))
            .collect::<String>();
    }
    node.get("simpleText")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string()
}

fn best_thumb(thumbs: &Value) -> String {
    let Some(arr) = thumbs.as_array() else {
        return String::new();
    };
    arr.iter()
        .rev()
        .find_map(|t| t.get("url").and_then(|u| u.as_str()).map(|s| s.to_string()))
        .unwrap_or_default()
}

fn item_from_two_row(r: &Value) -> Option<Value> {
    let video_id = r
        .pointer("/playlistItemData/videoId")
        .or_else(|| r.pointer("/navigationEndpoint/watchEndpoint/videoId"))
        .and_then(|v| v.as_str());
    let browse_id = r
        .pointer("/navigationEndpoint/browseEndpoint/browseId")
        .and_then(|v| v.as_str());
    let id = video_id.or(browse_id)?;
    let title = runs_text(r.get("title").unwrap_or(&Value::Null));
    if title.is_empty() {
        return None;
    }
    let artist = runs_text(r.get("subtitle").unwrap_or(&Value::Null));
    let cover = best_thumb(
        r.pointer("/thumbnailRenderer/musicThumbnailRenderer/thumbnail/thumbnails")
            .unwrap_or(&Value::Null),
    );
    let kind = if video_id.is_some() {
        "track"
    } else if id.starts_with("VL") || id.starts_with("PL") || id.starts_with("MPSP") {
        "playlist"
    } else if id.starts_with("UC") {
        "artist"
    } else {
        "album"
    };
    Some(json!({
        "id": id,
        "type": kind,
        "title": title,
        "artist": if artist.is_empty() { "Various" } else { artist.as_str() },
        "cover": cover,
        "coverSmall": cover,
        "coverLarge": cover,
    }))
}

fn item_from_responsive(r: &Value) -> Option<Value> {
    let video_id = r
        .pointer("/playlistItemData/videoId")
        .or_else(|| r.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/navigationEndpoint/watchEndpoint/videoId"))
        .or_else(|| r.pointer("/navigationEndpoint/watchEndpoint/videoId"))
        .and_then(|v| v.as_str());
    let browse_id = r
        .pointer("/navigationEndpoint/browseEndpoint/browseId")
        .or_else(|| r.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/navigationEndpoint/browseEndpoint/browseId"))
        .and_then(|v| v.as_str());
    let id = video_id.or(browse_id)?;
    let title = r
        .pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text")
        .map(runs_text)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| runs_text(r.get("title").unwrap_or(&Value::Null)));
    if title.is_empty() {
        return None;
    }
    let artist = r
        .pointer("/flexColumns/1/musicResponsiveListItemFlexColumnRenderer/text")
        .map(runs_text)
        .unwrap_or_default();
    let cover = best_thumb(
        r.pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails")
            .or_else(|| r.pointer("/thumbnailRenderer/musicThumbnailRenderer/thumbnail/thumbnails"))
            .unwrap_or(&Value::Null),
    );
    let kind = if video_id.is_some() {
        "track"
    } else if id.starts_with("VL") || id.starts_with("PL") || id.starts_with("MPSP") {
        "playlist"
    } else if id.starts_with("UC") {
        "artist"
    } else {
        "album"
    };
    Some(json!({
        "id": id,
        "type": kind,
        "title": title,
        "artist": if artist.is_empty() { "Various" } else { artist.as_str() },
        "cover": cover,
        "coverSmall": cover,
        "coverLarge": cover,
    }))
}

fn push_shelf(title: String, contents: &Value, out: &mut Vec<Value>) {
    let Some(arr) = contents.as_array() else {
        return;
    };
    let mut items = Vec::new();
    for c in arr {
        if let Some(r) = c.get("musicTwoRowItemRenderer") {
            if let Some(item) = item_from_two_row(r) {
                items.push(item);
            }
        } else if let Some(r) = c.get("musicResponsiveListItemRenderer") {
            if let Some(item) = item_from_responsive(r).or_else(|| item_from_two_row(r)) {
                items.push(item);
            }
        } else if let Some(r) = c.get("richItemRenderer") {
            let inner = r.get("content").unwrap_or(r);
            if let Some(two) = inner.get("musicTwoRowItemRenderer") {
                if let Some(item) = item_from_two_row(two) {
                    items.push(item);
                }
            } else if let Some(resp) = inner.get("musicResponsiveListItemRenderer") {
                if let Some(item) = item_from_responsive(resp).or_else(|| item_from_two_row(resp)) {
                    items.push(item);
                }
            }
        }
    }
    if !items.is_empty() {
        out.push(json!({ "title": title, "items": items }));
    }
}

fn walk_carousels(node: &Value, out: &mut Vec<Value>) {
    match node {
        Value::Array(arr) => {
            for v in arr {
                walk_carousels(v, out);
            }
        }
        Value::Object(map) => {
            if let Some(carousel) = map.get("musicCarouselShelfRenderer") {
                let title = carousel
                    .pointer("/header/musicCarouselShelfBasicHeaderRenderer/title")
                    .map(runs_text)
                    .filter(|s| !s.is_empty())
                    .or_else(|| carousel.get("title").map(runs_text))
                    .unwrap_or_else(|| "Section".into());
                push_shelf(title, carousel.get("contents").unwrap_or(&Value::Null), out);
            }
            if let Some(shelf) = map.get("musicShelfRenderer") {
                let title = shelf
                    .get("title")
                    .map(runs_text)
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "Section".into());
                push_shelf(title, shelf.get("contents").unwrap_or(&Value::Null), out);
            }
            if let Some(shelf) = map.get("musicPlaylistShelfRenderer") {
                let title = shelf
                    .get("title")
                    .map(runs_text)
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "Playlists".into());
                push_shelf(title, shelf.get("contents").unwrap_or(&Value::Null), out);
            }
            if let Some(grid) = map.get("musicGridRenderer") {
                let title = grid
                    .pointer("/header/musicHeaderRenderer/title")
                    .map(runs_text)
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "Section".into());
                push_shelf(title, grid.get("contents").unwrap_or(&Value::Null), out);
            }
            if let Some(grid) = map.get("gridRenderer") {
                let title = grid
                    .pointer("/header/gridHeaderRenderer/title")
                    .map(runs_text)
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "Section".into());
                push_shelf(title, grid.get("items").unwrap_or(&Value::Null), out);
            }
            for v in map.values() {
                walk_carousels(v, out);
            }
        }
        _ => {}
    }
}

/// same as resolve_cookies but commands can call it without main-thread io
pub fn resolve_cookies_public(app: &AppHandle) -> String {
    resolve_cookies(app)
}

pub fn clear_cookie_cache() {
    if let Ok(mut guard) = COOKIE_CACHE.lock() {
        *guard = None;
    }
}

/// browse ytm, home comes back as compact shelves so ipc doesnt choke on a megabyte of json
#[tauri::command]
pub async fn ytm_browse(
    app: AppHandle,
    browse_id: String,
    hl: String,
    gl: String,
) -> Result<String, String> {
    // dont block the webview thread from inside an invoke, home deadlocks if you do
    hydrate_innertube(&app);
    let cookie = resolve_cookies(&app);
    let version = client_version();
    let body = json!({
        "context": {
            "client": {
                "clientName": "WEB_REMIX",
                "clientVersion": version,
                "hl": hl,
                "gl": gl,
            }
        },
        "browseId": browse_id,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{YTM_BROWSE}?prettyPrint=false&key={}", innertube_api_key());
    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Origin", "https://music.youtube.com")
        .header("X-Origin", "https://music.youtube.com")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        )
        .json(&body);

    if !cookie.is_empty() {
        req = req.header("Cookie", &cookie);
        if let Some(sapi) = extract_sapisid(&cookie) {
            req = req
                .header("Authorization", sapisidhash(&sapi))
                .header("X-Goog-AuthUser", "0");
        }
    }

    let res = req.send().await.map_err(|e| format!("browse send: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| format!("browse body: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "HTTP {status}: {}",
            text.chars().take(240).collect::<String>()
        ));
    }

    // peel shelves out here, raw browse payloads are stupid huge
    let data: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if data.get("error").is_some() {
        return Err(format!(
            "ytm error: {}",
            data.get("error").unwrap_or(&Value::Null)
        ));
    }
    let mut sections = Vec::new();
    walk_carousels(&data, &mut sections);
    if !sections.is_empty() {
        #[cfg(feature = "qa")]
        {
            let dir = app
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let _ = std::fs::create_dir_all(&dir);
            let meta =
                json!({ "browseId": browse_id, "sections": sections.len(), "rawLen": text.len() });
            let _ = std::fs::write(dir.join("browse_rust_meta.json"), meta.to_string());
        }
        return Ok(json!({ "zenithSections": sections }).to_string());
    }

    Ok(text)
}
