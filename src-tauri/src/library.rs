use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::db::{artist_key, now_ms, with};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS lib_tracks(
  video_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album TEXT,
  duration REAL,
  cover TEXT,
  added_at INTEGER NOT NULL,
  artist_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lib_tags(
  video_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY(video_id, tag)
);
CREATE INDEX IF NOT EXISTS lib_tags_tag ON lib_tags(tag);
CREATE TABLE IF NOT EXISTS lib_collections(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lib_collection_items(
  collection_id INTEGER NOT NULL,
  video_id TEXT NOT NULL,
  pos INTEGER NOT NULL,
  PRIMARY KEY(collection_id, video_id)
);
";

pub fn migrate(c: &Connection) {
    let _ = c.execute_batch(SCHEMA);
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrackIn {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_sec: Option<f64>,
    pub cover: Option<String>,
}

fn clean(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

fn save_track(c: &Connection, t: &TrackIn) -> rusqlite::Result<()> {
    if t.id.is_empty() || t.id.len() > 64 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    c.execute(
        "INSERT INTO lib_tracks(video_id,title,artist,album,duration,cover,added_at,artist_key)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(video_id) DO UPDATE SET title=excluded.title, artist=excluded.artist,
           album=COALESCE(excluded.album, album), duration=COALESCE(excluded.duration, duration),
           cover=COALESCE(excluded.cover, cover)",
        params![
            t.id,
            clean(&t.title, 300),
            clean(&t.artist, 300),
            t.album,
            t.duration_sec,
            t.cover,
            now_ms(),
            artist_key(&t.artist)
        ],
    )?;
    Ok(())
}

#[derive(Serialize)]
pub struct Collection {
    id: i64,
    name: String,
    folder: String,
    count: i64,
}

#[tauri::command(async)]
pub fn lib_collections() -> Result<Vec<Collection>, String> {
    with(|c| {
        let mut q = c.prepare(
            "SELECT c.id, c.name, c.folder, (SELECT COUNT(*) FROM lib_collection_items i WHERE i.collection_id=c.id)
             FROM lib_collections c ORDER BY c.folder COLLATE NOCASE, c.name COLLATE NOCASE",
        )?;
        let rows = q.query_map([], |r| {
            Ok(Collection {
                id: r.get(0)?,
                name: r.get(1)?,
                folder: r.get(2)?,
                count: r.get(3)?,
            })
        })?;
        Ok(rows.flatten().collect())
    })
}

#[tauri::command(async)]
pub fn lib_collection_save(id: Option<i64>, name: String, folder: String) -> Result<i64, String> {
    let (name, folder) = (clean(&name, 120), clean(&folder, 120));
    if name.is_empty() {
        return Err("empty name".into());
    }
    with(|c| match id {
        Some(id) => {
            c.execute(
                "UPDATE lib_collections SET name=?1, folder=?2 WHERE id=?3",
                params![name, folder, id],
            )?;
            Ok(id)
        }
        None => {
            c.execute(
                "INSERT INTO lib_collections(name,folder,created_at) VALUES(?1,?2,?3)",
                params![name, folder, now_ms()],
            )?;
            Ok(c.last_insert_rowid())
        }
    })
}

#[tauri::command(async)]
pub fn lib_collection_delete(id: i64) -> Result<(), String> {
    with(|c| {
        c.execute(
            "DELETE FROM lib_collection_items WHERE collection_id=?1",
            params![id],
        )?;
        c.execute("DELETE FROM lib_collections WHERE id=?1", params![id])?;
        Ok(())
    })
}

#[tauri::command(async)]
pub fn lib_collection_add(id: i64, track: TrackIn) -> Result<(), String> {
    with(|c| {
        save_track(c, &track)?;
        let pos: i64 = c.query_row(
            "SELECT COALESCE(MAX(pos), -1) + 1 FROM lib_collection_items WHERE collection_id=?1",
            params![id],
            |r| r.get(0),
        )?;
        c.execute(
            "INSERT OR IGNORE INTO lib_collection_items(collection_id,video_id,pos) VALUES(?1,?2,?3)",
            params![id, track.id, pos],
        )?;
        Ok(())
    })
}

#[tauri::command(async)]
pub fn lib_collection_remove(id: i64, video_id: String) -> Result<(), String> {
    with(|c| {
        c.execute(
            "DELETE FROM lib_collection_items WHERE collection_id=?1 AND video_id=?2",
            params![id, video_id],
        )?;
        Ok(())
    })
}

#[derive(Serialize)]
pub struct TagCount {
    tag: String,
    count: i64,
}

#[tauri::command(async)]
pub fn lib_tags() -> Result<Vec<TagCount>, String> {
    with(|c| {
        let mut q = c.prepare(
            "SELECT tag, COUNT(*) FROM lib_tags GROUP BY tag ORDER BY COUNT(*) DESC, tag COLLATE NOCASE",
        )?;
        let rows = q.query_map([], |r| {
            Ok(TagCount {
                tag: r.get(0)?,
                count: r.get(1)?,
            })
        })?;
        Ok(rows.flatten().collect())
    })
}

#[tauri::command(async)]
pub fn lib_track_tags(video_id: String) -> Result<Vec<String>, String> {
    with(|c| {
        let mut q = c.prepare("SELECT tag FROM lib_tags WHERE video_id=?1 ORDER BY tag")?;
        let rows = q.query_map(params![video_id], |r| r.get(0))?;
        Ok(rows.flatten().collect())
    })
}

#[tauri::command(async)]
pub fn lib_set_tags(track: TrackIn, tags: Vec<String>) -> Result<(), String> {
    with(|c| {
        let tx = c.unchecked_transaction()?;
        save_track(&tx, &track)?;
        tx.execute("DELETE FROM lib_tags WHERE video_id=?1", params![track.id])?;
        for t in tags
            .iter()
            .map(|t| clean(&t.to_lowercase(), 40))
            .filter(|t| !t.is_empty())
            .take(30)
        {
            tx.execute(
                "INSERT OR IGNORE INTO lib_tags(video_id,tag) VALUES(?1,?2)",
                params![track.id, t],
            )?;
        }
        tx.commit()
    })
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub collection: Option<i64>,
    pub tag: Option<String>,
    pub search: Option<String>,
    pub sort: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibTrack {
    id: String,
    title: String,
    artist: String,
    album: Option<String>,
    duration_sec: Option<f64>,
    cover: Option<String>,
    added_at: i64,
    plays: i64,
    last_played: Option<i64>,
    tags: Vec<String>,
}

pub fn query(c: &Connection, q: &Query) -> rusqlite::Result<Vec<LibTrack>> {
    // kolejność w kolekcji to pozycja dodania; poza kolekcją domyślnie najnowsze na górze
    let order = match q.sort.as_deref() {
        Some("title") => "t.title COLLATE NOCASE",
        Some("artist") => "t.artist COLLATE NOCASE, t.title COLLATE NOCASE",
        Some("plays") => "plays DESC, t.title COLLATE NOCASE",
        Some("recent") => "last_played IS NULL, last_played DESC",
        _ if q.collection.is_some() => "i.pos",
        _ => "t.added_at DESC",
    };
    let join = if q.collection.is_some() {
        "JOIN lib_collection_items i ON i.video_id=t.video_id AND i.collection_id=:col"
    } else {
        ""
    };
    let sql = format!(
        "SELECT t.video_id, t.title, t.artist, t.album, t.duration, t.cover, t.added_at,
           (SELECT COUNT(*) FROM plays p WHERE p.video_id=t.video_id AND p.skipped=0) plays,
           (SELECT MAX(at) FROM plays p WHERE p.video_id=t.video_id) last_played,
           (SELECT group_concat(tag, char(31)) FROM lib_tags g WHERE g.video_id=t.video_id) tags
         FROM lib_tracks t {join}
         WHERE (:tag IS NULL OR EXISTS (SELECT 1 FROM lib_tags g WHERE g.video_id=t.video_id AND g.tag=:tag))
           AND (:search IS NULL OR t.title LIKE :search OR t.artist LIKE :search OR t.album LIKE :search)
         ORDER BY {order} LIMIT 5000"
    );
    let search = q
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{}%", s.replace(['%', '_'], "")));
    let mut st = c.prepare(&sql)?;
    let mut named: Vec<(&str, &dyn rusqlite::ToSql)> = vec![(":tag", &q.tag), (":search", &search)];
    if q.collection.is_some() {
        named.push((":col", &q.collection));
    }
    let rows = st.query_map(named.as_slice(), |r| {
        Ok(LibTrack {
            id: r.get(0)?,
            title: r.get(1)?,
            artist: r.get(2)?,
            album: r.get(3)?,
            duration_sec: r.get(4)?,
            cover: r.get(5)?,
            added_at: r.get(6)?,
            plays: r.get(7)?,
            last_played: r.get(8)?,
            tags: r
                .get::<_, Option<String>>(9)?
                .map(|s| s.split('\u{1f}').map(String::from).collect())
                .unwrap_or_default(),
        })
    })?;
    Ok(rows.flatten().collect())
}

#[tauri::command(async)]
pub fn lib_query(query: Query) -> Result<Vec<LibTrack>, String> {
    with(|c| self::query(c, &query))
}

/// Kolekcje, w których już jest ten utwór: menu kontekstowe pokazuje przy nich znacznik.
#[tauri::command(async)]
pub fn lib_track_collections(video_id: String) -> Result<Vec<i64>, String> {
    with(|c| {
        let mut q =
            c.prepare("SELECT collection_id FROM lib_collection_items WHERE video_id=?1")?;
        let rows = q.query_map(params![video_id], |r| r.get(0))?;
        Ok(rows.flatten().collect())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: &str, title: &str, artist: &str) -> TrackIn {
        TrackIn {
            id: id.into(),
            title: title.into(),
            artist: artist.into(),
            album: None,
            duration_sec: Some(200.0),
            cover: None,
        }
    }

    #[test]
    fn tags_collections_sort_and_search() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(crate::db::SCHEMA).unwrap();
        migrate(&c);
        save_track(&c, &t("b", "Beta", "Zed")).unwrap();
        save_track(&c, &t("a", "Alpha", "Yan")).unwrap();
        c.execute(
            "INSERT INTO lib_tags VALUES('a','chill'),('b','gym'),('b','chill')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO plays(video_id,title,artist,listened,at,artist_key,title_key) VALUES('b','Beta','Zed',100,9,'zed','beta'),('b','Beta','Zed',100,10,'zed','beta')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO lib_collections(id,name,created_at) VALUES(1,'Mix',0)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO lib_collection_items VALUES(1,'b',0),(1,'a',1)",
            [],
        )
        .unwrap();
        let ids = |q: Query| {
            query(&c, &q)
                .unwrap()
                .into_iter()
                .map(|x| x.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            ids(Query {
                sort: Some("title".into()),
                ..Default::default()
            }),
            ["a", "b"]
        );
        assert_eq!(
            ids(Query {
                sort: Some("plays".into()),
                ..Default::default()
            }),
            ["b", "a"]
        );
        assert_eq!(
            ids(Query {
                tag: Some("gym".into()),
                ..Default::default()
            }),
            ["b"]
        );
        assert_eq!(
            ids(Query {
                search: Some("alp%".into()),
                ..Default::default()
            }),
            ["a"]
        );
        assert_eq!(
            ids(Query {
                collection: Some(1),
                ..Default::default()
            }),
            ["b", "a"]
        );
        let all = query(&c, &Query::default()).unwrap();
        let b = all.iter().find(|x| x.id == "b").unwrap();
        assert_eq!(b.plays, 2);
        assert_eq!(b.last_played, Some(10));
        assert_eq!(b.tags.len(), 2);
    }
}
