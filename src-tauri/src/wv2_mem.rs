#[cfg(windows)]
pub fn set_low(win: &tauri::WebviewWindow, low: bool) {
    apply(win, if low { 2 } else { 1 });
}

/// Okna wtyczek dzielą renderer z oknem głównym; niski cel oddaje to, co po nim zostało (pomiar: z 28 do 8 MB).
#[cfg(windows)]
pub fn aux_low(app: &tauri::AppHandle, low: bool) {
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;
    if low {
        // nowe okno główne startuje na NORMAL, więc stary stan nie może blokować przejścia na LOW
        STATE.store(0, std::sync::atomic::Ordering::SeqCst);
    }
    for label in crate::windows::AUX_WINDOW_LABELS {
        let Some(win) = app.get_webview_window(label) else {
            continue;
        };
        let _ = win.with_webview(move |wv| unsafe {
            let Ok(core) = wv.controller().CoreWebView2() else {
                return;
            };
            if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
                let _ = c19.SetMemoryUsageTargetLevel(if low {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                });
            }
        });
    }
}

#[cfg(not(windows))]
pub fn aux_low(_app: &tauri::AppHandle, _low: bool) {}

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

// widoczne okno w tle dostaje niski cel po 30 s; zdarzenie fokusu zamiast odpytywania okna co sekundę
#[cfg(windows)]
pub fn on_focus(win: &tauri::WebviewWindow, focused: bool) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static BLUR_GEN: AtomicU64 = AtomicU64::new(0);
    let gen = BLUR_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    if focused {
        return;
    }
    let w = win.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(BACKGROUND_AFTER_S));
        if BLUR_GEN.load(Ordering::SeqCst) != gen || crate::windows::is_shutting_down() {
            return;
        }
        // zminimalizowane ma już poziom 2; 3 przywróciłoby SetIsVisible(true)
        if !w.is_minimized().unwrap_or(false) && w.is_visible().unwrap_or(false) {
            apply(&w, 3);
        }
    });
}

#[cfg(not(windows))]
pub fn on_focus(_win: &tauri::WebviewWindow, _focused: bool) {}
