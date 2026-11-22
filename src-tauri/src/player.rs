use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

// jeden klient na (UA, limit, przekierowania): każda budowa wczytuje certyfikaty i gubi otwarte połączenia
pub fn client(ua: &str, secs: u64, follow: bool) -> Option<reqwest::Client> {
    type Key = (String, u64, bool);
    static CACHE: OnceLock<Mutex<HashMap<Key, reqwest::Client>>> = OnceLock::new();
    let mut m = CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let key = (ua.to_string(), secs, follow);
    if let Some(c) = m.get(&key) {
        return Some(c.clone());
    }
    crate::win_proxy::wait();
    let mut b = reqwest::Client::builder().timeout(Duration::from_secs(secs));
    if !ua.is_empty() {
        b = b.user_agent(ua);
    }
    if !follow {
        b = b.redirect(reqwest::redirect::Policy::none());
    }
    let c = b.build().ok()?;
    m.insert(key, c.clone());
    Some(c)
}
use std::time::{Duration, Instant};

use crate::now_secs;

const ANDROID_KEY: &str = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vfUWA0yam";
const PLAYER_URL: &str = "https://www.youtube.com/youtubei/v1/player";

const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const VISIONOS_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

const VISITOR_TTL: Duration = Duration::from_secs(6 * 3600);
const BOT_COOLDOWN: Duration = Duration::from_secs(10 * 60);

static VISITOR: Mutex<Option<(String, Instant)>> = Mutex::new(None);
static BOT_BLOCKED_AT: Mutex<Option<Instant>> = Mutex::new(None);
static RATE_LIMITED_AT: Mutex<Option<Instant>> = Mutex::new(None);
// po limicie YouTube każda kolejna próba przedłuża blokadę; 12 wywołań /player na utwór wystarcza na wszystkie warstwy
const CALLS_PER_VIDEO: u32 = 12;
const CALLS_WINDOW: Duration = Duration::from_secs(10 * 60);

fn parse_visitor_data(body: &str) -> Option<String> {
    let start = body.find('[')?;
    let v: Value = serde_json::from_str(&body[start..]).ok()?;
    let vd = v.pointer("/0/2/0/0/13")?.as_str()?.trim();
    if vd.len() >= 16 && vd.len() <= 2048 && vd.bytes().all(|b| b.is_ascii_graphic()) {
        Some(vd.to_string())
    } else {
        None
    }
}

async fn visitor_data() -> Option<String> {
    if let Ok(g) = VISITOR.lock() {
        if let Some((v, at)) = g.as_ref() {
            if at.elapsed() < VISITOR_TTL {
                return Some(v.clone());
            }
        }
    }
    let http = client(CHROME_UA, 6, true)?;
    let body = http
        .get("https://www.youtube.com/sw.js_data")
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    let vd = parse_visitor_data(&body)?;
    if let Ok(mut g) = VISITOR.lock() {
        *g = Some((vd.clone(), Instant::now()));
    }
    Some(vd)
}

fn status_reason(data: &Value) -> (&str, String) {
    let status = data
        .pointer("/playabilityStatus/status")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let reason = data
        .pointer("/playabilityStatus/reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    (status, reason)
}

// "Sign in to confirm your age" też ma LOGIN_REQUIRED, a blokadą adresu IP jest tylko "not a bot"
fn is_bot_check(data: &Value) -> bool {
    let (status, reason) = status_reason(data);
    status == "LOGIN_REQUIRED" && reason.contains("not a bot")
}

// jak _is_agegated w yt-dlp: osobne pole, status albo treść powodu, zależnie od klienta
pub fn is_age_gated(data: &Value) -> bool {
    if data
        .pointer("/playabilityStatus/desktopLegacyAgeGateReason")
        .is_some_and(|v| !v.is_null())
    {
        return true;
    }
    let (status, reason) = status_reason(data);
    matches!(status, "AGE_CHECK_REQUIRED" | "AGE_VERIFICATION_REQUIRED")
        || ["confirm your age", "age-restricted", "inappropriate"]
            .iter()
            .any(|s| reason.contains(s))
}

fn failure_kind(data: &Value) -> &'static str {
    let (status, reason) = status_reason(data);
    if is_age_gated(data) {
        "age"
    } else if is_bot_check(data) {
        "bot"
    } else if reason.contains("try again later") {
        // ten sam status ERROR co usunięty film, ale to limit zapytań z tego adresu (jak w yt-dlp)
        "ratelimit"
    } else if reason.contains("country") {
        "region"
    } else if status == "ERROR"
        || ["private", "removed", "terminated", "no longer available"]
            .iter()
            .any(|s| reason.contains(s))
    {
        "gone"
    } else {
        "blocked"
    }
}

type Kinds = Mutex<HashMap<String, &'static str>>;

fn kinds() -> &'static Kinds {
    static K: OnceLock<Kinds> = OnceLock::new();
    K.get_or_init(Default::default)
}

// klienci mówią różnie o tym samym filmie (np. visionos "not available" przy filmie dla dzieci), wygrywa najpewniejszy
fn kind_rank(k: &str) -> u8 {
    match k {
        "ratelimit" => 7,
        "dead" => 6,
        "age" => 5,
        "region" => 4,
        "bot" => 3,
        "blocked" => 2,
        _ => 1,
    }
}

pub fn note_kind(video_id: &str, kind: &'static str) {
    let mut m = kinds().lock().unwrap_or_else(|p| p.into_inner());
    if m.len() >= 256 {
        m.clear();
    }
    let e = m.entry(video_id.to_string()).or_insert(kind);
    if kind_rank(kind) > kind_rank(e) {
        *e = kind;
    }
}

pub fn failure_of(video_id: &str) -> Option<&'static str> {
    kinds()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(video_id)
        .copied()
}

pub fn forget_failure(video_id: &str) {
    kinds()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(video_id);
}

fn active(at: &Mutex<Option<Instant>>) -> bool {
    at.lock()
        .ok()
        .and_then(|g| *g)
        .is_some_and(|at| at.elapsed() < BOT_COOLDOWN)
}

// blokada gościa: „not a bot” albo limit; zalogowany ma inne liczniki po stronie YouTube
pub fn bot_blocked() -> bool {
    active(&BOT_BLOCKED_AT) || rate_limited()
}

pub fn rate_limited() -> bool {
    active(&RATE_LIMITED_AT)
}

// nowy visitor, ale bez kasowania blokady: eskalacja zerująca ją sama napędzała lawinę zapytań
pub fn fresh_start() {
    if let Ok(mut g) = VISITOR.lock() {
        *g = None;
    }
}

fn mark_bot_blocked() {
    crate::diag::log("[Zenith] guest cooldown: youtube asked to confirm not a bot".into());
    if let Ok(mut g) = BOT_BLOCKED_AT.lock() {
        *g = Some(Instant::now());
    }
    fresh_start();
}

fn mark_rate_limited(video_id: &str) {
    crate::diag::log(format!("[Zenith] rate limited by youtube at {video_id}"));
    if let Ok(mut g) = RATE_LIMITED_AT.lock() {
        *g = Some(Instant::now());
    }
    note_kind(video_id, "ratelimit");
}

type Calls = Mutex<HashMap<String, (u32, Instant)>>;

fn calls() -> &'static Calls {
    static C: OnceLock<Calls> = OnceLock::new();
    C.get_or_init(Default::default)
}

fn take_call(video_id: &str, now: Instant) -> bool {
    take_from(calls(), CALLS_PER_VIDEO, video_id, now)
}

