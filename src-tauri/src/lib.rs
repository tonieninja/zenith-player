mod auth_store;
mod cover_cache;
mod deps;
mod diag;
mod discord;
mod downloads;
mod dualsense;
mod export_file;
mod jsc;
mod lastfm;
mod listenbrainz;
mod login_nav;
#[cfg(target_os = "linux")]
mod mpris;
mod native_audio;
mod player;
mod player_js;
mod portable;
#[cfg(target_os = "linux")]
mod portal_hotkeys;
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

pub(crate) fn mark(label: impl Into<String>) {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if !*ON.get_or_init(|| std::env::var("ZENITH_TRACE").as_deref() == Ok("1")) {
        return;
    }
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    eprintln!("[trace {ms}] {}", label.into());
}

pub(crate) fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
async fn post_webhook(webview: tauri::Webview, url: String, body: String) -> Result<u16, String> {
    auth_store::main_window_only(&webview)?;
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
    // bez przekierowań: adres sprawdzony wyżej nie może odbić żądania do sieci lokalnej
    let client = crate::player::client("", 8, false).ok_or("http client")?;
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
async fn get_ytm_cookies(app: tauri::AppHandle, webview: tauri::Webview) -> Result<String, String> {
    // mini bez okna głównego sam wysyła polubienia na konto, więc też dostaje ciasteczka
    if webview.label() != "mini-player" {
        auth_store::main_window_only(&webview)?;
    }
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
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = win.destroy();
        let _ = tx.send(());
    })
    .map_err(|e| e.to_string())?;
    // czekanie bez blokowania wątku tokio, na którym chodzą też inne komendy
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), rx).await;
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
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(150)).await,
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
// Linux: klawisze mediów idą przez MPRIS, a skróty (portal lub XGrabKey) dopiero po włączeniu w ustawieniach
static GLOBAL_HOTKEYS_ON: AtomicBool = AtomicBool::new(!cfg!(target_os = "linux"));
static HOTKEY_LOCK: Mutex<()> = Mutex::new(());

fn debug_log_enabled() -> bool {
    std::env::var_os("ZENITH_DEBUG").is_some()
}

pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    if windows::ensure_main(app) {
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
    } else if !windows::defer_ui_event("zenith-tray-action", action) {
        let _ = app.emit("zenith-tray-action", action);
    }
}

// zwykły GNOME nie ma zasobnika: appindicator wpada wtedy w niewidoczną GtkStatusIcon, a zamknięcie chowa okno w nicość
#[cfg(target_os = "linux")]
fn tray_host_present() -> bool {
    let has = || -> zbus::Result<bool> {
        let conn = zbus::blocking::Connection::session()?;
        let dbus = zbus::blocking::fdo::DBusProxy::new(&conn)?;
        Ok(dbus.name_has_owner("org.kde.StatusNotifierWatcher".try_into()?)?)
    };
    has().unwrap_or(true)
}

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "linux")]
    if !tray_host_present() {
        return Err("no StatusNotifier host".into());
    }
    let play = MenuItem::with_id(app, "tray-play", "Play / Pause", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "tray-next", "Next track", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "tray-show", "Show Zenith", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&play, &next, &show, &quit])?;

    // domyślna ikona to 16 px (Windows) albo 32 px (Linux), rozmyta w zasobniku przy skali powyżej 100%
    let tray_png: &[u8] = if cfg!(windows) {
        include_bytes!("../icons/32x32.png")
    } else {
        include_bytes!("../icons/128x128.png")
    };
    let icon = cfg!(not(target_os = "macos"))
        .then(|| tauri::image::Image::from_bytes(tray_png).ok())
        .flatten()
        .or_else(|| app.default_window_icon().cloned())
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

#[tauri::command]
fn set_close_to_tray(enabled: bool) -> bool {
    CLOSE_TO_TRAY.store(enabled, Ordering::SeqCst);
    enabled && TRAY_READY.load(Ordering::SeqCst)
}

#[tauri::command]
fn tray_available() -> bool {
    TRAY_READY.load(Ordering::SeqCst)
}

pub(crate) const HOTKEY_ACTIONS: [&str; 6] = [
    "toggle-play",
    "next",
    "prev",
    "volume-up",
    "volume-down",
    "like",
];

static HOTKEY_BINDINGS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
static HOTKEY_LIVE: Mutex<Vec<(tauri_plugin_global_shortcut::Shortcut, String)>> =
    Mutex::new(Vec::new());

