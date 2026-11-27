use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const NS_CONN: &str = "urn:x-cast:com.google.cast.tp.connection";
const NS_BEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
const NS_RECV: &str = "urn:x-cast:com.google.cast.receiver";
const NS_MEDIA: &str = "urn:x-cast:com.google.cast.media";
const APP_ID: &str = "CC1AD845";
const ME: &str = "sender-0";
const PLATFORM: &str = "receiver-0";
const TICK: Duration = Duration::from_millis(50);
const PING_EVERY: Duration = Duration::from_secs(5);
const POLL_EVERY: Duration = Duration::from_secs(5);
const DEAD_AFTER: Duration = Duration::from_secs(16);
const LOAD_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Status {
    pub session: u64,
    pub conn: &'static str,
    pub device: String,
    pub player: String,
    pub idle: String,
    pub time: f64,
    pub duration: f64,
    pub volume: f64,
    pub muted: bool,
    pub error: String,
}

type Emit = Arc<dyn Fn(&Status) + Send + Sync>;
type Reply = tokio::sync::oneshot::Sender<Result<Status, String>>;

pub enum Cmd {
    Load {
        media: Value,
        start: f64,
        autoplay: bool,
        reply: Reply,
    },
    Media(Value),
    Volume(Value),
    Close,
}

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push(v as u8 | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn get_varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let mut v = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *b.get(*i)?;
        *i += 1;
        v |= u64::from(byte & 0x7f) << shift;
        if byte < 0x80 {
            return Some(v);
        }
    }
    None
}

// CastMessage z cast_channel.proto: wersja=1, nadawca=2, odbiorca=3, przestrzeń=4, typ=5 (0 = tekst), tekst=6
fn encode(src: &str, dst: &str, ns: &str, payload: &str) -> Vec<u8> {
    let mut m = vec![0x08, 0x00];
    for (tag, s) in [(0x12, src), (0x1a, dst), (0x22, ns)] {
        m.push(tag);
        put_varint(&mut m, s.len() as u64);
        m.extend_from_slice(s.as_bytes());
    }
    m.extend_from_slice(&[0x28, 0x00, 0x32]);
    put_varint(&mut m, payload.len() as u64);
    m.extend_from_slice(payload.as_bytes());
    let mut frame = (m.len() as u32).to_be_bytes().to_vec();
    frame.extend(m);
    frame
}

#[derive(Default, Debug, PartialEq)]
struct Msg {
    src: String,
    ns: String,
    payload: String,
}

fn decode(b: &[u8]) -> Option<Msg> {
    let mut m = Msg::default();
    let mut i = 0;
    while i < b.len() {
        let key = get_varint(b, &mut i)?;
        match key & 7 {
            0 => {
                get_varint(b, &mut i)?;
            }
            2 => {
                let len = usize::try_from(get_varint(b, &mut i)?).ok()?;
                let v = b.get(i..i.checked_add(len)?)?;
                i += len;
                let text = || String::from_utf8_lossy(v).into_owned();
                match key >> 3 {
                    2 => m.src = text(),
                    4 => m.ns = text(),
                    6 => m.payload = text(),
                    _ => {}
                }
            }
            _ => return None,
        }
    }
    Some(m)
}

// odbiornik ogranicza wiadomość do 64 KiB, więc większa długość znaczy rozjechany strumień
fn take_frames(buf: &mut Vec<u8>) -> Result<Vec<Vec<u8>>, String> {
    let mut out = Vec::new();
    while buf.len() >= 4 {
        let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        if len > 1 << 20 {
            return Err("corrupt frame".into());
        }
        if buf.len() < 4 + len {
            break;
        }
        out.push(buf[4..4 + len].to_vec());
        buf.drain(..4 + len);
    }
    Ok(out)
}

// Chromecast ma certyfikat podpisany przez Google tylko dla aplikacji Google; protokół wymaga go nie sprawdzać
#[derive(Debug)]
struct AnyCert;

