//! Offline downloads: whole tracks saved under <app data>/downloads/<id>.audio with a small
//! json index next to them. Playback of a saved track goes through the local proxy
//! (/offline/<token>/<id>), so both the WebView engine and the native engine just see an
//! http url with range support and need no special file handling.

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadMeta {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub saved_at: u64,
}

static DIR: OnceLock<PathBuf> = OnceLock::new();
static INDEX: OnceLock<Mutex<BTreeMap<String, DownloadMeta>>> = OnceLock::new();
static ACTIVE: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

pub fn valid_id(id: &str) -> bool {
    id.len() == 11
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn index() -> &'static Mutex<BTreeMap<String, DownloadMeta>> {
    INDEX.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn active() -> &'static Mutex<std::collections::HashSet<String>> {
    ACTIVE.get_or_init(|| Mutex::new(Default::default()))
}

/// called once from setup; loads the index and drops entries whose file is gone
pub fn init(app: &AppHandle) {
    let Ok(base) = app.path().app_data_dir() else {
        return;
    };
    init_dir(base.join("downloads"));
}

pub fn init_dir(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let map = load_index(&dir);
    if let Ok(mut idx) = index().lock() {
        *idx = map;
    }
    let _ = DIR.set(dir);
}

fn load_index(dir: &std::path::Path) -> BTreeMap<String, DownloadMeta> {
    let raw = std::fs::read_to_string(dir.join("index.json")).unwrap_or_default();
    let list: Vec<DownloadMeta> = serde_json::from_str(&raw).unwrap_or_default();
    list.into_iter()
        .filter(|m| valid_id(&m.id) && dir.join(format!("{}.audio", m.id)).is_file())
        .map(|m| (m.id.clone(), m))
        .collect()
}

fn save_index() {
    let Some(dir) = DIR.get() else { return };
    let list: Vec<DownloadMeta> = match index().lock() {
        Ok(m) => m.values().cloned().collect(),
        Err(_) => return,
    };
    let tmp = dir.join("index.json.tmp");
    if let Ok(s) = serde_json::to_string(&list) {
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, dir.join("index.json"));
        }
    }
}

pub fn file_for(id: &str) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    let p = DIR.get()?.join(format!("{id}.audio"));
    p.is_file().then_some(p)
}

pub fn is_downloaded(id: &str) -> bool {
    index().lock().map(|m| m.contains_key(id)).unwrap_or(false) && file_for(id).is_some()
}

#[tauri::command]
pub fn downloads_list() -> Vec<DownloadMeta> {
    let mut v: Vec<DownloadMeta> = index()
        .lock()
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default();
    v.sort_by_key(|m| std::cmp::Reverse(m.saved_at));
    v
}

#[tauri::command]
pub fn downloads_delete(id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("bad id".into());
    }
    if let Some(p) = file_for(&id) {
        std::fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    if let Ok(mut m) = index().lock() {
        m.remove(&id);
    }
    save_index();
    Ok(())
}

#[tauri::command]
pub fn downloads_clear() -> Result<usize, String> {
    let ids: Vec<String> = downloads_list().into_iter().map(|m| m.id).collect();
    for id in &ids {
        downloads_delete(id.clone())?;
    }
    Ok(ids.len())
}

/// fetches the whole track through the stream proxy (which already knows how to talk to
/// the cdn) and stores it. Emits `download-progress` {id, done, total} while it runs.
#[tauri::command]
pub async fn downloads_add(app: AppHandle, meta: DownloadMeta) -> Result<DownloadMeta, String> {
    if !valid_id(&meta.id) {
        return Err("bad id".into());
    }
    let dir = DIR.get().cloned().ok_or("downloads folder unavailable")?;
    if is_downloaded(&meta.id) {
        return index()
            .lock()
            .ok()
            .and_then(|m| m.get(&meta.id).cloned())
            .ok_or_else(|| "index".into());
    }
    {
        let mut a = active().lock().map_err(|_| "lock")?;
        if !a.insert(meta.id.clone()) {
            return Err("already downloading".into());
        }
    }
    let id = meta.id.clone();
    let r = fetch_to_disk(&app, &dir, meta).await;
    if let Ok(mut a) = active().lock() {
        a.remove(&id);
    }
    r
}

async fn fetch_to_disk(
    app: &AppHandle,
    dir: &std::path::Path,
    mut meta: DownloadMeta,
) -> Result<DownloadMeta, String> {
    let url = crate::stream::get_stream_url(app.clone(), meta.id.clone(), None)
        .await?
        .ok_or("no stream for this track")?;
    if url.contains("/offline/") {
        return Err("already offline".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    if !(meta.duration > 0.0) {
        meta.duration = duration_from_url(&url).unwrap_or(0.0);
    }
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("http {}", res.status().as_u16()));
    }
    let total = res.content_length().unwrap_or(0);
    let part = dir.join(format!("{}.part", meta.id));
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| e.to_string())?;
    let mut done: u64 = 0;
    let mut last_emit = 0u64;
    let mut body = res.bytes_stream();
    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = body.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                let _ = tokio::fs::remove_file(&part).await;
                return Err(e.to_string());
            }
        };
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if done - last_emit > 256 * 1024 {
            last_emit = done;
            let _ = app.emit(
                "download-progress",
                serde_json::json!({ "id": meta.id, "done": done, "total": total }),
            );
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if done == 0 || (total > 0 && done < total) {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("download cut short".into());
    }
    tokio::fs::rename(&part, dir.join(format!("{}.audio", meta.id)))
        .await
        .map_err(|e| e.to_string())?;
    meta.size = done;
    meta.saved_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut m) = index().lock() {
        m.insert(meta.id.clone(), meta.clone());
    }
    save_index();
    let _ = app.emit(
        "download-progress",
        serde_json::json!({ "id": meta.id, "done": done, "total": done, "finished": true }),
    );
    Ok(meta)
}