pub(crate) fn default_hotkey_bindings() -> Vec<(String, String)> {
    vec![
        ("toggle-play".into(), "Ctrl+Alt+Space".into()),
        ("next".into(), "Ctrl+Alt+ArrowRight".into()),
        ("prev".into(), "Ctrl+Alt+ArrowLeft".into()),
        ("volume-up".into(), String::new()),
        ("volume-down".into(), String::new()),
        ("like".into(), String::new()),
    ]
}

fn is_reserved_accelerator(acc: &str) -> bool {
    let a = acc.trim().to_ascii_lowercase().replace(' ', "");
    matches!(
        a.as_str(),
        "ctrl+keyc"
            | "ctrl+keyv"
            | "ctrl+keyx"
            | "ctrl+keya"
            | "ctrl+keyq"
            | "ctrl+keyw"
            | "cmd+keyc"
            | "cmd+keyv"
            | "cmd+keyx"
            | "cmd+keya"
            | "cmd+keyq"
            | "cmd+keyw"
            | "super+keyc"
            | "super+keyv"
            | "super+keyx"
            | "super+keya"
            | "commandorcontrol+keyc"
            | "commandorcontrol+keyv"
            | "commandorcontrol+keyx"
            | "commandorcontrol+keya"
            | "commandorcontrol+keyq"
            | "commandorcontrol+keyw"
    )
}

pub(crate) fn parse_accelerator(acc: &str) -> Option<tauri_plugin_global_shortcut::Shortcut> {
    let acc = acc.trim();
    if acc.is_empty() || is_reserved_accelerator(acc) {
        return None;
    }
    acc.parse::<tauri_plugin_global_shortcut::Shortcut>().ok()
}

fn zenith_shortcuts() -> Vec<(tauri_plugin_global_shortcut::Shortcut, String)> {
    use tauri_plugin_global_shortcut::{Code, Shortcut};
    let bindings = {
        let b = HOTKEY_BINDINGS.lock().unwrap_or_else(|e| e.into_inner());
        if b.is_empty() {
            default_hotkey_bindings()
        } else {
            b.clone()
        }
    };
    let mut list: Vec<(Shortcut, String)> = Vec::new();
    for (action, acc) in bindings {
        if let Some(sc) = parse_accelerator(&acc) {
            if !list.iter().any(|(s, _)| *s == sc) {
                list.push((sc, action));
            }
        }
    }
    // na macOS klawisze mediów obsługuje Now Playing, a podsłuch CGEventTap wymaga zgody na dostępność
    if cfg!(windows) {
        list.push((
            Shortcut::new(None, Code::MediaPlayPause),
            "toggle-play".into(),
        ));
        list.push((Shortcut::new(None, Code::MediaTrackNext), "next".into()));
        list.push((Shortcut::new(None, Code::MediaTrackPrevious), "prev".into()));
    }
    list
}

pub(crate) fn hotkey_action_for(
    shortcut: &tauri_plugin_global_shortcut::Shortcut,
) -> Option<String> {
    let live = HOTKEY_LIVE.lock().unwrap_or_else(|e| e.into_inner());
    live.iter()
        .find(|(s, _)| s == shortcut)
        .map(|(_, a)| a.clone())
}

// GTK na natywnym Waylandzie: brak globalnych skrótów, pozycji okien i „zawsze na wierzchu”
pub(crate) fn native_wayland() -> bool {
    cfg!(target_os = "linux")
        && std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var("GDK_BACKEND").as_deref() != Ok("x11")
}

fn apply_global_shortcuts(app: &tauri::AppHandle, enabled: bool) -> usize {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let _guard = HOTKEY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let gs = app.global_shortcut();
    // HOTKEY_LIVE czyta handler skrótu na wątku X11; trzymany podczas register() mógł zakleszczyć oba wątki
    let old = std::mem::take(&mut *HOTKEY_LIVE.lock().unwrap_or_else(|e| e.into_inner()));
    for (sc, _) in old {
        if gs.is_registered(sc) {
            let _ = gs.unregister(sc);
        }
    }
    // global-hotkey łapie klawisze tylko przez X11; na Waylandzie rejestracja „udaje się”, a skrót nigdy nie działa
    if native_wayland() {
        #[cfg(target_os = "linux")]
        {
            let bindings = HOTKEY_BINDINGS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            // pusta lista = start przed ustawieniami z frontendu, a portal przyjmuje skróty tylko raz
            if enabled && !bindings.is_empty() {
                portal_hotkeys::sync(app, bindings);
            } else if !enabled {
                portal_hotkeys::close();
            }
        }
        return 0;
    }
    if !enabled {
        return 0;
    }
    let mut live = Vec::new();
    for (shortcut, action) in zenith_shortcuts() {
        match gs.register(shortcut) {
            Ok(()) => live.push((shortcut, action)),
            Err(e) => {
                if debug_log_enabled() {
                    eprintln!("[zenith] global shortcut {shortcut} unavailable: {e}");
                }
            }
        }
    }
    let n = live.len();
    *HOTKEY_LIVE.lock().unwrap_or_else(|e| e.into_inner()) = live;
    n
}

