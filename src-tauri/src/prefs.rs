//! small settings mirror on disk.
//!
//! WebView2 writes localStorage to disk lazily and rate-limits the commits when a page
//! writes a lot (the saved queue, liked tracks). on Windows the pending batch could be
//! lost when Zenith quit, so small flags like "disclaimer accepted" or the language never
//! reached disk and the welcome screen came back on every start. the UI mirrors its small
//! keys here and restores missing ones before the first render.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

static LOCK: Mutex<()> = Mutex::new(());

const MAX_KEYS: usize = 400;
const MAX_VALUE: usize = 4096;

fn file(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_local_data_dir().ok()?.join("prefs.json"))
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
}
