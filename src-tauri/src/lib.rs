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

fn on_login_popup_page_loaded(app: &tauri::AppHandle, url: &url::Url) {
    if !login_nav::is_finish_page(url) {
        return;
    }
    queue_login_capture(app);
}

#[tauri::command]
async fn finish_login_if_ready(app: tauri::AppHandle) -> Result<bool, String> {
    if !login_popup_exists(&app) {
        return Ok(false);
    }
    auth_store::set_login_popup_sync_ready(true);
    let synced = auth_store::capture_ytm_login_session(app.clone()).await?;
    if synced {
        emit_login_synced(&app);
    }
    Ok(synced)
}

#[tauri::command]
async fn close_google_login(app: tauri::AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("google-login") else {
        return Ok(());
    };
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = win.destroy();
        let _ = tx.send(());
    })
    .map_err(|e| e.to_string())?;
    let _ = rx.recv_timeout(std::time::Duration::from_secs(3));
    Ok(())
}

#[tauri::command]
async fn open_google_login(app: tauri::AppHandle, title: String) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;

    if let Some(existing) = app.get_webview_window("google-login") {
        reset_login_sync_state();
        existing.show().map_err(|e| e.to_string())?;
        existing.set_focus().map_err(|e| e.to_string())?;
        queue_login_capture(&app);
        return Ok(());
    }
    reset_login_sync_state();

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("webview-google-login");
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let url = windows::app_url(login_nav::LOADING_PAGE)?;

    let app_nav = app.clone();
    let app_page = app.clone();
    let win = WebviewWindowBuilder::new(&app, "google-login", url)
        .title(&title)
        .inner_size(500.0, 700.0)
        .center()
        .resizable(true)
        .focused(true)
        .enable_clipboard_access()
        .background_color(tauri::window::Color(12, 14, 20, 255))
        .user_agent(login_nav::user_agent())
        .data_directory(data_dir)
        .on_navigation(move |nav_url| {
            if login_nav::is_loading_page(nav_url) {
                return true;
            }
            match login_nav::decide(nav_url) {
                login_nav::NavDecision::Allow => true,
                login_nav::NavDecision::OpenExternal => {
                    use tauri_plugin_opener::OpenerExt;
                    let _ = app_nav.opener().open_url(nav_url.as_str(), None::<&str>);
                    false
                }
                login_nav::NavDecision::Block => false,
            }
        })
        .on_page_load(move |_window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            on_login_popup_page_loaded(&app_page, payload.url());
        })
        .build()
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn clear_ytm_auth(app: tauri::AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        auth_store::with_webview_on_main(&app2, |handle| {
            auth_store::wipe_webview_auth_cookies(handle);
            Ok(())
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    ytm_api::clear_cookie_cache();
    stream::wipe_netscape_cookie_file(&app);
    Ok(())
}

#[tauri::command]
async fn clear_login_webview_data(app: tauri::AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        auth_store::with_webview_on_main(&app2, |handle| {
            if let Some(win) = handle.get_webview_window("google-login") {
                let _ = win.destroy();
            }
            Ok(())
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("webview-google-login");
    for attempt in 0..5 {
        if !data_dir.exists() {
            break;
        }
        match std::fs::remove_dir_all(&data_dir) {
            Ok(()) => break,
            Err(e) if attempt == 4 => {
                if debug_log_enabled() {
                    eprintln!("[Zenith] could not wipe login profile: {e}");
                }
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(150)),
        }
    }
    reset_login_sync_state();
    Ok(())
}

struct TrayMenu {
    play: MenuItem<tauri::Wry>,
    next: MenuItem<tauri::Wry>,
    show: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

static TRAY_READY: AtomicBool = AtomicBool::new(false);
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);
static GLOBAL_HOTKEYS_ON: AtomicBool = AtomicBool::new(true);
static HOTKEY_LOCK: Mutex<()> = Mutex::new(());

fn debug_log_enabled() -> bool {
    std::env::var_os("ZENITH_DEBUG").is_some()
}

pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    if ui_drop::ensure_main(app) {
        return;
    }
    if let Some(win) = app.get_webview_window("main") {
        wv2_mem::set_low(&win, false);
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[cfg(target_os = "linux")]
use mpris::mpris_update;

#[cfg(not(target_os = "linux"))]
use smtc::mpris_update;

pub(crate) fn tray_action(app: &tauri::AppHandle, action: &str) {
    if native_audio::is_headless() {
        native_audio::headless::action(action);
    } else {
        let _ = app.emit("zenith-tray-action", action);
    }
}

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let play = MenuItem::with_id(app, "tray-play", "Play / Pause", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "tray-next", "Next track", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "tray-show", "Show Zenith", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&play, &next, &show, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("missing default window icon")?;

    TrayIconBuilder::with_id("zenith-tray")
        .icon(icon)
        .menu(&menu)
        .tooltip("Zenith Player")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-play" => tray_action(app, "toggle-play"),
            "tray-next" => tray_action(app, "next"),
            "tray-show" => show_main_window(app),
            "tray-quit" => {
                windows::graceful_shutdown(app);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    app.manage(TrayMenu {
        play,
        next,
        show,
        quit,
    });
    TRAY_READY.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn set_tray_labels(
    app: tauri::AppHandle,
    play: String,
    next: String,
    show: String,
    quit: String,
) -> Result<(), String> {
    if let Some(menu) = app.try_state::<TrayMenu>() {
        menu.play.set_text(play).map_err(|e| e.to_string())?;
        menu.next.set_text(next).map_err(|e| e.to_string())?;
        menu.show.set_text(show).map_err(|e| e.to_string())?;
        menu.quit.set_text(quit).map_err(|e| e.to_string())?;
    }
    Ok(())
}
