use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ArtistStat {
    name: String,
    plays: i64,
    minutes: f64,
    before: i64,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrackStat {
    video_id: String,
    title: String,
    artist: String,
    plays: i64,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    plays: i64,
    minutes: f64,
    artists: i64,
    skipped: i64,
    top_artists: Vec<ArtistStat>,
    top_tracks: Vec<TrackStat>,
    rising: Vec<ArtistStat>,
    hours: Vec<f64>,
    weekdays: Vec<f64>,
    daily: Vec<(String, f64)>,
    first_at: Option<i64>,
}

// przesłuchane minuty nie mogą przekroczyć długości utworu (pozycja po przewinięciu bywa większa)
const MIN: &str = "MIN(listened, COALESCE(duration, listened)) / 60.0";
const LOCAL: &str = "datetime(at / 1000, 'unixepoch', 'localtime')";
// „+” odbiera planerowi indeks wykonawcy: bez tego czyta całą historię w kolejności grupowania zamiast zakresu dat
const TOP_TRACKS: &str = "SELECT MAX(video_id), MIN(title), MIN(artist), COUNT(*) FROM plays
     WHERE at >= ?1 AND skipped=0 GROUP BY +artist_key, title_key ORDER BY 4 DESC LIMIT 25";

pub fn overview(c: &Connection, days: i64, now: i64) -> rusqlite::Result<Overview> {
    let since = if days > 0 { now - days * 86_400_000 } else { 0 };
    let prev = if days > 0 {
        since - days * 86_400_000
    } else {
        0
    };
    let mut o = Overview {
        hours: vec![0.0; 24],
        weekdays: vec![0.0; 7],
        ..Default::default()
    };
    (o.plays, o.minutes, o.artists, o.skipped) = c.query_row(
        &format!(
            "SELECT COUNT(*) FILTER (WHERE skipped=0), COALESCE(SUM({MIN}) FILTER (WHERE skipped=0),0),
                    COUNT(DISTINCT artist_key), COUNT(*) FILTER (WHERE skipped=1)
             FROM plays WHERE at >= ?1"
        ),
        params![since],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    o.first_at = c.query_row("SELECT MIN(at) FROM plays", [], |r| r.get(0))?;

    let artists = |from: i64, to: i64, limit: i64| -> rusqlite::Result<Vec<ArtistStat>> {
        let mut q = c.prepare(&format!(
            "SELECT MIN(artist), COUNT(*), SUM({MIN}) FROM plays
             WHERE at >= ?1 AND at < ?2 AND skipped=0 GROUP BY artist_key ORDER BY 3 DESC LIMIT ?3"
        ))?;
        let rows = q.query_map(params![from, to, limit], |r| {
            Ok(ArtistStat {
                name: r.get(0)?,
                plays: r.get(1)?,
                minutes: r.get(2)?,
                before: 0,
            })
        })?;
        Ok(rows.flatten().collect())
    };
    o.top_artists = artists(since, i64::MAX, 40)?;

    // rosnący: w tym okresie dużo więcej odtworzeń niż w poprzednim tej samej długości
    if days > 0 {
        let before = artists(prev, since, 500)?;
        let mut rising: Vec<ArtistStat> = artists(since, i64::MAX, 200)?
            .into_iter()
            .map(|mut a| {
                a.before = before
                    .iter()
                    .find(|b| b.name.eq_ignore_ascii_case(&a.name))
                    .map_or(0, |b| b.plays);
                a
            })
            .filter(|a| a.plays >= 3 && a.plays >= a.before * 2)
            .collect();
        rising.sort_by_key(|a| std::cmp::Reverse(a.plays - a.before));
        rising.truncate(8);
        o.rising = rising;
    }

    let mut q = c.prepare(TOP_TRACKS)?;
    o.top_tracks = q
        .query_map(params![since], |r| {
            Ok(TrackStat {
                video_id: r.get(0)?,
                title: r.get(1)?,
                artist: r.get(2)?,
                plays: r.get(3)?,
            })
        })?
        .flatten()
        .collect();

    let mut q = c.prepare(&format!(
        "SELECT CAST(strftime('%H', {LOCAL}) AS INTEGER), CAST(strftime('%w', {LOCAL}) AS INTEGER), SUM({MIN})
         FROM plays WHERE at >= ?1 AND skipped=0 GROUP BY 1, 2"
    ))?;
    for (h, w, m) in q
        .query_map(params![since], |r| {
            Ok((
                r.get::<_, i64>(0)? as usize,
                r.get::<_, i64>(1)? as usize,
                r.get::<_, f64>(2)?,
            ))
        })?
        .flatten()
    {
        if let Some(x) = o.hours.get_mut(h) {
            *x += m;
        }
        // tydzień od poniedziałku, SQLite liczy od niedzieli
        if let Some(x) = o.weekdays.get_mut((w + 6) % 7) {
            *x += m;
        }
    }

    // wykres dzienny dla okresu, a dla „całości” tygodniowy, żeby lata historii się zmieściły
    let bucket = if days > 0 && days <= 90 {
        "%Y-%m-%d"
    } else {
        "%Y-%W"
    };
    let mut q = c.prepare(&format!(
        "SELECT strftime('{bucket}', {LOCAL}), SUM({MIN}) FROM plays
         WHERE at >= ?1 AND skipped=0 GROUP BY 1 ORDER BY 1"
    ))?;
    o.daily = q
        .query_map(params![since], |r| Ok((r.get(0)?, r.get(1)?)))?
        .flatten()
        .collect();
    Ok(o)
}

#[tauri::command(async)]
pub fn stats_overview(days: i64) -> Result<Overview, String> {
    crate::db::with(|c| overview(c, days.clamp(0, 36_500), crate::db::now_ms()))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ArtistTrack {
    video_id: String,
    title: String,
    plays: i64,
}

#[tauri::command(async)]
pub fn stats_artist(name: String, days: i64) -> Result<Vec<ArtistTrack>, String> {
    let since = if days > 0 {
        crate::db::now_ms() - days * 86_400_000
    } else {
        0
    };
    let key = crate::db::artist_key(&name);
    crate::db::with(|c| {
        let mut q = c.prepare(
            "SELECT MAX(video_id), MIN(title), COUNT(*) FROM plays
             WHERE artist_key=?1 AND at >= ?2 AND skipped=0 GROUP BY title_key ORDER BY 3 DESC LIMIT 15",
        )?;
        let rows = q.query_map(params![key, since], |r| {
            Ok(ArtistTrack {
                video_id: r.get(0)?,
                title: r.get(1)?,
                plays: r.get(2)?,
            })
        })?;
        Ok(rows.flatten().collect())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overview_counts_trends_and_buckets() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(crate::db::SCHEMA).unwrap();
        let day = 86_400_000i64;
        let now = 1_000 * day;
        let add = |artist: &str, title: &str, at: i64, skipped: i32| {
            c.execute(
                "INSERT INTO plays(video_id,title,artist,duration,listened,at,skipped,artist_key,title_key)
                 VALUES('v',?1,?2,200,400,?3,?4,lower(?2),lower(?1))",
                params![title, artist, at, skipped],
            )
            .unwrap();
        };
        for i in 0..4 {
            add("New", "Hit", now - day - i, 0);
        }
        add("Old", "Classic", now - 10 * day, 0);
        add("Old", "Classic", now - 2 * day, 0);
        add("Old", "Skip", now - 2 * day, 1);
        let o = overview(&c, 7, now).unwrap();
        assert_eq!(o.plays, 5);
        assert_eq!(o.skipped, 1);
        assert!(
            (o.minutes - 5.0 * 200.0 / 60.0).abs() < 1e-6,
            "listened capped at duration"
        );
        assert_eq!(o.top_artists[0].name, "New");
        assert_eq!(
            o.rising.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
            ["New"]
        );
        assert_eq!(o.top_tracks[0].plays, 4);
        assert!((o.hours.iter().sum::<f64>() - o.minutes).abs() < 1e-6);
        assert!(!o.daily.is_empty());
        let all = overview(&c, 0, now).unwrap();
        assert_eq!(all.plays, 6);
        assert!(all.rising.is_empty());
    }

    #[test]
    fn top_tracks_read_only_the_period() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(crate::db::SCHEMA).unwrap();
        crate::db::upgrade(&c).unwrap();
        let plan = crate::db::query_plan(&c, TOP_TRACKS);
        assert!(plan.contains("SEARCH plays USING INDEX plays_at"), "{plan}");
    }
}