fn take_from(calls: &Calls, limit: u32, video_id: &str, now: Instant) -> bool {
    let mut m = calls.lock().unwrap_or_else(|p| p.into_inner());
    m.retain(|_, (_, at)| now.duration_since(*at) < CALLS_WINDOW);
    let e = m.entry(video_id.to_string()).or_insert((0, now));
    if e.0 >= limit {
        return false;
    }
    e.0 += 1;
    true
}

fn calls_done(video_id: &str) {
    calls()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(video_id);
}

#[derive(Clone, Debug)]
pub struct DirectAudio {
    pub url: String,
    pub user_agent: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Client {
    Visionos,
    TvSamsung,
    WebEmbedded,
    Web,
    Mweb,
    WebMusic,
    WebCreator,
}

pub struct ClientSpec {
    pub name: &'static str,
    pub version: &'static str,
    pub client_id: i32,
    pub user_agent: &'static str,
    pub host: &'static str,
    pub needs_js: bool,
    pub needs_pot: bool,
    pub cookies: bool,
    extra: fn() -> Value,
}

const SAFARI_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)";
const TIZEN_UA: &str = "Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1";
const IPAD_UA: &str = "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)";

fn no_extra() -> Value {
    json!({})
}

pub fn spec(c: Client) -> ClientSpec {
    let base = |name, version, client_id, user_agent| ClientSpec {
        name,
        version,
        client_id,
        user_agent,
        host: "www.youtube.com",
        needs_js: true,
        needs_pot: false,
        cookies: true,
        extra: no_extra,
    };
    match c {
        Client::Visionos => ClientSpec {
            needs_js: false,
            cookies: false,
            extra: || {
                json!({
                    "deviceMake": "Apple",
                    "deviceModel": "RealityDevice17,1",
                    "osName": "visionOS",
                    "osVersion": "26.5.23O471",
                })
            },
            ..base("VISIONOS", "1.02", 101, VISIONOS_UA)
        },
        Client::TvSamsung => ClientSpec {
            extra: || {
                json!({
                    "deviceMake": "Samsung",
                    "deviceModel": "UKS9800",
                    "osName": "Tizen",
                    "osVersion": "2.4.0",
                })
            },
            ..base("TVHTML5", "5.20260707", 7, TIZEN_UA)
        },
        Client::WebEmbedded => base("WEB_EMBEDDED_PLAYER", "2.20260708.00.00", 56, SAFARI_UA),
        Client::Web => ClientSpec {
            needs_pot: true,
            ..base("WEB", "2.20260708.00.00", 1, CHROME_UA)
        },
        Client::Mweb => ClientSpec {
            needs_pot: true,
            ..base("MWEB", "2.20260708.05.00", 2, IPAD_UA)
        },
        Client::WebMusic => ClientSpec {
            needs_pot: true,
            host: "music.youtube.com",
            ..base("WEB_REMIX", "1.20260707.12.00", 67, CHROME_UA)
        },
        // yt-dlp: omija weryfikację wieku konta w UE, ale tylko z logowaniem i tokenem PO
        Client::WebCreator => ClientSpec {
            needs_pot: true,
            ..base("WEB_CREATOR", "1.20260708.06.00", 62, CHROME_UA)
        },
    }
}

#[derive(Clone)]
pub struct Auth {
    pub cookie: String,
    pub data_sync_id: Option<String>,
}

impl Auth {
    pub fn from_cookie_header(cookie: &str) -> Option<Auth> {
        let has_sid = cookie.split(';').any(|p| {
            let k = p.trim().split('=').next().unwrap_or("");
            matches!(k, "SAPISID" | "__Secure-3PAPISID" | "__Secure-1PAPISID")
        });
        (has_sid && !cookie.trim().is_empty()).then(|| Auth {
            cookie: cookie.to_string(),
            data_sync_id: None,
        })
    }
}

pub fn parse_cipher(sc: &str) -> Option<(String, String, String)> {
    let mut url = None;
    let mut s = None;
    let mut sp = None;
    for (k, v) in url::form_urlencoded::parse(sc.as_bytes()) {
        match k.as_ref() {
            "url" => url = Some(v.to_string()),
            "s" => s = Some(v.to_string()),
            "sp" => sp = Some(v.to_string()),
            _ => {}
        }
    }
    Some((url?, s?, sp.unwrap_or_else(|| "signature".into())))
}

pub fn query_param(u: &str, key: &str) -> Option<String> {
    let parsed = url::Url::parse(u).ok()?;
    let v = parsed
        .query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.to_string());
    v
}

pub fn set_param(u: &str, key: &str, value: &str) -> String {
    let Ok(mut parsed) = url::Url::parse(u) else {
        return u.to_string();
    };
    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(k, _)| k != key)
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    {
        let mut q = parsed.query_pairs_mut();
        q.clear();
        for (k, v) in &pairs {
            q.append_pair(k, v);
        }
        q.append_pair(key, value);
    }
    parsed.to_string()
}

struct Candidate {
    score: i32,
    url: String,
    sig: Option<(String, String)>,
}

fn candidates(data: &Value) -> Vec<Candidate> {
    let mut formats: Vec<&Value> = Vec::new();
    for ptr in ["/streamingData/adaptiveFormats", "/streamingData/formats"] {
        if let Some(arr) = data.pointer(ptr).and_then(|v| v.as_array()) {
            formats.extend(arr);
        }
    }
    let mut out = Vec::new();
    for audio_only in [true, false] {
        for fmt in &formats {
            // eksperyment DRM na klientach TV: taki format ma adres, ale bez licencji nie da się go odtworzyć
            if audio_only != is_audio_only_fmt(fmt) || fmt.get("drmFamilies").is_some() {
                continue;
            }
            let score = format_score(fmt) - if audio_only { 0 } else { 1000 };
            if format_score(fmt) <= 0 {
                continue;
            }
            if let Some(u) = fmt.get("url").and_then(|v| v.as_str()) {
                if is_progressive_url(u) {
                    out.push(Candidate {
                        score,
                        url: u.to_string(),
                        sig: None,
                    });
                }
            } else if let Some(sc) = fmt.get("signatureCipher").and_then(|v| v.as_str()) {
                if let Some((u, s, sp)) = parse_cipher(sc) {
                    if is_progressive_url(&u) {
                        out.push(Candidate {
                            score,
                            url: u,
                            sig: Some((s, sp)),
                        });
                    }
                }
            }
        }
    }
    out.sort_by_key(|c| std::cmp::Reverse(c.score));
    out
}

