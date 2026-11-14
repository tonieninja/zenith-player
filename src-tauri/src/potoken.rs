use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

pub const LABEL: &str = "zenith-pot";
const REPLY_HOST: &str = "zenith-pot.invalid";
const START_URL: &str = "https://www.youtube.com/?themeRefresh=1";
const TOKEN_TTL: Duration = Duration::from_secs(2 * 3600);
const IDLE_CLOSE_SECS: u64 = 45;
const CLOSE_AFTER_MINT: Duration = Duration::from_secs(3);
const BROKEN_COOLDOWN: Duration = Duration::from_secs(15 * 60);
const WANT_STICKY_SECS: u64 = 3 * 24 * 3600;

static APP: OnceLock<AppHandle> = OnceLock::new();
static WANTED: AtomicBool = AtomicBool::new(false);
static LOADED: AtomicBool = AtomicBool::new(false);
static OPENING: AtomicBool = AtomicBool::new(false);
static FAILS: AtomicU8 = AtomicU8::new(0);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static LAST_USE: AtomicU64 = AtomicU64::new(0);
static BROKEN_AT: Mutex<Option<Instant>> = Mutex::new(None);
static REAPER: std::sync::Once = std::sync::Once::new();
static MINT_GEN: AtomicU64 = AtomicU64::new(0);

type Pending = Mutex<HashMap<u64, oneshot::Sender<Option<String>>>>;

fn pending() -> &'static Pending {
    static P: OnceLock<Pending> = OnceLock::new();
    P.get_or_init(Default::default)
}

fn cache() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    static C: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

const INIT_JS: &str = r#"(() => {
  if (window.top !== window || window.__zpMint) return;
  document.addEventListener('play', (e) => {
    const m = e.target;
    if (m && typeof m.pause === 'function') { m.muted = true; m.pause(); }
  }, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const find = () => {
    const known = window['havuokmhhs-0'];
    if (known && known.bevasrs && typeof known.bevasrs.wpc === 'function') return known.bevasrs.wpc;
    for (const k of Object.getOwnPropertyNames(window)) {
      let v;
      try { v = window[k]; } catch (e) { continue; }
      if (!v || typeof v !== 'object') continue;
      let keys;
      try { keys = Object.keys(v); } catch (e) { continue; }
      for (const k2 of keys) {
        let w;
        try { w = v[k2]; } catch (e) { continue; }
        if (w && typeof w === 'object' && typeof w.wpc === 'function') return w.wpc;
      }
    }
    return null;
  };
  let chain = Promise.resolve();
  const reply = (id, tok, err) => {
    const q = tok ? '&t=' + encodeURIComponent(tok) : '&e=' + encodeURIComponent(String(err).slice(0, 160));
    chain = chain.then(async () => {
      location.href = 'https://zenith-pot.invalid/r?i=' + id + q;
      await sleep(60);
    });
  };
  window.__zpMint = async (id, c) => {
    try {
      let wpc = null;
      for (let i = 0; i < 24 && !wpc; i++) {
        wpc = find();
        if (!wpc) await sleep(500);
      }
      if (!wpc) throw new Error('webpo client missing');
      for (let i = 0; i < 14; i++) {
        try {
          const client = await wpc();
          const t = await client.mws({c, mc: false, me: false});
          if (typeof t === 'string' && t.length > 20) return reply(id, t);
        } catch (e) {
          if (!String(e).includes('SDF:notready')) throw e;
        }
        await sleep(600);
      }
      throw new Error('webpo client not ready');
    } catch (e) {
      reply(id, null, e);
    }
  };
})();"#;

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    if let Ok(dir) = app.path().app_local_data_dir() {
        std::thread::spawn(move || {
            let _ = std::fs::remove_dir_all(dir.join("webview-pot"));
        });
    }
    if want_file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|at| now_secs().saturating_sub(at) < WANT_STICKY_SECS)
        .unwrap_or(false)
    {
        WANTED.store(true, Ordering::SeqCst);
    }
}

fn want_file() -> Option<std::path::PathBuf> {
    Some(
        APP.get()?
            .path()
            .app_local_data_dir()
            .ok()?
            .join("pot-wanted.txt"),
    )
}

