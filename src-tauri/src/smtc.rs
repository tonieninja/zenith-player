use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
};
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;

thread_local! {
    static MC: RefCell<Option<MediaControls>> = const { RefCell::new(None) };
}
static TRIED: AtomicBool = AtomicBool::new(false);
static PLAYING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, PartialEq, Default)]
struct Meta {
    title: String,
    artist: String,
    art: String,
    dur_ms: u64,
}
static LAST: Mutex<Option<Meta>> = Mutex::new(None);

fn hwnd(app: &AppHandle) -> Option<*mut std::ffi::c_void> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let w = app.get_webview_window("main")?;
        w.hwnd().ok().map(|h| h.0 as *mut std::ffi::c_void)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Some(std::ptr::null_mut())
    }
}

fn create(app: &AppHandle) -> Option<MediaControls> {
    let h = hwnd(app)?;
    let cfg = PlatformConfig {
        display_name: "Zenith",
        dbus_name: "zenith",
        hwnd: (!h.is_null()).then_some(h),
    };
    let mut mc = MediaControls::new(cfg)
        .map_err(|e| eprintln!("[Zenith] media controls unavailable: {e:?}"))
        .ok()?;
    let a = app.clone();
    mc.attach(move |ev| {
        let playing = PLAYING.load(Ordering::SeqCst);
        let act = match ev {
            MediaControlEvent::Toggle => Some("toggle-play"),
            MediaControlEvent::Play if !playing => Some("toggle-play"),
            MediaControlEvent::Pause | MediaControlEvent::Stop if playing => Some("toggle-play"),
            MediaControlEvent::Next => Some("next"),
            MediaControlEvent::Previous => Some("prev"),
            MediaControlEvent::Raise => {
                crate::show_main_window(&a);
                None
            }
            _ => None,
        };
        if let Some(act) = act {
            crate::tray_action(&a, act);
        }
    })
    .map_err(|e| eprintln!("[Zenith] media controls attach failed: {e:?}"))
    .ok()?;
    Some(mc)
}

fn apply(app: &AppHandle, meta: Option<Meta>, meta_changed: bool, playing: bool, position: f64) {
    MC.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            if TRIED.swap(true, Ordering::SeqCst) {
                return;
            }
            *slot = create(app);
        }
        let Some(mc) = slot.as_mut() else { return };
        match &meta {
            Some(m) => {
                if meta_changed {
                    let _ = mc.set_metadata(MediaMetadata {
                        title: Some(&m.title),
                        artist: Some(&m.artist),
                        album: None,
                        cover_url: (!m.art.is_empty()).then_some(m.art.as_str()),
                        duration: (m.dur_ms > 0).then(|| Duration::from_millis(m.dur_ms)),
                    });
                }
                let progress = Some(MediaPosition(Duration::from_secs_f64(position.max(0.0))));
                let _ = mc.set_playback(if playing {
                    MediaPlayback::Playing { progress }
                } else {
                    MediaPlayback::Paused { progress }
                });
            }
            None => {
                let _ = mc.set_playback(MediaPlayback::Stopped);
            }
        }
    });
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn mpris_update(
    app: AppHandle,
    title: Option<String>,
    artist: Option<String>,
    art: Option<String>,
    playing: bool,
    position: f64,
    duration: f64,
) {
    PLAYING.store(playing, Ordering::SeqCst);
    let meta = title.map(|title| Meta {
        title,
        artist: artist.unwrap_or_default(),
        art: art.unwrap_or_default(),
        dur_ms: (duration.max(0.0) * 1000.0) as u64,
    });
    let changed = {
        let mut last = LAST.lock().unwrap_or_else(|p| p.into_inner());
        let c = *last != meta;
        last.clone_from(&meta);
        c
    };
    let a = app.clone();
    let _ = app.run_on_main_thread(move || apply(&a, meta, changed, playing, position));
}
