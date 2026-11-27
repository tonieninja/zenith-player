use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadMeta {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub saved_at: u64,
    #[serde(default)]
    pub file: String,
}

static DIR: OnceLock<PathBuf> = OnceLock::new();
static INDEX: OnceLock<Mutex<BTreeMap<String, DownloadMeta>>> = OnceLock::new();
static ACTIVE: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();

pub fn valid_id(id: &str) -> bool {
    id.len() == 11
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn index() -> &'static Mutex<BTreeMap<String, DownloadMeta>> {
    INDEX.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn active() -> &'static Mutex<std::collections::HashSet<String>> {
    ACTIVE.get_or_init(|| Mutex::new(Default::default()))
}

// usunięte w trakcie pobierania: kończące się pobranie nie może wrócić na listę
fn dropped() -> &'static Mutex<std::collections::HashSet<String>> {
    static DROPPED: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    DROPPED.get_or_init(|| Mutex::new(Default::default()))
}

pub fn init(app: &AppHandle) {
    let Ok(local) = app.path().app_local_data_dir() else {
        return;
    };
    let dir = local.join("downloads");
    // gigabajty audio w profilu Roaming spowalniają logowanie w firmach; stary katalog przenosimy raz
    if let Ok(old) = app.path().app_data_dir().map(|b| b.join("downloads")) {
        if old != dir && old.is_dir() && !dir.exists() {
            let _ = std::fs::create_dir_all(&local);
            if std::fs::rename(&old, &dir).is_err() {
                return init_dir(old);
            }
        }
    }
    init_dir(dir);
}

pub fn init_dir(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    // przerwane pobrania nie wznawiają się po restarcie, a mogą ważyć setki MB
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            if e.path().extension().is_some_and(|x| x == "part") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let raw = std::fs::read_to_string(dir.join("index.json")).unwrap_or_default();
    let map = load_index(&dir, &raw);
    let fresh = serde_json::to_string(&map.values().collect::<Vec<_>>()).ok();
    if let Ok(mut idx) = index().lock() {
        *idx = map;
    }
    let _ = DIR.set(dir);
    // zapis tylko po zmianie (przemianowany <id>.audio, sierota, zniknięty plik): co start opóźniał pierwsze okno
    if fresh.as_deref() != Some(raw.as_str()) {
        save_index();
    }
}

const AUDIO_EXTS: [&str; 6] = ["webm", "m4a", "ogg", "opus", "mp3", "audio"];

fn ext_for(head: &[u8]) -> &'static str {
    match sniff_mime(head) {
        "audio/webm" => "webm",
        "audio/mp4" => "m4a",
        "audio/ogg" => "ogg",
        "audio/mpeg" => "mp3",
        _ => "audio",
    }
}

// nazwa jak w yt-dlp: czytelna po skopiowaniu na pendrive, a id w nawiasie zostaje do odszukania utworu
fn file_name(meta: &DownloadMeta, ext: &str) -> String {
    let who = if meta.artist.is_empty() {
        meta.title.clone()
    } else {
        format!("{} - {}", meta.artist, meta.title)
    };
    format!(
        "{} [{}].{ext}",
        crate::export_file::safe_name(&who),
        meta.id
    )
}

// nazwa z index.json trafia do join; ukośnik, „..” albo „C:x” wyprowadziłyby ścieżkę poza folder pobrań
fn plain_name(name: &str) -> bool {
    !name.is_empty() && !name.contains(['/', '\\', ':']) && !name.starts_with('.')
}

fn id_of(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    if !AUDIO_EXTS.contains(&ext) {
        return None;
    }
    let id = match stem.strip_suffix(']').and_then(|s| s.rsplit_once(" [")) {
        Some((_, id)) => id,
        None => stem,
    };
    valid_id(id).then(|| id.to_string())
}