/// sniff the container so the webview picks the right decoder
pub fn sniff_mime(head: &[u8]) -> &'static str {
    if head.len() >= 4 && head[..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        "audio/webm"
    } else if head.len() >= 8 && &head[4..8] == b"ftyp" {
        "audio/mp4"
    } else if head.len() >= 4 && &head[..4] == b"OggS" {
        "audio/ogg"
    } else if head.len() >= 3
        && (&head[..3] == b"ID3" || (head[0] == 0xFF && head[1] & 0xE0 == 0xE0))
    {
        "audio/mpeg"
    } else {
        "application/octet-stream"
    }
}

/// parses "bytes=a-b" against a file length; None means serve everything
pub fn parse_range(h: Option<&str>, len: u64) -> Option<(u64, u64)> {
    let v = h?.trim().strip_prefix("bytes=")?;
    let (a, b) = v.split_once('-')?;
    if len == 0 {
        return None;
    }
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (len.saturating_sub(n), len - 1)
    } else {
        let s: u64 = a.parse().ok()?;
        let e = if b.is_empty() {
            len - 1
        } else {
            b.parse::<u64>().ok()?.min(len - 1)
        };
        (s, e)
    };
    (start <= end && start < len).then_some((start, end))
}

/// (status, bytes, start, end, file length, mime)
pub type Slice = (u16, Vec<u8>, u64, u64, u64, &'static str);

/// reads the requested slice of a saved track (capped so one response stays small)
pub fn read_slice(id: &str, range: Option<&str>) -> Option<Slice> {
    let path = file_for(id)?;
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut head = [0u8; 12];
    let n = f.read(&mut head).ok()?;
    let mime = sniff_mime(&head[..n]);
    let (status, start, end) = match parse_range(range, len) {
        Some((s, e)) => (206u16, s, e.min(s + 8 * 1024 * 1024 - 1)),
        None => (200u16, 0, len.saturating_sub(1)),
    };
    f.seek(SeekFrom::Start(start)).ok()?;
    let want = if len == 0 { 0 } else { end - start + 1 };
    let mut buf = vec![0u8; want as usize];
    f.read_exact(&mut buf).ok()?;
    Some((status, buf, start, end, len, mime))
}

/// googlevideo urls carry the track length as `dur=223.456`, handy when the ui didn't know it
fn duration_from_url(url: &str) -> Option<f64> {
    let q = url.split_once('?')?.1;
    q.split('&')
        .find_map(|kv| kv.strip_prefix("dur="))
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|d| d.is_finite() && *d > 0.0)
}

#[cfg(test)]
mod tests {
    #[test]
    fn duration_from_stream_url() {
        assert_eq!(
            super::duration_from_url(
                "https://x.googlevideo.com/videoplayback?itag=251&dur=223.481&mime=audio"
            ),
            Some(223.481)
        );
        assert_eq!(
            super::duration_from_url("https://x/videoplayback?itag=251"),
            None
        );
        assert_eq!(super::duration_from_url("https://x/v?dur=abc"), None);
    }
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range(Some("bytes=0-"), 100), Some((0, 99)));
        assert_eq!(parse_range(Some("bytes=10-19"), 100), Some((10, 19)));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Some((90, 99)));
        assert_eq!(parse_range(Some("bytes=50-500"), 100), Some((50, 99)));
        assert_eq!(parse_range(Some("bytes=200-"), 100), None);
        assert_eq!(parse_range(None, 100), None);
    }

    #[test]
    fn mime() {
        assert_eq!(sniff_mime(&[0x1A, 0x45, 0xDF, 0xA3]), "audio/webm");
        assert_eq!(sniff_mime(b"\0\0\0\x20ftypM4A "), "audio/mp4");
        assert_eq!(sniff_mime(b"xx"), "application/octet-stream");
    }

    #[test]
    fn ids() {
        assert!(valid_id("dQw4w9WgXcQ"));
        assert!(!valid_id("../etc/pass"));
        assert!(!valid_id("short"));
    }

    #[test]
    fn index_roundtrip_and_slice() {
        let dir = std::env::temp_dir().join(format!("zenith-dl-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let id = "abcdefghijk";
        std::fs::write(dir.join(format!("{id}.audio")), b"OggS0123456789").unwrap();
        let meta = DownloadMeta {
            id: id.into(),
            title: "t".into(),
            artist: String::new(),
            album: String::new(),
            cover: String::new(),
            duration: 1.0,
            size: 14,
            saved_at: 1,
        };
        let ghost = DownloadMeta {
            id: "zzzzzzzzzzz".into(),
            ..meta.clone()
        };
        std::fs::write(
            dir.join("index.json"),
            serde_json::to_string(&vec![meta.clone(), ghost]).unwrap(),
        )
        .unwrap();
        init_dir(dir.clone());
        assert_eq!(downloads_list(), vec![meta]);
        let (st, buf, s, e, len, mime) = read_slice(id, Some("bytes=4-7")).unwrap();
        assert_eq!(
            (st, &buf[..], s, e, len, mime),
            (206, &b"0123"[..], 4, 7, 14, "audio/ogg")
        );
        downloads_delete(id.into()).unwrap();
        assert!(downloads_list().is_empty());
        assert!(!dir.join(format!("{id}.audio")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
