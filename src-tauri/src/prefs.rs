use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

static LOCK: Mutex<()> = Mutex::new(());
static PREFS_PENDING: Mutex<Option<(PathBuf, String)>> = Mutex::new(None);
static FAVORITES_PENDING: Mutex<Option<(PathBuf, String)>> = Mutex::new(None);

// komenda zostaje synchroniczna, więc kolejność treści to kolejność wywołań; zapis pliku idzie poza wątek okna
fn write_later(slot: &'static Mutex<Option<(PathBuf, String)>>, path: PathBuf, body: String) {
    *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some((path, body));
    tauri::async_runtime::spawn_blocking(move || {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Some((path, body)) = slot.lock().unwrap_or_else(|e| e.into_inner()).take() else {
            return;
        };
        let write = || -> std::io::Result<()> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, body)?;
            std::fs::rename(&tmp, &path)
        };
        if let Err(e) = write() {
            crate::diag::log(format!("[Zenith] {} not saved: {e}", path.display()));
        }
    });
}

const MAX_KEYS: usize = 400;
const MAX_VALUE: usize = 4096;
const FAVORITES_MAX_BYTES: usize = 4_000_000;
pub const FAVORITES_MAX_TRACKS: usize = 2000;

fn file(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_local_data_dir().ok()?.join("prefs.json"))
}

fn favorites_file(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_local_data_dir().ok()?.join("favorites.json"))
}

pub fn normalize_favorites(body: &str) -> Result<String, String> {
    if body.len() > FAVORITES_MAX_BYTES {
        return Err("favorites too big".into());
    }
    let value: serde_json::Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    let arr = value.as_array().ok_or("favorites must be a list")?;
    if arr.len() > FAVORITES_MAX_TRACKS {
        return Err("too many favorites".into());
    }
    for item in arr {
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() || id.len() > 64 {
            return Err("bad favorite id".into());
        }
    }
    serde_json::to_string(arr).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn favorites_load(app: AppHandle) -> String {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(path) = favorites_file(&app) else {
        return "[]".into();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return "[]".into();
    };
    normalize_favorites(&raw).unwrap_or_else(|_| "[]".into())
}

#[tauri::command]
pub fn favorites_save(app: AppHandle, body: String) -> Result<(), String> {
    let body = normalize_favorites(&body)?;
    let path = favorites_file(&app).ok_or("no data dir")?;
    write_later(&FAVORITES_PENDING, path, body);
    Ok(())
}

pub fn sanitize(map: HashMap<String, String>) -> HashMap<String, String> {
    map.into_iter()
        .filter(|(k, v)| !k.is_empty() && k.len() <= 128 && v.len() <= MAX_VALUE)
        .filter(|(k, _)| {
            let l = k.to_ascii_lowercase();
            ![
                "token",
                "secret",
                "session",
                "password",
                "apikey",
                "api_key",
                "cookie",
                "webhook_url",
            ]
            .iter()
            .any(|s| l.contains(s))
                && !l.ends_with("_pin")
        })
        .take(MAX_KEYS)
        .collect()
}

#[tauri::command(async)]
pub fn prefs_load(app: AppHandle) -> HashMap<String, String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    file(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<HashMap<String, String>>(&s).ok())
        .map(sanitize)
        .unwrap_or_default()
}

#[tauri::command]
pub fn prefs_save(
    app: AppHandle,
    webview: tauri::Webview,
    prefs: HashMap<String, String>,
) -> Result<(), String> {
    crate::auth_store::main_window_only(&webview)?;
    let path = file(&app).ok_or("no data dir")?;
    let body = serde_json::to_string(&sanitize(prefs)).map_err(|e| e.to_string())?;
    write_later(&PREFS_PENDING, path, body);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn newest_body_wins() {
        use std::sync::Mutex;
        static SLOT: Mutex<Option<(std::path::PathBuf, String)>> = Mutex::new(None);
        let path = std::env::temp_dir().join(format!("zprefs_test_{}.json", std::process::id()));
        for i in 0..20 {
            super::write_later(&SLOT, path.clone(), i.to_string());
        }
        let read = || std::fs::read_to_string(&path).unwrap_or_default();
        for _ in 0..500 {
            if read() == "19" {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let _g = super::LOCK.lock().unwrap();
        assert!(SLOT.lock().unwrap().is_none());
        assert_eq!(read(), "19");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn drops_big_values() {
        let mut m = std::collections::HashMap::new();
        m.insert("zenith_legal_ack".to_string(), "1".to_string());
        m.insert("zenith_saved_tracks".to_string(), "x".repeat(5000));
        m.insert("zenith_mxm_usertoken".to_string(), "t".to_string());
        let s = super::sanitize(m);
        assert_eq!(s.len(), 1);
        assert!(s.contains_key("zenith_legal_ack"));
    }

    #[test]
    fn favorites_list_round_trips_and_rejects_junk() {
        let raw = r#"[{"id":"dQw4w9WgXcQ","title":"x","artist":"y","type":"track","cover":""}]"#;
        let norm = super::normalize_favorites(raw).unwrap();
        assert!(norm.contains("dQw4w9WgXcQ"));
        assert!(super::normalize_favorites("[]").is_ok());
        assert!(super::normalize_favorites(r#"{"id":"nope"}"#).is_err());
        assert!(super::normalize_favorites(r#"[{"title":"no id"}]"#).is_err());
    }
}