impl rustls::client::danger::ServerCertVerifier for AnyCert {
    fn verify_server_cert(
        &self,
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _: &[u8],
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

type Tls = rustls::StreamOwned<rustls::ClientConnection, TcpStream>;

struct Link {
    tls: Tls,
    buf: Vec<u8>,
    last_rx: Instant,
}

impl Link {
    fn open(host: &str, port: u16) -> Result<Link, String> {
        let ip: IpAddr = host.parse().map_err(|_| format!("bad host {host}"))?;
        let err = |e: std::io::Error| e.to_string();
        let sock = TcpStream::connect_timeout(&SocketAddr::new(ip, port), Duration::from_secs(5))
            .map_err(err)?;
        let _ = sock.set_nodelay(true);
        sock.set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(err)?;
        sock.set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(err)?;
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let cfg = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AnyCert))
            .with_no_client_auth();
        let conn =
            rustls::ClientConnection::new(Arc::new(cfg), ip.into()).map_err(|e| e.to_string())?;
        let mut tls = rustls::StreamOwned::new(conn, sock);
        while tls.conn.is_handshaking() {
            tls.conn.complete_io(&mut tls.sock).map_err(err)?;
        }
        tls.sock.set_read_timeout(Some(TICK)).map_err(err)?;
        Ok(Link {
            tls,
            buf: Vec::new(),
            last_rx: Instant::now(),
        })
    }

    fn send(&mut self, dst: &str, ns: &str, payload: &Value) -> Result<(), String> {
        let frame = encode(ME, dst, ns, &payload.to_string());
        self.tls
            .write_all(&frame)
            .and_then(|_| self.tls.flush())
            .map_err(|e| e.to_string())
    }

    // czeka najwyżej TICK, bo ta sama pętla obsługuje komendy z okna
    fn recv(&mut self) -> Result<Vec<Msg>, String> {
        let mut chunk = [0u8; 16384];
        match self.tls.read(&mut chunk) {
            Ok(0) => return Err("closed by device".into()),
            Ok(n) => {
                self.buf.extend_from_slice(&chunk[..n]);
                self.last_rx = Instant::now();
            }
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(e) => return Err(e.to_string()),
        }
        Ok(take_frames(&mut self.buf)?
            .iter()
            .filter_map(|f| decode(f))
            .collect())
    }
}

struct Pending {
    media: Value,
    start: f64,
    autoplay: bool,
    reply: Reply,
}

enum Flow {
    Close,
    Ended,
    Lost(String),
}

struct Session {
    emit: Emit,
    status: Status,
    req: u64,
    app: Option<(String, String)>,
    joined: bool,
    media_id: Option<i64>,
    launching: bool,
    pending: Option<Pending>,
    waiting: Option<(u64, Reply, Instant)>,
    poll_at: Instant,
}

impl Session {
    fn next(&mut self) -> u64 {
        self.req += 1;
        self.req
    }

    fn emit(&self) {
        (self.emit)(&self.status);
    }

    fn set_conn(&mut self, conn: &'static str) {
        if self.status.conn != conn {
            self.status.conn = conn;
            self.emit();
        }
    }

    fn fail_load(&mut self, why: &str) {
        if let Some(p) = self.pending.take() {
            let _ = p.reply.send(Err(why.to_string()));
        }
        if let Some((_, r, _)) = self.waiting.take() {
            let _ = r.send(Err(why.to_string()));
        }
    }

    fn finish(&mut self, error: Option<String>) {
        self.fail_load("cast closed");
        self.status.conn = "closed";
        self.status.error = error.unwrap_or_default();
        self.emit();
    }

    fn load(&mut self, link: &mut Link, p: Pending) -> Result<(), String> {
        let Some((tid, sid)) = self.app.clone().filter(|_| self.joined) else {
            if !self.launching {
                self.launching = true;
                let id = self.next();
                link.send(
                    PLATFORM,
                    NS_RECV,
                    &json!({"type": "LAUNCH", "appId": APP_ID, "requestId": id}),
                )?;
            }
            if let Some(old) = self.pending.replace(p) {
                let _ = old.reply.send(Err("superseded".into()));
            }
            return Ok(());
        };
        let id = self.next();
        link.send(
            &tid,
            NS_MEDIA,
            &json!({
                "type": "LOAD", "requestId": id, "sessionId": sid, "media": p.media,
                "autoplay": p.autoplay, "currentTime": p.start
            }),
        )?;
        // stara sesja multimediów kończy się wtedy jako INTERRUPTED; do odpowiedzi nic jej nie zgłaszamy
        self.media_id = None;
        if let Some((_, old, _)) = self.waiting.replace((id, p.reply, Instant::now())) {
            let _ = old.send(Err("superseded".into()));
        }
        Ok(())
    }

