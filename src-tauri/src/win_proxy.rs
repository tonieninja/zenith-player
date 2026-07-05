#[cfg(windows)]
pub fn init() {
    if has_env("HTTPS_PROXY") || has_env("HTTP_PROXY") || has_env("ALL_PROXY") {
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(unsafe { resolve("https://music.youtube.com/") });
    });
    let proxy = match rx.recv_timeout(std::time::Duration::from_millis(4000)) {
        Ok(p) => p,
        Err(_) => {
            eprintln!("[zenith] proxy autodetect timed out, using direct/registry settings");
            None
        }
    };
    if let Some(p) = proxy {
        let url = if p.contains("://") {
            p
        } else {
            format!("http://{p}")
        };
        eprintln!("[zenith] using windows proxy for rust http: {url}");
        std::env::set_var("HTTPS_PROXY", &url);
        std::env::set_var("HTTP_PROXY", &url);
        if !has_env("NO_PROXY") {
            std::env::set_var("NO_PROXY", "localhost,127.0.0.1,::1");
        }
    }
}

#[cfg(not(windows))]
pub fn init() {}

#[cfg(windows)]
fn has_env(k: &str) -> bool {
    std::env::var(k)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
        || std::env::var(k.to_ascii_lowercase())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn pick_proxy(list: &str) -> Option<String> {
    let mut fallback = None;
    for raw in list.split([';', ' ', '\t', '\n', '\r']) {
        let e = raw.trim();
        if e.is_empty() {
            continue;
        }
        if let Some((scheme, rest)) = e.split_once('=') {
            let scheme = scheme.trim().to_ascii_lowercase();
            if scheme == "https" && !rest.trim().is_empty() {
                return Some(rest.trim().to_string());
            }
            if scheme == "http" && fallback.is_none() && !rest.trim().is_empty() {
                fallback = Some(rest.trim().to_string());
            }
            continue;
        }
        let up = e.to_ascii_uppercase();
        if up == "DIRECT" || up == "PROXY" {
            continue;
        }
        if fallback.is_none() {
            fallback = Some(e.to_string());
        }
    }
    fallback
}

#[cfg(windows)]
unsafe fn take_wstr(p: windows_sys::core::PWSTR) -> Option<String> {
    use windows_sys::Win32::Foundation::GlobalFree;
    if p.is_null() {
        return None;
    }
    let mut len = 0usize;
    while *p.add(len) != 0 {
        len += 1;
    }
    let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
    GlobalFree(p as _);
    Some(s)
}

#[cfg(windows)]
unsafe fn resolve(target: &str) -> Option<String> {
    use windows_sys::Win32::Networking::WinHttp::*;

    let mut ie: WINHTTP_CURRENT_USER_IE_PROXY_CONFIG = std::mem::zeroed();
    let have_ie = WinHttpGetIEProxyConfigForCurrentUser(&mut ie) != 0;
    let (auto_detect, pac_url, static_proxy) = if have_ie {
        let pac = take_wstr(ie.lpszAutoConfigUrl);
        let px = take_wstr(ie.lpszProxy);
        let _ = take_wstr(ie.lpszProxyBypass);
        (ie.fAutoDetect != 0, pac, px)
    } else {
        (true, None, None)
    };

    if auto_detect || pac_url.is_some() {
        let agent: Vec<u16> = "Zenith\0".encode_utf16().collect();
        let session = WinHttpOpen(
            agent.as_ptr(),
            WINHTTP_ACCESS_TYPE_NO_PROXY,
            std::ptr::null(),
            std::ptr::null(),
            0,
        );
        if !session.is_null() {
            WinHttpSetTimeouts(session, 3000, 3000, 3000, 3000);
            let url_w: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
            let pac_w: Option<Vec<u16>> = pac_url
                .as_ref()
                .map(|u| u.encode_utf16().chain(Some(0)).collect());
            let mut attempts: Vec<WINHTTP_AUTOPROXY_OPTIONS> = Vec::new();
            if let Some(pw) = pac_w.as_ref() {
                let mut o: WINHTTP_AUTOPROXY_OPTIONS = std::mem::zeroed();
                o.dwFlags = WINHTTP_AUTOPROXY_CONFIG_URL;
                o.lpszAutoConfigUrl = pw.as_ptr();
                o.fAutoLogonIfChallenged = 1;
                attempts.push(o);
            }
            if auto_detect {
                let mut o: WINHTTP_AUTOPROXY_OPTIONS = std::mem::zeroed();
                o.dwFlags = WINHTTP_AUTOPROXY_AUTO_DETECT;
                o.dwAutoDetectFlags =
                    WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A;
                o.fAutoLogonIfChallenged = 1;
                attempts.push(o);
            }
            let mut found = None;
            for mut o in attempts {
                let mut info: WINHTTP_PROXY_INFO = std::mem::zeroed();
                if WinHttpGetProxyForUrl(session, url_w.as_ptr(), &mut o, &mut info) != 0 {
                    let px = take_wstr(info.lpszProxy);
                    let _ = take_wstr(info.lpszProxyBypass);
                    if info.dwAccessType == WINHTTP_ACCESS_TYPE_NAMED_PROXY {
                        found = px.as_deref().and_then(pick_proxy);
                    }
                    break;
                }
            }
            WinHttpCloseHandle(session);
            if found.is_some() {
                return found;
            }
        }
    }
    static_proxy.as_deref().and_then(pick_proxy)
}

#[cfg(test)]
mod tests {
    use super::pick_proxy;
    #[test]
    fn picks() {
        assert_eq!(pick_proxy("proxy:8080").as_deref(), Some("proxy:8080"));
        assert_eq!(
            pick_proxy("http=a:80;https=b:443").as_deref(),
            Some("b:443")
        );
        assert_eq!(pick_proxy("http=a:80;ftp=c:21").as_deref(), Some("a:80"));
        assert_eq!(pick_proxy("a:80; b:81").as_deref(), Some("a:80"));
        assert_eq!(pick_proxy("DIRECT"), None);
        assert_eq!(pick_proxy(""), None);
    }
}
