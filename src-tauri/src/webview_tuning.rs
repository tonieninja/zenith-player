//! Linux (WebKitGTK) memory tuning for the app's webviews.
//!
//! WebKitGTK defaults to the "web browser" cache model: a large in-memory resource
//! cache plus a back/forward page cache, sized for tabbed browsing. Zenith is a single
//! page app that never navigates, so most of that is dead weight in the web process.

#[cfg(target_os = "linux")]
pub fn tune(win: &tauri::WebviewWindow) {
    use webkit2gtk::{CacheModel, SettingsExt, WebContextExt, WebViewExt};
    let model = match std::env::var("ZENITH_WEBKIT_CACHE").as_deref() {
        Ok("browser") => CacheModel::WebBrowser,
        Ok("viewer") => CacheModel::DocumentViewer,
        _ => CacheModel::DocumentBrowser,
    };
    let _ = win.with_webview(move |wv| {
        let view = wv.inner();
        if let Some(ctx) = view.context() {
            ctx.set_cache_model(model);
        }
        if let Some(settings) = WebViewExt::settings(&view) {
            // single page app: nothing to go "back" to
            settings.set_enable_page_cache(false);
            // nothing in zenith draws with webgl
            settings.set_enable_webgl(false);
            settings.set_enable_back_forward_navigation_gestures(false);
            // without this, Ctrl+V/C/X can abort the web process on WebKitGTK
            // when the clipboard plugin and GTK accelerators fight over paste
            settings.set_javascript_can_access_clipboard(true);
            #[cfg(not(debug_assertions))]
            settings.set_enable_developer_extras(false);
        }
    });
}

#[cfg(not(target_os = "linux"))]
pub fn tune(_win: &tauri::WebviewWindow) {}

/// process-wide memory settings, called first thing in main (before GTK, WebKit or any
/// thread exists, so child processes inherit the environment too)
#[cfg(target_os = "linux")]
pub fn early_init() {
    // glibc gives every thread that touches malloc its own 64MB arena; with tokio,
    // reqwest, gtk and webkit threads that fragments into a lot of resident memory.
    // two arenas are plenty for this app. respected by the web process as well
    if std::env::var_os("MALLOC_ARENA_MAX").is_none() {
        std::env::set_var("MALLOC_ARENA_MAX", "2");
    }
    unsafe {
        libc::mallopt(libc::M_ARENA_MAX, 2);
    }
    software_rendering_defaults();
    // WebKit's own memory pressure handler for the web process (read by the patched wry,
    // vendor/wry): above 40% of a 100 MB budget it does a non-critical release every 10 s
    // (JS GC, decoded image/font caches); never kills. measured: web anon flat 21-23 MB
    // over 12 min of playback instead of 21 -> 34 MB. ZENITH_WEBKIT_MP=off disables
    if std::env::var_os("ZENITH_WEBKIT_MP").is_none() {
        std::env::set_var("ZENITH_WEBKIT_MP", "100:0.4:0.6:10");
    }
    // JavaScriptCore JIT off for the web process (inherited env). Measured on WebKitGTK
    // 2.54: the JIT's code/profiling heaps were most of the web process' growth during
    // playback (lyrics view 98 -> 170 MB); interpreter-only stays flat at ~85-90 MB and,
    // since the ui is paint-bound, CPU is unchanged (lyrics 48-61% vs 49-63%). the app's JS
    // is ui glue, not number crunching. ZENITH_JIT=1 (or any JSC_useJIT) restores it
    if std::env::var_os("JSC_useJIT").is_none() && std::env::var("ZENITH_JIT").as_deref() != Ok("1")
    {
        std::env::set_var("JSC_useJIT", "0");
    }
    // the web and network processes are spawned from here and inherit this: freed
    // memory goes back to the OS promptly instead of piling up in glibc arenas (the
    // per-frame paint allocations of the lyrics view otherwise grow the web process)
    if std::env::var_os("GLIBC_TUNABLES").is_none() {
        std::env::set_var(
            "GLIBC_TUNABLES",
            "glibc.malloc.trim_threshold=131072:glibc.malloc.mmap_threshold=131072:glibc.malloc.arena_max=2",
        );
    }
    // hand freed heap back to the OS every minute (cheap, and keeps RSS honest after
    // bursts like a library load or a yt-dlp update)
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

/// without a GPU render node WebKitGTK still sets up GL (Mesa llvmpipe) and the dmabuf
/// renderer in the web process, i.e. it emulates a GPU on the CPU: ~100-200MB more memory
/// and much more CPU per repaint than plain shared-memory software rendering, which looks
/// identical. only applied when there is no /dev/dri render node; any WEBKIT_* value the
/// user sets wins, and ZENITH_RENDER=gpu keeps webkit's defaults
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
    // an earlier build also hid EGL here (__EGL_VENDOR_LIBRARY_DIRS) to save ~30MB, but some
    // pages (google sign-in after the email step) make the web process ask for an EGL display
    // anyway and it aborts, which froze the sign-in window. leave EGL alone
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