#[tauri::command]
fn set_global_hotkey_bindings(
    app: tauri::AppHandle,
    bindings: std::collections::HashMap<String, String>,
) -> Vec<String> {
    let mut list = Vec::new();
    let mut bad = Vec::new();
    for a in HOTKEY_ACTIONS {
        let acc = bindings.get(a).cloned().unwrap_or_default();
        if !acc.trim().is_empty() && parse_accelerator(&acc).is_none() {
            bad.push(a.to_string());
        }
        list.push((a.to_string(), acc));
    }
    *HOTKEY_BINDINGS.lock().unwrap_or_else(|e| e.into_inner()) = list;
    let on = GLOBAL_HOTKEYS_ON.load(Ordering::SeqCst);
    apply_global_shortcuts(&app, on);
    // nic nie próbowano rejestrować, więc nie ma czego zgłaszać jako zajęte przez inną aplikację
    if !on || native_wayland() {
        return bad;
    }
    let live = HOTKEY_LIVE.lock().unwrap_or_else(|e| e.into_inner());
    for (a, acc) in bindings {
        if let Some(sc) = parse_accelerator(&acc) {
            if !live.iter().any(|(s, _)| *s == sc) && !bad.contains(&a) {
                bad.push(a);
            }
        }
    }
    bad
}

#[tauri::command]
fn set_global_hotkeys(app: tauri::AppHandle, enabled: bool) -> usize {
    GLOBAL_HOTKEYS_ON.store(enabled, Ordering::SeqCst);
    apply_global_shortcuts(&app, enabled)
}

#[tauri::command]
async fn cover_cache_base() -> Result<String, String> {
    stream_proxy::ensure_ready().await?;
    stream_proxy::cover_base().ok_or_else(|| "proxy not ready".to_string())
}

// macOS ma domyślne menu Tauri z Quit, Hide i Undo; podmiana zostawiłaby samo Edit jako menu aplikacji
#[cfg(windows)]
fn install_edit_menu(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::menu::{PredefinedMenuItem, Submenu};
    let cut = PredefinedMenuItem::cut(app, None).map_err(|e| e.to_string())?;
    let copy = PredefinedMenuItem::copy(app, None).map_err(|e| e.to_string())?;
    let paste = PredefinedMenuItem::paste(app, None).map_err(|e| e.to_string())?;
    let select_all = PredefinedMenuItem::select_all(app, None).map_err(|e| e.to_string())?;
    let edit = Submenu::with_items(app, "Edit", true, &[&cut, &copy, &paste, &select_all])
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&edit]).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

