use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

fn aux_closed_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("aux_closed.txt"))
}

/// Okno wtyczki zamknięte, gdy nie ma okna głównego; zapis na dysku przetrwa też wyjście z zasobnika.
pub fn note_aux_closed(app: &AppHandle, label: &str) {
    let Some(path) = aux_closed_file(app) else {
        return;
    };
    let mut list = std::fs::read_to_string(&path).unwrap_or_default();
    if !list.lines().any(|l| l == label) {
        list.push_str(label);
        list.push('\n');
        let _ = std::fs::write(path, list);
    }
}

#[tauri::command]
pub fn aux_closed_take(app: AppHandle) -> Vec<String> {
    let Some(path) = aux_closed_file(&app) else {
        return Vec::new();
    };
    let list = std::fs::read_to_string(&path).unwrap_or_default();
    let _ = std::fs::remove_file(&path);
    list.lines()
        .filter(|l| REMEMBERED_LABELS.contains(l))
        .map(String::from)
        .collect()
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
    with_positions(app, |map| {
        map.insert(label.to_string(), SavedPos { x: pos.x, y: pos.y });
    });
    // przeciąganie to dziesiątki zdarzeń na sekundę; na dysk idzie stan po chwili ciszy
    static PENDING: AtomicBool = AtomicBool::new(false);
    if PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        PENDING.store(false, Ordering::SeqCst);
        let snapshot = with_positions(&app, |map| map.clone());
        if let (Some(path), Ok(json)) = (positions_file(&app), serde_json::to_string(&snapshot)) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    });
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
    if UI_READY.load(Ordering::SeqCst) {
        crate::webview_tuning::clear_gpu_probe();
    }

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

static HIDE_GEN: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
struct MainGeo {
    pos: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    maximized: bool,
}
static MAIN_GEO: Mutex<Option<MainGeo>> = Mutex::new(None);
static KEEP_UI: AtomicBool = AtomicBool::new(false);
// zanim JS okna głównego podepnie nasłuchy, akcje z zasobnika, skrótów i mini czekają tutaj zamiast przepaść
static UI_READY: AtomicBool = AtomicBool::new(false);
static NOT_READY_AT: AtomicU64 = AtomicU64::new(0);
static PENDING_UI: Mutex<Vec<(&'static str, String)>> = Mutex::new(Vec::new());

// po 15 s bez sygnału z JS wysyłamy normalnie, żeby zasobnik nie utknął z martwą kolejką
pub fn ui_is_ready() -> bool {
    let now = now_ms();
    UI_READY.load(Ordering::SeqCst)
        || now.saturating_sub(NOT_READY_AT.load(Ordering::SeqCst)) > 15_000
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn mark_not_ready() {
    NOT_READY_AT.store(now_ms(), Ordering::SeqCst);
    UI_READY.store(false, Ordering::SeqCst);
}

/// Zwraca false, gdy okno jest gotowe i zdarzenie trzeba wysłać od razu.
pub fn defer_ui_event(event: &'static str, payload: &str) -> bool {
    if ui_is_ready() {
        return false;
    }
    let mut q = PENDING_UI.lock().unwrap_or_else(|p| p.into_inner());
    if q.len() < 32 {
        q.push((event, payload.to_string()));
    }
    true
}

#[tauri::command]
pub fn ui_ready(app: AppHandle) {
    UI_READY.store(true, Ordering::SeqCst);
    crate::webview_tuning::gpu_render_ok();
    let q = std::mem::take(&mut *PENDING_UI.lock().unwrap_or_else(|p| p.into_inner()));
    for (event, payload) in q {
        let _ = app.emit_to("main", event, payload);
    }
}

/// JS po schowaniu okna mówi, czy musi żyć dalej: wtyczki bez odpowiednika w Ruście albo dociąganie radia.
#[tauri::command]
pub fn ui_keep(app: AppHandle, keep: bool) {
    KEEP_UI.store(keep, Ordering::SeqCst);
    let hidden = app
        .get_webview_window("main")
        .is_some_and(|w| !w.is_visible().unwrap_or(true));
    if !keep && hidden {
        main_hidden(&app);
    }
}

// do odpowiedzi JS okno zostaje; zgubione zdarzenie (zasobnik tuż po starcie) nie może go zwolnić z wtyczkami
pub fn hold_ui() {
    KEEP_UI.store(true, Ordering::SeqCst);
}

pub fn ui_drop_enabled() -> bool {
    // po powrocie okno odtwarza widok z migawki, więc w zasobniku może zostać sam Rust zamiast całego WebView
    let default_on = cfg!(any(target_os = "linux", windows));
    crate::native_audio::available()
        && match std::env::var("ZENITH_UI_DROP").as_deref() {
            Ok("0") => false,
            Ok("1") => true,
            _ => default_on,
        }
}

fn ui_drop_delay_ms() -> u64 {
    std::env::var("ZENITH_UI_DROP_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        // na Windows okno często chowa się i wraca co chwilę, a każde zwolnienie to sekunda budowania od nowa
        .unwrap_or(if cfg!(windows) { 30_000 } else { 3000 })
}

pub fn main_hidden(app: &AppHandle) {
    if !ui_drop_enabled() {
        return;
    }
    let gen = HIDE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(ui_drop_delay_ms()));
        if HIDE_GEN.load(Ordering::SeqCst) != gen || is_shutting_down() {
            return;
        }
        let a = app.clone();
        let _ = app.run_on_main_thread(move || drop_main(&a));
    });
}

