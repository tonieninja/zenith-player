//! catches the Spotify OAuth redirect on 127.0.0.1 so the PKCE flow needs no client secret
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

const PAGE_OK: &str = "<!doctype html><meta charset=utf-8><title>Zenith</title><body style=\"font-family:sans-serif;background:#111;color:#eee;text-align:center;padding-top:20vh\"><h2>Spotify is connected</h2><p>You can close this tab and go back to Zenith.</p>";
const PAGE_ERR: &str = "<!doctype html><meta charset=utf-8><title>Zenith</title><body style=\"font-family:sans-serif;background:#111;color:#eee;text-align:center;padding-top:20vh\"><h2>Spotify did not connect</h2><p>Go back to Zenith and try again.</p>";

/// pulls code/state/error out of "GET /callback?code=..&state=.. HTTP/1.1"
pub fn parse_callback(request_line: &str) -> Option<Vec<(String, String)>> {
    let target = request_line.split_whitespace().nth(1)?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/callback" {
        return None;
    }
    Some(
        url::form_urlencoded::parse(query.as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect(),
    )
}

fn wait(port: u16, state: String, timeout: Duration) -> Result<String, String> {
    let listener =
        TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("port {port} is busy: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let start = Instant::now();
    loop {
        if start.elapsed() > timeout {
            return Err("timed out waiting for Spotify".into());
        }
        let Ok((mut stream, _)) = listener.accept() else {
            std::thread::sleep(Duration::from_millis(150));
            continue;
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]);
        let Some(params) = parse_callback(req.lines().next().unwrap_or("")) else {
            let _ = stream.write_all(
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            continue;
        };
        let get = |k: &str| params.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone());
        let ok = get("state").as_deref() == Some(state.as_str()) && get("code").is_some();
        let body = if ok { PAGE_OK } else { PAGE_ERR };
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        if ok {
            return Ok(get("code").unwrap_or_default());
        }
        return Err(get("error").unwrap_or_else(|| "state mismatch".into()));
    }
}

#[tauri::command]
pub async fn spotify_wait_for_code(
    port: u16,
    state: String,
    timeout_secs: u64,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        wait(port, state, Duration::from_secs(timeout_secs.min(900)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_code_and_state() {
        let p = parse_callback("GET /callback?code=abc%2B1&state=xyz HTTP/1.1").unwrap();
        assert!(p.contains(&("code".into(), "abc+1".into())));
        assert!(p.contains(&("state".into(), "xyz".into())));
        assert!(parse_callback("GET /favicon.ico HTTP/1.1").is_none());
    }

    #[test]
    fn full_redirect_roundtrip() {
        let port = 18766;
        let h = std::thread::spawn(move || wait(port, "s1".into(), Duration::from_secs(5)));
        std::thread::sleep(Duration::from_millis(300));
        let mut c = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.write_all(b"GET /callback?code=C0DE&state=s1 HTTP/1.1\r\nHost: x\r\n\r\n")
            .unwrap();
        let mut out = String::new();
        let _ = c.read_to_string(&mut out);
        assert!(out.contains("Spotify is connected"));
        assert_eq!(h.join().unwrap().unwrap(), "C0DE");
    }
}
