use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::webview::Cookie;
use tauri::{AppHandle, Manager, WebviewWindow};

static LOGIN_POPUP_SYNC_READY: AtomicBool = AtomicBool::new(false);

pub fn set_login_popup_sync_ready(ready: bool) {
    LOGIN_POPUP_SYNC_READY.store(ready, Ordering::SeqCst);
}

const AUTH_URLS: &[&str] = &[
    "https://music.youtube.com/",
    "https://www.youtube.com/",
    "https://youtube.com/",
    "https://accounts.google.com/",
    "https://www.google.com/",
    "https://google.com/",
];

#[derive(Serialize, Deserialize, Clone)]
struct StoredCookie {
    name: String,
    value: String,
    domain: Option<String>,
    path: Option<String>,
    secure: bool,
    http_only: bool,
}

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("ytm_session.json"))
}

/// pre-1.0 identifier `com.zenithplayer.app` dumped sessions in a different folder on windows
fn legacy_session_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let local = std::env::var("LOCALAPPDATA").ok()?;
        let p = PathBuf::from(local)
            .join("com.zenithplayer.app")
            .join("ytm_session.json");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn cookie_key(c: &Cookie<'_>) -> String {
    format!("{}@{}", c.name(), c.domain().unwrap_or_default())
}

fn cookie_to_stored(c: &Cookie<'_>) -> StoredCookie {
    StoredCookie {
        name: c.name().to_string(),
        value: c.value().to_string(),
        domain: c.domain().map(|s| s.to_string()),
        path: c.path().map(|s| s.to_string()),
        secure: c.secure().unwrap_or(false),
        http_only: c.http_only().unwrap_or(false),
    }
}

fn stored_to_cookie(s: &StoredCookie) -> Cookie<'static> {
    let mut b = Cookie::build((s.name.clone(), s.value.clone()));
    if let Some(ref d) = s.domain {
        b = b.domain(d.clone());
    }
    if let Some(ref p) = s.path {
        b = b.path(p.clone());
    }
    if s.secure {
        b = b.secure(true);
    }
    if s.http_only {
        b = b.http_only(true);
    }
    b.build()
}

fn collect_cookies_for_webview(wv: &WebviewWindow) -> Vec<StoredCookie> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut push_cookie = |c: Cookie<'_>| {
        let key = cookie_key(&c);
        if seen.insert(key) {
            out.push(cookie_to_stored(&c));
        }
    };
    if let Ok(all) = wv.cookies() {
        for c in all {
            push_cookie(c);
        }
    }
    for url_str in AUTH_URLS {
        let Ok(url) = url_str.parse::<tauri::Url>() else {
            continue;
        };
        let Ok(cookies) = wv.cookies_for_url(url) else {
            continue;
        };
        for c in cookies {
            push_cookie(c);
        }
    }
    out
}

fn collect_all_cookies(app: &AppHandle) -> Vec<StoredCookie> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for (_, wv) in app.webview_windows() {
        for stored in collect_cookies_for_webview(&wv) {
            let key = format!("{}@{}", stored.name, stored.domain.as_deref().unwrap_or(""));
            if seen.insert(key) {
                out.push(stored);
            }
        }
    }
    out
}

/// cookies from the google login popup only, main window leftovers are stale junk
fn collect_login_popup_cookies(app: &AppHandle) -> Vec<StoredCookie> {
    let Some(login) = app.get_webview_window("google-login") else {
        return Vec::new();
    };
    let mut out = collect_cookies_for_webview(&login);
    if let Ok(current) = login.url() {
        if let Ok(cookies) = login.cookies_for_url(current) {
            let mut seen: HashSet<String> = out
                .iter()
                .map(|c| format!("{}@{}", c.name, c.domain.as_deref().unwrap_or("")))
                .collect();
            for c in cookies {
                let key = cookie_key(&c);
                if seen.insert(key) {
                    out.push(cookie_to_stored(&c));
                }
            }
        }
    }
    out
}

fn apply_to_main(app: &AppHandle, stored: &[StoredCookie]) -> usize {
    let Some(main) = app.get_webview_window("main") else {
        return 0;
    };
    apply_cookies(&main, stored)
}

