mod auth_store;
mod cover_cache;
mod deps;
mod discord;
mod downloads;
mod dualsense;
mod export_file;
mod jsc;
mod lastfm;
mod login_nav;
#[cfg(target_os = "linux")]
mod mpris;
mod native_audio;
mod player;
mod player_js;
mod potoken;
mod prefs;
mod remote;
mod resolve_plan;
mod room;
mod secret_store;
#[cfg(not(target_os = "linux"))]
mod smtc;
mod spotify_auth;
mod stream;
mod stream_proxy;
mod timeline;
mod ui_drop;
#[cfg(windows)]
mod webview2_check;
mod webview_tuning;
mod win_proxy;
mod windows;
mod wv2_mem;
mod ytm_api;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::PageLoadEvent,
    Emitter, Manager, RunEvent, WindowEvent,
};

#[tauri::command]
async fn post_webhook(url: String, body: String) -> Result<u16, String> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| "invalid url".to_string())?;
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "[::1]");
    match parsed.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err("only https (or http on localhost) is allowed".into()),
    }
    if body.len() > 64 * 1024 {
        return Err("payload too large".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(parsed)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(res.status().as_u16())
}

#[tauri::command]
async fn get_ytm_cookies(app: tauri::AppHandle) -> Result<String, String> {
    Ok(ytm_api::resolve_cookies_public(&app))
}

static LOGIN_SYNC_SCHEDULED: AtomicBool = AtomicBool::new(false);
static LOGIN_CAPTURE_GEN: AtomicU64 = AtomicU64::new(0);

fn reset_login_sync_state() {
    auth_store::set_login_popup_sync_ready(false);
    LOGIN_SYNC_SCHEDULED.store(false, Ordering::SeqCst);
    LOGIN_CAPTURE_GEN.fetch_add(1, Ordering::SeqCst);
}

fn login_popup_exists(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("google-login").is_some()
}

fn emit_login_synced(app: &tauri::AppHandle) {
    let _ = app.emit("ytm-login-cookies-synced", ());
    let _ = app.emit_to("main", "ytm-login-cookies-synced", ());
}

fn try_capture_login_session(app: &tauri::AppHandle) -> bool {
    auth_store::capture_login_session(app).unwrap_or(false)
}

fn schedule_login_cookie_sync(app: &tauri::AppHandle) {
    if LOGIN_SYNC_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        struct WatchGuard;
        impl Drop for WatchGuard {
            fn drop(&mut self) {
                LOGIN_SYNC_SCHEDULED.store(false, Ordering::SeqCst);
            }
        }
        let _guard = WatchGuard;

        auth_store::set_login_popup_sync_ready(true);

        for attempt in 0..15 {
            let delay_ms = 500 + attempt * 500;
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            if app.get_webview_window("google-login").is_none() {
                return;
            }
            let (tx, rx) = std::sync::mpsc::channel();
            let app_main = app.clone();
            if app
                .run_on_main_thread(move || {
                    let synced = try_capture_login_session(&app_main);
                    let _ = tx.send(synced);
                })
                .is_err()
            {
                continue;
            }
            if rx
                .recv_timeout(std::time::Duration::from_secs(8))
                .unwrap_or(false)
            {
                crate::ytm_api::refresh_cookie_cache_from_webview(&app);
                emit_login_synced(&app);
                return;
            }
        }
    });
}

fn queue_login_capture(app: &tauri::AppHandle) {
    if !login_popup_exists(app) {
        return;
    }
    auth_store::set_login_popup_sync_ready(true);
    let gen = LOGIN_CAPTURE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(280));
        if LOGIN_CAPTURE_GEN.load(Ordering::SeqCst) != gen {
            return;
        }
        if app.get_webview_window("google-login").is_none() {
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let app_main = app.clone();
        let captured = app
            .run_on_main_thread(move || {
                let synced = try_capture_login_session(&app_main);
                let _ = tx.send(synced);
            })
            .is_ok()
            && rx
                .recv_timeout(std::time::Duration::from_secs(8))
                .unwrap_or(false);
        if LOGIN_CAPTURE_GEN.load(Ordering::SeqCst) != gen {
            return;
        }
        if captured {
            crate::ytm_api::refresh_cookie_cache_from_webview(&app);
            emit_login_synced(&app);
            return;
        }
        schedule_login_cookie_sync(&app);
    });
}
