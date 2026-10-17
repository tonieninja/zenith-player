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
            eprintln!("[Zenith] innertube client {} key ok", next.client_version);
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

const MUSIC_HOST: &str = "music.youtube.com";
const MUSIC_ORIGIN: &str = "https://music.youtube.com";

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn sha1_hex(raw: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(raw.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn host_matches_cookie_domain(host: &str, domain: &str) -> bool {
    let host = host.trim().trim_start_matches('.').to_ascii_lowercase();
    let dom = domain.trim().trim_start_matches('.').to_ascii_lowercase();
    if host.is_empty() || dom.is_empty() {
        return false;
    }
    host == dom || host.ends_with(&format!(".{dom}"))
}

pub fn cookies_for_host<'a>(
    cookies: &[(&'a str, &'a str, &'a str)],
    host: &str,
) -> Vec<(&'a str, &'a str)> {
    use std::collections::HashMap;
    let mut best: HashMap<&str, (usize, &str)> = HashMap::new();
    for (name, value, domain) in cookies {
        if name.is_empty() || value.is_empty() {
            continue;
        }
        let spec = if domain.trim().is_empty() {
            0
        } else if host_matches_cookie_domain(host, domain) {
            domain.trim().trim_start_matches('.').len()
        } else {
            continue;
        };
        match best.get(name) {
            Some((prev, _)) if *prev > spec => {}
            Some((prev, _)) if *prev == spec && spec > 0 => {}
            _ => {
                best.insert(*name, (spec, *value));
            }
        }
    }
    let mut pairs: Vec<(&str, &str)> = best.into_iter().map(|(n, (_, v))| (n, v)).collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    pairs
}

pub fn music_cookie_header(cookies: &[(&str, &str, &str)]) -> String {
    cookies_for_host(cookies, MUSIC_HOST)
        .into_iter()
        .map(|(n, v)| format!("{n}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn header_value<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header.split(';').find_map(|part| {
        let part = part.trim();
        let (k, v) = part.split_once('=')?;
        if k.trim() == name {
            let v = v.trim();
            if v.is_empty() {
                None
            } else {
                Some(v)
            }
        } else {
            None
        }
    })
}

pub fn sapisid_authorization(cookie: &str, origin: &str, ts: u64) -> String {
    let mut parts = Vec::new();
    if let Some(v) =
        header_value(cookie, "SAPISID").or_else(|| header_value(cookie, "__Secure-3PAPISID"))
    {
        let hash = sha1_hex(&format!("{ts} {v} {origin}"));
        parts.push(format!("SAPISIDHASH {ts}_{hash}"));
    }
    if let Some(v) = header_value(cookie, "__Secure-1PAPISID") {
        let hash = sha1_hex(&format!("{ts} {v} {origin}"));
        parts.push(format!("SAPISID1PHASH {ts}_{hash}"));
    }
    if let Some(v) = header_value(cookie, "__Secure-3PAPISID") {
        let hash = sha1_hex(&format!("{ts} {v} {origin}"));
        parts.push(format!("SAPISID3PHASH {ts}_{hash}"));
    }
    parts.join(" ")
}

fn auth_cookie_score(header: &str) -> u32 {
    [
        "SAPISID",
        "__Secure-1PAPISID",
        "__Secure-3PAPISID",
        "__Secure-1PSID",
        "__Secure-3PSID",
        "SID",
        "HSID",
        "SSID",
        "LOGIN_INFO",
    ]
    .into_iter()
    .filter(|name| header_value(header, name).is_some())
    .count() as u32
}

fn cookies_from_session_file(app: &AppHandle) -> String {
    let Ok(dir) = app.path().app_data_dir() else {
        return String::new();
    };
    let path = dir.join("ytm_session.json");
    if !path.exists() {
        return String::new();
    }
    let Ok((raw, _)) = crate::secret_store::read_session(&path) else {
        return String::new();
    };
    #[derive(Deserialize)]
    struct FileCookie {
        name: String,
        value: String,
        #[serde(default)]
        domain: Option<String>,
    }
    let Ok(list) = serde_json::from_str::<Vec<FileCookie>>(&raw) else {
        return String::new();
    };
    let triples: Vec<(&str, &str, &str)> = list
        .iter()
        .map(|c| {
            (
                c.name.as_str(),
                c.value.as_str(),
                c.domain.as_deref().unwrap_or(""),
            )
        })
        .collect();
    music_cookie_header(&triples)
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

fn resolve_cookies(app: &AppHandle) -> String {
    let from_file = cookies_from_session_file(app);
    let cached = if let Ok(guard) = COOKIE_CACHE.lock() {
        guard.as_ref().map(|(c, _)| c.clone()).unwrap_or_default()
    } else {
        String::new()
    };

    if auth_cookie_score(&cached) > 0 {
        return cached;
    }
    if auth_cookie_score(&from_file) > 0 {
        warm_cookie_cache(from_file.clone());
        return from_file;
    }
    let merged = merge_cookie_headers(&from_file, &cached);
    if !merged.is_empty() {
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

pub fn warm_cookie_cache(cookie_header: String) {
    let score = auth_cookie_score(&cookie_header);
    if score == 0 {
        return;
    }
    if let Ok(mut guard) = COOKIE_CACHE.lock() {
        if let Some((existing, _)) = guard.as_ref() {
            if auth_cookie_score(existing) > score {
                return;
            }
        }
        *guard = Some((cookie_header, Instant::now()));
    }
}

static COOKIE_COLLECT_LOCK: Mutex<()> = Mutex::new(());

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
            if label == crate::potoken::LABEL {
                continue;
            }
            let mut triples: Vec<(String, String, String)> = Vec::new();
            let take = |c: tauri::webview::Cookie<'_>, into: &mut Vec<(String, String, String)>| {
                into.push((
                    c.name().to_string(),
                    c.value().to_string(),
                    c.domain().unwrap_or("").to_string(),
                ));
            };
            if let Ok(all) = webview.cookies() {
                for c in all {
                    take(c, &mut triples);
                }
            }
            if triples.is_empty() {
                for url in &urls {
                    if let Ok(cookies) = webview.cookies_for_url(url.clone()) {
                        for c in cookies {
                            take(c, &mut triples);
                        }
                    }
                }
            }
            if triples.is_empty() {
                continue;
            }
            let refs: Vec<(&str, &str, &str)> = triples
                .iter()
                .map(|(n, v, d)| (n.as_str(), v.as_str(), d.as_str()))
                .collect();
            let joined = music_cookie_header(&refs);
            let has_auth = auth_cookie_score(&joined) > 0;
            if has_auth {
                if label == "google-login"
                    && auth_cookie_score(&joined) >= auth_cookie_score(&login_auth)
                {
                    login_auth = joined.clone();
                }
                if auth_cookie_score(&joined) >= auth_cookie_score(&best_auth) {
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

fn parse_clock_duration(text: &str) -> Option<f64> {
    let raw = text.trim();
    let parts: Vec<&str> = raw.split(':').collect();
    if parts.len() != 2 && parts.len() != 3 {
        return None;
    }
    if !raw.chars().all(|c| c.is_ascii_digit() || c == ':') {
        return None;
    }
    if parts[0].is_empty() || parts.iter().skip(1).any(|p| p.len() != 2) {
        return None;
    }
    let nums: Option<Vec<f64>> = parts.iter().map(|p| p.parse::<f64>().ok()).collect();
    let nums = nums?;
    if nums.iter().any(|n| !n.is_finite()) {
        return None;
    }
    let sec = if nums.len() == 2 {
        nums[0] * 60.0 + nums[1]
    } else {
        nums[0] * 3600.0 + nums[1] * 60.0 + nums[2]
    };
    if sec > 0.0 {
        Some(sec)
    } else {
        None
    }
}

fn first_text(node: &Value) -> Option<String> {
    let text = runs_text(node);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn extract_duration_sec(r: &Value) -> Option<f64> {
    let paths = [
        "/lengthText",
        "/fixedColumns/0/musicResponsiveListItemFixedColumnRenderer/text",
        "/fixedColumns/1/musicResponsiveListItemFixedColumnRenderer/text",
        "/thumbnailOverlays/0/thumbnailOverlayTimeStatusRenderer/text",
        "/thumbnailOverlays/1/thumbnailOverlayTimeStatusRenderer/text",
    ];
    for path in paths {
        if let Some(text) = r.pointer(path).and_then(first_text) {
            if let Some(sec) = parse_clock_duration(&text) {
                return Some(sec);
            }
        }
    }
    None
}

fn with_duration(mut item: Value, r: &Value) -> Value {
    if let Some(sec) = extract_duration_sec(r) {
        item["durationSec"] = json!(sec);
    }
    item
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
    Some(with_duration(
        json!({
            "id": id,
            "type": kind,
            "title": title,
            "artist": if artist.is_empty() { "Various" } else { artist.as_str() },
            "cover": cover,
            "coverSmall": cover,
            "coverLarge": cover,
        }),
        r,
    ))
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
    Some(with_duration(
        json!({
            "id": id,
            "type": kind,
            "title": title,
            "artist": if artist.is_empty() { "Various" } else { artist.as_str() },
            "cover": cover,
            "coverSmall": cover,
            "coverLarge": cover,
        }),
        r,
    ))
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

pub fn resolve_cookies_public(app: &AppHandle) -> String {
    resolve_cookies(app)
}

pub fn clear_cookie_cache() {
    if let Ok(mut guard) = COOKIE_CACHE.lock() {
        *guard = None;
    }
}

#[tauri::command]
pub async fn ytm_browse(
    app: AppHandle,
    browse_id: String,
    hl: String,
    gl: String,
    params: Option<String>,
) -> Result<String, String> {
    hydrate_innertube(&app);
    let cookie = resolve_cookies(&app);
    let version = client_version();
    let mut body = json!({
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
    if let Some(params) = params.filter(|p| !p.trim().is_empty()) {
        body["params"] = json!(params);
    }

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
        .header(
            "Accept-Language",
            if hl.to_lowercase().starts_with("pl") {
                "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7"
            } else {
                "en-US,en;q=0.9,pl;q=0.7"
            },
        )
        .json(&body);

    if !cookie.is_empty() {
        req = req.header("Cookie", &cookie);
        let auth = sapisid_authorization(&cookie, MUSIC_ORIGIN, now_secs());
        if !auth.is_empty() {
            req = req
                .header("Authorization", auth)
                .header("X-Goog-AuthUser", "0");
        }
    }

    let res = match req.try_clone().map(|r| r.send()) {
        Some(fut) => match fut.await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[ytm_browse] send failed, retrying once: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                req.send().await.map_err(|e| format!("browse send: {e}"))?
            }
        },
        None => req.send().await.map_err(|e| format!("browse send: {e}"))?,
    };
    let status = res.status();
    let text = res.text().await.map_err(|e| format!("browse body: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "HTTP {status}: {}",
            text.chars().take(240).collect::<String>()
        ));
    }

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
        return Ok(json!({ "zenithSections": sections }).to_string());
    }

    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn music_host_ignores_google_and_www_only_cookies() {
        let cookies = [
            ("SAPISID", "google", ".google.com"),
            ("SAPISID", "www-only", "www.youtube.com"),
            ("SAPISID", "yt", "youtube.com"),
            ("__Secure-3PAPISID", "three", ".youtube.com"),
            ("SID", "gsid", ".google.com"),
        ];
        let h = music_cookie_header(&cookies);
        assert_eq!(h, "SAPISID=yt; __Secure-3PAPISID=three");
    }

    #[test]
    fn more_specific_domain_wins() {
        let cookies = [
            ("SAPISID", "broad", ".youtube.com"),
            ("SAPISID", "music", "music.youtube.com"),
        ];
        assert_eq!(music_cookie_header(&cookies), "SAPISID=music");
    }

    #[test]
    fn authorization_includes_1p_and_3p_hashes() {
        let cookie = "SAPISID=secret; __Secure-1PAPISID=one; __Secure-3PAPISID=three";
        let auth = sapisid_authorization(cookie, MUSIC_ORIGIN, 1_700_000_000);
        assert_eq!(
            auth,
            "SAPISIDHASH 1700000000_d2a0deeb95ea263a68778d9e9ac8840dce59d800 SAPISID1PHASH 1700000000_da24a2c934790185633fc7b6b66bd84107f1999e SAPISID3PHASH 1700000000_7761b97c35f7260402cc05c3109e7bd1aa1ebeca"
        );
    }

    #[test]
    fn authorization_falls_back_to_3p_when_sapisid_is_missing() {
        let cookie = "__Secure-3PAPISID=three";
        let auth = sapisid_authorization(cookie, MUSIC_ORIGIN, 1_700_000_000);
        assert!(auth.starts_with("SAPISIDHASH 1700000000_7761b97c35f7260402cc05c3109e7bd1aa1ebeca"));
        assert!(auth.contains("SAPISID3PHASH 1700000000_7761b97c35f7260402cc05c3109e7bd1aa1ebeca"));
    }

    #[test]
    fn clock_duration_parses_mmss_and_hhmmss() {
        assert_eq!(parse_clock_duration("3:21"), Some(201.0));
        assert_eq!(parse_clock_duration("1:02:03"), Some(3723.0));
        assert_eq!(parse_clock_duration("0:00"), None);
        assert_eq!(parse_clock_duration("2013"), None);
    }

    #[test]
    fn two_row_item_keeps_length_text() {
        let r = json!({
            "playlistItemData": { "videoId": "ZP69PLBqFUo" },
            "title": { "runs": [{ "text": "Get Lucky" }] },
            "subtitle": { "runs": [{ "text": "Daft Punk" }] },
            "lengthText": { "runs": [{ "text": "4:08" }] },
            "thumbnailRenderer": { "musicThumbnailRenderer": { "thumbnail": { "thumbnails": [] } } },
        });
        let item = item_from_two_row(&r).unwrap();
        assert_eq!(item["durationSec"], json!(248.0));
        assert_eq!(item["title"], json!("Get Lucky"));
    }
}
