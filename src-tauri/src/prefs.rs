use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

static LOCK: Mutex<()> = Mutex::new(());

const MAX_KEYS: usize = 400;
const MAX_VALUE: usize = 4096;
const FAVORITES_MAX_BYTES: usize = 1_500_000;
const FAVORITES_MAX_TRACKS: usize = 500;

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

#[tauri::command]
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
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let body = normalize_favorites(&body)?;
    let path = favorites_file(&app).ok_or("no data dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn sanitize(map: HashMap<String, String>) -> HashMap<String, String> {
    map.into_iter()
        .filter(|(k, v)| !k.is_empty() && k.len() <= 128 && v.len() <= MAX_VALUE)
        .filter(|(k, _)| {
            let l = k.to_ascii_lowercase();
            ![
                "token", "secret", "session", "password", "apikey", "api_key", "cookie",
            ]
            .iter()
            .any(|s| l.contains(s))
        })
        .take(MAX_KEYS)
        .collect()
}

#[tauri::command]
pub fn prefs_load(app: AppHandle) -> HashMap<String, String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    file(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<HashMap<String, String>>(&s).ok())
        .map(sanitize)
        .unwrap_or_default()
}

#[tauri::command]
pub fn prefs_save(app: AppHandle, prefs: HashMap<String, String>) -> Result<(), String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = file(&app).ok_or("no data dir")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string(&sanitize(prefs)).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
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