pub fn drop_main(app: &AppHandle) {
    // okna wtyczek nie trzymają okna głównego: bez niego utwór i zegar podaje im headless::now_playing
    if KEEP_UI.load(Ordering::SeqCst) {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(true) {
            return;
        }
        if let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) {
            let maximized = w.is_maximized().unwrap_or(false);
            let mut geo = MAIN_GEO.lock().unwrap_or_else(|p| p.into_inner());
            // rozmiar zmaksymalizowanego okna to obszar roboczy; po przywróceniu zostaje ostatni zwykły
            match (maximized, geo.as_mut()) {
                (true, Some(g)) => g.maximized = true,
                _ => {
                    *geo = Some(MainGeo {
                        pos,
                        size,
                        maximized,
                    })
                }
            }
        }
        mark_not_ready();
        crate::native_audio::set_headless(true);
        #[cfg(target_os = "linux")]
        let _ = w.with_webview(|wv| {
            use webkit2gtk::WebViewExt;
            wv.inner().terminate_web_process();
        });
        let _ = w.destroy();
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            #[cfg(target_os = "linux")]
            unsafe {
                libc::malloc_trim(0);
            }
            // szybki powrót okna w tych 1,5 s nie może zostawić mini i nakładki na niskim limicie pamięci
            if app.get_webview_window("main").is_none() {
                crate::wv2_mem::aux_low(&app, true);
            }
        });
    }
}

pub fn ensure_main(app: &AppHandle) -> bool {
    HIDE_GEN.fetch_add(1, Ordering::SeqCst);
    if app.get_webview_window("main").is_some() {
        return false;
    }
    mark_not_ready();
    let Some(cfg) = app.config().app.windows.first().cloned() else {
        return false;
    };
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        // budowane niewidoczne: inaczej mignie w domyślnym miejscu, zanim trafi na zapamiętaną pozycję
        let built = WebviewWindowBuilder::from_config(&h, &cfg).map(|b| {
            b.visible(false)
                .enable_clipboard_access()
                .initialization_script(
                    "window.__ZENITH_RESTORED__ = true; window.close = function () {};",
                )
        });
        match built.and_then(|b| b.build()) {
            Ok(w) => {
                crate::webview_tuning::tune(&w);
                crate::wv2_mem::aux_low(&h, false);
                if let Some(g) = *MAIN_GEO.lock().unwrap_or_else(|p| p.into_inner()) {
                    let _ = w.set_size(g.size);
                    let _ = w.set_position(g.pos);
                    // monitor odłączony, gdy okno siedziało w zasobniku: bez tego wróciłoby poza ekran
                    keep_on_screen(&w);
                    if g.maximized {
                        let _ = w.maximize();
                    }
                }
                let _ = w.show();
                let _ = w.set_focus();
            }
            Err(e) => eprintln!("[zenith] main window rebuild failed: {e}"),
        }
    });
    true
}

pub fn aux_windows_use_transparency() -> bool {
    !cfg!(target_os = "linux")
}

