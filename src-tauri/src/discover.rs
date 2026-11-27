use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::params;
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Clone)]
pub struct Pick {
    pub artist: String,
    pub title: String,
    pub because: String,
}

static CACHE: Mutex<Option<(Instant, Vec<Pick>)>> = Mutex::new(None);
const TTL: Duration = Duration::from_secs(6 * 3600);
const DEEZER: &str = "https://api.deezer.com";

// „+” trzyma planer na zakresie dat; z indeksem wykonawcy czytał całą historię
const TOP_ARTISTS: &str =
    "SELECT artist, COUNT(*) n FROM plays WHERE at > ?1 AND skipped = 0 AND listened >= 30
     GROUP BY +artist_key ORDER BY n DESC LIMIT 6";

/// Najczęściej słuchani wykonawcy z dwóch miesięcy i wszyscy kiedykolwiek grani (ich nie polecamy).
fn taste() -> (Vec<String>, HashSet<String>) {
    let since = crate::db::now_ms() - 60 * 86_400_000;
    crate::db::with(|c| {
        let mut q = c.prepare(TOP_ARTISTS)?;
        let top = q
            .query_map(params![since], |r| r.get::<_, String>(0))?
            .flatten()
            .collect();
        let mut q = c.prepare("SELECT DISTINCT artist_key FROM plays")?;
        let known = q
            .query_map([], |r| r.get::<_, String>(0))?
            .flatten()
            .collect();
        Ok((top, known))
    })
    .unwrap_or_default()
}

/// Podobni wykonawcy z grafu Deezera: kto pojawia się przy kilku ulubionych, ten idzie wyżej.
pub fn rank(
    related: &[(String, Vec<(u64, String)>)],
    known: &HashSet<String>,
    limit: usize,
) -> Vec<(u64, String, String)> {
    let mut score: HashMap<u64, (f64, String, String)> = HashMap::new();
    for (seed, list) in related {
        for (i, (id, name)) in list.iter().enumerate() {
            if known.contains(&crate::db::artist_key(name)) {
                continue;
            }
            let e = score
                .entry(*id)
                .or_insert((0.0, name.clone(), seed.clone()));
            e.0 += 1.0 + 1.0 / (i as f64 + 1.0);
        }
    }
    let mut out: Vec<_> = score.into_iter().collect();
    out.sort_by(|a, b| b.1 .0.total_cmp(&a.1 .0).then(a.0.cmp(&b.0)));
    out.into_iter()
        .take(limit)
        .map(|(id, (_, name, seed))| (id, name, seed))
        .collect()
}

async fn get(http: &crate::player::Http, path: &str) -> Option<Value> {
    let r = http.get(format!("{DEEZER}{path}")).send().await.ok()?;
    r.json::<Value>().await.ok()
}

fn names(v: &Value) -> Vec<(u64, String)> {
    v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| Some((a["id"].as_u64()?, a["name"].as_str()?.to_string())))
        .collect()
}

/// Wtyczka „Odkrywaj” pyta Deezera o podobnych wykonawców; wysyła tylko nazwy najczęściej słuchanych.
#[tauri::command]
pub async fn discover_picks() -> Result<Vec<Pick>, String> {
    if let Some((at, picks)) = CACHE.lock().unwrap_or_else(|p| p.into_inner()).clone() {
        if at.elapsed() < TTL {
            return Ok(picks);
        }
    }
    let (top, known) = taste();
    if top.is_empty() {
        return Ok(Vec::new());
    }
    let http = crate::player::client("", 10, true).ok_or("http client")?;
    let mut related = Vec::new();
    for seed in &top {
        let q = url::form_urlencoded::byte_serialize(seed.as_bytes()).collect::<String>();
        let Some(found) = get(&http, &format!("/search/artist?q={q}&limit=1")).await else {
            continue;
        };
        let Some((id, _)) = names(&found).into_iter().next() else {
            continue;
        };
        if let Some(rel) = get(&http, &format!("/artist/{id}/related?limit=10")).await {
            related.push((seed.clone(), names(&rel)));
        }
    }
    let mut picks = Vec::new();
    for (id, artist, because) in rank(&related, &known, 16) {
        let top = get(&http, &format!("/artist/{id}/top?limit=1")).await;
        if let Some(title) = top.as_ref().and_then(|t| t["data"][0]["title"].as_str()) {
            picks.push(Pick {
                artist,
                title: title.to_string(),
                because,
            });
        }
    }
    if !picks.is_empty() {
        *CACHE.lock().unwrap_or_else(|p| p.into_inner()) = Some((Instant::now(), picks.clone()));
    }
    Ok(picks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_neighbours_win_and_known_artists_drop() {
        let related = vec![
            (
                "A".into(),
                vec![
                    (1, "Justice".into()),
                    (2, "Known Band".into()),
                    (3, "Air".into()),
                ],
            ),
            ("B".into(), vec![(3, "Air".into()), (4, "Cassius".into())]),
        ];
        let known: HashSet<String> = ["known band".to_string()].into();
        let out = rank(&related, &known, 10);
        assert_eq!(out[0].1, "Air");
        assert!(out.iter().all(|x| x.1 != "Known Band"));
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn top_artists_read_only_two_months() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(crate::db::SCHEMA).unwrap();
        crate::db::upgrade(&c).unwrap();
        let plan = crate::db::query_plan(&c, TOP_ARTISTS);
        assert!(plan.contains("SEARCH plays USING INDEX plays_at"), "{plan}");
    }
}
