use hidapi::{BusType, HidApi, HidDevice};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const VID: u16 = 0x054C;
// DualSense i DualSense Edge; po Bluetooth PID jest ten sam co po USB
const PIDS: [u16; 2] = [0x0CE6, 0x0DF2];

static RUNNING: AtomicBool = AtomicBool::new(false);
static POLL_THREAD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

lazy_static::lazy_static! {
    static ref LED: Arc<Mutex<[u8; 3]>> = Arc::new(Mutex::new([0, 90, 255]));
}

#[derive(Clone, Copy)]
struct TouchPoint {
    x: i32,
    y: i32,
    t: Instant,
}

struct GestureTracker {
    start: Option<TouchPoint>,
    last: Option<TouchPoint>,
    active: bool,
    last_fire: Instant,
}

impl GestureTracker {
    fn new() -> Self {
        Self {
            start: None,
            last: None,
            active: false,
            last_fire: Instant::now() - Duration::from_secs(2),
        }
    }

    fn reset(&mut self) {
        self.start = None;
        self.last = None;
        self.active = false;
    }

    fn on_touch(&mut self, x: i32, y: i32) {
        let p = TouchPoint {
            x,
            y,
            t: Instant::now(),
        };
        if !self.active {
            self.start = Some(p);
            self.active = true;
        }
        self.last = Some(p);
    }

    fn on_release(&mut self) -> Option<&'static str> {
        if !self.active {
            return None;
        }
        let start = self.start?;
        let end = self.last?;
        self.reset();

        if self.last_fire.elapsed() < Duration::from_millis(500) {
            return None;
        }

        let dt = end.t.duration_since(start.t).as_secs_f32();
        if dt <= 0.001 || dt > 0.55 {
            return None;
        }

        let dx = (end.x - start.x) as f32;
        let dy = (end.y - start.y) as f32;
        let dist = (dx * dx + dy * dy).sqrt();
        if dist < 180.0 {
            return None;
        }
        let vel = dist / dt;
        if vel < 280.0 {
            return None;
        }

        let abs_dx = dx.abs();
        let abs_dy = dy.abs();
        let action = if abs_dx > abs_dy * 2.0 {
            if dx > 0.0 {
                "next"
            } else {
                "prev"
            }
        } else if abs_dy > abs_dx * 2.0 {
            "toggle-play"
        } else {
            return None;
        };

        self.last_fire = Instant::now();
        Some(action)
    }
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
struct PadState {
    touching: bool,
    x: i32,
    y: i32,
    buttons: [u8; 3],
}

// raport 0x01 z USB (64 B) i 0x31 z Bluetooth (78 B) mają te same pola, w BT przesunięte o bajt
fn parse_report(buf: &[u8]) -> Option<(PadState, bool)> {
    let (base, bt) = match *buf.first()? {
        0x01 if buf.len() >= 64 => (1, false),
        0x31 if buf.len() >= 78 => (2, true),
        _ => return None,
    };
    let d = &buf[base..];
    let state = PadState {
        touching: d[32] & 0x80 == 0,
        x: ((d[34] as i32 & 0x0F) << 8) | d[33] as i32,
        y: ((d[35] as i32) << 4) | ((d[34] as i32 & 0xF0) >> 4),
        buttons: [d[7], d[8], d[9]],
    };
    Some((state, bt))
}

const CROSS: u8 = 0x20;
const L1: u8 = 0x01;
const R1: u8 = 0x02;
const OPTIONS: u8 = 0x20;
const TOUCH_CLICK: u8 = 0x02;
const HAT_RIGHT: u8 = 2;
const HAT_LEFT: u8 = 6;

// te same przyciski co wcześniej w Gamepad API: krzyżyk/options/klik touchpada, R1/L1, d-pad
fn button_action(prev: [u8; 3], now: [u8; 3]) -> Option<&'static str> {
    let down = |i: usize, mask: u8| now[i] & mask != 0 && prev[i] & mask == 0;
    let hat = |b: [u8; 3]| b[0] & 0x0F;
    let hat_to = |h: u8| hat(now) == h && hat(prev) != h;
    if down(0, CROSS) || down(1, OPTIONS) || down(2, TOUCH_CLICK) {
        Some("toggle-play")
    } else if down(1, R1) || hat_to(HAT_RIGHT) {
        Some("next")
    } else if down(1, L1) || hat_to(HAT_LEFT) {
        Some("prev")
    } else {
        None
    }
}

