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
    // licznik na adres: jeden host z błędnym PIN-em nie blokuje pilota wszystkim pozostałym
    static ref FAILS: Mutex<Fails> = Mutex::new(Fails::new());
    // adresów IPv6 w sieci lokalnej jest dowolnie dużo, więc licznik per IP sam nie zatrzyma zgadywania
    static ref GLOBAL_FAILS: Mutex<GlobalFails> = Mutex::new(GlobalFails::default());
    static ref CLIENTS: Mutex<u32> = Mutex::new(0);
    static ref LAST_LYRICS: Mutex<String> = Mutex::new(String::new());
    static ref DEVICE_KEYS: Mutex<std::collections::HashSet<String>> = Mutex::new(Default::default());
    static ref KEYS_FILE: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);
    // podbijany przy każdej zmianie uprawnień; połączone telefony sprawdzają wtedy dostęp od nowa
    static ref GEN: tokio::sync::watch::Sender<u64> = tokio::sync::watch::channel(0).0;
}

const GLOBAL_LIMIT: u32 = 20;
const GLOBAL_WINDOW: Duration = Duration::from_secs(60);

#[derive(Default)]
struct GlobalFails {
    window: Option<Instant>,
    count: u32,
    until: Option<Instant>,
}

fn bump_gen() {
    GEN.send_modify(|g| *g = g.wrapping_add(1));
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

// obca domena wskazująca na ten adres (DNS rebinding) i cudza strona w przeglądarce nie dostają odpowiedzi
fn same_site(headers: &axum::http::HeaderMap) -> bool {
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let bare = match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => host.split(':').next().unwrap_or(""),
    };
    if bare != "localhost" && !bare.ends_with(".local") && bare.parse::<IpAddr>().is_err() {
        return false;
    }
    headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|o| {
            o.strip_prefix("http://")
                .or_else(|| o.strip_prefix("https://"))
                .is_some_and(|rest| rest == host)
        })
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

// bez losowości token byłby samymi zerami, więc lepiej odmówić parowania
fn random_hex(n: usize) -> Option<String> {
    let mut b = vec![0u8; n];
    getrandom::getrandom(&mut b).ok()?;
    Some(b.iter().map(|x| format!("{x:02x}")).collect())
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
        // ucięty plik przy awarii wylogowałby wszystkie sparowane telefony
        let tmp = p.with_extension("tmp");
        let body = serde_json::to_string(&keys).unwrap_or_else(|_| "[]".into());
        if std::fs::write(&tmp, body).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
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

type Fails = std::collections::HashMap<IpAddr, (u32, Option<Instant>)>;

fn key_ok(q: &PinQuery) -> bool {
    q.key.as_deref().is_some_and(|k| {
        !k.is_empty() && DEVICE_KEYS.lock().map(|s| s.contains(k)).unwrap_or(false)
    })
}

fn server_auth() -> Option<(String, bool)> {
    SERVER
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| (s.pin.clone(), s.pair)))
}

