// Wtyczki, które bez okna robi Rust: scrobbling, webhook, statystyki, SponsorBlock i wyłącznik czasowy.
// Konfiguracja przychodzi w planie od JS (`plugins`), a stan wraca do JS przy odbudowie okna.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use super::Snapshot;

pub enum Act {
    Seek(f64),
    Pause,
    Next,
}

#[derive(Default)]
struct Listen {
    id: String,
    title: String,
    artist: String,
    album: String,
    cover: String,
    duration: f64,
    start_ms: u64,
    listened: f64,
    since: Option<Instant>,
    done: bool,
}

#[derive(Default)]
struct Seg {
    start: f64,
    end: f64,
    video: f64,
}

#[derive(Default)]
struct St {
    cfg: Value,
    cur: Option<Listen>,
    stats_total: f64,
    stats_per: HashMap<String, f64>,
    stats_sessions: u32,
    stats_since: Option<Instant>,
    failed: Vec<Value>,
    // None: zapytanie w drodze albo nieudane, ponowienie po minucie
    segs: HashMap<String, Option<Vec<Seg>>>,
    seg_retry: HashMap<String, Instant>,
    kept: Vec<(f64, f64)>,
    last_jump: f64,
    sleep_ends: u64,
    // stan do oddania istnieje dopiero po wejściu w tryb bez okna; plan od JS sam go nie tworzy
    active: bool,
    skipped_for: String,
    // kolejka z samymi zablokowanymi nie może przewijać się bez końca, jak MAX_SKIPS w JS
    skips: u32,
}

static ST: Mutex<Option<St>> = Mutex::new(None);

fn st<R>(f: impl FnOnce(&mut St) -> R) -> R {
    let mut g = ST.lock().unwrap_or_else(|p| p.into_inner());
    f(g.get_or_insert_with(St::default))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn on(cfg: &Value, k: &str) -> bool {
    cfg[k].as_bool().unwrap_or(false)
}

pub fn scrobble_threshold(d: f64) -> f64 {
    (d / 2.0).min(240.0)
}

pub fn configure(plugins: &Value) {
    st(|s| s.cfg = plugins.clone());
}

fn listen_of(track: &Value, playing: bool) -> Listen {
    let s = |k: &str| track[k].as_str().unwrap_or("").to_string();
    Listen {
        id: s("id"),
        title: s("title"),
        artist: s("artist"),
        album: s("album"),
        cover: [s("coverLarge"), s("cover")]
            .into_iter()
            .find(|c| !c.is_empty())
            .unwrap_or_default(),
        duration: track["durationSec"].as_f64().unwrap_or(0.0),
        start_ms: now_ms(),
        since: playing.then(Instant::now),
        ..Default::default()
    }
}

fn tally(s: &mut St) {
    if let Some(c) = s.cur.as_mut() {
        if let Some(t) = c.since {
            c.listened += t.elapsed().as_secs_f64();
            c.since = Some(Instant::now());
        }
    }
    if let Some(t) = s.stats_since {
        let d = t.elapsed().as_secs_f64();
        s.stats_since = Some(Instant::now());
        // jak w JS: dłuższa przerwa między tyknięciami to uśpiony komputer, a nie słuchanie
        if on(&s.cfg, "stats") && d > 0.0 && d <= 120.0 {
            if let Some(id) = s
                .cur
                .as_ref()
                .map(|c| c.id.clone())
                .filter(|i| !i.is_empty())
            {
                s.stats_total += d;
                *s.stats_per.entry(id).or_insert(0.0) += d / 60.0;
            }
        }
    }
}

fn scrobble_json(c: &Listen) -> Value {
    json!({
        "artist": c.artist,
        "track": c.title,
        "duration": c.duration.round() as u64,
        "timestamp": c.start_ms / 1000,
        "video_id": c.id,
    })
}

fn maybe_scrobble(s: &mut St) {
    let Some(c) = s.cur.as_mut() else { return };
    // jak w JS: odsłuch bez wykonawcy lub tytułu serwisy odrzucają na stałe
    if c.done
        || c.duration <= 30.0
        || c.listened < scrobble_threshold(c.duration)
        || c.artist.trim().is_empty()
        || c.title.trim().is_empty()
    {
        return;
    }
    c.done = true;
    let body = scrobble_json(c);
    let lastfm = on(&s.cfg, "lastfm");
    let lb = on(&s.cfg, "listenbrainz");
    let Some(app) = super::engine().and_then(|e| e.app.clone()) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let mut failed = Vec::new();
        if lastfm {
            let t = serde_json::from_value(body.clone());
            let ok = match t {
                Ok(t) => crate::lastfm::lastfm_scrobble(app.clone(), t).await.is_ok(),
                Err(_) => false,
            };
            if !ok {
                failed.push(json!({ "service": "lastfm", "s": body }));
            }
        }
        if lb {
            let t = serde_json::from_value(body.clone());
            let ok = match t {
                Ok(t) => crate::listenbrainz::listenbrainz_submit(app.clone(), t)
                    .await
                    .is_ok(),
                Err(_) => false,
            };
            if !ok {
                failed.push(json!({ "service": "listenbrainz", "s": body }));
            }
        }
        if !failed.is_empty() {
            st(|s| {
                s.failed.extend(failed);
                let n = s.failed.len();
                // jak kolejka w JS: przy długim braku sieci zostaje 50 najnowszych
                if n > 50 {
                    s.failed.drain(..n - 50);
                }
            });
        }
    });
}

