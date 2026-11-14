#[cfg(windows)]
pub fn set_low(win: &tauri::WebviewWindow, low: bool) {
    apply(win, if low { 2 } else { 1 });
}

#[cfg(windows)]
fn apply(win: &tauri::WebviewWindow, want: u8) {
    use std::sync::atomic::Ordering;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;
    if win.label() != "main" {
        return;
    }
    if STATE.swap(want, Ordering::SeqCst) == want {
        return;
    }
    let _ = win.with_webview(move |wv| unsafe {
        let controller = wv.controller();
        let _ = controller.SetIsVisible(want != 2);
        let Ok(core) = controller.CoreWebView2() else {
            return;
        };
        if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
            let level = if want == 1 {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            };
            let _ = c19.SetMemoryUsageTargetLevel(level);
        }
    });
}

#[cfg(windows)]
static STATE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

#[cfg(windows)]
const BACKGROUND_AFTER_S: u64 = 30;

#[cfg(not(windows))]
pub fn set_low(_win: &tauri::WebviewWindow, _low: bool) {}

#[cfg(windows)]
pub fn start_watch(app: &tauri::AppHandle) {
    use tauri::Manager;
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("zenith-wv2-mem".into())
        .spawn(move || {
            let mut unfocused: u64 = 0;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(1000));
                if crate::windows::is_shutting_down() {
                    return;
                }
                let Some(w) = app.get_webview_window("main") else {
                    continue;
                };
                let hidden = w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true);
                if hidden {
                    unfocused = 0;
                    apply(&w, 2);
                    continue;
                }
                if w.is_focused().unwrap_or(true) {
                    unfocused = 0;
                    apply(&w, 1);
                } else {
                    unfocused += 1;
                    if unfocused >= BACKGROUND_AFTER_S {
                        apply(&w, 3);
                    } else if STATE.load(std::sync::atomic::Ordering::SeqCst) == 2 {
                        apply(&w, 1);
                    }
                }
            }
        });
}

#[cfg(not(windows))]
pub fn start_watch(_app: &tauri::AppHandle) {}
