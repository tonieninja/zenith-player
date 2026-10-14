use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Query,
    },
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const PAGE: &str = include_str!("../remote/index.html");
const BYE: &str = "{\"type\":\"bye\"}";
const ICON: &[u8] = include_bytes!("../icons/128x128.png");
const ICON_256: &[u8] = include_bytes!("../icons/128x128@2x.png");
const ICON_512: &[u8] = include_bytes!("../icons/icon.png");
const MANIFEST: &str = r##"{"name":"Zenith Remote","short_name":"Zenith","start_url":"/","scope":"/","display":"standalone","orientation":"portrait","background_color":"#0c0e14","theme_color":"#0c0e14","icons":[{"src":"/icon-256.png","sizes":"256x256","type":"image/png"},{"src":"/icon-512.png","sizes":"512x512","type":"image/png","purpose":"any maskable"}]}"##;
const MDNS_HOST: &str = "zenith.local.";

struct Server {
    port: u16,
    pin: String,
    pair: bool,
    pair_token: String,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    mdns: Option<mdns_sd::ServiceDaemon>,
}

lazy_static::lazy_static! {
    static ref SERVER: Mutex<Option<Server>> = Mutex::new(None);
    static ref LAST_STATE: Mutex<String> = Mutex::new(String::from("{}"));
    static ref TX: tokio::sync::broadcast::Sender<String> = tokio::sync::broadcast::channel(32).0;
    static ref APP: Mutex<Option<AppHandle>> = Mutex::new(None);
    static ref FAILS: Mutex<(u32, Option<Instant>)> = Mutex::new((0, None));
        static ref CLIENTS: Mutex<u32> = Mutex::new(0);
    static ref LAST_LYRICS: Mutex<String> = Mutex::new(String::new());
    static ref DEVICE_KEYS: Mutex<std::collections::HashSet<String>> = Mutex::new(Default::default());
    static ref KEYS_FILE: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);
}

fn is_lan(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => lan_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return lan_v4(v4);
            }
            v6.is_loopback()
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || (v6.segments()[0] & 0xfe00) == 0xfc00
        }
    }
}

fn lan_v4(v4: Ipv4Addr) -> bool {
    let o = v4.octets();
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || (o[0] == 100 && (o[1] & 0xc0) == 64)
}

fn lan_ip() -> Option<Ipv4Addr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    match s.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    let _ = getrandom::getrandom(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = (a.len() ^ b.len()) as u8;
    for (i, x) in b.iter().enumerate() {
        diff |= x ^ a.get(i).copied().unwrap_or(0);
    }
    diff == 0 && !b.is_empty()
}

fn save_keys() {
    let path = KEYS_FILE.lock().ok().and_then(|g| g.clone());
    let keys: Vec<String> = DEVICE_KEYS
        .lock()
        .map(|k| k.iter().cloned().collect())
        .unwrap_or_default();
    if let Some(p) = path {
        let _ = std::fs::write(
            p,
            serde_json::to_string(&keys).unwrap_or_else(|_| "[]".into()),
        );
    }
}

fn load_keys(path: std::path::PathBuf) {
    let keys: Vec<String> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if let Ok(mut k) = DEVICE_KEYS.lock() {
        k.clear();
        k.extend(keys.into_iter().filter(|x| x.len() == 48));
    }
    if let Ok(mut f) = KEYS_FILE.lock() {
        *f = Some(path);
    }
}

fn auth_ok(q: &PinQuery) -> Result<(), StatusCode> {
    if let Some(k) = q.key.as_deref() {
        if !k.is_empty() && DEVICE_KEYS.lock().map(|s| s.contains(k)).unwrap_or(false) {
            return Ok(());
        }
    }
    let (pin, pair) = SERVER
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| (s.pin.clone(), s.pair)))
        .unwrap_or_default();
    if pin.is_empty() && !pair {
        return Ok(());
    }
    if pin.is_empty() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    pin_ok(q.pin.as_deref())
}

fn note_fail(f: &mut (u32, Option<Instant>)) {
    f.0 += 1;
    if f.0 >= 8 {
        f.1 = Some(Instant::now() + Duration::from_secs(60));
    }
}