fn auth_ok(q: &PinQuery, ip: IpAddr) -> Result<(), StatusCode> {
    if key_ok(q) {
        return Ok(());
    }
    // bez wpisu serwera (start, zmiana portu, zatrzymanie) nie ma PIN-u do porównania, więc nikt nie wchodzi
    let Some((pin, pair)) = server_auth() else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    // w trybie QR wpuszcza tylko klucz z parowania, jak obiecuje opis przełącznika; PIN dałby drugą furtkę
    if pair {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if pin.is_empty() {
        return Ok(());
    }
    pin_ok(q.pin.as_deref(), &pin, ip)
}

// ponowne sprawdzenie po zmianie uprawnień; nie liczy prób, bo telefon niczego tu nie zgaduje
fn still_ok(q: &PinQuery) -> bool {
    if key_ok(q) {
        return true;
    }
    match server_auth() {
        Some((pin, false)) => pin.is_empty() || ct_eq(q.pin.as_deref().unwrap_or(""), &pin),
        _ => false,
    }
}

fn note_global_fail(g: &mut GlobalFails, now: Instant) {
    if g.window
        .is_none_or(|w| now.duration_since(w) > GLOBAL_WINDOW)
    {
        g.window = Some(now);
        g.count = 0;
    }
    g.count += 1;
    if g.count >= GLOBAL_LIMIT {
        g.until = Some(now + GLOBAL_WINDOW);
        g.window = None;
    }
}

fn globally_locked(now: Instant) -> bool {
    GLOBAL_FAILS
        .lock()
        .ok()
        .and_then(|g| g.until)
        .is_some_and(|until| now < until)
}

fn record_fail(f: &mut Fails, ip: IpAddr) {
    note_fail(f, ip);
    if let Ok(mut g) = GLOBAL_FAILS.lock() {
        note_global_fail(&mut g, Instant::now());
    }
}

fn note_fail(f: &mut Fails, ip: IpAddr) {
    if f.len() > 256 {
        f.retain(|_, e| e.1.is_some());
    }
    let e = f.entry(ip).or_default();
    e.0 += 1;
    if e.0.is_multiple_of(8) {
        // każda kolejna seria 8 błędów podwaja blokadę (do ~1 h), więc 4-cyfrowy PIN nie pada w jedną noc
        let secs = 60 << (e.0 / 8 - 1).min(6);
        e.1 = Some(Instant::now() + Duration::from_secs(secs));
    }
}

fn locked(ip: IpAddr) -> Result<std::sync::MutexGuard<'static, Fails>, StatusCode> {
    let f = FAILS
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let now = Instant::now();
    if globally_locked(now)
        || f.get(&ip)
            .and_then(|e| e.1)
            .is_some_and(|until| now < until)
    {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }
    Ok(f)
}

fn pin_ok(given: Option<&str>, want: &str, ip: IpAddr) -> Result<(), StatusCode> {
    let mut f = locked(ip)?;
    let g = given.unwrap_or("").as_bytes();
    let w = want.as_bytes();
    let mut diff = (g.len() ^ w.len()) as u8;
    for (i, b) in w.iter().enumerate() {
        diff |= b ^ g.get(i).copied().unwrap_or(0);
    }
    if diff == 0 {
        f.remove(&ip);
        Ok(())
    } else {
        record_fail(&mut f, ip);
        Err(StatusCode::UNAUTHORIZED)
    }
}

#[derive(Deserialize, Default, Clone)]
struct PinQuery {
    pin: Option<String>,
    key: Option<String>,
}

#[derive(Deserialize)]
struct PairQuery {
    t: Option<String>,
}