// sam obraz z adaptiveFormats: avc1 tylko gdy WebView go zdekoduje, potem vp9; AV1 i reszta odpadają (ciężkie w CPU)
fn video_candidates(data: &Value, max_h: u32, avc: bool) -> Vec<Candidate> {
    let num = |f: &Value, k: &str| f.get(k).and_then(Value::as_i64).unwrap_or(0);
    let mut out: Vec<(i64, i64, Candidate)> = Vec::new();
    let list = data
        .pointer("/streamingData/adaptiveFormats")
        .and_then(Value::as_array);
    for fmt in list.into_iter().flatten() {
        let mime = fmt.get("mimeType").and_then(Value::as_str).unwrap_or("");
        let codecs = mime.split("codecs=").nth(1).unwrap_or("").trim_matches('"');
        let base = if !mime.starts_with("video/") {
            continue;
        } else if avc && codecs.starts_with("avc1") {
            2000
        } else if codecs.starts_with("vp9") || codecs.starts_with("vp09") {
            1000
        } else {
            continue;
        };
        let height = num(fmt, "height");
        if fmt.get("drmFamilies").is_some()
            || fmt.get("type").and_then(Value::as_str) == Some("FORMAT_STREAM_TYPE_OTF")
            || height <= 0
            || height > max_h as i64
        {
            continue;
        }
        let score = base + height - if num(fmt, "fps") > 30 { 100 } else { 0 };
        let found = match (
            fmt.get("url").and_then(Value::as_str),
            fmt.get("signatureCipher"),
        ) {
            (Some(u), _) => Some((u.to_string(), None)),
            (None, Some(sc)) => sc
                .as_str()
                .and_then(parse_cipher)
                .map(|(u, s, sp)| (u, Some((s, sp)))),
            _ => None,
        };
        if let Some((url, sig)) = found.filter(|(u, _)| is_progressive_url(u)) {
            out.push((
                score,
                num(fmt, "bitrate"),
                Candidate {
                    score: score as i32,
                    url,
                    sig,
                },
            ));
        }
    }
    out.sort_by_key(|(s, b, _)| (std::cmp::Reverse(*s), *b));
    out.into_iter().map(|(_, _, c)| c).collect()
}

// ATV to nieruchoma okładka; goście nie podają musicVideoType, ale ATV zawsze wrzuca kanał „… - Topic”
fn still_image_upload(data: &Value) -> bool {
    let field = |p: &str| data.pointer(p).and_then(Value::as_str).unwrap_or("");
    field("/videoDetails/musicVideoType") == "MUSIC_VIDEO_TYPE_ATV"
        || field("/videoDetails/author").ends_with(" - Topic")
}

// adres działa dopiero po reklamie przed utworem (yt-dlp _get_available_at_timestamp); wcześniej googlevideo daje 403
fn preroll_wait(data: &Value) -> Duration {
    fn ads(v: &Value, ms: &mut f64) {
        match v {
            Value::Object(m) => {
                if let Some(r) = m.get("instreamVideoAdRenderer") {
                    let len = r
                        .get("playerVars")
                        .and_then(Value::as_str)
                        .and_then(|q| {
                            url::form_urlencoded::parse(q.as_bytes())
                                .find(|(k, _)| k == "length_seconds")
                                .and_then(|(_, v)| v.parse::<f64>().ok())
                        })
                        .map(|s| s * 1000.0);
                    let skip = r.get("skipOffsetMilliseconds").and_then(Value::as_f64);
                    *ms += skip.or(len).unwrap_or(0.0);
                    return;
                }
                m.values().for_each(|x| ads(x, ms));
            }
            Value::Array(a) => a.iter().for_each(|x| ads(x, ms)),
            _ => {}
        }
    }
    let list = |key: &str| {
        data.get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
    };
    let mut ms = 0.0;
    for p in list("adPlacements").filter(|p| {
        p.pointer("/adPlacementRenderer/config/adPlacementConfig/kind")
            .and_then(Value::as_str)
            == Some("AD_PLACEMENT_KIND_START")
    }) {
        ads(p, &mut ms);
    }
    for s in list("adSlots").filter(|s| {
        s.pointer("/adSlotRenderer/adSlotMetadata/triggerEvent")
            .and_then(Value::as_str)
            == Some("SLOT_TRIGGER_EVENT_BEFORE_CONTENT")
    }) {
        ads(s, &mut ms);
    }
    Duration::from_millis(ms.clamp(0.0, 15_000.0) as u64)
}

fn is_progressive_url(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    if u.is_empty() {
        return false;
    }
    if u.contains(".m3u8") || u.contains("manifest/hls") || u.contains("/sabr/") {
        return false;
    }
    if u.contains("manifest/dash") || u.contains("mime=text") {
        return false;
    }
    u.starts_with("https://") || u.starts_with("http://")
}

fn format_score(fmt: &Value) -> i32 {
    let itag = fmt.get("itag").and_then(|v| v.as_i64()).unwrap_or(0);
    let mime = fmt
        .get("mimeType")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if crate::native_audio::available() {
        match itag {
            251 => return 120,
            250 => return 115,
            249 => return 112,
            _ => {}
        }
    }
    match itag {
        141 => 110,
        140 => 100,
        251 => 90,
        250 => 80,
        249 => 70,
        139 => 60,
        18 => 50,
        _ => {
            if mime.starts_with("audio/mp4") {
                85
            } else if mime.contains("mp4a") {
                82
            } else if mime.starts_with("audio/webm") || mime.contains("opus") {
                75
            } else if mime.starts_with("audio/") {
                40
            } else if mime.contains("audio/mp4") || mime.contains("mp4a") {
                45
            } else {
                0
            }
        }
    }
}

fn is_audio_only_fmt(fmt: &Value) -> bool {
    let mime = fmt
        .get("mimeType")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    mime.starts_with("audio/")
}

#[cfg(test)]
fn pick_audio_url(data: &Value) -> Option<String> {
    candidates(data)
        .into_iter()
        .find(|c| c.sig.is_none())
        .map(|c| c.url)
}

fn playable(data: &Value) -> bool {
    let status = data
        .pointer("/playabilityStatus/status")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    status.is_empty() || status.eq_ignore_ascii_case("ok")
}

const EMBED_URL: &str = "https://www.reddit.com/";

pub fn request_body(
    video_id: &str,
    spec: &ClientSpec,
    visitor: Option<&str>,
    sts: Option<u64>,
) -> Value {
    let mut client_obj = json!({
        "clientName": spec.name,
        "clientVersion": spec.version,
        "hl": "en",
        "gl": "US",
        "timeZone": "UTC",
        "utcOffsetMinutes": 0,
        "userAgent": spec.user_agent,
    });
    if let (Some(map), Some(dst)) = (
        (spec.extra)().as_object().cloned(),
        client_obj.as_object_mut(),
    ) {
        for (k, v) in map {
            dst.insert(k, v);
        }
    }
    if let (Some(vd), Some(dst)) = (visitor, client_obj.as_object_mut()) {
        dst.insert("visitorData".into(), Value::String(vd.to_string()));
    }
    let mut playback = json!({ "html5Preference": "HTML5_PREF_WANTS" });
    if let Some(sts) = sts {
        playback["signatureTimestamp"] = json!(sts);
    }
    let mut context = json!({ "client": client_obj });
    if spec.name == "WEB_EMBEDDED_PLAYER" {
        context["thirdParty"] = json!({ "embedUrl": EMBED_URL });
    }
    json!({
        "context": context,
        "videoId": video_id,
        "contentCheckOk": true,
        "racyCheckOk": true,
        "playbackContext": { "contentPlaybackContext": playback },
    })
}

fn json_str_field(html: &str, key: &str) -> Option<String> {
    let at = html.find(&format!("\"{key}\":\""))? + key.len() + 4;
    let rest = &html[at..];
    let v = &rest[..rest.find('"')?];
    (!v.is_empty()).then(|| v.to_string())
}

struct Embed {
    ctx: String,
    flags: String,
    version: Option<String>,
    visitor: Option<String>,
}

async fn embed_tokens(video_id: &str, user_agent: &str) -> Option<Embed> {
    let http = client(user_agent, 8, true)?;
    let html = http
        .get(format!("https://www.youtube.com/embed/{video_id}?html5=1"))
        .header("Referer", EMBED_URL)
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    Some(Embed {
        ctx: json_str_field(&html, "embeddedPlayerEncryptedContext")?,
        flags: json_str_field(&html, "encryptedHostFlags")?,
        version: json_str_field(&html, "INNERTUBE_CLIENT_VERSION"),
        visitor: json_str_field(&html, "VISITOR_DATA"),
    })
}

