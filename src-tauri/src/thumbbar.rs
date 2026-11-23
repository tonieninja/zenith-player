#[tauri::command]
pub fn thumbbar_update(window: tauri::WebviewWindow, on: bool, playing: bool, tips: [String; 4]) {
    #[cfg(windows)]
    imp::update(&window, on, playing, tips);
    #[cfg(not(windows))]
    let _ = (window, on, playing, tips);
}

#[cfg(windows)]
mod imp {
    use std::cell::RefCell;
    use tauri::Emitter;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::{
        DefSubclassProc, ITaskbarList3, SetWindowSubclass, TaskbarList, THBF_ENABLED, THBF_HIDDEN,
        THBN_CLICKED, THB_FLAGS, THB_ICON, THB_TOOLTIP, THUMBBUTTON,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateIcon, GetSystemMetrics, RegisterWindowMessageW, HICON, SM_CXSMICON, WM_COMMAND,
    };

    const ACTIONS: [(u32, &str); 3] = [(0x5A00, "prev"), (0x5A01, "toggle-play"), (0x5A02, "next")];

    #[derive(Default)]
    struct State {
        hwnd: isize,
        list: Option<ITaskbarList3>,
        added: bool,
        on: bool,
        playing: bool,
        // poprzedni, odtwórz, pauza, następny
        tips: [String; 4],
        icons: Option<[HICON; 4]>,
        app: Option<tauri::AppHandle>,
    }

    thread_local! {
        // tylko wątek okna: tam przychodzą komunikaty i tam działa COM paska zadań
        static ST: RefCell<State> = RefCell::new(State::default());
    }

    pub fn update(win: &tauri::WebviewWindow, on: bool, playing: bool, tips: [String; 4]) {
        use tauri::Manager;
        let Ok(h) = win.hwnd() else { return };
        let hwnd = h.0 as isize;
        let app = win.app_handle().clone();
        let _ = win.run_on_main_thread(move || {
            ST.with_borrow_mut(|s| {
                (s.on, s.playing, s.tips, s.app) = (on, playing, tips, Some(app));
                if s.hwnd != hwnd {
                    // okno odbudowane z zasobnika ma nowy przycisk na pasku i trzeba go podpiąć od nowa
                    s.hwnd = hwnd;
                    s.added = false;
                    unsafe {
                        let _ = SetWindowSubclass(HWND(hwnd as _), Some(on_msg), 0x5A, 0);
                    }
                }
                let _ = apply(s);
            })
        });
    }

    fn apply(s: &mut State) -> windows::core::Result<()> {
        if !s.added && !s.on {
            return Ok(());
        }
        let list = match &s.list {
            Some(l) => l.clone(),
            None => {
                let l: ITaskbarList3 =
                    unsafe { CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)? };
                unsafe { l.HrInit()? };
                s.list = Some(l.clone());
                l
            }
        };
        let icons = *s.icons.get_or_insert_with(make_icons);
        let b = buttons(s, &icons);
        let hwnd = HWND(s.hwnd as _);
        // dodanych przycisków nie da się usunąć, więc wyłączenie wtyczki tylko je ukrywa
        if s.added {
            unsafe { list.ThumbBarUpdateButtons(hwnd, &b) }
        } else {
            unsafe { list.ThumbBarAddButtons(hwnd, &b)? };
            s.added = true;
            Ok(())
        }
    }

    fn buttons(s: &State, icons: &[HICON; 4]) -> [THUMBBUTTON; 3] {
        let flags = if s.on { THBF_ENABLED } else { THBF_HIDDEN };
        let mid = if s.playing { 2 } else { 1 };
        [(0, 0), (1, mid), (2, 3)].map(|(slot, i)| {
            let mut b = THUMBBUTTON {
                dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
                iId: ACTIONS[slot].0,
                hIcon: icons[i],
                dwFlags: flags,
                ..Default::default()
            };
            for (d, c) in b.szTip.iter_mut().zip(s.tips[i].encode_utf16().take(259)) {
                *d = c;
            }
            b
        })
    }

    unsafe extern "system" fn on_msg(
        hwnd: HWND,
        msg: u32,
        wp: WPARAM,
        lp: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if msg == WM_COMMAND && (wp.0 >> 16) as u32 == THBN_CLICKED {
            let id = (wp.0 & 0xFFFF) as u32;
            if let Some(&(_, action)) = ACTIONS.iter().find(|(i, _)| *i == id) {
                ST.with(|c| {
                    if let Some(app) = c.try_borrow().ok().and_then(|s| s.app.clone()) {
                        let _ = app.emit("zenith-mini-action", action);
                    }
                });
                return LRESULT(0);
            }
        }
        // Eksplorator po restarcie tworzy przycisk od nowa i przyciski trzeba dodać jeszcze raz
        static TASKBAR_CREATED: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
        let created = *TASKBAR_CREATED
            .get_or_init(|| unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) });
        if msg == created {
            ST.with(|c| {
                if let Ok(mut s) = c.try_borrow_mut() {
                    s.added = false;
                    let _ = apply(&mut s);
                }
            });
        }
        unsafe { DefSubclassProc(hwnd, msg, wp, lp) }
    }

    // kolor ikon z motywu paska przy pierwszym użyciu; po zmianie motywu nowy dopiero po restarcie
    fn make_icons() -> [HICON; 4] {
        let px = unsafe { GetSystemMetrics(SM_CXSMICON) }.clamp(16, 64) as usize;
        let ink = if super::light_taskbar() { 0x20 } else { 0xFF };
        [0, 1, 2, 3].map(|g| {
            let alpha = super::raster(&super::glyph(g), px);
            let bgra: Vec<u8> = alpha.iter().flat_map(|&a| [ink, ink, ink, a]).collect();
            let mask = vec![0u8; px * px.div_ceil(16) * 2];
            unsafe {
                CreateIcon(
                    None,
                    px as i32,
                    px as i32,
                    1,
                    32,
                    mask.as_ptr(),
                    bgra.as_ptr(),
                )
                .unwrap_or_default()
            }
        })
    }
}

