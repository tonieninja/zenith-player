#[cfg(target_os = "linux")]
pub fn tune(win: &tauri::WebviewWindow) {
    use webkit2gtk::{CacheModel, SettingsExt, WebContextExt, WebViewExt};
    // tylko główna instancja: druga kończy się od razu i jej znacznik wyglądałby jak padnięty start gpu;
    // swap, bo okna pomocnicze nie zgłaszają ui_ready i ich znacznik zostałby do końca sesji
    if GPU_PROBE.swap(false, std::sync::atomic::Ordering::SeqCst) {
        if let Some((probe, _)) = render_marks() {
            let _ = std::fs::write(probe, std::process::id().to_string());
        }
    }
    let model = match std::env::var("ZENITH_WEBKIT_CACHE").as_deref() {
        Ok("browser") => CacheModel::WebBrowser,
        Ok("document") => CacheModel::DocumentBrowser,
        _ => CacheModel::DocumentViewer,
    };
    let app = tauri::Manager::app_handle(win).clone();
    let watch = win.label() == "main" && GPU_LEVEL.load(std::sync::atomic::Ordering::SeqCst) < 2;
    let _ = win.with_webview(move |wv| {
        let view = wv.inner();
        if let Some(ctx) = view.context() {
            ctx.set_cache_model(model);
        }
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_page_cache(false);
            settings.set_enable_webgl(false);
            settings.set_enable_back_forward_navigation_gestures(false);
            settings.set_javascript_can_access_clipboard(true);
            #[cfg(not(debug_assertions))]
            settings.set_enable_developer_extras(false);
        }
        // próba z pid łapie tylko padnięty start; zawieszenie lub crash WebKita później zostawiały martwe okno
        if watch {
            use webkit2gtk::WebProcessTerminationReason as Why;
            let on_crash = app.clone();
            view.connect_web_process_terminated(move |_, why| {
                if matches!(why, Why::Crashed | Why::ExceededMemoryLimit) {
                    step_down_and_restart(&on_crash);
                }
            });
            view.connect_is_web_process_responsive_notify(move |v| {
                if v.is_web_process_responsive() {
                    return;
                }
                let (v, app) = (v.clone(), app.clone());
                webkit2gtk::glib::timeout_add_seconds_local_once(10, move || {
                    let shown = tauri::Manager::get_webview_window(&app, "main")
                        .is_some_and(|w| w.is_visible().unwrap_or(false));
                    if shown && !v.is_web_process_responsive() {
                        step_down_and_restart(&app);
                    }
                });
            });
        }
    });
}

// martwy pid w próbie: następny start zejdzie o poziom tą samą drogą co po padniętym starcie
#[cfg(target_os = "linux")]
fn step_down_and_restart(app: &tauri::AppHandle) {
    if crate::windows::is_shutting_down() {
        return;
    }
    if let Some((probe, _)) = render_marks() {
        let _ = std::fs::write(probe, "0");
    }
    app.request_restart();
}

