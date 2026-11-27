use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{MetadataOptions, StandardTagKey};
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Emitter};

use crate::db::{artist_key, title_key, with};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS local_files(
  path TEXT PRIMARY KEY,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  album TEXT,
  duration REAL,
  mtime INTEGER NOT NULL,
  artist_key TEXT NOT NULL,
  title_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS local_files_keys ON local_files(artist_key, title_key);
";
const EXTS: [&str; 7] = ["flac", "mp3", "opus", "ogg", "m4a", "wav", "aac"];

static SCANNING: AtomicBool = AtomicBool::new(false);
// id z YouTube Music -> lokalny plik tego samego utworu, ustalane przy starcie odtwarzania
static BOUND: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

pub fn migrate(c: &Connection) {
    let _ = c.execute_batch(SCHEMA);
}

#[derive(Debug, PartialEq, Default)]
pub struct Tags {
    pub artist: Option<String>,
    pub title: Option<String>,
    pub album: Option<String>,
    pub duration: Option<f64>,
}

/// Komentarze Vorbis z nagłówka Ogg (Opus albo Vorbis): symphonia nie czyta ich dla Opusa.
pub fn vorbis_comments(head: &[u8]) -> Tags {
    let mut t = Tags::default();
    let start = head
        .windows(8)
        .position(|w| w == b"OpusTags")
        .map(|i| i + 8)
        .or_else(|| {
            head.windows(7)
                .position(|w| w == b"\x03vorbis")
                .map(|i| i + 7)
        });
    let Some(mut i) = start else { return t };
    let u32_at = |i: usize| -> Option<usize> {
        Some(u32::from_le_bytes(head.get(i..i + 4)?.try_into().ok()?) as usize)
    };
    let Some(vendor) = u32_at(i) else { return t };
    i += 4 + vendor;
    let Some(n) = u32_at(i) else { return t };
    i += 4;
    for _ in 0..n.min(200) {
        let Some(len) = u32_at(i) else { break };
        let Some(raw) = head.get(i + 4..i + 4 + len) else {
            break;
        };
        i += 4 + len;
        let s = String::from_utf8_lossy(raw);
        let Some((k, v)) = s.split_once('=') else {
            continue;
        };
        let v = Some(v.trim().to_string()).filter(|v| !v.is_empty());
        match k.to_ascii_uppercase().as_str() {
            "ARTIST" if t.artist.is_none() => t.artist = v,
            "TITLE" => t.title = v,
            "ALBUM" => t.album = v,
            _ => {}
        }
    }
    t
}

fn symphonia_tags(path: &Path) -> Tags {
    let mut t = Tags::default();
    let Ok(f) = std::fs::File::open(path) else {
        return t;
    };
    let mut hint = Hint::new();
    if let Some(e) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(e);
    }
    let mss = MediaSourceStream::new(Box::new(f), Default::default());
    let Ok(mut probed) = symphonia::default::get_probe().format(
        &hint,
        mss,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    ) else {
        return t;
    };
    let mut take = |rev: &symphonia::core::meta::MetadataRevision| {
        for tag in rev.tags() {
            let v = Some(tag.value.to_string()).filter(|v| !v.trim().is_empty());
            match tag.std_key {
                Some(StandardTagKey::Artist) if t.artist.is_none() => t.artist = v,
                Some(StandardTagKey::TrackTitle) if t.title.is_none() => t.title = v,
                Some(StandardTagKey::Album) if t.album.is_none() => t.album = v,
                _ => {}
            }
        }
    };
    // ID3 siedzi przed strumieniem (probe), Vorbis/MP4 w samym kontenerze (format)
    if let Some(rev) = probed.metadata.get().as_ref().and_then(|m| m.current()) {
        take(rev);
    }
    if let Some(rev) = probed.format.metadata().current() {
        take(rev);
    }
    if let Some(tr) = probed.format.default_track() {
        let p = &tr.codec_params;
        if let (Some(n), Some(tb)) = (p.n_frames, p.time_base) {
            let tm = tb.calc_time(n);
            t.duration = Some(tm.seconds as f64 + tm.frac);
        }
    }
    t
}

