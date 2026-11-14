use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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

fn domain_for_set(name: &str, domain: Option<&str>) -> Option<String> {
    if name.starts_with("__Host-") {
        return None;
    }
    let raw = domain.unwrap_or("").trim();
    if raw.is_empty() {
        return Some(
            if name.starts_with("__Secure-")
                || matches!(
                    name,
                    "SAPISID" | "APISID" | "SID" | "HSID" | "SSID" | "LOGIN_INFO"
                )
            {
                ".youtube.com".to_string()
            } else {
                ".google.com".to_string()
            },
        );
    }
    let bare = raw.trim_start_matches('.').to_ascii_lowercase();
    Some(format!(".{bare}"))
}

fn stored_to_cookie(s: &StoredCookie) -> Cookie<'static> {
    let mut b = Cookie::build((s.name.clone(), s.value.clone()));
    if let Some(d) = domain_for_set(&s.name, s.domain.as_deref()) {
        b = b.domain(d);
    }
    let path = s
        .path
        .as_deref()
        .filter(|p| !p.is_empty())
        .unwrap_or("/")
        .to_string();
    b = b.path(path);
    if s.secure || s.name.starts_with("__Secure-") || s.name.starts_with("__Host-") {
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
    let mut full_jar = false;
    if let Ok(all) = wv.cookies() {
        full_jar = !all.is_empty();
        for c in all {
            push_cookie(c);
        }
    }
    for url_str in AUTH_URLS.iter().filter(|_| !full_jar) {
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
    for (label, wv) in app.webview_windows() {
        if label == crate::potoken::LABEL {
            continue;
        }
        for stored in collect_cookies_for_webview(&wv) {
            let key = format!("{}@{}", stored.name, stored.domain.as_deref().unwrap_or(""));
            if seen.insert(key) {
                out.push(stored);
            }
        }
    }
    out
}

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
    let triples: Vec<(&str, &str, &str)> = stored
        .iter()
        .filter(|c| is_session_cookie(c))
        .map(|c| {
            (
                c.name.as_str(),
                c.value.as_str(),
                c.domain.as_deref().unwrap_or(""),
            )
        })
        .collect();
    crate::ytm_api::music_cookie_header(&triples)
}

fn apply_cookies(wv: &WebviewWindow, stored: &[StoredCookie]) -> usize {
    let mut n = 0;
    for s in stored {
        let c = stored_to_cookie(s);
        if wv.set_cookie(c).is_ok() {
            n += 1;
            continue;
        }
        let Some(domain) = domain_for_set(&s.name, s.domain.as_deref()) else {
            continue;
        };
        let mut b = Cookie::build((s.name.clone(), s.value.clone())).domain(domain);
        if let Some(ref p) = s.path {
            if !p.is_empty() {
                b = b.path(p.clone());
            }
        }
        if s.secure || s.name.starts_with("__Secure-") || s.name.starts_with("__Host-") {
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

fn is_youtube_domain(domain: Option<&str>) -> bool {
    let d = domain
        .unwrap_or("")
        .trim_start_matches('.')
        .to_ascii_lowercase();
    d == "youtube.com" || d.ends_with(".youtube.com")
}

fn has_auth_marker(cookies: &[StoredCookie]) -> bool {
    cookies.iter().any(|c| {
        is_youtube_domain(c.domain.as_deref())
            && matches!(
                c.name.as_str(),
                "SAPISID" | "__Secure-3PAPISID" | "__Secure-1PAPISID"
            )
    })
}

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

pub fn capture_login_session(app: &AppHandle) -> Result<bool, String> {
    let Some(login) = app.get_webview_window("google-login") else {
        return Ok(false);
    };
    if !login
        .url()
        .map(|u| crate::login_nav::is_finish_page(&u))
        .unwrap_or(false)
    {
        return Ok(false);
    }
    if !LOGIN_POPUP_SYNC_READY.load(Ordering::SeqCst) {
        return Ok(false);
    }
    let all = collect_login_popup_cookies(app);
    let total = all.len();
    let cookies: Vec<StoredCookie> = all.into_iter().filter(is_session_cookie).collect();
    let marker = has_auth_marker(&cookies);
    eprintln!(
        "[zenith] login capture: {total} cookies, {} google/youtube, auth marker: {marker}",
        cookies.len()
    );
    if cookies.is_empty() || !marker {
        return Ok(false);
    }

    let _ = apply_to_main(app, &cookies);

    let header = stored_to_header(&cookies);
    crate::ytm_api::warm_cookie_cache(header);
    let _ = apply_to_main(app, &cookies);

    Ok(true)
}

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
    let parsed = crate::secret_store::read_session(&load_path).and_then(|(raw, legacy)| {
        serde_json::from_str::<Vec<StoredCookie>>(&raw)
            .map(|c| (c, legacy))
            .map_err(|e| e.to_string())
    });
    let (cookies, was_legacy) = match parsed {
        Ok(v) => v,
        Err(_) => {
            let _ = fs::remove_file(&load_path);
            return Ok(false);
        }
    };
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cv(name: &str, value: &str, domain: &str) -> StoredCookie {
        StoredCookie {
            name: name.into(),
            value: value.into(),
            domain: Some(domain.into()),
            path: Some("/".into()),
            secure: true,
            http_only: false,
        }
    }

    fn c(name: &str, domain: &str) -> StoredCookie {
        cv(name, "x", domain)
    }

    #[test]
    fn google_only_sapisid_is_not_a_youtube_login() {
        let google = vec![c("SAPISID", ".google.com"), c("SID", ".google.com")];
        assert!(!has_auth_marker(&google));
        let mut both = google.clone();
        both.push(c("SAPISID", ".youtube.com"));
        assert!(has_auth_marker(&both));
        assert!(has_auth_marker(&[c(
            "__Secure-3PAPISID",
            "music.youtube.com"
        )]));
        assert!(!has_auth_marker(&[c("SAPISID", ".notyoutube.com")]));
    }

    #[test]
    fn header_prefers_youtube_sapisid_over_google() {
        let cookies = vec![
            cv("SAPISID", "google", ".google.com"),
            cv("SAPISID", "yt", ".youtube.com"),
            cv("__Secure-3PSID", "psid", ".youtube.com"),
            cv("_ga", "x", ".example.com"),
        ];
        let h = stored_to_header(&cookies);
        assert_eq!(h, "SAPISID=yt; __Secure-3PSID=psid");
        assert!(!h.contains("google"));
    }

    #[test]
    fn dotted_domain_is_restored_for_webkit() {
        assert_eq!(
            domain_for_set("SAPISID", Some("youtube.com")).as_deref(),
            Some(".youtube.com")
        );
        assert_eq!(
            domain_for_set("__Secure-3PAPISID", Some(".youtube.com")).as_deref(),
            Some(".youtube.com")
        );
        assert_eq!(domain_for_set("__Host-GAPS", Some("youtube.com")), None);
    }

    #[test]
    fn auth_marker_needs_sapisid() {
        assert!(!has_auth_marker(&[c("SID", ".google.com")]));
        assert!(has_auth_marker(&[c("__Secure-3PAPISID", ".youtube.com")]));
    }

    #[test]
    fn session_cookie_filter() {
        assert!(is_session_cookie(&c("SID", ".google.com")));
        assert!(is_session_cookie(&c("SID", ".google.pl")));
        assert!(is_session_cookie(&c("LOGIN_INFO", ".youtube.com")));
        assert!(!is_session_cookie(&c("x", ".example.com")));
    }
}