async fn player_request(
    video_id: &str,
    spec: &ClientSpec,
    visitor: Option<&str>,
    sts: Option<u64>,
    auth: Option<&Auth>,
) -> Option<Value> {
    let embed = if spec.name == "WEB_EMBEDDED_PLAYER" {
        Some(embed_tokens(video_id, spec.user_agent).await?)
    } else {
        None
    };
    let visitor = embed
        .as_ref()
        .and_then(|e| e.visitor.as_deref())
        .or(visitor);
    let version = embed
        .as_ref()
        .and_then(|e| e.version.as_deref())
        .unwrap_or(spec.version);
    let mut body = request_body(video_id, spec, visitor, sts);
    if let Some(e) = &embed {
        body["context"]["client"]["clientVersion"] = json!(version);
        body["context"]["thirdParty"]["embeddedPlayerContext"] = json!({
            "embeddedPlayerEncryptedContext": e.ctx,
            "ancestorOriginsSupported": false,
        });
        body["playbackContext"]["contentPlaybackContext"]["encryptedHostFlags"] = json!(e.flags);
    }
    let http = client(spec.user_agent, 10, true)?;
    let origin = format!("https://{}", spec.host);
    let url = if spec.name == "VISIONOS" {
        format!("{PLAYER_URL}?prettyPrint=false&key={ANDROID_KEY}")
    } else {
        format!("https://{}/youtubei/v1/player?prettyPrint=false", spec.host)
    };
    let mut req = http
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Origin", origin.as_str())
        .header("X-YouTube-Client-Name", spec.client_id.to_string())
        .header("X-YouTube-Client-Version", version);
    if let Some(vd) = visitor {
        req = req.header("X-Goog-Visitor-Id", vd);
    }
    if let Some(a) = auth.filter(|_| spec.cookies) {
        let authz = crate::ytm_api::sapisid_authorization(&a.cookie, &origin, now_secs());
        req = req
            .header("Cookie", a.cookie.as_str())
            .header("X-Goog-AuthUser", "0")
            .header("X-Origin", origin.as_str());
        if !authz.is_empty() {
            req = req.header("Authorization", authz);
        }
    }
    let res = req.json(&body).send().await.ok()?;
    if !res.status().is_success() {
        crate::diag::log(format!(
            "[Zenith] innertube {} {} http {}",
            spec.name,
            video_id,
            res.status().as_u16()
        ));
        if res.status().as_u16() == 429 {
            mark_rate_limited(video_id);
        }
        return None;
    }
    let data: Value = res.json().await.ok()?;
    if let Some(db) = data
        .pointer("/playerConfig/audioConfig/loudnessDb")
        .and_then(Value::as_f64)
    {
        remember_loudness(video_id, db);
    }
    Some(data)
}

fn loudness_map() -> &'static Mutex<HashMap<String, f64>> {
    static MAP: OnceLock<Mutex<HashMap<String, f64>>> = OnceLock::new();
    MAP.get_or_init(Default::default)
}

fn remember_loudness(video_id: &str, db: f64) {
    if !db.is_finite() {
        return;
    }
    let mut m = loudness_map().lock().unwrap_or_else(|p| p.into_inner());
    if m.len() >= 512 {
        m.clear();
    }
    m.insert(video_id.to_string(), db);
}

/// Głośność utworu względem poziomu odniesienia YouTube (-14 LUFS), z odpowiedzi odtwarzacza.
pub fn loudness_db(video_id: &str) -> Option<f64> {
    loudness_map()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(video_id)
        .copied()
}

async fn finish_url(
    c: &Candidate,
    player: Option<&crate::player_js::Player>,
    pot: Option<&str>,
) -> Option<String> {
    let mut url = c.url.clone();
    let n = query_param(&url, "n");
    if c.sig.is_some() || n.is_some() {
        let p = player?;
        let sig_in: Vec<String> = c.sig.iter().map(|(s, _)| s.clone()).collect();
        let n_in: Vec<String> = n.iter().cloned().collect();
        let solved = match crate::player_js::solve(&p.id, n_in, sig_in).await {
            Ok(s) => s,
            Err(e) => {
                crate::diag::log(format!("[Zenith] js challenge failed: {e}"));
                return None;
            }
        };
        if let Some((s, sp)) = &c.sig {
            url = set_param(&url, sp, solved.sig.get(s)?);
        }
        if let Some(n) = &n {
            url = set_param(&url, "n", solved.n.get(n)?);
        }
    }
    if let Some(t) = pot {
        url = set_param(&url, "pot", t);
    }
    Some(url)
}

pub async fn client_once(
    video_id: &str,
    client: Client,
    visitor: Option<&str>,
    auth: Option<&Auth>,
) -> Option<DirectAudio> {
    let spec = spec(client);
    let auth = auth.filter(|_| spec.cookies);
    if rate_limited() || (auth.is_none() && bot_blocked()) {
        return None;
    }
    if !take_call(video_id, Instant::now()) {
        crate::diag::log(format!("[Zenith] innertube budget used up for {video_id}"));
        return None;
    }
    let player = if spec.needs_js {
        Some(crate::player_js::current().await?)
    } else {
        None
    };
    // zalogowany web_embedded bez tokenu PO GVS daje adresy z 403 (yt-dlp #17989, #18051)
    let needs_pot = spec.needs_pot || (auth.is_some() && client == Client::WebEmbedded);
    let pot = if needs_pot {
        let binding = match auth {
            Some(a) => a.data_sync_id.clone().or_else(|| visitor.map(String::from)),
            None => visitor.map(String::from),
        }?;
        crate::potoken::want();
        Some(crate::potoken::mint(&binding).await?)
    } else {
        None
    };
    let data = player_request(
        video_id,
        &spec,
        visitor,
        player.as_ref().and_then(|p| p.sts),
        auth,
    )
    .await?;
    let ready_at = tokio::time::Instant::now() + preroll_wait(&data);
    let status = data
        .pointer("/playabilityStatus/status")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    // „not a bot” u gościa dotyczy adresu IP, nie klienta, więc pozostali goście dostaliby to samo
    if is_bot_check(&data) && auth.is_none() {
        mark_bot_blocked();
    }
    if failure_kind(&data) == "ratelimit" {
        mark_rate_limited(video_id);
    }
    if !playable(&data) {
        let why = data
            .pointer("/playabilityStatus/errorCode")
            .or_else(|| data.pointer("/playabilityStatus/reason"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        crate::diag::log(format!(
            "[Zenith] innertube {} {}: {} {}",
            spec.name, video_id, status, why
        ));
        note_kind(video_id, failure_kind(&data));
        return None;
    }
    let list = candidates(&data);
    if list.is_empty() {
        crate::diag::log(format!(
            "[Zenith] innertube {} {} playable but no progressive audio",
            spec.name, video_id
        ));
        // same strumienie SABR mówią coś tylko o tym kliencie; „dead” zasłaniałby prawdziwy powód od innych
        note_kind(video_id, "sabr");
        return None;
    }
    for c in list.iter().take(3) {
        let Some(url) = finish_url(c, player.as_ref(), pot.as_deref()).await else {
            continue;
        };
        tokio::time::sleep_until(ready_at).await;
        if url_reachable(&url, spec.user_agent).await && tail_reachable(&url, spec.user_agent).await
        {
            crate::diag::log(format!(
                "[Zenith] innertube {} ok for {}",
                spec.name, video_id
            ));
            calls_done(video_id);
            return Some(DirectAudio {
                url,
                user_agent: spec.user_agent.to_string(),
            });
        }
        crate::diag::log(format!(
            "[Zenith] innertube {} url dead (403?) for {}",
            spec.name, video_id
        ));
    }
    // klient przeszedł bramkę, więc to nie wiek ani region i eskalacja z odświeżonym player JS ma sens
    note_kind(video_id, "dead");
    None
}

pub async fn resolve_with(
    video_id: &str,
    clients: &[Client],
    auth: Option<&Auth>,
) -> Option<(DirectAudio, Client)> {
    let visitor = visitor_data().await;
    for c in clients {
        if let Some(got) = client_once(video_id, *c, visitor.as_deref(), auth).await {
            return Some((got, *c));
        }
    }
    None
}

pub async fn url_reachable(url: &str, user_agent: &str) -> bool {
    for wait in [0u64, 700, 1800] {
        tokio::time::sleep(Duration::from_millis(wait)).await;
        match probe(url, user_agent, "bytes=0-98303").await {
            Some(true) => return true,
            Some(false) => continue,
            None => return false,
        }
    }
    false
}

// googlevideo oddaje pierwszy zakres nawet przy złym tokenie PO, a 403 przychodzi dopiero w środku utworu
async fn tail_reachable(url: &str, user_agent: &str) -> bool {
    let Some(len) = query_param(url, "clen")
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|l| *l > 400_000)
    else {
        return true;
    };
    let at = len * 6 / 10;
    probe(url, user_agent, &format!("bytes={at}-{}", at + 98_303)).await == Some(true)
}

async fn probe(url: &str, user_agent: &str, range: &str) -> Option<bool> {
    let http = client(user_agent, 8, false)?;
    let mut at = url.to_string();
    for _ in 0..4 {
        let r = http
            .get(&at)
            .header("Range", range)
            .header("Referer", "https://www.youtube.com/")
            .header("Origin", "https://www.youtube.com")
            .send()
            .await
            .ok()?;
        let code = r.status().as_u16();
        if code == 200 || code == 206 {
            return Some(true);
        }
        let next = r
            .headers()
            .get("location")
            .and_then(|l| l.to_str().ok())
            .map(String::from);
        match next {
            Some(n) if r.status().is_redirection() => at = n,
            _ if code == 403 => return Some(false),
            _ => {
                crate::diag::log(format!("[Zenith] stream probe http {code}"));
                return None;
            }
        }
    }
    None
}

// teledysk ma własny, mały budżet, żeby nigdy nie zjadał wywołań, których potrzebuje dźwięk tego samego utworu
const VIDEO_CALLS_PER_VIDEO: u32 = 3;
const VIDEO_CLIENTS: [Client; 3] = [Client::Visionos, Client::TvSamsung, Client::WebEmbedded];

fn video_calls() -> &'static Calls {
    static C: OnceLock<Calls> = OnceLock::new();
    C.get_or_init(Default::default)
}