fn crc32(prefix: u8, data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in std::iter::once(&prefix).chain(data) {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320 & (crc & 1).wrapping_neg());
        }
    }
    !crc
}

fn led_report(bt: bool, seq: u8, first: bool, rgb: [u8; 3]) -> Vec<u8> {
    if !bt {
        let mut r = vec![0u8; 48];
        r[0] = 0x02;
        r[1] = 0xFF;
        r[2] = 0xF7;
        r[45..48].copy_from_slice(&rgb);
        return r;
    }
    let mut r = vec![0u8; 78];
    r[0] = 0x31;
    r[1] = (seq & 0x0F) << 4;
    r[2] = 0x10;
    let c = &mut r[3..];
    c[0] = 0xFF;
    c[1] = 0xF7;
    if first {
        // po sparowaniu pad trzyma własną animację diody, dopóki jej nie wygasimy
        c[38] = 0x02;
        c[41] = 0x02;
    }
    c[44..47].copy_from_slice(&rgb);
    let crc = crc32(0xA2, &r[..74]);
    r[74..78].copy_from_slice(&crc.to_le_bytes());
    r
}

fn open_pad(api: &mut HidApi) -> Option<(HidDevice, bool)> {
    let _ = api.refresh_devices();
    let info = api
        .device_list()
        .find(|d| d.vendor_id() == VID && PIDS.contains(&d.product_id()))?
        .clone();
    let dev = info.open_device(api).ok()?;
    Some((dev, matches!(info.bus_type(), BusType::Bluetooth)))
}

fn emit_action(app: &AppHandle, action: &str) {
    if crate::native_audio::is_headless() {
        crate::native_audio::headless::action(action);
    } else {
        let _ = app.emit("zenith-dualsense-action", action);
    }
}

fn sleep_while_running(total: Duration) {
    let until = Instant::now() + total;
    while RUNNING.load(Ordering::SeqCst) && Instant::now() < until {
        thread::sleep(Duration::from_millis(100));
    }
}

fn run_pad(app: &AppHandle, device: &HidDevice, mut bt: bool) {
    // bez odczytu raportu 0x05 pad po Bluetooth wysyła skrócony raport bez touchpada
    let mut feature = [0u8; 41];
    feature[0] = 0x05;
    let _ = device.get_feature_report(&mut feature);

    let mut tracker = GestureTracker::new();
    let mut prev = PadState::default();
    let mut last_led: Option<[u8; 3]> = None;
    let mut seq = 0u8;
    let mut last_action = Instant::now() - Duration::from_secs(1);
    let mut buf = [0u8; 128];

    while RUNNING.load(Ordering::SeqCst) {
        let want = LED.lock().map(|c| *c).unwrap_or([0, 0, 0]);
        if last_led != Some(want) {
            let report = led_report(bt, seq, last_led.is_none(), want);
            seq = seq.wrapping_add(1);
            if device.write(&report).is_ok() {
                last_led = Some(want);
            }
        }

        let n = match device.read_timeout(&mut buf, 100) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("[dualsense] read failed: {e}");
                return;
            }
        };
        let Some((state, is_bt)) = parse_report(&buf[..n]) else {
            continue;
        };
        if is_bt && !bt {
            bt = true;
            last_led = None;
        }

        let mut action = button_action(prev.buttons, state.buttons);
        if state.touching {
            tracker.on_touch(state.x, state.y);
        } else if prev.touching {
            action = action.or(tracker.on_release());
        }
        prev = state;

        if let Some(a) = action {
            if last_action.elapsed() >= Duration::from_millis(300) {
                last_action = Instant::now();
                emit_action(app, a);
            }
        }
    }

    let off = led_report(bt, seq, false, [0, 0, 0]);
    let _ = device.write(&off);
}

fn poll_loop(app: AppHandle) {
    let Ok(mut api) = HidApi::new() else {
        RUNNING.store(false, Ordering::SeqCst);
        return;
    };
    let mut told_missing = false;
    while RUNNING.load(Ordering::SeqCst) {
        let Some((device, bt)) = open_pad(&mut api) else {
            if !told_missing {
                told_missing = true;
                let _ = app.emit("zenith-dualsense-status", "not-found");
            }
            sleep_while_running(Duration::from_secs(2));
            continue;
        };
        told_missing = false;
        let status = if bt { "connected-bt" } else { "connected" };
        let _ = app.emit("zenith-dualsense-status", status);
        run_pad(&app, &device, bt);
        if RUNNING.load(Ordering::SeqCst) {
            let _ = app.emit("zenith-dualsense-status", "disconnected");
            sleep_while_running(Duration::from_secs(1));
        }
    }
    let _ = app.emit("zenith-dualsense-status", "stopped");
}

