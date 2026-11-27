use std::collections::HashMap;

use rusqlite::types::Value as Sql;
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
    tx.commit()?;
    Ok(n)
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
    let db = crate::db::with(dump).unwrap_or(Value::Null);
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
    if let Some(fav) = v
        .get("favorites")
        .filter(|f| f.as_array().is_some_and(|a| !a.is_empty()))
    {
        crate::prefs::favorites_save(app, fav.to_string())?;
    }
    if v["db"].is_object() {
        crate::db::with(|c| restore(c, &v["db"]))?;
    }
    Ok(v["prefs"]
        .as_object()
        .map(|m| {
            m.iter()
                .filter(|(k, _)| k.starts_with("zenith") && !is_secret(k))
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default())
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
    fn secrets_stay_out() {
        assert!(is_secret("zenith_lastfm_session"));
        assert!(is_secret("zenith_remote_pin"));
        assert!(!is_secret("zenith_plugins_enabled"));
        assert_eq!(stamp().len(), 10);
    }
}