/// „Wykonawca - Tytuł.flac” albo „01 - Tytuł.mp3” z folderem wykonawcy wyżej.
pub fn from_name(path: &Path) -> Tags {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let stem = stem.trim_start_matches(|c: char| {
        c.is_ascii_digit() || c == '.' || c == ' ' || c == '-' || c == '_'
    });
    let (artist, title) = match stem.split_once(" - ") {
        Some((a, b)) => (Some(a.trim().to_string()), b.trim().to_string()),
        None => {
            let dir = |n: usize| {
                path.ancestors()
                    .nth(n)
                    .and_then(|p| p.file_name())
                    .and_then(|s| s.to_str())
                    .map(String::from)
            };
            // shortcut: zakłada układ Wykonawca/Album/utwór; plik leżący wprost w folderze wykonawcy dostanie zły klucz
            (dir(2), stem.trim().to_string())
        }
    };
    Tags {
        artist,
        title: Some(title).filter(|t| !t.is_empty()),
        ..Default::default()
    }
}

fn read_tags(path: &Path) -> Tags {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // panika symphonii na uszkodzonym pliku zamknęłaby aplikację przy każdym starcie (skan rusza sam)
    let mut t = std::panic::catch_unwind(|| symphonia_tags(path)).unwrap_or_default();
    if (t.artist.is_none() || t.title.is_none()) && (ext == "opus" || ext == "ogg") {
        let mut head = vec![0u8; 256 * 1024];
        if let Ok(mut f) = std::fs::File::open(path) {
            let n = f.read(&mut head).unwrap_or(0);
            let v = vorbis_comments(&head[..n]);
            t.artist = t.artist.or(v.artist);
            t.title = t.title.or(v.title);
            t.album = t.album.or(v.album);
        }
    }
    if t.artist.is_none() || t.title.is_none() {
        let n = from_name(path);
        t.artist = t.artist.or(n.artist);
        t.title = t.title.or(n.title);
    }
    t
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 12 || out.len() > 200_000 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        // dowiązania pomijamy, bo pętla w drzewie skanowałaby bez końca
        if ft.is_dir() {
            walk(&p, out, depth + 1);
        } else if ft.is_file()
            && p.extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| EXTS.contains(&x.to_ascii_lowercase().as_str()))
        {
            out.push(p);
        }
    }
}

