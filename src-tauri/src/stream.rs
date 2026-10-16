use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{command, AppHandle, Manager};

use crate::player::{self, Auth, Client, DirectAudio};
use crate::resolve_plan::{self, Step};
use crate::stream_proxy;
use crate::ytm_api;

type StreamCache = Mutex<HashMap<String, (String, String, u64)>>;

static STREAM_CACHE: OnceLock<StreamCache> = OnceLock::new();

fn get_cache() -> &'static StreamCache {
    STREAM_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn url_expiry(url: &str) -> Option<u64> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == "expire").then(|| v.parse::<u64>().ok()).flatten()
    })
}

fn cache_fresh(url: &str, fetched_at: u64, now: u64) -> bool {
    match url_expiry(url) {
        Some(exp) => now + 600 < exp && now.saturating_sub(fetched_at) < 3 * 3600,
        None => now.saturating_sub(fetched_at) < 240,
    }
}

fn validate_video_id(video_id: &str) -> Result<(), String> {
    if video_id.len() == 11
        && video_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Ok(())
    } else {
        Err("invalid video id".into())
    }
}

static APP: OnceLock<AppHandle> = OnceLock::new();

pub const RECOVERY_ATTEMPTS: usize = resolve_plan::RECOVERY.len();

static PREFERRED: Mutex<Option<Client>> = Mutex::new(None);
static PREFERRED_LOADED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    if let Ok(dir) = app.path().app_local_data_dir() {
        crate::player_js::init(dir.join("player-js"));
        for old in ["yt-dlp-cache", "bin"] {
            let p = dir.join(old);
            if p.is_dir() {
                std::thread::spawn(move || {
                    let _ = std::fs::remove_dir_all(p);
                });
            }
        }
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn pref_file() -> Option<std::path::PathBuf> {
    Some(
        APP.get()?
            .path()
            .app_local_data_dir()
            .ok()?
            .join("stream-client.txt"),
    )
}

fn preferred_client() -> Option<Client> {
    if !PREFERRED_LOADED.swap(true, Ordering::SeqCst) {
        if let Some(c) = pref_file()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| resolve_plan::by_name(&s))
        {
            if let Ok(mut g) = PREFERRED.lock() {
                g.get_or_insert(c);
            }
        }
    }
    PREFERRED.lock().ok().and_then(|g| *g)
}

fn set_preferred(c: Client) {
    if c == Client::Visionos || player::spec(c).needs_pot {
        return;
    }
    if let Ok(mut g) = PREFERRED.lock() {
        if *g == Some(c) {
            return;
        }
        *g = Some(c);
    }
    if let Some(p) = pref_file() {
        let _ = std::fs::write(p, resolve_plan::name(c));
    }
}

fn auth() -> Option<Auth> {
    let app = APP.get()?;
    let mut a = Auth::from_cookie_header(&ytm_api::resolve_cookies_public(app))?;
    a.data_sync_id = data_sync_id(&a.cookie);
    Some(a)
}

static DATASYNC: Mutex<Option<(u64, String, u64)>> = Mutex::new(None);

fn cookie_fingerprint(cookie: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    cookie.hash(&mut h);
    h.finish()
}

fn data_sync_id(cookie: &str) -> Option<String> {
    let fp = cookie_fingerprint(cookie);
    let g = DATASYNC.lock().ok()?;
    g.as_ref()
        .filter(|(f, _, at)| *f == fp && now_secs().saturating_sub(*at) < 6 * 3600)
        .map(|(_, id, _)| id.clone())
}

pub fn parse_data_sync_id(page: &str) -> Option<String> {
    let i = page.find("\"DATASYNC_ID\":\"")?;
    let rest = &page[i + 15..];
    let raw = &rest[..rest.find('"')?];
    let id = raw.split("||").next()?.trim();
    (!id.is_empty() && id.len() < 200).then(|| id.to_string())
}

async fn warm_data_sync_id(a: &Auth) -> Option<String> {
    if let Some(id) = a.data_sync_id.clone() {
        return Some(id);
    }
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(crate::login_nav::user_agent())
        .build()
        .ok()?;
    let page = http
        .get("https://music.youtube.com/")
        .header("Cookie", a.cookie.as_str())
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    let id = parse_data_sync_id(&page)?;
    if let Ok(mut g) = DATASYNC.lock() {
        *g = Some((cookie_fingerprint(&a.cookie), id.clone(), now_secs()));
    }
    Some(id)
}