// pliki sprzed nazw z tytułem (<id>.audio) dostają tytuł i prawdziwe rozszerzenie przy pierwszym starcie
fn settle_file(dir: &std::path::Path, meta: &mut DownloadMeta) -> bool {
    if plain_name(&meta.file) && !meta.file.ends_with(".audio") && dir.join(&meta.file).is_file() {
        return true;
    }
    let old = dir.join(format!("{}.audio", meta.id));
    let mut head = [0u8; 12];
    let Ok(n) = std::fs::File::open(&old).and_then(|mut f| f.read(&mut head)) else {
        return false;
    };
    let name = file_name(meta, ext_for(&head[..n]));
    meta.file = if std::fs::rename(&old, dir.join(&name)).is_ok() {
        name
    } else {
        format!("{}.audio", meta.id)
    };
    true
}

fn load_index(dir: &std::path::Path, raw: &str) -> BTreeMap<String, DownloadMeta> {
    let list: Vec<DownloadMeta> = serde_json::from_str(raw).unwrap_or_default();
    let mut map: BTreeMap<String, DownloadMeta> = list
        .into_iter()
        .filter_map(|mut m| (valid_id(&m.id) && settle_file(dir, &mut m)).then_some(m))
        .map(|m| (m.id.clone(), m))
        .collect();
    // plik spoza indeksu (zepsuty JSON, zamknięcie przed zapisem) musi dać się usunąć z aplikacji
    for mut m in rebuild_index(dir) {
        if !map.contains_key(&m.id) && settle_file(dir, &mut m) {
            map.insert(m.id.clone(), m);
        }
    }
    map
}

fn rebuild_index(dir: &std::path::Path) -> Vec<DownloadMeta> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    rd.flatten()
        .filter_map(|e| {
            let file = e.file_name().to_str()?.to_string();
            let id = id_of(&file)?;
            let md = e.metadata().ok()?;
            let saved_at = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            let title = file
                .rsplit_once(" [")
                .map_or(id.clone(), |(t, _)| t.to_string());
            Some(DownloadMeta {
                title,
                id,
                artist: String::new(),
                album: String::new(),
                cover: String::new(),
                duration: 0.0,
                size: md.len(),
                saved_at,
                file,
            })
        })
        .collect()
}

fn save_index() {
    let Some(dir) = DIR.get() else { return };
    // zapis pod blokadą: dwa pobrania kończące się naraz nie nadpiszą indeksu starszym stanem
    let Ok(m) = index().lock() else { return };
    let list: Vec<&DownloadMeta> = m.values().collect();
    let tmp = dir.join("index.json.tmp");
    if let Ok(s) = serde_json::to_string(&list) {
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, dir.join("index.json"));
        }
    }
}

pub fn file_for(id: &str) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    let name = index().lock().ok()?.get(id)?.file.clone();
    if !plain_name(&name) {
        return None;
    }
    let p = DIR.get()?.join(name);
    p.is_file().then_some(p)
}

pub fn is_downloaded(id: &str) -> bool {
    index().lock().map(|m| m.contains_key(id)).unwrap_or(false) && file_for(id).is_some()
}

