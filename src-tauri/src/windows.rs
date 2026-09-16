use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const AUX_WINDOW_LABELS: [&str; 4] = [
    "lyrics-overlay",
    "lyrics-second",
    "mini-player",
    "google-login",
];

static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

fn app_url(page: &str) -> Result<WebviewUrl, String> {
    if cfg!(debug_assertions) {
        let raw = format!("http://localhost:1420/{}", page);
        raw.parse::<url::Url>()
            .map(WebviewUrl::External)
            .map_err(|e| e.to_string())
    } else {
        Ok(WebviewUrl::App(page.into()))
    }
}

/// close aux webviews one by one on the main thread, otherwise you get RecvError races
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

/// shutdown: shortcuts off, then aux windows, then exit, safe to call twice
pub fn graceful_shutdown(app: &AppHandle) {
    if SHUTTING_DOWN.swap(true, Ordering::SeqCst) {
        return;
    }

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
                    // last ditch if the main loop is wedged
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

#[tauri::command]
pub fn app_prepare_shutdown(app: AppHandle) -> Result<(), String> {
    graceful_shutdown(&app);
    Ok(())
}

#[tauri::command]
pub async fn open_lyrics_overlay(app: AppHandle) -> Result<(), String> {
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Ok(());
    }
    if let Some(existing) = app.get_webview_window("lyrics-overlay") {
        existing.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, "lyrics-overlay", app_url("overlay.html")?)
        .title("Zenith Lyrics")
        .always_on_top(true)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .inner_size(960.0, 400.0)
        .min_inner_size(480.0, 260.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn open_lyrics_second_screen(app: AppHandle) -> Result<(), String> {
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Ok(());
    }
    if let Some(existing) = app.get_webview_window("lyrics-second") {
        existing.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let target = if monitors.len() > 1 {
        monitors[1].clone()
    } else {
        monitors.first().cloned().ok_or("No monitor found")?
    };
    let pos = target.position();
    let size = target.size();
    let w = size.width as f64;
    let h = (size.height as f64 * 0.55).max(360.0);

    WebviewWindowBuilder::new(&app, "lyrics-second", app_url("overlay.html")?)
        .title("Zenith Lyrics")
        .always_on_top(true)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(true)
        .min_inner_size(640.0, 320.0)
        .inner_size(w, h)
        .position(pos.x as f64, (pos.y as f64) + size.height as f64 - h)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn open_mini_player(app: AppHandle) -> Result<(), String> {
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Ok(());
    }
    if let Some(existing) = app.get_webview_window("mini-player") {
        existing.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, "mini-player", app_url("mini.html")?)
        .title("Zenith Mini")
        .always_on_top(true)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .inner_size(380.0, 96.0)
        .min_inner_size(300.0, 80.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
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
