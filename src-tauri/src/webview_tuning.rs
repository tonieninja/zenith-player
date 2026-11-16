#[cfg(target_os = "linux")]
pub fn tune(win: &tauri::WebviewWindow) {
    use webkit2gtk::{CacheModel, SettingsExt, WebContextExt, WebViewExt};
    let model = match std::env::var("ZENITH_WEBKIT_CACHE").as_deref() {
        Ok("browser") => CacheModel::WebBrowser,
        Ok("document") => CacheModel::DocumentBrowser,
        _ => CacheModel::DocumentViewer,
    };
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
    });
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
    if std::env::var("ZENITH_RENDER").as_deref() == Ok("gpu") {
        return;
    }
    // sterownik nvidia z rendererem dmabuf WebKitGTK nie startuje na Waylandzie (błąd protokołu 71)
    if std::path::Path::new("/proc/driver/nvidia/version").exists() {
        set_default("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            set_default("__NV_DISABLE_EXPLICIT_SYNC", "1");
        }
        return;
    }
    if has_render_node() {
        return;
    }
    set_default("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
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
