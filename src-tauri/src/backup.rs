use std::collections::{HashMap, HashSet};

use rusqlite::types::Value as Sql;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

const FORMAT: &str = "zenith-backup";
const TABLES: [&str; 6] = [
    "plays",
    "ratings",
    "lib_tracks",
    "lib_tags",
    "lib_collections",
    "lib_collection_items",
];
const MAX_BYTES: usize = 200_000_000;
const SECRET: [&str; 8] = [
    "token",
    "secret",
    "session",
    "password",
    "apikey",
    "api_key",
    "cookie",
    "webhook_url",
];

fn is_secret(key: &str) -> bool {
    let l = key.to_ascii_lowercase();
    SECRET.iter().any(|s| l.contains(s)) || l.ends_with("_pin")
}

fn columns(c: &rusqlite::Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut q = c.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols = q
        .query_map([], |r| r.get::<_, String>(1))?
        .flatten()
        .collect();
    Ok(cols)
}

fn dump(c: &rusqlite::Connection) -> rusqlite::Result<Value> {
    let mut out = Map::new();
    for t in TABLES {
        let cols = columns(c, t)?;
        let mut q = c.prepare(&format!("SELECT * FROM {t}"))?;
        let rows: Vec<Value> = q
            .query_map([], |r| {
                let mut row = Vec::with_capacity(cols.len());
                for i in 0..cols.len() {
                    row.push(match r.get::<_, Sql>(i)? {
                        Sql::Null | Sql::Blob(_) => Value::Null,
                        Sql::Integer(n) => json!(n),
                        Sql::Real(f) => json!(f),
                        Sql::Text(s) => json!(s),
                    });
                }
                Ok(Value::Array(row))
            })?
            .flatten()
            .collect();
        out.insert(t.into(), json!({ "columns": cols, "rows": rows }));
    }
    Ok(Value::Object(out))
}

/// Wiersze z kopii trafiają tylko do znanych tabel i kolumn; duplikaty są pomijane, więc import dwa razy nic nie psuje.
fn restore(c: &rusqlite::Connection, db: &Value) -> rusqlite::Result<usize> {
    let tx = c.unchecked_transaction()?;
    let mut n = 0;
    for t in TABLES {
        let Some(part) = db.get(t) else { continue };
        if matches!(t, "lib_collections" | "lib_collection_items") {
            continue;
        }
        let known = columns(&tx, t)?;
        let cols: Vec<&str> = part["columns"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        // id wiersza odtworzeń pochodzi z innej bazy i zderzyłby się z lokalnymi
        let keep: Vec<usize> = (0..cols.len())
            .filter(|&i| known.iter().any(|k| k == cols[i]) && !(t == "plays" && cols[i] == "id"))
            .collect();
        if keep.is_empty() {
            continue;
        }
        let names: Vec<&str> = keep.iter().map(|&i| cols[i]).collect();
        let marks = vec!["?"; keep.len()].join(",");
        let sql = if t == "plays" {
            // odtworzenia nie mają klucza z treści, więc ten sam czas i utwór uznajemy za duplikat
            format!(
                "INSERT INTO plays({}) SELECT {marks} WHERE NOT EXISTS (SELECT 1 FROM plays WHERE at=?{} AND video_id=?{})",
                names.join(","),
                keep.len() + 1,
                keep.len() + 2
            )
        } else {
            format!(
                "INSERT OR IGNORE INTO {t}({}) VALUES({marks})",
                names.join(",")
            )
        };
        let mut q = tx.prepare(&sql)?;
        let at_i = cols.iter().position(|c| *c == "at");
        let vid_i = cols.iter().position(|c| *c == "video_id");
        for row in part["rows"].as_array().into_iter().flatten() {
            let Some(row) = row.as_array() else { continue };
            let val = |i: usize| -> Sql {
                match row.get(i) {
                    Some(Value::String(s)) => Sql::Text(s.clone()),
                    Some(Value::Number(x)) => x
                        .as_i64()
                        .map(Sql::Integer)
                        .unwrap_or_else(|| Sql::Real(x.as_f64().unwrap_or(0.0))),
                    Some(Value::Bool(b)) => Sql::Integer(*b as i64),
                    _ => Sql::Null,
                }
            };
            let mut vals: Vec<Sql> = keep.iter().map(|&i| val(i)).collect();
            if t == "plays" {
                vals.push(at_i.map(val).unwrap_or(Sql::Null));
                vals.push(vid_i.map(val).unwrap_or(Sql::Null));
            }
            n += q.execute(rusqlite::params_from_iter(vals)).unwrap_or(0);
        }
    }
    n += merge_collections(&tx, db)?;
    tx.commit()?;
    Ok(n)
}

fn backup_rows(db: &Value, table: &str, names: &[&str]) -> Vec<Vec<Value>> {
    let cols = db[table]["columns"].as_array();
    let idx: Option<Vec<usize>> = names
        .iter()
        .map(|n| cols?.iter().position(|c| c == n))
        .collect();
    let Some(idx) = idx else { return Vec::new() };
    db[table]["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let r = r.as_array()?;
            Some(
                idx.iter()
                    .map(|&i| r.get(i).cloned().unwrap_or(Value::Null))
                    .collect(),
            )
        })
        .collect()
}

