use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use rusqlite::{params, Connection};
use serde::Deserialize;
use tauri::{AppHandle, Manager};

static DB: OnceLock<Mutex<Connection>> = OnceLock::new();

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS plays(
  id INTEGER PRIMARY KEY,
  video_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album TEXT,
  duration REAL,
  listened REAL NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'zenith',
  skipped INTEGER NOT NULL DEFAULT 0,
  artist_key TEXT NOT NULL,
  title_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plays_at ON plays(at);
CREATE INDEX IF NOT EXISTS plays_video ON plays(video_id);
CREATE INDEX IF NOT EXISTS plays_artist ON plays(artist_key);
CREATE UNIQUE INDEX IF NOT EXISTS plays_import ON plays(source, at, title_key) WHERE source <> 'zenith';
CREATE TABLE IF NOT EXISTS ratings(
  video_id TEXT PRIMARY KEY,
  rating INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  artist_key TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
";

pub fn init(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    if let Some(c) = open(&dir.join("zenith.db")) {
        let _ = DB.set(Mutex::new(c));
    }
}

fn open(path: &Path) -> Option<Connection> {
    let c = Connection::open(path).ok()?;
    // WAL: zapis odtworzenia nie blokuje odczytu statystyk z drugiego wątku
    let _ = c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    c.execute_batch(SCHEMA).ok()?;
    crate::library::migrate(&c);
    crate::local_files::migrate(&c);
    Some(c)
}

pub fn with<R>(f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> Result<R, String> {
    let m = DB.get().ok_or("database unavailable")?;
    let c = m.lock().unwrap_or_else(|p| p.into_inner());
    f(&c).map_err(|e| e.to_string())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const VARIANT_WORDS: [&str; 24] = [
    "remix",
    "rmx",
    "sped up",
    "speed up",
    "slowed",
    "reverb",
    "nightcore",
    "8d",
    "bass boosted",
    "cover",
    "karaoke",
    "instrumental",
    "acapella",
    "a cappella",
    "live",
    "mashup",
    "bootleg",
    "flip",
    "tiktok",
    "phonk",
    "lofi",
    "lo-fi",
    "extended",
    "edit",
];

fn has_word(hay: &str, word: &str) -> bool {
    hay.match_indices(word).any(|(i, _)| {
        let before = hay[..i].chars().next_back();
        let after = hay[i + word.len()..].chars().next();
        !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric)
    })
}

/// Remiks, przyspieszona wersja, cover albo wersja koncertowa tego samego utworu.
pub fn is_variant(title: &str) -> bool {
    let t = title.to_lowercase();
    VARIANT_WORDS.iter().any(|w| has_word(&t, w))
}

/// Tytuł bez dopisków w nawiasach, „feat.” i wersji: wszystkie remiksy jednej piosenki dają ten sam klucz.
pub fn title_key(title: &str) -> String {
    let t = title.to_lowercase();
    let mut out = String::with_capacity(t.len());
    let mut depth = 0u32;
    for ch in t.chars() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    let mut base = out.as_str();
    for cut in [" feat", " ft.", " ft ", " prod."] {
        if let Some(i) = base.find(cut) {
            base = &base[..i];
        }
    }
    // „Tytuł - Sped Up” albo „Tytuł - Remix”: część po myślniku liczy się tylko, gdy to nie wersja
    let base = match base.rsplit_once(" - ") {
        Some((head, tail)) if is_variant(tail) => head,
        _ => base,
    };
    base.chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Pierwszy wykonawca, małymi literami: „A, B & C” i „A feat. B” liczą się jako A.
pub fn artist_key(artist: &str) -> String {
    let a = artist.to_lowercase();
    let mut end = a.len();
    for sep in [",", " & ", " x ", " feat", " ft.", " • ", " and ", " i "] {
        if let Some(i) = a.find(sep) {
            end = end.min(i);
        }
    }
    a[..end].trim().to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayIn {
    pub video_id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration: Option<f64>,
    pub listened: f64,
    pub at: Option<i64>,
}

/// Ucięte przed 30 s (a w krótkim utworze przed połową) znaczy, że ktoś go przewinął.
pub fn was_skipped(listened: f64, duration: Option<f64>) -> bool {
    let d = duration.unwrap_or(0.0);
    d > 40.0 && listened < 30.0_f64.min(d / 2.0)
}

pub fn log_play(p: &PlayIn) -> Result<(), String> {
    if p.title.trim().is_empty() || p.listened.is_nan() || p.listened < 5.0 {
        return Ok(());
    }
    let at = p.at.unwrap_or_else(now_ms);
    with(|c| {
        c.execute(
            "INSERT INTO plays(video_id,title,artist,album,duration,listened,at,skipped,artist_key,title_key)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                p.video_id,
                p.title,
                p.artist,
                p.album,
                p.duration,
                p.listened,
                at,
                was_skipped(p.listened, p.duration) as i32,
                artist_key(&p.artist),
                title_key(&p.title)
            ],
        )
    })
    .map(|_| ())
}

/// Scrobble z innej usługi: wykonawca, tytuł, album i czas w ms.
pub type Scrobble = (String, String, Option<String>, i64);

/// Odtworzenia z innej usługi; ten sam czas i tytuł z tego samego źródła nie wejdą drugi raz.
pub fn import_plays(source: &str, rows: &[Scrobble]) -> Result<usize, String> {
    with(|c| {
        let tx = c.unchecked_transaction()?;
        let mut n = 0;
        {
            let mut q = tx.prepare(
                "INSERT OR IGNORE INTO plays(title,artist,album,listened,at,source,artist_key,title_key)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            )?;
            for (artist, title, album, at) in rows {
                // shortcut: scrobble nie mówi, ile słuchano, więc liczymy typowe 3 minuty
                n += q.execute(params![
                    title,
                    artist,
                    album,
                    180.0,
                    at,
                    source,
                    artist_key(artist),
                    title_key(title)
                ])?;
            }
        }
        tx.commit()?;
        Ok(n)
    })
}

#[tauri::command]
pub fn db_log_play(play: PlayIn) -> Result<(), String> {
    log_play(&play)
}

/// Ocena utworu: 1 lubię, -1 nie lubię, 0 zdejmuje ocenę.
#[tauri::command]
pub fn db_rate(video_id: String, rating: i32, title: String, artist: String) -> Result<(), String> {
    with(|c| {
        if rating == 0 {
            c.execute("DELETE FROM ratings WHERE video_id=?1", params![video_id])
        } else {
            c.execute(
                "INSERT INTO ratings(video_id,rating,title,artist_key,at) VALUES(?1,?2,?3,?4,?5)
                 ON CONFLICT(video_id) DO UPDATE SET rating=excluded.rating, at=excluded.at",
                params![
                    video_id,
                    rating.signum(),
                    title,
                    artist_key(&artist),
                    now_ms()
                ],
            )
        }
    })
    .map(|_| ())
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Cand {
    pub id: String,
    pub title: String,
    pub artist: String,
}

/// Co wiemy o guście: świeżo grane, pomijane, oceny i ulubieni wykonawcy.
#[derive(Default)]
pub struct Taste {
    pub recent_ids: HashSet<String>,
    pub recent_titles: HashSet<String>,
    pub skipped_ids: HashSet<String>,
    pub disliked_ids: HashSet<String>,
    pub artist_score: HashMap<String, f64>,
}

const DAY_MS: i64 = 86_400_000;

fn load_taste(now: i64) -> Taste {
    let mut t = Taste::default();
    let _ = with(|c| {
        let mut q = c.prepare(
            "SELECT video_id, title_key, artist_key, skipped, at FROM plays WHERE at > ?1",
        )?;
        let rows = q.query_map(params![now - 90 * DAY_MS], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i32>(3)? != 0,
                r.get::<_, i64>(4)?,
            ))
        })?;
        for (id, tk, ak, skipped, at) in rows.flatten() {
            if skipped {
                t.skipped_ids.insert(id);
                *t.artist_score.entry(ak).or_default() -= 0.35;
                continue;
            }
            if now - at < 2 * DAY_MS {
                t.recent_ids.insert(id);
                t.recent_titles.insert(tk);
            }
            *t.artist_score.entry(ak).or_default() += 0.25;
        }
        let mut q = c.prepare("SELECT video_id, rating, artist_key FROM ratings")?;
        let rows = q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i32>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for (id, rating, ak) in rows.flatten() {
            if rating < 0 {
                t.disliked_ids.insert(id);
                *t.artist_score.entry(ak).or_default() -= 2.0;
            } else {
                *t.artist_score.entry(ak).or_default() += 0.6;
            }
        }
        Ok(())
    });
    // wykonawca słuchany setki razy nie może zagłuszyć reszty radia
    for v in t.artist_score.values_mut() {
        *v = v.clamp(-4.0, 3.0);
    }
    t
}

/// Dobiera do kolejki utwory z radia: bez wersji tego samego utworu, bez świeżo granych i pomijanych,
/// z ulubionymi wykonawcami wyżej i najwyżej dwoma utworami jednego wykonawcy w paczce.
pub fn rank(
    seed: &Cand,
    candidates: &[Cand],
    exclude: &[String],
    blocked_artists: &[String],
    taste: &Taste,
    limit: usize,
) -> Vec<String> {
    let seed_title = title_key(&seed.title);
    let seed_variant = is_variant(&seed.title);
    let excluded: HashSet<&str> = exclude.iter().map(String::as_str).collect();
    let blocked: Vec<String> = blocked_artists.iter().map(|b| b.to_lowercase()).collect();
    let n = candidates.len().max(1) as f64;
    let mut seen_titles: HashSet<String> = HashSet::new();
    seen_titles.insert(seed_title.clone());
    let mut scored: Vec<(f64, &Cand, String)> = Vec::new();
    for (i, c) in candidates.iter().enumerate() {
        let tk = title_key(&c.title);
        let ak = artist_key(&c.artist);
        let lower_artist = c.artist.to_lowercase();
        if c.id == seed.id
            || excluded.contains(c.id.as_str())
            || taste.disliked_ids.contains(&c.id)
            || taste.skipped_ids.contains(&c.id)
            || blocked
                .iter()
                .any(|b| !b.is_empty() && has_word(&lower_artist, b))
            || tk.is_empty()
            || !seen_titles.insert(tk.clone())
        {
            continue;
        }
        // kolejność radia YouTube Music to wciąż najlepsza wskazówka podobieństwa (gatunek, tempo, nastrój)
        let mut score = 1.5 * (1.0 - i as f64 / n);
        if taste.recent_ids.contains(&c.id) || taste.recent_titles.contains(&tk) {
            score -= 3.0;
        }
        if is_variant(&c.title) && !seed_variant {
            score -= 1.5;
        }
        score += taste.artist_score.get(&ak).copied().unwrap_or(0.0) * 0.5;
        scored.push((score, c, ak));
    }
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));

    let seed_artist = artist_key(&seed.artist);
    let mut per_artist: HashMap<String, usize> = HashMap::new();
    per_artist.insert(seed_artist.clone(), 0);
    let mut out: Vec<String> = Vec::new();
    let mut last = seed_artist;
    let mut pool = scored;
    while out.len() < limit && !pool.is_empty() {
        // najlepszy, który nie powtarza poprzedniego wykonawcy i nie przekracza dwóch na paczkę
        let pick = pool
            .iter()
            .position(|(_, _, ak)| *ak != last && per_artist.get(ak).copied().unwrap_or(0) < 2)
            .or_else(|| {
                // same powtórki: lepiej zagrać drugi raz tego samego wykonawcę niż urwać radio
                (out.len() < limit / 2).then_some(0)
            });
        let Some(i) = pick else { break };
        let (_, c, ak) = pool.remove(i);
        *per_artist.entry(ak.clone()).or_default() += 1;
        last = ak;
        out.push(c.id.clone());
    }
    out
}

#[tauri::command]
pub fn smart_queue(
    seed: Cand,
    candidates: Vec<Cand>,
    exclude: Vec<String>,
    blocked_artists: Vec<String>,
    limit: usize,
) -> Vec<String> {
    let taste = load_taste(now_ms());
    rank(
        &seed,
        &candidates,
        &exclude,
        &blocked_artists,
        &taste,
        limit.clamp(1, 50),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(id: &str, title: &str, artist: &str) -> Cand {
        Cand {
            id: id.into(),
            title: title.into(),
            artist: artist.into(),
        }
    }

    #[test]
    fn variants_of_one_song_share_a_key() {
        let k = title_key("Pobij Mnie");
        assert_eq!(title_key("Pobij Mnie (Sped Up)"), k);
        assert_eq!(title_key("Pobij mnie - Slowed + Reverb"), k);
        assert_eq!(title_key("POBIJ MNIE [Remix] feat. Ktoś"), k);
        assert_ne!(title_key("Pobij Mnie Jeszcze Raz"), k);
        assert_eq!(title_key("Song - Part 2"), "song part 2");
    }

    #[test]
    fn variant_words_need_whole_words() {
        assert!(is_variant("Pobij mnie (sped up)"));
        assert!(is_variant("Track - Live at Wembley"));
        assert!(!is_variant("Deliver"));
        assert!(!is_variant("Coverage"));
    }

    #[test]
    fn first_artist_is_the_key() {
        assert_eq!(
            artist_key("Michał Szczygieł, Ktoś & Inny"),
            "michał szczygieł"
        );
        assert_eq!(artist_key("Justice feat. Tame Impala"), "justice");
        assert_eq!(artist_key("Bedoes 2115"), "bedoes 2115");
    }

    #[test]
    fn short_listen_is_a_skip_only_for_real_tracks() {
        assert!(was_skipped(12.0, Some(200.0)));
        assert!(!was_skipped(45.0, Some(200.0)));
        assert!(!was_skipped(12.0, Some(30.0)));
        assert!(was_skipped(15.0, Some(50.0)));
    }

    #[test]
    fn radio_full_of_remixes_turns_into_different_songs() {
        let seed = c("s", "Pobij Mnie", "Michał Szczygieł");
        let mut cands = vec![
            c("r1", "Pobij Mnie (Sped Up)", "Michał Szczygieł"),
            c("r2", "Pobij Mnie (Slowed)", "Ktoś"),
            c("r3", "pobij mnie - remix", "DJ X"),
        ];
        for i in 0..12 {
            cands.push(c(
                &format!("o{i}"),
                &format!("Inna {i}"),
                &format!("Artysta {}", i % 4),
            ));
        }
        let out = rank(&seed, &cands, &[], &[], &Taste::default(), 10);
        assert!(out.iter().all(|id| id.starts_with('o')), "{out:?}");
        assert_eq!(out.len(), 8, "two per artist: {out:?}");
        for w in out.windows(2) {
            let a = cands.iter().find(|x| x.id == w[0]).unwrap();
            let b = cands.iter().find(|x| x.id == w[1]).unwrap();
            assert_ne!(artist_key(&a.artist), artist_key(&b.artist));
        }
    }

    #[test]
    fn history_and_dislikes_steer_the_pick() {
        let seed = c("s", "Seed", "A");
        let cands = vec![
            c("x1", "One", "B"),
            c("x2", "Two", "C"),
            c("x3", "Three", "D"),
            c("x4", "Four", "E"),
        ];
        let mut taste = Taste::default();
        taste.disliked_ids.insert("x1".into());
        taste.recent_ids.insert("x2".into());
        taste.artist_score.insert("e".into(), 3.0);
        let out = rank(&seed, &cands, &["x3".into()], &[], &taste, 4);
        assert_eq!(out, vec!["x4".to_string(), "x2".to_string()]);
        let out = rank(&seed, &cands, &[], &["b".into()], &Taste::default(), 4);
        assert!(!out.contains(&"x1".to_string()));
    }

    #[test]
    fn plays_and_ratings_feed_the_taste() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        let _ = DB.set(Mutex::new(c));
        let base = PlayIn {
            video_id: "aaaaaaaaaaa".into(),
            title: "Hit (Sped Up)".into(),
            artist: "Fav, Other".into(),
            album: None,
            duration: Some(200.0),
            listened: 190.0,
            at: None,
        };
        log_play(&base).unwrap();
        log_play(&PlayIn {
            video_id: "bbbbbbbbbbb".into(),
            listened: 8.0,
            ..base
        })
        .unwrap();
        db_rate("ccccccccccc".into(), -1, "Bad".into(), "Nope".into()).unwrap();
        let t = load_taste(now_ms());
        assert!(t.recent_ids.contains("aaaaaaaaaaa"));
        assert!(t.recent_titles.contains("hit"));
        assert!(t.skipped_ids.contains("bbbbbbbbbbb"));
        assert!(t.disliked_ids.contains("ccccccccccc"));
        assert!(t.artist_score["nope"] < 0.0);
    }
}
