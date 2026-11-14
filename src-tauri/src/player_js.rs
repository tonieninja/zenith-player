use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ID_TTL: Duration = Duration::from_secs(3600);

static CURRENT: Mutex<Option<(String, Instant)>> = Mutex::new(None);
static DIR: OnceLock<PathBuf> = OnceLock::new();
static FETCH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static LAST_JS: Mutex<Option<(String, String, Instant)>> = Mutex::new(None);

fn take_recent(id: &str) -> Option<String> {
    let mut g = LAST_JS.lock().ok()?;
    match g.take() {
        Some((i, js, at)) if i == id && at.elapsed() < Duration::from_secs(120) => Some(js),
        _ => None,
    }
}

pub fn init(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    crate::jsc::set_cache_dir(dir.clone());
    let _ = DIR.set(dir);
}

#[derive(Clone, Debug)]
pub struct Player {
    pub id: String,
    pub sts: Option<u64>,
}

fn http() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(CHROME_UA)
        .build()
        .ok()
}

pub fn parse_player_id(iframe_api: &str) -> Option<String> {
    let mut rest = iframe_api;
    while let Some(i) = rest.find("player") {
        rest = &rest[i + 6..];
        let r = rest.trim_start_matches('\\').trim_start_matches('/');
        let r = r.trim_start_matches('\\');
        let id: String = r.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
        if id.len() == 8 && r[id.len()..].trim_start_matches('\\').starts_with('/') {
            return Some(id);
        }
    }
    None
}

pub fn parse_sts(js: &str) -> Option<u64> {
    for key in ["signatureTimestamp", "sts"] {
        let mut rest = js;
        while let Some(i) = rest.find(key) {
            rest = &rest[i + key.len()..];
            let r = rest.trim_start();
            let Some(r) = r.strip_prefix(':') else {
                continue;
            };
            let digits: String = r
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if digits.len() == 5 {
                return digits.parse().ok();
            }
        }
    }
    None
}

pub fn player_url(id: &str) -> String {
    format!("https://www.youtube.com/s/player/{id}/player_ias.vflset/en_US/base.js")
}

fn sts_file(id: &str) -> Option<PathBuf> {
    DIR.get().map(|d| d.join(format!("sts-{id}.txt")))
}

pub fn forget() {
    if let Ok(mut g) = CURRENT.lock() {
        *g = None;
    }
}

async fn current_id() -> Option<String> {
    if let Ok(g) = CURRENT.lock() {
        if let Some((id, at)) = g.as_ref() {
            if at.elapsed() < ID_TTL {
                return Some(id.clone());
            }
        }
    }
    let body = http()?
        .get("https://www.youtube.com/iframe_api")
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    let id = parse_player_id(&body)?;
    if let Ok(mut g) = CURRENT.lock() {
        *g = Some((id.clone(), Instant::now()));
    }
    Some(id)
}

pub async fn download(id: &str, keep: bool) -> Option<String> {
    let res = http()?.get(player_url(id)).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let js = res.text().await.ok()?;
    if js.len() < 100_000 {
        return None;
    }
    if let (Some(sts), Some(p)) = (parse_sts(&js), sts_file(id)) {
        let _ = std::fs::write(p, sts.to_string());
    }
    if keep && !crate::jsc::has_preprocessed(id) {
        if let Ok(mut g) = LAST_JS.lock() {
            *g = Some((id.to_string(), js.clone(), Instant::now()));
        }
    }
    Some(js)
}

pub async fn version() -> Option<String> {
    current_id().await
}

pub async fn current() -> Option<Player> {
    let id = current_id().await?;
    let saved = sts_file(&id)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| s.trim().parse::<u64>().ok());
    if saved.is_some() {
        return Some(Player { id, sts: saved });
    }
    let _one = FETCH.lock().await;
    let sts = download(&id, true).await.and_then(|js| parse_sts(&js));
    Some(Player { id, sts })
}

pub async fn solve(
    id: &str,
    n: Vec<String>,
    sig: Vec<String>,
) -> Result<crate::jsc::Solved, String> {
    if n.is_empty() && sig.is_empty() {
        return Ok(Default::default());
    }
    let first = crate::jsc::solve_async(id.to_string(), None, n.clone(), sig.clone()).await;
    match first {
        Err(e) if e.contains("need player") => {
            let _one = FETCH.lock().await;
            let js = match take_recent(id) {
                Some(js) => js,
                None => download(id, false).await.ok_or("player download failed")?,
            };
            if let Ok(mut g) = LAST_JS.lock() {
                *g = None;
            }
            crate::jsc::solve_async(id.to_string(), Some(js), n, sig).await
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_player_id_in_iframe_api() {
        let body = r#"var scriptUrl = 'https:\/\/www.youtube.com\/s\/player\/fad7e4e9\/www-widgetapi.vflset\/www-widgetapi.js';"#;
        assert_eq!(parse_player_id(body).as_deref(), Some("fad7e4e9"));
        assert_eq!(
            parse_player_id("/s/player/0123abcd/player_ias.vflset").as_deref(),
            Some("0123abcd")
        );
        assert_eq!(parse_player_id("player/xyz/"), None);
    }

    #[test]
    fn reads_signature_timestamp() {
        assert_eq!(parse_sts("a={signatureTimestamp:20767,b:1}"), Some(20767));
        assert_eq!(parse_sts("x.sts : 19999 ;"), Some(19999));
        assert_eq!(parse_sts("signatureTimestamp:123"), None);
    }

    #[test]
    fn base_js_url_shape() {
        assert_eq!(
            player_url("fad7e4e9"),
            "https://www.youtube.com/s/player/fad7e4e9/player_ias.vflset/en_US/base.js"
        );
    }
}