// kolekcje łączymy po nazwie i folderze: id z innej bazy wskazałoby inną, lokalną kolekcję
fn merge_collections(tx: &rusqlite::Connection, db: &Value) -> rusqlite::Result<usize> {
    let mut ids: HashMap<i64, i64> = HashMap::new();
    let mut n = 0;
    for r in backup_rows(
        db,
        "lib_collections",
        &["id", "name", "folder", "created_at"],
    ) {
        let (Some(old), Some(name)) = (r[0].as_i64(), r[1].as_str()) else {
            continue;
        };
        let folder = r[2].as_str().unwrap_or("");
        let found = tx
            .query_row(
                "SELECT id FROM lib_collections WHERE name=?1 AND folder=?2",
                params![name, folder],
                |x| x.get(0),
            )
            .optional()?;
        let id = match found {
            Some(id) => id,
            None => {
                tx.execute(
                    "INSERT INTO lib_collections(name,folder,created_at) VALUES(?1,?2,?3)",
                    params![
                        name,
                        folder,
                        r[3].as_i64().unwrap_or_else(crate::db::now_ms)
                    ],
                )?;
                n += 1;
                tx.last_insert_rowid()
            }
        };
        ids.insert(old, id);
    }
    let mut items = backup_rows(
        db,
        "lib_collection_items",
        &["collection_id", "video_id", "pos"],
    );
    // kolejność z kopii zostaje, a utwory, których kolekcja nie ma, idą za jej obecnymi
    items.sort_by_key(|r| r[2].as_i64().unwrap_or(0));
    for r in items {
        let (Some(&id), Some(video_id)) = (r[0].as_i64().and_then(|o| ids.get(&o)), r[1].as_str())
        else {
            continue;
        };
        n += tx.execute(
            "INSERT OR IGNORE INTO lib_collection_items(collection_id,video_id,pos)
             SELECT ?1, ?2, COALESCE(MAX(pos), -1) + 1 FROM lib_collection_items WHERE collection_id=?1",
            params![id, video_id],
        )?;
    }
    Ok(n)
}

// ulubione dodane po zrobieniu kopii zostają na początku, z kopii dochodzą tylko brakujące
fn merge_favorites(current: &str, backup: &[&Value]) -> Vec<Value> {
    let mut out: Vec<Value> = serde_json::from_str(current).unwrap_or_default();
    let mut seen: HashSet<String> = out
        .iter()
        .filter_map(|f| f["id"].as_str().map(String::from))
        .collect();
    for f in backup
        .iter()
        .flat_map(|b| b.as_array().into_iter().flatten())
    {
        let id = f["id"].as_str().unwrap_or("");
        if !id.is_empty() && id.len() <= 64 && seen.insert(id.to_string()) {
            out.push(f.clone());
        }
    }
    out.truncate(crate::prefs::FAVORITES_MAX_TRACKS);
    out
}

fn stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // data cywilna z dni od epoki (algorytm Howarda Hinnanta), bez zależności od chrono
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