#[tauri::command]
pub fn downloads_open_folder(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = DIR.get().ok_or("no downloads folder")?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn downloads_list() -> Vec<DownloadMeta> {
    let mut v: Vec<DownloadMeta> = index()
        .lock()
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default();
    v.sort_by_key(|m| std::cmp::Reverse(m.saved_at));
    v
}

#[tauri::command(async)]
pub fn downloads_delete(id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("bad id".into());
    }
    if active().lock().is_ok_and(|a| a.contains(&id)) {
        if let Ok(mut d) = dropped().lock() {
            d.insert(id.clone());
        }
    }
    if let Some(p) = file_for(&id) {
        std::fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    if let Ok(mut m) = index().lock() {
        m.remove(&id);
    }
    save_index();
    Ok(())
}

// jeden zapis indeksu na końcu: zapis po każdym pliku przy tysiącu pobrań to setki MB i sekundy pracy
#[tauri::command(async)]
pub fn downloads_clear() -> Result<usize, String> {
    if let (Ok(a), Ok(mut d)) = (active().lock(), dropped().lock()) {
        d.extend(a.iter().cloned());
    }
    let ids: Vec<String> = downloads_list().into_iter().map(|m| m.id).collect();
    let mut first_err = None;
    for id in &ids {
        if let Some(Err(e)) = file_for(id).map(std::fs::remove_file) {
            first_err.get_or_insert(e.to_string());
        } else if let Ok(mut m) = index().lock() {
            m.remove(id);
        }
    }
    save_index();
    first_err.map_or(Ok(ids.len()), Err)
}

#[tauri::command]
pub async fn downloads_add(
    app: AppHandle,
    meta: DownloadMeta,
    tags: Option<bool>,
) -> Result<DownloadMeta, String> {
    if !valid_id(&meta.id) {
        return Err("bad id".into());
    }
    let dir = DIR.get().cloned().ok_or("downloads folder unavailable")?;
    if is_downloaded(&meta.id) {
        return index()
            .lock()
            .ok()
            .and_then(|m| m.get(&meta.id).cloned())
            .ok_or_else(|| "index".into());
    }
    {
        let mut a = active().lock().map_err(|_| "lock")?;
        if !a.insert(meta.id.clone()) {
            return Err("already downloading".into());
        }
    }
    if let Ok(mut d) = dropped().lock() {
        d.remove(&meta.id);
    }
    let id = meta.id.clone();
    let r = fetch_to_disk(&app, &dir, meta, tags.unwrap_or(false)).await;
    if let Ok(mut a) = active().lock() {
        a.remove(&id);
    }
    if r.is_err() {
        // bez końcowego zdarzenia panel pobrań zostaje na ostatnim procencie z zablokowanym przyciskiem
        let _ = app.emit(
            "download-progress",
            serde_json::json!({ "id": id, "done": 0, "total": 0, "finished": true }),
        );
    }
    r
}

// po tylu nieudanych próbach z rzędu (backoff do 32 s) uznajemy, że sieci nie ma
const MAX_FAILS: u32 = 8;
const PROGRESS_STEP: u64 = 1024 * 1024;

pub(crate) async fn fetch_part(
    url: &str,
    part: &std::path::Path,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<u64, String> {
    use reqwest::header::{CONTENT_RANGE, RANGE};
    use tokio::io::{AsyncSeekExt, AsyncWriteExt};
    // wspólny klient, bo każdy build wczytuje systemowy magazyn certyfikatów od nowa
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    // bez całkowitego limitu czasu: 9 h audio to kilkaset MB, a ten limit liczy też czytanie body
    let client = crate::stream_proxy::cached_client(&CLIENT, || {
        reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(std::time::Duration::from_secs(10))
            .read_timeout(std::time::Duration::from_secs(90))
            .no_gzip()
            .no_brotli()
            .build()
    })
    .ok_or("no http client")?;
    let mut file = tokio::fs::File::create(part)
        .await
        .map_err(|e| e.to_string())?;
    let (mut done, mut total, mut fails) = (0u64, 0u64, 0u32);
    let mut why = String::from("download failed");
    while total == 0 || done < total {
        if fails > MAX_FAILS {
            return Err(why);
        }
        if fails > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(1 << fails.min(5))).await;
        }
        let res = match client
            .get(url)
            .header(RANGE, format!("bytes={done}-"))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                why = format!("http {}", r.status().as_u16());
                fails += 1;
                continue;
            }
            Err(e) => {
                why = e.to_string();
                fails += 1;
                continue;
            }
        };
        let ranged = res.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        let (start, size) = match res
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(crate::stream_proxy::parse_content_range)
        {
            Some((a, _, t)) if ranged => (a, t),
            _ => (0, res.content_length().unwrap_or(0)),
        };
        // po odświeżeniu linku może przyjść inny format; sklejenie dwóch plików zepsułoby nagranie
        if start != done || (total > 0 && size != total) {
            file.set_len(0).await.map_err(|e| e.to_string())?;
            file.seek(std::io::SeekFrom::Start(0))
                .await
                .map_err(|e| e.to_string())?;
            done = 0;
            if start != 0 {
                why = "server returned the wrong range".into();
                fails += 1;
                continue;
            }
        }
        total = size;
        let before = done;
        let mut cut = false;
        let mut body = res.bytes_stream();
        while let Some(chunk) = body.next().await {
            match chunk {
                Ok(c) => {
                    file.write_all(&c).await.map_err(|e| e.to_string())?;
                    done += c.len() as u64;
                    on_progress(done, total);
                }
                Err(e) => {
                    why = e.to_string();
                    cut = true;
                    break;
                }
            }
        }
        if done > before {
            fails = 0;
        }
        if cut || done == before {
            fails += 1;
            continue;
        }
        if total == 0 {
            break;
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    if done == 0 {
        return Err("empty download".into());
    }
    Ok(done)
}

