//! non-linux: audio stays in the webview (<audio>), the ui is never dropped
use serde_json::Value;
pub fn available() -> bool {
    false
}
pub fn init(_app: &tauri::AppHandle) {}
pub fn is_headless() -> bool {
    false
}
pub fn set_headless(_on: bool) {}
pub mod headless {
    pub fn action(_a: &str) {}
    pub fn save_state() {}
}
#[tauri::command]
pub fn zaudio_available() -> bool {
    false
}
#[tauri::command]
pub fn zaudio_cmd(cmd: Value) -> Value {
    let _ = cmd;
    Value::Null
}
#[tauri::command]
pub async fn zaudio_play() -> Result<Value, String> {
    Err("unavailable".into())
}
#[tauri::command]
pub async fn zaudio_wait_ready(timeout_ms: u64) -> bool {
    let _ = timeout_ms;
    false
}
#[tauri::command]
pub async fn zaudio_crossfade(url: String, seconds: f64) -> Result<Value, String> {
    let _ = (url, seconds);
    Err("unavailable".into())
}
#[tauri::command]
pub fn zaudio_preroll(url: String) -> bool {
    let _ = url;
    false
}
#[tauri::command]
pub fn zaudio_plan(plan: Value) {
    let _ = plan;
}
#[tauri::command]
pub fn zaudio_attach() -> Value {
    Value::Null
}