fn announce_track(cfg: &Value, c: &Listen) {
    let Some(app) = super::engine().and_then(|e| e.app.clone()) else {
        return;
    };
    let lastfm = on(cfg, "lastfm");
    let lb = on(cfg, "listenbrainz");
    let hook = cfg["webhook"].as_str().map(String::from);
    if c.artist.is_empty() || c.title.is_empty() {
        return;
    }
    let np = json!({
        "artist": c.artist,
        "track": c.title,
        "duration": (c.duration > 0.0).then(|| c.duration.round() as u64),
        "video_id": c.id,
    });
    let hook_body = json!({
        "event": "track_change",
        "title": c.title,
        "artist": c.artist,
        "id": c.id,
        "position": 0,
        "duration": c.duration,
        "isPlaying": true,
        "coverUrl": c.cover,
        "timestamp": now_ms(),
    })
    .to_string();
    tauri::async_runtime::spawn(async move {
        if lastfm {
            if let Ok(t) = serde_json::from_value(np.clone()) {
                let _ = crate::lastfm::lastfm_now_playing(app.clone(), t).await;
            }
        }
        if lb {
            if let Ok(t) = serde_json::from_value(np) {
                let _ = crate::listenbrainz::listenbrainz_now_playing(app.clone(), t).await;
            }
        }
        if let Some(url) = hook {
            let _ = crate::send_webhook(&url, hook_body).await;
        }
    });
}

/// Okno właśnie zniknęło: bieżący utwór gra dalej, więc licznik odsłuchu przejmujemy od JS.
pub fn began(track: &Value, playing: bool) {
    st(|s| {
        let mut c = listen_of(track, playing);
        let h = &s.cfg["handoff"];
        if h["id"].as_str() == Some(c.id.as_str()) {
            c.listened = h["listened"].as_f64().unwrap_or(0.0);
            c.done = h["done"].as_bool().unwrap_or(false);
            c.start_ms = h["start"].as_u64().unwrap_or(c.start_ms);
            if let Some(d) = h["duration"].as_f64().filter(|d| *d > 0.0) {
                c.duration = d;
            }
        }
        s.cur = Some(c);
        s.active = true;
        s.stats_since = playing.then(Instant::now);
        s.sleep_ends = s.cfg["sleep"]["endsAt"].as_u64().unwrap_or(0);
        s.kept.clear();
        s.last_jump = f64::NAN;
    });
}

