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
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(spec.user_agent)
        .build()
        .ok()?;
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
        eprintln!(
            "[Zenith] innertube {} {} http {}",
            spec.name,
            video_id,
            res.status().as_u16()
        );
        return None;
    }
    res.json().await.ok()
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
                eprintln!("[Zenith] js challenge failed: {e}");
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
    let player = if spec.needs_js {
        Some(crate::player_js::current().await?)
    } else {
        None
    };
    let pot = if spec.needs_pot {
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
    let status = data
        .pointer("/playabilityStatus/status")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    if is_bot_check(&data) && auth.is_none() && client == Client::Visionos {
        mark_bot_blocked();
    }
    if !playable(&data) {
        let why = data
            .pointer("/playabilityStatus/errorCode")
            .or_else(|| data.pointer("/playabilityStatus/reason"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        eprintln!(
            "[Zenith] innertube {} {} → {} {}",
            spec.name, video_id, status, why
        );
        return None;
    }
    let list = candidates(&data);
    if list.is_empty() {
        eprintln!(
            "[Zenith] innertube {} {} playable but no progressive audio",
            spec.name, video_id
        );
        return None;
    }
    for c in list.iter().take(3) {
        let Some(url) = finish_url(c, player.as_ref(), pot.as_deref()).await else {
            continue;
        };
        if url_reachable(&url, spec.user_agent).await {
            eprintln!("[Zenith] innertube {} ok for {}", spec.name, video_id);
            return Some(DirectAudio {
                url,
                user_agent: spec.user_agent.to_string(),
            });
        }
        eprintln!(
            "[Zenith] innertube {} url dead (403?) for {}",
            spec.name, video_id
        );
    }
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
        match probe(url, user_agent).await {
            Some(true) => return true,
            Some(false) => continue,
            None => return false,
        }
    }
    false
}

async fn probe(url: &str, user_agent: &str) -> Option<bool> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(user_agent)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let mut at = url.to_string();
    for _ in 0..4 {
        let r = http
            .get(&at)
            .header("Range", "bytes=0-98303")
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
                eprintln!("[Zenith] stream probe http {code}");
                return None;
            }
        }
    }
    None
}

pub async fn fetch_direct_audio(video_id: &str) -> Option<DirectAudio> {
    if bot_blocked() {
        eprintln!(
            "[Zenith] innertube skipped for {} (bot check cooldown)",
            video_id
        );
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
            Client::WebSafari,
            Client::Mweb,
            Client::WebMusic,
        ] {
            assert!(spec(c).needs_pot, "{c:?}");
        }
        for c in [
            Client::Tv,
            Client::TvSamsung,
            Client::WebEmbedded,
            Client::TvDowngraded,
        ] {
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
}