async fn run_clients(
    video_id: &str,
    clients: &[Client],
    auth: Option<&Auth>,
) -> Option<DirectAudio> {
    let mut a = auth.cloned();
    if let Some(x) = a.as_mut() {
        if clients.iter().any(|c| player::spec(*c).needs_pot) {
            x.data_sync_id = warm_data_sync_id(x).await;
        }
    }
    let (got, c) = player::resolve_with(video_id, clients, a.as_ref()).await?;
    if auth.is_none() {
        set_preferred(c);
    }
    Some(got)
}

pub async fn recover_upstream(
    video_id: &str,
    attempt: usize,
    failed_url: &str,
) -> Option<stream_proxy::Upstream> {
    APP.get()?;
    let clients = *resolve_plan::RECOVERY.get(attempt)?;
    let lock = resolve_lock(video_id);
    let _held = lock.lock().await;
    if let Some(cur) = stream_proxy::current_upstream(video_id) {
        if cur.url != failed_url {
            return Some(cur);
        }
    }
    crate::potoken::want();
    let signed = attempt + 1 == resolve_plan::RECOVERY.len();
    let a = if signed { auth() } else { None };
    if signed && a.is_none() {
        return None;
    }
    let got = run_clients(video_id, clients, a.as_ref()).await?;
    if got.url == failed_url {
        return None;
    }
    eprintln!("[Zenith] stream recovered for {video_id} (client set {attempt})");
    let _ = remember_and_proxy(video_id, &got.url, &got.user_agent, now_secs());
    Some(stream_proxy::Upstream {
        url: got.url,
        user_agent: got.user_agent,
    })
}

static LAST_FAILURE: Mutex<Option<&'static str>> = Mutex::new(None);

pub(crate) fn note_failure(kind: &'static str) {
    if let Ok(mut g) = LAST_FAILURE.lock() {
        let rank = |k: &str| match k {
            "component" => 4,
            "network" => 3,
            "bot" => 2,
            _ => 1,
        };
        if g.map(|o| rank(kind) >= rank(o)).unwrap_or(true) {
            *g = Some(kind);
        }
    }
}

#[tauri::command]
pub fn stream_last_failure() -> Option<String> {
    LAST_FAILURE
        .lock()
        .ok()
        .and_then(|g| g.map(|s| s.to_string()))
}

pub fn evict_cached_url(video_id: &str) {
    if let Ok(mut cache) = get_cache().lock() {
        cache.remove(video_id);
    }
    stream_proxy::remove_direct_url(video_id);
}

pub fn wipe_netscape_cookie_file(app: &AppHandle) {
    if let Ok(dir) = app.path().app_local_data_dir() {
        let path = dir.join("bin").join("youtube-cookies.txt");
        let _ = std::fs::remove_file(path);
    }
}

fn remember_and_proxy(
    video_id: &str,
    url: &str,
    user_agent: &str,
    now: u64,
) -> Result<String, String> {
    let mut cache = get_cache()
        .lock()
        .map_err(|e| format!("Cache lock error: {}", e))?;
    if let Some((_, _, ts)) = cache.get(video_id) {
        if *ts > now {
            if let Some(proxy) = stream_proxy::proxy_url(video_id) {
                return Ok(proxy);
            }
        }
    }
    stream_proxy::store_upstream(
        video_id,
        stream_proxy::Upstream {
            url: url.to_string(),
            user_agent: user_agent.to_string(),
        },
    );
    cache.insert(
        video_id.to_string(),
        (url.to_string(), user_agent.to_string(), now),
    );
    while cache.len() > 64 {
        let oldest = cache
            .iter()
            .min_by_key(|(_, (_, _, ts))| *ts)
            .map(|(k, _)| k.clone());
        if let Some(k) = oldest {
            stream_proxy::remove_direct_url(&k);
            cache.remove(&k);
        } else {
            break;
        }
    }
    drop(cache);
    stream_proxy::proxy_url(video_id).ok_or_else(|| "stream proxy not ready".to_string())
}

