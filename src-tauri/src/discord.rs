use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde::Deserialize;
use serde_json::json;
use tauri::command;

static CLIENT: Mutex<Option<(String, DiscordIpcClient)>> = Mutex::new(None);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresencePayload {
    pub client_id: String,
    pub title: String,
    pub artist: String,
    pub duration: f64,
    pub position: f64,
    pub is_playing: bool,
    pub cover_url: Option<String>,
    pub track_url: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
}

const YTM_ICON: &str =
    "https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/youtube-music.png";

// Discord odrzuca całe SET_ACTIVITY, gdy tekst ma mniej niż 2 albo więcej niż 128 jednostek UTF-16
fn fit(s: &str) -> String {
    let mut n = 0;
    let mut out: String = s
        .trim()
        .chars()
        .take_while(|c| {
            n += c.len_utf16();
            n <= 128
        })
        .collect();
    while out.chars().count() < 2 {
        out.push('\u{2800}');
    }
    out
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

#[command(async)]
pub fn discord_update_presence(payload: PresencePayload) -> Result<(), String> {
    let mut guard = CLIENT
        .lock()
        .map_err(|e| format!("Discord lock error: {e}"))?;
    ensure_connected(&mut guard, &payload.client_id)?;
    let (_, client) = guard.as_mut().expect("client connected above");

    let title = fit(&payload.title);
    let artist = fit(&payload.artist);
    let https = |u: Option<&str>| u.filter(|u| u.starts_with("https://")).map(str::to_string);
    let track_url = https(payload.track_url.as_deref());
    let has_artist = !payload.artist.trim().is_empty();
    let artist_url = format!(
        "https://music.youtube.com/search?q={}",
        url_encode(payload.artist.trim())
    );
    let context = payload
        .context
        .as_deref()
        .filter(|c| !c.trim().is_empty())
        .unwrap_or("Zenith Player");
    let large_text = fit(if payload.is_playing {
        context
    } else {
        "Paused"
    });

    // status_display_type 2: lista członków pokazuje "Słucha <tytuł>" zamiast nazwy aplikacji
    let mut activity = json!({
        "type": 2,
        "status_display_type": 2,
        "details": title,
        "state": artist,
        "assets": { "large_text": large_text },
    });
    if let Some(cover) = https(payload.cover_url.as_deref()) {
        activity["assets"]["large_image"] = json!(cover);
    }
    if payload.is_playing {
        activity["assets"]["small_image"] = json!(YTM_ICON);
        activity["assets"]["small_text"] = json!("Zenith Player");
    }
    if let Some(u) = &track_url {
        activity["details_url"] = json!(u);
        activity["assets"]["large_url"] = json!(u);
    }
    if has_artist {
        activity["state_url"] = json!(artist_url);
    }
    if payload.is_playing && payload.duration.is_finite() && payload.duration > 0.0 {
        let start = now_millis() - (payload.position.max(0.0) * 1000.0) as i64;
        let end = start + (payload.duration * 1000.0) as i64;
        activity["timestamps"] = json!({ "start": start, "end": end });
    }
    let mut buttons = Vec::new();
    if let Some(u) = &track_url {
        buttons.push(json!({ "label": "Listen on YouTube Music", "url": u }));
    }
    if has_artist {
        buttons.push(json!({ "label": "More from this artist", "url": artist_url }));
    }
    if !buttons.is_empty() {
        activity["buttons"] = json!(buttons);
    }

    // surowe SET_ACTIVITY, bo builder w crate nie zna pól *_url ani status_display_type
    let data = json!({
        "cmd": "SET_ACTIVITY",
        "args": { "pid": std::process::id(), "activity": activity },
        "nonce": now_millis().to_string(),
    });
    if let Err(e) = client.send(data, 1) {
        if let Some((_, mut dead)) = guard.take() {
            let _ = dead.close();
        }
        return Err(format!("Discord set_activity failed: {e}"));
    }
    Ok(())
}

#[command(async)]
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

#[command(async)]
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

#[cfg(test)]
mod tests {
    use super::fit;

    #[test]
    fn fit_keeps_discord_text_limits() {
        assert_eq!(fit("A").chars().count(), 2);
        assert_eq!(fit("  Song  "), "Song");
        assert_eq!(fit(&"x".repeat(300)).len(), 128);
        assert!(fit(&"🎵".repeat(100)).encode_utf16().count() <= 128);
    }
}
