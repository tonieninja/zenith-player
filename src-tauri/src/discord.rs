use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use discord_rich_presence::activity::{Activity, ActivityType, Assets, Button, Timestamps};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde::Deserialize;
use tauri::command;

static CLIENT: Mutex<Option<(String, DiscordIpcClient)>> = Mutex::new(None);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresencePayload {
    pub client_id: String,
    pub title: String,
    pub artist: String,
    /// track length in seconds
    pub duration: f64,
    /// where we are in the track, seconds
    pub position: f64,
    pub is_playing: bool,
    pub cover_url: Option<String>,
    pub track_url: Option<String>,
}

fn url_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn ensure_connected(
    guard: &mut Option<(String, DiscordIpcClient)>,
    client_id: &str,
) -> Result<(), String> {
    let needs_new = match guard.as_ref() {
        Some((id, _)) => id != client_id,
        None => true,
    };
    if needs_new {
        if let Some((_, mut old)) = guard.take() {
            let _ = old.close();
        }
        let mut client = DiscordIpcClient::new(client_id)
            .map_err(|e| format!("Discord client init failed: {e}"))?;
        client
            .connect()
            .map_err(|e| format!("Discord connect failed (is Discord running?): {e}"))?;
        *guard = Some((client_id.to_string(), client));
    }
    Ok(())
}

#[command]
pub fn discord_update_presence(payload: PresencePayload) -> Result<(), String> {
    let mut guard = CLIENT
        .lock()
        .map_err(|e| format!("Discord lock error: {e}"))?;
    ensure_connected(&mut guard, &payload.client_id)?;
    let (_, client) = guard.as_mut().expect("client connected above");

    // discord wants details/state at least 2 chars, pad the short ones
    let title = if payload.title.trim().len() < 2 {
        format!("{}  ", payload.title)
    } else {
        payload.title.clone()
    };
    let artist = if payload.artist.trim().len() < 2 {
        format!("{}  ", payload.artist)
    } else {
        payload.artist.clone()
    };

    let mut activity = Activity::new()
        .activity_type(ActivityType::Listening)
        .details(&title)
        .state(&artist);

    // hover the big cover = "Title - Artist", hover the little badge = playing/paused
    let large_text = format!("{title} - {artist}");
    let small_image =
        "https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/youtube-music.png";
    let small_text = if payload.is_playing {
        "Playing on Zenith"
    } else {
        "Paused"
    };
    let mut assets = Assets::new()
        .large_text(&large_text)
        .small_image(small_image)
        .small_text(small_text);
    if let Some(cover) = payload.cover_url.as_deref() {
        assets = assets.large_image(cover);
    }
    activity = activity.assets(assets);

    // timestamps give discord the bar, we skip them while paused cause discord has no paused state
    if payload.is_playing && payload.duration > 0.0 && payload.duration.is_finite() {
        let now = now_millis();
        let start = now - (payload.position.max(0.0) * 1000.0) as i64;
        let end = start + (payload.duration * 1000.0) as i64;
        activity = activity.timestamps(Timestamps::new().start(start).end(end));
    }

    let mut buttons: Vec<Button> = Vec::new();
    if let Some(url) = payload.track_url.as_deref() {
        if url.starts_with("https://") {
            buttons.push(Button::new("▶ Listen on YouTube Music", url));
        }
    }
    let artist_query: String = url_encode(&payload.artist);
    let artist_url = format!("https://music.youtube.com/search?q={artist_query}");
    if buttons.len() < 2 && !payload.artist.trim().is_empty() {
        buttons.push(Button::new("More from this artist", &artist_url));
    }
    if !buttons.is_empty() {
        activity = activity.buttons(buttons);
    }

    if let Err(e) = client.set_activity(activity) {
        // connection probably died (discord closed), drop it so the next call reconnects
        if let Some((_, mut dead)) = guard.take() {
            let _ = dead.close();
        }
        return Err(format!("Discord set_activity failed: {e}"));
    }
    Ok(())
}

#[command]
pub fn discord_clear_presence() -> Result<(), String> {
    let mut guard = CLIENT
        .lock()
        .map_err(|e| format!("Discord lock error: {e}"))?;
    if let Some((_, client)) = guard.as_mut() {
        if client.clear_activity().is_err() {
            if let Some((_, mut dead)) = guard.take() {
                let _ = dead.close();
            }
        }
    }
    Ok(())
}

#[command]
pub fn discord_disconnect() -> Result<(), String> {
    let mut guard = CLIENT
        .lock()
        .map_err(|e| format!("Discord lock error: {e}"))?;
    if let Some((_, mut client)) = guard.take() {
        let _ = client.clear_activity();
        let _ = client.close();
    }
    Ok(())
}