#[derive(Serialize)]
pub struct SearchHit {
    id: String,
    title: String,
    artist: String,
    cover: String,
    cover_small: String,
    cover_large: String,
}

type ResolveLocks = Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>;

fn resolve_lock(video_id: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<ResolveLocks> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = locks.lock().unwrap_or_else(|e| e.into_inner());
    map.retain(|_, l| std::sync::Arc::strong_count(l) > 1);
    map.entry(video_id.to_string())
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

const INNERTUBE_HEAD_START_MS: u64 = 2500;
static INNERTUBE_MISS: AtomicU64 = AtomicU64::new(0);

pub fn innertube_struggling() -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let at = INNERTUBE_MISS.load(Ordering::SeqCst);
    at > 0 && now.saturating_sub(at) < 15 * 60
}

type UpstreamFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Option<stream_proxy::Upstream>> + Send>>;

pub fn upstream_on_demand(video_id: String) -> UpstreamFuture {
    Box::pin(async move {
        let app = APP.get()?.clone();
        get_stream_url(app, video_id.clone(), None).await.ok()??;
        stream_proxy::current_upstream(&video_id)
    })
}

#[command]
pub async fn get_stream_url(
    app: AppHandle,
    video_id: String,
    fresh: Option<bool>,
) -> Result<Option<String>, String> {
    validate_video_id(&video_id)?;
    if !fresh.unwrap_or(false) && crate::downloads::is_downloaded(&video_id) {
        crate::stream_proxy::ensure_ready().await?;
        if let Some(u) = crate::stream_proxy::offline_url(&video_id) {
            return Ok(Some(u));
        }
    }
    let _ = APP.set(app.clone());
    let lock = resolve_lock(&video_id);
    let started = std::time::Instant::now();
    let _held = lock.lock().await;
    let waited = started.elapsed() > Duration::from_millis(200);
    let vid = video_id.clone();
    let r = get_stream_url_locked(app, video_id, fresh.filter(|f| *f && !waited)).await;
    crate::timeline::mark(format!(
        "get_stream_url end {vid} ok={}",
        matches!(r, Ok(Some(_)))
    ));
    r
}

async fn get_stream_url_locked(
    app: AppHandle,
    video_id: String,
    fresh: Option<bool>,
) -> Result<Option<String>, String> {
    stream_proxy::ensure_ready().await?;
    let now = now_secs();
    let force = fresh.unwrap_or(false);
    if force {
        evict_cached_url(&video_id);
    }

    if !force {
        let cache = get_cache()
            .lock()
            .map_err(|e| format!("Cache lock error: {}", e))?;
        if let Some((url, ua, timestamp)) = cache.get(&video_id) {
            if cache_fresh(url, *timestamp, now) {
                stream_proxy::store_upstream(
                    &video_id,
                    stream_proxy::Upstream {
                        url: url.clone(),
                        user_agent: ua.clone(),
                    },
                );
                if let Some(proxy) = stream_proxy::proxy_url(&video_id) {
                    return Ok(Some(proxy));
                }
            }
        }
    }
    let _ = app;
    if let Ok(mut g) = LAST_FAILURE.lock() {
        *g = None;
    }
    let struggling = innertube_struggling();
    let head_start = if struggling {
        0
    } else {
        INNERTUBE_HEAD_START_MS
    };
    let innertube = player::fetch_direct_audio(&video_id);
    tokio::pin!(innertube);
    let mut it_done = false;
    tokio::select! {
        r = &mut innertube => {
            it_done = true;
            if let Some(got) = r {
                crate::timeline::mark(format!("layer innertube {video_id}"));
                return remember_and_proxy(&video_id, &got.url, &got.user_agent, now).map(Some);
            }
        }
        _ = tokio::time::sleep(Duration::from_millis(head_start)) => {}
    }
    INNERTUBE_MISS.store(now.max(1), Ordering::SeqCst);
    let signed = auth();
    let mut second: Vec<Client> = Vec::new();
    if let Some(p) = preferred_client() {
        second.push(p);
    }
    for c in resolve_plan::GUEST_JS {
        if !second.contains(c) {
            second.push(*c);
        }
    }
    let vid = video_id.clone();
    let js_layer = async move {
        if let Some(got) = run_clients(&vid, &second, None).await {
            return Some(got);
        }
        let a = auth()?;
        run_clients(&vid, resolve_plan::SIGNED_IN, Some(&a)).await
    };
    tokio::pin!(js_layer);
    let mut js_done = false;
    while !(js_done && it_done) {
        tokio::select! {
            r = &mut js_layer, if !js_done => {
                js_done = true;
                if let Some(got) = r {
                    crate::timeline::mark(format!("layer js {video_id}"));
                    return remember_and_proxy(&video_id, &got.url, &got.user_agent, now).map(Some);
                }
            }
            r = &mut innertube, if !it_done => {
                it_done = true;
                if let Some(got) = r {
                    crate::timeline::mark(format!("layer innertube {video_id}"));
                    return remember_and_proxy(&video_id, &got.url, &got.user_agent, now).map(Some);
                }
            }
        }
    }

    if let Some(got) = escalate(&video_id, signed).await {
        crate::timeline::mark(format!("layer escalation {video_id}"));
        return remember_and_proxy(&video_id, &got.url, &got.user_agent, now).map(Some);
    }
    note_failure(if player::bot_blocked() {
        "bot"
    } else {
        "unavailable"
    });
    Ok(None)
}

