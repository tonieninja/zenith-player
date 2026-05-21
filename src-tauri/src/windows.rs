use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

pub const AUX_WINDOW_LABELS: [&str; 4] = [
    "lyrics-overlay",
    "lyrics-second",
    "mini-player",
    "google-login",
];

const REMEMBERED_LABELS: [&str; 3] = ["lyrics-overlay", "lyrics-second", "mini-player"];

static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
struct SavedPos {
    x: i32,
    y: i32,
}

static POSITIONS: Mutex<Option<HashMap<String, SavedPos>>> = Mutex::new(None);

pub const WEBVIEW2_ARGS: &str = "--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,IntensiveWakeUpThrottling,msWebOOUI,msPdfOOUI,msSmartScreenProtection,SpareRendererForSitePerProcess,BackForwardCache,Translate,OptimizationHints,MediaRouter,AutofillServerCommunication --disable-background-networking --disable-component-update --disable-domain-reliability --disable-sync --no-pings --renderer-process-limit=1";

pub fn merged_webview_args() -> String {
    match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        Ok(extra) if !extra.trim().is_empty() => format!("{WEBVIEW2_ARGS} {}", extra.trim()),
        _ => WEBVIEW2_ARGS.to_string(),
    }
}

pub fn with_user_webview_args<R: tauri::Runtime>(mut ctx: tauri::Context<R>) -> tauri::Context<R> {
    let args = merged_webview_args();
    for w in ctx.config_mut().app.windows.iter_mut() {
        w.additional_browser_args = Some(args.clone());
    }
    ctx
}

fn positions_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("aux_windows.json"))
}

fn with_positions<T>(app: &AppHandle, f: impl FnOnce(&mut HashMap<String, SavedPos>) -> T) -> T {
    let mut guard = POSITIONS.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        let loaded = positions_file(app)
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<HashMap<String, SavedPos>>(&s).ok())
            .unwrap_or_default();
        *guard = Some(loaded);
    }
    f(guard.as_mut().expect("positions map initialised above"))
}

pub fn remember_position(app: &AppHandle, label: &str, pos: PhysicalPosition<i32>) {
    if !REMEMBERED_LABELS.contains(&label) {
        return;
    }
    let snapshot = with_positions(app, |map| {
        map.insert(label.to_string(), SavedPos { x: pos.x, y: pos.y });
        map.clone()
    });
    if let (Some(path), Ok(json)) = (positions_file(app), serde_json::to_string(&snapshot)) {
        let _ = std::fs::write(path, json);
    }
}

fn saved_position(app: &AppHandle, label: &str) -> Option<(f64, f64)> {
    let pos = with_positions(app, |map| map.get(label).copied())?;
    let monitors = app.available_monitors().ok()?;
    let visible = monitors.iter().any(|m| {
        let mp = m.position();
        let ms = m.size();
        let cx = pos.x + 40;
        let cy = pos.y + 20;
        cx >= mp.x && cy >= mp.y && cx < mp.x + ms.width as i32 && cy < mp.y + ms.height as i32
    });
    if !visible {
        return None;
    }
    let scale = monitors
        .iter()
        .find(|m| {
            let mp = m.position();
            let ms = m.size();
            pos.x >= mp.x
                && pos.x < mp.x + ms.width as i32
                && pos.y >= mp.y
                && pos.y < mp.y + ms.height as i32
        })
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    Some((pos.x as f64 / scale, pos.y as f64 / scale))
}

fn main_monitor_rect(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| app.available_monitors().ok()?.into_iter().next())?;
    let scale = monitor.scale_factor();
    let pos = monitor.position();
    let size = monitor.size();
    Some((
        pos.x as f64 / scale,
        pos.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    ))
}

pub(crate) fn app_url(page: &str) -> Result<WebviewUrl, String> {
    if cfg!(debug_assertions) {
        let raw = format!("http://localhost:1420/{}", page);
        raw.parse::<url::Url>()
            .map(WebviewUrl::External)
            .map_err(|e| e.to_string())
    } else {
        Ok(WebviewUrl::App(page.into()))
    }
}

pub fn close_auxiliary_windows(app: &AppHandle) {
    for label in AUX_WINDOW_LABELS {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.hide();
            let _ = win.destroy();
        }
    }
}

fn unregister_shortcuts(app: &AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let _ = app.global_shortcut().unregister_all();
}

