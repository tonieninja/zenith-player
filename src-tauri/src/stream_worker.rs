//! resident yt-dlp resolvers. a resolve used to start yt-dlp.exe every time (process,
//! python imports, player JS from disk, the music "next" request and an m3u8 manifest
//! nobody needs): ~3 s here. a few warm processes answering over stdin with only the
//! requests playback needs take ~1.1 s, most of it the JS challenge solve.
//! the plugin is next to the binary (yt-dlp loads `yt-dlp-plugins/` from there)
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;

const PLUGIN: &str = include_str!("zenith_worker.py");
/// three warm processes (each with its own node): a click should not queue behind
/// the background prefetches of the next tracks
const POOL: usize = 3;

/// web_music: with its client config cached in the worker (one page per session, like
/// a browser) a warm resolve is ~0.25 s and googlevideo accepts its urls for official
/// uploads too. skipping the watch page, the music "next" data and the m3u8 manifest is
/// what makes it fast; dash is still needed (skipping it loses the formats)
pub const WORKER_CLIENTS: &str = "web_music";

type Reply = Sender<Value>;

struct Worker {
    bin: PathBuf,
    /// cookie file + its mtime for the signed-in worker (yt-dlp reads cookies at start)
    cookies: Option<(PathBuf, Option<std::time::SystemTime>)>,
    child: Child,
    stdin: ChildStdin,
    pending: Arc<Mutex<HashMap<u64, Reply>>>,
    busy: Arc<AtomicUsize>,
    dead: Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

static POOL_SLOTS: OnceLock<Vec<Mutex<Option<Worker>>>> = OnceLock::new();
/// signed-in worker, only used when googlevideo refused the anonymous url (some uploads
/// bind the stream to a PO token / a session; the logged-in web clients still get them)
static COOKIE_SLOT: Mutex<Option<Worker>> = Mutex::new(None);
pub const COOKIE_CLIENTS: &str = "web_music,web_safari,-tv_downgraded";

fn mtime(p: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static CACHE_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

fn slots() -> &'static Vec<Mutex<Option<Worker>>> {
    POOL_SLOTS.get_or_init(|| (0..POOL).map(|_| Mutex::new(None)).collect())
}

fn install_plugin(bin: &Path) -> Option<()> {
    let dir = bin
        .parent()?
        .join("yt-dlp-plugins")
        .join("zenith")
        .join("yt_dlp_plugins")
        .join("extractor");
    let file = dir.join("zenith_worker.py");
    if std::fs::read_to_string(&file).ok().as_deref() != Some(PLUGIN) {
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::write(&file, PLUGIN).ok()?;
    }
    Some(())
}

fn spawn(bin: &Path) -> Option<Worker> {
    spawn_with(bin, None)
}

fn spawn_with(bin: &Path, cookies: Option<&Path>) -> Option<Worker> {
    install_plugin(bin)?;
    let mut cmd = Command::new(bin);
    cmd.args(["--ignore-config", "--quiet", "--no-warnings"]);
    if let Some(c) = cookies {
        cmd.arg("--cookies").arg(c);
    }
    if let Some(Some(c)) = CACHE_DIR.get() {
        cmd.arg("--cache-dir").arg(c);
    }
    if let Some(node) = crate::ytdlp::node_executable() {
        cmd.arg("--js-runtimes")
            .arg(format!("node:{}", node.display()));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.args(["--compat-options", "no-certifi"]);
        cmd.creation_flags(0x08000000);
    }
    cmd.arg("zenith-worker:serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let pending: Arc<Mutex<HashMap<u64, Reply>>> = Arc::default();
    let dead = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (p2, d2) = (pending.clone(), dead.clone());
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Some(body) = line.strip_prefix("@@ZW ") else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<Value>(body) else {
                continue;
            };
            if v.get("ready").is_some() {
                crate::timeline::mark("worker ready");
                continue;
            }
            let id = v.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
            if let Some(tx) = p2.lock().ok().and_then(|mut g| g.remove(&id)) {
                let _ = tx.send(v);
            }
        }
        d2.store(true, Ordering::SeqCst);
        // wake everyone still waiting on this process
        if let Ok(mut g) = p2.lock() {
            g.clear();
        }
    });
    // no throwaway warm-up resolve: the first real resolves (the restored queue at
    // start) would queue behind it; the preprocessed player and the client config come
    // from the yt-dlp cache dir instead
    Some(Worker {
        bin: bin.to_path_buf(),
        cookies: cookies.map(|c| (c.to_path_buf(), mtime(c))),
        child,
        stdin,
        pending,
        busy: Arc::new(AtomicUsize::new(0)),
        dead,
    })
}