pub fn track_started(track: &Value) {
    st(|s| {
        tally(s);
        maybe_scrobble(s);
        let c = listen_of(track, true);
        if on(&s.cfg, "stats") && !c.id.is_empty() {
            s.stats_sessions += 1;
        }
        announce_track(&s.cfg, &c);
        s.cur = Some(c);
        s.stats_since = Some(Instant::now());
        s.kept.clear();
        s.last_jump = f64::NAN;
    });
}

pub fn play_state(playing: bool) {
    st(|s| {
        tally(s);
        maybe_scrobble(s);
        if let Some(c) = s.cur.as_mut() {
            c.since = if playing {
                c.since.or_else(|| Some(Instant::now()))
            } else {
                None
            };
        }
        s.stats_since = if playing {
            s.stats_since.or_else(|| Some(Instant::now()))
        } else {
            None
        };
        // jak w JS: po wygaśnięciu licznik startuje od nowa przy następnym odtworzeniu
        if playing && s.sleep_ends == 0 {
            if let Some(m) = s.cfg["sleep"]["mins"].as_f64().filter(|m| *m > 0.0) {
                s.sleep_ends = now_ms() + (m * 60_000.0) as u64;
            }
        }
    });
}

/// Mini odtwarzacz przewinął w środek fragmentu: użytkownik chce go usłyszeć.
pub fn on_seek(t: f64) {
    st(|s| {
        if t == s.last_jump {
            return;
        }
        let Some(id) = s.cur.as_ref().map(|c| c.id.clone()) else {
            return;
        };
        if let Some(Some(segs)) = s.segs.get(&id) {
            let hit: Vec<(f64, f64)> = segs
                .iter()
                .filter(|g| t >= g.start && t < g.end)
                .map(|g| (g.start, g.end))
                .collect();
            s.kept.extend(hit);
        }
    });
}

pub fn tick(snap: &Snapshot) -> Option<Act> {
    st(|s| {
        tally(s);
        let d = snap.d.unwrap_or(0.0);
        if let Some(c) = s.cur.as_mut() {
            if d > 0.0 {
                c.duration = d;
            }
            // pętla jednego utworu: powrót na start po przesłuchaniu to nowe odtworzenie
            let since_start = now_ms().saturating_sub(c.start_ms) as f64 / 1000.0;
            if c.done && snap.t < 3.0 && d > 0.0 && since_start >= d - 5.0 {
                use std::mem::take;
                *c = Listen {
                    id: take(&mut c.id),
                    title: take(&mut c.title),
                    artist: take(&mut c.artist),
                    album: take(&mut c.album),
                    cover: take(&mut c.cover),
                    duration: c.duration,
                    start_ms: now_ms(),
                    since: c.since,
                    ..Default::default()
                };
            }
        }
        maybe_scrobble(s);
        if let Some(a) = skip_blocked(s) {
            return Some(a);
        }
        if s.sleep_ends > 0 && now_ms() >= s.sleep_ends {
            s.sleep_ends = 0;
            if !snap.paused {
                return Some(Act::Pause);
            }
        }
        if !on(&s.cfg, "sponsorblock") || snap.paused {
            return None;
        }
        sponsor_jump(s, snap.t, d)
    })
}

// JS liczy listę z kolejki: wykonawcy zablokowani ręcznie i artyści z listy muzyki AI
fn skip_blocked(s: &mut St) -> Option<Act> {
    let id = s.cur.as_ref()?.id.clone();
    if id.is_empty() || s.skipped_for == id {
        return None;
    }
    let listed = s.cfg["skip"]
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(id.as_str())));
    if !listed {
        s.skips = 0;
        return None;
    }
    s.skipped_for = id;
    s.skips += 1;
    (s.skips <= 10).then_some(Act::Next)
}

