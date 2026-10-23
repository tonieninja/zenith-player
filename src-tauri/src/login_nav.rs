#[derive(Debug, PartialEq, Eq)]
pub enum NavDecision {
    Allow,
    OpenExternal,
    Block,
}

fn is_google_country_host(h: &str) -> bool {
    let labels: Vec<&str> = h.split('.').collect();
    let Some(pos) = labels.iter().position(|l| *l == "google") else {
        return false;
    };
    let tail = &labels[pos + 1..];
    match tail {
        [cc] => cc.len() == 2 && cc.chars().all(|c| c.is_ascii_alphabetic()),
        [mid, cc] => {
            matches!(*mid, "co" | "com")
                && cc.len() == 2
                && cc.chars().all(|c| c.is_ascii_alphabetic())
        }
        _ => false,
    }
}

pub fn host_allowed(host: &str) -> bool {
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    const ROOTS: &[&str] = &[
        "google.com",
        "youtube.com",
        "youtube-nocookie.com",
        "ytimg.com",
        "gstatic.com",
        "googleusercontent.com",
        "googleapis.com",
        "googlesyndication.com",
        "googletagmanager.com",
        "google-analytics.com",
        "doubleclick.net",
        "recaptcha.net",
        "gvt1.com",
        "gvt2.com",
        "ggpht.com",
        "withgoogle.com",
    ];
    ROOTS
        .iter()
        .any(|r| h == *r || h.ends_with(&format!(".{r}")))
        || is_google_country_host(&h)
}

pub fn decide(url: &url::Url) -> NavDecision {
    match url.scheme() {
        "about" | "data" | "blob" | "javascript" => NavDecision::Allow,
        "http" | "https" => match url.host_str() {
            Some(h) if host_allowed(h) => NavDecision::Allow,
            Some(_) => NavDecision::OpenExternal,
            None => NavDecision::Block,
        },
        "mailto" | "tel" => NavDecision::OpenExternal,
        _ => NavDecision::Block,
    }
}

pub fn is_finish_page(url: &url::Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let Some(h) = url.host_str() else {
        return false;
    };
    let h = h.to_ascii_lowercase();
    matches!(
        h.as_str(),
        "music.youtube.com" | "www.youtube.com" | "youtube.com" | "m.youtube.com"
    )
}

pub fn user_agent() -> &'static str {
    #[cfg(windows)]
    {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"
    }
    #[cfg(not(windows))]
    {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15"
    }
}

pub const LOADING_PAGE: &str = "login-loading.html";

pub fn is_loading_page(url: &url::Url) -> bool {
    url.path().ends_with(LOADING_PAGE)
        && match url.scheme() {
            "tauri" => url.host_str() == Some("localhost"),
            "http" | "https" => {
                matches!(url.host_str(), Some("tauri.localhost") | Some("localhost"))
            }
            _ => false,
        }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> url::Url {
        url::Url::parse(s).unwrap()
    }

    #[test]
    fn google_flow_is_allowed() {
        for s in [
            "https://accounts.google.com/v3/signin/identifier",
            "https://accounts.google.com/v3/signin/challenge/pwd",
            "https://accounts.youtube.com/accounts/CheckConnection",
            "https://www.google.pl/accounts/SetSID",
            "https://accounts.google.co.uk/x",
            "https://www.google.com.br/x",
            "https://ssl.gstatic.com/x.js",
            "https://www.recaptcha.net/recaptcha/api2/anchor",
            "https://consent.youtube.com/m",
            "https://music.youtube.com/",
        ] {
            assert_eq!(decide(&u(s)), NavDecision::Allow, "{s}");
        }
    }

    #[test]
    fn iframe_schemes_do_not_hang() {
        assert_eq!(decide(&u("about:blank")), NavDecision::Allow);
        assert_eq!(decide(&u("about:srcdoc")), NavDecision::Allow);
        assert_eq!(decide(&u("data:text/html,x")), NavDecision::Allow);
        assert_eq!(
            decide(&u("blob:https://accounts.google.com/123")),
            NavDecision::Allow
        );
    }

    #[test]
    fn outside_links_go_to_browser() {
        assert_eq!(
            decide(&u("https://example.com/")),
            NavDecision::OpenExternal
        );
        assert_eq!(
            decide(&u("https://google.evil.com/")),
            NavDecision::OpenExternal
        );
        assert_eq!(
            decide(&u("https://notgoogle.com/")),
            NavDecision::OpenExternal
        );
        assert_eq!(decide(&u("file:///etc/passwd")), NavDecision::Block);
        assert_eq!(decide(&u("tauri://localhost/")), NavDecision::Block);
    }

    #[test]
    fn finish_only_on_top_level_youtube() {
        assert!(is_finish_page(&u("https://music.youtube.com/")));
        assert!(is_finish_page(&u("https://www.youtube.com/")));
        assert!(!is_finish_page(&u(
            "https://accounts.youtube.com/accounts/SetSID"
        )));
        assert!(!is_finish_page(&u("https://consent.youtube.com/m")));
        assert!(!is_finish_page(&u("https://accounts.google.com/")));
        assert!(!is_finish_page(&u("http://music.youtube.com/")));
    }

    #[test]
    fn loading_page_origins() {
        assert!(is_loading_page(&u("tauri://localhost/login-loading.html")));
        assert!(is_loading_page(&u(
            "http://tauri.localhost/login-loading.html"
        )));
        assert!(is_loading_page(&u(
            "http://localhost:1420/login-loading.html"
        )));
        assert!(!is_loading_page(&u("tauri://localhost/index.html")));
        assert!(!is_loading_page(&u("https://evil.com/login-loading.html")));
    }

    #[test]
    fn start_url_matches_loading_page() {
        let html = include_str!("../../public/login-loading.html").replace("&amp;", "&");
        assert!(html.contains(
            "https://accounts.google.com/ServiceLogin?service=youtube&passive=true&continue=https%3A%2F%2Fmusic.youtube.com%2F"
        ));
    }
}