fn mtime(p: &Path) -> i64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Skanuje foldery w tle; niezmienione pliki (ta sama data) nie są czytane drugi raz.
#[tauri::command]
pub fn local_scan(app: AppHandle, folders: Vec<String>) -> Result<(), String> {
    if SCANNING.swap(true, Ordering::SeqCst) {
        return Err("scan already running".into());
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let folders: Vec<String> = folders
        .iter()
        .map(|f| match f.trim().strip_prefix('~') {
            Some(rest) if !home.is_empty() => format!("{home}{rest}"),
            _ => f.trim().to_string(),
        })
        .collect();
    std::thread::spawn(move || {
        let mut files = Vec::new();
        for f in folders.iter().map(PathBuf::from).filter(|p| p.is_dir()) {
            walk(&f, &mut files, 0);
        }
        let known: HashMap<String, i64> = with(|c| {
            let mut q = c.prepare("SELECT path, mtime FROM local_files")?;
            let rows = q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            Ok(rows.flatten().collect())
        })
        .unwrap_or_default();
        let total = files.len();
        let mut added = 0;
        for (i, p) in files.iter().enumerate() {
            let key = p.to_string_lossy().to_string();
            let m = mtime(p);
            if known.get(&key) == Some(&m) {
                continue;
            }
            let t = read_tags(p);
            let (Some(artist), Some(title)) = (t.artist, t.title) else {
                continue;
            };
            let ok = with(|c| {
                c.execute(
                    "INSERT OR REPLACE INTO local_files(path,artist,title,album,duration,mtime,artist_key,title_key)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![key, artist, title, t.album, t.duration, m, artist_key(&artist), title_key(&title)],
                )
            });
            added += usize::from(ok.is_ok());
            if i % 50 == 0 {
                let _ = app.emit(
                    "local-scan",
                    serde_json::json!({ "done": false, "seen": i, "total": total }),
                );
            }
        }
        // pliki usunięte z dysku albo spoza wybranych folderów nie mogą wygrywać ze streamem
        let roots: Vec<String> = folders.clone();
        let _ = with(|c| {
            let mut q = c.prepare("SELECT path FROM local_files")?;
            let gone: Vec<String> = q
                .query_map([], |r| r.get::<_, String>(0))?
                .flatten()
                .filter(|p| {
                    !Path::new(p).is_file() || !roots.iter().any(|r| p.starts_with(r.as_str()))
                })
                .collect();
            for p in gone {
                c.execute("DELETE FROM local_files WHERE path=?1", params![p])?;
            }
            Ok(())
        });
        if let Ok(mut b) = BOUND.lock() {
            *b = None;
        }
        let count = with(|c| {
            c.query_row("SELECT COUNT(*) FROM local_files", [], |r| {
                r.get::<_, i64>(0)
            })
        })
        .unwrap_or(0);
        let _ = app.emit(
            "local-scan",
            serde_json::json!({ "done": true, "seen": total, "total": total, "added": added, "count": count }),
        );
        SCANNING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[derive(Serialize)]
pub struct LocalStatus {
    count: i64,
}

#[tauri::command]
pub fn local_status() -> LocalStatus {
    LocalStatus {
        count: with(|c| c.query_row("SELECT COUNT(*) FROM local_files", [], |r| r.get(0)))
            .unwrap_or(0),
    }
}

#[tauri::command]
pub fn local_forget() -> Result<(), String> {
    if let Ok(mut b) = BOUND.lock() {
        *b = None;
    }
    with(|c| c.execute("DELETE FROM local_files", []).map(|_| ()))
}

/// Plik dla utworu po wykonawcy i tytule; przy znanej długości różnica ponad 6 s znaczy inną wersję.
pub fn find(
    c: &Connection,
    artist: &str,
    title: &str,
    duration: Option<f64>,
) -> rusqlite::Result<Option<PathBuf>> {
    let (ak, tk) = (artist_key(artist), title_key(title));
    if ak.is_empty() || tk.is_empty() || crate::db::is_variant(title) {
        return Ok(None);
    }
    let row: Option<(String, Option<f64>)> = c
        .query_row(
            "SELECT path, duration FROM local_files WHERE artist_key=?1 AND title_key=?2
             ORDER BY CASE WHEN ?3 IS NULL OR duration IS NULL THEN 0 ELSE ABS(duration - ?3) END LIMIT 1",
            params![ak, tk, duration],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(row
        .filter(|(_, d)| match (d, duration) {
            (Some(a), Some(b)) if b > 0.0 => (a - b).abs() <= 6.0,
            _ => true,
        })
        .map(|(p, _)| PathBuf::from(p))
        .filter(|p| p.is_file()))
}

/// Wiąże id z YouTube Music z lokalnym plikiem; zwraca true, gdy utwór zagra z dysku.
pub fn bind(id: &str, artist: &str, title: &str, duration: Option<f64>) -> bool {
    if !crate::downloads::valid_id(id) {
        return false;
    }
    let found = with(|c| find(c, artist, title, duration)).ok().flatten();
    let Ok(mut g) = BOUND.lock() else {
        return false;
    };
    let map = g.get_or_insert_with(HashMap::new);
    match found {
        Some(p) => {
            if map.len() > 5000 {
                map.clear();
            }
            map.insert(id.to_string(), p);
            true
        }
        None => {
            map.remove(id);
            false
        }
    }
}

#[tauri::command]
pub fn local_bind(id: String, artist: String, title: String, duration: Option<f64>) -> bool {
    bind(&id, &artist, &title, duration)
}

pub fn bound(id: &str) -> Option<PathBuf> {
    BOUND
        .lock()
        .ok()?
        .as_ref()?
        .get(id)
        .cloned()
        .filter(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "needs ZENITH_TEST_WEBM pointing at a downloaded track"]
    fn reads_tags_from_a_real_ogg_opus() {
        let src = std::env::var("ZENITH_TEST_WEBM").unwrap();
        let dst = std::env::temp_dir().join(format!("zenith-local-{}.opus", std::process::id()));
        let t = crate::opus_tags::Tags {
            title: "Feel Good Inc",
            artist: "Gorillaz",
            album: "Demon Days",
            cover_jpeg: None,
        };
        crate::opus_tags::webm_to_ogg(Path::new(&src), &dst, &t).unwrap();
        let got = read_tags(&dst);
        let _ = std::fs::remove_file(&dst);
        assert_eq!(got.artist.as_deref(), Some("Gorillaz"));
        assert_eq!(got.title.as_deref(), Some("Feel Good Inc"));
    }

    #[test]
    fn names_and_vorbis_comments() {
        let t = from_name(Path::new("/m/Daft Punk - One More Time.flac"));
        assert_eq!(
            (t.artist.as_deref(), t.title.as_deref()),
            (Some("Daft Punk"), Some("One More Time"))
        );
        let t = from_name(Path::new("/m/Justice/Cross/03 Genesis.mp3"));
        assert_eq!(
            (t.artist.as_deref(), t.title.as_deref()),
            (Some("Justice"), Some("Genesis"))
        );

        let mut head = b"OggS....OpusTags".to_vec();
        head.extend(3u32.to_le_bytes());
        head.extend(b"lib");
        head.extend(2u32.to_le_bytes());
        for c in ["ARTIST=Air", "title=La femme d'argent"] {
            head.extend((c.len() as u32).to_le_bytes());
            head.extend(c.as_bytes());
        }
        let v = vorbis_comments(&head);
        assert_eq!(v.artist.as_deref(), Some("Air"));
        assert_eq!(v.title.as_deref(), Some("La femme d'argent"));
    }

    #[test]
    fn truncated_webm_named_opus_falls_back_to_the_file_name() {
        let mut b =
            std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tone.webm"))
                .unwrap();
        b.truncate(b.len() / 2);
        let p = std::env::temp_dir().join(format!("Air - Kyoto {}.opus", std::process::id()));
        std::fs::write(&p, b).unwrap();
        let t = read_tags(&p);
        let _ = std::fs::remove_file(&p);
        assert_eq!(t.artist.as_deref(), Some("Air"));
    }

    #[test]
    fn find_matches_keys_and_rejects_other_versions() {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c);
        let p = std::env::temp_dir().join(format!("zenith-local-{}.flac", std::process::id()));
        std::fs::write(&p, b"fLaC").unwrap();
        c.execute(
            "INSERT INTO local_files VALUES(?1,'Air','La Femme d''Argent',NULL,428,0,'air','la femme d argent')",
            params![p.to_string_lossy()],
        )
        .unwrap();
        assert_eq!(
            find(&c, "AIR", "La femme d'argent", Some(430.0)).unwrap(),
            Some(p.clone())
        );
        assert_eq!(
            find(&c, "Air", "La femme d'argent (Remastered)", None).unwrap(),
            Some(p.clone())
        );
        assert_eq!(
            find(&c, "Air", "La femme d'argent", Some(300.0)).unwrap(),
            None
        );
        assert_eq!(
            find(&c, "Air", "La femme d'argent (Live)", None).unwrap(),
            None
        );
        let _ = std::fs::remove_file(p);
    }
}