/// tauri-codegen 2.6 bierze z icon.ico pierwszy wpis (16 px) i pasek zadań go rozciąga;
/// zasób exe 32512 ma wszystkie rozmiary, więc system dobiera ostry przy każdym DPI.
#[cfg(windows)]
pub fn tune(win: &tauri::WebviewWindow) {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON,
        LR_DEFAULTCOLOR, LR_SHARED, SM_CXICON, SM_CXSMICON, SM_CYICON, SM_CYSMICON, WM_SETICON,
    };
    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    unsafe {
        let module = GetModuleHandleW(std::ptr::null());
        if module.is_null() {
            return;
        }
        for (kind, cx, cy) in [
            (ICON_BIG, SM_CXICON, SM_CYICON),
            (ICON_SMALL, SM_CXSMICON, SM_CYSMICON),
        ] {
            let icon = LoadImageW(
                module,
                32512 as *const u16,
                IMAGE_ICON,
                GetSystemMetrics(cx),
                GetSystemMetrics(cy),
                LR_DEFAULTCOLOR | LR_SHARED,
            );
            if !icon.is_null() {
                SendMessageW(hwnd.0 as _, WM_SETICON, kind as usize, icon as isize);
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn tune(_win: &tauri::WebviewWindow) {}

#[cfg(target_os = "linux")]
pub fn early_init() {
    if std::env::var_os("MALLOC_ARENA_MAX").is_none() {
        std::env::set_var("MALLOC_ARENA_MAX", "2");
    }
    unsafe {
        libc::mallopt(libc::M_ARENA_MAX, 2);
        // WebKit 2.50 ze sterownikiem NVIDIA 580 gubi deskryptor na klatkę; przy miękkim limicie 1024 pada po minucie
        let mut lim: libc::rlimit = std::mem::zeroed();
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) == 0 && lim.rlim_cur < lim.rlim_max {
            lim.rlim_cur = lim.rlim_max.min(65536);
            libc::setrlimit(libc::RLIMIT_NOFILE, &lim);
        }
    }
    software_rendering_defaults();
    // bez JIT cały interfejs liczy interpreter JavaScriptCore, wielokrotnie wolniejszy; ZENITH_JIT=0 go wyłącza
    if std::env::var_os("JSC_useJIT").is_none() && std::env::var("ZENITH_JIT").as_deref() == Ok("0")
    {
        std::env::set_var("JSC_useJIT", "0");
    }
    if std::env::var_os("GLIBC_TUNABLES").is_none() {
        std::env::set_var(
            "GLIBC_TUNABLES",
            "glibc.malloc.trim_threshold=131072:glibc.malloc.mmap_threshold=131072:glibc.malloc.arena_max=2",
        );
    }
    std::thread::Builder::new()
        .name("zenith-trim".into())
        .spawn(|| loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            unsafe {
                libc::malloc_trim(0);
            }
        })
        .ok();
}

#[cfg(target_os = "linux")]
fn software_rendering_defaults() {
    let nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists();
    // Debian/Ubuntu (także WebKit w AppImage) łatką wyłączają dmabuf na nvidii; bez tej zmiennej całe UI rysuje CPU
    let force_dmabuf = || set_default("WEBKIT_FORCE_DMABUF_RENDERER", "1");
    if std::env::var("ZENITH_RENDER").as_deref() == Ok("gpu") {
        if nvidia {
            force_dmabuf();
        }
        return;
    }
    if nvidia {
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            set_default("__NV_DISABLE_EXPLICIT_SYNC", "1");
        }
        // WebKit 2.54 wgrywa okładki do atlasu przez mapowany dmabuf, co na nvidii wiesza proces strony (Explore)
        set_default("WEBKIT_DISABLE_DMABUF_ATLAS", "1");
        // dmabuf na części sterowników nvidia nie startuje (błąd 71); FORCE_SHM rysuje dalej na gpu i tylko kopiuje
        // klatkę przez RAM, a DISABLE_DMABUF wyłącza w WebKit 2.54 całe przyspieszenie i rysuje wszystko na CPU
        let level = gpu_render_level();
        GPU_LEVEL.store(level, std::sync::atomic::Ordering::SeqCst);
        match level {
            0 => {
                force_dmabuf();
                GPU_PROBE.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            // przy ekranie na zintegrowanej karcie FORCE_SHM przenosi WebKit na EGL nvidii, który potrafi się zawiesić
            1 if nvidia_drives_display() => {
                force_dmabuf();
                set_default("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1");
                GPU_PROBE.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            _ => {
                GPU_LEVEL.store(2, std::sync::atomic::Ordering::SeqCst);
                set_default("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
        }
        return;
    }
    if has_render_node() {
        return;
    }
    set_default("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
}

#[cfg(target_os = "linux")]
static GPU_PROBE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// bez nvidii zostaje 2: tam nie ma niższego poziomu, więc nie ma po co restartować
#[cfg(target_os = "linux")]
static GPU_LEVEL: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(2);

// laptop hybrydowy: ekran (boot_vga) na intelu/amd, nvidia tylko liczy; brak /sys zostawia dawną ścieżkę
#[cfg(target_os = "linux")]
fn nvidia_drives_display() -> bool {
    std::fs::read_dir("/sys/class/drm").map_or(true, |d| {
        let read = |p: std::path::PathBuf| std::fs::read_to_string(p).unwrap_or_default();
        let boot: Vec<_> = d
            .flatten()
            .map(|e| e.path().join("device"))
            .filter(|dev| read(dev.join("boot_vga")).trim() == "1")
            .collect();
        boot.is_empty()
            || boot
                .iter()
                .any(|dev| read(dev.join("vendor")).trim() == "0x10de")
    })
}

#[cfg(target_os = "linux")]
fn render_marks() -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    use std::path::PathBuf;
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    let dir = base.join("com.zenithplayer.desktop");
    // AppImage ma własny WebKit, więc jego padnięty start nie może obniżać poziomu deb/rpm i odwrotnie
    let tag = if std::env::var_os("APPIMAGE").is_some() {
        "-appimage"
    } else {
        ""
    };
    Some((
        dir.join(format!("render-probe{tag}")),
        dir.join(format!("render-safe{tag}")),
    ))
}

// 0 dmabuf, 1 kopia przez RAM, 2 CPU; próba zostawia znacznik z pid, który po martwym procesie oznacza padnięty start
#[cfg(target_os = "linux")]
fn gpu_render_level() -> u8 {
    render_marks().map_or(2, |(probe, safe)| {
        if let Some(dir) = probe.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        render_level_at(&probe, &safe, env!("CARGO_PKG_VERSION"), |pid| {
            std::path::Path::new(&format!("/proc/{pid}")).exists()
        })
    })
}

#[cfg(target_os = "linux")]
fn render_level_at(
    probe: &std::path::Path,
    safe: &std::path::Path,
    version: &str,
    alive: impl Fn(u32) -> bool,
) -> u8 {
    let cpu = format!("{version} cpu");
    let level = match std::fs::read_to_string(safe) {
        Ok(v) if v == cpu => return 2,
        Ok(v) if v == version => 1,
        _ => 0,
    };
    let Ok(owner) = std::fs::read_to_string(probe) else {
        return level;
    };
    if owner.trim().parse().is_ok_and(&alive) {
        return level;
    }
    let _ = std::fs::remove_file(probe);
    let _ = std::fs::write(safe, if level == 0 { version } else { cpu.as_str() });
    level + 1
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[test]
    fn each_failed_gpu_start_steps_down_one_level_until_the_next_version() {
        let dir = std::env::temp_dir().join(format!("zenith-render-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (probe, safe) = (dir.join("render-probe"), dir.join("render-safe"));
        let dead = |_| false;
        let level = |v| super::render_level_at(&probe, &safe, v, dead);
        assert_eq!(level("1.0.0"), 0);
        // druga instancja przy działającej pierwszej nie może uznać próby za padniętą
        std::fs::write(&probe, "4242").unwrap();
        assert_eq!(
            super::render_level_at(&probe, &safe, "1.0.0", |p| p == 4242),
            0
        );
        assert!(probe.exists());
        assert_eq!(level("1.0.0"), 1);
        assert!(!probe.exists());
        assert_eq!(level("1.0.0"), 1);
        std::fs::write(&probe, "4242").unwrap();
        assert_eq!(level("1.0.0"), 2);
        assert_eq!(level("1.0.0"), 2);
        assert_eq!(level("1.0.1"), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// wyjście zaraz po starcie nie może zostawić znacznika, bo następny start uznałby gpu za zepsute
pub fn clear_gpu_probe() {
    #[cfg(target_os = "linux")]
    if let Some((probe, _)) = render_marks() {
        let _ = std::fs::remove_file(probe);
    }
}

// 5 s zapasu: błąd 71 potrafi przyjść przy pierwszej klatce, już po tym, jak JS zgłosił gotowość
pub fn gpu_render_ok() {
    #[cfg(target_os = "linux")]
    if let Some((probe, _)) = render_marks().filter(|(p, _)| p.exists()) {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let _ = std::fs::remove_file(probe);
        });
    }
}

#[cfg(target_os = "linux")]
fn set_default(key: &str, value: &str) {
    if std::env::var_os(key).is_none() {
        std::env::set_var(key, value);
    }
}

#[cfg(target_os = "linux")]
fn has_render_node() -> bool {
    std::fs::read_dir("/dev/dri")
        .map(|d| {
            d.flatten()
                .any(|e| e.file_name().to_string_lossy().starts_with("renderD"))
        })
        .unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
pub fn early_init() {}

pub fn trim_heap() {
    #[cfg(target_os = "linux")]
    unsafe {
        libc::malloc_trim(0);
    }
}