fn sponsor_jump(s: &mut St, t: f64, d: f64) -> Option<Act> {
    let id = s.cur.as_ref()?.id.clone();
    let valid = id.len() == 11
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid || d <= 0.0 || !t.is_finite() {
        return None;
    }
    match s.segs.get(&id) {
        Some(Some(segs)) => {
            for g in segs {
                // fragment z innej wersji filmu przeskoczyłby nie to miejsce
                if g.video > 0.0 && (g.video - d).abs() > 3.0 {
                    continue;
                }
                if g.end - g.start >= 0.9 * d || s.kept.contains(&(g.start, g.end)) {
                    continue;
                }
                if t >= g.start && t < g.end - 0.3 {
                    let to = if g.end >= d - 1.0 { d - 0.25 } else { g.end };
                    s.last_jump = to;
                    return Some(Act::Seek(to));
                }
            }
            None
        }
        Some(None) => {
            if s.seg_retry
                .get(&id)
                .is_some_and(|at| at.elapsed().as_secs() >= 60)
            {
                s.segs.remove(&id);
            }
            None
        }
        None => {
            if s.segs.len() > 300 {
                s.segs.clear();
            }
            s.segs.insert(id.clone(), None);
            s.seg_retry.insert(id.clone(), Instant::now());
            tauri::async_runtime::spawn(load_segments(id));
            None
        }
    }
}

const SB_CATEGORIES: &str = r#"["music_offtopic","sponsor","selfpromo","interaction"]"#;