// Err(true): film to nieruchoma okładka albo budżet się skończył, więc kolejny klient nic nie zmieni
async fn video_once(
    video_id: &str,
    client: Client,
    visitor: Option<&str>,
    max_h: u32,
    avc: bool,
) -> Result<DirectAudio, bool> {
    if bot_blocked() {
        return Err(true);
    }
    if !take_from(
        video_calls(),
        VIDEO_CALLS_PER_VIDEO,
        video_id,
        Instant::now(),
    ) {
        return Err(true);
    }
    let spec = spec(client);
    let player = if spec.needs_js {
        Some(crate::player_js::current().await.ok_or(false)?)
    } else {
        None
    };
    let sts = player.as_ref().and_then(|p| p.sts);
    let data = player_request(video_id, &spec, visitor, sts, None)
        .await
        .ok_or(false)?;
    if is_bot_check(&data) {
        mark_bot_blocked();
    }
    if failure_kind(&data) == "ratelimit" {
        mark_rate_limited(video_id);
    }
    if !playable(&data) {
        return Err(false);
    }
    if still_image_upload(&data) {
        return Err(true);
    }
    let ready_at = tokio::time::Instant::now() + preroll_wait(&data);
    for c in video_candidates(&data, max_h, avc).iter().take(2) {
        let Some(url) = finish_url(c, player.as_ref(), None).await else {
            continue;
        };
        tokio::time::sleep_until(ready_at).await;
        if url_reachable(&url, spec.user_agent).await && tail_reachable(&url, spec.user_agent).await
        {
            crate::diag::log(format!("[Zenith] video {} ok for {video_id}", spec.name));
            return Ok(DirectAudio {
                url,
                user_agent: spec.user_agent.to_string(),
            });
        }
    }
    Err(false)
}

/// Sam obraz teledysku (bez dźwięku) od klientów-gości: bez tokenu PO, ciasteczek i ukrytego okna.
pub async fn fetch_video(video_id: &str, max_h: u32, avc: bool) -> Option<DirectAudio> {
    if bot_blocked() {
        return None;
    }
    let visitor = visitor_data().await;
    for c in VIDEO_CLIENTS {
        match video_once(video_id, c, visitor.as_deref(), max_h, avc).await {
            Ok(got) => return Some(got),
            Err(true) => return None,
            Err(false) => {}
        }
    }
    None
}

pub async fn fetch_direct_audio(video_id: &str) -> Option<DirectAudio> {
    if bot_blocked() {
        crate::diag::log(format!(
            "[Zenith] innertube skipped for {} (bot check cooldown)",
            video_id
        ));
        return None;
    }
    let visitor = visitor_data().await;
    client_once(video_id, Client::Visionos, visitor.as_deref(), None).await
}

#[cfg(test)]
mod tests {
    use super::{is_bot_check, is_progressive_url, parse_visitor_data, pick_audio_url};

    #[tokio::test]
    #[ignore = "talks to youtube"]
    async fn live_native_layer() {
        let ids = [
            "kJQP7kiw5Fk",
            "9bZkp7q19f0",
            "OPf0YbXqDm0",
            "fJ9rUzIMcZQ",
            "60ItHLz5WEA",
        ];
        let mut ok = 0;
        for id in ids {
            let t = std::time::Instant::now();
            let got = super::fetch_direct_audio(id).await;
            println!(
                "native {id}: {} in {} ms",
                got.is_some(),
                t.elapsed().as_millis()
            );
            ok += got.is_some() as usize;
        }
        assert!(ok >= 4, "native layer {ok}/5");
    }

