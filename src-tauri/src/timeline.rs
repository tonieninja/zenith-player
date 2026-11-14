use std::sync::OnceLock;

pub fn mark(label: impl Into<String>) {
    static ON: OnceLock<bool> = OnceLock::new();
    if !*ON.get_or_init(|| std::env::var("ZENITH_TRACE").as_deref() == Ok("1")) {
        return;
    }
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    eprintln!("[trace {ms}] {}", label.into());
}
