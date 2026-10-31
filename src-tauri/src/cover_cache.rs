//! cover art resized to the size it is shown at and kept on disk, served by the local
//! proxy: `http://127.0.0.1:<port>/cover/<token>/<px>/<urlencoded https url>` -> JPEG <= px*px.
//! (a custom uri scheme is blocked by WebKitGTK's CSP handling even when listed)
//! Fewer bytes over the network and much smaller decodes in the webview (a 480x360
//! hqdefault shown at 48px used to be decoded at full size every time).
//! Size-capped (MAX_BYTES), oldest files dropped first.
use sha1::{Digest, Sha1};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};

const MAX_BYTES: u64 = 64 * 1024 * 1024;
const TRIM_TO: u64 = 48 * 1024 * 1024;
const ALLOWED_PX: [u32; 3] = [THUMB_PX, 240, 544];
/// queue / up next / player bar rows (40-56 css px)
const THUMB_PX: u32 = 120;
const ALLOWED_HOSTS: [&str; 5] = [
    "i.ytimg.com",
    "lh3.googleusercontent.com",
    "yt3.ggpht.com",
    "yt3.googleusercontent.com",
    "i9.ytimg.com",
];

static DIR: OnceLock<PathBuf> = OnceLock::new();
static WRITES: AtomicU32 = AtomicU32::new(0);

fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Option<&'static PathBuf> {
    if let Some(d) = DIR.get() {
        return Some(d);
    }
    let d = app.path().app_cache_dir().ok()?.join("covers");
    std::fs::create_dir_all(&d).ok()?;
    Some(DIR.get_or_init(|| d))
}

/// "/<px>/<encoded url>" -> (px, url); only known sizes and image hosts
pub fn parse_path(path: &str) -> Option<(u32, String)> {
    let rest = path.strip_prefix('/')?;
    let (px, enc) = rest.split_once('/')?;
    let px: u32 = px.parse().ok()?;
    if !ALLOWED_PX.contains(&px) {
        return None;
    }
    let url = percent_decode(enc)?;
    let parsed = url::Url::parse(&url).ok()?;
    if parsed.scheme() != "https" || !ALLOWED_HOSTS.contains(&parsed.host_str()?) {
        return None;
    }
    Some((px, url))
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn key(px: u32, url: &str) -> String {
    let mut h = Sha1::new();
    h.update(px.to_le_bytes());
    h.update(url.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// decode + shrink to fit px (never upscale) + JPEG q86
pub fn resize_to_jpeg(bytes: &[u8], px: u32) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let img = if px <= THUMB_PX {
        // thumbnails sit in object-fit: cover boxes: the SHORT side must reach px, or a
        // 16:9 video thumb would be soft once cropped to the square
        let short = img.width().min(img.height());
        if short > px {
            let (w, h) = (
                (img.width() as u64 * px as u64 / short as u64) as u32,
                (img.height() as u64 * px as u64 / short as u64) as u32,
            );
            img.resize_exact(w.max(1), h.max(1), image::imageops::FilterType::Triangle)
        } else {
            img
        }
    } else if img.width() > px || img.height() > px {
        img.resize(px, px, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let rgb = img.to_rgb8();
    let mut out = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 86);
    enc.encode_image(&rgb).ok()?;
    Some(out)
}

/// drop the oldest files once the folder is over MAX_BYTES
pub fn trim(dir: &Path, max: u64, to: u64) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            m.is_file().then(|| {
                (
                    m.modified().unwrap_or(std::time::UNIX_EPOCH),
                    m.len(),
                    e.path(),
                )
            })
        })
        .collect();
    let total: u64 = files.iter().map(|f| f.1).sum();
    if total <= max {
        return;
    }
    files.sort_by_key(|f| f.0);
    let mut cur = total;
    for (_, len, p) in files {
        if cur <= to {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            cur = cur.saturating_sub(len);
        }
    }
}

fn http() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36")
            .build()
            .expect("http client")
    })
}

/// remember where the cache lives (called once from setup)
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let _ = cache_dir(app);
}

/// cached or freshly resized JPEG for (px, url); Err = http status for the proxy
pub async fn get(px: u32, url: String) -> Result<Vec<u8>, u16> {
    let dir = DIR.get().cloned();
    let file = dir
        .as_ref()
        .map(|d| d.join(format!("{}.jpg", key(px, &url))));
    if let Some(f) = file.as_ref() {
        if let Ok(bytes) = tokio::fs::read(f).await {
            return Ok(bytes);
        }
    }
    let src = match http().get(&url).send().await {
        Ok(r) if r.status().is_success() => r.bytes().await.ok(),
        _ => None,
    };
    // the <img> onError chain then falls back to the original url / smaller variants
    let src = src.ok_or(502u16)?;
    let out = tokio::task::spawn_blocking(move || resize_to_jpeg(&src, px))
        .await
        .ok()
        .flatten()
        .ok_or(415u16)?;
    if let (Some(f), Some(d)) = (file, dir) {
        let tmp = f.with_extension("tmp");
        if tokio::fs::write(&tmp, &out).await.is_ok() {
            let _ = tokio::fs::rename(&tmp, &f).await;
        }
        if WRITES.fetch_add(1, Ordering::Relaxed).is_multiple_of(64) {
            tokio::task::spawn_blocking(move || trim(&d, MAX_BYTES, TRIM_TO));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_allowed() {
        let ok = parse_path("/240/https%3A%2F%2Fi.ytimg.com%2Fvi%2Fabc%2Fhqdefault.jpg").unwrap();
        assert_eq!(ok, (240, "https://i.ytimg.com/vi/abc/hqdefault.jpg".into()));
        assert!(parse_path("/241/https%3A%2F%2Fi.ytimg.com%2Fx").is_none());
        assert!(parse_path("/240/https%3A%2F%2Fevil.com%2Fx").is_none());
        assert!(parse_path("/240/http%3A%2F%2Fi.ytimg.com%2Fx").is_none());
    }

    #[test]
    fn resizes_down_not_up() {
        let mut big = Vec::new();
        image::DynamicImage::new_rgb8(480, 360)
            .write_to(&mut std::io::Cursor::new(&mut big), image::ImageFormat::Png)
            .unwrap();
        let out = resize_to_jpeg(&big, 240).unwrap();
        let img = image::load_from_memory(&out).unwrap();
        assert_eq!((img.width(), img.height()), (240, 180));
        let out = resize_to_jpeg(&big, 544).unwrap();
        let img = image::load_from_memory(&out).unwrap();
        assert_eq!((img.width(), img.height()), (480, 360));
        let out = resize_to_jpeg(&big, 120).unwrap();
        let img = image::load_from_memory(&out).unwrap();
        assert_eq!((img.width(), img.height()), (160, 120));
    }

    #[test]
    fn trims_oldest() {
        let d = std::env::temp_dir().join(format!("zcover_test_{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        for i in 0..5 {
            std::fs::write(d.join(format!("{i}.jpg")), vec![0u8; 1000]).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        trim(&d, 3000, 2000);
        let left: Vec<_> = std::fs::read_dir(&d).unwrap().flatten().collect();
        assert_eq!(left.len(), 2);
        assert!(d.join("4.jpg").exists());
        std::fs::remove_dir_all(&d).unwrap();
    }
}