pub fn parse_segments(v: &Value, id: &str) -> Vec<(f64, f64, f64)> {
    let Some(video) = v
        .as_array()
        .and_then(|a| a.iter().find(|x| x["videoID"].as_str() == Some(id)))
    else {
        return Vec::new();
    };
    let cats: Vec<&str> = vec!["music_offtopic", "sponsor", "selfpromo", "interaction"];
    let mut out: Vec<(f64, f64, f64)> = video["segments"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .filter(|g| g["actionType"].as_str().is_none_or(|a| a == "skip"))
        .filter(|g| g["category"].as_str().is_some_and(|c| cats.contains(&c)))
        .filter_map(|g| {
            let s = g["segment"][0].as_f64()?;
            let e = g["segment"][1].as_f64()?;
            (e - s > 0.5).then(|| (s, e, g["videoDuration"].as_f64().unwrap_or(0.0)))
        })
        .collect();
    out.sort_by(|a, b| a.0.total_cmp(&b.0));
    out
}

async fn load_segments(id: String) {
    use sha2::Digest;
    let hash = sha2::Sha256::digest(id.as_bytes());
    let prefix: String = hash.iter().take(2).map(|b| format!("{b:02x}")).collect();
    let url = format!(
        "https://sponsor.ajay.app/api/skipSegments/{prefix}?categories={}&actionType=skip",
        url::form_urlencoded::byte_serialize(SB_CATEGORIES.as_bytes()).collect::<String>()
    );
    let Some(c) = crate::player::client("", 8, true) else {
        return;
    };
    let res = match c.get(url).send().await {
        Ok(r) => r,
        Err(_) => return,
    };
    let segs = match res.status().as_u16() {
        404 => Vec::new(),
        200 => match res.json::<Value>().await {
            Ok(v) => parse_segments(&v, &id),
            Err(_) => return,
        },
        _ => return,
    };
    st(|s| {
        s.segs.insert(
            id,
            Some(
                segs.into_iter()
                    .map(|(start, end, video)| Seg { start, end, video })
                    .collect(),
            ),
        );
    });
}

/// Stan dla okna po odbudowie; liczniki i nieudane scrobble oddaje tylko raz.
pub fn take() -> Option<Value> {
    let mut g = ST.lock().unwrap_or_else(|p| p.into_inner());
    let s = g.as_mut().filter(|s| s.active)?;
    s.active = false;
    tally(s);
    let v = state_json(s);
    s.stats_total = 0.0;
    s.stats_per.clear();
    s.stats_sessions = 0;
    s.failed.clear();
    Some(v)
}

/// To samo do pliku stanu, gdy aplikacja kończy się bez okna; nic nie zeruje.
pub fn persist() -> Value {
    st(|s| state_json(s))
}

fn state_json(s: &St) -> Value {
    json!({
        "handoff": s.cur.as_ref().map(|c| json!({
            "id": c.id,
            "listened": c.listened,
            "done": c.done,
            "start": c.start_ms,
            "duration": c.duration,
        })),
        "stats": {
            "totalSeconds": s.stats_total,
            "trackMinutes": s.stats_per,
            "sessions": s.stats_sessions,
        },
        "failed": s.failed,
        "sleepEndsAt": s.sleep_ends,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threshold_is_half_capped_at_four_minutes() {
        assert_eq!(scrobble_threshold(200.0), 100.0);
        assert_eq!(scrobble_threshold(1200.0), 240.0);
    }

    #[test]
    fn listen_without_artist_is_never_scrobbled() {
        let mut s = St {
            cur: Some(Listen {
                title: "Song".into(),
                artist: " ".into(),
                duration: 200.0,
                listened: 150.0,
                ..Default::default()
            }),
            ..Default::default()
        };
        maybe_scrobble(&mut s);
        assert!(!s.cur.as_ref().unwrap().done);
    }

    #[test]
    fn segments_keep_skip_categories_only() {
        let v = json!([
            { "videoID": "other", "segments": [{ "segment": [1.0, 9.0], "category": "sponsor" }] },
            { "videoID": "abcdefghijk", "segments": [
                { "segment": [30.0, 40.0], "category": "music_offtopic", "actionType": "skip", "videoDuration": 200.0 },
                { "segment": [0.0, 5.0], "category": "intro" },
                { "segment": [10.0, 10.2], "category": "sponsor" },
                { "segment": [2.0, 8.0], "category": "sponsor", "actionType": "mute" },
                { "segment": [5.0, 8.0], "category": "selfpromo" }
            ]}
        ]);
        assert_eq!(
            parse_segments(&v, "abcdefghijk"),
            vec![(5.0, 8.0, 0.0), (30.0, 40.0, 200.0)]
        );
    }

    #[test]
    fn blocked_track_is_skipped_once_and_streak_is_capped() {
        let mut s = St {
            cfg: json!({ "skip": ["a"] }),
            ..Default::default()
        };
        for i in 0..12 {
            s.cur = Some(Listen {
                id: "a".into(),
                ..Default::default()
            });
            s.skipped_for.clear();
            assert_eq!(skip_blocked(&mut s).is_some(), i < 10);
            assert!(skip_blocked(&mut s).is_none());
        }
        s.cur = Some(Listen {
            id: "b".into(),
            ..Default::default()
        });
        assert!(skip_blocked(&mut s).is_none());
        assert_eq!(s.skips, 0);
    }

    #[test]
    fn sponsor_jump_skips_and_respects_kept() {
        let mut s = St {
            cfg: json!({ "sponsorblock": true }),
            cur: Some(Listen {
                id: "abcdefghijk".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        s.segs.insert(
            "abcdefghijk".into(),
            Some(vec![
                Seg {
                    start: 30.0,
                    end: 40.0,
                    video: 200.0,
                },
                Seg {
                    start: 190.0,
                    end: 200.0,
                    video: 0.0,
                },
            ]),
        );
        assert!(matches!(sponsor_jump(&mut s, 35.0, 200.0), Some(Act::Seek(t)) if t == 40.0));
        assert!(matches!(sponsor_jump(&mut s, 195.0, 200.0), Some(Act::Seek(t)) if t == 199.75));
        assert!(sponsor_jump(&mut s, 35.0, 260.0).is_none());
        s.kept.push((30.0, 40.0));
        assert!(sponsor_jump(&mut s, 35.0, 200.0).is_none());
    }
}