async fn escalate(video_id: &str, signed: Option<Auth>) -> Option<DirectAudio> {
    let deadline = std::time::Instant::now() + Duration::from_secs(45);
    crate::potoken::want();
    let pot = crate::potoken::wait_ready(Duration::from_secs(8)).await;
    for (round, delay) in resolve_plan::retry_delays_ms().iter().enumerate() {
        if std::time::Instant::now() >= deadline {
            break;
        }
        if *delay > 0 {
            tokio::time::sleep(Duration::from_millis(*delay)).await;
        }
        if round > 0 {
            player::fresh_start();
            crate::player_js::forget();
        }
        if let Some(got) = player::fetch_direct_audio(video_id).await {
            return Some(got);
        }
        let steps = resolve_plan::escalation(signed.is_some(), pot && crate::potoken::ready());
        for step in steps {
            if std::time::Instant::now() >= deadline {
                break;
            }
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            let fut = async {
                match step {
                    Step::Guest(c) => run_clients(video_id, c, None).await,
                    Step::SignedIn(c) => run_clients(video_id, c, signed.as_ref()).await,
                }
            };
            if let Ok(Some(got)) = tokio::time::timeout(left, fut).await {
                return Some(got);
            }
        }
    }
    None
}

#[command]
pub fn clear_stream_cache() {
    if let Ok(mut cache) = get_cache().lock() {
        for key in cache.keys().cloned().collect::<Vec<_>>() {
            stream_proxy::remove_direct_url(&key);
        }
        cache.clear();
    }
    stream_proxy::clear_all_direct_urls();
}

pub fn parse_length(s: &str) -> Option<f64> {
    let mut total = 0f64;
    let mut any = false;
    for part in s.trim().split(':') {
        let n: f64 = part.trim().parse().ok()?;
        total = total * 60.0 + n;
        any = true;
    }
    any.then_some(total)
}

fn text_of(v: &Value) -> Option<String> {
    if let Some(s) = v.get("simpleText").and_then(|x| x.as_str()) {
        return Some(s.to_string());
    }
    let runs = v.get("runs")?.as_array()?;
    let s: String = runs
        .iter()
        .filter_map(|r| r.get("text").and_then(|t| t.as_str()))
        .collect();
    (!s.is_empty()).then_some(s)
}

fn collect_videos<'a>(v: &'a Value, out: &mut Vec<&'a Value>) {
    match v {
        Value::Object(m) => {
            if let Some(r) = m.get("videoRenderer") {
                out.push(r);
                return;
            }
            for x in m.values() {
                collect_videos(x, out);
            }
        }
        Value::Array(a) => {
            for x in a {
                collect_videos(x, out);
            }
        }
        _ => {}
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub id: String,
    pub title: String,
    pub channel: String,
    pub duration: Option<f64>,
}

