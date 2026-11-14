use std::io::{self, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

static SPOOL_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_spool_dir(dir: PathBuf) {
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with("zaudio-") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let _ = SPOOL_DIR.set(dir);
}

fn spool_file() -> Option<std::fs::File> {
    use std::sync::atomic::AtomicU64;
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = SPOOL_DIR.get()?;
    let path = dir.join(format!(
        "zaudio-{}-{}.part",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let mut o = std::fs::OpenOptions::new();
    o.read(true).write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        o.custom_flags(0x0400_0000);
    }
    let f = o.open(&path).ok()?;
    #[cfg(unix)]
    let _ = std::fs::remove_file(&path);
    Some(f)
}

enum Store {
    Mem(Vec<u8>),
    Disk(std::fs::File, u64),
}

impl Default for Store {
    fn default() -> Self {
        Store::Mem(Vec::new())
    }
}

#[cfg(unix)]
fn pread(f: &std::fs::File, out: &mut [u8], at: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(f, out, at)
}
#[cfg(windows)]
fn pread(f: &std::fs::File, out: &mut [u8], at: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(f, out, at)
}
#[cfg(unix)]
fn pwrite(f: &std::fs::File, data: &[u8], at: u64) -> io::Result<()> {
    std::os::unix::fs::FileExt::write_all_at(f, data, at)
}
#[cfg(windows)]
fn pwrite(f: &std::fs::File, data: &[u8], at: u64) -> io::Result<()> {
    let mut done = 0;
    while done < data.len() {
        let n = std::os::windows::fs::FileExt::seek_write(f, &data[done..], at + done as u64)?;
        if n == 0 {
            return Err(io::ErrorKind::WriteZero.into());
        }
        done += n;
    }
    Ok(())
}

impl Store {
    fn sized(total: u64) -> Store {
        if let Some(f) = spool_file() {
            if f.set_len(total).is_ok() {
                return Store::Disk(f, total);
            }
        }
        Store::Mem(vec![0u8; total as usize])
    }

    fn len(&self) -> u64 {
        match self {
            Store::Mem(v) => v.len() as u64,
            Store::Disk(_, n) => *n,
        }
    }

    fn put(&mut self, at: u64, data: &[u8]) -> io::Result<()> {
        match self {
            Store::Mem(v) => {
                let end = at as usize + data.len();
                if v.len() < end {
                    v.resize(end, 0);
                }
                v[at as usize..end].copy_from_slice(data);
                Ok(())
            }
            Store::Disk(f, n) => {
                pwrite(f, data, at)?;
                *n = (*n).max(at + data.len() as u64);
                Ok(())
            }
        }
    }

    fn get(&self, at: u64, out: &mut [u8]) -> io::Result<usize> {
        match self {
            Store::Mem(v) => {
                let a = (at as usize).min(v.len());
                let n = out.len().min(v.len() - a);
                out[..n].copy_from_slice(&v[a..a + n]);
                Ok(n)
            }
            Store::Disk(f, _) => {
                let mut got = 0;
                while got < out.len() {
                    let n = pread(f, &mut out[got..], at + got as u64)?;
                    if n == 0 {
                        break;
                    }
                    got += n;
                }
                Ok(got)
            }
        }
    }
}

#[derive(Default)]
struct Data {
    bytes: Store,
    total: Option<u64>,
    filled: Vec<(u64, u64)>,
    done: bool,
    err: Option<String>,
    mime: String,
    want: Option<u64>,
    cursor: u64,
}

impl Data {
    fn has(&self, pos: u64) -> Option<u64> {
        self.filled
            .iter()
            .find(|(a, b)| *a <= pos && pos < *b)
            .map(|(_, b)| *b)
    }

    fn mark(&mut self, a: u64, b: u64) {
        self.filled.push((a, b));
        self.filled.sort_unstable();
        let mut out: Vec<(u64, u64)> = Vec::with_capacity(self.filled.len());
        for (s, e) in self.filled.drain(..) {
            match out.last_mut() {
                Some(l) if s <= l.1 => l.1 = l.1.max(e),
                _ => out.push((s, e)),
            }
        }
        self.filled = out;
        if let Some(t) = self.total {
            if self.filled.first() == Some(&(0, t)) {
                self.done = true;
            }
        }
    }

    fn next_gap(&self, from: u64) -> Option<u64> {
        let total = self.total?;
        let gap_at = |p: u64| -> Option<u64> {
            let mut p = p;
            for (a, b) in &self.filled {
                if p < *a {
                    return Some(p);
                }
                if p < *b {
                    p = *b;
                }
            }
            (p < total).then_some(p)
        };
        gap_at(from).or_else(|| gap_at(0))
    }
}

#[derive(Default)]
pub struct Buf {
    d: Mutex<Data>,
    cv: Condvar,
    cancel: AtomicBool,
}

const JUMP: u64 = 384 * 1024;

impl Buf {
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.cv.notify_all();
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Data> {
        self.d.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn mime(&self) -> String {
        self.lock().mime.clone()
    }

    #[cfg(test)]
    pub fn from_bytes(bytes: Vec<u8>, mime: &str) -> Arc<Buf> {
        let b = Buf::default();
        {
            let mut d = b.lock();
            let n = bytes.len() as u64;
            d.total = Some(n);
            d.bytes = Store::Mem(bytes);
            d.mark(0, n);
            d.done = true;
            d.mime = mime.into();
        }
        Arc::new(b)
    }

    pub fn wait_header(&self) -> Result<(), String> {
        let mut d = self.lock();
        loop {
            if self.cancelled() {
                return Err("cancelled".into());
            }
            if let Some(e) = &d.err {
                return Err(e.clone());
            }
            if d.done || d.has(0).is_some_and(|e| e >= 64 * 1024) {
                return Ok(());
            }
            d = self.cv.wait(d).unwrap_or_else(|p| p.into_inner());
        }
    }

    fn read_at(&self, pos: u64, out: &mut [u8]) -> io::Result<usize> {
        let mut d = self.lock();
        loop {
            if self.cancelled() {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
            }
            if let Some(end) = d.has(pos) {
                let n = ((end - pos) as usize).min(out.len());
                return d.bytes.get(pos, &mut out[..n]);
            }
            if let Some(e) = &d.err {
                return Err(io::Error::other(e.clone()));
            }
            if d.total.is_some_and(|t| pos >= t) || (d.done && d.total.is_none()) {
                return Ok(0);
            }
            if d.total.is_some() && (pos < d.cursor || pos > d.cursor + JUMP) && d.want != Some(pos)
            {
                d.want = Some(pos);
                self.cv.notify_all();
            }
            d = self.cv.wait(d).unwrap_or_else(|p| p.into_inner());
        }
    }

    fn len(&self) -> Option<u64> {
        let d = self.lock();
        d.total.or(d.done.then_some(d.bytes.len()))
    }
}

fn client(local: bool) -> &'static reqwest::blocking::Client {
    static LOCAL: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    static NET: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    let cell = if local { &LOCAL } else { &NET };
    cell.get_or_init(|| {
        let b = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(None::<Duration>)
            .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36");
        let b = if local { b.no_proxy() } else { b };
        b.build().unwrap_or_else(|_| reqwest::blocking::Client::new())
    })
}

fn is_local(url: &str) -> bool {
    url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost")
}

pub fn open(url: &str) -> Arc<Buf> {
    let buf = Arc::new(Buf::default());
    let b = buf.clone();
    let url = url.to_string();
    std::thread::Builder::new()
        .name("zaudio-net".into())
        .spawn(move || download(&b, &url))
        .ok();
    buf
}

fn fail(b: &Buf, e: String) {
    b.lock().err = Some(e);
    b.cv.notify_all();
}

fn total_from(resp: &reqwest::blocking::Response) -> Option<u64> {
    if resp.status().as_u16() == 206 {
        return resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.trim().parse().ok());
    }
    resp.content_length()
}

fn download(b: &Buf, url: &str) {
    if let Some(path) = url.strip_prefix("file://") {
        match std::fs::File::open(path).and_then(|f| f.metadata().map(|m| (f, m.len()))) {
            Ok((f, n)) => {
                let mut d = b.lock();
                d.total = Some(n);
                d.bytes = Store::Disk(f, n);
                d.mark(0, n);
                d.done = true;
            }
            Err(e) => fail(b, e.to_string()),
        }
        b.cv.notify_all();
        return;
    }
    let c = client(is_local(url));
    let mut tries = 0u64;
    let mut from = 0u64;
    loop {
        if b.cancelled() {
            return;
        }
        {
            let mut d = b.lock();
            if d.err.is_some() {
                return;
            }
            if d.done {
                drop(d);
                if crate::debug_log_enabled() {
                    eprintln!("[zaudio] download complete");
                }
                b.cv.notify_all();
                return;
            }
            if let Some(w) = d.want.take() {
                from = w;
            } else if d.total.is_some() {
                match d.next_gap(from) {
                    Some(g) => from = g,
                    None => {
                        d.done = true;
                        continue;
                    }
                }
            }
            d.cursor = from;
        }
        let resp = match c
            .get(url)
            .header(reqwest::header::RANGE, format!("bytes={from}-"))
            .send()
        {
            Ok(r) if r.status().is_success() => r,
            other => {
                tries += 1;
                let msg = match &other {
                    Ok(r) => format!("http {}", r.status()),
                    Err(e) => e.to_string(),
                };
                let fatal = matches!(&other, Ok(r) if r.status().is_client_error() && r.status().as_u16() != 408 && r.status().as_u16() != 429);
                if tries > 4 || fatal {
                    fail(b, msg);
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(400 * tries));
                continue;
            }
        };
        let partial = resp.status().as_u16() == 206;
        {
            let mut d = b.lock();
            if d.mime.is_empty() {
                d.mime = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
            }
            if !partial {
                from = 0;
            }
            if d.total.is_none() {
                if let Some(t) = total_from(&resp) {
                    d.total = Some(t);
                    d.bytes = Store::sized(t);
                }
            }
            d.cursor = from;
        }
        match pump(b, resp, from) {
            Pump::Again(at) => {
                tries = 0;
                from = at;
            }
            Pump::Broken(at) => {
                tries += 1;
                from = at;
                if tries > 5 {
                    fail(b, "connection dropped".into());
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        }
    }
}

enum Pump {
    Again(u64),
    Broken(u64),
}

fn pump(b: &Buf, mut resp: reqwest::blocking::Response, start: u64) -> Pump {
    let mut chunk = vec![0u8; 64 * 1024];
    let mut at = start;
    loop {
        if b.cancelled() {
            return Pump::Again(at);
        }
        match resp.read(&mut chunk) {
            Ok(0) => {
                let mut d = b.lock();
                if d.total.is_none() {
                    d.total = Some(at);
                    d.done = true;
                }
                return Pump::Again(at);
            }
            Ok(n) => {
                let mut d = b.lock();
                let n64 = n as u64;
                match d.total {
                    Some(t) => {
                        let end = (at + n64).min(t);
                        let len = (end - at) as usize;
                        if let Err(e) = d.bytes.put(at, &chunk[..len]) {
                            d.err = Some(e.to_string());
                            drop(d);
                            b.cv.notify_all();
                            return Pump::Again(at);
                        }
                        d.mark(at, end);
                    }
                    None => {
                        let e0 = d.bytes.len();
                        if let Err(e) = d.bytes.put(e0, &chunk[..n]) {
                            d.err = Some(e.to_string());
                            drop(d);
                            b.cv.notify_all();
                            return Pump::Again(at);
                        }
                        let e = d.bytes.len();
                        d.filled = vec![(0, e)];
                    }
                }
                at += n64;
                d.cursor = at;
                let jump = d.want.is_some();
                let overlap = d.total.is_some() && d.has(at).is_some();
                let done = d.done;
                drop(d);
                b.cv.notify_all();
                if jump || overlap || done {
                    return Pump::Again(at);
                }
            }
            Err(_) => return Pump::Broken(at),
        }
    }
}

pub struct Reader {
    buf: Arc<Buf>,
    pos: u64,
}

impl Reader {
    pub fn new(buf: Arc<Buf>) -> Self {
        Reader { buf, pos: 0 }
    }
}

impl Read for Reader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let n = self.buf.read_at(self.pos, out)?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for Reader {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let p = match to {
            SeekFrom::Start(p) => p as i64,
            SeekFrom::Current(d) => self.pos as i64 + d,
            SeekFrom::End(d) => {
                let len = self
                    .buf
                    .len()
                    .ok_or_else(|| io::Error::new(io::ErrorKind::Unsupported, "unknown length"))?;
                len as i64 + d
            }
        };
        if p < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "negative seek"));
        }
        self.pos = p as u64;
        Ok(self.pos)
    }
}