/// seconds since the epoch of the last resolve
static LAST_USE: AtomicU64 = AtomicU64::new(0);
/// after this long without a resolve only one worker stays (about 65-75 MB each)
const IDLE_SHRINK_SECS: u64 = 300;
const REAP_EVERY: Duration = Duration::from_secs(60);
static REAPER: std::sync::Once = std::sync::Once::new();
static REFILLING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn start_reaper() {
    REAPER.call_once(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(REAP_EVERY);
            let idle = now_secs().saturating_sub(LAST_USE.load(Ordering::SeqCst));
            if idle < IDLE_SHRINK_SECS {
                continue;
            }
            let mut dropped = 0;
            for slot in slots().iter().skip(1) {
                if let Ok(mut g) = slot.lock() {
                    if g.as_ref()
                        .map(|w| w.busy.load(Ordering::SeqCst) == 0)
                        .unwrap_or(false)
                    {
                        *g = None;
                        dropped += 1;
                    }
                }
            }
            if let Ok(mut g) = COOKIE_SLOT.lock() {
                if g.as_ref()
                    .map(|w| w.busy.load(Ordering::SeqCst) == 0)
                    .unwrap_or(false)
                {
                    *g = None;
                    dropped += 1;
                }
            }
            if dropped > 0 {
                crate::timeline::mark(format!("worker pool idle: {dropped} stopped"));
            }
        });
    });
}

/// a resolve came in: if the pool was shrunk, bring it back in the background (the
/// one that stayed answers this request right away)
fn note_use(app: &AppHandle) {
    LAST_USE.store(now_secs(), Ordering::SeqCst);
    let missing = slots()
        .iter()
        .any(|s| s.lock().map(|g| g.is_none()).unwrap_or(false));
    if missing && !REFILLING.swap(true, Ordering::SeqCst) {
        warm(app);
    }
}

/// start the pool (app start, and again when the binary changed). cheap when warm
pub fn warm(app: &AppHandle) {
    start_reaper();
    LAST_USE.store(now_secs(), Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = CACHE_DIR.set(crate::stream::ytdlp_cache_dir_pub(&app));
        let Ok(bin) = crate::ytdlp::ensure_ytdlp(&app) else {
            REFILLING.store(false, Ordering::SeqCst);
            return;
        };
        let stale = |g: &Option<Worker>| {
            g.as_ref()
                .map(|w| {
                    w.dead.load(Ordering::SeqCst)
                        || (w.bin != bin && w.busy.load(Ordering::SeqCst) == 0)
                })
                .unwrap_or(true)
        };
        for slot in slots() {
            // spawn outside the slot lock: a resolve picking a worker meanwhile must not
            // wait for a python start
            if !slot.lock().map(|g| stale(&g)).unwrap_or(false) {
                continue;
            }
            let fresh = spawn(&bin);
            if let Ok(mut g) = slot.lock() {
                if stale(&g) {
                    *g = fresh;
                }
            }
        }
        crate::timeline::mark("worker pool spawned");
        REFILLING.store(false, Ordering::SeqCst);
    });
}

fn ask(w: &mut Worker, req: &Value, id: u64, timeout: Duration) -> Option<Value> {
    let (tx, rx) = channel();
    if let Ok(mut p) = w.pending.lock() {
        p.insert(id, tx);
    }
    if writeln!(w.stdin, "{req}")
        .and_then(|_| w.stdin.flush())
        .is_err()
    {
        w.dead.store(true, Ordering::SeqCst);
        return None;
    }
    rx.recv_timeout(timeout).ok()
}