    #[tokio::test]
    #[ignore = "talks to youtube"]
    async fn live_video_formats() {
        use super::{video_candidates, Client};
        let visitor = super::visitor_data().await;
        for id in ["kJQP7kiw5Fk", "-4SQVBZNdEc", "9bZkp7q19f0", "khnokW3Mw24"] {
            for c in [Client::Visionos, Client::TvSamsung, Client::WebEmbedded] {
                let spec = super::spec(c);
                let player = if spec.needs_js {
                    crate::player_js::current().await
                } else {
                    None
                };
                let sts = player.as_ref().and_then(|p| p.sts);
                let Some(data) =
                    super::player_request(id, &spec, visitor.as_deref(), sts, None).await
                else {
                    println!("{id} {}: no response", spec.name);
                    continue;
                };
                let fmts = data
                    .pointer("/streamingData/adaptiveFormats")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let video: Vec<_> = fmts
                    .iter()
                    .filter(|f| f["mimeType"].as_str().unwrap_or("").starts_with("video/"))
                    .collect();
                let direct = video.iter().filter(|f| f.get("url").is_some()).count();
                let ciphered = video
                    .iter()
                    .filter(|f| f.get("signatureCipher").is_some())
                    .count();
                let picked = video_candidates(&data, 720, true);
                let mut reach = "-".to_string();
                if let Some(cand) = picked.first() {
                    reach = match super::finish_url(cand, player.as_ref(), None).await {
                        Some(u) => {
                            let itag = super::query_param(&u, "itag").unwrap_or_default();
                            let head = super::probe(&u, spec.user_agent, "bytes=0-98303").await;
                            let tail = super::tail_reachable(&u, spec.user_agent).await;
                            format!("itag {itag} head {head:?} tail {tail}")
                        }
                        None => "finish_url failed".into(),
                    };
                }
                println!(
                    "{id} {}: status {} still {} video {} direct {direct} cipher {ciphered} sabr {} picked {} -> {reach}",
                    spec.name,
                    data.pointer("/playabilityStatus/status").and_then(|v| v.as_str()).unwrap_or("?"),
                    super::still_image_upload(&data),
                    video.len(),
                    data.pointer("/streamingData/serverAbrStreamingUrl").is_some(),
                    picked.len(),
                );
            }
            let got = super::fetch_video(id, 720, true).await.map(|d| d.url);
            println!(
                "{id} fetch_video: {:?}",
                got.and_then(|u| super::query_param(&u, "itag"))
            );
        }
    }

    #[test]
    fn native_layer_needs_no_js_and_no_po_token() {
        let c = super::spec(super::Client::Visionos);
        assert_eq!(c.name, "VISIONOS");
        assert_eq!(c.client_id, 101);
        assert!(!c.needs_js && !c.needs_pot && !c.cookies);
    }

    #[test]
    fn web_clients_need_po_tokens_and_tv_does_not() {
        use super::{spec, Client};
        for c in [
            Client::Web,
            Client::Mweb,
            Client::WebMusic,
            Client::WebCreator,
        ] {
            assert!(spec(c).needs_pot, "{c:?}");
        }
        for c in [Client::TvSamsung, Client::WebEmbedded] {
            assert!(!spec(c).needs_pot && spec(c).needs_js, "{c:?}");
        }
        assert_eq!(spec(Client::WebMusic).host, "music.youtube.com");
    }

    #[test]
    fn body_carries_sts_and_embed_context() {
        use super::{request_body, spec, Client};
        let b = request_body(
            "dQw4w9WgXcQ",
            &spec(Client::WebEmbedded),
            Some("vd"),
            Some(20767),
        );
        assert_eq!(
            b.pointer("/playbackContext/contentPlaybackContext/signatureTimestamp"),
            Some(&json!(20767))
        );
        assert_eq!(
            b.pointer("/context/thirdParty/embedUrl"),
            Some(&json!("https://www.reddit.com/"))
        );
        assert_eq!(b.pointer("/context/client/visitorData"), Some(&json!("vd")));
        let v = request_body("dQw4w9WgXcQ", &spec(Client::Visionos), None, None);
        assert!(v
            .pointer("/playbackContext/contentPlaybackContext/signatureTimestamp")
            .is_none());
        assert_eq!(
            v.pointer("/context/client/deviceMake"),
            Some(&json!("Apple"))
        );
    }

    #[test]
    fn reads_embed_tokens_from_the_page() {
        let html = r#"x "embeddedPlayerEncryptedContext":"AAu-1_x","ancestorOriginsSupported":false "encryptedHostFlags":"AAuF" "a":"""#;
        assert_eq!(
            super::json_str_field(html, "embeddedPlayerEncryptedContext").as_deref(),
            Some("AAu-1_x")
        );
        assert_eq!(
            super::json_str_field(html, "encryptedHostFlags").as_deref(),
            Some("AAuF")
        );
        assert_eq!(super::json_str_field(html, "a"), None);
        assert_eq!(super::json_str_field(html, "nope"), None);
    }

    #[test]
    fn cipher_and_query_helpers() {
        let (u, s, sp) = super::parse_cipher("s=AB%3DC&sp=sig&url=https%3A%2F%2Fr1.googlevideo.com%2Fvideoplayback%3Fn%3Dxyz%26itag%3D251").unwrap();
        assert_eq!(s, "AB=C");
        assert_eq!(sp, "sig");
        assert_eq!(super::query_param(&u, "n").as_deref(), Some("xyz"));
        let u2 = super::set_param(&u, "n", "solved");
        assert_eq!(super::query_param(&u2, "n").as_deref(), Some("solved"));
        assert_eq!(super::query_param(&u2, "itag").as_deref(), Some("251"));
        let u3 = super::set_param(&u2, "sig", "a/b+c=");
        assert_eq!(super::query_param(&u3, "sig").as_deref(), Some("a/b+c="));
        assert!(super::parse_cipher("url=https%3A%2F%2Fx").is_none());
    }

    #[test]
    fn signed_in_needs_a_sapisid_cookie() {
        assert!(super::Auth::from_cookie_header("SAPISID=a; SID=b").is_some());
        assert!(super::Auth::from_cookie_header("__Secure-3PAPISID=a").is_some());
        assert!(super::Auth::from_cookie_header("NID=1").is_none());
        assert!(super::Auth::from_cookie_header("").is_none());
    }

    #[test]
    fn ciphered_formats_are_still_candidates() {
        let data = json!({
            "streamingData": {
                "adaptiveFormats": [
                    { "itag": 251, "mimeType": "audio/webm; codecs=\"opus\"", "signatureCipher": "s=QQ&sp=sig&url=https%3A%2F%2Fr1.googlevideo.com%2Fvideoplayback%3Fitag%3D251" },
                    { "itag": 18, "mimeType": "video/mp4; codecs=\"avc1, mp4a.40.2\"", "url": "https://r1.googlevideo.com/videoplayback?itag=18" }
                ]
            }
        });
        let c = super::candidates(&data);
        assert_eq!(c.len(), 2);
        assert!(c[0].sig.is_some(), "audio-only first even with a cipher");
        assert!(c[1].url.contains("itag=18"));
    }

    #[test]
    fn parses_visitor_data() {
        let body = r#")]}'
[[null,null,[[[null,null,null,null,null,null,null,null,null,null,null,null,null,"CgtBQkNERUZHSElKSyiAgICA"]]]]]"#;
        assert_eq!(
            parse_visitor_data(body).as_deref(),
            Some("CgtBQkNERUZHSElKSyiAgICA")
        );
        assert_eq!(parse_visitor_data("garbage"), None);
    }

    #[test]
    fn detects_bot_check() {
        let d = json!({"playabilityStatus": {"status": "LOGIN_REQUIRED", "reason": "Sign in to confirm you are not a bot"}});
        assert!(is_bot_check(&d));
        let d = json!({"playabilityStatus": {"status": "LOGIN_REQUIRED", "reason": "This video is private"}});
        assert!(!is_bot_check(&d));
        let d = json!({"playabilityStatus": {"status": "LOGIN_REQUIRED", "reason": "Sign in to confirm your age"}});
        assert!(
            !is_bot_check(&d),
            "age gate must not start the bot cooldown"
        );
        let d = json!({"playabilityStatus": {"status": "LOGIN_REQUIRED", "reason": "Sign in to confirm you’re not a bot"}});
        assert!(is_bot_check(&d));
    }

