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

fn forward(v: &Value) -> bool {
    let Some(clean) = sanitize(v) else {
        return false;
    };
    #[cfg(test)]
    if let Ok(path) = std::env::var("ZENITH_REMOTE_E2E_LOG") {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(f, "{clean}");
        }
    }
    if let Some(app) = APP.lock().ok().and_then(|g| g.clone()) {
        let _ = app.emit("zenith-remote-cmd", clean);
    }
    true
}

async fn page() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
            (
                header::HeaderName::from_static("x-content-type-options"),
                "nosniff",
            ),
            (
                header::HeaderName::from_static("referrer-policy"),
                "no-referrer",
            ),
        ],
        PAGE,
    )
        .into_response()
}

async fn icon() -> Response {
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "max-age=86400"),
        ],
        ICON,
    )
        .into_response()
}

async fn api_state(Query(q): Query<PinQuery>) -> Response {
    if let Err(code) = auth_ok(&q) {
        return code.into_response();
    }
    let s = LAST_STATE.lock().map(|g| g.clone()).unwrap_or_default();
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        s,
    )
        .into_response()
}

async fn ws_upgrade(ws: WebSocketUpgrade, Query(q): Query<PinQuery>) -> Response {
    if let Err(code) = auth_ok(&q) {
        return code.into_response();
    }
    ws.max_message_size(16 * 1024)
        .on_upgrade(client)
        .into_response()
}

async fn client(socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let mut rx = TX.subscribe();
    if let Ok(mut c) = CLIENTS.lock() {
        *c += 1;
    }
    let first = LAST_STATE.lock().map(|g| g.clone()).unwrap_or_default();
    let lyrics = LAST_LYRICS.lock().map(|g| g.clone()).unwrap_or_default();
    let mut ok = sink.send(Message::Text(first.into())).await.is_ok();
    if ok && !lyrics.is_empty() {
        ok = sink.send(Message::Text(lyrics.into())).await.is_ok();
    }
    if ok {
        loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Ok(s) => {
                        let bye = s == BYE;
                        if sink.send(Message::Text(s.into())).await.is_err() || bye {
                            let _ = sink.send(Message::Close(None)).await;
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                },
                inc = stream.next() => match inc {
                    Some(Ok(Message::Text(t))) => {
                        if let Ok(v) = serde_json::from_str::<Value>(t.as_str()) { forward(&v); }
                    }
                    Some(Ok(Message::Ping(p))) => { let _ = sink.send(Message::Pong(p)).await; }
                    Some(Ok(_)) => {}
                    _ => break,
                },
            }
        }
    }
    if let Ok(mut c) = CLIENTS.lock() {
        *c = c.saturating_sub(1);
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    running: bool,
    port: u16,
    url: Option<String>,
    mdns_url: Option<String>,
    qr_url: Option<String>,
    qr_svg: Option<String>,
    clients: u32,
    paired_devices: u32,
}

fn info() -> RemoteInfo {
    let (port, pair, mdns) = SERVER
        .lock()
        .ok()
        .and_then(|g| {
            g.as_ref().map(|s| {
                (
                    Some(s.port),
                    s.pair.then(|| s.pair_token.clone()),
                    s.mdns.is_some(),
                )
            })
        })
        .unwrap_or((None, None, false));
    let url = port.map(|p| {
        format!(
            "http://{}:{}/",
            lan_ip()
                .map(|i| i.to_string())
                .unwrap_or_else(|| "127.0.0.1".into()),
            p
        )
    });
    let mdns_url = port
        .filter(|_| mdns)
        .map(|p| format!("http://zenith.local:{p}/"));
    let qr_url = match (&url, pair) {
        (Some(u), Some(t)) => Some(format!("{u}?pair={t}")),
        (u, _) => u.clone(),
    };
    let qr_svg = qr_url.as_ref().and_then(|u| {
        qrcode::QrCode::new(u.as_bytes()).ok().map(|c| {
            qr_svg_fluid(
                &c.render::<qrcode::render::svg::Color>()
                    .quiet_zone(true)
                    .module_dimensions(1, 1)
                    .dark_color(qrcode::render::svg::Color("#000000"))
                    .light_color(qrcode::render::svg::Color("#ffffff"))
                    .build(),
            )
        })
    });
    RemoteInfo {
        running: port.is_some(),
        port: port.unwrap_or(0),
        url,
        mdns_url,
        qr_url,
        qr_svg,
        clients: CLIENTS.lock().map(|c| *c).unwrap_or(0),
        paired_devices: DEVICE_KEYS.lock().map(|k| k.len() as u32).unwrap_or(0),
    }
}