async fn api_pair(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<PairQuery>,
) -> Response {
    let ip = addr.ip();
    let mut f = match locked(ip) {
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
                let Some(t) = random_hex(12) else {
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                };
                s.pair_token = t;
                true
            }
            _ => false,
        }
    };
    if !ok {
        record_fail(&mut f, ip);
        return StatusCode::UNAUTHORIZED.into_response();
    }
    f.remove(&ip);
    drop(f);
    let Some(key) = random_hex(24) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
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
        // id chroni przed skokiem w zły utwór, gdy kolejka zmieniła się, zanim telefon dostał stan
        "jump" => json!({
            "cmd": cmd,
            "index": num("index")?.max(0.0).floor(),
            "id": s("id", 64).filter(|id| id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')),
        }),
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
    // stare połączenie po zatrzymaniu pilota nie steruje już odtwarzaczem
    if SERVER.lock().map(|g| g.is_none()).unwrap_or(true) {
        return false;
    }
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

async fn api_state(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<PinQuery>,
) -> Response {
    if let Err(code) = auth_ok(&q, addr.ip()) {
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

async fn ws_upgrade(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    ws: WebSocketUpgrade,
    Query(q): Query<PinQuery>,
) -> Response {
    if let Err(code) = auth_ok(&q, addr.ip()) {
        return code.into_response();
    }
    ws.max_message_size(16 * 1024)
        .on_upgrade(move |s| client(s, q))
        .into_response()
}

async fn client(socket: WebSocket, q: PinQuery) {
    let (mut sink, mut stream) = socket.split();
    let mut rx = TX.subscribe();
    let mut gen = GEN.subscribe();
    // uprawnienia mogły się zmienić między sprawdzeniem PIN-u a zapisaniem się na zmiany
    if !still_ok(&q) {
        let _ = sink.send(Message::Text(BYE.into())).await;
        let _ = sink.send(Message::Close(None)).await;
        return;
    }
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
                Ok(()) = gen.changed() => {
                    if !still_ok(&q) {
                        let _ = sink.send(Message::Text(BYE.into())).await;
                        let _ = sink.send(Message::Close(None)).await;
                        break;
                    }
                }
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
    webview: tauri::Webview,
    port: u16,
    pin: String,
    pair: Option<bool>,
) -> Result<RemoteInfo, String> {
    use tauri::Manager;
    crate::auth_store::main_window_only(&webview)?;
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

// zatrzymany serwer zwalnia port, dopiero gdy jego zadanie się obudzi; szybkie wył./wł. trafiało na „port zajęty”
async fn bind_retry(addr: SocketAddr) -> std::io::Result<tokio::net::TcpListener> {
    let mut tries = 0;
    loop {
        match tokio::net::TcpListener::bind(addr).await {
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && tries < 10 => {
                tries += 1;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            r => return r,
        }
    }
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
                    s.pair_token = random_hex(12).ok_or("no randomness")?;
                }
                drop(g);
                bump_gen();
                return Ok(info());
            }
            stop_inner(s);
            *g = None;
        }
    }
    let port = if port == 0 { 8765 } else { port };
    let pair_token = random_hex(12).ok_or("no randomness")?;
    let host = [0, 0, 0, 0];
    let listener = bind_retry(SocketAddr::from((host, port)))
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
                if !is_lan(addr.ip()) || !same_site(req.headers()) {
                    return StatusCode::FORBIDDEN.into_response();
                }
                next.run(req).await
            },
        ));
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    // wpis przed startem nasłuchu, żeby pierwsze żądania nie trafiły na serwer bez PIN-u
    *SERVER.lock().map_err(|e| e.to_string())? = Some(Server {
        port,
        pin,
        pair,
        pair_token,
        shutdown: Some(tx),
        mdns: None,
    });
    FAILS.lock().map_err(|e| e.to_string())?.clear();
    *GLOBAL_FAILS.lock().map_err(|e| e.to_string())? = GlobalFails::default();
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
    if let Some(d) = mdns {
        let mut g = SERVER.lock().map_err(|e| e.to_string())?;
        match g.as_mut().filter(|s| s.port == port) {
            Some(s) => s.mdns = Some(d),
            None => {
                let _ = d.shutdown();
            }
        }
    }
    bump_gen();
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
    bump_gen();
}

#[tauri::command]
pub fn remote_forget_devices() -> RemoteInfo {
    if let Ok(mut k) = DEVICE_KEYS.lock() {
        k.clear();
    }
    save_keys();
    bump_gen();
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
    // reguła blokująca (np. po „Anuluj” w okienku zapory Windows) wygrywa z każdą regułą zezwalającą
    pub blocked: bool,
}

#[cfg(windows)]
pub const FIREWALL_RULE: &str = "Zenith Player (local network)";
// deinstalator wersji z instalatora kasuje reguły po nazwie, więc portable ma własną
#[cfg(windows)]
const FIREWALL_RULE_PORTABLE: &str = "Zenith Player portable (local network)";

// sama nazwa szuka najpierw obok exe, a portable leży np. w Pobranych obok dowolnych plików
#[cfg(windows)]
pub(crate) fn hidden_powershell() -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    let exe = std::path::Path::new(&root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let mut c = std::process::Command::new(exe);
    c.args(["-NoProfile", "-NonInteractive", "-Command"]);
    c.creation_flags(0x0800_0000);
    c
}

