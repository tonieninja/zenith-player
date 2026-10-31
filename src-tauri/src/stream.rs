use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{command, AppHandle, Manager};

use crate::player;
use crate::stream_proxy;
use crate::ytdlp;
use crate::ytm_api;

/// video id -> (stream url, mime, fetched-at)
type StreamCache = Mutex<HashMap<String, (String, String, u64)>>;

static STREAM_CACHE: OnceLock<StreamCache> = OnceLock::new();

fn get_cache() -> &'static StreamCache {
    STREAM_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// googlevideo urls carry their own expiry (`expire=<unix secs>`, usually ~6h out).
/// trusting it instead of a fixed 4 minute window means a track played again, or one
/// the preload resolved a while ago, starts instantly without another yt-dlp run
fn url_expiry(url: &str) -> Option<u64> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == "expire").then(|| v.parse::<u64>().ok()).flatten()
    })
}

/// still safe to hand out: 10 min margin before googlevideo's expiry, capped at 3h
/// after we resolved it. urls without an expiry keep the old short window
fn cache_fresh(url: &str, fetched_at: u64, now: u64) -> bool {
    match url_expiry(url) {
        Some(exp) => now + 600 < exp && now.saturating_sub(fetched_at) < 3 * 3600,
        None => now.saturating_sub(fetched_at) < 240,
    }
}

fn validate_video_id(video_id: &str) -> Result<(), String> {
    if video_id.len() == 11
        && video_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Ok(())
    } else {
        Err("invalid video id".into())
    }
}

fn pick_stream_url(stdout: &str) -> Option<String> {
    let urls: Vec<&str> = stdout
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("http://") || line.starts_with("https://"))
        .collect();
    urls.iter()
        .copied()
        .find(|u| {
            let l = u.to_ascii_lowercase();
            l.contains("mime=audio")
                || l.contains("itag=140")
                || l.contains("itag=251")
                || l.contains("itag=139")
        })
        .or_else(|| urls.first().copied())
        .map(|s| s.to_string())
}

/// "User-Agent" from the `%(http_headers)j` line yt-dlp printed next to the url
fn pick_user_agent(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('{'))
        .find_map(|l| {
            let v: Value = serde_json::from_str(l).ok()?;
            let ua = v.get("User-Agent")?.as_str()?.trim();
            (!ua.is_empty()).then(|| ua.to_string())
        })
}

static CLIENT_UA: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn remember_client_ua(video_id: &str, ua: Option<String>) {
    let map = CLIENT_UA.get_or_init(|| Mutex::new(HashMap::new()));
    let mut m = map.lock().unwrap_or_else(|e| e.into_inner());
    match ua {
        Some(ua) => {
            m.insert(video_id.to_string(), ua);
        }
        None => {
            m.remove(video_id);
        }
    }
    if m.len() > 64 {
        m.clear();
    }
}

fn ua_for(video_id: &str) -> String {
    CLIENT_UA
        .get()
        .and_then(|m| m.lock().ok().and_then(|m| m.get(video_id).cloned()))
        .unwrap_or_else(|| YTDLP_UA.to_string())
}

/// client sets tried, in order, when googlevideo refuses an url mid-playback
const RECOVERY_CLIENTS: &[&str] = &[
    "youtube:player_client=android_vr",
    "youtube:player_client=tv,web_embedded",
    "youtube:player_client=ios,mweb",
    "youtube:player_client=web_music,web_safari,-tv_downgraded",
];

pub const RECOVERY_ATTEMPTS: usize = RECOVERY_CLIENTS.len();

static APP: OnceLock<AppHandle> = OnceLock::new();

/// client set that last gave a playable url on this network; tried first on the next
/// resolves and kept on disk, so the first track after a restart doesn't have to find
/// out again that e.g. the TV and Android VR urls get a 403 here
static PREFERRED_CLIENTS: Mutex<Option<String>> = Mutex::new(None);
static PREFERRED_LOADED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// raced on a resolve when there is no working preference yet (or it stopped working)
const RACE_CLIENTS: &[&str] = &[
    "youtube:player_client=default,android_vr,web_embedded,tv",
    "youtube:player_client=tv,web_embedded",
    "youtube:player_client=android_vr",
];

fn pref_file() -> Option<std::path::PathBuf> {
    Some(
        APP.get()?
            .path()
            .app_local_data_dir()
            .ok()?
            .join("stream-client.txt"),
    )
}

fn known_client_set(c: &str) -> bool {
    RACE_CLIENTS.contains(&c) || RECOVERY_CLIENTS.contains(&c)
}

fn preferred_clients() -> Option<String> {
    if !PREFERRED_LOADED.swap(true, Ordering::SeqCst) {
        if let Some(saved) = pref_file().and_then(|p| std::fs::read_to_string(p).ok()) {
            let saved = saved.trim().to_string();
            if known_client_set(&saved) {
                if let Ok(mut g) = PREFERRED_CLIENTS.lock() {
                    g.get_or_insert(saved);
                }
            }
        }
    }
    PREFERRED_CLIENTS.lock().ok().and_then(|g| g.clone())
}

fn set_preferred_clients(c: &str) {
    if let Ok(mut g) = PREFERRED_CLIENTS.lock() {
        if g.as_deref() == Some(c) {
            return;
        }
        *g = Some(c.to_string());
    }
    if let Some(p) = pref_file() {
        let _ = std::fs::write(p, c);
    }
}

/// does googlevideo hand out this url? only the response headers are read (~0.1-0.3 s),
/// the body is dropped, instead of finding out in the stream proxy and recovering one client
/// set at a time. only a clear refusal counts as dead; a network error is left to the
/// proxy, which has its own route fallbacks
fn probe_playable(url: &str, ua: &str) -> bool {
    // same request the stream proxy makes first (an open range, Origin set): a 2 byte
    // range was answered 206 for android_vr urls that then got a 403 in the proxy
    match tauri::async_runtime::block_on(stream_proxy::probe_status(url, ua)) {
        Some(c) => !matches!(c, 401 | 403 | 404 | 410 | 429),
        None => true,
    }
}

