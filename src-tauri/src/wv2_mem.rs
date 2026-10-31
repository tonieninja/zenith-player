//! WebView2 memory target (Windows): while the main window is minimized or hidden in
//! the tray, ask WebView2 to keep its memory use low (it drops caches, decoded images
//! and GPU resources it can recreate). Nothing is suspended: scripts and the <audio>
//! element keep running, so playback and track advance are unaffected. The controller
//! is also marked invisible, so the page stops painting while nobody can see it. Restoring the
//! window switches back to the normal target.

#[cfg(windows)]
pub fn set_low(win: &tauri::WebviewWindow, low: bool) {
    apply(win, if low { 2 } else { 1 });
}

/// 1 normal, 2 hidden (low memory + invisible), 3 background: visible but unfocused for a
/// while (another app in front, or the window covered): low memory target only, the page keeps
/// painting exactly as before, so nothing visible changes; WebView2 just trims caches it can
/// rebuild (decoded images, GPU tiles, script caches) instead of keeping them warm
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
        // a minimized window is not "hidden" for WebView2 on its own: the page kept
        // rendering the lyrics view at ~1 core while minimized / in the tray. marking the
        // controller invisible makes document.hidden true, so painting and rAF stop
        // (audio, timers and the track advance keep running)
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

/// seconds without focus before the background (low memory, still visible) target applies
#[cfg(windows)]
const BACKGROUND_AFTER_S: u64 = 30;

#[cfg(not(windows))]
pub fn set_low(_win: &tauri::WebviewWindow, _low: bool) {}

/// the tray plugin can hide the window from the ui side as well, which no Rust window
/// event reports: check the main window once a second (cheap) and follow it
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
                        // restored but not focused yet: back to visible right away
                        apply(&w, 1);
                    }
                }
            }
        });
}

#[cfg(not(windows))]
pub fn start_watch(_app: &tauri::AppHandle) {}
