//! dualsense hid, touchpad swipes become media gestures + rgb led
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const VID: u16 = 0x054C;
const PID_USB: u16 = 0x0CE6;
const PID_BT: u16 = 0x0CE7;

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
        let gesture = if abs_dx > abs_dy * 2.0 {
            if dx > 0.0 {
                "right"
            } else {
                "left"
            }
        } else if abs_dy > abs_dx * 2.0 {
            if dy < 0.0 {
                "up"
            } else {
                "down"
            }
        } else {
            return None;
        };

        self.last_fire = Instant::now();
        Some(gesture)
    }
}

fn parse_touch_usb(buf: &[u8]) -> (bool, i32, i32) {
    // usb input report 0x01, touch finger0 sits around bytes 33..37
    if buf.len() < 37 {
        return (false, 0, 0);
    }
    let t0 = buf[33];
    let active = (t0 & 0x80) == 0;
    let x = ((buf[35] as i32 & 0x0F) << 8) | (buf[34] as i32);
    let y = ((buf[36] as i32) << 4) | ((buf[35] as i32 & 0xF0) >> 4);
    (active, x, y)
}

fn parse_touch_bt(buf: &[u8]) -> (bool, i32, i32) {
    // bluetooth input report 0x31, layout is not the same as usb
    if buf.len() < 9 || buf[0] != 0x31 {
        return (false, 0, 0);
    }
    let t0 = buf[4];
    let active = (t0 & 0x80) == 0;
    let x = ((buf[6] as i32 & 0x0F) << 8) | (buf[5] as i32);
    let y = ((buf[7] as i32) << 4) | ((buf[6] as i32 & 0xF0) >> 4);
    (active, x, y)
}

fn write_led(device: &mut hidapi::HidDevice, r: u8, g: u8, b: u8) {
    // usual dualsense usb output report for player led / lightbar, dumbed down
    let mut report = [0u8; 48];
    report[0] = 0x02;
    report[1] = 0xFF;
    report[2] = 0xF7;
    report[45] = r;
    report[46] = g;
    report[47] = b;
    let _ = device.write(&report);
}

fn poll_loop(app: AppHandle) {
    let Ok(api) = hidapi::HidApi::new() else {
        RUNNING.store(false, Ordering::SeqCst);
        return;
    };

    let (mut device, is_bt) = match api.open(VID, PID_USB) {
        Ok(d) => (d, false),
        Err(_) => match api.open(VID, PID_BT) {
            Ok(d) => (d, true),
            Err(_) => {
                RUNNING.store(false, Ordering::SeqCst);
                let _ = app.emit("zenith-dualsense-status", "not-found");
                return;
            }
        },
    };
    let _ = device.set_blocking_mode(false);
    let status = if is_bt { "connected-bt" } else { "connected" };
    let _ = app.emit("zenith-dualsense-status", status);

    let mut tracker = GestureTracker::new();
    let mut was_active = false;
    let mut last_led = [255u8, 255, 255]; // force a write first time
    let mut buf = [0u8; 128];

    while RUNNING.load(Ordering::SeqCst) {
        if let Ok(rgb) = LED.lock() {
            let cur = [rgb[0], rgb[1], rgb[2]];
            if cur != last_led {
                write_led(&mut device, cur[0], cur[1], cur[2]);
                last_led = cur;
            }
        }

        match device.read_timeout(&mut buf, 20) {
            Ok(n) if n > 0 => {
                let (active, x, y) = if is_bt {
                    parse_touch_bt(&buf[..n])
                } else {
                    parse_touch_usb(&buf[..n])
                };
                if active {
                    tracker.on_touch(x, y);
                    was_active = true;
                } else if was_active {
                    if let Some(g) = tracker.on_release() {
                        let _ = app.emit("zenith-dualsense-gesture", g);
                    }
                    was_active = false;
                }
            }
            _ => {}
        }
        thread::sleep(Duration::from_millis(40));
    }

    write_led(&mut device, 0, 0, 0);
    let _ = app.emit("zenith-dualsense-status", "stopped");
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
pub fn dualsense_set_led(r: u8, g: u8, b: u8) -> Result<(), String> {
    if let Ok(mut rgb) = LED.lock() {
        *rgb = [r, g, b];
    }
    Ok(())
}