pub fn ytdlp_cache_dir_pub(app: &AppHandle) -> Option<std::path::PathBuf> {
    ytdlp_cache_dir(app)
}

fn ytdlp_cache_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_local_data_dir().ok()?.join("yt-dlp-cache");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// googlevideo answered 403/410/429 for the url we handed out: resolve the same video
/// again with a different player client (the session cookies on the last one) and
/// return the new upstream, so the proxy can retry the request without the <audio>
/// element ever seeing an error. `attempt` picks the client set
pub async fn recover_upstream(
    video_id: &str,
    attempt: usize,
    failed_url: &str,
) -> Option<stream_proxy::Upstream> {
    let app = APP.get()?.clone();
    let clients = RECOVERY_CLIENTS.get(attempt)?.to_string();
    let vid = video_id.to_string();
    let lock = resolve_lock(video_id);
    let _held = lock.lock().await;
    // another request for the same track already recovered while we waited
    if let Some(cur) = stream_proxy::current_upstream(video_id) {
        if cur.url != failed_url {
            return Some(cur);
        }
    }
    // first recovery: the warm signed-in worker (~0.6 s) instead of starting yt-dlp with
    // one client set after another (~4 s each). uploads whose anonymous urls googlevideo
    // refuses play with the session
    if attempt == 0 {
        let app2 = app.clone();
        let vid2 = vid.clone();
        let fast = tokio::task::spawn_blocking(move || {
            let fmt = "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best";
            crate::stream_worker::resolve_clients(
                &app2,
                &vid2,
                fmt,
                crate::stream_worker::FALLBACK_CLIENTS,
                Duration::from_secs(10),
            )
            .or_else(|| {
                let cookies = cookie_file_for(&app2)?;
                crate::stream_worker::resolve_signed_in(
                    &app2,
                    &cookies,
                    &vid2,
                    fmt,
                    Duration::from_secs(10),
                )
            })
        })
        .await
        .ok()
        .flatten();
        if let Some((url, ua)) = fast {
            if url != failed_url {
                remember_client_ua(video_id, ua);
                let ua = ua_for(video_id);
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let _ = remember_and_proxy(video_id, &url, &ua, now);
                return Some(stream_proxy::Upstream {
                    url,
                    user_agent: ua,
                });
            }
        }
    }
    let use_cookies = attempt + 1 == RECOVERY_CLIENTS.len();
    let got = tokio::task::spawn_blocking(move || {
        let bin = ytdlp::ensure_ytdlp(&app).ok()?;
        let cookies = if use_cookies {
            cookie_file_for(&app)
        } else {
            None
        };
        let cache = ytdlp_cache_dir(&app);
        run_ytdlp_get_url(
            &bin,
            &vid,
            cookies.as_deref(),
            cache.as_deref(),
            "bestaudio/best",
            clients,
        )
        .ok()
        .flatten()
    })
    .await
    .ok()
    .flatten()?;
    let ua = ua_for(video_id);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    eprintln!(
        "[Zenith] stream recovered for {} (client set {})",
        video_id, attempt
    );
    // this network keeps refusing the urls of the default mix: start with what worked
    if !use_cookies {
        set_preferred_clients(RECOVERY_CLIENTS[attempt]);
    }
    let _ = remember_and_proxy(video_id, &got, &ua, now);
    Some(stream_proxy::Upstream {
        url: got,
        user_agent: ua,
    })
}

/// player clients for yt-dlp.
/// signed out: the usual mix (android_vr is the most reliable without cookies).
/// with cookies: yt-dlp skips android_vr and falls back to the logged-in tv_downgraded
/// client, which youtube currently answers with "The page needs to be reloaded" - so
/// it is excluded and the web clients that do accept cookies are used instead
fn extractor_args_for(with_cookies: bool) -> String {
    if with_cookies {
        "youtube:player_client=default,-tv_downgraded,web_safari,web_embedded".into()
    } else {
        "youtube:player_client=default,android_vr,web_embedded,tv".into()
    }
}

thread_local! {
    /// a worker url googlevideo refused: still the last resort if nothing else resolves
    static WORKER_REFUSED: std::cell::RefCell<Option<(String, Option<String>)>> =
        const { std::cell::RefCell::new(None) };
}

fn fallback_from_worker(_video_id: &str, url: String, ua: Option<String>) {
    WORKER_REFUSED.with(|c| *c.borrow_mut() = Some((url, ua)));
}