    #[test]
    fn classifies_why_a_video_does_not_play() {
        use super::{failure_kind, is_age_gated};
        let ps = |status: &str, reason: &str| json!({"playabilityStatus": {"status": status, "reason": reason}});
        for d in [
            ps("LOGIN_REQUIRED", "Sign in to confirm your age"),
            ps("UNPLAYABLE", "Sorry, this content is age-restricted"),
            ps(
                "LOGIN_REQUIRED",
                "This video may be inappropriate for some users.",
            ),
            ps("AGE_VERIFICATION_REQUIRED", ""),
            json!({"playabilityStatus": {"status": "OK", "desktopLegacyAgeGateReason": 1}}),
        ] {
            assert!(is_age_gated(&d), "{d}");
            assert_eq!(failure_kind(&d), "age");
        }
        assert!(!is_age_gated(&ps("OK", "")));
        assert_eq!(
            failure_kind(&ps("LOGIN_REQUIRED", "Sign in to confirm you’re not a bot")),
            "bot"
        );
        assert_eq!(
            failure_kind(&ps(
                "UNPLAYABLE",
                "The uploader has not made this video available in your country"
            )),
            "region"
        );
        assert_eq!(
            failure_kind(&ps("ERROR", "This video is unavailable")),
            "gone"
        );
        assert_eq!(
            failure_kind(&ps("LOGIN_REQUIRED", "This video is private")),
            "gone"
        );
        assert_eq!(
            failure_kind(&ps("UNPLAYABLE", "This video is not available")),
            "blocked"
        );
        assert_eq!(
            failure_kind(&ps(
                "ERROR",
                "This content isn't available, try again later."
            )),
            "ratelimit"
        );
    }

    #[test]
    fn each_video_gets_a_bounded_number_of_player_calls() {
        use super::{calls_done, take_call, CALLS_PER_VIDEO, CALLS_WINDOW};
        let t0 = std::time::Instant::now();
        let id = "budget00001";
        calls_done(id);
        for _ in 0..CALLS_PER_VIDEO {
            assert!(take_call(id, t0));
        }
        assert!(!take_call(id, t0), "13th call must be refused");
        assert!(
            take_call("budget00002", t0),
            "other videos keep their own budget"
        );
        assert!(
            take_call(id, t0 + CALLS_WINDOW),
            "budget comes back after the window"
        );
        calls_done(id);
        calls_done("budget00002");
    }

    #[test]
    fn the_surest_reason_wins_per_video() {
        use super::{failure_of, forget_failure, note_kind};
        let id = "kindtest001";
        forget_failure(id);
        note_kind(id, "gone");
        note_kind(id, "blocked");
        note_kind(id, "age");
        note_kind(id, "bot");
        assert_eq!(failure_of(id), Some("age"));
        note_kind(id, "dead");
        assert_eq!(failure_of(id), Some("dead"));
        note_kind(id, "sabr");
        assert_eq!(failure_of(id), Some("dead"));
        note_kind(id, "ratelimit");
        assert_eq!(
            failure_of(id),
            Some("ratelimit"),
            "a limit stops everything"
        );
        assert_eq!(failure_of("kindtest002"), None);
        forget_failure(id);
        assert_eq!(failure_of(id), None);
    }

    #[test]
    fn waits_for_the_preroll_ad_only_before_content() {
        use std::time::Duration;
        let ad = |kind: &str, skip: Option<u64>| {
            let mut r = json!({"playerVars": "length_seconds=15&x=1"});
            if let Some(s) = skip {
                r["skipOffsetMilliseconds"] = json!(s);
            }
            json!({"adPlacementRenderer": {"config": {"adPlacementConfig": {"kind": kind}},
                "renderer": {"instreamVideoAdRenderer": r}}})
        };
        let d = json!({"adPlacements": [ad("AD_PLACEMENT_KIND_START", Some(6000)), ad("AD_PLACEMENT_KIND_END", None)]});
        assert_eq!(super::preroll_wait(&d), Duration::from_millis(6000));
        let d = json!({"adPlacements": [ad("AD_PLACEMENT_KIND_START", None)]});
        assert_eq!(super::preroll_wait(&d), Duration::from_secs(15));
        let slot = json!({"adSlots": [{"adSlotRenderer": {"adSlotMetadata": {"triggerEvent": "SLOT_TRIGGER_EVENT_BEFORE_CONTENT"},
            "fulfillmentContent": {"x": [{"instreamVideoAdRenderer": {"skipOffsetMilliseconds": 5000}}, {"instreamVideoAdRenderer": {"skipOffsetMilliseconds": 20000}}]}}}]});
        assert_eq!(
            super::preroll_wait(&slot),
            Duration::from_secs(15),
            "capped"
        );
        assert_eq!(super::preroll_wait(&json!({})), Duration::ZERO);
    }