#[tauri::command]
pub async fn remote_firewall_status() -> FirewallStatus {
    #[cfg(windows)]
    {
        tokio::task::spawn_blocking(|| {
            let exe = std::env::current_exe()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            let ip = lan_ip().map(|i| i.to_string()).unwrap_or_default();
            // liczy się profil sieci z adresu w kodzie QR (Domain=1, Private=2, Public=4, Any=0), a nie np. karty
            // Hyper-V; ścieżkę porównuje PowerShell, bo netsh pisze w stronie OEM i gubi polskie znaki z nazwy konta
            let script = "$ProgressPreference = 'SilentlyContinue'; \
                 $bits = @{ DomainAuthenticated = 1; Private = 2; Public = 4 }; \
                 $idx = if ($env:ZENITH_IP) { @(Get-NetIPAddress -IPAddress $env:ZENITH_IP -ErrorAction SilentlyContinue).InterfaceIndex }; \
                 $nets = @(if ($idx) { Get-NetConnectionProfile -InterfaceIndex $idx -ErrorAction SilentlyContinue }); \
                 if (-not $nets) { $nets = @(Get-NetConnectionProfile) }; \
                 $need = 0; $nets | ForEach-Object { $need = $need -bor [int]$bits[[string]$_.NetworkCategory] }; \
                 if ($need -eq 0) { $need = 2 }; \
                 $rules = @(Get-NetFirewallApplicationFilter -Program ([WildcardPattern]::Escape($env:ZENITH_EXE)) -ErrorAction SilentlyContinue | Get-NetFirewallRule | \
                   Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' }); \
                 $blocked = @($rules | Where-Object { $_.Action -eq 'Block' -and ([int]$_.Profile -eq 0 -or ([int]$_.Profile -band $need)) }).Count -gt 0; \
                 $ok = -not $blocked -and @($rules | Where-Object { $_.Action -eq 'Allow' -and ([int]$_.Profile -eq 0 -or ([int]$_.Profile -band $need) -eq $need) }).Count -gt 0; \
                 '{0}{1}{2}' -f [int](($need -band 4) -ne 0), [int]$ok, [int]$blocked";
            let out = hidden_powershell()
                .arg(script)
                .env("ZENITH_EXE", exe)
                .env("ZENITH_IP", ip)
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
                .unwrap_or_default();
            FirewallStatus {
                windows: true,
                public_network: out.starts_with('1'),
                rule_ok: out.get(1..2) == Some("1"),
                blocked: out.get(2..3) == Some("1"),
            }
        })
        .await
        .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        FirewallStatus::default()
    }
}

// najpierw kasuje wszystkie reguły tego exe, bo blokada z okienka zapory wygrywa z regułą zezwalającą
// uproszczenie: cmd rozwinie %ZMIENNA% w ścieżce exe; poprawić, gdy ktoś zgłosi taką ścieżkę
#[cfg(windows)]
fn firewall_args(exe: &str, name: &str, public_network: bool) -> String {
    // sieć publiczna (hotel, kawiarnia) tylko po kliknięciu pod ostrzeżeniem, które to opisuje
    let profile = if public_network {
        "private,domain,public"
    } else {
        "private,domain"
    };
    format!(
        "/c netsh advfirewall firewall delete rule name=all dir=in program=\"{exe}\" & \
         netsh advfirewall firewall add rule name=\"{name}\" dir=in action=allow program=\"{exe}\" \
         profile={profile} remoteip=localsubnet protocol=TCP enable=yes"
    )
}

// okno Zenith jako właściciel zgody UAC; bez niego Windows pokazuje ją tylko jako mrugający przycisk na pasku
#[cfg(windows)]
fn shell_wait(verb: &str, file: &str, args: &str, hwnd: isize) -> Result<u32, u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, WaitForSingleObject, INFINITE,
    };
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
        SHELLEXECUTEINFOW,
    };
    let w = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (verb, file, args) = (w(verb), w(file), w(args));
    let mut sei: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    sei.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    sei.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
    sei.hwnd = hwnd as _;
    sei.lpVerb = verb.as_ptr();
    sei.lpFile = file.as_ptr();
    sei.lpParameters = args.as_ptr();
    sei.nShow = 0;
    unsafe {
        if ShellExecuteExW(&mut sei) == 0 {
            return Err(GetLastError());
        }
        // kopia uchwytu, bo na x86 struktura jest packed i referencja do pola się nie skompiluje
        let process = sei.hProcess;
        if process.is_null() {
            return Err(0);
        }
        WaitForSingleObject(process, INFINITE);
        let mut code = 1u32;
        GetExitCodeProcess(process, &mut code);
        CloseHandle(process);
        Ok(code)
    }
}