// GTK3 na Waylandzie ignoruje keep_above i skip_taskbar; w KWin ustawia je tylko jego własny skrypt
#[cfg(target_os = "linux")]
pub(crate) fn kwin_pin_aux_windows() {
    std::thread::spawn(|| {
        let run = || -> Result<(), Box<dyn std::error::Error>> {
            const KWIN: Option<&str> = Some("org.kde.KWin");
            const SCRIPTING: Option<&str> = Some("org.kde.kwin.Scripting");
            let conn = zbus::blocking::Connection::session()?;
            let file = std::env::var_os("XDG_RUNTIME_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
                .join(format!("zenith-kwin-pin-{}.js", std::process::id()));
            // KWin 6 ma stackingOrder i windowAdded, KWin 5 clientList() i clientAdded
            const PIN_JS: &str = r#"function pin(w) {
  if (w && w.pid == ZENITH_PID && /^Zenith (Lyrics|Mini)/.test(w.caption)) {
    w.keepAbove = true;
    w.skipTaskbar = true;
  }
}
(workspace.stackingOrder || workspace.clientList()).forEach(pin);
(workspace.windowAdded || workspace.clientAdded).connect(pin);
"#;
            let js = PIN_JS.replace("ZENITH_PID", &std::process::id().to_string());
            let _ = std::fs::remove_file(&file);
            // create_new nie pójdzie za dowiązaniem podłożonym we wspólnym /tmp ani nie nadpisze cudzego pliku
            std::io::Write::write_all(
                &mut std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&file)?,
                js.as_bytes(),
            )?;
            let path = file.to_string_lossy().to_string();
            let _ = conn.call_method(
                KWIN,
                "/Scripting",
                SCRIPTING,
                "unloadScript",
                &("zenith-pin",),
            );
            conn.call_method(
                KWIN,
                "/Scripting",
                SCRIPTING,
                "loadScript",
                &(path.as_str(), "zenith-pin"),
            )?;
            conn.call_method(KWIN, "/Scripting", SCRIPTING, "start", &())?;
            Ok(())
        };
        if let Err(e) = run() {
            if crate::debug_log_enabled() {
                eprintln!("[zenith] kwin pin unavailable: {e}");
            }
        }
    });
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

// stałe 1280x800 na 1440p czy 4K przy skali 2 to okienko na pół ekranu, w którym treść się nie mieści
pub fn first_open_size((w, h): (u32, u32), (aw, ah): (u32, u32)) -> (u32, u32) {
    let fit = |cur: u32, area: u32| (area / 5 * 4).max(cur).min(area);
    (fit(w, aw), fit(h, ah))
}

pub(crate) fn fit_first_open(win: &tauri::WebviewWindow) {
    let Ok(size) = win.inner_size() else {
        return;
    };
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())
        .or_else(|| win.available_monitors().ok()?.into_iter().next());
    let Some(m) = monitor else { return };
    let area = m.work_area().size;
    let want = first_open_size((size.width, size.height), (area.width, area.height));
    if want != (size.width, size.height) {
        let _ = win.set_size(tauri::PhysicalSize::new(want.0, want.1));
        let _ = win.center();
    }
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

pub(crate) fn keep_on_screen(win: &tauri::WebviewWindow) {
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
    use super::{clamp_rect, first_open_size};

    #[test]
    fn first_open_takes_most_of_a_big_screen() {
        assert_eq!(first_open_size((2560, 1600), (3840, 2080)), (3072, 1664));
        assert_eq!(first_open_size((1280, 800), (1920, 1040)), (1536, 832));
        assert_eq!(first_open_size((1280, 800), (1366, 728)), (1280, 728));
    }

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
    // Wayland ignoruje pozycję okna; drugi monitor da się wskazać tylko pełnym ekranem na jego wyjściu
    let wl_full = crate::native_wayland() && !single_screen;
    let (x, y) = if wl_full {
        default_pos
    } else {
        saved_position(&app, "lyrics-second").unwrap_or(default_pos)
    };

    let builder = WebviewWindowBuilder::new(&app, "lyrics-second", app_url("overlay.html")?)
        .additional_browser_args(&merged_webview_args())
        .enable_clipboard_access()
        .title("Zenith Lyrics")
        .resizable(true)
        .min_inner_size(560.0, 260.0)
        .inner_size(w, h)
        .position(x, y)
        .fullscreen(wl_full);
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
