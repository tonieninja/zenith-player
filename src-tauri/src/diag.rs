use std::collections::VecDeque;
use std::sync::Mutex;

static LOG: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
const MAX_LINES: usize = 300;

// błędy reqwest niosą pełny adres googlevideo z IP i podpisem; do schowka trafia tylko host i ścieżka
fn redact(line: &str) -> String {
    line.split(' ')
        .map(|w| match (w.find("http"), w.find('?')) {
            (Some(h), Some(q)) if q > h => {
                let tail = w[q..].find(')').map_or("", |i| &w[q + i..]);
                format!("{}{}", &w[..q], tail)
            }
            _ => w.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn clock(secs: u64) -> String {
    let s = secs % 86_400;
    format!("{:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
}

pub fn log(line: String) {
    eprintln!("{line}");
    let mut g = LOG.lock().unwrap_or_else(|p| p.into_inner());
    if g.len() >= MAX_LINES {
        g.pop_front();
    }
    g.push_back(format!("{} {}", clock(crate::now_secs()), redact(&line)));
}

#[tauri::command]
pub fn stream_diagnostics() -> String {
    let g = LOG.lock().unwrap_or_else(|p| p.into_inner());
    g.iter().cloned().collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_strings_never_reach_the_log() {
        let raw = "[Zenith] proxy upstream error (abc): error sending request for url (https://rr1.googlevideo.com/videoplayback?ip=1.2.3.4&sig=x)";
        let r = redact(raw);
        assert!(!r.contains("ip=") && !r.contains("sig="), "{r}");
        assert!(
            r.contains("https://rr1.googlevideo.com/videoplayback)"),
            "{r}"
        );
        assert_eq!(
            redact("[Zenith] innertube VISIONOS ok for abc"),
            "[Zenith] innertube VISIONOS ok for abc"
        );
        assert_eq!(clock(3_725), "01:02:05");
    }

    #[test]
    fn keeps_only_the_newest_lines() {
        for i in 0..(MAX_LINES + 5) {
            log(format!("line {i}"));
        }
        let all = stream_diagnostics();
        assert!(all.lines().count() <= MAX_LINES);
        assert!(all.ends_with(&format!("line {}", MAX_LINES + 4)));
    }
}