#[tauri::command(async)]
pub fn backup_export(
    app: AppHandle,
    webview: tauri::Webview,
    prefs: HashMap<String, String>,
) -> Result<String, String> {
    crate::auth_store::main_window_only(&webview)?;
    let prefs: HashMap<String, String> = prefs.into_iter().filter(|(k, _)| !is_secret(k)).collect();
    let favorites: Value =
        serde_json::from_str(&crate::prefs::favorites_load(app.clone())).unwrap_or(json!([]));
    let db = crate::db::with_read(dump).unwrap_or(Value::Null);
    let body = json!({
        "format": FORMAT,
        "version": 1,
        "app": env!("CARGO_PKG_VERSION"),
        "createdAt": stamp(),
        "prefs": prefs,
        "favorites": favorites,
        "db": db,
    });
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().document_dir())
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let base = format!("zenith-backup-{}", stamp());
    let mut path = dir.join(format!("{base}.json"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{base} ({n}).json"));
        n += 1;
    }
    std::fs::write(&path, body.to_string()).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Przywraca ulubione i bazę, a ustawienia oddaje oknu, które wpisuje je do localStorage i się przeładowuje.
#[tauri::command(async)]
pub fn backup_import(
    app: AppHandle,
    webview: tauri::Webview,
    body: String,
) -> Result<HashMap<String, String>, String> {
    crate::auth_store::main_window_only(&webview)?;
    if body.len() > MAX_BYTES {
        return Err("backup too big".into());
    }
    let v: Value = serde_json::from_str(&body).map_err(|_| "not a Zenith backup")?;
    if v["format"] != FORMAT {
        return Err("not a Zenith backup".into());
    }
    let in_prefs: Value = v["prefs"]["zenith_saved_tracks"]
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    let favorites = merge_favorites(
        &crate::prefs::favorites_load(app.clone()),
        &[&v["favorites"], &in_prefs],
    );
    let favorites = (!favorites.is_empty()).then(|| Value::from(favorites).to_string());
    if let Some(body) = &favorites {
        crate::prefs::favorites_save(app, body.clone())?;
    }
    if v["db"].is_object() {
        crate::db::with(|c| restore(c, &v["db"]))?;
    }
    let mut prefs: HashMap<String, String> = v["prefs"]
        .as_object()
        .map(|m| {
            m.iter()
                .filter(|(k, _)| k.starts_with("zenith") && !is_secret(k))
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    // okno wpisuje te ustawienia do localStorage, więc lista z kopii nadpisałaby nowsze ulubione
    prefs.remove("zenith_saved_tracks");
    if let Some(body) = favorites {
        prefs.insert("zenith_saved_tracks".into(), body);
    }
    Ok(prefs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(crate::db::SCHEMA).unwrap();
        crate::library::migrate(&c);
        c
    }

    #[test]
    fn dump_and_restore_round_trip_without_duplicates() {
        let a = mem();
        a.execute(
            "INSERT INTO plays(video_id,title,artist,listened,at,artist_key,title_key) VALUES('v1','T','A',100,5,'a','t')",
            [],
        )
        .unwrap();
        a.execute(
            "INSERT INTO ratings(video_id,rating,at) VALUES('v2',-1,7)",
            [],
        )
        .unwrap();
        let mut d = dump(&a).unwrap();
        // kolumna, której nie ma w schemacie, nie może trafić do zapytania
        d["ratings"]["columns"]
            .as_array_mut()
            .unwrap()
            .push(json!("evil); DROP TABLE plays;--"));
        let b = mem();
        assert_eq!(restore(&b, &d).unwrap(), 2);
        assert_eq!(restore(&b, &d).unwrap(), 0);
        let n: i64 = b
            .query_row("SELECT COUNT(*) FROM plays", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn collections_merge_by_name_not_by_id() {
        let local = mem();
        local
            .execute_batch(
                "INSERT INTO lib_collections(id,name,folder,created_at) VALUES(1,'Siłownia','',1);
                 INSERT INTO lib_collection_items VALUES(1,'localAAAAAA',0);",
            )
            .unwrap();
        let other = mem();
        other
            .execute_batch(
                "INSERT INTO lib_collections(id,name,folder,created_at) VALUES(1,'Chill','',2),(2,'Siłownia','',3);
                 INSERT INTO lib_collection_items VALUES(1,'backupCCCCC',1),(1,'backupBBBBB',0),(2,'backupDDDDD',0);",
            )
            .unwrap();
        let d = dump(&other).unwrap();
        assert_eq!(restore(&local, &d).unwrap(), 4);
        assert_eq!(restore(&local, &d).unwrap(), 0);
        let items = |name: &str| -> Vec<String> {
            let mut q = local
                .prepare(
                    "SELECT i.video_id FROM lib_collection_items i JOIN lib_collections c ON c.id=i.collection_id
                     WHERE c.name=?1 ORDER BY i.pos",
                )
                .unwrap();
            q.query_map([name], |r| r.get(0))
                .unwrap()
                .flatten()
                .collect()
        };
        assert_eq!(items("Siłownia"), ["localAAAAAA", "backupDDDDD"]);
        assert_eq!(items("Chill"), ["backupBBBBB", "backupCCCCC"]);
    }

    #[test]
    fn favorites_merge_instead_of_replacing() {
        let backup = json!([{"id": "b"}, {"id": "c"}, {"id": ""}]);
        let in_prefs = json!([{"id": "d"}]);
        let out = merge_favorites(
            r#"[{"id":"a"},{"id":"b","title":"new"}]"#,
            &[&backup, &in_prefs],
        );
        let ids: Vec<&str> = out.iter().filter_map(|f| f["id"].as_str()).collect();
        assert_eq!(ids, ["a", "b", "c", "d"]);
        assert_eq!(out[1]["title"], "new");
        let many: Value = (0..3000)
            .map(|i| json!({ "id": format!("x{i}") }))
            .collect();
        assert_eq!(
            merge_favorites("[]", &[&many]).len(),
            crate::prefs::FAVORITES_MAX_TRACKS
        );
    }

    #[test]
    fn secrets_stay_out() {
        assert!(is_secret("zenith_lastfm_session"));
        assert!(is_secret("zenith_remote_pin"));
        assert!(!is_secret("zenith_plugins_enabled"));
        assert_eq!(stamp().len(), 10);
    }
}