/// the stream itself never needs the account: try anonymously first (fast, works for
/// everything public) and only hand the session cookies to yt-dlp when that fails
/// (age-restricted / members-only / region-locked-for-guests tracks)
fn fetch_stream_url_any(
    ytdlp_bin: &std::path::Path,
    video_id: &str,
    cookie_file: Option<&Path>,
    cache_dir: Option<&Path>,
) -> Result<Option<String>, String> {
    let format = if crate::native_audio::available() {
        "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best[ext=mp4]/best"
    } else {
        "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[ext=mp4]/best"
    };
    // warm resident resolver first (~1.1 s instead of ~3 s). its client gives urls that
    // play without a PO token; if googlevideo refuses one anyway the proxy recovers it
    // warm resident resolvers first: web_music (~0.25 s warm), and web_embedded only if
    // googlevideo refuses that url. the check reads only the response headers (~0.1 s)
    if let Some(app) = APP.get() {
        let mut refused: Option<(String, Option<String>)> = None;
        for clients in [
            crate::stream_worker::WORKER_CLIENTS,
            crate::stream_worker::FALLBACK_CLIENTS,
        ] {
            let Some((url, ua)) = crate::stream_worker::resolve_clients(
                app,
                video_id,
                format,
                clients,
                Duration::from_secs(8),
            ) else {
                continue;
            };
            if clients == crate::stream_worker::WORKER_CLIENTS {
                // no check on the critical path (~0.1 s): web_music urls are almost always
                // accepted, the check runs next to playback and swaps in a web_embedded url
                // if googlevideo refuses (the stream proxy would recover it as well)
                remember_client_ua(video_id, ua.clone());
                let (app, vid, u0, fmt) = (
                    app.clone(),
                    video_id.to_string(),
                    url.clone(),
                    format.to_string(),
                );
                std::thread::spawn(move || {
                    if probe_playable(&u0, ua.as_deref().unwrap_or(YTDLP_UA)) {
                        return;
                    }
                    if stream_proxy::current_upstream(&vid)
                        .map(|c| c.url != u0)
                        .unwrap_or(false)
                    {
                        return;
                    }
                    if let Some((u2, ua2)) = crate::stream_worker::resolve_clients(
                        &app,
                        &vid,
                        &fmt,
                        crate::stream_worker::FALLBACK_CLIENTS,
                        Duration::from_secs(10),
                    ) {
                        if probe_playable(&u2, ua2.as_deref().unwrap_or(YTDLP_UA)) {
                            remember_client_ua(&vid, ua2);
                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs())
                                .unwrap_or(0);
                            let _ = remember_and_proxy(&vid, &u2, &ua_for(&vid), now);
                        }
                    }
                });
                return Ok(Some(url));
            }
            if probe_playable(&url, ua.as_deref().unwrap_or(YTDLP_UA)) {
                remember_client_ua(video_id, ua);
                return Ok(Some(url));
            }
            refused.get_or_insert((url, ua));
        }
        if let Some((url, ua)) = refused.take() {
            fallback_from_worker(video_id, url, ua);
        }
    }
    let mut fallback: Option<(String, Option<String>)> =
        WORKER_REFUSED.with(|c| c.borrow_mut().take());
    // with no preference yet, only one resolve races (3 yt-dlp runs); the others wait
    // for it and then use the client set that won
    static RACE_GATE: Mutex<()> = Mutex::new(());
    let mut _gate = None;
    let mut preferred = preferred_clients();
    if preferred.is_none() {
        _gate = RACE_GATE.lock().ok();
        preferred = preferred_clients();
        if preferred.is_some() {
            _gate = None;
        }
    }
    if let Some(clients) = preferred.as_deref() {
        if let Ok(Some((url, ua))) = run_ytdlp_raw(
            ytdlp_bin,
            video_id,
            None,
            cache_dir,
            format,
            clients.to_string(),
        ) {
            let ok = probe_playable(&url, ua.as_deref().unwrap_or(YTDLP_UA));
            if ok {
                remember_client_ua(video_id, ua);
                return Ok(Some(url));
            }
            fallback = Some((url, ua));
        }
    }

    // no working preference: race the client sets, first url googlevideo accepts wins
    let (tx, rx) = std::sync::mpsc::channel();
    let mut started = 0;
    for set in RACE_CLIENTS
        .iter()
        .filter(|c| Some(**c) != preferred.as_deref())
    {
        let tx = tx.clone();
        let bin = ytdlp_bin.to_path_buf();
        let vid = video_id.to_string();
        let cache = cache_dir.map(|p| p.to_path_buf());
        let format = format.to_string();
        std::thread::spawn(move || {
            let got = run_ytdlp_raw(&bin, &vid, None, cache.as_deref(), &format, set.to_string())
                .ok()
                .flatten();
            let res = got.map(|(url, ua)| {
                let ok = probe_playable(&url, ua.as_deref().unwrap_or(YTDLP_UA));
                (*set, url, ua, ok)
            });
            let _ = tx.send(res);
        });
        started += 1;
    }
    drop(tx);
    for _ in 0..started {
        let Ok(res) = rx.recv() else { break };
        if let Some((set, url, ua, ok)) = res {
            if ok {
                set_preferred_clients(set);
                remember_client_ua(video_id, ua);
                return Ok(Some(url));
            }
            fallback.get_or_insert((url, ua));
        }
    }

    // signed in only when nothing anonymous worked (age-restricted, members-only, ...)
    if let Some(cookies) = cookie_file {
        if let Ok(Some(url)) = fetch_stream_url_sync(ytdlp_bin, video_id, Some(cookies), cache_dir)
        {
            return Ok(Some(url));
        }
    }
    // a refused url is still better than none: the proxy recovers it with other clients
    Ok(fallback.map(|(url, ua)| {
        remember_client_ua(video_id, ua);
        url
    }))
}

fn fetch_stream_url_sync(
    ytdlp_bin: &std::path::Path,
    video_id: &str,
    cookie_file: Option<&Path>,
    cache_dir: Option<&Path>,
) -> Result<Option<String>, String> {
    let format = if crate::native_audio::available() {
        "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best[ext=mp4]/best"
    } else {
        "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best[ext=mp4]/best"
    };
    let extractor = extractor_args_for(cookie_file.is_some());
    run_ytdlp_get_url(
        ytdlp_bin,
        video_id,
        cookie_file,
        cache_dir,
        format,
        extractor,
    )
}

/// last resort once the usual yt-dlp clients and the innertube clients failed (typically
/// "Sign in to confirm you're not a bot" for this IP): yt-dlp's full client rotation incl.
/// the web clients that solve the JS challenges itself, any audio format, plus the
/// session cookies when we have them (a signed-in request is not bot-checked)
const LAST_RESORT_CLIENTS: &str =
    "youtube:player_client=default,-tv_downgraded,mweb,web_safari,web_music,tv_simply,android_vr";

fn fetch_stream_url_last_resort(
    ytdlp_bin: &std::path::Path,
    video_id: &str,
    cookie_file: Option<&Path>,
    cache_dir: Option<&Path>,
) -> Result<Option<String>, String> {
    run_ytdlp_get_url(
        ytdlp_bin,
        video_id,
        cookie_file,
        cache_dir,
        "bestaudio/best",
        LAST_RESORT_CLIENTS.to_string(),
    )
}

fn run_ytdlp_get_url(
    ytdlp_bin: &std::path::Path,
    video_id: &str,
    cookie_file: Option<&Path>,
    cache_dir: Option<&Path>,
    format: &str,
    extractor: String,
) -> Result<Option<String>, String> {
    let got = run_ytdlp_raw(
        ytdlp_bin,
        video_id,
        cookie_file,
        cache_dir,
        format,
        extractor,
    )?;
    Ok(got.map(|(url, ua)| {
        remember_client_ua(video_id, ua);
        url
    }))
}