#[tauri::command]
pub async fn remote_start(
    app: AppHandle,
    port: u16,
    pin: String,
    pair: Option<bool>,
) -> Result<RemoteInfo, String> {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        load_keys(dir.join("remote_devices.json"));
    }
    *APP.lock().map_err(|e| e.to_string())? = Some(app);
    start_server(port, pin, pair.unwrap_or(false)).await
}

fn stop_inner(s: &mut Server) {
    if let Some(tx) = s.shutdown.take() {
        let _ = tx.send(());
    }
    if let Some(d) = s.mdns.take() {
        let _ = d.shutdown();
    }
}

fn start_mdns(port: u16) -> Option<mdns_sd::ServiceDaemon> {
    let ip = lan_ip()?;
    let d = mdns_sd::ServiceDaemon::new().ok()?;
    let svc = mdns_sd::ServiceInfo::new(
        "_http._tcp.local.",
        "Zenith Remote",
        MDNS_HOST,
        ip.to_string(),
        port,
        &[("path", "/")][..],
    )
    .ok()?;
    if d.register(svc).is_err() {
        let _ = d.shutdown();
        return None;
    }
    Some(d)
}

async fn start_server(port: u16, pin: String, pair: bool) -> Result<RemoteInfo, String> {
    let pin: String = pin.trim().chars().take(32).collect();
    {
        let mut g = SERVER.lock().map_err(|e| e.to_string())?;
        if let Some(s) = g.as_mut() {
            if s.port == port || port == 0 {
                s.pin = pin;
                if s.pair != pair {
                    s.pair = pair;
                    s.pair_token = random_hex(12);
                }
                drop(g);
                return Ok(info());
            }
            stop_inner(s);
            *g = None;
        }
    }
    let port = if port == 0 { 8765 } else { port };
    let host = [0, 0, 0, 0];
    let listener = tokio::net::TcpListener::bind(SocketAddr::from((host, port)))
        .await
        .map_err(|e| format!("port {port}: {e}"))?;
    let router = Router::new()
        .route("/", get(page))
        .route("/icon.png", get(icon))
        .route("/icon-256.png", get(icon256))
        .route("/icon-512.png", get(icon512))
        .route("/manifest.webmanifest", get(manifest))
        .route("/api/pair", get(api_pair))
        .route("/api/state", get(api_state))
        .route("/ws", get(ws_upgrade))
        .layer(axum::middleware::from_fn(
            |ConnectInfo(addr): ConnectInfo<SocketAddr>,
             req: axum::extract::Request,
             next: axum::middleware::Next| async move {
                if !is_lan(addr.ip()) {
                    return StatusCode::FORBIDDEN.into_response();
                }
                next.run(req).await
            },
        ));
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = rx.await;
        })
        .await;
    });
    let mdns = if std::env::var("ZENITH_REMOTE_MDNS").as_deref() == Ok("0") {
        None
    } else {
        start_mdns(port)
    };
    *SERVER.lock().map_err(|e| e.to_string())? = Some(Server {
        port,
        pin,
        pair,
        pair_token: random_hex(12),
        shutdown: Some(tx),
        mdns,
    });
    *FAILS.lock().map_err(|e| e.to_string())? = (0, None);
    Ok(info())
}

#[tauri::command]
pub fn remote_stop() {
    if let Ok(mut g) = SERVER.lock() {
        if let Some(mut s) = g.take() {
            stop_inner(&mut s);
        }
    }
    let _ = TX.send(String::from(BYE));
}

#[tauri::command]
pub fn remote_forget_devices() -> RemoteInfo {
    if let Ok(mut k) = DEVICE_KEYS.lock() {
        k.clear();
    }
    save_keys();
    info()
}

#[tauri::command]
pub fn remote_info() -> RemoteInfo {
    info()
}

