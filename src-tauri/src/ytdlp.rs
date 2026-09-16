//! download / refresh yt-dlp into app data, we never ship the binary
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;
use tauri::{AppHandle, Manager};

static ENSURE_LOCK: Mutex<()> = Mutex::new(());
static LAST_FAIL: Mutex<Option<Instant>> = Mutex::new(None);
const FAIL_COOLDOWN: Duration = Duration::from_secs(45);
const STALE_AFTER_SECS: u64 = 14 * 24 * 3600;

#[cfg(windows)]
const YTDLP_NAME: &str = "yt-dlp.exe";
#[cfg(not(windows))]
const YTDLP_NAME: &str = "yt-dlp";

fn download_urls() -> &'static [&'static str] {
    // official names: yt-dlp.exe (win x64), yt-dlp_x86.exe, yt-dlp_macos, yt-dlp_linux
    #[cfg(all(windows, target_arch = "x86"))]
    {
        &[
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_x86.exe",
            "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_x86.exe",
            "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_x86.exe",
        ]
    }
    #[cfg(all(windows, not(target_arch = "x86")))]
    {
        &[
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
            "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe",
            "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe",
        ]
    }
    #[cfg(target_os = "macos")]
    {
        &[
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
            "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_macos",
        ]
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        &[
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux",
            "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_linux",
        ]
    }
}

fn app_bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("bin");
    fs::create_dir_all(&dir).map_err(|e| format!("create bin dir: {e}"))?;
    Ok(dir)
}

pub fn ytdlp_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_bin_dir(app)?.join(YTDLP_NAME))
}

fn file_is_stale(path: &PathBuf) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return true;
    };
    if meta.len() < 1_000_000 {
        return true;
    }
    let Ok(modified) = meta.modified() else {
        return false;
    };
    let Ok(age) = SystemTime::now().duration_since(modified) else {
        return false;
    };
    age.as_secs() > STALE_AFTER_SECS
}

fn binary_looks_ancient(path: &PathBuf) -> bool {
    match read_ytdlp_version(path) {
        Some(ver) => {
            let year = ver
                .split('.')
                .next()
                .and_then(|y| y.trim().parse::<u32>().ok())
                .unwrap_or(0);
            year > 0 && year < 2026
        }
        None => false,
    }
}