    fn command(&mut self, link: &mut Link, cmd: Cmd) -> Result<(), String> {
        match cmd {
            Cmd::Load {
                media,
                start,
                autoplay,
                reply,
            } => self.load(
                link,
                Pending {
                    media,
                    start,
                    autoplay,
                    reply,
                },
            ),
            Cmd::Media(mut v) => {
                let (Some((tid, _)), Some(mid)) = (self.app.clone(), self.media_id) else {
                    return Ok(());
                };
                v["requestId"] = json!(self.next());
                v["mediaSessionId"] = json!(mid);
                link.send(&tid, NS_MEDIA, &v)
            }
            Cmd::Volume(vol) => {
                self.poll_at = Instant::now() + Duration::from_secs(1);
                let id = self.next();
                link.send(
                    PLATFORM,
                    NS_RECV,
                    &json!({"type": "SET_VOLUME", "requestId": id, "volume": vol}),
                )
            }
            Cmd::Close => Ok(()),
        }
    }

    fn receiver_status(&mut self, link: &mut Link, st: &Value) -> Result<Option<Flow>, String> {
        if let Some(l) = st["volume"]["level"].as_f64() {
            self.status.volume = l;
        }
        if let Some(m) = st["volume"]["muted"].as_bool() {
            self.status.muted = m;
        }
        let ours = st["applications"]
            .as_array()
            .and_then(|a| a.iter().find(|x| x["appId"] == APP_ID))
            .and_then(|x| {
                Some((
                    x["transportId"].as_str()?.to_string(),
                    x["sessionId"].as_str()?.to_string(),
                ))
            });
        match ours {
            Some(app) => {
                if self.app.as_ref() != Some(&app) || !self.joined {
                    link.send(&app.0, NS_CONN, &json!({"type": "CONNECT"}))?;
                    if self.app.as_ref() != Some(&app) {
                        self.media_id = None;
                    }
                    self.app = Some(app.clone());
                    self.joined = true;
                    self.launching = false;
                    let id = self.next();
                    link.send(
                        &app.0,
                        NS_MEDIA,
                        &json!({"type": "GET_STATUS", "requestId": id}),
                    )?;
                }
                if let Some(p) = self.pending.take() {
                    self.load(link, p)?;
                }
            }
            // aplikację zamknięto pilotem albo przejęła ją inna; YouTube Music kończy wtedy przesyłanie
            None if self.app.is_some() && !self.launching => return Ok(Some(Flow::Ended)),
            None => {}
        }
        self.emit();
        Ok(None)
    }

    fn media_status(&mut self, v: &Value) {
        let req = v["requestId"].as_u64().unwrap_or(0);
        if let Some((id, _, _)) = &self.waiting {
            if req != *id {
                return;
            }
        }
        let first = v["status"].as_array().and_then(|a| a.first());
        if let Some(st) = first {
            let sid = st["mediaSessionId"].as_i64();
            if self.media_id.is_none() {
                self.media_id = sid;
            } else if sid != self.media_id {
                return;
            }
            if let Some(p) = st["playerState"].as_str() {
                self.status.player = p.to_string();
            }
            self.status.idle = st["idleReason"].as_str().unwrap_or("").to_string();
            if let Some(t) = st["currentTime"].as_f64() {
                self.status.time = t;
            }
            if let Some(d) = st["media"]["duration"].as_f64() {
                self.status.duration = d;
            }
        } else if self.waiting.is_none() {
            self.media_id = None;
            self.status.player = "IDLE".into();
        }
        if let Some((_, reply, _)) = self.waiting.take() {
            let _ = reply.send(if first.is_some() {
                Ok(self.status.clone())
            } else {
                Err("load failed".into())
            });
        }
        self.emit();
    }