fn url_and_ua(v: &Value) -> Option<(String, Option<String>)> {
    let url = v.get("url")?.as_str()?.to_string();
    if !url.starts_with("https://") {
        return None;
    }
    let ua = v
        .get("headers")
        .and_then(|h| h.get("User-Agent"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Some((url, ua))
}

/// the signed-in worker (spawned on first need, respawned when the cookie file changed).
/// one request at a time; it only runs when an anonymous url was refused
pub fn resolve_signed_in(
    app: &AppHandle,
    cookies: &Path,
    video_id: &str,
    format: &str,
    timeout: Duration,
) -> Option<(String, Option<String>)> {
    let bin = crate::ytdlp::ensure_ytdlp(app).ok()?;
    let mut g = COOKIE_SLOT.lock().ok()?;
    let stale = match g.as_ref() {
        None => true,
        Some(w) => {
            w.dead.load(Ordering::SeqCst)
                || w.bin != bin
                || w.cookies
                    .as_ref()
                    .map(|(p, m)| p != cookies || *m != mtime(cookies))
                    .unwrap_or(true)
        }
    };
    if stale {
        *g = None;
        *g = spawn_with(&bin, Some(cookies));
    }
    let w = g.as_mut()?;
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let req = json!({
        "id": id, "video": video_id, "format": format, "clients": COOKIE_CLIENTS,
        "ea": {"player_skip": "initial_data", "skip": "hls,translated_subs"},
    });
    crate::timeline::mark(format!("signed-in worker ask {video_id}"));
    let v = ask(w, &req, id, timeout)?;
    crate::timeline::mark(format!(
        "signed-in worker answer {video_id} ms={} ok={}",
        v.get("ms").and_then(|x| x.as_u64()).unwrap_or(0),
        v.get("url").is_some()
    ));
    url_and_ua(&v)
}

/// second choice when googlevideo refuses the web_music url (~0.5 s warm)
pub const FALLBACK_CLIENTS: &str = "web_embedded";

pub fn resolve_clients(
    app: &AppHandle,
    video_id: &str,
    format: &str,
    clients: &str,
    timeout: Duration,
) -> Option<(String, Option<String>)> {
    let bin = crate::ytdlp::ensure_ytdlp(app).ok()?;
    note_use(app);
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = channel();
    let mut sent: Option<Arc<AtomicUsize>> = None;
    // pick + send under one lock, so two parallel resolves land on different workers
    static SELECT: Mutex<()> = Mutex::new(());
    let _pick = SELECT.lock().ok();
    // least busy live slot; respawn a dead one or one on an outdated binary
    let mut order: Vec<(usize, usize)> = slots()
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let load = s
                .lock()
                .ok()
                .and_then(|g| g.as_ref().map(|w| w.busy.load(Ordering::SeqCst)))
                .unwrap_or(usize::MAX / 2);
            (load, i)
        })
        .collect();
    order.sort();
    for (_, i) in order {
        let Ok(mut g) = slots()[i].lock() else {
            continue;
        };
        let replace = match g.as_ref() {
            None => true,
            Some(w) => {
                w.dead.load(Ordering::SeqCst)
                    || (w.bin != bin && w.busy.load(Ordering::SeqCst) == 0)
            }
        };
        if replace {
            *g = None;
            *g = spawn(&bin);
        }
        let Some(w) = g.as_mut() else { continue };
        let req = json!({
            "id": id,
            "video": video_id,
            "format": format,
            "clients": clients,
            "ea": {"player_skip": "webpage,initial_data", "skip": "hls,translated_subs"},
        });
        if let Ok(mut p) = w.pending.lock() {
            p.insert(id, tx.clone());
        }
        if writeln!(w.stdin, "{req}")
            .and_then(|_| w.stdin.flush())
            .is_ok()
        {
            w.busy.fetch_add(1, Ordering::SeqCst);
            sent = Some(w.busy.clone());
            break;
        }
        w.dead.store(true, Ordering::SeqCst);
    }
    drop(_pick);
    let busy = sent?;
    crate::timeline::mark(format!("worker ask {video_id} [{clients}]"));
    let got = rx.recv_timeout(timeout).ok();
    busy.fetch_sub(1, Ordering::SeqCst);
    let v = got?;
    crate::timeline::mark(format!(
        "worker answer {video_id} ms={} ok={}",
        v.get("ms").and_then(|x| x.as_u64()).unwrap_or(0),
        v.get("url").is_some()
    ));
    let url = v.get("url")?.as_str()?.to_string();
    if !url.starts_with("https://") {
        return None;
    }
    let ua = v
        .get("headers")
        .and_then(|h| h.get("User-Agent"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Some((url, ua))
}