async fn fetch_to_disk(
    app: &AppHandle,
    dir: &std::path::Path,
    mut meta: DownloadMeta,
    tags: bool,
) -> Result<DownloadMeta, String> {
    let url = crate::stream::get_stream_url(app.clone(), meta.id.clone(), None)
        .await?
        .ok_or("no stream for this track")?;
    if url.contains("/offline/") {
        return Err("already offline".into());
    }
    if meta.duration.is_nan() || meta.duration <= 0.0 {
        // adres proxy nie ma dur=, ma go dopiero link z googlevideo pod spodem
        meta.duration = crate::stream_proxy::current_upstream(&meta.id)
            .and_then(|u| duration_from_url(&u.url))
            .unwrap_or(0.0);
    }
    let part = dir.join(format!("{}.part", meta.id));
    let mut last_emit = 0u64;
    let fetched = fetch_part(&url, &part, |done, total| {
        if done.saturating_sub(last_emit) >= PROGRESS_STEP || done < last_emit {
            last_emit = done;
            let _ = app.emit(
                "download-progress",
                serde_json::json!({ "id": meta.id, "done": done, "total": total }),
            );
        }
    })
    .await;
    let done = match fetched {
        Ok(n) => n,
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(e);
        }
    };
    let mut head = [0u8; 12];
    let n = std::fs::File::open(&part)
        .and_then(|mut f| f.read(&mut head))
        .unwrap_or(0);
    let mut ext = ext_for(&head[..n]);
    let mut done = done;
    if tags && ext == "webm" {
        if let Some(size) = tag_as_opus(&part, &meta).await {
            ext = "opus";
            done = size;
        }
    }
    meta.file = file_name(&meta, ext);
    let path = dir.join(&meta.file);
    if let Err(e) = tokio::fs::rename(&part, &path).await {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(e.to_string());
    }
    meta.size = done;
    meta.saved_at = crate::now_secs();
    if dropped().lock().is_ok_and(|mut d| d.remove(&meta.id)) {
        let _ = tokio::fs::remove_file(&path).await;
        return Err("cancelled".into());
    }
    if let Ok(mut m) = index().lock() {
        m.insert(meta.id.clone(), meta.clone());
    }
    let _ = tokio::task::spawn_blocking(save_index).await;
    let _ = app.emit(
        "download-progress",
        serde_json::json!({ "id": meta.id, "done": done, "total": done, "finished": true }),
    );
    Ok(meta)
}

