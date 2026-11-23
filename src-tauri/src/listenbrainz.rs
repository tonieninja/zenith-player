use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const API: &str = "https://api.listenbrainz.org/1";

#[derive(Serialize, Deserialize, Default, Clone)]
struct Creds {
    token: String,
    user: String,
}

static CACHE: Mutex<Option<Creds>> = Mutex::new(None);

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("listenbrainz.bin"))
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

fn client() -> Result<crate::player::Http, String> {
    crate::player::client(concat!("Zenith/", env!("CARGO_PKG_VERSION")), 12, true)
        .ok_or_else(|| "http client".to_string())
}

async fn reply(res: reqwest::Response) -> Result<Value, String> {
    let status = res.status().as_u16();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let msg = v.get("error").and_then(Value::as_str).unwrap_or("");
        return Err(format!("listenbrainz {status}: {msg}"));
    }
    Ok(v)
}

#[derive(Serialize)]
pub struct ListenbrainzStatus {
    user: Option<String>,
}

fn status_of(c: &Creds) -> ListenbrainzStatus {
    ListenbrainzStatus {
        user: (!c.token.is_empty()).then(|| c.user.clone()),
    }
}

#[tauri::command]
pub fn listenbrainz_status(app: AppHandle) -> ListenbrainzStatus {
    status_of(&load(&app))
}

#[tauri::command]
pub async fn listenbrainz_set_token(
    app: AppHandle,
    token: String,
) -> Result<ListenbrainzStatus, String> {
    let token = token.trim().to_string();
    if token.is_empty() || token.len() > 100 || !token.chars().all(|c| c.is_ascii_graphic()) {
        return Err("listenbrainz 401: invalid token".into());
    }
    let v = reply(
        client()?
            .get(format!("{API}/validate-token"))
            .header("Authorization", format!("Token {token}"))
            .send()
            .await
            .map_err(|e| e.to_string())?,
    )
    .await?;
    if v.get("valid").and_then(Value::as_bool) != Some(true) {
        return Err("listenbrainz 401: invalid token".into());
    }
    let user = v
        .get("user_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let c = Creds { token, user };
    save(&app, &c)?;
    Ok(status_of(&c))
}

#[tauri::command]
pub fn listenbrainz_logout(app: AppHandle) -> Result<ListenbrainzStatus, String> {
    let c = Creds::default();
    save(&app, &c)?;
    Ok(status_of(&c))
}

#[derive(Deserialize)]
pub struct Listen {
    artist: String,
    track: String,
    album: Option<String>,
    duration: Option<u32>,
    timestamp: Option<u64>,
    video_id: Option<String>,
}

fn listen_body(t: &Listen, playing_now: bool) -> Value {
    let clip = |s: &str| s.chars().take(300).collect::<String>();
    let mut info = json!({
        "media_player": "Zenith",
        "submission_client": "Zenith",
        "submission_client_version": env!("CARGO_PKG_VERSION"),
        "music_service": "youtube.com",
    });
    if let Some(d) = t.duration.filter(|d| *d > 0) {
        info["duration_ms"] = json!(d as u64 * 1000);
    }
    if let Some(id) = t.video_id.as_ref().filter(|id| id.len() == 11) {
        info["origin_url"] = json!(format!("https://music.youtube.com/watch?v={id}"));
    }
    let mut meta = json!({
        "artist_name": clip(&t.artist),
        "track_name": clip(&t.track),
        "additional_info": info,
    });
    if let Some(a) = t.album.as_ref().filter(|a| !a.is_empty()) {
        meta["release_name"] = json!(clip(a));
    }
    let mut listen = json!({ "track_metadata": meta });
    if !playing_now {
        listen["listened_at"] = json!(t.timestamp.unwrap_or(0));
    }
    json!({
        "listen_type": if playing_now { "playing_now" } else { "single" },
        "payload": [listen],
    })
}

async fn submit(app: &AppHandle, t: &Listen, playing_now: bool) -> Result<(), String> {
    let c = load(app);
    if c.token.is_empty() {
        return if playing_now {
            Ok(())
        } else {
            Err("not connected".into())
        };
    }
    reply(
        client()?
            .post(format!("{API}/submit-listens"))
            .header("Authorization", format!("Token {}", c.token))
            .json(&listen_body(t, playing_now))
            .send()
            .await
            .map_err(|e| e.to_string())?,
    )
    .await
    .map(|_| ())
}

#[tauri::command]
pub async fn listenbrainz_now_playing(app: AppHandle, t: Listen) -> Result<(), String> {
    submit(&app, &t, true).await
}

#[tauri::command]
pub async fn listenbrainz_submit(app: AppHandle, t: Listen) -> Result<(), String> {
    submit(&app, &t, false).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_listens_carry_a_timestamp_and_playing_now_does_not() {
        let t = Listen {
            artist: "The Weeknd".into(),
            track: "Blinding Lights".into(),
            album: Some(String::new()),
            duration: Some(200),
            timestamp: Some(1_700_000_000),
            video_id: Some("4NRXx6U8ABQ".into()),
        };
        let single = listen_body(&t, false);
        assert_eq!(single["listen_type"], "single");
        assert_eq!(single["payload"][0]["listened_at"], 1_700_000_000);
        let meta = &single["payload"][0]["track_metadata"];
        assert_eq!(meta["track_name"], "Blinding Lights");
        assert!(meta.get("release_name").is_none());
        assert_eq!(meta["additional_info"]["duration_ms"], 200_000);
        assert_eq!(
            meta["additional_info"]["origin_url"],
            "https://music.youtube.com/watch?v=4NRXx6U8ABQ"
        );
        let now = listen_body(&t, true);
        assert_eq!(now["listen_type"], "playing_now");
        assert!(now["payload"][0].get("listened_at").is_none());
    }
}