#[cfg(windows)]
fn light_taskbar() -> bool {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let (key, name) = (
        wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"),
        wide("SystemUsesLightTheme"),
    );
    let (mut v, mut n) = (0u32, 4u32);
    let r = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut v as *mut u32).cast(),
            &mut n,
        )
    };
    r == 0 && v == 1
}

type Poly = Vec<(f32, f32)>;

// 0 poprzedni, 1 odtwórz, 2 pauza, 3 następny; współrzędne w kwadracie 0..1
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn glyph(g: usize) -> Vec<Poly> {
    let rect = |x0: f32, x1: f32| vec![(x0, 0.2), (x1, 0.2), (x1, 0.8), (x0, 0.8)];
    let next = vec![vec![(0.18, 0.2), (0.62, 0.5), (0.18, 0.8)], rect(0.66, 0.8)];
    match g {
        0 => next
            .into_iter()
            .map(|p| p.into_iter().rev().map(|(x, y)| (1.0 - x, y)).collect())
            .collect(),
        1 => vec![vec![(0.26, 0.16), (0.84, 0.5), (0.26, 0.84)]],
        2 => vec![rect(0.24, 0.42), rect(0.58, 0.76)],
        _ => next,
    }
}

// pokrycie 4×4 próbki na piksel, żeby skosy trójkątów nie były poszarpane w 16 px
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn raster(polys: &[Poly], px: usize) -> Vec<u8> {
    let inside = |p: &Poly, x: f32, y: f32| {
        (0..p.len()).all(|i| {
            let ((ax, ay), (bx, by)) = (p[i], p[(i + 1) % p.len()]);
            (bx - ax) * (y - ay) - (by - ay) * (x - ax) >= 0.0
        })
    };
    let mut out = vec![0u8; px * px];
    for (i, a) in out.iter_mut().enumerate() {
        let (x, y) = ((i % px) as f32, (i / px) as f32);
        let mut hit = 0u32;
        for s in 0..16 {
            let u = (x + ((s % 4) as f32 + 0.5) / 4.0) / px as f32;
            let v = (y + ((s / 4) as f32 + 0.5) / 4.0) / px as f32;
            hit += polys.iter().any(|p| inside(p, u, v)) as u32;
        }
        *a = (hit * 255 / 16) as u8;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glyphs_fill_their_shapes_and_leave_the_corners_clear() {
        for g in 0..4 {
            let a = raster(&glyph(g), 16);
            assert_eq!(a[0], 0, "glyph {g} corner");
            assert!(
                a.iter().filter(|&&v| v == 255).count() > 20,
                "glyph {g} is empty"
            );
        }
        // trójkąt odtwarzania stoi po lewej, a przycisk "poprzedni" to lustro "następnego"
        let play = raster(&glyph(1), 16);
        assert_eq!(play[8 * 16 + 5], 255);
        assert_eq!(play[8 * 16 + 14], 0);
        let (prev, next) = (raster(&glyph(0), 16), raster(&glyph(3), 16));
        for y in 0..16 {
            for x in 0..16 {
                assert_eq!(prev[y * 16 + x], next[y * 16 + 15 - x]);
            }
        }
    }
}