// nieudane przepakowanie zostawia oryginalny WebM bez tagów, bo utwór i tak jest już na dysku
async fn tag_as_opus(part: &std::path::Path, meta: &DownloadMeta) -> Option<u64> {
    let cover = match meta.cover.as_str() {
        "" => None,
        url => crate::cover_cache::get(544, url.to_string()).await.ok(),
    };
    let (src, dst, m) = (
        part.to_path_buf(),
        part.with_extension("opus.part"),
        meta.clone(),
    );
    let out = dst.clone();
    let r = tokio::task::spawn_blocking(move || {
        let tags = crate::opus_tags::Tags {
            title: &m.title,
            artist: &m.artist,
            album: &m.album,
            cover_jpeg: cover.as_deref(),
        };
        crate::opus_tags::webm_to_ogg(&src, &out, &tags)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    let size = r
        .and_then(|()| std::fs::rename(&dst, part).map_err(|e| e.to_string()))
        .and_then(|()| {
            std::fs::metadata(part)
                .map(|m| m.len())
                .map_err(|e| e.to_string())
        });
    match size {
        Ok(n) => Some(n),
        Err(e) => {
            eprintln!("[downloads] tags skipped for {}: {e}", meta.id);
            let _ = std::fs::remove_file(&dst);
            None
        }
    }
}

pub fn sniff_mime(head: &[u8]) -> &'static str {
    if head.len() >= 4 && head[..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        "audio/webm"
    } else if head.len() >= 8 && &head[4..8] == b"ftyp" {
        "audio/mp4"
    } else if head.len() >= 4 && &head[..4] == b"OggS" {
        "audio/ogg"
    } else if head.len() >= 3
        && (&head[..3] == b"ID3" || (head[0] == 0xFF && head[1] & 0xE0 == 0xE0))
    {
        "audio/mpeg"
    } else {
        "application/octet-stream"
    }
}

pub fn parse_range(h: Option<&str>, len: u64) -> Option<(u64, u64)> {
    let v = h?.trim().strip_prefix("bytes=")?;
    let (a, b) = v.split_once('-')?;
    if len == 0 {
        return None;
    }
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (len.saturating_sub(n), len - 1)
    } else {
        let s: u64 = a.parse().ok()?;
        let e = if b.is_empty() {
            len - 1
        } else {
            b.parse::<u64>().ok()?.min(len - 1)
        };
        (s, e)
    };
    (start <= end && start < len).then_some((start, end))
}

const SLICE_MAX: u64 = 8 * 1024 * 1024;

pub type Slice = (u16, Vec<u8>, u64, u64, u64, &'static str);

pub fn read_slice(id: &str, range: Option<&str>) -> Option<Slice> {
    let path = file_for(id)?;
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut head = [0u8; 12];
    let n = f.read(&mut head).ok()?;
    let mime = sniff_mime(&head[..n]);
    // bez Range też najwyżej 8 MiB, bo 9 h nagranie w całości to setki MB w pamięci
    let cap = |s: u64, e: u64| e.min(s + SLICE_MAX - 1);
    let (status, start, end) = match parse_range(range, len) {
        Some((s, e)) => (206u16, s, cap(s, e)),
        None if len > SLICE_MAX => (206u16, 0, cap(0, len - 1)),
        None => (200u16, 0, len.saturating_sub(1)),
    };
    f.seek(SeekFrom::Start(start)).ok()?;
    let want = if len == 0 { 0 } else { end - start + 1 };
    let mut buf = vec![0u8; want as usize];
    f.read_exact(&mut buf).ok()?;
    Some((status, buf, start, end, len, mime))
}

fn duration_from_url(url: &str) -> Option<f64> {
    let q = url.split_once('?')?.1;
    q.split('&')
        .find_map(|kv| kv.strip_prefix("dur="))
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|d| d.is_finite() && *d > 0.0)
}