#[tauri::command]
pub fn remote_push(payload: String) {
    if SERVER.lock().map(|g| g.is_none()).unwrap_or(true) || payload.len() > 512 * 1024 {
        return;
    }
    if payload.starts_with("{\"type\":\"lyrics\"") {
        if let Ok(mut g) = LAST_LYRICS.lock() {
            if *g == payload {
                return;
            }
            *g = payload.clone();
        }
    }
    if payload.starts_with("{\"type\":\"state\"") {
        if let Ok(mut g) = LAST_STATE.lock() {
            if *g == payload {
                return;
            }
            *g = payload.clone();
        }
    }
    let _ = TX.send(payload);
}

fn qr_svg_fluid(svg: &str) -> String {
    let Some(start) = svg.find("<svg") else {
        return svg.to_string();
    };
    let end = start + svg[start..].find('>').unwrap_or(0);
    let head = &svg[start..end];
    let attr = |name: &str| -> Option<u32> {
        let k = format!(" {name}=\"");
        let i = head.find(&k)? + k.len();
        head[i..].split('"').next()?.parse().ok()
    };
    let (Some(w), Some(h)) = (attr("width"), attr("height")) else {
        return svg.to_string();
    };
    let mut new_head = head
        .replace(&format!(" width=\"{w}\""), "")
        .replace(&format!(" height=\"{h}\""), "");
    if !new_head.contains("viewBox") {
        new_head.push_str(&format!(" viewBox=\"0 0 {w} {h}\""));
    }
    new_head.push_str(" width=\"100%\" height=\"100%\" shape-rendering=\"crispEdges\" preserveAspectRatio=\"xMidYMid meet\"");
    format!("{}{}{}", &svg[..start], new_head, &svg[end..])
}
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FirewallStatus {
    pub windows: bool,
    pub rule_ok: bool,
    pub public_network: bool,
}

pub const FIREWALL_RULE: &str = "Zenith Player (local network)";

#[cfg(windows)]
fn hidden_cmd(exe: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut c = std::process::Command::new(exe);
    c.creation_flags(0x0800_0000);
    c
}

#[tauri::command]
pub async fn remote_firewall_status() -> FirewallStatus {
    #[cfg(windows)]
    {
        tokio::task::spawn_blocking(|| {
            let rule_ok = hidden_cmd("netsh")
                .args(["advfirewall", "firewall", "show", "rule"])
                .arg(format!("name={FIREWALL_RULE}"))
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            let public_network = hidden_cmd("powershell")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "(Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' }).Count",
                ])
                .output()
                .ok()
                .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u32>().ok())
                .map(|n| n > 0)
                .unwrap_or(false);
            FirewallStatus { windows: true, rule_ok, public_network }
        })
        .await
        .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        FirewallStatus::default()
    }
}