fn domain_rank(domain: &str) -> u8 {
    let d = domain.trim_start_matches('.').to_ascii_lowercase();
    if d == "music.youtube.com" || d.ends_with(".music.youtube.com") {
        4
    } else if d == "youtube.com" || d.ends_with(".youtube.com") {
        3
    } else if d == "google.com" || d.ends_with(".google.com") {
        2
    } else {
        1
    }
}

fn is_session_cookie(c: &StoredCookie) -> bool {
    let d = c
        .domain
        .as_deref()
        .unwrap_or("")
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if d.is_empty() {
        return !c.name.starts_with("_ga") && c.name != "_gid" && c.name != "NID";
    }
    d.contains("google") || d.contains("youtube") || d.contains("gstatic")
}

fn stored_to_header(stored: &[StoredCookie]) -> String {
    let mut best: HashMap<&str, &StoredCookie> = HashMap::new();
    for c in stored.iter().filter(|c| is_session_cookie(c)) {
        let rank = domain_rank(c.domain.as_deref().unwrap_or(""));
        match best.get(c.name.as_str()) {
            Some(existing) if domain_rank(existing.domain.as_deref().unwrap_or("")) >= rank => {}
            _ => {
                best.insert(c.name.as_str(), c);
            }
        }
    }
    best.into_iter()
        .map(|(_, c)| format!("{}={}", c.name, c.value))
        .collect::<Vec<_>>()
        .join("; ")
}

fn apply_cookies(wv: &WebviewWindow, stored: &[StoredCookie]) -> usize {
    let mut n = 0;
    for s in stored {
        let c = stored_to_cookie(s);
        if wv.set_cookie(c).is_ok() {
            n += 1;
            continue;
        }
        // webview2 sometimes hates the original domain, try a cleaned one
        let domain = s
            .domain
            .as_deref()
            .filter(|d| !d.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if s.name.contains("youtube") || s.name.starts_with("__Secure-") {
                    ".youtube.com".to_string()
                } else {
                    ".google.com".to_string()
                }
            });
        let mut b = Cookie::build((s.name.clone(), s.value.clone())).domain(domain);
        if let Some(ref p) = s.path {
            if !p.is_empty() {
                b = b.path(p.clone());
            }
        }
        if s.secure {
            b = b.secure(true);
        }
        if s.http_only {
            b = b.http_only(true);
        }
        if wv.set_cookie(b.build()).is_ok() {
            n += 1;
        }
    }
    n
}

fn has_auth_marker(cookies: &[StoredCookie]) -> bool {
    // SID/SSID is just a google accounts session, innertube wants SAPISID
    cookies.iter().any(|c| {
        matches!(
            c.name.as_str(),
            "SAPISID" | "__Secure-3PAPISID" | "__Secure-1PAPISID"
        )
    })
}