    fn handle(&mut self, link: &mut Link, m: Msg) -> Result<Option<Flow>, String> {
        let v: Value = serde_json::from_str(&m.payload).unwrap_or(Value::Null);
        let kind = v["type"].as_str().unwrap_or("");
        match (m.ns.as_str(), kind) {
            (NS_BEAT, "PING") => link.send(&m.src, NS_BEAT, &json!({"type": "PONG"}))?,
            (NS_CONN, "CLOSE") if self.app.as_ref().is_some_and(|a| a.0 == m.src) => {
                return Ok(Some(Flow::Ended))
            }
            (NS_RECV, "RECEIVER_STATUS") => return self.receiver_status(link, &v["status"]),
            (NS_RECV, "LAUNCH_ERROR" | "INVALID_REQUEST") => {
                self.launching = false;
                let why = v["reason"].as_str().unwrap_or("launch failed").to_string();
                if let Some(p) = self.pending.take() {
                    let _ = p.reply.send(Err(why));
                }
            }
            (NS_MEDIA, "MEDIA_STATUS") => self.media_status(&v),
            (NS_MEDIA, "LOAD_FAILED" | "LOAD_CANCELLED" | "INVALID_REQUEST" | "ERROR") => {
                let req = v["requestId"].as_u64();
                if self.waiting.as_ref().map(|w| w.0) == req {
                    if let Some((_, r, _)) = self.waiting.take() {
                        let _ = r.send(Err(format!("{kind} {}", v["detailedErrorCode"])));
                    }
                }
            }
            _ => {}
        }
        Ok(None)
    }

    fn serve(&mut self, link: &mut Link, rx: &Receiver<Cmd>) -> Flow {
        self.joined = false;
        let id = self.next();
        let hello = link
            .send(PLATFORM, NS_CONN, &json!({"type": "CONNECT"}))
            .and_then(|_| {
                link.send(
                    PLATFORM,
                    NS_RECV,
                    &json!({"type": "GET_STATUS", "requestId": id}),
                )
            });
        if let Err(e) = hello {
            return Flow::Lost(e);
        }
        self.set_conn("connected");
        let mut ping = Instant::now();
        self.poll_at = Instant::now() + POLL_EVERY;
        loop {
            loop {
                match rx.try_recv() {
                    Ok(Cmd::Close) | Err(TryRecvError::Disconnected) => return Flow::Close,
                    Ok(c) => {
                        if let Err(e) = self.command(link, c) {
                            return Flow::Lost(e);
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                }
            }
            if self
                .waiting
                .as_ref()
                .is_some_and(|w| w.2.elapsed() > LOAD_TIMEOUT)
            {
                self.fail_load("load timed out");
            }
            let mut beat = || -> Result<(), String> {
                if ping.elapsed() >= PING_EVERY {
                    ping = Instant::now();
                    link.send(PLATFORM, NS_BEAT, &json!({"type": "PING"}))?;
                }
                // odbiornik zgłasza stan tylko przy zmianach, pozycja dryfuje, a głośności nie ogłasza wcale
                if Instant::now() >= self.poll_at {
                    self.poll_at = Instant::now() + POLL_EVERY;
                    self.req += 1;
                    let id = self.req;
                    link.send(
                        PLATFORM,
                        NS_RECV,
                        &json!({"type": "GET_STATUS", "requestId": id}),
                    )?;
                    if let Some((tid, _)) = self
                        .app
                        .clone()
                        .filter(|_| self.joined && self.status.player == "PLAYING")
                    {
                        self.req += 1;
                        let id = self.req;
                        link.send(
                            &tid,
                            NS_MEDIA,
                            &json!({"type": "GET_STATUS", "requestId": id}),
                        )?;
                    }
                }
                Ok(())
            };
            if let Err(e) = beat() {
                return Flow::Lost(e);
            }
            if link.last_rx.elapsed() > DEAD_AFTER {
                return Flow::Lost("device stopped answering".into());
            }
            let msgs = match link.recv() {
                Ok(m) => m,
                Err(e) => return Flow::Lost(e),
            };
            for m in msgs {
                match self.handle(link, m) {
                    Ok(None) => {}
                    Ok(Some(flow)) => return flow,
                    Err(e) => return Flow::Lost(e),
                }
            }
        }
    }

    fn goodbye(&mut self, link: &mut Link) {
        if let Some((tid, sid)) = self.app.take() {
            let id = self.next();
            let _ = link.send(
                PLATFORM,
                NS_RECV,
                &json!({"type": "STOP", "sessionId": sid, "requestId": id}),
            );
            let _ = link.send(&tid, NS_CONN, &json!({"type": "CLOSE"}));
        }
        let _ = link.send(PLATFORM, NS_CONN, &json!({"type": "CLOSE"}));
        link.tls.conn.send_close_notify();
        let _ = link.tls.flush();
    }

    // przerwa przed ponownym połączeniem; zamknięcie działa od razu, a wczytanie poczeka na odbiornik
    fn idle(&mut self, rx: &Receiver<Cmd>, wait: Duration) -> bool {
        let end = Instant::now() + wait;
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(Cmd::Close) | Err(mpsc::RecvTimeoutError::Disconnected) => return false,
                Ok(Cmd::Load {
                    media,
                    start,
                    autoplay,
                    reply,
                }) => {
                    let p = Pending {
                        media,
                        start,
                        autoplay,
                        reply,
                    };
                    if let Some(old) = self.pending.replace(p) {
                        let _ = old.reply.send(Err("superseded".into()));
                    }
                }
                Ok(_) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => break,
            }
        }
        true
    }
}

