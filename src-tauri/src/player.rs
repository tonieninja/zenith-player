//! innertube /player, steal a direct audio url without yt-dlp when youtube
//! still hands out progressive googlevideo links (android_vr / embedded / tv)
use serde_json::{json, Value};
use std::time::Duration;

const ANDROID_KEY: &str = "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vfUWA0yam";
const PLAYER_URL: &str = "https://www.youtube.com/youtubei/v1/player";

const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

async fn player_once(video_id: &str, spec: &ClientSpec) -> Option<DirectAudio> {
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
    let res = http
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Origin", "https://www.youtube.com")
        .header("X-YouTube-Client-Name", spec.client_id.to_string())
        .header("X-YouTube-Client-Version", spec.version)
        .json(&body)
        .send()
        .await
        .ok()?;

    if !res.status().is_success() {
        return None;
    }
    let data: Value = res.json().await.ok()?;
    let status = data
        .pointer("/playabilityStatus/status")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
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
    for spec in clients() {
        match player_once(video_id, &spec).await {
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
    use super::{is_progressive_url, pick_audio_url};
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