/// one yt-dlp run (plus the network fallbacks): the url and the user agent it belongs to
fn run_ytdlp_raw(
    ytdlp_bin: &std::path::Path,
    video_id: &str,
    cookie_file: Option<&Path>,
    cache_dir: Option<&Path>,
    format: &str,
    extractor: String,
) -> Result<Option<(String, Option<String>)>, String> {
    let page = format!("https://music.youtube.com/watch?v={}", video_id);

    let mut args: Vec<String> = vec![
        "-f".into(),
        format.into(),
        "--extractor-args".into(),
        extractor,
        "--socket-timeout".into(),
        "10".into(),
        "--retries".into(),
        "1".into(),
        "--no-playlist".into(),
        "--ignore-config".into(),
        "--no-warnings".into(),
        // url + the headers yt-dlp would send for it: googlevideo urls from the android/
        // ios/tv clients are tied to that client's user agent, replaying them with a
        // desktop chrome UA is a common cause of 403 mid-track
        "--print".into(),
        "url".into(),
        "--print".into(),
        "%(http_headers)j".into(),
    ];
    if let Some(cache) = cache_dir {
        args.push("--cache-dir".into());
        args.push(cache.display().to_string());
    }
    if let Some(cookies) = cookie_file {
        args.push("--cookies".into());
        args.push(cookies.display().to_string());
    }
    if let Some(node) = ytdlp::node_executable() {
        args.push("--js-runtimes".into());
        args.push(format!("node:{}", node.display()));
    }
    // yt-dlp ships its own CA bundle (certifi). school / company networks that inspect
    // HTTPS install their own root in the Windows store, which certifi does not know, so
    // every request failed with CERTIFICATE_VERIFY_FAILED while the browser (WebView2) and
    // the Rust clients (native roots) worked. use the system store instead, like they do
    #[cfg(windows)]
    {
        args.push("--compat-options".into());
        args.push("no-certifi".into());
    }
    if let Some(extra) = NET_FALLBACK.lock().ok().and_then(|g| *g) {
        args.extend(extra.iter().map(|x| x.to_string()));
    }
    args.push(page);

    let mut cmd = Command::new(ytdlp_bin);
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    crate::timeline::mark(format!(
        "ytdlp spawn {video_id} [{}]",
        args.iter()
            .position(|a| a == "--extractor-args")
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_default()
    ));
    let output = run_with_timeout(cmd, Duration::from_secs(25))?;
    crate::timeline::mark(format!(
        "ytdlp exit {video_id} ok={}",
        pick_stream_url(&String::from_utf8_lossy(&output.stdout)).is_some()
    ));

    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Some(url) = pick_stream_url(&stdout) {
        return Ok(Some((url, pick_user_agent(&stdout))));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    eprintln!("[Zenith] yt-dlp error ({}): {}", video_id, stderr.trim());
    let kind = classify_failure(&stderr);
    note_failure(kind);
    // network-level failure (school / office filter, TLS inspection, a WPAD proxy that
    // breaks googlevideo, ...): walk through the fallbacks instead of giving up. each
    // one is a separate yt-dlp run, so only the ones that fit the error are tried
    if kind == "network" {
        for (name, extra) in network_fallbacks(&stderr, proxy_in_env()) {
            let mut a2 = args.clone();
            let page = a2.pop().unwrap_or_default();
            a2.extend(extra.iter().map(|x| x.to_string()));
            a2.push(page);
            let mut c2 = Command::new(ytdlp_bin);
            c2.args(&a2).stdout(Stdio::piped()).stderr(Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                c2.creation_flags(0x08000000);
            }
            match run_with_timeout(c2, Duration::from_secs(25)) {
                Ok(out) => {
                    let so = String::from_utf8_lossy(&out.stdout);
                    if let Some(url) = pick_stream_url(&so) {
                        eprintln!(
                            "[Zenith] yt-dlp ok with fallback '{}' for {}",
                            name, video_id
                        );
                        let ua = pick_user_agent(&so);
                        if let Ok(mut g) = NET_FALLBACK.lock() {
                            *g = Some(extra);
                        }
                        return Ok(Some((url, ua)));
                    }
                    let se = String::from_utf8_lossy(&out.stderr);
                    eprintln!(
                        "[Zenith] yt-dlp fallback '{}' failed ({}): {}",
                        name,
                        video_id,
                        se.trim()
                    );
                }
                Err(e) => eprintln!(
                    "[Zenith] yt-dlp fallback '{}' failed ({}): {}",
                    name, video_id, e
                ),
            }
        }
    }
    Ok(None)
}

/// network fallback that worked last time; added to every later run right away so a
/// school network costs the extra attempt once per session, not once per track
static NET_FALLBACK: Mutex<Option<&'static [&'static str]>> = Mutex::new(None);