fn read_ytdlp_version(path: &PathBuf) -> Option<String> {
    let mut cmd = std::process::Command::new(path);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let out = cmd.output().ok()?;
    let ver = String::from_utf8_lossy(&out.stdout);
    let line = ver.lines().next()?.trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

fn parse_ver(s: &str) -> Option<(u32, u32, u32)> {
    let mut parts = s.trim().split('.').filter_map(|p| {
        p.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u32>()
            .ok()
    });
    Some((
        parts.next()?,
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    ))
}

fn ver_newer(remote: &str, local: &str) -> bool {
    match (parse_ver(remote), parse_ver(local)) {
        (Some(a), Some(b)) => a > b,
        (Some(_), None) => true,
        _ => false,
    }
}

fn github_latest_tag(client: &reqwest::blocking::Client) -> Option<String> {
    let res = client
        .get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .ok()?
        .error_for_status()
        .ok()?;
    let v: Value = res.json().ok()?;
    let tag = v.get("tag_name")?.as_str()?.trim();
    if tag.is_empty() {
        None
    } else {
        Some(tag.to_string())
    }
}

pub struct YtdlpRefresh {
    pub version: String,
    pub updated: bool,
}

/// check github for a newer yt-dlp and install it into app data
pub fn refresh_ytdlp(app: &AppHandle) -> Result<YtdlpRefresh, String> {
    let _guard = ENSURE_LOCK.lock().map_err(|e| e.to_string())?;
    let path = ytdlp_path(app)?;
    let local_ver = if path.exists() {
        read_ytdlp_version(&path)
    } else {
        None
    };
    let client = reqwest::blocking::Client::builder()
        .user_agent("ZenithPlayer/1.0 (dep refresh; +https://github.com/yt-dlp/yt-dlp)")
        .timeout(Duration::from_secs(45))
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .ok();
    let remote = client.as_ref().and_then(github_latest_tag);
    let missing = !path.exists() || file_is_stale(&path) || binary_looks_ancient(&path);
    let need = match (&remote, &local_ver) {
        (Some(r), Some(l)) => ver_newer(r, l) || binary_looks_ancient(&path),
        (Some(_), None) => true,
        (None, _) => missing,
    };

    if !need {
        clear_fail();
        return Ok(YtdlpRefresh {
            version: local_ver.unwrap_or_default(),
            updated: false,
        });
    }

    if in_fail_cooldown() && path.exists() {
        return Ok(YtdlpRefresh {
            version: local_ver.unwrap_or_default(),
            updated: false,
        });
    }

    match download_ytdlp(&path) {
        Ok(()) => {
            clear_fail();
            let version = read_ytdlp_version(&path).unwrap_or_else(|| remote.unwrap_or_default());
            eprintln!("[Zenith] yt-dlp now {version}");
            Ok(YtdlpRefresh {
                version,
                updated: true,
            })
        }
        Err(e) => {
            mark_fail();
            if path.exists() {
                eprintln!("[Zenith] yt-dlp refresh failed ({e}) - using existing binary");
                Ok(YtdlpRefresh {
                    version: local_ver.unwrap_or_default(),
                    updated: false,
                })
            } else if let Some(sys) = which_ytdlp() {
                Ok(YtdlpRefresh {
                    version: read_ytdlp_version(&sys).unwrap_or_default(),
                    updated: false,
                })
            } else {
                Err(e)
            }
        }
    }
}

fn download_ytdlp(dest: &PathBuf) -> Result<(), String> {
    eprintln!("[Zenith] downloading yt-dlp...");
    let client = reqwest::blocking::Client::builder()
        .user_agent("ZenithPlayer/1.0 (yt-dlp bootstrap; +https://github.com/yt-dlp/yt-dlp)")
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let mut last_err = String::from("no download urls");
    for url in download_urls() {
        match download_one(&client, url, dest) {
            Ok(()) => {
                eprintln!("[Zenith] yt-dlp ready at {}", dest.display());
                return Ok(());
            }
            Err(e) => {
                eprintln!("[Zenith] yt-dlp download miss ({url}): {e}");
                last_err = e;
            }
        }
    }
    Err(last_err)
}

fn looks_like_ytdlp_binary(bytes: &[u8]) -> bool {
    if bytes.len() < 4 {
        return false;
    }
    bytes.starts_with(b"MZ")
        || bytes.starts_with(b"\x7fELF")
        || bytes.starts_with(b"#!")
        || bytes.starts_with(&[0xfe, 0xed, 0xfa, 0xce])
        || bytes.starts_with(&[0xfe, 0xed, 0xfa, 0xcf])
        || bytes.starts_with(&[0xce, 0xfa, 0xed, 0xfe])
        || bytes.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
        || bytes.starts_with(&[0xca, 0xfe, 0xba, 0xbe])
        || bytes.starts_with(&[0xbe, 0xba, 0xfe, 0xca])
}

fn download_one(
    client: &reqwest::blocking::Client,
    url: &str,
    dest: &PathBuf,
) -> Result<(), String> {
    let bytes = client
        .get(url)
        .header("Accept", "application/octet-stream")
        .send()
        .map_err(|e| format!("yt-dlp download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("yt-dlp download HTTP: {e}"))?
        .bytes()
        .map_err(|e| e.to_string())?;
    if bytes.len() < 1_000_000 {
        return Err(format!(
            "yt-dlp download too small ({} bytes) - aborting",
            bytes.len()
        ));
    }
    let magic_ok = looks_like_ytdlp_binary(&bytes);
    if !magic_ok {
        return Err("yt-dlp download failed integrity check (unexpected file header)".into());
    }
    let tmp = dest.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    let _ = fs::remove_file(dest);
    fs::rename(&tmp, dest).map_err(|e| format!("install yt-dlp: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(dest).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(dest, perms).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn in_fail_cooldown() -> bool {
    if let Ok(g) = LAST_FAIL.lock() {
        if let Some(at) = *g {
            return at.elapsed() < FAIL_COOLDOWN;
        }
    }
    false
}

fn mark_fail() {
    if let Ok(mut g) = LAST_FAIL.lock() {
        *g = Some(Instant::now());
    }
}

fn clear_fail() {
    if let Ok(mut g) = LAST_FAIL.lock() {
        *g = None;
    }
}

/// path to yt-dlp, downloads into app data if we dont have a usable copy yet
pub fn ensure_ytdlp(app: &AppHandle) -> Result<PathBuf, String> {
    let _guard = ENSURE_LOCK.lock().map_err(|e| e.to_string())?;
    let path = ytdlp_path(app)?;

    if path.exists() && !binary_looks_ancient(&path) {
        let meta_ok = fs::metadata(&path)
            .map(|m| m.len() >= 1_000_000)
            .unwrap_or(false);
        if meta_ok {
            clear_fail();
            return Ok(path);
        }
    }

    if in_fail_cooldown() && path.exists() {
        return Ok(path);
    }

    match download_ytdlp(&path) {
        Ok(()) => {
            clear_fail();
            Ok(path)
        }
        Err(e) => {
            mark_fail();
            if path.exists() {
                eprintln!("[Zenith] yt-dlp refresh failed ({e}) - using existing binary");
                Ok(path)
            } else if let Some(sys) = which_ytdlp() {
                if !binary_looks_ancient(&sys) {
                    Ok(sys)
                } else {
                    Err(e)
                }
            } else {
                Err(e)
            }
        }
    }
}

fn which_ytdlp() -> Option<PathBuf> {
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join(YTDLP_NAME);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

/// node.exe, yt-dlp uses it for n-sig / ejs challenges
pub fn node_executable() -> Option<PathBuf> {
    let candidates = [
        std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .map(|p| p.join("nodejs").join("node.exe")),
        Some(PathBuf::from(r"C:\Program Files\nodejs\node.exe")),
    ];
    for c in candidates.into_iter().flatten() {
        if c.exists() {
            return Some(c);
        }
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn ensure_ytdlp_ready(app: AppHandle) -> Result<String, String> {
    let app2 = app.clone();
    let path = tokio::task::spawn_blocking(move || ensure_ytdlp(&app2))
        .await
        .map_err(|e| e.to_string())??;
    Ok(path.display().to_string())
}