/// webview2 cookie apis have to run on the main thread or windows hangs/crashes
pub fn with_webview_on_main<T, F>(app: &AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
{
    let app = app.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let app_main = app.clone();
    app.run_on_main_thread(move || {
        let result = f(&app_main);
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(8))
        .map_err(|_| "webview cookie op timed out".to_string())?
}

/// copy auth from the login popup into the session file + cookie cache
/// popup having auth cookies is enough, reading them back from main is best-effort
pub fn capture_login_session(app: &AppHandle) -> Result<bool, String> {
    if app.get_webview_window("google-login").is_none() {
        return Ok(false);
    }
    if !LOGIN_POPUP_SYNC_READY.load(Ordering::SeqCst) {
        return Ok(false);
    }
    let cookies: Vec<StoredCookie> = collect_login_popup_cookies(app)
        .into_iter()
        .filter(is_session_cookie)
        .collect();
    if cookies.is_empty() || !has_auth_marker(&cookies) {
        return Ok(false);
    }

    let _ = apply_to_main(app, &cookies);

    let header = stored_to_header(&cookies);
    crate::ytm_api::warm_cookie_cache(header);
    let _ = apply_to_main(app, &cookies);

    Ok(true)
}

/// copy ytm auth cookies from the login popup into the main window
/// call this on the main thread
pub fn sync_auth_from_login_popup(app: &AppHandle) -> Result<bool, String> {
    capture_login_session(app)
}

#[tauri::command]
pub async fn capture_ytm_login_session(app: AppHandle) -> Result<bool, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_webview_on_main(&app2, |app| {
            if app.get_webview_window("google-login").is_none() {
                return Ok(false);
            }
            set_login_popup_sync_ready(true);
            capture_login_session(app)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sync_ytm_auth_to_main(app: AppHandle) -> Result<bool, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::ytm_api::clear_cookie_cache();
        let ok = with_webview_on_main(&app2, |app| {
            if app.get_webview_window("google-login").is_some() {
                return sync_auth_from_login_popup(app);
            }
            let cookies: Vec<StoredCookie> = collect_all_cookies(app)
                .into_iter()
                .filter(is_session_cookie)
                .collect();
            if !has_auth_marker(&cookies) {
                return Ok(false);
            }
            let _ = apply_to_main(app, &cookies);
            crate::ytm_api::warm_cookie_cache(stored_to_header(&cookies));
            Ok(true)
        })?;
        crate::ytm_api::refresh_cookie_cache_from_webview(&app2);
        Ok(ok)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn persist_ytm_session(app: AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    let cookies: Vec<StoredCookie> = tauri::async_runtime::spawn_blocking(move || {
        with_webview_on_main(&app2, |app| {
            Ok(collect_all_cookies(app)
                .into_iter()
                .filter(is_session_cookie)
                .collect())
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    if !has_auth_marker(&cookies) {
        return Err("no auth cookies to save".into());
    }
    let path = session_path(&app)?;
    let json = serde_json::to_string(&cookies).map_err(|e| e.to_string())?;
    crate::secret_store::write_session(&path, &json)?;
    crate::ytm_api::warm_cookie_cache(stored_to_header(&cookies));
    let _ = crate::ytm_api::resolve_cookies_public(&app);
    Ok(())
}

#[tauri::command]
pub async fn restore_ytm_session(app: AppHandle) -> Result<bool, String> {
    let path = session_path(&app)?;
    let load_path = if path.exists() {
        path.clone()
    } else {
        legacy_session_path().unwrap_or_else(|| path.clone())
    };
    if !load_path.exists() {
        return Ok(false);
    }
    let (raw, was_legacy) = crate::secret_store::read_session(&load_path)?;
    let cookies: Vec<StoredCookie> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if cookies.is_empty() || !has_auth_marker(&cookies) {
        return Ok(false);
    }
    let cookies_for_apply = cookies.clone();
    let app2 = app.clone();
    crate::ytm_api::warm_cookie_cache(stored_to_header(&cookies));
    let applied = tauri::async_runtime::spawn_blocking(move || {
        with_webview_on_main(&app2, move |app| Ok(apply_to_main(app, &cookies_for_apply)))
    })
    .await
    .map_err(|e| e.to_string())??;
    if applied > 0 && (was_legacy || load_path != path) {
        let json = serde_json::to_string(&cookies).map_err(|e| e.to_string())?;
        crate::secret_store::write_session(&path, &json)?;
        if load_path != path {
            let _ = fs::remove_file(&load_path);
        }
    }
    let _ = crate::ytm_api::resolve_cookies_public(&app);
    Ok(has_auth_marker(&cookies))
}

#[tauri::command]
pub fn clear_ytm_session_store(app: AppHandle) -> Result<(), String> {
    let path = session_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    crate::ytm_api::clear_cookie_cache();
    Ok(())
}

#[tauri::command]
pub fn forget_ytm_session_file(app: AppHandle) -> Result<(), String> {
    let path = session_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// delete google / youtube auth cookies from every webview, ui thread only
pub fn wipe_webview_auth_cookies(app: &AppHandle) {
    for (_, wv) in app.webview_windows() {
        if let Ok(all) = wv.cookies() {
            for cookie in all {
                let stored = cookie_to_stored(&cookie);
                if is_session_cookie(&stored) {
                    let _ = wv.delete_cookie(cookie);
                }
            }
        }
        for url_str in AUTH_URLS {
            let Ok(url) = url_str.parse::<tauri::Url>() else {
                continue;
            };
            let Ok(cookies) = wv.cookies_for_url(url) else {
                continue;
            };
            for cookie in cookies {
                let _ = wv.delete_cookie(cookie);
            }
        }
    }
}
