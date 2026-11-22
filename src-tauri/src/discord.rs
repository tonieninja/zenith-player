use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::command;

struct Conn {
    id: String,
    user: String,
    client: DiscordIpcClient,
}

static CLIENT: Mutex<Option<Conn>> = Mutex::new(None);
static STATUS: Mutex<String> = Mutex::new(String::new());
static NONCE: AtomicU64 = AtomicU64::new(0);

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

const ICON: &str =
    "https://raw.githubusercontent.com/tonieninja/zenith-player/main/src-tauri/icons/128x128@2x.png";
const PAUSED_ICON: &str =
    "https://raw.githubusercontent.com/tonieninja/zenith-player/main/docs/discord/paused.png";
const REPO: &str = "https://github.com/tonieninja/zenith-player";
// Discord nie podaje limitów obrazów i linków; po 256 znakach inne klienty widzą odrzucone SET_ACTIVITY
const URL_MAX: usize = 256;
const BUTTON_URL_MAX: usize = 512;

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

fn set_status(s: String) {
    *STATUS.lock().unwrap_or_else(|p| p.into_inner()) = s;
}

// crate połyka odpowiedź na handshake, a zły ID dostaje CLOSE 4000 i wyglądał jak połączony
fn check_handshake(op: u32, v: &Value) -> Result<String, String> {
    if op == 1 && v["evt"] == "READY" {
        let u = &v["data"]["user"];
        let name = u["global_name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| u["username"].as_str());
        return Ok(name.unwrap_or_default().to_string());
    }
    if v["code"].as_u64() == Some(4000) {
        return Err("invalid-app-id".into());
    }
    Err(format!(
        "rejected:{}",
        v["message"].as_str().unwrap_or("handshake")
    ))
}

fn reply_for(v: &Value, nonce: &str) -> Option<Result<(), String>> {
    if v["nonce"].as_str() != Some(nonce) {
        return None;
    }
    if v["evt"] == "ERROR" {
        let msg = v["data"]["message"].as_str().unwrap_or("unknown");
        return Some(Err(format!("rejected:{msg}")));
    }
    Some(Ok(()))
}

// zewnętrzny Err to zerwany pipe (połączenie do wyrzucenia), wewnętrzny to odrzucony payload
fn exchange(client: &mut DiscordIpcClient, mut cmd: Value) -> Result<Result<(), String>, String> {
    let nonce = format!("{}-{}", now_millis(), NONCE.fetch_add(1, Ordering::Relaxed));
    cmd["nonce"] = json!(nonce);
    client.send(cmd, 1).map_err(|e| e.to_string())?;
    // shortcut: odczyt blokuje bez limitu (synchroniczny pipe); przy zgłoszeniach zawieszeń wątek z recv_timeout
    loop {
        let (op, v) = client.recv().map_err(|e| e.to_string())?;
        match op {
            2 => return Err(v["message"].as_str().unwrap_or("closed").to_string()),
            3 => client.send(v, 4).map_err(|e| e.to_string())?,
            _ => {
                if let Some(r) = reply_for(&v, &nonce) {
                    return Ok(r);
                }
            }
        }
    }
}

fn ensure_connected(guard: &mut Option<Conn>, client_id: &str) -> Result<(), String> {
    if guard.as_ref().is_some_and(|c| c.id == client_id) {
        return Ok(());
    }
    if let Some(mut old) = guard.take() {
        let _ = old.client.close();
    }
    let mut client =
        DiscordIpcClient::new(client_id).map_err(|e| format!("Discord client init failed: {e}"))?;
    if let Err(e) = client.connect_ipc() {
        set_status("no-discord".into());
        return Err(format!("Discord connect failed (is Discord running?): {e}"));
    }
    let shake = client
        .send(json!({ "v": 1, "client_id": client_id }), 0)
        .and_then(|_| client.recv())
        .map_err(|e| e.to_string())
        .and_then(|(op, v)| check_handshake(op, &v));
    match shake {
        Ok(user) => {
            set_status(format!("connected:{user}"));
            *guard = Some(Conn {
                id: client_id.to_string(),
                user,
                client,
            });
            Ok(())
        }
        Err(e) => {
            let _ = client.close();
            set_status(e.clone());
            Err(e)
        }
    }
}

// okładki z lh3/yt3 przychodzą jako 544 px; Discord pokazuje je większe w profilu, więc prosimy o 1024
fn big_cover(u: &str) -> String {
    let google = u.contains(".googleusercontent.com/") || u.contains(".ggpht.com/");
    match u.rfind('=') {
        Some(i)
            if google
                && u[i + 1..].starts_with(['w', 's'])
                && u[i + 2..].starts_with(|c: char| c.is_ascii_digit()) =>
        {
            format!("{}=w1024-h1024-l90-rj", &u[..i])
        }
        _ => u.to_string(),
    }
}

fn build_activity(p: &PresencePayload, now_ms: i64) -> Value {
    let link = |u: Option<&str>, max: usize| {
        u.filter(|u| u.starts_with("https://") && u.len() <= max)
            .map(str::to_string)
    };
    let track_url = link(p.track_url.as_deref(), URL_MAX);
    let artist = p.artist.trim();
    let artist_url = (!artist.is_empty())
        .then(|| format!("https://music.youtube.com/search?q={}", url_encode(artist)))
        .filter(|u| u.len() <= URL_MAX);
    let context = p
        .context
        .as_deref()
        .filter(|c| !c.trim().is_empty())
        .unwrap_or("Zenith");
    let cover = link(p.cover_url.as_deref(), URL_MAX)
        .map(|c| big_cover(&c))
        .filter(|c| c.len() <= URL_MAX);

    // status_display_type 2: lista członków pokazuje „Słucha <tytuł>” zamiast nazwy aplikacji
    let mut a = json!({
        "type": 2,
        "status_display_type": 2,
        "details": fit(&p.title),
        "state": fit(artist),
        "assets": {
            "large_image": cover.as_deref().unwrap_or(ICON),
            "large_text": fit(context),
        },
    });
    if !p.is_playing {
        a["assets"]["small_image"] = json!(PAUSED_ICON);
        a["assets"]["small_text"] = json!("Paused");
    } else if cover.is_some() {
        a["assets"]["small_image"] = json!(ICON);
        a["assets"]["small_text"] = json!("Zenith");
    }
    if let Some(u) = &track_url {
        a["details_url"] = json!(u);
        a["assets"]["large_url"] = json!(u);
    }
    if let Some(u) = &artist_url {
        a["state_url"] = json!(u);
    }
    if p.is_playing && p.duration.is_finite() && p.duration > 0.0 {
        let start = now_ms - (p.position.max(0.0) * 1000.0) as i64;
        let end = start + (p.duration * 1000.0) as i64;
        a["timestamps"] = json!({ "start": start, "end": end });
    }
    let mut buttons = Vec::new();
    if let Some(u) = link(p.track_url.as_deref(), BUTTON_URL_MAX) {
        buttons.push(json!({ "label": "Listen on YouTube Music", "url": u }));
    }
    buttons.push(json!({ "label": "Get Zenith", "url": REPO }));
    a["buttons"] = json!(buttons);
    a
}

fn set_activity(conn: &mut Option<Conn>, activity: Value) -> Result<(), String> {
    let Some(c) = conn.as_mut() else {
        return Ok(());
    };
    // surowe SET_ACTIVITY, bo builder w crate nie zna pól *_url ani status_display_type
    let cmd = json!({
        "cmd": "SET_ACTIVITY",
        "args": { "pid": std::process::id(), "activity": activity },
    });
    match exchange(&mut c.client, cmd) {
        Ok(Ok(())) => {
            set_status(format!("connected:{}", c.user));
            Ok(())
        }
        Ok(Err(rejected)) => {
            set_status(rejected.clone());
            Err(rejected)
        }
        Err(io) => {
            if let Some(mut dead) = conn.take() {
                let _ = dead.client.close();
            }
            set_status("no-discord".into());
            Err(format!("Discord set_activity failed: {io}"))
        }
    }
}

#[command(async)]
pub fn discord_update_presence(payload: PresencePayload) -> Result<(), String> {
    let mut guard = CLIENT
        .lock()
        .map_err(|e| format!("Discord lock error: {e}"))?;
    ensure_connected(&mut guard, &payload.client_id)?;
    set_activity(&mut guard, build_activity(&payload, now_millis()))
}

#[command(async)]
pub fn discord_clear_presence() -> Result<(), String> {
    let mut guard = CLIENT
        .lock()
        .map_err(|e| format!("Discord lock error: {e}"))?;
    let _ = set_activity(&mut guard, Value::Null);
    Ok(())
}

#[command(async)]
pub fn discord_disconnect() -> Result<(), String> {
    let mut guard = CLIENT
        .lock()
        .map_err(|e| format!("Discord lock error: {e}"))?;
    let _ = set_activity(&mut guard, Value::Null);
    if let Some(mut c) = guard.take() {
        let _ = c.client.close();
    }
    set_status(String::new());
    Ok(())
}

#[command]
pub fn discord_status() -> String {
    STATUS.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(playing: bool) -> PresencePayload {
        PresencePayload {
            client_id: "1".into(),
            title: "Sonne".into(),
            artist: "Rammstein".into(),
            duration: 272.0,
            position: 10.0,
            is_playing: playing,
            cover_url: Some("https://lh3.googleusercontent.com/abc=w544-h544-l90-rj".into()),
            track_url: Some("https://music.youtube.com/watch?v=StZcUAPRRac".into()),
            context: Some("Liked songs".into()),
        }
    }

    // ręcznie przy działającym Discordzie: cargo test --lib discord::tests::live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live() {
        let mut p = payload(true);
        p.client_id = "1514342633374486709".into();
        let r = discord_update_presence(p);
        println!("play: {r:?} status={}", discord_status());
        std::thread::sleep(std::time::Duration::from_secs(3));
        let mut p = payload(false);
        p.client_id = "1514342633374486709".into();
        let r = discord_update_presence(p);
        println!("pause: {r:?} status={}", discord_status());
        std::thread::sleep(std::time::Duration::from_secs(2));
        println!("disconnect: {:?}", discord_disconnect());
        let mut p = payload(true);
        p.client_id = "123".into();
        println!(
            "bad id: {:?} status={}",
            discord_update_presence(p),
            discord_status()
        );
        let _ = discord_disconnect();
    }

    #[test]
    fn fit_keeps_discord_text_limits() {
        assert_eq!(fit("A").chars().count(), 2);
        assert_eq!(fit("  Song  "), "Song");
        assert_eq!(fit(&"x".repeat(300)).len(), 128);
        assert!(fit(&"🎵".repeat(100)).encode_utf16().count() <= 128);
    }

    #[test]
    fn handshake_answers_are_checked() {
        let ready =
            json!({"evt": "READY", "data": {"user": {"username": "u", "global_name": "Ola"}}});
        assert_eq!(check_handshake(1, &ready).as_deref(), Ok("Ola"));
        let bad = json!({"code": 4000, "message": "Invalid Client ID"});
        assert_eq!(check_handshake(2, &bad), Err("invalid-app-id".into()));
        assert!(check_handshake(1, &json!({"evt": "ERROR"})).is_err());
    }

    #[test]
    fn replies_match_our_nonce_and_report_rejections() {
        assert_eq!(reply_for(&json!({"nonce": "other"}), "n1"), None);
        assert_eq!(
            reply_for(&json!({"nonce": "n1", "evt": null}), "n1"),
            Some(Ok(()))
        );
        let err = json!({"nonce": "n1", "evt": "ERROR", "data": {"message": "bad"}});
        assert_eq!(reply_for(&err, "n1"), Some(Err("rejected:bad".into())));
    }

    #[test]
    fn playing_card_has_progress_big_cover_and_buttons() {
        let a = build_activity(&payload(true), 1_000_000);
        assert_eq!(a["type"], 2);
        let t = &a["timestamps"];
        assert_eq!(
            t["end"].as_i64().unwrap() - t["start"].as_i64().unwrap(),
            272_000
        );
        assert_eq!(t["start"], 990_000);
        assert!(a["assets"]["large_image"]
            .as_str()
            .unwrap()
            .ends_with("=w1024-h1024-l90-rj"));
        assert_eq!(a["assets"]["small_image"], ICON);
        assert_eq!(a["assets"]["large_text"], "Liked songs");
        let b = a["buttons"].as_array().unwrap();
        assert_eq!(b.len(), 2);
        assert!(b.iter().all(|b| b["label"].as_str().unwrap().len() <= 32));
    }

    #[test]
    fn paused_card_keeps_context_and_drops_progress() {
        let a = build_activity(&payload(false), 1_000_000);
        assert!(a.get("timestamps").is_none());
        assert_eq!(a["assets"]["small_image"], PAUSED_ICON);
        assert_eq!(a["assets"]["small_text"], "Paused");
        assert_eq!(a["assets"]["large_text"], "Liked songs");
    }

    #[test]
    fn long_or_plain_links_are_left_out() {
        let mut p = payload(true);
        p.cover_url = Some(format!("https://x.com/{}", "a".repeat(300)));
        p.artist = "東京事変".repeat(10);
        let a = build_activity(&p, 0);
        assert_eq!(a["assets"]["large_image"], ICON);
        assert!(a["assets"].get("small_image").is_none());
        assert!(a.get("state_url").is_none());
        p.cover_url = Some("http://insecure/cover.jpg".into());
        assert_eq!(build_activity(&p, 0)["assets"]["large_image"], ICON);
        let yt = "https://i.ytimg.com/vi/x/hqdefault.jpg";
        assert_eq!(big_cover(yt), yt);
    }
}