#[cfg(test)]
mod tests {
    // serwer z Range: odpowiedź n-ta (od 0) dostaje bodies[n], a cut[n] zrywa ją po tylu bajtach
    fn flaky_server(bodies: Vec<Vec<u8>>, cut: Vec<Option<usize>>) -> String {
        use std::io::{BufRead, BufReader, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for (n, c) in l.incoming().flatten().enumerate() {
                let body = bodies[n.min(bodies.len() - 1)].clone();
                let cut = cut.get(n).copied().flatten();
                let mut r = BufReader::new(c.try_clone().unwrap());
                let mut from = 0usize;
                loop {
                    let mut line = String::new();
                    if r.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                        from = v.trim().trim_end_matches('-').parse().unwrap_or(0);
                    }
                }
                let len = body.len();
                let from = from.min(len);
                let mut c = c;
                let head = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {from}-{}/{len}\r\nConnection: close\r\n\r\n",
                    len - from,
                    len - 1
                );
                let _ = c.write_all(head.as_bytes());
                let end = cut.map(|k| (from + k).min(len)).unwrap_or(len);
                let _ = c.write_all(&body[from..end]);
                let _ = c.flush();
            }
        });
        format!("http://127.0.0.1:{port}/a")
    }

    fn tmp_part(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("zenith-part-{tag}-{}.part", std::process::id()))
    }

    #[tokio::test]
    async fn resumes_from_the_byte_where_the_connection_dropped() {
        let body: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let url = flaky_server(vec![body.clone()], vec![Some(120_000), None]);
        let part = tmp_part("resume");
        let mut seen = 0u64;
        let n = super::fetch_part(&url, &part, |d, _| seen = d)
            .await
            .unwrap();
        assert_eq!(n, body.len() as u64);
        assert_eq!(seen, n);
        assert_eq!(std::fs::read(&part).unwrap(), body);
        let _ = std::fs::remove_file(&part);
    }

    #[tokio::test]
    async fn restarts_when_the_file_changes_under_a_new_link() {
        let first: Vec<u8> = vec![1; 200_000];
        let second: Vec<u8> = vec![2; 150_000];
        let url = flaky_server(vec![first, second.clone()], vec![Some(50_000), None, None]);
        let part = tmp_part("swap");
        let n = super::fetch_part(&url, &part, |_, _| {}).await.unwrap();
        assert_eq!(n, second.len() as u64);
        assert_eq!(std::fs::read(&part).unwrap(), second);
        let _ = std::fs::remove_file(&part);
    }

    #[test]
    fn duration_from_stream_url() {
        assert_eq!(
            super::duration_from_url(
                "https://x.googlevideo.com/videoplayback?itag=251&dur=223.481&mime=audio"
            ),
            Some(223.481)
        );
        assert_eq!(
            super::duration_from_url("https://x/videoplayback?itag=251"),
            None
        );
        assert_eq!(super::duration_from_url("https://x/v?dur=abc"), None);
    }
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range(Some("bytes=0-"), 100), Some((0, 99)));
        assert_eq!(parse_range(Some("bytes=10-19"), 100), Some((10, 19)));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Some((90, 99)));
        assert_eq!(parse_range(Some("bytes=50-500"), 100), Some((50, 99)));
        assert_eq!(parse_range(Some("bytes=200-"), 100), None);
        assert_eq!(parse_range(None, 100), None);
    }

    #[test]
    fn mime() {
        assert_eq!(sniff_mime(&[0x1A, 0x45, 0xDF, 0xA3]), "audio/webm");
        assert_eq!(sniff_mime(b"\0\0\0\x20ftypM4A "), "audio/mp4");
        assert_eq!(sniff_mime(b"xx"), "application/octet-stream");
    }

    #[test]
    fn ids() {
        assert!(valid_id("dQw4w9WgXcQ"));
        assert!(!valid_id("../etc/pass"));
        assert!(!valid_id("short"));
    }

    #[test]
    fn audio_missing_from_a_valid_index_comes_back() {
        let dir = std::env::temp_dir().join(format!("zenith-dl-orphan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("aaaaaaaaaaa.audio"), b"OggS").unwrap();
        std::fs::write(dir.join("bbbbbbbbbbb.audio"), b"OggS0123").unwrap();
        let known = DownloadMeta {
            id: "aaaaaaaaaaa".into(),
            title: "known".into(),
            artist: String::new(),
            album: String::new(),
            cover: String::new(),
            duration: 1.0,
            size: 4,
            saved_at: 1,
            file: String::new(),
        };
        std::fs::write(
            dir.join("index.json"),
            serde_json::to_string(&vec![known.clone()]).unwrap(),
        )
        .unwrap();
        let raw = std::fs::read_to_string(dir.join("index.json")).unwrap();
        let map = load_index(&dir, &raw);
        let renamed = DownloadMeta {
            file: "known [aaaaaaaaaaa].ogg".into(),
            ..known
        };
        assert_eq!(map.get("aaaaaaaaaaa"), Some(&renamed));
        assert!(dir.join("known [aaaaaaaaaaa].ogg").is_file());
        let orphan = map.get("bbbbbbbbbbb").unwrap();
        assert_eq!((orphan.title.as_str(), orphan.size), ("bbbbbbbbbbb", 8));
        assert!(dir.join(&orphan.file).is_file() && orphan.file.ends_with(".ogg"));
        assert!(!dir.join("bbbbbbbbbbb.audio").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn index_roundtrip_and_slice() {
        let dir = std::env::temp_dir().join(format!("zenith-dl-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let id = "abcdefghijk";
        std::fs::write(dir.join(format!("{id}.audio")), b"OggS0123456789").unwrap();
        let meta = DownloadMeta {
            id: id.into(),
            title: "t".into(),
            artist: String::new(),
            album: String::new(),
            cover: String::new(),
            duration: 1.0,
            size: 14,
            saved_at: 1,
            file: String::new(),
        };
        let ghost = DownloadMeta {
            id: "zzzzzzzzzzz".into(),
            ..meta.clone()
        };
        std::fs::write(
            dir.join("index.json"),
            serde_json::to_string(&vec![meta.clone(), ghost]).unwrap(),
        )
        .unwrap();
        init_dir(dir.clone());
        let file = format!("t [{id}].ogg");
        let meta = DownloadMeta { file, ..meta };
        assert_eq!(downloads_list(), vec![meta.clone()]);
        let saved: Vec<DownloadMeta> =
            serde_json::from_str(&std::fs::read_to_string(dir.join("index.json")).unwrap())
                .unwrap();
        assert_eq!(saved, vec![meta.clone()]);
        let (st, buf, s, e, len, mime) = read_slice(id, Some("bytes=4-7")).unwrap();
        assert_eq!(
            (st, &buf[..], s, e, len, mime),
            (206, &b"0123"[..], 4, 7, 14, "audio/ogg")
        );
        downloads_delete(id.into()).unwrap();
        assert!(downloads_list().is_empty());
        assert!(!dir.join(&meta.file).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn readable_names_keep_the_id() {
        let meta = DownloadMeta {
            id: "HyHNuVaZJ-k".into(),
            title: "Feel Good Inc.".into(),
            artist: "Gorillaz".into(),
            album: String::new(),
            cover: String::new(),
            duration: 0.0,
            size: 0,
            saved_at: 0,
            file: String::new(),
        };
        let name = file_name(&meta, ext_for(&[0x1A, 0x45, 0xDF, 0xA3]));
        assert_eq!(name, "Gorillaz - Feel Good Inc [HyHNuVaZJ-k].webm");
        assert_eq!(id_of(&name).as_deref(), Some("HyHNuVaZJ-k"));
        assert_eq!(id_of("HyHNuVaZJ-k.audio").as_deref(), Some("HyHNuVaZJ-k"));
        assert_eq!(id_of("notes [HyHNuVaZJ-k].txt"), None);
        assert_eq!(id_of("x [short].webm"), None);
        assert!(plain_name(&name));
        assert!(!plain_name("../index.json") && !plain_name("a/b.webm") && !plain_name("a\\b"));
        assert!(!plain_name("C:x.webm") && !plain_name("a.webm:stream"));
    }
}