pub fn parse_search(data: &Value) -> Vec<Found> {
    let mut list = Vec::new();
    collect_videos(data, &mut list);
    list.into_iter()
        .filter_map(|r| {
            let id = r.get("videoId")?.as_str()?.to_string();
            validate_video_id(&id).ok()?;
            let title = r.get("title").and_then(text_of).unwrap_or_default();
            let channel = r
                .get("ownerText")
                .or_else(|| r.get("longBylineText"))
                .or_else(|| r.get("shortBylineText"))
                .and_then(text_of)
                .unwrap_or_default();
            let duration = r
                .get("lengthText")
                .and_then(text_of)
                .and_then(|t| parse_length(&t));
            Some(Found {
                id,
                title,
                channel,
                duration,
            })
        })
        .collect()
}

pub async fn yt_search(query: &str, limit: usize) -> Result<Vec<Found>, String> {
    let spec = player::spec(Client::Web);
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent(spec.user_agent)
        .build()
        .map_err(|e| e.to_string())?;
    let body = json!({
        "context": { "client": { "clientName": spec.name, "clientVersion": spec.version, "hl": "en", "gl": "US" } },
        "query": query,
        "params": "EgIQAQ%3D%3D",
    });
    let res = http
        .post("https://www.youtube.com/youtubei/v1/search?prettyPrint=false")
        .header("Content-Type", "application/json")
        .header("Origin", "https://www.youtube.com")
        .header("X-YouTube-Client-Name", spec.client_id.to_string())
        .header("X-YouTube-Client-Version", spec.version)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            note_failure("network");
            e.to_string()
        })?;
    if !res.status().is_success() {
        return Err(format!("search http {}", res.status().as_u16()));
    }
    let data: Value = res.json().await.map_err(|e| e.to_string())?;
    let mut found = parse_search(&data);
    found.truncate(limit);
    Ok(found)
}

#[command]
pub async fn search_videos(
    app: AppHandle,
    query: String,
    limit: u32,
) -> Result<Vec<SearchHit>, String> {
    let _ = APP.set(app);
    let limit = limit.min(30) as usize;
    let found = yt_search(&query, limit).await?;
    Ok(found
        .into_iter()
        .map(|f| SearchHit {
            cover: format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", f.id),
            cover_small: format!("https://i.ytimg.com/vi/{}/mqdefault.jpg", f.id),
            cover_large: format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", f.id),
            title: if f.title.is_empty() {
                "Unknown".into()
            } else {
                f.title
            },
            artist: if f.channel.is_empty() {
                "Unknown".into()
            } else {
                f.channel
            },
            id: f.id,
        })
        .collect())
}

#[command]
pub async fn resolve_alternate_stream(
    app: AppHandle,
    video_id: String,
    query: String,
    title: Option<String>,
    duration: Option<f64>,
) -> Result<Option<String>, String> {
    validate_video_id(&video_id)?;
    let _ = APP.set(app.clone());
    let q: String = query
        .chars()
        .filter(|c| !c.is_control())
        .take(160)
        .collect();
    if q.trim().is_empty() {
        return Ok(None);
    }
    let found = yt_search(&format!("{} audio", q.trim()), 6).await?;
    let want = title.as_deref().map(norm_title).filter(|t| !t.is_empty());
    let found: Vec<(String, Option<f64>, String)> = found
        .into_iter()
        .filter(|f| {
            want.as_ref()
                .is_none_or(|w| norm_title(&f.title).contains(w.as_str()))
        })
        .map(|f| (f.id, f.duration, f.channel))
        .collect();
    let picks = pick_alternates(&video_id, duration, found);
    for alt in picks.into_iter().take(2) {
        if let Ok(Some(_)) = get_stream_url(app.clone(), alt.clone(), None).await {
            if let Some(up) = stream_proxy::current_upstream(&alt) {
                stream_proxy::store_upstream(&video_id, up);
                eprintln!("[Zenith] playing alternate upload {} for {}", alt, video_id);
                return Ok(stream_proxy::proxy_url(&video_id));
            }
        }
    }
    Ok(None)
}