fn run(dev: Device, session: u64, rx: Receiver<Cmd>, emit: Emit) {
    let mut s = Session {
        emit,
        status: Status {
            session,
            conn: "connecting",
            device: dev.name.clone(),
            volume: 1.0,
            ..Status::default()
        },
        req: 0,
        app: None,
        joined: false,
        media_id: None,
        launching: false,
        pending: None,
        waiting: None,
        poll_at: Instant::now(),
    };
    s.emit();
    let mut fails = 0u32;
    loop {
        match Link::open(&dev.host, dev.port) {
            Ok(mut link) => {
                fails = 0;
                match s.serve(&mut link, &rx) {
                    Flow::Close => {
                        s.goodbye(&mut link);
                        s.finish(None);
                        break;
                    }
                    Flow::Ended => {
                        s.finish(None);
                        break;
                    }
                    Flow::Lost(e) => {
                        crate::diag::log(format!("[Zenith] cast link lost: {e}"));
                        // zapytanie wysłane przed zerwaniem nie dostanie już odpowiedzi
                        if let Some((_, r, _)) = s.waiting.take() {
                            let _ = r.send(Err("connection lost".into()));
                        }
                        s.set_conn("reconnecting");
                    }
                }
            }
            Err(e) => {
                fails += 1;
                if fails > 5 {
                    s.finish(Some(e));
                    break;
                }
                s.set_conn("reconnecting");
                if !s.idle(&rx, Duration::from_secs(1 << fails.min(4))) {
                    s.finish(None);
                    break;
                }
            }
        }
    }
    if CURRENT.load(Ordering::SeqCst) == session {
        crate::player::PREFER_V4.store(false, Ordering::SeqCst);
    }
}

static CURRENT: AtomicU64 = AtomicU64::new(0);
static SESSION: Mutex<Option<Sender<Cmd>>> = Mutex::new(None);

pub fn connect(dev: Device, emit: Emit) -> u64 {
    let session = CURRENT.fetch_add(1, Ordering::SeqCst) + 1;
    // googlevideo wiąże link z adresem pytającego, a telewizor wychodzi do sieci przez wspólne IPv4
    crate::player::PREFER_V4.store(true, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    if let Some(old) = SESSION
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .replace(tx)
    {
        let _ = old.send(Cmd::Close);
    }
    let _ = std::thread::Builder::new()
        .name("cast".into())
        .spawn(move || run(dev, session, rx, emit));
    session
}

pub fn send(cmd: Cmd) -> Result<(), String> {
    SESSION
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .ok_or("not casting")?
        .send(cmd)
        .map_err(|_| "not casting".to_string())
}

pub fn disconnect() {
    if let Some(tx) = SESSION.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = tx.send(Cmd::Close);
    }
}