#[tauri::command(async)]
pub fn dualsense_start(app: AppHandle) -> Result<(), String> {
    if RUNNING.load(Ordering::SeqCst) {
        let _ = app.emit("zenith-dualsense-status", "already-running");
        return Ok(());
    }
    if let Ok(mut guard) = POLL_THREAD.lock() {
        if let Some(handle) = guard.take() {
            let _ = handle.join();
        }
    }
    RUNNING.store(true, Ordering::SeqCst);
    let handle = thread::spawn(move || poll_loop(app));
    if let Ok(mut guard) = POLL_THREAD.lock() {
        *guard = Some(handle);
    }
    Ok(())
}

#[tauri::command(async)]
pub fn dualsense_stop() -> Result<(), String> {
    RUNNING.store(false, Ordering::SeqCst);
    if let Ok(mut rgb) = LED.lock() {
        *rgb = [0, 0, 0];
    }
    if let Ok(mut guard) = POLL_THREAD.lock() {
        if let Some(handle) = guard.take() {
            let _ = handle.join();
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub fn dualsense_set_led(r: u8, g: u8, b: u8) -> Result<(), String> {
    if let Ok(mut rgb) = LED.lock() {
        *rgb = [r, g, b];
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usb_report() -> Vec<u8> {
        let mut r = vec![0u8; 64];
        r[0] = 0x01;
        r[8] = 0x08;
        r[33] = 0x80;
        r
    }

    fn as_bt(usb: &[u8]) -> Vec<u8> {
        let mut r = vec![0u8; 78];
        r[0] = 0x31;
        r[2..65].copy_from_slice(&usb[1..64]);
        r
    }

    #[test]
    fn bt_report_reads_like_usb_shifted_by_one() {
        let mut usb = usb_report();
        usb[33] = 0x05;
        usb[34] = 0x34;
        usb[35] = 0x52;
        usb[36] = 0x19;
        usb[9] = R1;
        let (a, a_bt) = parse_report(&usb).unwrap();
        let (b, b_bt) = parse_report(&as_bt(&usb)).unwrap();
        assert!(!a_bt && b_bt);
        assert_eq!(a, b);
        assert!(a.touching);
        assert_eq!((a.x, a.y), (0x234, 0x195));
        assert_eq!(a.buttons[1], R1);
    }

    #[test]
    fn short_bt_report_is_ignored() {
        let mut short = vec![0u8; 10];
        short[0] = 0x01;
        assert!(parse_report(&short).is_none());
    }

    #[test]
    fn buttons_fire_on_press_only() {
        let idle = [0x08, 0, 0];
        assert_eq!(
            button_action(idle, [0x08 | CROSS, 0, 0]),
            Some("toggle-play")
        );
        assert_eq!(
            button_action([0x08 | CROSS, 0, 0], [0x08 | CROSS, 0, 0]),
            None
        );
        assert_eq!(button_action(idle, [0x08, R1, 0]), Some("next"));
        assert_eq!(button_action(idle, [HAT_LEFT, 0, 0]), Some("prev"));
        assert_eq!(
            button_action(idle, [0x08, 0, TOUCH_CLICK]),
            Some("toggle-play")
        );
    }

    #[test]
    fn crc_matches_reference() {
        assert_eq!(crc32(b'1', b"23456789"), 0xCBF4_3926);
    }

    #[test]
    fn bt_led_report_has_colour_and_crc() {
        let r = led_report(true, 3, true, [10, 20, 30]);
        assert_eq!(r.len(), 78);
        assert_eq!((r[0], r[1], r[2]), (0x31, 0x30, 0x10));
        assert_eq!(&r[47..50], &[10, 20, 30]);
        let crc = u32::from_le_bytes([r[74], r[75], r[76], r[77]]);
        assert_eq!(crc, crc32(0xA2, &r[..74]));
        let usb = led_report(false, 0, true, [10, 20, 30]);
        assert_eq!(&usb[45..48], &[10, 20, 30]);
    }
}
