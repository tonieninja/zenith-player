use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, WebviewWindowBuilder};

static HIDE_GEN: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy)]
struct Geo {
    pos: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    maximized: bool,
}
static GEO: std::sync::Mutex<Option<Geo>> = std::sync::Mutex::new(None);

pub fn enabled() -> bool {
    let default_on = cfg!(target_os = "linux");
    crate::native_audio::available()
        && match std::env::var("ZENITH_UI_DROP").as_deref() {
            Ok("0") => false,
            Ok("1") => true,
            _ => default_on,
        }
}

fn delay_ms() -> u64 {
    std::env::var("ZENITH_UI_DROP_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3000)
}

pub fn hidden(app: &AppHandle) {
    if !enabled() {
        return;
    }
    let gen = HIDE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms()));
        if HIDE_GEN.load(Ordering::SeqCst) != gen || crate::windows::is_shutting_down() {
            return;
        }
        let a = app.clone();
        let _ = app.run_on_main_thread(move || drop_main(&a));
    });
}

pub fn drop_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(true) {
            return;
        }
        if let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) {
            *GEO.lock().unwrap_or_else(|p| p.into_inner()) = Some(Geo {
                pos,
                size,
                maximized: w.is_maximized().unwrap_or(false),
            });
        }
        crate::native_audio::set_headless(true);
        #[cfg(target_os = "linux")]
        let _ = w.with_webview(|wv| {
            use webkit2gtk::WebViewExt;
            wv.inner().terminate_web_process();
        });
        let _ = w.destroy();
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            #[cfg(target_os = "linux")]
            unsafe {
                libc::malloc_trim(0);
            }
        });
    }
}

pub fn ensure_main(app: &AppHandle) -> bool {
    HIDE_GEN.fetch_add(1, Ordering::SeqCst);
    if app.get_webview_window("main").is_some() {
        return false;
    }
    let Some(cfg) = app.config().app.windows.first().cloned() else {
        return false;
    };
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        let built = WebviewWindowBuilder::from_config(&h, &cfg).map(|b| {
            b.enable_clipboard_access().initialization_script(
                "window.__ZENITH_RESTORED__ = true; window.close = function () {};",
            )
        });
        match built.and_then(|b| b.build()) {
            Ok(w) => {
                crate::webview_tuning::tune(&w);
                if let Some(g) = *GEO.lock().unwrap_or_else(|p| p.into_inner()) {
                    let _ = w.set_size(g.size);
                    let _ = w.set_position(g.pos);
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