    #[test]
    fn drm_formats_are_never_candidates() {
        let data = json!({"streamingData": {"adaptiveFormats": [
            { "itag": 251, "mimeType": "audio/webm; codecs=\"opus\"", "url": "https://g.example/drm", "drmFamilies": ["WIDEVINE"] },
            { "itag": 140, "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "url": "https://g.example/m4a" }
        ]}});
        let c = super::candidates(&data);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].url, "https://g.example/m4a");
    }

    fn video_fixture() -> serde_json::Value {
        let v = |itag: u32, codec: &str, h: u32, fps: u32, extra: serde_json::Value| {
            let mime = if codec.starts_with("avc1") {
                "video/mp4"
            } else {
                "video/webm"
            };
            let mut f = json!({
                "itag": itag, "mimeType": format!("{mime}; codecs=\"{codec}\""),
                "height": h, "width": h * 16 / 9, "fps": fps, "bitrate": itag * 1000,
                "url": format!("https://r1.googlevideo.com/videoplayback?itag={itag}"),
            });
            for (k, x) in extra.as_object().cloned().unwrap_or_default() {
                f[k] = x;
            }
            f
        };
        let none = json!({});
        json!({"streamingData": {
            "formats": [{ "itag": 18, "mimeType": "video/mp4; codecs=\"avc1.42001E, mp4a.40.2\"", "height": 360, "url": "https://r1.googlevideo.com/videoplayback?itag=18" }],
            "adaptiveFormats": [
                v(137, "avc1.640028", 1080, 30, none.clone()),
                v(298, "avc1.4d4020", 720, 60, none.clone()),
                v(136, "avc1.4d401f", 720, 30, none.clone()),
                v(135, "avc1.4d401e", 480, 30, none.clone()),
                v(247, "vp9", 720, 30, none.clone()),
                v(302, "vp9", 720, 60, none.clone()),
                v(244, "vp9", 480, 30, none.clone()),
                v(398, "av01.0.05M.08", 720, 30, none.clone()),
                v(400, "vp9", 720, 30, json!({ "drmFamilies": ["WIDEVINE"] })),
                v(401, "vp9", 720, 30, json!({ "type": "FORMAT_STREAM_TYPE_OTF" })),
                v(402, "vp9", 720, 30, json!({ "url": "https://manifest.googlevideo.com/api/manifest/hls_playlist/x.m3u8" })),
                v(403, "vp9", 720, 30, json!({ "url": "https://r1.googlevideo.com/sabr/x" })),
                { "itag": 251, "mimeType": "audio/webm; codecs=\"opus\"", "bitrate": 1, "url": "https://r1.googlevideo.com/videoplayback?itag=251" }
            ]
        }})
    }

    #[test]
    fn video_picker_prefers_avc1_up_to_max_height() {
        let itags = |max_h, avc| -> Vec<String> {
            super::video_candidates(&video_fixture(), max_h, avc)
                .iter()
                .map(|c| super::query_param(&c.url, "itag").unwrap_or_default())
                .collect()
        };
        assert_eq!(
            itags(720, true),
            ["136", "298", "135", "247", "302", "244"],
            "avc1 first, 30 fps beats 60 fps, nothing above 720"
        );
        assert_eq!(itags(720, false), ["247", "302", "244"], "vp9 only");
        assert_eq!(itags(480, true), ["135", "244"]);
        assert_eq!(itags(1080, true)[0], "137");
        assert!(itags(144, true).is_empty());
    }

    #[test]
    fn video_picker_keeps_the_cipher() {
        let data = json!({"streamingData": {"adaptiveFormats": [
            { "itag": 136, "mimeType": "video/mp4; codecs=\"avc1.4d401f\"", "height": 720, "fps": 25,
              "signatureCipher": "s=QQ&sp=sig&url=https%3A%2F%2Fr1.googlevideo.com%2Fvideoplayback%3Fitag%3D136" },
            { "itag": 247, "mimeType": "video/webm; codecs=\"vp9\"", "height": 720, "signatureCipher": "url=https%3A%2F%2Fx" }
        ]}});
        let c = super::video_candidates(&data, 720, true);
        assert_eq!(c.len(), 1, "a cipher without s is dropped");
        assert_eq!(c[0].sig, Some(("QQ".into(), "sig".into())));
    }

    #[test]
    fn still_image_uploads_get_no_video() {
        let t = |d: serde_json::Value| super::still_image_upload(&d);
        assert!(t(
            json!({"videoDetails": {"musicVideoType": "MUSIC_VIDEO_TYPE_ATV"}})
        ));
        assert!(t(json!({"videoDetails": {"author": "Daft Punk - Topic"}})));
        assert!(!t(
            json!({"videoDetails": {"musicVideoType": "MUSIC_VIDEO_TYPE_OMV", "author": "officialpsy"}})
        ));
        assert!(!t(json!({"videoDetails": {"author": "Topic Talks"}})));
        assert!(!t(json!({})));
    }

    #[test]
    fn video_budget_is_separate_from_audio() {
        let now = std::time::Instant::now();
        let id = "vbudget0001";
        for _ in 0..super::VIDEO_CALLS_PER_VIDEO {
            assert!(super::take_from(
                super::video_calls(),
                super::VIDEO_CALLS_PER_VIDEO,
                id,
                now
            ));
        }
        assert!(!super::take_from(
            super::video_calls(),
            super::VIDEO_CALLS_PER_VIDEO,
            id,
            now
        ));
        assert!(super::take_call(id, now), "audio budget untouched");
        super::calls_done(id);
    }
    use serde_json::json;

    #[test]
    fn rejects_hls() {
        assert!(!is_progressive_url(
            "https://manifest.googlevideo.com/api/manifest/hls_playlist/foo.m3u8"
        ));
        assert!(is_progressive_url(
            "https://rr1---sn-abc.googlevideo.com/videoplayback?id=x"
        ));
    }

    #[test]
    fn prefers_m4a() {
        let data = json!({
            "streamingData": {
                "adaptiveFormats": [
                    { "itag": 251, "mimeType": "audio/webm; codecs=\"opus\"", "url": "https://g.example/opus" },
                    { "itag": 140, "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "url": "https://g.example/m4a" }
                ]
            }
        });
        let picked = pick_audio_url(&data).as_deref().map(str::to_string);
        if crate::native_audio::available() {
            assert_eq!(picked.as_deref(), Some("https://g.example/opus"));
        } else {
            assert_eq!(picked.as_deref(), Some("https://g.example/m4a"));
        }
    }

    #[test]
    fn skips_muxed_when_opus_exists() {
        let data = json!({
            "streamingData": {
                "adaptiveFormats": [
                    { "itag": 251, "mimeType": "audio/webm; codecs=\"opus\"", "url": "https://g.example/opus" }
                ],
                "formats": [
                    { "itag": 18, "mimeType": "video/mp4; codecs=\"avc1.42001E, mp4a.40.2\"", "url": "https://g.example/mux" }
                ]
            }
        });
        assert_eq!(
            pick_audio_url(&data).as_deref(),
            Some("https://g.example/opus")
        );
    }
}

#[cfg(test)]
mod live_tests {
    #[tokio::test]
    #[ignore]
    async fn innertube_timing() {
        for id in [
            "dQw4w9WgXcQ",
            "kJQP7kiw5Fk",
            "9bZkp7q19f0",
            "OPf0YbXqDm0",
            "fJ9rUzIMcZQ",
        ] {
            let t = std::time::Instant::now();
            let got = super::fetch_direct_audio(id).await;
            println!(
                "innertube {id}: {:.2}s ok={}",
                t.elapsed().as_secs_f64(),
                got.is_some()
            );
        }
    }
}

#[cfg(test)]
mod chain_live {
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "talks to youtube"]
    async fn every_layer_on_real_tracks() {
        crate::player_js::init(std::env::temp_dir().join("zenith-live-player"));
        let ids = [
            "kJQP7kiw5Fk",
            "9bZkp7q19f0",
            "OPf0YbXqDm0",
            "fJ9rUzIMcZQ",
            "60ItHLz5WEA",
            "JGwWNGJdvx8",
            "hT_nvWreIhg",
            "YQHsXMglC9A",
            "RgKAFK5djSk",
            "CevxZvSJLk8",
        ];
        let mut hits = std::collections::HashMap::new();
        for id in ids {
            for c in [
                super::Client::Visionos,
                super::Client::WebEmbedded,
                super::Client::TvSamsung,
            ] {
                let t = std::time::Instant::now();
                let got = super::resolve_with(id, &[c], None).await;
                let itag = got
                    .as_ref()
                    .and_then(|(g, _)| super::query_param(&g.url, "itag"));
                println!(
                    "{id} {c:?}: {:?} itag={itag:?} {} ms",
                    got.is_some(),
                    t.elapsed().as_millis()
                );
                if got.is_some() {
                    *hits.entry(format!("{c:?}")).or_insert(0) += 1;
                }
            }
        }
        println!("{hits:?}");
    }

    // lista filmów z ZENITH_IDS, bo korpus testowy zmienia się z każdą zmianą po stronie YouTube
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "talks to youtube"]
    async fn guest_corpus() {
        crate::player_js::init(std::env::temp_dir().join("zenith-live-player"));
        let ids = std::env::var("ZENITH_IDS").unwrap_or_default();
        let only = std::env::var("ZENITH_CLIENT")
            .ok()
            .and_then(|s| crate::resolve_plan::by_name(&s));
        let (mut ok, mut n, all) = (0, 0, std::time::Instant::now());
        for id in ids.split(',').filter(|s| s.len() == 11) {
            let t = std::time::Instant::now();
            let mut how = "none".to_string();
            if let Some(c) = only {
                if let Some((g, _)) = super::resolve_with(id, &[c], None).await {
                    how = format!("{c:?} itag={:?}", super::query_param(&g.url, "itag"));
                }
            } else if let Some(g) = super::fetch_direct_audio(id).await {
                how = format!("visionos itag={:?}", super::query_param(&g.url, "itag"));
            } else if let Some((g, c)) =
                super::resolve_with(id, crate::resolve_plan::GUEST_JS, None).await
            {
                how = format!("{c:?} itag={:?}", super::query_param(&g.url, "itag"));
            }
            n += 1;
            ok += (how != "none") as usize;
            println!(
                "{id} {how} {} ms bot_cooldown={}",
                t.elapsed().as_millis(),
                super::bot_blocked()
            );
        }
        println!("guest ok {ok}/{n} in {} s", all.elapsed().as_secs());
    }
}
