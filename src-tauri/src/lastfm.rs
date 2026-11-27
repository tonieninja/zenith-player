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
    let client = crate::player::client("Zenith/4.0 (desktop music player)", 12, true)
        .ok_or("http client")?;
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

static IMPORTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Jedna strona historii: (wykonawca, tytuł, album, czas w ms); utwór grany teraz nie ma daty i odpada.
pub fn parse_recent(v: &serde_json::Value) -> (Vec<crate::db::Scrobble>, u64) {
    let rt = &v["recenttracks"];
    let pages = rt["@attr"]["totalPages"]
        .as_str()
        .and_then(|p| p.parse().ok())
        .or_else(|| rt["@attr"]["totalPages"].as_u64())
        .unwrap_or(0);
    // jeden scrobble przychodzi jako obiekt, nie lista
    let list = match &rt["track"] {
        serde_json::Value::Array(a) => a.clone(),
        o @ serde_json::Value::Object(_) => vec![o.clone()],
        _ => Vec::new(),
    };
    let rows = list
        .iter()
        .filter_map(|t| {
            let uts: i64 = t["date"]["uts"].as_str()?.parse().ok()?;
            let artist = t["artist"]["#text"]
                .as_str()
                .or_else(|| t["artist"]["name"].as_str())?;
            let title = t["name"].as_str()?;
            let album = t["album"]["#text"]
                .as_str()
                .filter(|a| !a.is_empty())
                .map(String::from);
            Some((artist.to_string(), title.to_string(), album, uts * 1000))
        })
        .collect();
    (rows, pages)
}

/// Całą historię Last.fm wciąga w tle do bazy statystyk; postęp idzie zdarzeniem lastfm-import.
#[tauri::command]
pub fn lastfm_import(app: AppHandle, user: Option<String>) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let c = load(&app);
    if c.api_key.is_empty() {
        return Err("Set your Last.fm API key in the scrobbler plugin first".into());
    }
    let user = user
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| c.user.clone());
    if user.is_empty() || user.len() > 64 {
        return Err("Last.fm user name missing".into());
    }
    if IMPORTING.swap(true, Ordering::SeqCst) {
        return Err("import already running".into());
    }
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        let (mut page, mut pages, mut added) = (1u64, 1u64, 0usize);
        let mut error = None;
        while page <= pages {
            let mut p = BTreeMap::new();
            p.insert("user".into(), user.clone());
            p.insert("limit".into(), "200".into());
            p.insert("page".into(), page.to_string());
            let v = match call(&c, "user.getrecenttracks", p, false).await {
                Ok(v) => v,
                Err(e) => {
                    error = Some(e);
                    break;
                }
            };
            let (rows, total) = parse_recent(&v);
            pages = total.max(1);
            added += crate::db::import_plays("lastfm", &rows).unwrap_or(0);
            let _ = app.emit(
                "lastfm-import",
                serde_json::json!({ "page": page, "pages": pages, "added": added }),
            );
            page += 1;
            // Last.fm wpuszcza około pięciu zapytań na sekundę
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        let _ = app.emit(
            "lastfm-import",
            serde_json::json!({ "done": true, "added": added, "error": error }),
        );
        IMPORTING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn recent_tracks_skip_now_playing_and_accept_single_object() {
        let v = serde_json::json!({"recenttracks":{"@attr":{"totalPages":"3"},"track":[
            {"artist":{"#text":"A"},"name":"Now","@attr":{"nowplaying":"true"}},
            {"artist":{"#text":"B"},"name":"Old","album":{"#text":""},"date":{"uts":"100"}}
        ]}});
        let (rows, pages) = super::parse_recent(&v);
        assert_eq!(pages, 3);
        assert_eq!(rows, vec![("B".into(), "Old".into(), None, 100_000)]);
        let one = serde_json::json!({"recenttracks":{"track":{"artist":{"#text":"C"},"name":"X","date":{"uts":"5"}}}});
        assert_eq!(super::parse_recent(&one).0.len(), 1);
    }

    use super::*;
    #[test]
    fn signature_matches_spec_example() {
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
