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

// po BT pad dostaje te same 47 bajtów co po USB, tylko z nagłówkiem 0x31 i CRC na końcu
fn bt_report(seq: u8, common: &[u8; 47]) -> Vec<u8> {
    let mut r = vec![0u8; 78];
    r[0] = 0x31;
    r[1] = (seq & 0x0F) << 4;
    r[2] = 0x10;
    r[3..50].copy_from_slice(common);
    let crc = crc32(0xA2, &r[..74]);
    r[74..78].copy_from_slice(&crc.to_le_bytes());
    r
}

// po sparowaniu przez BT pad trzyma własną animację diody i ignoruje kolor, dopóki jej nie wygasimy
fn bt_setup_report(seq: u8) -> Vec<u8> {
    let mut c = [0u8; 47];
    c[38] = 0x02;
    c[41] = 0x02;
    bt_report(seq, &c)
}

fn led_report(bt: bool, seq: u8, rgb: [u8; 3]) -> Vec<u8> {
    let mut c = [0u8; 47];
    c[0] = 0xFF;
    c[1] = 0xF7;
    c[44..47].copy_from_slice(&rgb);
    if bt {
        return bt_report(seq, &c);
    }
    let mut r = vec![0x02];
    r.extend_from_slice(&c);
    r
}

fn is_bt_basic_report(buf: &[u8]) -> bool {
    buf.first() == Some(&0x01) && (10..64).contains(&buf.len())
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

fn run_pad(app: &AppHandle, device: &HidDevice, mut bt: bool) -> bool {
    // bez odczytu raportu 0x05 pad po Bluetooth wysyła skrócony raport bez touchpada;
    // Windows odrzuca bufor mniejszy niż największy feature report pada, stąd zapas
    let mut feature = [0u8; 128];
    feature[0] = 0x05;
    if let Err(e) = device.get_feature_report(&mut feature) {
        eprintln!("[dualsense] feature report 0x05 failed: {e}");
    }

    let mut tracker = GestureTracker::new();
    let mut prev = PadState::default();
    let mut last_led: Option<[u8; 3]> = None;
    let mut setup_sent = false;
    let mut write_err_logged = false;
    let mut seq = 0u8;
    let mut last_action = Instant::now() - Duration::from_secs(1);
    let mut buf = [0u8; 128];
    let mut alive = false;
    let mut last_report = Instant::now();
    let mut last_write = Instant::now();

    while RUNNING.load(Ordering::SeqCst) {
        let want = LED.lock().map(|c| *c).unwrap_or([0, 0, 0]);
        // Steam Input potrafi nadpisać diodę, więc kolor wraca co sekundę
        if last_led != Some(want) || last_write.elapsed() >= Duration::from_secs(1) {
            last_write = Instant::now();
            if bt && !setup_sent {
                let _ = device.write(&bt_setup_report(seq));
                seq = seq.wrapping_add(1);
                setup_sent = true;
            }
            let report = led_report(bt, seq, want);
            seq = seq.wrapping_add(1);
            match device.write(&report) {
                Ok(_) => last_led = Some(want),
                Err(e) if !write_err_logged => {
                    write_err_logged = true;
                    eprintln!("[dualsense] lightbar write failed (bt={bt}): {e}");
                }
                Err(_) => {}
            }
        }

        let n = match device.read_timeout(&mut buf, 100) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("[dualsense] read failed: {e}");
                return alive;
            }
        };
        if n == 0 {
            // Windows nie zgłasza błędu po wyłączeniu pada przez BT, odczyt po prostu milknie
            if last_report.elapsed() >= Duration::from_secs(3) {
                return alive;
            }
            continue;
        }
        last_report = Instant::now();
        if !alive {
            alive = true;
            let status = if bt || buf[0] == 0x31 || is_bt_basic_report(&buf[..n]) {
                "connected-bt"
            } else {
                "connected"
            };
            let _ = app.emit("zenith-dualsense-status", status);
        }
        if !bt && is_bt_basic_report(&buf[..n]) {
            // pad po BT w trybie podstawowym, raport diody 0x31 przełączy go w pełny tryb
            bt = true;
            last_led = None;
        }
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

    let off = led_report(bt, seq, [0, 0, 0]);
    let _ = device.write(&off);
    alive
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
        let was_alive = run_pad(&app, &device, bt);
        if RUNNING.load(Ordering::SeqCst) {
            if was_alive {
                let _ = app.emit("zenith-dualsense-status", "disconnected");
            }
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
    fn short_bt_report_is_ignored_but_marks_bt() {
        let mut short = vec![0u8; 10];
        short[0] = 0x01;
        assert!(parse_report(&short).is_none());
        assert!(is_bt_basic_report(&short));
        assert!(!is_bt_basic_report(&usb_report()));
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
        let r = led_report(true, 3, [10, 20, 30]);
        assert_eq!(r.len(), 78);
        assert_eq!(
            (r[0], r[1], r[2], r[3], r[4]),
            (0x31, 0x30, 0x10, 0xFF, 0xF7)
        );
        assert_eq!(&r[47..50], &[10, 20, 30]);
        assert_eq!((r[41], r[44]), (0, 0));
        let crc = u32::from_le_bytes([r[74], r[75], r[76], r[77]]);
        assert_eq!(crc, crc32(0xA2, &r[..74]));

        let setup = bt_setup_report(4);
        assert_eq!((setup[3], setup[41], setup[44]), (0, 0x02, 0x02));

        // raport USB bajt w bajt taki jak przed zmianą
        let usb = led_report(false, 0, [10, 20, 30]);
        let mut old = [0u8; 48];
        old[0] = 0x02;
        old[1] = 0xFF;
        old[2] = 0xF7;
        old[45..48].copy_from_slice(&[10, 20, 30]);
        assert_eq!(usb, old.to_vec());
    }
}