#[tauri::command]
pub async fn remote_firewall_allow() -> Result<bool, String> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = exe.to_string_lossy().replace('\'', "''");
        let args = format!(
            "advfirewall firewall add rule name=\"{FIREWALL_RULE}\" dir=in action=allow program=\"{exe}\" profile=private,public remoteip=localsubnet protocol=TCP enable=yes"
        );
        let script = format!(
            "try {{ Start-Process netsh -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '{args}'; exit 0 }} catch {{ exit 1 }}"
        );
        let ok = tokio::task::spawn_blocking(move || {
            hidden_cmd("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        })
        .await
        .unwrap_or(false);
        if !ok {
            return Ok(false);
        }
        Ok(remote_firewall_status().await.rule_ok)
    }
    #[cfg(not(windows))]
    {
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lan_filter() {
        assert!(is_lan("192.168.1.5".parse().unwrap()));
        assert!(is_lan("10.0.0.1".parse().unwrap()));
        assert!(is_lan("127.0.0.1".parse().unwrap()));
        assert!(is_lan("::ffff:192.168.0.2".parse().unwrap()));
        assert!(!is_lan("8.8.8.8".parse().unwrap()));
        assert!(!is_lan("2001:db8::1".parse().unwrap()));
    }
    fn http(port: u16, req: &str) -> String {
        use std::io::{Read, Write};
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_millis(800)))
            .unwrap();
        s.write_all(req.as_bytes()).unwrap();
        let mut out = vec![0u8; 65536];
        let n = s.read(&mut out).unwrap_or(0);
        String::from_utf8_lossy(&out[..n]).into_owned()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn server_roundtrip() {
        let port = 18799;
        start_server(port, "1234".into(), false).await.unwrap();
        remote_push("{\"type\":\"state\",\"isPlaying\":true}".into());
        let r = tokio::task::spawn_blocking(move || {
            (
                http(port, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
                http(port, "GET /api/state HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
                http(port, "GET /api/state?pin=1234 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
                http(port, "GET /ws?pin=1234 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"),
            )
        })
        .await
        .unwrap();
        assert!(
            r.0.starts_with("HTTP/1.1 200") && r.0.contains("Zenith Remote"),
            "{}",
            r.0
        );
        assert!(r.1.starts_with("HTTP/1.1 401"), "{}", r.1);
        assert!(
            r.2.starts_with("HTTP/1.1 200") && r.2.contains("isPlaying"),
            "{}",
            r.2
        );
        assert!(r.3.starts_with("HTTP/1.1 101"), "{}", r.3);
        let i = info();
        let svg = i.qr_svg.unwrap();
        assert!(i.running && svg.contains("<svg"));
        assert!(
            svg.contains("viewBox=") && svg.contains("width=\"100%\""),
            "{svg}"
        );
        remote_stop();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
        assert!(!info().running);

        let port = 18798;
        start_server(port, String::new(), true).await.unwrap();
        let qr = info().qr_url.unwrap();
        let tok = qr.split("pair=").nth(1).unwrap().to_string();
        let r = tokio::task::spawn_blocking(move || {
            let a = http(
                port,
                "GET /api/state HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
            );
            let b = http(
                port,
                &format!("GET /api/pair?t={tok} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
            );
            let c = http(
                port,
                &format!("GET /api/pair?t={tok} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
            );
            let key = b
                .split("\"key\":\"")
                .nth(1)
                .map(|x| x[..48].to_string())
                .unwrap_or_default();
            let d = http(
                port,
                &format!(
                    "GET /api/state?key={key} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
                ),
            );
            let m = http(
                port,
                "GET /manifest.webmanifest HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
            );
            (a, b, c, d, m)
        })
        .await
        .unwrap();
        assert!(r.0.starts_with("HTTP/1.1 401"), "{}", r.0);
        assert!(
            r.1.starts_with("HTTP/1.1 200") && r.1.contains("key"),
            "{}",
            r.1
        );
        assert!(
            r.2.starts_with("HTTP/1.1 401"),
            "token must be single-use: {}",
            r.2
        );
        assert!(r.3.starts_with("HTTP/1.1 200"), "{}", r.3);
        assert!(r.4.contains("Zenith Remote"), "{}", r.4);
        remote_stop();
    }

    #[test]
    fn sanitize_cmds() {
        assert_eq!(
            sanitize(&json!({"cmd":"volume","value":3})).unwrap()["value"],
            1.0
        );
        assert!(sanitize(&json!({"cmd":"rm -rf"})).is_none());
        assert!(sanitize(&json!({"cmd":"playTrack","track":{"id":"../x"}})).is_none());
        assert!(sanitize(&json!({"cmd":"playTrack","track":{"id":"dQw4w9WgXcQ"}})).is_some());
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn e2e_serve() {
        let port: u16 = std::env::var("ZENITH_E2E_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(18890);
        std::env::set_var("ZENITH_REMOTE_MDNS", "0");
        start_server(port, "4321".into(), false).await.unwrap();
        remote_push(
            r#"{"type":"state","isPlaying":true,"position":10,"duration":200,"volume":0.5,"liked":false,"shuffle":false,"sleepLeft":0,"track":{"id":"t1","title":"E2E Song","artist":"Test Artist","cover":""},"queue":[]}"#.into(),
        );
        remote_push(
            r#"{"type":"lyrics","trackId":"t1","synced":[{"t":0,"x":"first line"},{"t":9,"x":"current line"},{"t":60,"x":"later line"}],"plain":null}"#.into(),
        );
        println!("E2E_READY {port}");
        tokio::time::sleep(Duration::from_secs(900)).await;
    }
}
