use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const ANDROID_KEY: &str = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vfUWA0yam";
const PLAYER_URL: &str = "https://www.youtube.com/youtubei/v1/player";

const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const VISIONOS_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

const VISITOR_TTL: Duration = Duration::from_secs(6 * 3600);
const BOT_COOLDOWN: Duration = Duration::from_secs(10 * 60);

static VISITOR: Mutex<Option<(String, Instant)>> = Mutex::new(None);
static BOT_BLOCKED_AT: Mutex<Option<Instant>> = Mutex::new(None);

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
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .user_agent(CHROME_UA)
        .build()
        .ok()?;
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

fn is_bot_check(data: &Value) -> bool {
    let status = data
        .pointer("/playabilityStatus/status")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let reason = data
        .pointer("/playabilityStatus/reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    status == "LOGIN_REQUIRED" && (reason.contains("bot") || reason.contains("confirm"))
}

pub fn bot_blocked() -> bool {
    BOT_BLOCKED_AT
        .lock()
        .ok()
        .and_then(|g| *g)
        .map(|at| at.elapsed() < BOT_COOLDOWN)
        .unwrap_or(false)
}

pub fn fresh_start() {
    if let Ok(mut g) = BOT_BLOCKED_AT.lock() {
        *g = None;
    }
    if let Ok(mut g) = VISITOR.lock() {
        *g = None;
    }
}

fn mark_bot_blocked() {
    if let Ok(mut g) = BOT_BLOCKED_AT.lock() {
        *g = Some(Instant::now());
    }
    if let Ok(mut g) = VISITOR.lock() {
        *g = None;
    }
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
    Tv,
    TvDowngraded,
    WebEmbedded,
    WebSafari,
    Web,
    Mweb,
    WebMusic,
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
const COBALT_UA: &str = "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)";
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
        Client::Tv => base("TVHTML5", "7.20260707.07.00", 7, COBALT_UA),
        Client::TvDowngraded => base(
            "TVHTML5",
            "5.20260707",
            7,
            "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
        ),
        Client::WebEmbedded => base("WEB_EMBEDDED_PLAYER", "2.20260708.00.00", 56, SAFARI_UA),
        Client::WebSafari => ClientSpec {
            needs_pot: true,
            ..base("WEB", "2.20260708.00.00", 1, SAFARI_UA)
        },
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
            if audio_only != is_audio_only_fmt(fmt) {
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

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(user_agent)
        .build()
        .ok()?;
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