#[tauri::command]
pub async fn remote_firewall_allow(
    webview: tauri::Webview,
    public_network: Option<bool>,
) -> Result<bool, String> {
    crate::auth_store::main_window_only(&webview)?;
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let name = if crate::portable::is_portable() {
            FIREWALL_RULE_PORTABLE
        } else {
            FIREWALL_RULE
        };
        let args = firewall_args(
            &exe.to_string_lossy(),
            name,
            public_network.unwrap_or(false),
        );
        let cmd = std::path::Path::new(
            &std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into()),
        )
        .join(r"System32\cmd.exe");
        // HWND to nie Send, więc do wątku idzie liczba
        let hwnd = webview.window().hwnd().map(|h| h.0 as isize).unwrap_or(0);
        let res = tokio::task::spawn_blocking(move || {
            shell_wait("runas", &cmd.to_string_lossy(), &args, hwnd)
        })
        .await
        .unwrap_or(Err(0));
        if let Err(code) = res {
            // 1223 = ERROR_CANCELLED, czyli „Nie” w oknie UAC
            eprintln!("[remote] firewall elevation failed: {code}");
            return Ok(false);
        }
        Ok(remote_firewall_status().await.rule_ok)
    }
    #[cfg(not(windows))]
    {
        let _ = public_network;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn shell_wait_exit_code() {
        let cmd = format!(r"{}\System32\cmd.exe", std::env::var("SystemRoot").unwrap());
        assert_eq!(shell_wait("open", &cmd, "/c exit 0", 0), Ok(0));
        assert_eq!(shell_wait("open", &cmd, "/c exit 3", 0), Ok(3));
        assert!(shell_wait("open", r"C:\zenith-no-such.exe", "", 0).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn firewall_args_profiles() {
        let a = firewall_args(r"C:\Users\Zoś ’x\zenith-player.exe", FIREWALL_RULE, false);
        assert!(
            a.starts_with("/c netsh advfirewall firewall delete rule name=all dir=in program=\"")
        );
        assert!(a.contains(
            r#"program="C:\Users\Zoś ’x\zenith-player.exe" profile=private,domain remoteip"#
        ));
        assert!(firewall_args("x", FIREWALL_RULE, true).contains("profile=private,domain,public "));
    }
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
                http(port, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
                http(port, "GET /api/state HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
                http(port, "GET /api/state?pin=1234 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
                http(port, "GET /api/state?pin=1234 HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n"),
                http(port, "GET /api/state?pin=1234 HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: https://evil.example\r\nConnection: close\r\n\r\n"),
                http(port, "GET /ws?pin=1234 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"),
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
        assert!(r.5.starts_with("HTTP/1.1 101"), "{}", r.5);
        assert!(r.3.starts_with("HTTP/1.1 403"), "{}", r.3);
        assert!(r.4.starts_with("HTTP/1.1 403"), "{}", r.4);
        let i = info();
        let svg = i.qr_svg.unwrap();
        assert!(i.running && svg.contains("<svg"));
        assert!(
            svg.contains("viewBox=") && svg.contains("width=\"100%\""),
            "{svg}"
        );
        let ws = tokio::task::spawn_blocking(move || {
            use std::io::{Read, Write};
            let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.set_read_timeout(Some(Duration::from_millis(800)))
                .unwrap();
            s.write_all(
                b"GET /ws?pin=1234 HTTP/1.1
Host: 127.0.0.1
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Version: 13
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==

",
            )
            .unwrap();
            let mut all = Vec::new();
            let mut buf = vec![0u8; 65536];
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline && !String::from_utf8_lossy(&all).contains("isPlaying")
            {
                match s.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => all.extend_from_slice(&buf[..n]),
                    Err(_) => {}
                }
            }
            let head = String::from_utf8_lossy(&all).into_owned();
            assert!(
                head.starts_with("HTTP/1.1 101") && head.contains("isPlaying"),
                "{head}"
            );
            s
        })
        .await
        .unwrap();
        start_server(port, "9999".into(), false).await.unwrap();
        let got = tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let mut s = ws;
            let mut all = Vec::new();
            let mut buf = vec![0u8; 65536];
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline && !String::from_utf8_lossy(&all).contains(BYE) {
                match s.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => all.extend_from_slice(&buf[..n]),
                    Err(_) => {}
                }
            }
            String::from_utf8_lossy(&all).into_owned()
        })
        .await
        .unwrap();
        assert!(
            got.contains(BYE),
            "phone with the old pin must be dropped: {got}"
        );
        remote_stop();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
        assert!(!info().running);
        assert_eq!(
            auth_ok(&PinQuery::default(), "127.0.0.1".parse().unwrap()),
            Err(StatusCode::UNAUTHORIZED)
        );

        let port = 18798;
        start_server(port, String::new(), true).await.unwrap();
        let qr = info().qr_url.unwrap();
        let tok = qr.split("pair=").nth(1).unwrap().to_string();
        let r = tokio::task::spawn_blocking(move || {
            let a = http(
                port,
                "GET /api/state HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            );
            let b = http(
                port,
                &format!("GET /api/pair?t={tok} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
            );
            let c = http(
                port,
                &format!("GET /api/pair?t={tok} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
            );
            let key = b
                .split("\"key\":\"")
                .nth(1)
                .map(|x| x[..48].to_string())
                .unwrap_or_default();
            let d = http(
                port,
                &format!(
                    "GET /api/state?key={key} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
                ),
            );
            let m = http(
                port,
                "GET /manifest.webmanifest HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
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
        start_server(port, "1234".into(), true).await.unwrap();
        let r = tokio::task::spawn_blocking(move || {
            http(
                port,
                "GET /api/state?pin=1234 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            )
        })
        .await
        .unwrap();
        assert!(
            r.starts_with("HTTP/1.1 401"),
            "pin must not bypass pairing: {r}"
        );
        remote_stop();
    }

    #[test]
    fn lockout_doubles() {
        let mut f = Fails::new();
        let ip: IpAddr = "192.168.1.9".parse().unwrap();
        let left = |f: &Fails| {
            f[&ip]
                .1
                .unwrap()
                .saturating_duration_since(Instant::now())
                .as_secs()
        };
        for _ in 0..7 {
            note_fail(&mut f, ip);
        }
        assert!(f[&ip].1.is_none());
        note_fail(&mut f, ip);
        assert!((55..=60).contains(&left(&f)));
        for _ in 0..8 {
            note_fail(&mut f, ip);
        }
        assert!((115..=120).contains(&left(&f)));
        for _ in 0..800 {
            note_fail(&mut f, ip);
        }
        assert!(left(&f) <= 3840);
    }

    #[test]
    fn global_limit_locks_everyone() {
        let t0 = Instant::now();
        let mut g = GlobalFails::default();
        for _ in 0..GLOBAL_LIMIT - 1 {
            note_global_fail(&mut g, t0);
        }
        assert!(g.until.is_none());
        note_global_fail(&mut g, t0);
        assert!(g.until.is_some_and(|u| u > t0));
        let mut g = GlobalFails::default();
        for _ in 0..GLOBAL_LIMIT - 1 {
            note_global_fail(&mut g, t0);
        }
        note_global_fail(&mut g, t0 + GLOBAL_WINDOW + Duration::from_secs(1));
        assert!(g.until.is_none() && g.count == 1);
    }

    #[test]
    fn sanitize_cmds() {
        assert_eq!(
            sanitize(&json!({"cmd":"volume","value":3})).unwrap()["value"],
            1.0
        );
        assert!(sanitize(&json!({"cmd":"rm -rf"})).is_none());
        assert!(sanitize(&json!({"cmd":"playTrack","track":{"id":"../x"}})).is_none());
        let j = sanitize(&json!({"cmd":"jump","index":3,"id":"a/b"})).unwrap();
        assert!(j["id"].is_null() && j["index"] == 3.0);
        let j = sanitize(&json!({"cmd":"jump","index":3,"id":"dQw4w9WgXcQ"})).unwrap();
        assert_eq!(j["id"], "dQw4w9WgXcQ");
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
