mod auth_store;
mod deps;
mod discord;
mod dualsense;
mod player;
mod room;
mod secret_store;
mod stream;
mod stream_proxy;
mod windows;
mod ytdlp;
mod ytm_api;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::PageLoadEvent,
    Emitter, Manager, RunEvent, WindowEvent,
};

#[tauri::command]
fn debug_write_dump(
    app: tauri::AppHandle,
    name: String,
    contents: String,
) -> Result<String, String> {
    #[cfg(not(feature = "qa"))]
    {
        let _ = (app, name, contents);
        return Err("qa dumps disabled in this build".into());
    }
    #[cfg(feature = "qa")]
    {
        let safe = name
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == '.')
            .collect::<String>();
        if safe.is_empty() || safe.len() > 80 {
            return Err("bad name".into());
        }
        let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(safe);
        std::fs::write(&path, contents).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    }
}

#[tauri::command]
async fn get_ytm_cookies(app: tauri::AppHandle) -> Result<String, String> {
    // never touch webview cookie apis here, parallel calls freeze the ui on windows
    Ok(ytm_api::resolve_cookies_public(&app))
}

static LOGIN_SYNC_SCHEDULED: AtomicBool = AtomicBool::new(false);
static LOGIN_CAPTURE_GEN: AtomicU64 = AtomicU64::new(0);

fn reset_login_sync_state() {
    auth_store::set_login_popup_sync_ready(false);
    LOGIN_SYNC_SCHEDULED.store(false, Ordering::SeqCst);
    LOGIN_CAPTURE_GEN.fetch_add(1, Ordering::SeqCst);
}

fn login_nav_host_allowed(host: &str) -> bool {
    let h = host.trim().to_ascii_lowercase();
    h == "accounts.google.com"
        || h.ends_with(".google.com")
        || h == "google.com"
        || h == "youtube.com"
        || h.ends_with(".youtube.com")
        || h == "gstatic.com"
        || h.ends_with(".gstatic.com")
        || h == "googleusercontent.com"
        || h.ends_with(".googleusercontent.com")
        || h == "googleapis.com"
        || h.ends_with(".googleapis.com")
        || h == "recaptcha.net"
        || h.ends_with(".recaptcha.net")
        || h == "gvt1.com"
        || h.ends_with(".gvt1.com")
}