fn norm_title(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn pick_alternates(
    video_id: &str,
    duration: Option<f64>,
    found: Vec<(String, Option<f64>, String)>,
) -> Vec<String> {
    let mut c: Vec<(u8, f64, String)> = found
        .into_iter()
        .filter(|(id, _, _)| id != video_id && validate_video_id(id).is_ok())
        .filter_map(|(id, dur, ch)| {
            let diff = match (duration.filter(|d| *d > 0.0), dur) {
                (Some(want), Some(got)) => (want - got).abs(),
                (Some(_), None) => return None,
                (None, _) => 0.0,
            };
            if diff > 7.0 {
                return None;
            }
            let topic = if ch.ends_with(" - Topic") { 0 } else { 1 };
            Some((topic, diff, id))
        })
        .collect();
    c.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
    });
    c.into_iter().map(|x| x.2).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn alternates_match_length_and_prefer_topic() {
        let found = vec![
            (
                "aaaaaaaaaaa".to_string(),
                Some(200.0),
                "Some Channel".to_string(),
            ),
            (
                "bbbbbbbbbbb".to_string(),
                Some(203.0),
                "Artist - Topic".to_string(),
            ),
            (
                "ccccccccccc".to_string(),
                Some(260.0),
                "Artist - Topic".to_string(),
            ),
            (
                "orig0000000".to_string(),
                Some(200.0),
                "Artist - Topic".to_string(),
            ),
        ];
        let p = super::pick_alternates("orig0000000", Some(200.0), found);
        assert_eq!(
            p,
            vec!["bbbbbbbbbbb".to_string(), "aaaaaaaaaaa".to_string()]
        );
    }

    #[test]
    fn expiry_drives_cache() {
        let u = "https://rr1---sn-x.googlevideo.com/videoplayback?expire=20000&ei=a&itag=251";
        assert_eq!(super::url_expiry(u), Some(20000));
        assert!(super::cache_fresh(u, 10000, 10500));
        assert!(!super::cache_fresh(u, 10000, 19500));
        assert!(!super::cache_fresh(
            "https://x.googlevideo.com/v?itag=1",
            0,
            300
        ));
        assert!(super::cache_fresh(
            "https://x.googlevideo.com/v?itag=1",
            0,
            100
        ));
    }

    #[test]
    fn lengths_and_search_results() {
        assert_eq!(super::parse_length("3:45"), Some(225.0));
        assert_eq!(super::parse_length("1:02:03"), Some(3723.0));
        assert_eq!(super::parse_length("LIVE"), None);
        let data = serde_json::json!({
            "contents": { "x": [ { "itemSectionRenderer": { "contents": [
                { "videoRenderer": {
                    "videoId": "dQw4w9WgXcQ",
                    "title": { "runs": [ { "text": "Never Gonna" } ] },
                    "ownerText": { "runs": [ { "text": "Rick Astley - Topic" } ] },
                    "lengthText": { "simpleText": "3:33" }
                } },
                { "videoRenderer": { "videoId": "bad" } },
                { "shelfRenderer": {} }
            ] } } ] }
        });
        let f = super::parse_search(&data);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].channel, "Rick Astley - Topic");
        assert_eq!(f[0].duration, Some(213.0));
    }

    #[test]
    fn reads_data_sync_id() {
        let page = r#"ytcfg.set({"DATASYNC_ID":"1234567890||","X":1})"#;
        assert_eq!(
            super::parse_data_sync_id(page).as_deref(),
            Some("1234567890")
        );
        assert_eq!(super::parse_data_sync_id("nothing"), None);
    }

    #[test]
    fn video_ids_are_checked() {
        assert!(super::validate_video_id("dQw4w9WgXcQ").is_ok());
        assert!(super::validate_video_id("../../etc").is_err());
    }
}

#[cfg(test)]
mod search_live {
    #[tokio::test]
    #[ignore = "talks to youtube"]
    async fn finds_a_known_song() {
        let hits = super::yt_search("psy gangnam style", 5).await.unwrap();
        println!(
            "{:?}",
            hits.iter()
                .map(|h| (&h.id, &h.title, h.duration))
                .collect::<Vec<_>>()
        );
        assert!(hits.iter().any(|h| h.id == "9bZkp7q19f0"));
    }
}