/// which extra yt-dlp flags to try after a network error, most conservative first.
/// - direct: the proxy windows handed us (WPAD/PAC/registry) refuses youtube, go around it
/// - system certs: TLS inspection with the school's root CA in the OS store (yt-dlp's
///   bundled certifi list does not know it). already the default on windows
/// - no cert check: last resort for an inspecting proxy whose root is not even in the OS
///   store. only the metadata request runs unchecked; the audio itself still goes through
///   the rust proxy with normal verification and must come from a googlevideo host
fn network_fallbacks(
    stderr: &str,
    has_proxy: bool,
) -> Vec<(&'static str, &'static [&'static str])> {
    let e = stderr.to_ascii_lowercase();
    let cert = e.contains("certificate") || e.contains("ssl");
    let mut v: Vec<(&'static str, &'static [&'static str])> = Vec::new();
    if has_proxy {
        v.push(("direct", &["--proxy", ""]));
    }
    if cert {
        if !cfg!(windows) {
            v.push(("system certs", &["--compat-options", "no-certifi"]));
        }
        v.push(("no cert check", &["--no-check-certificates"]));
        if has_proxy {
            v.push((
                "direct, no cert check",
                &["--proxy", "", "--no-check-certificates"],
            ));
        }
    }
    if !cert && !has_proxy {
        // a timeout / reset on ipv6 is common on badly configured school networks
        v.push(("ipv4", &["--force-ipv4"]));
    }
    v
}

fn proxy_in_env() -> bool {
    [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
    ]
    .iter()
    .any(|k| {
        std::env::var(k)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
    })
}

/// why the last resolve failed, for the error message: "network" (this network blocks or
/// breaks the connection: proxy, filter, TLS inspection, DNS), "bot" (YouTube wants a
/// sign-in for this IP, common on shared school / office IPs), "component" (yt-dlp could
/// not be downloaded), "unavailable" (the video itself)
static LAST_FAILURE: Mutex<Option<&'static str>> = Mutex::new(None);

pub(crate) fn note_failure(kind: &'static str) {
    if let Ok(mut g) = LAST_FAILURE.lock() {
        // keep the most telling reason of one resolve: network > bot > unavailable
        let rank = |k: &str| match k {
            "component" => 4,
            "network" => 3,
            "bot" => 2,
            _ => 1,
        };
        if g.map(|o| rank(kind) >= rank(o)).unwrap_or(true) {
            *g = Some(kind);
        }
    }
}

pub fn classify_failure(stderr: &str) -> &'static str {
    let e = stderr.to_ascii_lowercase();
    let net = [
        "certificate_verify_failed",
        "certificate verify failed",
        "ssl:",
        "unable to connect to proxy",
        "proxyerror",
        "tunnel connection failed",
        "connection refused",
        "connection reset",
        "timed out",
        "getaddrinfo failed",
        "name or service not known",
        "no address associated",
        "network is unreachable",
        "failed to resolve",
        "remote end closed connection",
        "http error 407",
        "unable to download webpage",
        "spawn failed",
        "eof occurred in violation",
        "wrong version number",
        "connection aborted",
        "temporary failure in name resolution",
        "no route to host",
        // a filter that answers with its own block page instead of youtube's html
        "unable to extract initial",
        "failed to parse json",
        "unable to extract yt initial data",
    ];
    if net.iter().any(|n| e.contains(n)) {
        return "network";
    }
    if e.contains("not a bot") || e.contains("sign in to confirm") || e.contains("http error 429") {
        return "bot";
    }
    "unavailable"
}

#[tauri::command]
pub fn stream_last_failure() -> Option<String> {
    LAST_FAILURE
        .lock()
        .ok()
        .and_then(|g| g.map(|s| s.to_string()))
}

/// yt-dlp normally finishes in seconds, but a stuck js challenge solver or a dead socket
/// could keep a stream request (and its blocking thread) waiting forever
fn run_with_timeout(mut cmd: Command, limit: Duration) -> Result<std::process::Output, String> {
    use std::io::Read;
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("yt-dlp spawn failed: {}", e))?;
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    // drain both pipes on their own threads so a chatty process can't block on a full pipe
    let out_t = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let err_t = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    });
    let deadline = std::time::Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("yt-dlp timed out after {}s", limit.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("yt-dlp wait failed: {e}")),
        }
    };
    Ok(std::process::Output {
        status,
        stdout: out_t.join().unwrap_or_default(),
        stderr: err_t.join().unwrap_or_default(),
    })
}

const YTDLP_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