pub fn graceful_shutdown(app: &AppHandle) {
    if SHUTTING_DOWN.swap(true, Ordering::SeqCst) {
        return;
    }

    if crate::native_audio::is_headless() {
        crate::native_audio::headless::save_state();
    }
    let _ = app.emit_to("main", "zenith-app-quitting", ());
    unregister_shortcuts(app);

    let app = app.clone();
    if app
        .run_on_main_thread({
            let app = app.clone();
            move || {
                close_auxiliary_windows(&app);

                let app2 = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(180));
                    let app3 = app2.clone();
                    if app2
                        .run_on_main_thread(move || {
                            app3.exit(0);
                        })
                        .is_err()
                    {
                        std::process::exit(0);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    std::process::exit(0);
                });
            }
        })
        .is_err()
    {
        std::process::exit(0);
    }
}

pub fn is_shutting_down() -> bool {
    SHUTTING_DOWN.load(Ordering::SeqCst)
}

pub fn aux_windows_use_transparency() -> bool {
    !cfg!(target_os = "linux")
}

fn style_aux_window<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    mut b: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    b = b
        .always_on_top(true)
        .decorations(false)
        .shadow(false)
        .skip_taskbar(true)
        .focused(false);
    if aux_windows_use_transparency() {
        b.transparent(true)
    } else {
        b.transparent(false)
            .background_color(tauri::window::Color(10, 11, 16, 255))
    }
}

fn reveal_aux_window(win: &tauri::WebviewWindow) {
    let _ = win.show();
    keep_on_screen(win);
}

#[tauri::command]
pub fn app_prepare_shutdown(app: AppHandle) -> Result<(), String> {
    graceful_shutdown(&app);
    Ok(())
}

fn refocus_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_focus();
    }
}

fn show_without_focus(win: &tauri::WebviewWindow) -> Result<(), String> {
    if !win.is_visible().unwrap_or(false) {
        win.show().map_err(|e| e.to_string())?;
    }
    refocus_main(win.app_handle());
    Ok(())
}

#[tauri::command]
pub async fn open_lyrics_overlay(app: AppHandle) -> Result<(), String> {
    if is_shutting_down() {
        return Ok(());
    }
    if let Some(existing) = app.get_webview_window("lyrics-overlay") {
        return show_without_focus(&existing);
    }

    let (w, h) = (640.0, 160.0);
    let (x, y) = saved_position(&app, "lyrics-overlay").unwrap_or_else(|| {
        main_monitor_rect(&app)
            .map(|(mx, my, mw, mh)| (mx + (mw - w) / 2.0, my + (mh - h - 120.0).max(0.0)))
            .unwrap_or((100.0, 100.0))
    });

    let builder = WebviewWindowBuilder::new(&app, "lyrics-overlay", app_url("overlay.html")?)
        .additional_browser_args(&merged_webview_args())
        .enable_clipboard_access()
        .title("Zenith Lyrics")
        .inner_size(w, h)
        .min_inner_size(420.0, 96.0)
        .position(x, y)
        .resizable(true);
    let win = style_aux_window(builder)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.set_ignore_cursor_events(true);
    reveal_aux_window(&win);
    crate::webview_tuning::tune(&win);
    refocus_main(&app);
    Ok(())
}

pub fn clamp_rect(
    (x, y, w, h): (i32, i32, i32, i32),
    (ax, ay, aw, ah): (i32, i32, i32, i32),
) -> (i32, i32, i32, i32) {
    let w = w.min(aw).max(1);
    let h = h.min(ah).max(1);
    let x = x.clamp(ax, ax + aw - w);
    let y = y.clamp(ay, ay + ah - h);
    (x, y, w, h)
}

fn keep_on_screen(win: &tauri::WebviewWindow) {
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
        return;
    };
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten());
    let Some(m) = monitor else { return };
    let wa = m.work_area();
    let area = (
        wa.position.x,
        wa.position.y,
        wa.size.width as i32,
        wa.size.height as i32,
    );
    let cur = (pos.x, pos.y, size.width as i32, size.height as i32);
    let fixed = clamp_rect(cur, area);
    if fixed.2 != cur.2 || fixed.3 != cur.3 {
        let _ = win.set_size(tauri::PhysicalSize::new(fixed.2 as u32, fixed.3 as u32));
    }
    if fixed.0 != cur.0 || fixed.1 != cur.1 {
        let _ = win.set_position(PhysicalPosition::new(fixed.0, fixed.1));
    }
}

#[cfg(test)]
mod clamp_tests {
    use super::clamp_rect;

    #[test]
    fn pulls_a_window_back_from_the_top_left() {
        assert_eq!(
            clamp_rect((-50, -30, 800, 300), (0, 0, 1920, 1040)),
            (0, 0, 800, 300)
        );
    }