fn login_capture_host(host: &str) -> bool {
    let h = host.trim().to_ascii_lowercase();
    h.contains("google.com") || h.contains("youtube.com")
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

/// retry cookie sync after the ytm redirect, dont poll while theyre still on google accounts
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

fn on_login_popup_navigated(app: &tauri::AppHandle, host: &str) {
    if !login_capture_host(host) {
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
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    if let Some(existing) = app.get_webview_window("google-login") {
        reset_login_sync_state();
        existing.show().map_err(|e| e.to_string())?;
        existing.set_focus().map_err(|e| e.to_string())?;
        queue_login_capture(&app);
        return Ok(());
    }
    reset_login_sync_state();

    // main window already set additionalBrowserArgs in tauri.conf
    // on windows webview2 wants a separate data dir when the args differ
    // otherwise the popup is blank and can take the whole app with it
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("webview-google-login");
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let parsed = url::Url::parse(
        "https://accounts.google.com/ServiceLogin?continue=https://music.youtube.com/",
    )
    .map_err(|e| e.to_string())?;
    let url = WebviewUrl::External(parsed);

    let app_nav = app.clone();
    let app_page = app.clone();
    let win = WebviewWindowBuilder::new(&app, "google-login", url)
        .title(&title)
        .inner_size(500.0, 700.0)
        .center()
        .resizable(true)
        .data_directory(data_dir)
        .on_navigation(move |nav_url| {
            if nav_url.scheme() == "about" {
                return true;
            }
            let Some(host) = nav_url.host_str() else {
                return false;
            };
            if !login_nav_host_allowed(host) {
                return false;
            }
            on_login_popup_navigated(&app_nav, host);
            true
        })
        .on_page_load(move |_window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            if let Some(host) = payload.url().host_str() {
                on_login_popup_navigated(&app_page, host);
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;

    Ok(())
}

/// yeet google / ytm session cookies from every webview (sign-out)
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

/// wipe the isolated google-login webview profile so next sign-in is a clean slate
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
    if data_dir.exists() {
        std::fs::remove_dir_all(&data_dir).map_err(|e| e.to_string())?;
    }
    reset_login_sync_state();
    Ok(())
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

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("Zenith Player")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-play" => {
                let _ = app.emit("zenith-tray-action", "toggle-play");
            }
            "tray-next" => {
                let _ = app.emit("zenith-tray-action", "next");
            }
            "tray-show" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
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
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

fn register_global_shortcuts(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

    let gs = app.global_shortcut();
    let shortcuts = [
        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space),
        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::ArrowRight),
        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::ArrowLeft),
        Shortcut::new(None, Code::MediaPlayPause),
        Shortcut::new(None, Code::MediaTrackNext),
        Shortcut::new(None, Code::MediaTrackPrevious),
    ];

    for shortcut in shortcuts {
        // media keys might already be stolen by another app, dont abort startup over it
        // spotify znowu zjadl klawisze, trudno, odpalamy dalej
        if let Err(e) = gs.register(shortcut) {
            eprintln!("[zenith] global shortcut register skipped: {e}");
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let action = if shortcut
                        == &Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space)
                        || shortcut == &Shortcut::new(None, Code::MediaPlayPause)
                    {
                        "toggle-play"
                    } else if shortcut
                        == &Shortcut::new(
                            Some(Modifiers::CONTROL | Modifiers::ALT),
                            Code::ArrowRight,
                        )
                        || shortcut == &Shortcut::new(None, Code::MediaTrackNext)
                    {
                        "next"
                    } else if shortcut
                        == &Shortcut::new(
                            Some(Modifiers::CONTROL | Modifiers::ALT),
                            Code::ArrowLeft,
                        )
                        || shortcut == &Shortcut::new(None, Code::MediaTrackPrevious)
                    {
                        "prev"
                    } else {
                        return;
                    };
                    let _ = app.emit("zenith-tray-action", action);
                })
                .build(),
        )
        .setup(|app| {
            tauri::async_runtime::spawn(stream_proxy::start_background());
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                crate::deps::hydrate(&handle);
                let report = crate::deps::refresh_all(&handle);
                eprintln!(
                    "[Zenith] deps yt-dlp={} innertube={} updated_ytdlp={} updated_it={}",
                    report.ytdlp_version.as_deref().unwrap_or("-"),
                    report.innertube_version.as_deref().unwrap_or("-"),
                    report.ytdlp_updated,
                    report.innertube_updated
                );
            });
            setup_tray(app)?;
            register_global_shortcuts(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        api.prevent_close();
                        windows::graceful_shutdown(window.app_handle());
                    }
                }
                // aux windows closing on their own should not kill the whole app
                WindowEvent::Destroyed => {
                    let label = window.label().to_string();
                    if windows::AUX_WINDOW_LABELS.iter().any(|l| *l == label) {
                        // overlay/mini closed, main stays
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_ytm_cookies,
            debug_write_dump,
            clear_ytm_auth,
            clear_login_webview_data,
            auth_store::persist_ytm_session,
            auth_store::restore_ytm_session,
            auth_store::clear_ytm_session_store,
            auth_store::forget_ytm_session_file,
            auth_store::sync_ytm_auth_to_main,
            auth_store::capture_ytm_login_session,
            open_google_login,
            close_google_login,
            finish_login_if_ready,
            windows::open_lyrics_overlay,
            windows::open_lyrics_second_screen,
            windows::open_mini_player,
            windows::close_window,
            windows::app_prepare_shutdown,
            room::room_create,
            room::room_join,
            room::room_leave,
            room::room_get_code,
            room::room_get_port,
            room::room_peer_count,
            room::room_broadcast,
            dualsense::dualsense_start,
            dualsense::dualsense_stop,
            dualsense::dualsense_set_led,
            stream::get_stream_url,
            stream::clear_stream_cache,
            stream::search_ytdlp,
            ytdlp::ensure_ytdlp_ready,
            deps::refresh_playback_deps,
            deps::get_innertube_config,
            ytm_api::ytm_browse,
            discord::discord_update_presence,
            discord::discord_clear_presence,
            discord::discord_disconnect
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let _ = app_handle.global_shortcut().unregister_all();
                windows::close_auxiliary_windows(app_handle);
            }
        });
}