fn write_netscape_cookies(header: &str, dest: &Path) -> Result<(), String> {
    if header.trim().is_empty() {
        return Err("empty cookies".into());
    }
    let mut out = String::from("# Netscape HTTP Cookie File\n");
    for part in header.split(';') {
        let part = part.trim();
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        let name = name.trim();
        let value = value.trim();
        if name.is_empty() || value.is_empty() {
            continue;
        }
        let secure =
            name.starts_with("__Secure-") || name.starts_with("__Host-") || name == "SAPISID";
        let flag = "TRUE";
        let sec = if secure { "TRUE" } else { "FALSE" };
        for domain in [".youtube.com", ".google.com"] {
            out.push_str(&format!(
                "{domain}\t{flag}\t/\t{sec}\t2147483647\t{name}\t{value}\n"
            ));
        }
    }
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // session cookies: private file, written aside and renamed so a yt-dlp run that is
    // reading the old file never sees a half-written one
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = dest.with_extension(format!("tmp{}", SEQ.fetch_add(1, Ordering::Relaxed)));
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(out.as_bytes()).map_err(|e| e.to_string())?;
    }
    if let Err(e) = std::fs::rename(&tmp, dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

fn cookie_file_for(app: &AppHandle) -> Option<std::path::PathBuf> {
    let header = ytm_api::resolve_cookies_public(app);
    if header.is_empty() {
        return None;
    }
    let path = app
        .path()
        .app_local_data_dir()
        .ok()?
        .join("bin")
        .join("youtube-cookies.txt");
    write_netscape_cookies(&header, &path).ok()?;
    Some(path)
}

pub fn evict_cached_url(video_id: &str) {
    if let Ok(mut cache) = get_cache().lock() {
        cache.remove(video_id);
    }
    stream_proxy::remove_direct_url(video_id);
}

pub fn wipe_netscape_cookie_file(app: &AppHandle) {
    if let Ok(dir) = app.path().app_local_data_dir() {
        let path = dir.join("bin").join("youtube-cookies.txt");
        let _ = std::fs::remove_file(path);
    }
}

fn remember_and_proxy(
    video_id: &str,
    url: &str,
    user_agent: &str,
    now: u64,
) -> Result<String, String> {
    let mut cache = get_cache()
        .lock()
        .map_err(|e| format!("Cache lock error: {}", e))?;
    if let Some((_, _, ts)) = cache.get(video_id) {
        if *ts > now {
            if let Some(proxy) = stream_proxy::proxy_url(video_id) {
                return Ok(proxy);
            }
        }
    }
    stream_proxy::store_upstream(
        video_id,
        stream_proxy::Upstream {
            url: url.to_string(),
            user_agent: user_agent.to_string(),
        },
    );
    cache.insert(
        video_id.to_string(),
        (url.to_string(), user_agent.to_string(), now),
    );
    while cache.len() > 64 {
        let oldest = cache
            .iter()
            .min_by_key(|(_, (_, _, ts))| *ts)
            .map(|(k, _)| k.clone());
        if let Some(k) = oldest {
            stream_proxy::remove_direct_url(&k);
            cache.remove(&k);
        } else {
            break;
        }
    }
    drop(cache);
    stream_proxy::proxy_url(video_id).ok_or_else(|| "stream proxy not ready".to_string())
}

#[derive(Serialize)]
pub struct YtdlpTrack {
    id: String,
    title: String,
    artist: String,
    cover: String,
    cover_small: String,
    cover_large: String,
}

type ResolveLocks = Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>;

/// one resolve per video id at a time: playback, the preload plugin and the home-feed
/// warmup used to start separate yt-dlp runs for the same track in parallel, and after a
/// failure each of them retried on its own (dozens of yt-dlp + node processes)
fn resolve_lock(video_id: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<ResolveLocks> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = locks.lock().unwrap_or_else(|e| e.into_inner());
    // drop locks nobody is holding or waiting on any more
    map.retain(|_, l| std::sync::Arc::strong_count(l) > 1);
    map.entry(video_id.to_string())
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

#[command]
pub async fn get_stream_url(
    app: AppHandle,
    video_id: String,
    fresh: Option<bool>,
) -> Result<Option<String>, String> {
    validate_video_id(&video_id)?;
    // a saved track never needs the network
    if !fresh.unwrap_or(false) && crate::downloads::is_downloaded(&video_id) {
        crate::stream_proxy::ensure_ready().await?;
        if let Some(u) = crate::stream_proxy::offline_url(&video_id) {
            return Ok(Some(u));
        }
    }
    let _ = APP.set(app.clone());
    let lock = resolve_lock(&video_id);
    let started = std::time::Instant::now();
    let _held = lock.lock().await;
    // a forced refresh that had to wait for another resolve of the same id can reuse
    // that fresh result instead of running yt-dlp again
    let waited = started.elapsed() > Duration::from_millis(200);
    let vid = video_id.clone();
    let r = get_stream_url_locked(app, video_id, fresh.filter(|f| *f && !waited)).await;
    crate::timeline::mark(format!(
        "get_stream_url end {vid} ok={}",
        matches!(r, Ok(Some(_)))
    ));
    r
}

async fn get_stream_url_locked(
    app: AppHandle,
    video_id: String,
    fresh: Option<bool>,
) -> Result<Option<String>, String> {
    stream_proxy::ensure_ready().await?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let force = fresh.unwrap_or(false);
    if force {
        evict_cached_url(&video_id);
    }

    if !force {
        let cache = get_cache()
            .lock()
            .map_err(|e| format!("Cache lock error: {}", e))?;
        if let Some((url, ua, timestamp)) = cache.get(&video_id) {
            // googlevideo urls die way before 15 min, keep the cache short
            if cache_fresh(url, *timestamp, now) {
                stream_proxy::store_upstream(
                    &video_id,
                    stream_proxy::Upstream {
                        url: url.clone(),
                        user_agent: ua.clone(),
                    },
                );
                if let Some(proxy) = stream_proxy::proxy_url(&video_id) {
                    return Ok(Some(proxy));
                }
            }
        }
    }

    let app2 = app.clone();
    let vid = video_id.clone();
    let cookies = cookie_file_for(&app);
    let cookie_clone = cookies.clone();
    let cache_dir = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|p| p.join("yt-dlp-cache"));
    if let Some(dir) = cache_dir.as_ref() {
        let _ = std::fs::create_dir_all(dir);
    }
    let cache_clone = cache_dir.clone();
    if let Ok(mut g) = LAST_FAILURE.lock() {
        *g = None;
    }
    // a yt-dlp that cannot be downloaded (GitHub blocked on this network) must not stop
    // the innertube fallback below
    // yt-dlp and the innertube player run side by side and the first usable url wins.
    // innertube is a couple of plain https requests (often well under a second), yt-dlp
    // is sturdier but has to start a process; racing them takes the faster one per
    // network instead of always paying for yt-dlp first and innertube after it failed
    let mut ytdlp_task = tokio::task::spawn_blocking(move || {
        let res = {
            let r = ytdlp::ensure_ytdlp(&app2);
            r
        };
        match res {
            Ok(bin) => {
                fetch_stream_url_any(&bin, &vid, cookie_clone.as_deref(), cache_clone.as_deref())
            }
            Err(e) => {
                eprintln!("[Zenith] yt-dlp unavailable: {e}");
                note_failure("component");
                Ok(None)
            }
        }
    });
    let innertube = player::fetch_direct_audio(&video_id);
    tokio::pin!(innertube);
    let (mut yt_done, mut it_done) = (false, false);
    while !(yt_done && it_done) {
        tokio::select! {
            r = &mut ytdlp_task, if !yt_done => {
                yt_done = true;
                if let Ok(Ok(Some(direct_url))) = r {
                    let proxy = remember_and_proxy(&video_id, &direct_url, &ua_for(&video_id), now)?;
                    return Ok(Some(proxy));
                }
            }
            r = &mut innertube, if !it_done => {
                it_done = true;
                if let Some(got) = r {
                    let proxy = remember_and_proxy(&video_id, &got.url, &got.user_agent, now)?;
                    return Ok(Some(proxy));
                }
            }
        }
    }

    // innertube bot-checked (or gave nothing usable): one broader yt-dlp pass
    let app3 = app.clone();
    let vid = video_id.clone();
    let cookie_clone = cookies.clone();
    let cache_clone = cache_dir.clone();
    let last = tokio::task::spawn_blocking(move || match ytdlp::ensure_ytdlp(&app3) {
        Ok(bin) => fetch_stream_url_last_resort(
            &bin,
            &vid,
            cookie_clone.as_deref(),
            cache_clone.as_deref(),
        ),
        Err(_) => Ok(None),
    })
    .await
    .map_err(|e| format!("stream task failed: {}", e))?
    .unwrap_or(None);
    if let Some(url) = last {
        eprintln!("[Zenith] yt-dlp last resort ok for {}", video_id);
        let proxy = remember_and_proxy(&video_id, &url, &ua_for(&video_id), now)?;
        return Ok(Some(proxy));
    }

    // everything failed: most often an outdated yt-dlp after a youtube change. refresh it
    // in the background (rate limited) so the next attempt uses the new extractor
    maybe_refresh_ytdlp_in_background(&app);
    Ok(None)
}

static LAST_BG_REFRESH: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

fn maybe_refresh_ytdlp_in_background(app: &AppHandle) {
    {
        let Ok(mut last) = LAST_BG_REFRESH.lock() else {
            return;
        };
        if last
            .map(|t| t.elapsed() < Duration::from_secs(3 * 3600))
            .unwrap_or(false)
        {
            return;
        }
        *last = Some(std::time::Instant::now());
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || match ytdlp::refresh_ytdlp(&app) {
        Ok(r) if r.updated => eprintln!(
            "[Zenith] yt-dlp updated to {} after failed resolves",
            r.version
        ),
        Ok(_) => {}
        Err(e) => eprintln!("[Zenith] yt-dlp background refresh failed: {e}"),
    });
}

#[command]
pub fn clear_stream_cache() {
    if let Ok(mut cache) = get_cache().lock() {
        for key in cache.keys().cloned().collect::<Vec<_>>() {
            stream_proxy::remove_direct_url(&key);
        }
        cache.clear();
    }
    stream_proxy::clear_all_direct_urls();
}

#[command]
pub async fn search_ytdlp(
    app: AppHandle,
    query: String,
    limit: u32,
) -> Result<Vec<YtdlpTrack>, String> {
    let limit = limit.min(30);
    let app2 = app.clone();
    tokio::task::spawn_blocking(move || {
        let ytdlp = ytdlp::ensure_ytdlp(&app2)?;
        let search = format!("ytsearch{}:{}", limit, query);
        let mut cmd = Command::new(&ytdlp);
        cmd.args([
            "-j",
            "--extractor-args",
            "youtube:player_client=android_vr,web_embedded,tv,ios",
            "--flat-playlist",
            "--no-warnings",
            "--quiet",
            &search,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let output = run_with_timeout(cmd, Duration::from_secs(45))?;
        if !output.status.success() {
            return Ok(vec![]);
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut items = Vec::new();
        for line in stdout.lines() {
            let v: Value = match serde_json::from_str(line) {
                Ok(val) => val,
                Err(_) => continue,
            };
            let id = match v.get("id").and_then(|x| x.as_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let title = v
                .get("title")
                .and_then(|x| x.as_str())
                .unwrap_or("Unknown")
                .to_string();
            let artist = v
                .get("uploader")
                .and_then(|x| x.as_str())
                .or_else(|| v.get("channel").and_then(|x| x.as_str()))
                .unwrap_or("Unknown")
                .to_string();
            let cover = format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", id);
            let cover_small = format!("https://i.ytimg.com/vi/{}/mqdefault.jpg", id);
            let cover_large = format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", id);
            items.push(YtdlpTrack {
                id,
                title,
                artist,
                cover,
                cover_small,
                cover_large,
            });
        }
        Ok(items)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// last resort when every client refused a track: look for another upload of the same
/// song (official audio / "- Topic" channel) with a matching length and play that under
/// the original id, so queue, lyrics and metadata stay as they are
#[command]
pub async fn resolve_alternate_stream(
    app: AppHandle,
    video_id: String,
    query: String,
    title: Option<String>,
    duration: Option<f64>,
) -> Result<Option<String>, String> {
    validate_video_id(&video_id)?;
    let _ = APP.set(app.clone());
    let q: String = query
        .chars()
        .filter(|c| !c.is_control())
        .take(160)
        .collect();
    if q.trim().is_empty() {
        return Ok(None);
    }
    let app2 = app.clone();
    let search = format!("ytsearch6:{} audio", q.trim());
    let found: Vec<(String, Option<f64>, String, String)> =
        tokio::task::spawn_blocking(move || {
            let bin = ytdlp::ensure_ytdlp(&app2)?;
            let mut cmd = Command::new(&bin);
            cmd.args([
                "-j",
                "--flat-playlist",
                "--no-warnings",
                "--quiet",
                "--ignore-config",
                &search,
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
            }
            let out = run_with_timeout(cmd, Duration::from_secs(30))?;
            let stdout = String::from_utf8_lossy(&out.stdout);
            Ok::<_, String>(
                stdout
                    .lines()
                    .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                    .filter_map(|v| {
                        let id = v.get("id")?.as_str()?.to_string();
                        let dur = v.get("duration").and_then(|d| d.as_f64());
                        let ch = v
                            .get("channel")
                            .or_else(|| v.get("uploader"))
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string();
                        let t = v
                            .get("title")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string();
                        Some((id, dur, ch, t))
                    })
                    .collect(),
            )
        })
        .await
        .map_err(|e| e.to_string())??;
    // same song only: the candidate title has to contain the track title
    let want = title.as_deref().map(norm_title).filter(|t| !t.is_empty());
    let found: Vec<(String, Option<f64>, String)> = found
        .into_iter()
        .filter(|(_, _, _, t)| {
            want.as_ref()
                .is_none_or(|w| norm_title(t).contains(w.as_str()))
        })
        .map(|(id, d, ch, _)| (id, d, ch))
        .collect();
    let picks = pick_alternates(&video_id, duration, found);
    for alt in picks.into_iter().take(2) {
        if let Ok(Some(_)) = get_stream_url(app.clone(), alt.clone(), None).await {
            if let Some(up) = stream_proxy::current_upstream(&alt) {
                stream_proxy::store_upstream(&video_id, up);
                eprintln!("[Zenith] playing alternate upload {} for {}", alt, video_id);
                return Ok(stream_proxy::proxy_url(&video_id));
            }
        }
    }
    Ok(None)
}

fn norm_title(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// candidates other than the failed id; with a known length only uploads within 7 s of
/// it, "- Topic" (auto-generated official audio) channels first
fn pick_alternates(
    video_id: &str,
    duration: Option<f64>,
    found: Vec<(String, Option<f64>, String)>,
) -> Vec<String> {
    let mut c: Vec<(u8, f64, String)> = found
        .into_iter()
        .filter(|(id, _, _)| id != video_id && validate_video_id(id).is_ok())
        .filter_map(|(id, dur, ch)| {
            let diff = match (duration.filter(|d| *d > 0.0), dur) {
                (Some(want), Some(got)) => (want - got).abs(),
                (Some(_), None) => return None,
                (None, _) => 0.0,
            };
            if diff > 7.0 {
                return None;
            }
            let topic = if ch.ends_with(" - Topic") { 0 } else { 1 };
            Some((topic, diff, id))
        })
        .collect();
    c.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
    });
    c.into_iter().map(|x| x.2).collect()
}

#[cfg(test)]
mod tests {
    use super::pick_stream_url;
    #[cfg(unix)]
    use super::{run_with_timeout, write_netscape_cookies};
    #[cfg(unix)]
    use std::process::{Command, Stdio};
    #[cfg(unix)]
    use std::time::Duration;

    #[cfg(unix)]
    #[test]
    fn timeout_kills_hung_process() {
        let mut cmd = Command::new("sleep");
        cmd.arg("5").stdout(Stdio::piped()).stderr(Stdio::piped());
        let started = std::time::Instant::now();
        assert!(run_with_timeout(cmd, Duration::from_millis(300)).is_err());
        assert!(started.elapsed() < Duration::from_secs(3));

        let mut ok = Command::new("echo");
        ok.arg("https://x/a")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let out = run_with_timeout(ok, Duration::from_secs(5)).unwrap();
        assert_eq!(
            pick_stream_url(&String::from_utf8_lossy(&out.stdout)).as_deref(),
            Some("https://x/a")
        );
    }

    #[cfg(unix)]
    #[test]
    fn cookie_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("zenith-ck-{}", std::process::id()));
        let path = dir.join("youtube-cookies.txt");
        write_netscape_cookies("SAPISID=abc; NID=1", &path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("\tSAPISID\tabc"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn alternates_match_length_and_prefer_topic() {
        let found = vec![
            (
                "aaaaaaaaaaa".to_string(),
                Some(200.0),
                "Some Channel".to_string(),
            ),
            (
                "bbbbbbbbbbb".to_string(),
                Some(203.0),
                "Artist - Topic".to_string(),
            ),
            (
                "ccccccccccc".to_string(),
                Some(260.0),
                "Artist - Topic".to_string(),
            ),
            (
                "orig0000000".to_string(),
                Some(200.0),
                "Artist - Topic".to_string(),
            ),
        ];
        let p = super::pick_alternates("orig0000000", Some(200.0), found);
        assert_eq!(
            p,
            vec!["bbbbbbbbbbb".to_string(), "aaaaaaaaaaa".to_string()]
        );
    }

    #[test]
    fn user_agent_from_headers_line() {
        let out = "https://rr1.googlevideo.com/videoplayback?x=1\n{\"User-Agent\": \"com.google.android.apps.youtube.vr.oculus/1.6\", \"Accept\": \"*/*\"}\n";
        assert_eq!(
            super::pick_user_agent(out).as_deref(),
            Some("com.google.android.apps.youtube.vr.oculus/1.6")
        );
        assert_eq!(
            super::pick_stream_url(out).as_deref(),
            Some("https://rr1.googlevideo.com/videoplayback?x=1")
        );
    }

    #[test]
    fn expiry_drives_cache() {
        let u = "https://rr1---sn-x.googlevideo.com/videoplayback?expire=20000&ei=a&itag=251";
        assert_eq!(super::url_expiry(u), Some(20000));
        assert!(super::cache_fresh(u, 10000, 10500));
        assert!(!super::cache_fresh(u, 10000, 19500));
        assert!(!super::cache_fresh(
            "https://x.googlevideo.com/v?itag=1",
            0,
            300
        ));
        assert!(super::cache_fresh(
            "https://x.googlevideo.com/v?itag=1",
            0,
            100
        ));
    }

    #[test]
    fn network_fallback_order() {
        let cert = "ERROR: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed";
        let f = super::network_fallbacks(cert, true);
        assert_eq!(f[0].0, "direct");
        assert!(f.iter().any(|x| x.1.contains(&"--no-check-certificates")));
        let f = super::network_fallbacks("ERROR: timed out", false);
        assert_eq!(f[0].0, "ipv4");
        assert_eq!(
            super::classify_failure("ERROR: Unable to extract initial data"),
            "network"
        );
    }

    #[test]
    fn classifies_failures() {
        assert_eq!(super::classify_failure("ERROR: [youtube] x: Unable to download API page: <urlopen error [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed"), "network");
        assert_eq!(
            super::classify_failure("ERROR: Unable to connect to proxy"),
            "network"
        );
        assert_eq!(
            super::classify_failure("ERROR: [youtube] x: Sign in to confirm you’re not a bot"),
            "bot"
        );
        assert_eq!(
            super::classify_failure("ERROR: [youtube] x: Video unavailable"),
            "unavailable"
        );
    }

    #[test]
    fn picks_first_http_line() {
        let raw = "https://example.com/audio.m4a\nhttps://example.com/other";
        assert_eq!(
            pick_stream_url(raw),
            Some("https://example.com/audio.m4a".to_string())
        );
    }
}

#[cfg(test)]
mod client_tests {
    use super::extractor_args_for;

    #[test]
    fn cookies_never_use_tv_downgraded() {
        let with = extractor_args_for(true);
        assert!(with.contains("-tv_downgraded"));
        assert!(!with.contains("android_vr"));
        let without = extractor_args_for(false);
        assert!(without.contains("android_vr"));
    }
}