    #[test]
    fn shrinks_a_window_bigger_than_the_screen() {
        assert_eq!(
            clamp_rect((100, 900, 1600, 400), (0, 0, 1280, 680)),
            (0, 280, 1280, 400)
        );
    }

    #[test]
    fn respects_a_second_monitor_on_the_left() {
        assert_eq!(
            clamp_rect((-2000, 10, 860, 330), (-1920, 0, 1920, 1080)),
            (-1920, 10, 860, 330)
        );
    }
}

#[tauri::command]
pub async fn open_lyrics_second_screen(app: AppHandle) -> Result<(), String> {
    if is_shutting_down() {
        return Ok(());
    }
    if let Some(existing) = app.get_webview_window("lyrics-second") {
        return show_without_focus(&existing);
    }

    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let main_mon = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten());
    let target = monitors
        .iter()
        .find(|m| match &main_mon {
            Some(mm) => m.position() != mm.position(),
            None => false,
        })
        .cloned()
        .or_else(|| main_mon.clone())
        .or_else(|| monitors.first().cloned())
        .ok_or("No monitor found")?;
    let single_screen = monitors.len() < 2;
    let scale = target.scale_factor();
    let pos = target.position();
    let size = target.size();
    let mon_x = pos.x as f64 / scale;
    let mon_y = pos.y as f64 / scale;
    let mon_w = size.width as f64 / scale;
    let mon_h = size.height as f64 / scale;
    let (w, h) = if single_screen {
        ((mon_w * 0.7).max(640.0), 340.0)
    } else {
        (mon_w, (mon_h * 0.55).max(360.0))
    };
    let default_pos = if single_screen {
        (mon_x + (mon_w - w) / 2.0, mon_y + 48.0)
    } else {
        (mon_x, mon_y + mon_h - h)
    };
    let (x, y) = saved_position(&app, "lyrics-second").unwrap_or(default_pos);

    let builder = WebviewWindowBuilder::new(&app, "lyrics-second", app_url("overlay.html")?)
        .additional_browser_args(&merged_webview_args())
        .enable_clipboard_access()
        .title("Zenith Lyrics")
        .resizable(true)
        .min_inner_size(560.0, 260.0)
        .inner_size(w, h)
        .position(x, y);
    let win = style_aux_window(builder)
        .build()
        .map_err(|e| e.to_string())?;
    reveal_aux_window(&win);
    crate::webview_tuning::tune(&win);
    refocus_main(&app);
    Ok(())
}

#[tauri::command]
pub async fn open_mini_player(app: AppHandle) -> Result<(), String> {
    if is_shutting_down() {
        return Ok(());
    }
    if let Some(existing) = app.get_webview_window("mini-player") {
        return show_without_focus(&existing);
    }

    let (w, h) = (400.0, 96.0);
    let (x, y) = saved_position(&app, "mini-player").unwrap_or_else(|| {
        main_monitor_rect(&app)
            .map(|(mx, my, mw, mh)| (mx + mw - w - 24.0, my + mh - h - 140.0))
            .unwrap_or((100.0, 100.0))
    });

    let builder = WebviewWindowBuilder::new(&app, "mini-player", app_url("mini.html")?)
        .additional_browser_args(&merged_webview_args())
        .enable_clipboard_access()
        .title("Zenith Mini")
        .inner_size(w, h)
        .min_inner_size(340.0, 84.0)
        .position(x, y)
        .resizable(true);
    let win = style_aux_window(builder)
        .build()
        .map_err(|e| e.to_string())?;
    reveal_aux_window(&win);
    crate::webview_tuning::tune(&win);
    refocus_main(&app);
    Ok(())
}

#[tauri::command]
pub async fn close_window(app: AppHandle, label: String) -> Result<(), String> {
    if label == "main" || !AUX_WINDOW_LABELS.contains(&label.as_str()) {
        return Err("refusing to close this window".into());
    }
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.hide();
        win.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod aux_style_tests {
    #[test]
    fn linux_aux_windows_skip_transparency() {
        assert_eq!(
            super::aux_windows_use_transparency(),
            !cfg!(target_os = "linux")
        );
    }
}

#[cfg(test)]
mod args_tests {
    #[test]
    fn webview2_args_match_main_window() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["app"]["windows"][0]["additionalBrowserArgs"]
                .as_str()
                .unwrap(),
            super::WEBVIEW2_ARGS
        );
    }
}