fn locked() -> Result<std::sync::MutexGuard<'static, (u32, Option<Instant>)>, StatusCode> {
    let mut f = FAILS
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let Some(until) = f.1 {
        if Instant::now() < until {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        *f = (0, None);
    }
    Ok(f)
}

fn pin_ok(given: Option<&str>) -> Result<(), StatusCode> {
    let want = SERVER
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.pin.clone()))
        .unwrap_or_default();
    if want.is_empty() {
        return Ok(());
    }
    let mut f = FAILS
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if let Some(until) = f.1 {
        if Instant::now() < until {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        *f = (0, None);
    }
    let g = given.unwrap_or("").as_bytes();
    let w = want.as_bytes();
    let mut diff = (g.len() ^ w.len()) as u8;
    for (i, b) in w.iter().enumerate() {
        diff |= b ^ g.get(i).copied().unwrap_or(0);
    }
    if diff == 0 {
        f.0 = 0;
        Ok(())
    } else {
        f.0 += 1;
        if f.0 >= 8 {
            f.1 = Some(Instant::now() + Duration::from_secs(60));
        }
        Err(StatusCode::UNAUTHORIZED)
    }
}

#[derive(Deserialize, Default)]
struct PinQuery {
    pin: Option<String>,
    key: Option<String>,
}

#[derive(Deserialize)]
struct PairQuery {
    t: Option<String>,
}

async fn api_pair(Query(q): Query<PairQuery>) -> Response {
    let mut f = match locked() {
        Ok(f) => f,
        Err(c) => return c.into_response(),
    };
    let ok = {
        let mut g = match SERVER.lock() {
            Ok(g) => g,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
        match g.as_mut() {
            Some(s) if s.pair && ct_eq(q.t.as_deref().unwrap_or(""), &s.pair_token) => {
                s.pair_token = random_hex(12);
                true
            }
            _ => false,
        }
    };
    if !ok {
        note_fail(&mut f);
        return StatusCode::UNAUTHORIZED.into_response();
    }
    f.0 = 0;
    drop(f);
    let key = random_hex(24);
    if let Ok(mut k) = DEVICE_KEYS.lock() {
        if k.len() >= 32 {
            k.clear();
        }
        k.insert(key.clone());
    }
    save_keys();
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        json!({ "key": key }).to_string(),
    )
        .into_response()
}

async fn manifest() -> Response {
    (
        [(header::CONTENT_TYPE, "application/manifest+json")],
        MANIFEST,
    )
        .into_response()
}

async fn icon256() -> Response {
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "max-age=86400"),
        ],
        ICON_256,
    )
        .into_response()
}

async fn icon512() -> Response {
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "max-age=86400"),
        ],
        ICON_512,
    )
        .into_response()
}

fn sanitize(v: &Value) -> Option<Value> {
    let cmd = v.get("cmd")?.as_str()?;
    let num = |k: &str| v.get(k).and_then(|x| x.as_f64()).filter(|x| x.is_finite());
    let s = |k: &str, max: usize| {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(|x| x.chars().take(max).collect::<String>())
    };
    Some(match cmd {
        "toggle" | "play" | "pause" | "next" | "prev" | "like" | "mute" | "shuffle" | "loop" => {
            json!({ "cmd": cmd })
        }
        "volume" => json!({ "cmd": cmd, "value": num("value")?.clamp(0.0, 1.0) }),
        "seek" => json!({ "cmd": cmd, "value": num("value")?.max(0.0) }),
        "sleep" => json!({ "cmd": cmd, "minutes": num("minutes")?.clamp(0.0, 600.0).floor() }),
        "jump" => json!({ "cmd": cmd, "index": num("index")?.max(0.0).floor() }),
        "search" => {
            json!({ "cmd": cmd, "query": s("query", 200)?, "req": num("req").unwrap_or(0.0) })
        }
        "playTrack" | "addTrack" | "playNextTrack" => {
            let t = v.get("track")?;
            let id = t.get("id")?.as_str()?;
            if id.is_empty()
                || id.len() > 64
                || !id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                return None;
            }
            let f = |k: &str| {
                t.get(k)
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(500)
                    .collect::<String>()
            };
            json!({ "cmd": cmd, "track": { "id": id, "title": f("title"), "artist": f("artist"), "cover": f("cover") } })
        }
        _ => return None,
    })
}
