//! Last.fm scrobbling (plugin "Last.fm Scrobbler"). The user brings their own API account
//! (https://www.last.fm/api/account/create); key, secret and the session key are stored
//! encrypted with the same store as the YouTube Music session (DPAPI on Windows, 0600 file
//! elsewhere) and never reach the web view. Desktop auth flow: auth.getToken -> the user
//! approves in the browser -> auth.getSession.
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const API: &str = "https://ws.audioscrobbler.com/2.0/";

#[derive(Serialize, Deserialize, Default, Clone)]
struct Creds {
    api_key: String,
    secret: String,
    session: String,
    user: String,
    #[serde(default)]
    pending_token: String,
}

lazy_static::lazy_static! {
    static ref CACHE: Mutex<Option<Creds>> = Mutex::new(None);
}

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("lastfm.bin"))
}

fn load(app: &AppHandle) -> Creds {
    if let Some(c) = CACHE.lock().ok().and_then(|g| g.clone()) {
        return c;
    }
    let c: Creds = path(app)
        .and_then(|p| crate::secret_store::read_session(&p).ok())
        .and_then(|(j, _)| serde_json::from_str(&j).ok())
        .unwrap_or_default();
    if let Ok(mut g) = CACHE.lock() {
        *g = Some(c.clone());
    }
    c
}

fn save(app: &AppHandle, c: &Creds) -> Result<(), String> {
    let p = path(app).ok_or("no app data dir")?;
    crate::secret_store::write_session(&p, &serde_json::to_string(c).map_err(|e| e.to_string())?)?;
    if let Ok(mut g) = CACHE.lock() {
        *g = Some(c.clone());
    }
    Ok(())
}