pub fn discover(wait: Duration) -> Vec<Device> {
    let Ok(daemon) = mdns_sd::ServiceDaemon::new() else {
        return Vec::new();
    };
    let mut out: Vec<Device> = Vec::new();
    if let Ok(rx) = daemon.browse("_googlecast._tcp.local.") {
        let end = Instant::now() + wait;
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(mdns_sd::ServiceEvent::ServiceResolved(s)) => {
                    let Some(ip) = s.get_addresses_v4().into_iter().next() else {
                        continue;
                    };
                    let id = s.get_property_val_str("id").unwrap_or(&s.fullname);
                    if out.iter().any(|d| d.id == id) {
                        continue;
                    }
                    let name = s
                        .get_property_val_str("fn")
                        .or_else(|| s.fullname.split('.').next())
                        .unwrap_or("Chromecast");
                    out.push(Device {
                        id: id.to_string(),
                        name: name.to_string(),
                        host: ip.to_string(),
                        port: s.get_port(),
                    });
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
    }
    let _ = daemon.shutdown();
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

fn bound_to_v6(url: &str) -> bool {
    query_param(url, "ip").is_some_and(|ip| ip.contains(':'))
}

fn query_param(url: &str, key: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()?
        .query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

// adres odtwarzacza to http://127.0.0.1:port/{zenith|offline}/token/id; telewizor dostaje link googlevideo
fn video_id_of(src: &str) -> Option<String> {
    let id = url::Url::parse(src)
        .ok()?
        .path_segments()?
        .next_back()?
        .to_string();
    (id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then_some(id)
}

async fn direct_url(app: AppHandle, id: &str) -> Result<String, String> {
    crate::stream::get_stream_url(app, id.to_string(), None).await?;
    if let Some(up) = crate::stream_proxy::current_upstream(id).filter(|u| !bound_to_v6(&u.url)) {
        return Ok(up.url);
    }
    // pobrany plik nie ma linku, a link przez IPv6 komputera telewizor dostałby z błędem 403
    crate::stream::evict_cached_url(id);
    crate::stream::recover_upstream(id, 0, "")
        .await
        .map(|u| u.url)
        .ok_or_else(|| "no stream".to_string())
}

fn media(url: &str, title: &str, artist: &str, album: &str, cover: &str) -> Value {
    let mime = query_param(url, "mime").unwrap_or_else(|| "audio/mp4".into());
    let images: Vec<Value> = [cover]
        .iter()
        .filter(|c| c.starts_with("https://"))
        .map(|c| json!({ "url": c }))
        .collect();
    json!({
        "contentId": url,
        "contentUrl": url,
        "streamType": "BUFFERED",
        "contentType": mime,
        "metadata": {
            "metadataType": 3,
            "title": title,
            "artist": artist,
            "albumName": album,
            "images": images
        }
    })
}

static DEVICES: Mutex<Vec<Device>> = Mutex::new(Vec::new());

#[tauri::command]
pub async fn cast_discover() -> Vec<Device> {
    let found = tauri::async_runtime::spawn_blocking(|| discover(Duration::from_millis(2500)))
        .await
        .unwrap_or_default();
    let mut known = DEVICES.lock().unwrap_or_else(|e| e.into_inner());
    for d in &found {
        known.retain(|k| k.id != d.id);
        known.push(d.clone());
    }
    found
}

// tylko urządzenia z wykrywania: okno nie może otworzyć TLS do dowolnego adresu w sieci
#[tauri::command]
pub fn cast_connect(webview: tauri::Webview, app: AppHandle, id: String) -> Result<u64, String> {
    crate::auth_store::main_window_only(&webview)?;
    let dev = DEVICES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|d| d.id == id)
        .cloned()
        .ok_or("unknown device")?;
    Ok(connect(
        dev,
        Arc::new(move |s: &Status| {
            let _ = app.emit("cast", s);
        }),
    ))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn cast_load(
    app: AppHandle,
    src: String,
    title: String,
    artist: String,
    album: Option<String>,
    cover: Option<String>,
    start: f64,
    autoplay: bool,
) -> Result<Status, String> {
    let id = video_id_of(&src).ok_or("not castable")?;
    let mut url = direct_url(app, &id).await?;
    let (album, cover) = (album.unwrap_or_default(), cover.unwrap_or_default());
    for retry in [false, true] {
        let (reply, rx) = tokio::sync::oneshot::channel();
        send(Cmd::Load {
            media: media(&url, &title, &artist, &album, &cover),
            start: start.max(0.0),
            autoplay,
            reply,
        })?;
        match rx.await.map_err(|_| "cast closed".to_string())? {
            // link z pamięci mógł wygasnąć albo telewizor dostał 403; jedna próba ze świeżym
            Err(e) if !retry && e.starts_with("LOAD_FAILED") => {
                url = crate::stream::recover_upstream(&id, 0, &url)
                    .await
                    .map(|u| u.url)
                    .ok_or(e)?;
            }
            r => return r,
        }
    }
    Err("load failed".into())
}

#[tauri::command]
pub fn cast_cmd(op: String, value: Option<f64>) -> Result<(), String> {
    let v = value.unwrap_or(0.0);
    send(match op.as_str() {
        "play" => Cmd::Media(json!({"type": "PLAY"})),
        "pause" => Cmd::Media(json!({"type": "PAUSE"})),
        "seek" => Cmd::Media(json!({"type": "SEEK", "currentTime": v.max(0.0)})),
        "volume" => Cmd::Volume(json!({"level": v.clamp(0.0, 1.0)})),
        "mute" => Cmd::Volume(json!({"muted": v > 0.0})),
        _ => return Err("unknown cast op".into()),
    })
}

#[tauri::command]
pub fn cast_disconnect() {
    disconnect();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cast_message_round_trip() {
        let long = "x".repeat(300);
        let frame = encode("sender-0", "receiver-0", NS_MEDIA, &long);
        let len = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
        assert_eq!(len, frame.len() - 4);
        let mut buf = frame[..10].to_vec();
        assert!(take_frames(&mut buf).unwrap().is_empty());
        buf.extend_from_slice(&frame[10..]);
        buf.extend_from_slice(&frame);
        let frames = take_frames(&mut buf).unwrap();
        assert_eq!(frames.len(), 2);
        assert!(buf.is_empty());
        let m = decode(&frames[0]).unwrap();
        assert_eq!(
            m,
            Msg {
                src: "sender-0".into(),
                ns: NS_MEDIA.into(),
                payload: long
            }
        );
        assert!(take_frames(&mut vec![0xff, 0xff, 0xff, 0xff]).is_err());
        assert!(decode(&[0x12, 0x05, b'a']).is_none());
    }

    #[test]
    fn stream_urls_for_the_tv() {
        assert_eq!(
            video_id_of("http://127.0.0.1:5000/zenith/abc/dQw4w9WgXcQ").as_deref(),
            Some("dQw4w9WgXcQ")
        );
        assert_eq!(
            video_id_of("http://127.0.0.1:5000/offline/abc/dQw4w9WgXcQ").as_deref(),
            Some("dQw4w9WgXcQ")
        );
        assert!(video_id_of("http://127.0.0.1:5000/local/abc/song.flac").is_none());
        assert!(bound_to_v6(
            "https://r1.googlevideo.com/videoplayback?ip=2a02%3A1%3A%3A5&mime=audio%2Fwebm"
        ));
        let m = media(
            "https://r1.googlevideo.com/videoplayback?ip=1.2.3.4&mime=audio%2Fwebm",
            "T",
            "A",
            "",
            "",
        );
        assert_eq!(m["contentType"], "audio/webm");
        assert_eq!(m["metadata"]["images"], json!([]));
    }
}

// cargo test -q --lib -- --ignored cast_live --nocapture; ZENITH_CAST_HOST wybiera urządzenie, ZENITH_CAST_ID utwór
#[cfg(test)]
mod live {
    use super::*;

    fn wait_for(
        rx: &Receiver<Status>,
        what: &str,
        secs: u64,
        ok: impl Fn(&Status) -> bool,
    ) -> Status {
        let end = Instant::now() + Duration::from_secs(secs);
        loop {
            let left = end
                .checked_duration_since(Instant::now())
                .unwrap_or_else(|| panic!("timed out waiting for {what}"));
            let s = rx
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
            println!(
                "  [{what}] conn={} player={} idle={} t={:.1}/{:.1} vol={:.2} muted={} err={}",
                s.conn, s.player, s.idle, s.time, s.duration, s.volume, s.muted, s.error
            );
            assert_ne!(s.conn, "closed", "session closed while waiting for {what}");
            if ok(&s) {
                return s;
            }
        }
    }

    fn pause_for(rx: &Receiver<Status>, secs: u64) {
        let end = Instant::now() + Duration::from_secs(secs);
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            if let Ok(s) = rx.recv_timeout(left) {
                println!("  [watch] player={} t={:.1}", s.player, s.time);
            }
        }
    }

    // po panice wątek sesji musi jeszcze zdążyć wysłać STOP, inaczej telewizor gra dalej
    struct StopOnDrop;

    impl Drop for StopOnDrop {
        fn drop(&mut self) {
            disconnect();
            std::thread::sleep(Duration::from_millis(1500));
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "casts to a real device on the LAN"]
    async fn cast_live() {
        let want = std::env::var("ZENITH_CAST_HOST").ok();
        let found = tokio::task::spawn_blocking(|| discover(Duration::from_secs(4)))
            .await
            .unwrap();
        println!("discovered: {found:?}");
        let dev = found
            .into_iter()
            .find(|d| want.as_deref().is_none_or(|h| d.host == h))
            .expect("no cast device on the LAN");
        let (tx, rx) = mpsc::channel();
        connect(
            dev,
            Arc::new(move |s: &Status| {
                let _ = tx.send(s.clone());
            }),
        );
        let _guard = StopOnDrop;
        wait_for(&rx, "connected", 10, |s| s.conn == "connected");
        let vol0 = wait_for(&rx, "receiver status", 10, |_| true).volume;

        crate::player_js::init(std::env::temp_dir().join("zenith-live-player"));
        let id = std::env::var("ZENITH_CAST_ID").unwrap_or_else(|_| "dQw4w9WgXcQ".into());
        let got = match crate::player::fetch_direct_audio(&id).await {
            Some(g) => g,
            None => {
                crate::player::resolve_with(&id, crate::resolve_plan::GUEST_JS, None)
                    .await
                    .expect("no stream for the test track")
                    .0
            }
        };
        println!(
            "stream ip={:?} mime={:?} itag={:?}",
            query_param(&got.url, "ip"),
            query_param(&got.url, "mime"),
            query_param(&got.url, "itag")
        );
        let cover = format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg");
        let (reply, loaded) = tokio::sync::oneshot::channel();
        send(Cmd::Load {
            media: media(&got.url, "Zenith cast test", "Zenith", "Live test", &cover),
            start: 0.0,
            autoplay: true,
            reply,
        })
        .unwrap();
        let st = loaded.await.unwrap();
        println!("LOAD answered: {st:?}");
        let st = st.expect("device refused the stream");
        if st.player != "PLAYING" {
            wait_for(&rx, "playing", 30, |s| s.player == "PLAYING");
        }
        pause_for(&rx, 10);

        send(Cmd::Media(json!({"type": "PAUSE"}))).unwrap();
        wait_for(&rx, "paused", 10, |s| s.player == "PAUSED");
        send(Cmd::Media(json!({"type": "SEEK", "currentTime": 60.0}))).unwrap();
        wait_for(&rx, "seeked", 10, |s| (s.time - 60.0).abs() < 2.0);
        send(Cmd::Media(json!({"type": "PLAY"}))).unwrap();
        wait_for(&rx, "resumed", 10, |s| s.player == "PLAYING");
        pause_for(&rx, 4);

        let probe = if vol0 > 0.1 { vol0 - 0.05 } else { vol0 + 0.05 };
        send(Cmd::Volume(json!({ "level": probe }))).unwrap();
        wait_for(&rx, "volume probe", 10, |s| (s.volume - probe).abs() < 0.02);
        send(Cmd::Volume(json!({ "level": vol0 }))).unwrap();
        wait_for(&rx, "volume restored", 10, |s| {
            (s.volume - vol0).abs() < 0.02
        });

        send(Cmd::Media(json!({"type": "STOP"}))).unwrap();
        wait_for(&rx, "stopped", 10, |s| s.player == "IDLE");
        disconnect();
        let end = Instant::now() + Duration::from_secs(10);
        while let Ok(s) = rx.recv_timeout(end.saturating_duration_since(Instant::now())) {
            println!("  [disconnect] conn={}", s.conn);
            if s.conn == "closed" {
                assert!(s.error.is_empty(), "{}", s.error);
                return;
            }
        }
        panic!("session did not close");
    }
}
