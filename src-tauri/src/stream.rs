use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{command, AppHandle, Manager};

use crate::player;
use crate::stream_proxy;
use crate::ytdlp;
use crate::ytm_api;

static STREAM_CACHE: OnceLock<Mutex<HashMap<String, (String, String, u64)>>> = OnceLock::new();

fn get_cache() -> &'static Mutex<HashMap<String, (String, String, u64)>> {
    STREAM_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn validate_video_id(video_id: &str) -> Result<(), String> {
    if video_id.len() == 11
        && video_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Ok(())
    } else {
        Err("invalid video id".into())
    }
}

fn pick_stream_url(stdout: &str) -> Option<String> {
    let urls: Vec<&str> = stdout
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("http://") || line.starts_with("https://"))
        .collect();
    urls.iter()
        .copied()
        .find(|u| {
            let l = u.to_ascii_lowercase();
            l.contains("mime=audio")
                || l.contains("itag=140")
                || l.contains("itag=251")
                || l.contains("itag=139")
        })
        .or_else(|| urls.first().copied())
        .map(|s| s.to_string())
}

fn fetch_stream_url_sync(
    ytdlp_bin: &std::path::Path,
    video_id: &str,
    cookie_file: Option<&Path>,
    cache_dir: Option<&Path>,
) -> Result<Option<String>, String> {
    let page = format!("https://music.youtube.com/watch?v={}", video_id);
    let format = "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[ext=mp4]/best";
    let extractor = "youtube:player_client=default,android_vr,web_embedded,tv";

    let mut args: Vec<String> = vec![
        "-f".into(),
        format.into(),
        "--extractor-args".into(),
        extractor.into(),
        "--socket-timeout".into(),
        "10".into(),
        "--retries".into(),
        "1".into(),
        "--no-playlist".into(),
        "--ignore-config".into(),
        "--no-warnings".into(),
        "-g".into(),
    ];
    if let Some(cache) = cache_dir {
        args.push("--cache-dir".into());
        args.push(cache.display().to_string());
    }
    if let Some(cookies) = cookie_file {
        args.push("--cookies".into());
        args.push(cookies.display().to_string());
    }
    if let Some(node) = ytdlp::node_executable() {
        args.push("--js-runtimes".into());
        args.push(format!("node:{}", node.display()));
    }
    args.push(page);

    let mut cmd = Command::new(ytdlp_bin);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("yt-dlp spawn failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Some(url) = pick_stream_url(&stdout) {
        return Ok(Some(url));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!("[Zenith] yt-dlp error ({}): {}", video_id, stderr.trim());
    Ok(None)
}

const YTDLP_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

fn write_netscape_cookies(header: &str, dest: &Path) -> Result<(), String> {
    if header.trim().is_empty() {
        return Err("empty cookies".into());
    }
    let mut out = String::from("# Netscape HTTP Cookie File\n");
    for part in header.split(';') {
        let part = part.trim();
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        let name = name.trim();
        let value = value.trim();
        if name.is_empty() || value.is_empty() {
            continue;
        }
        let secure =
            name.starts_with("__Secure-") || name.starts_with("__Host-") || name == "SAPISID";
        let flag = "TRUE";
        let sec = if secure { "TRUE" } else { "FALSE" };
        for domain in [".youtube.com", ".google.com"] {
            out.push_str(&format!(
                "{domain}\t{flag}\t/\t{sec}\t2147483647\t{name}\t{value}\n"
            ));
        }
    }
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut f = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    f.write_all(out.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

fn cookie_file_for(app: &AppHandle) -> Option<std::path::PathBuf> {
    let header = ytm_api::resolve_cookies_public(app);
    if header.is_empty() {
        return None;
    }
    let path = app
        .path()
        .app_local_data_dir()
        .ok()?
        .join("bin")
        .join("youtube-cookies.txt");
    write_netscape_cookies(&header, &path).ok()?;
    Some(path)
}

pub fn evict_cached_url(video_id: &str) {
    if let Ok(mut cache) = get_cache().lock() {
        cache.remove(video_id);
    }
    stream_proxy::remove_direct_url(video_id);
}

pub fn wipe_netscape_cookie_file(app: &AppHandle) {
    if let Ok(dir) = app.path().app_local_data_dir() {
        let path = dir.join("bin").join("youtube-cookies.txt");
        let _ = std::fs::remove_file(path);
    }
}

fn remember_and_proxy(
    video_id: &str,
    url: &str,
    user_agent: &str,
    now: u64,
) -> Result<String, String> {
    let mut cache = get_cache()
        .lock()
        .map_err(|e| format!("Cache lock error: {}", e))?;
    if let Some((_, _, ts)) = cache.get(video_id) {
        if *ts > now {
            if let Some(proxy) = stream_proxy::proxy_url(video_id) {
                return Ok(proxy);
            }
        }
    }
    stream_proxy::store_upstream(
        video_id,
        stream_proxy::Upstream {
            url: url.to_string(),
            user_agent: user_agent.to_string(),
        },
    );
    cache.insert(
        video_id.to_string(),
        (url.to_string(), user_agent.to_string(), now),
    );
    while cache.len() > 24 {
        let oldest = cache
            .iter()
            .min_by_key(|(_, (_, _, ts))| *ts)
            .map(|(k, _)| k.clone());
        if let Some(k) = oldest {
            stream_proxy::remove_direct_url(&k);
            cache.remove(&k);
        } else {
            break;
        }
    }
    drop(cache);
    stream_proxy::proxy_url(video_id).ok_or_else(|| "stream proxy not ready".to_string())
}

#[derive(Serialize)]
pub struct YtdlpTrack {
    id: String,
    title: String,
    artist: String,
    cover: String,
    cover_small: String,
    cover_large: String,
}

#[command]
pub async fn get_stream_url(
    app: AppHandle,
    video_id: String,
    fresh: Option<bool>,
) -> Result<Option<String>, String> {
    validate_video_id(&video_id)?;
    stream_proxy::ensure_ready().await?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let force = fresh.unwrap_or(false);
    if force {
        evict_cached_url(&video_id);
    }

    if !force {
        let cache = get_cache()
            .lock()
            .map_err(|e| format!("Cache lock error: {}", e))?;
        if let Some((url, ua, timestamp)) = cache.get(&video_id) {
            // googlevideo urls die way before 15 min, keep the cache short
            if now.saturating_sub(*timestamp) < 240 {
                stream_proxy::store_upstream(
                    &video_id,
                    stream_proxy::Upstream {
                        url: url.clone(),
                        user_agent: ua.clone(),
                    },
                );
                if let Some(proxy) = stream_proxy::proxy_url(&video_id) {
                    return Ok(Some(proxy));
                }
            }
        }
    }

    let app2 = app.clone();
    let vid = video_id.clone();
    let cookies = cookie_file_for(&app);
    let cookie_clone = cookies.clone();
    let cache_dir = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|p| p.join("yt-dlp-cache"));
    if let Some(dir) = cache_dir.as_ref() {
        let _ = std::fs::create_dir_all(dir);
    }
    let cache_clone = cache_dir.clone();
    let direct = tokio::task::spawn_blocking(move || {
        let bin = ytdlp::ensure_ytdlp(&app2)?;
        fetch_stream_url_sync(&bin, &vid, cookie_clone.as_deref(), cache_clone.as_deref())
    })
    .await
    .map_err(|e| format!("stream task failed: {}", e))??;

    if let Some(direct_url) = direct {
        let proxy = remember_and_proxy(&video_id, &direct_url, YTDLP_UA, now)?;
        return Ok(Some(proxy));
    }

    if let Some(got) = player::fetch_direct_audio(&video_id).await {
        let proxy = remember_and_proxy(&video_id, &got.url, &got.user_agent, now)?;
        return Ok(Some(proxy));
    }

    Ok(None)
}

#[command]
pub fn clear_stream_cache() {
    if let Ok(mut cache) = get_cache().lock() {
        for key in cache.keys().cloned().collect::<Vec<_>>() {
            stream_proxy::remove_direct_url(&key);
        }
        cache.clear();
    }
    stream_proxy::clear_all_direct_urls();
}

#[command]
pub async fn search_ytdlp(
    app: AppHandle,
    query: String,
    limit: u32,
) -> Result<Vec<YtdlpTrack>, String> {
    let limit = limit.min(30);
    let app2 = app.clone();
    tokio::task::spawn_blocking(move || {
        let ytdlp = ytdlp::ensure_ytdlp(&app2)?;
        let search = format!("ytsearch{}:{}", limit, query);
        let mut cmd = Command::new(&ytdlp);
        cmd.args([
            "-j",
            "--extractor-args",
            "youtube:player_client=android_vr,web_embedded,tv,ios",
            "--flat-playlist",
            "--no-warnings",
            "--quiet",
            &search,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let output = cmd
            .output()
            .map_err(|e| format!("yt-dlp spawn failed: {}", e))?;
        if !output.status.success() {
            return Ok(vec![]);
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut items = Vec::new();
        for line in stdout.lines() {
            let v: Value = match serde_json::from_str(line) {
                Ok(val) => val,
                Err(_) => continue,
            };
            let id = match v.get("id").and_then(|x| x.as_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let title = v
                .get("title")
                .and_then(|x| x.as_str())
                .unwrap_or("Unknown")
                .to_string();
            let artist = v
                .get("uploader")
                .and_then(|x| x.as_str())
                .or_else(|| v.get("channel").and_then(|x| x.as_str()))
                .unwrap_or("Unknown")
                .to_string();
            let cover = format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", id);
            let cover_small = format!("https://i.ytimg.com/vi/{}/mqdefault.jpg", id);
            let cover_large = format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", id);
            items.push(YtdlpTrack {
                id,
                title,
                artist,
                cover,
                cover_small,
                cover_large,
            });
        }
        Ok(items)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::pick_stream_url;

    #[test]
    fn picks_first_http_line() {
        let raw = "https://example.com/audio.m4a\nhttps://example.com/other";
        assert_eq!(
            pick_stream_url(raw),
            Some("https://example.com/audio.m4a".to_string())
        );
    }
}