pub fn want() {
    if !WANTED.swap(true, Ordering::SeqCst) {
        if let Some(p) = want_file() {
            let _ = std::fs::write(p, now_secs().to_string());
        }
    }
    open();
}

pub fn wanted() -> bool {
    WANTED.load(Ordering::SeqCst)
}

fn broken() -> bool {
    BROKEN_AT
        .lock()
        .ok()
        .and_then(|g| *g)
        .map(|t| t.elapsed() < BROKEN_COOLDOWN)
        .unwrap_or(false)
}

pub fn ready() -> bool {
    LOADED.load(Ordering::SeqCst) && !broken()
}

pub async fn wait_ready(limit: Duration) -> bool {
    let until = Instant::now() + limit;
    while Instant::now() < until {
        if ready() {
            return true;
        }
        if broken() {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    ready()
}

fn open() {
    let Some(app) = APP.get().cloned() else {
        return;
    };
    if broken() || app.get_webview_window(LABEL).is_some() || OPENING.swap(true, Ordering::SeqCst) {
        return;
    }
    LAST_USE.store(now_secs(), Ordering::SeqCst);
    start_reaper();
    std::thread::spawn(move || {
        if let Err(e) = build(&app) {
            eprintln!("[Zenith] po token page failed: {e}");
            mark_broken();
        }
        OPENING.store(false, Ordering::SeqCst);
    });
}

fn build(app: &AppHandle) -> Result<(), String> {
    let url: tauri::Url = START_URL.parse().map_err(|e| format!("{e}"))?;
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("Zenith")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .decorations(false)
        .inner_size(960.0, 640.0)
        .user_agent(crate::login_nav::user_agent())
        .initialization_script(INIT_JS)
        .on_navigation(|u| {
            if u.host_str() == Some(REPLY_HOST) {
                deliver(u);
                return false;
            }
            allowed_host(u.host_str().unwrap_or("")) || u.scheme() == "about"
        })
        .on_page_load(|_w, p| {
            if p.event() == PageLoadEvent::Finished
                && p.url().host_str().map(allowed_host).unwrap_or(false)
            {
                LOADED.store(true, Ordering::SeqCst);
            }
        })
        .additional_browser_args(&crate::windows::merged_webview_args())
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn allowed_host(h: &str) -> bool {
    let h = h.to_ascii_lowercase();
    [
        "youtube.com",
        "google.com",
        "gstatic.com",
        "googleapis.com",
        "ytimg.com",
        "googlevideo.com",
        "doubleclick.net",
    ]
    .iter()
    .any(|d| h == *d || h.ends_with(&format!(".{d}")))
}

pub fn parse_reply(u: &tauri::Url) -> Option<(u64, Option<String>)> {
    if u.host_str() != Some(REPLY_HOST) {
        return None;
    }
    let mut id = None;
    let mut tok = None;
    for (k, v) in u.query_pairs() {
        match k.as_ref() {
            "i" => id = v.parse::<u64>().ok(),
            "t" if valid_token(&v) => tok = Some(v.to_string()),
            _ => {}
        }
    }
    Some((id?, tok))
}

pub fn valid_token(t: &str) -> bool {
    (20..=4096).contains(&t.len())
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'=' | b'+' | b'/'))
}

fn deliver(u: &tauri::Url) {
    let Some((id, tok)) = parse_reply(u) else {
        return;
    };
    if tok.is_none() {
        let err: String = u
            .query_pairs()
            .find(|(k, _)| k == "e")
            .map(|(_, v)| v.chars().take(160).collect())
            .unwrap_or_default();
        eprintln!("[Zenith] po token mint failed: {err}");
    }
    if let Some(tx) = pending().lock().ok().and_then(|mut g| g.remove(&id)) {
        let _ = tx.send(tok);
    }
}

fn mark_broken() {
    if let Ok(mut g) = BROKEN_AT.lock() {
        *g = Some(Instant::now());
    }
    close();
}

fn close() {
    LOADED.store(false, Ordering::SeqCst);
    let Some(app) = APP.get().cloned() else {
        return;
    };
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app2.get_webview_window(LABEL) {
            let _ = w.destroy();
        }
    });
}