// rpm 6 (Fedora 45+) odrzuca niepodpisaną paczkę w `rpm -U` updatera; wtedy zostaje link do wydania i dnf
#[tauri::command]
fn rpm_update_blocked() -> bool {
    use tauri::utils::{config::BundleType, platform::bundle_type};
    matches!(bundle_type(), Some(BundleType::Rpm))
        && std::process::Command::new("rpm")
            .args(["--eval", "%{_pkgverify_level}"])
            .output()
            .is_ok_and(|o| {
                matches!(
                    String::from_utf8_lossy(&o.stdout).trim(),
                    "signature" | "all"
                )
            })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    mark("app start");
    win_proxy::init();
    #[cfg(windows)]
    if !webview2_check::ensure() {
        return;
    }
    webview_tuning::early_init();
    // GTK3 wysyła prgname jako Wayland app_id, a KWin szuka ikony w <app_id>.desktop, czyli Zenith.desktop z paczki
    #[cfg(target_os = "linux")]
    webkit2gtk::glib::set_prgname(Some("Zenith"));
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if windows::ensure_main(app) {
                return;
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let Some(action) = hotkey_action_for(shortcut) else {
                        return;
                    };
                    tray_action(app, &action);
                })
                .build(),
        )
        .setup(|app| {
            portable::cleanup_old_exe();
            cover_cache::init(app.handle());
            if let Ok(dir) = app.path().app_cache_dir() {
                native_audio::set_spool_dir(dir.join("audio"));
            }
            downloads::init(app.handle());
            #[cfg(windows)]
            if let Err(e) = install_edit_menu(app.handle()) {
                eprintln!("[zenith] edit menu unavailable: {e}");
            }
            if let Some(main) = app.get_webview_window("main") {
                webview_tuning::tune(&main);
                // 1280x800 z konfiguracji nie mieści się na 1366x768 ani na 1080p przy skali 150%
                windows::keep_on_screen(&main);
                windows::fit_first_open(&main);
            }
            tauri::async_runtime::spawn(stream_proxy::start_background());
            potoken::init(app.handle());
            stream::init(app.handle());
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                crate::deps::hydrate(&handle);
                let report = crate::deps::refresh_all(&handle);
                eprintln!(
                    "[Zenith] deps player={} innertube={} updated_it={}",
                    report.player_version.as_deref().unwrap_or("-"),
                    report.innertube_version.as_deref().unwrap_or("-"),
                    report.innertube_updated
                );
            });
            if let Err(e) = setup_tray(app) {
                if debug_log_enabled() {
                    eprintln!("[zenith] tray unavailable: {e}");
                }
            }
            apply_global_shortcuts(app.handle(), GLOBAL_HOTKEYS_ON.load(Ordering::SeqCst));
            #[cfg(target_os = "linux")]
            if native_wayland() {
                windows::kwin_pin_aux_windows();
            }
            native_audio::init(app.handle());
            {
                use tauri::Listener;
                // bez okna głównego przyciski mini odtwarzacza obsługuje sam Rust
                app.listen_any("zenith-mini-action", |ev| {
                    let Ok(action) = serde_json::from_str::<String>(ev.payload()) else {
                        return;
                    };
                    if native_audio::is_headless() {
                        native_audio::headless::mini_action(&action);
                    } else {
                        windows::defer_ui_event("zenith-mini-action", &action);
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                if window.label() != "main" {
                    return;
                }
                api.prevent_close();
                if CLOSE_TO_TRAY.load(Ordering::SeqCst)
                    && TRAY_READY.load(Ordering::SeqCst)
                    && !windows::is_shutting_down()
                {
                    let _ = window.hide();
                    if let Some(wv) = window.app_handle().get_webview_window("main") {
                        wv2_mem::set_low(&wv, true);
                    }
                    windows::hold_ui();
                    let _ = window.emit_to("main", "zenith-hidden-to-tray", ());
                    windows::main_hidden(window.app_handle());
                } else {
                    windows::graceful_shutdown(window.app_handle());
                }
            }
            WindowEvent::Resized(_) if window.label() == "main" => {
                if let Some(wv) = window.app_handle().get_webview_window("main") {
                    let hidden =
                        wv.is_minimized().unwrap_or(false) || !wv.is_visible().unwrap_or(true);
                    wv2_mem::set_low(&wv, hidden);
                }
            }
            WindowEvent::Focused(focused) if window.label() == "main" => {
                if let Some(wv) = window.app_handle().get_webview_window("main") {
                    if *focused && !wv.is_minimized().unwrap_or(false) {
                        wv2_mem::set_low(&wv, false);
                    }
                    wv2_mem::on_focus(&wv, *focused);
                }
            }
            // na natywnym Waylandzie tao zgłasza przy każdej zmianie (0,0) i nadpisałby zapisane pozycje
            WindowEvent::Moved(pos) if !native_wayland() => {
                windows::remember_position(window.app_handle(), window.label(), *pos);
            }
            WindowEvent::Destroyed => {
                let label = window.label().to_string();
                if windows::AUX_WINDOW_LABELS.contains(&label.as_str())
                    && !windows::is_shutting_down()
                {
                    let app = window.app_handle();
                    if app.get_webview_window("main").is_some() && windows::ui_is_ready() {
                        let _ = app.emit_to("main", "zenith-aux-window-closed", label);
                    } else {
                        windows::note_aux_closed(app, &label);
                    }
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            mpris_update,
            rpm_update_blocked,
            native_audio::zaudio_available,
            native_audio::zaudio_duck,
            native_audio::zaudio_duck_meter,
            native_audio::zaudio_cmd,
            native_audio::zaudio_play,
            native_audio::zaudio_wait_ready,
            native_audio::zaudio_crossfade,
            native_audio::zaudio_preroll,
            native_audio::zaudio_tail,
            native_audio::zaudio_plan,
            native_audio::zaudio_attach,
            native_audio::zaudio_snapshot,
            windows::ui_ready,
            cover_cache_base,
            get_ytm_cookies,
            spotify_auth::spotify_wait_for_code,
            spotify_auth::spotify_token_load,
            spotify_auth::spotify_token_save,
            export_file::save_playlist_export,
            post_webhook,
            prefs::prefs_load,
            prefs::prefs_save,
            prefs::favorites_load,
            prefs::favorites_save,
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
            windows::ui_keep,
            windows::aux_closed_take,
            windows::app_prepare_shutdown,
            set_tray_labels,
            set_close_to_tray,
            tray_available,
            set_global_hotkeys,
            set_global_hotkey_bindings,
            lastfm::lastfm_status,
            lastfm::lastfm_set_keys,
            lastfm::lastfm_begin_auth,
            lastfm::lastfm_finish_auth,
            lastfm::lastfm_logout,
            lastfm::lastfm_now_playing,
            lastfm::lastfm_scrobble,
            listenbrainz::listenbrainz_status,
            listenbrainz::listenbrainz_set_token,
            listenbrainz::listenbrainz_logout,
            listenbrainz::listenbrainz_now_playing,
            listenbrainz::listenbrainz_submit,
            remote::remote_start,
            remote::remote_stop,
            remote::remote_info,
            remote::remote_forget_devices,
            remote::remote_push,
            remote::remote_firewall_status,
            remote::remote_firewall_allow,
            portable::app_is_portable,
            portable::portable_update_check,
            portable::portable_update_install,
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
            downloads::downloads_list,
            downloads::downloads_add,
            downloads::downloads_delete,
            downloads::downloads_clear,
            stream::stream_last_failure,
            stream::clear_stream_cache,
            stream::search_videos,
            stream::resolve_alternate_stream,
            deps::refresh_playback_deps,
            deps::get_innertube_config,
            ytm_api::ytm_browse,
            discord::discord_update_presence,
            discord::discord_clear_presence,
            discord::discord_disconnect,
            discord::discord_status,
            diag::stream_diagnostics
        ])
        .build(windows::with_user_webview_args(tauri::generate_context!()))
        .unwrap_or_else(|e| {
            #[cfg(windows)]
            webview2_check::fatal(&e.to_string());
            #[cfg(not(windows))]
            panic!("error while building tauri application: {e}");
        })
        .run(|app_handle, event| {
            // okno schowane do zasobnika trzeba móc przywrócić z Docka i Findera
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                show_main_window(app_handle);
            }
            if let RunEvent::ExitRequested {
                code: None, api, ..
            } = &event
            {
                if native_audio::is_headless() && !windows::is_shutting_down() {
                    api.prevent_exit();
                    return;
                }
            }
            if let RunEvent::Exit = event {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let _ = app_handle.global_shortcut().unregister_all();
                windows::close_auxiliary_windows(app_handle);
            }
        });
}

#[cfg(test)]
mod hotkey_tests {
    use super::*;

    #[test]
    fn default_bindings_parse() {
        for (a, acc) in default_hotkey_bindings() {
            assert!(HOTKEY_ACTIONS.contains(&a.as_str()));
            if !acc.is_empty() {
                assert!(parse_accelerator(&acc).is_some(), "{acc}");
            }
        }
    }

    #[test]
    fn accelerator_parsing() {
        assert!(parse_accelerator("Ctrl+Shift+KeyP").is_some());
        assert!(parse_accelerator("Alt+F9").is_some());
        assert!(parse_accelerator("").is_none());
        assert!(parse_accelerator("Ctrl+Nope").is_none());
        assert!(
            parse_accelerator("Ctrl+KeyV").is_none(),
            "Ctrl+V must not be a global hotkey"
        );
        assert!(parse_accelerator("Ctrl+KeyC").is_none());
        assert!(parse_accelerator("Ctrl+KeyQ").is_none());
    }
}
