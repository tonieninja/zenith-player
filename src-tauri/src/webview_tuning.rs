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

#[cfg(not(target_os = "linux"))]
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
    if std::env::var_os("ZENITH_WEBKIT_MP").is_none() {
        std::env::set_var("ZENITH_WEBKIT_MP", "100:0.4:0.6:10");
    }
    if std::env::var_os("JSC_useJIT").is_none() && std::env::var("ZENITH_JIT").as_deref() != Ok("1")
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
    if has_render_node() {
        return;
    }
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
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
