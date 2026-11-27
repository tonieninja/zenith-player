#[cfg(windows)]
pub fn set_low(win: &tauri::WebviewWindow, low: bool) {
    // ukryty WebView2 oddaje fokus oknu i Focused(true) od razu by je odsłonił; zasłonięte odsłania occlusion::watch
    if !low && occlusion::OCCLUDED.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
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

// Focused przychodzi tylko z WebView2, więc okno bez fokusu w webview nie zgłosi przejścia w tło;
// odpytywanie co 10 s zamiast co sekundę łapie każdy przypadek
#[cfg(windows)]
pub fn start_watch(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    use tauri::Manager;
    const TICK_S: u64 = 10;
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("zenith-wv2-mem".into())
        .spawn(move || {
            let mut background = 0;
            loop {
                std::thread::sleep(std::time::Duration::from_secs(TICK_S));
                if crate::windows::is_shutting_down() {
                    return;
                }
                let Some(w) = app.get_webview_window("main") else {
                    continue;
                };
                // zminimalizowanym i ukrytym zajmują się zdarzenia okna (poziom 2), zasłoniętym occlusion::watch
                if w.is_minimized().unwrap_or(false)
                    || !w.is_visible().unwrap_or(true)
                    || occlusion::OCCLUDED.load(Ordering::SeqCst)
                {
                    background = 0;
                // is_focused zostaje true po przejściu do innej aplikacji, rozstrzyga okno na pierwszym planie
                } else if w.hwnd().map_or(true, |h| unsafe {
                    windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() == h
                }) {
                    background = 0;
                    if STATE.load(Ordering::SeqCst) == 3 {
                        apply(&w, 1);
                    }
                } else if occlusion::hide_if_covered(&app, &w) {
                    background = 0;
                } else {
                    background += TICK_S;
                    if background >= BACKGROUND_AFTER_S {
                        apply(&w, 3);
                    }
                }
            }
        });
}

#[cfg(not(windows))]
pub fn start_watch(_app: &tauri::AppHandle) {}

// WebView2 sam nie wie, że okno przykryły inne, i rysuje dalej; schowany (IsVisible=false) przestaje
#[cfg(windows)]
mod occlusion {
    use super::apply;
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Manager, WebviewWindow};
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows::Win32::Graphics::Gdi::{GetWindowRgnBox, RGN_ERROR};
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetLayeredWindowAttributes, GetMessageW, GetWindow,
        GetWindowLongW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, KillTimer,
        PostQuitMessage, SetTimer, CHILDID_SELF, EVENT_OBJECT_CLOAKED, EVENT_OBJECT_DESTROY,
        EVENT_OBJECT_HIDE, EVENT_OBJECT_UNCLOAKED, EVENT_SYSTEM_FOREGROUND,
        EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MOVESIZEEND,
        GWL_EXSTYLE, GW_HWNDPREV, LAYERED_WINDOW_ATTRIBUTES_FLAGS, LWA_ALPHA, LWA_COLORKEY, MSG,
        OBJID_WINDOW, WINEVENT_OUTOFCONTEXT, WM_TIMER, WS_EX_LAYERED, WS_EX_TOOLWINDOW,
        WS_EX_TRANSPARENT,
    };

    pub static OCCLUDED: AtomicBool = AtomicBool::new(false);
    static APP: OnceLock<AppHandle> = OnceLock::new();
    static MAIN: AtomicIsize = AtomicIsize::new(0);

    /// Z obserwatora co 10 s: zakrycie wykrywa się bez pośpiechu, odsłonięcie od razu (haki i co 250 ms).
    pub fn hide_if_covered(app: &AppHandle, w: &WebviewWindow) -> bool {
        let Ok(h) = w.hwnd() else { return false };
        if !unsafe { covered(h) } || OCCLUDED.swap(true, Ordering::SeqCst) {
            return false;
        }
        let _ = APP.set(app.clone());
        MAIN.store(h.0 as isize, Ordering::SeqCst);
        apply(w, 2);
        let spawned = std::thread::Builder::new()
            .name("zenith-occlusion".into())
            .spawn(watch);
        if spawned.is_err() {
            OCCLUDED.store(false, Ordering::SeqCst);
            apply(w, 1);
            return false;
        }
        true
    }

    fn watch() {
        let ranges = [
            (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
            (EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZEEND),
            (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
            (EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE),
            (EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED),
        ];
        unsafe {
            let hooks: Vec<HWINEVENTHOOK> = ranges
                .iter()
                .map(|&(a, b)| {
                    SetWinEventHook(a, b, None, Some(on_event), 0, 0, WINEVENT_OUTOFCONTEXT)
                })
                .collect();
            // zmiana rozmiaru okna z wierzchu (np. przywrócenie z maksymalizacji) nie ma taniego zdarzenia
            let timer = SetTimer(None, 0, 250, None);
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                if msg.message == WM_TIMER {
                    recheck();
                }
            }
            let _ = KillTimer(None, timer);
            for h in hooks {
                let _ = UnhookWinEvent(h);
            }
        }
    }

    unsafe extern "system" fn on_event(
        _hook: HWINEVENTHOOK,
        _event: u32,
        _hwnd: HWND,
        obj: i32,
        child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if obj == OBJID_WINDOW.0 && child == CHILDID_SELF as i32 {
            recheck();
        }
    }

    fn recheck() {
        let h = HWND(MAIN.load(Ordering::SeqCst) as _);
        let w = APP.get().and_then(|a| a.get_webview_window("main"));
        if w.is_some() && unsafe { covered(h) } {
            return;
        }
        OCCLUDED.store(false, Ordering::SeqCst);
        // zminimalizowane albo schowane do zasobnika zostaje na poziomie 2 ze zdarzeń okna
        if let Some(w) =
            w.filter(|_| unsafe { IsWindowVisible(h).as_bool() && !IsIconic(h).as_bool() })
        {
            apply(&w, 1);
        }
        unsafe { PostQuitMessage(0) };
    }

    unsafe fn covered(me: HWND) -> bool {
        unsafe {
            if !IsWindowVisible(me).as_bool()
                || IsIconic(me).as_bool()
                || GetForegroundWindow() == me
            {
                return false;
            }
            // inny pulpit wirtualny
            if cloaked(me) {
                return true;
            }
            let Some(r) = bounds(me) else { return false };
            let mut open = vec![r];
            let mut h = me;
            while let Ok(up) = GetWindow(h, GW_HWNDPREV) {
                h = up;
                if !IsWindowVisible(h).as_bool() || IsIconic(h).as_bool() || cloaked(h) {
                    continue;
                }
                // Alt+Tab, widok zadań i podgląd z paska pokazują okno, więc musi się rysować
                if switcher(h) {
                    return false;
                }
                if let Some(b) = bounds(h).filter(|_| opaque(h)) {
                    open = cut(&open, b);
                    if open.is_empty() {
                        return true;
                    }
                    // shortcut: postrzępione odsłonięte resztki uznaje za widoczne, wystarczy przy zwykłym układzie
                    if open.len() > 64 {
                        return false;
                    }
                }
            }
            false
        }
    }

    unsafe fn cloaked(h: HWND) -> bool {
        let mut c = 0u32;
        unsafe { DwmGetWindowAttribute(h, DWMWA_CLOAKED, (&mut c as *mut u32).cast(), 4) }.is_ok()
            && c != 0
    }

    // ramka bez niewidocznych krawędzi do chwytania, w pikselach fizycznych jak u wszystkich okien
    unsafe fn bounds(h: HWND) -> Option<Rect> {
        let mut r = RECT::default();
        let size = size_of::<RECT>() as u32;
        unsafe {
            DwmGetWindowAttribute(
                h,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                (&mut r as *mut RECT).cast(),
                size,
            )
        }
        .ok()?;
        (r.right > r.left && r.bottom > r.top).then_some((r.left, r.top, r.right, r.bottom))
    }

    // bezczynne okna powłoki tych klas bywają widoczne, ale mają zerowy rozmiar (Windows 11: sufiks _WASDK)
    unsafe fn switcher(h: HWND) -> bool {
        let mut buf = [0u16; 64];
        let n = unsafe { GetClassNameW(h, &mut buf) }.max(0) as usize;
        let class = String::from_utf16_lossy(&buf[..n]);
        [
            "MultitaskingViewFrame",
            "XamlExplorerHostIslandWindow",
            "TaskListThumbnailWnd",
        ]
        .iter()
        .any(|c| class.starts_with(c))
            && unsafe { bounds(h) }.is_some()
    }

    // przezroczyste, przepuszczające klik, pływające i z kształtem okna mogą odsłaniać to pod spodem;
    // WS_EX_NOREDIRECTIONBITMAP mają wszystkie okna Chromium i Electrona, więc nie świadczy o przezroczystości
    unsafe fn opaque(h: HWND) -> bool {
        let mut pid = 0;
        // własne okna (nakładka tekstu, mini) bywają przezroczyste i nie zasłaniają całego okna głównego
        if unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) } != 0 && pid == std::process::id()
        {
            return false;
        }
        let ex = unsafe { GetWindowLongW(h, GWL_EXSTYLE) } as u32;
        if ex & (WS_EX_TRANSPARENT.0 | WS_EX_TOOLWINDOW.0) != 0 {
            return false;
        }
        if ex & WS_EX_LAYERED.0 != 0 {
            let (mut a, mut f) = (0u8, LAYERED_WINDOW_ATTRIBUTES_FLAGS(0));
            let ok = unsafe { GetLayeredWindowAttributes(h, None, Some(&mut a), Some(&mut f)) };
            if ok.is_err() || f.0 & LWA_COLORKEY.0 != 0 || (f.0 & LWA_ALPHA.0 != 0 && a < 255) {
                return false;
            }
        }
        let mut r = RECT::default();
        (unsafe { GetWindowRgnBox(h, &mut r) }) == RGN_ERROR
    }

    // lewo, góra, prawo, dół
    type Rect = (i32, i32, i32, i32);

    /// Części `open`, których nie przykrywa `c`.
    fn cut(open: &[Rect], c: Rect) -> Vec<Rect> {
        let (l, t, r, b) = c;
        let mut out = Vec::new();
        for &o in open {
            let (ol, ot, or, ob) = o;
            if l >= or || r <= ol || t >= ob || b <= ot {
                out.push(o);
                continue;
            }
            if ot < t {
                out.push((ol, ot, or, t));
            }
            if b < ob {
                out.push((ol, b, or, ob));
            }
            let (mt, mb) = (ot.max(t), ob.min(b));
            if ol < l {
                out.push((ol, mt, l, mb));
            }
            if r < or {
                out.push((r, mt, or, mb));
            }
        }
        out
    }

    #[cfg(test)]
    mod tests {
        use super::cut;

        fn area(v: &[(i32, i32, i32, i32)]) -> i32 {
            v.iter().map(|(l, t, r, b)| (r - l) * (b - t)).sum()
        }

        #[test]
        fn covering_windows_leave_only_the_visible_part() {
            let me = [(0, 0, 100, 80)];
            assert!(cut(&me, (-10, -10, 200, 200)).is_empty());
            assert_eq!(cut(&me, (200, 0, 300, 80)), me);
            // dziura w środku zostawia ramkę dookoła
            let ring = cut(&me, (10, 10, 90, 70));
            assert_eq!(area(&ring), 100 * 80 - 80 * 60);
            // dwie połówki razem przykrywają całość, jedna zostawia drugą
            let half = cut(&me, (0, 0, 50, 80));
            assert_eq!(half, vec![(50, 0, 100, 80)]);
            assert!(cut(&half, (50, -5, 105, 85)).is_empty());
            // pasek 1 px na brzegu to nadal okno widoczne
            assert_eq!(area(&cut(&me, (0, 0, 100, 79))), 100);
        }
    }
}