impl symphonia::core::io::MediaSource for Reader {
    fn is_seekable(&self) -> bool {
        self.buf.len().is_some()
    }

    fn byte_len(&self) -> Option<u64> {
        self.buf.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_seeks_and_reads_from_memory() {
        let b = Buf::from_bytes((0u8..=255).collect(), "audio/webm");
        let mut r = Reader::new(b.clone());
        let mut x = [0u8; 4];
        r.seek(SeekFrom::Start(10)).unwrap();
        r.read_exact(&mut x).unwrap();
        assert_eq!(x, [10, 11, 12, 13]);
        r.seek(SeekFrom::End(-2)).unwrap();
        assert_eq!(r.read(&mut x).unwrap(), 2);
        assert_eq!(r.read(&mut x).unwrap(), 0);
        assert_eq!(b.mime(), "audio/webm");
    }

    #[test]
    fn cancel_wakes_a_blocked_read() {
        let b = Arc::new(Buf::default());
        let b2 = b.clone();
        let t = std::thread::spawn(move || {
            let mut r = Reader::new(b2);
            let mut x = [0u8; 4];
            r.read(&mut x).is_err()
        });
        std::thread::sleep(Duration::from_millis(50));
        b.cancel();
        assert!(t.join().unwrap());
    }

    fn slow_server(body: Vec<u8>) -> String {
        use std::io::{BufRead, BufReader, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let body = Arc::new(body);
        std::thread::spawn(move || {
            for c in l.incoming().flatten() {
                let body = body.clone();
                std::thread::spawn(move || {
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
                    let mut c = c;
                    let n = body.len();
                    let head = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Type: audio/webm\r\nContent-Length: {}\r\nContent-Range: bytes {from}-{}/{n}\r\n\r\n",
                        n - from,
                        n - 1
                    );
                    if c.write_all(head.as_bytes()).is_err() {
                        return;
                    }
                    for part in body[from..].chunks(16 * 1024) {
                        if c.write_all(part).is_err() {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                });
            }
        });
        format!("http://127.0.0.1:{port}/a")
    }

    #[test]
    fn far_read_jumps_instead_of_waiting() {
        let body: Vec<u8> = (0..4_000_000u32).map(|i| (i % 251) as u8).collect();
        let url = slow_server(body.clone());
        let b = open(&url);
        b.wait_header().unwrap();
        assert_eq!(b.mime(), "audio/webm");
        let mut r = Reader::new(b.clone());
        let t = std::time::Instant::now();
        r.seek(SeekFrom::Start(3_500_000)).unwrap();
        let mut x = [0u8; 1000];
        r.read_exact(&mut x).unwrap();
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
        assert_eq!(&x[..], &body[3_500_000..3_501_000]);
        r.seek(SeekFrom::Start(100)).unwrap();
        r.read_exact(&mut x).unwrap();
        assert_eq!(&x[..], &body[100..1100]);
        r.seek(SeekFrom::End(-10)).unwrap();
        let mut y = Vec::new();
        r.read_to_end(&mut y).unwrap();
        assert_eq!(&y[..], &body[body.len() - 10..]);
        b.cancel();
    }

    #[test]
    fn spooled_download_reads_back_from_disk() {
        let dir = std::env::temp_dir().join(format!("zspool-{}", std::process::id()));
        set_spool_dir(dir.clone());
        let body: Vec<u8> = (0..1_500_000u32).map(|i| (i % 241) as u8).collect();
        let b = open(&slow_server(body.clone()));
        b.wait_header().unwrap();
        let mut r = Reader::new(b.clone());
        r.seek(SeekFrom::Start(1_200_000)).unwrap();
        let mut x = [0u8; 5000];
        r.read_exact(&mut x).unwrap();
        assert_eq!(&x[..], &body[1_200_000..1_205_000]);
        assert!(matches!(b.lock().bytes, Store::Disk(..)));
        r.seek(SeekFrom::Start(0)).unwrap();
        let mut all = Vec::new();
        r.read_to_end(&mut all).unwrap();
        assert_eq!(all, body);
        b.cancel();
        drop(r);
        drop(b);
        let left = || std::fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0);
        let t = std::time::Instant::now();
        while left() > 0 && t.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(left(), 0, "spool file goes away");
    }
}