fn close_soon() {
    let gen = MINT_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CLOSE_AFTER_MINT).await;
        let idle = pending().lock().map(|g| g.is_empty()).unwrap_or(true);
        if idle && MINT_GEN.load(Ordering::SeqCst) == gen {
            close();
        }
    });
}

fn start_reaper() {
    REAPER.call_once(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_secs(15));
            if crate::windows::is_shutting_down() {
                return;
            }
            let idle = now_secs().saturating_sub(LAST_USE.load(Ordering::SeqCst));
            let open = APP
                .get()
                .map(|a| a.get_webview_window(LABEL).is_some())
                .unwrap_or(false);
            if open && idle > IDLE_CLOSE_SECS {
                close();
            }
        });
    });
}

fn cached(binding: &str) -> Option<String> {
    let mut g = cache().lock().ok()?;
    g.retain(|_, (_, at)| at.elapsed() < TOKEN_TTL);
    g.get(binding).map(|(t, _)| t.clone())
}

pub async fn mint(binding: &str) -> Option<String> {
    if binding.is_empty() || binding.len() > 2048 {
        return None;
    }
    if let Some(t) = cached(binding) {
        return Some(t);
    }
    LAST_USE.store(now_secs(), Ordering::SeqCst);
    if !ready() {
        if !wanted() {
            return None;
        }
        open();
        if !wait_ready(Duration::from_secs(20)).await {
            return None;
        }
    }
    let app = APP.get()?.clone();
    let win = app.get_webview_window(LABEL)?;
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    pending().lock().ok()?.insert(id, tx);
    let js = format!(
        "window.__zpMint && window.__zpMint({id}, {})",
        serde_json::to_string(binding).ok()?
    );
    if win.eval(&js).is_err() {
        pending().lock().ok()?.remove(&id);
        return None;
    }
    let got = tokio::time::timeout(Duration::from_secs(20), rx)
        .await
        .ok()
        .and_then(|r| r.ok())
        .flatten();
    if let Ok(mut g) = pending().lock() {
        g.remove(&id);
    }
    close_soon();
    match got {
        Some(t) => {
            FAILS.store(0, Ordering::SeqCst);
            if let Ok(mut g) = cache().lock() {
                if g.len() > 256 {
                    g.clear();
                }
                g.insert(binding.to_string(), (t.clone(), Instant::now()));
            }
            Some(t)
        }
        None => {
            if FAILS.fetch_add(1, Ordering::SeqCst) + 1 >= 3 {
                FAILS.store(0, Ordering::SeqCst);
                eprintln!("[Zenith] po token page gave up, resting for a while");
                mark_broken();
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_url_parses() {
        let tok = "MnQwPw-abc_DEF=".repeat(3);
        let u: tauri::Url = format!("https://zenith-pot.invalid/r?i=7&t={tok}")
            .parse()
            .unwrap();
        assert_eq!(parse_reply(&u), Some((7, Some(tok))));
        let e: tauri::Url = "https://zenith-pot.invalid/r?i=8&e=boom".parse().unwrap();
        assert_eq!(parse_reply(&e), Some((8, None)));
        let other: tauri::Url = "https://www.youtube.com/r?i=8&t=x".parse().unwrap();
        assert_eq!(parse_reply(&other), None);
    }

    #[test]
    fn junk_tokens_are_refused() {
        assert!(!valid_token("short"));
        assert!(!valid_token(&"a<b".repeat(20)));
        assert!(valid_token(&"Mn0_-=".repeat(10)));
    }

    #[test]
    fn page_stays_on_google_hosts() {
        assert!(allowed_host("www.youtube.com"));
        assert!(allowed_host("accounts.google.com"));
        assert!(allowed_host("i.ytimg.com"));
        assert!(!allowed_host("evil-youtube.com"));
        assert!(!allowed_host("example.org"));
    }

    #[test]
    fn init_script_has_no_empty_catch() {
        assert!(!INIT_JS.contains("catch (e) {}"));
        assert!(INIT_JS.contains("zenith-pot.invalid"));
    }
}