/// api_sig = md5(concat of sorted k+v, without format/callback) + secret
pub fn sign(params: &BTreeMap<String, String>, secret: &str) -> String {
    let mut h = Md5::new();
    for (k, v) in params {
        if k == "format" || k == "callback" {
            continue;
        }
        h.update(k.as_bytes());
        h.update(v.as_bytes());
    }
    h.update(secret.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

async fn call(
    c: &Creds,
    method: &str,
    mut p: BTreeMap<String, String>,
    post: bool,
) -> Result<serde_json::Value, String> {
    p.insert("method".into(), method.into());
    p.insert("api_key".into(), c.api_key.clone());
    let sig = sign(&p, &c.secret);
    p.insert("api_sig".into(), sig);
    p.insert("format".into(), "json".into());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("Zenith/4.0 (desktop music player)")
        .build()
        .map_err(|e| e.to_string())?;
    let req = if post {
        client.post(API).form(&p)
    } else {
        client.get(API).query(&p)
    };
    let v: serde_json::Value = req
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(err) = v.get("error") {
        return Err(format!(
            "last.fm {}: {}",
            err,
            v.get("message").and_then(|m| m.as_str()).unwrap_or("")
        ));
    }
    Ok(v)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastfmStatus {
    configured: bool,
    user: Option<String>,
    pending: bool,
}

fn status_of(c: &Creds) -> LastfmStatus {
    LastfmStatus {
        configured: !c.api_key.is_empty() && !c.secret.is_empty(),
        user: (!c.session.is_empty()).then(|| c.user.clone()),
        pending: !c.pending_token.is_empty(),
    }
}

#[tauri::command]
pub fn lastfm_status(app: AppHandle) -> LastfmStatus {
    status_of(&load(&app))
}

#[tauri::command]
pub fn lastfm_set_keys(
    app: AppHandle,
    api_key: String,
    secret: String,
) -> Result<LastfmStatus, String> {
    let ok = |s: &str| s.len() == 32 && s.chars().all(|c| c.is_ascii_hexdigit());
    let (k, s) = (api_key.trim().to_string(), secret.trim().to_string());
    if !ok(&k) || !ok(&s) {
        return Err("API key and shared secret are 32 hex characters each".into());
    }
    let c = Creds {
        api_key: k,
        secret: s,
        ..Default::default()
    };
    save(&app, &c)?;
    Ok(status_of(&c))
}

/// returns the URL the user opens to allow Zenith
#[tauri::command]
pub async fn lastfm_begin_auth(app: AppHandle) -> Result<String, String> {
    let mut c = load(&app);
    if c.api_key.is_empty() {
        return Err("set the API key first".into());
    }
    let v = call(&c, "auth.getToken", BTreeMap::new(), false).await?;
    let token = v
        .get("token")
        .and_then(|t| t.as_str())
        .ok_or("no token")?
        .to_string();
    c.pending_token = token.clone();
    save(&app, &c)?;
    Ok(format!(
        "https://www.last.fm/api/auth/?api_key={}&token={}",
        c.api_key, token
    ))
}

#[tauri::command]
pub async fn lastfm_finish_auth(app: AppHandle) -> Result<LastfmStatus, String> {
    let mut c = load(&app);
    if c.pending_token.is_empty() {
        return Err("start the connection first".into());
    }
    let mut p = BTreeMap::new();
    p.insert("token".into(), c.pending_token.clone());
    let v = call(&c, "auth.getSession", p, false).await?;
    let s = v
        .get("session")
        .ok_or("no session (did you click Allow?)")?;
    c.session = s
        .get("key")
        .and_then(|k| k.as_str())
        .unwrap_or("")
        .to_string();
    c.user = s
        .get("name")
        .and_then(|k| k.as_str())
        .unwrap_or("")
        .to_string();
    c.pending_token.clear();
    save(&app, &c)?;
    Ok(status_of(&c))
}

#[tauri::command]
pub fn lastfm_logout(app: AppHandle) -> Result<LastfmStatus, String> {
    let mut c = load(&app);
    c.session.clear();
    c.user.clear();
    c.pending_token.clear();
    save(&app, &c)?;
    Ok(status_of(&c))
}

#[derive(Deserialize)]
pub struct ScrobbleTrack {
    artist: String,
    track: String,
    album: Option<String>,
    duration: Option<u32>,
    timestamp: Option<u64>,
}

fn track_params(t: &ScrobbleTrack) -> BTreeMap<String, String> {
    let mut p = BTreeMap::new();
    p.insert("artist".into(), t.artist.chars().take(300).collect());
    p.insert("track".into(), t.track.chars().take(300).collect());
    if let Some(a) = t.album.as_ref().filter(|a| !a.is_empty()) {
        p.insert("album".into(), a.chars().take(300).collect());
    }
    if let Some(d) = t.duration.filter(|d| *d > 0) {
        p.insert("duration".into(), d.to_string());
    }
    p
}

#[tauri::command]
pub async fn lastfm_now_playing(app: AppHandle, t: ScrobbleTrack) -> Result<(), String> {
    let c = load(&app);
    if c.session.is_empty() {
        return Ok(());
    }
    let mut p = track_params(&t);
    p.insert("sk".into(), c.session.clone());
    call(&c, "track.updateNowPlaying", p, true)
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn lastfm_scrobble(app: AppHandle, t: ScrobbleTrack) -> Result<(), String> {
    let c = load(&app);
    if c.session.is_empty() {
        return Err("not connected".into());
    }
    let mut p = track_params(&t);
    p.insert("timestamp".into(), t.timestamp.unwrap_or(0).to_string());
    p.insert("sk".into(), c.session.clone());
    call(&c, "track.scrobble", p, true).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signature_matches_spec_example() {
        // md5("api_keyxxxmethodauth.getSessiontokenyyy" + "secret")
        let mut p = BTreeMap::new();
        p.insert("api_key".to_string(), "xxx".to_string());
        p.insert("method".to_string(), "auth.getSession".to_string());
        p.insert("token".to_string(), "yyy".to_string());
        p.insert("format".to_string(), "json".to_string());
        let mut h = Md5::new();
        h.update(b"api_keyxxxmethodauth.getSessiontokenyyysecret");
        let want: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(sign(&p, "secret"), want);
    }
}
