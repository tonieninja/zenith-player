//! innertube /player, steal a direct audio url without yt-dlp when youtube
//! still hands out progressive googlevideo links (android_vr / embedded / tv)
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const ANDROID_KEY: &str = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vfUWA0yam";
const PLAYER_URL: &str = "https://www.youtube.com/youtubei/v1/player";

const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// visitorData ties anonymous requests to one "visitor" like a real client does; youtube
/// bot-checks requests without it sooner. cached for a few hours.
const VISITOR_TTL: Duration = Duration::from_secs(6 * 3600);
/// after "Sign in to confirm you're not a bot" this IP is flagged for a while: skip the
/// innertube clients (each costs a round trip) and go straight to the yt-dlp last resort
const BOT_COOLDOWN: Duration = Duration::from_secs(10 * 60);

static VISITOR: Mutex<Option<(String, Instant)>> = Mutex::new(None);
static BOT_BLOCKED_AT: Mutex<Option<Instant>> = Mutex::new(None);

fn parse_visitor_data(body: &str) -> Option<String> {
    // sw.js_data is ")]}'" + json; visitorData lives at [0][2][0][0][13]
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

fn mark_bot_blocked() {
    if let Ok(mut g) = BOT_BLOCKED_AT.lock() {
        *g = Some(Instant::now());
    }
    // a flagged visitor id only keeps the flag, fetch a new one next time
    if let Ok(mut g) = VISITOR.lock() {
        *g = None;
    }
}

#[derive(Clone, Debug)]
pub struct DirectAudio {
    pub url: String,
    pub user_agent: String,
}

struct ClientSpec {
    name: &'static str,
    version: &'static str,
    client_id: i32,
    user_agent: &'static str,
    extra: Value,
}

fn clients() -> Vec<ClientSpec> {
    // only clients that (today) dont need a gvs po token
    // ios/android/mweb spit urls that 403 without one
    vec![
        ClientSpec {
            name: "ANDROID_VR",
            version: "1.62.27",
            client_id: 28,
            user_agent: "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
            extra: json!({
                "deviceMake": "Oculus",
                "deviceModel": "Quest 3",
                "androidSdkVersion": 32,
                "osName": "Android",
                "osVersion": "12L",
            }),
        },
        ClientSpec {
            name: "WEB_EMBEDDED_PLAYER",
            version: "1.20250310.01.00",
            client_id: 56,
            user_agent: CHROME_UA,
            extra: json!({}),
        },
    ]
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
    // the native (gstreamer) engine decodes opus with libopus; aac would pull the whole
    // libav/ffmpeg stack (+~10MB resident in the main process) into the engine
    if crate::native_audio::available() {
        match itag {
            251 => return 120,
            250 => return 115,
            249 => return 112,
            _ => {}
        }
    }
    match itag {
        141 => 110, // m4a 256
        140 => 100, // m4a 128, html audio actually likes this one
        // ten itag webview2 zyje z nim w zgodzie, reszta to loteria
        251 => 90, // webm opus 160
        250 => 80,
        249 => 70,
        139 => 60,
        18 => 50, // muxed mp4
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

fn pick_audio_url(data: &Value) -> Option<String> {
    let mut formats: Vec<&Value> = Vec::new();
    if let Some(arr) = data
        .pointer("/streamingData/adaptiveFormats")
        .and_then(|v| v.as_array())
    {
        formats.extend(arr);
    }
    if let Some(arr) = data
        .pointer("/streamingData/formats")
        .and_then(|v| v.as_array())
    {
        formats.extend(arr);
    }

    let mut best: Option<(i32, String)> = None;
    for fmt in formats {
        let url = match fmt.get("url").and_then(|v| v.as_str()) {
            Some(u) if is_progressive_url(u) => u.to_string(),
            _ => continue,
        };
        // signatureCipher-only rows have no url, already skipped above
        let score = format_score(fmt);
        if score <= 0 {
            continue;
        }
        if best.as_ref().map(|(s, _)| *s).unwrap_or(0) < score {
            best = Some((score, url));
        }
    }
    best.map(|(_, u)| u)
}

fn playable(data: &Value) -> bool {
    let status = data
        .pointer("/playabilityStatus/status")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    status.is_empty() || status.eq_ignore_ascii_case("ok")
}

async fn player_once(
    video_id: &str,
    spec: &ClientSpec,
    visitor: Option<&str>,
) -> Option<DirectAudio> {
    let mut client_obj = json!({
        "clientName": spec.name,
        "clientVersion": spec.version,
        "hl": "en",
        "gl": "US",
        "userAgent": spec.user_agent,
    });
    if let Some(map) = spec.extra.as_object() {
        if let Some(dst) = client_obj.as_object_mut() {
            for (k, v) in map {
                dst.insert(k.clone(), v.clone());
            }
        }
    }

    if let (Some(vd), Some(dst)) = (visitor, client_obj.as_object_mut()) {
        dst.insert("visitorData".into(), Value::String(vd.to_string()));
    }

    let body = json!({
        "context": { "client": client_obj },
        "videoId": video_id,
        "contentCheckOk": true,
        "racyCheckOk": true,
        "playbackContext": {
            "contentPlaybackContext": {
                "html5Preference": "HTML5_PREF_WANTS",
            }
        }
    });

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(spec.user_agent)
        .build()
        .ok()?;

    let url = format!("{PLAYER_URL}?prettyPrint=false&key={ANDROID_KEY}");
    let mut req = http
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Origin", "https://www.youtube.com")
        .header("X-YouTube-Client-Name", spec.client_id.to_string())
        .header("X-YouTube-Client-Version", spec.version);
    if let Some(vd) = visitor {
        req = req.header("X-Goog-Visitor-Id", vd);
    }
    let res = req.json(&body).send().await.ok()?;

    if !res.status().is_success() {
        return None;
    }
    let data: Value = res.json().await.ok()?;
    let status = data
        .pointer("/playabilityStatus/status")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    if is_bot_check(&data) {
        mark_bot_blocked();
    }
    if !playable(&data) {
        eprintln!("[Zenith] innertube {} {} → {}", spec.name, video_id, status);
        return None;
    }
    let audio = match pick_audio_url(&data) {
        Some(u) => u,
        None => {
            eprintln!(
                "[Zenith] innertube {} {} playable but no progressive audio",
                spec.name, video_id
            );
            return None;
        }
    };
    Some(DirectAudio {
        url: audio,
        user_agent: spec.user_agent.to_string(),
    })
}

/// poke googlevideo so we dont hand the ui a 403 url
pub async fn url_reachable(url: &str, user_agent: &str) -> bool {
    let Ok(http) = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(user_agent)
        .build()
    else {
        return false;
    };
    let res = http
        .get(url)
        .header("Range", "bytes=0-98303")
        .header("Referer", "https://www.youtube.com/")
        .header("Origin", "https://www.youtube.com")
        .send()
        .await;
    match res {
        Ok(r) => {
            let code = r.status().as_u16();
            code == 200 || code == 206
        }
        Err(_) => false,
    }
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
    for spec in clients() {
        if bot_blocked() {
            break;
        }
        match player_once(video_id, &spec, visitor.as_deref()).await {
            Some(got) => {
                if url_reachable(&got.url, &got.user_agent).await {
                    eprintln!("[Zenith] innertube {} ok for {}", spec.name, video_id);
                    return Some(got);
                }
                eprintln!(
                    "[Zenith] innertube {} url dead (403?) for {}",
                    spec.name, video_id
                );
            }
            None => {
                eprintln!("[Zenith] innertube {} miss for {}", spec.name, video_id);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{is_bot_check, is_progressive_url, parse_visitor_data, pick_audio_url};

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
        assert_eq!(
            pick_audio_url(&data).as_deref(),
            Some("https://g.example/m4a")
        );
    }
}

/// live timing check, needs network: `cargo test --lib innertube_timing -- --ignored --nocapture`
#[cfg(test)]
mod live_tests {
    #[tokio::test]
    #[ignore]
    async fn innertube_timing() {
        for id in ["dQw4w9WgXcQ", "kJQP7kiw5Fk", "fJ9rUzIMcZQ"] {
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
