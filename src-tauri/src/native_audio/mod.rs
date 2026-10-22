mod decode;
mod dsp;
mod duck;
mod output;
mod source;

pub use source::set_spool_dir;

use decode::{DecCmd, DeckEv};
use output::DeckOut;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use source::Buf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub t: f64,
    pub d: Option<f64>,
    pub paused: bool,
    pub ready: u8,
    pub src: String,
    pub has_source: bool,
    pub crossfading: bool,
    pub ended: bool,
    pub muted: bool,
}

#[derive(Clone, Serialize)]
struct Ev {
    #[serde(rename = "type")]
    kind: &'static str,
    snap: Snapshot,
}

struct Deck {
    out: Arc<DeckOut>,
    tx: Sender<DecCmd>,
    buf: Option<Arc<Buf>>,
    src: String,
    ready: u8,
    dur: Option<f64>,
    ended: bool,
    gain: f64,
    want_play: bool,
    buffering: bool,
    pending_seek: Option<f64>,
    errored: bool,
    gen: u64,
    last_t: f64,
    norm: f64,
    loud_sum: f64,
    loud_n: u32,
}

struct State {
    decks: Vec<Deck>,
    active: usize,
    master: f64,
    duck: f64,
    muted: bool,
    rate: f64,
    fade_token: u64,
    fading: bool,
    norm_on: bool,
    ab: Option<(f64, f64)>,
    ab_hold_until: Option<Instant>,
}

pub struct Engine {
    st: Mutex<State>,
    app: Option<AppHandle>,
}

static ENGINE: OnceLock<Option<Engine>> = OnceLock::new();
static HEADLESS: AtomicBool = AtomicBool::new(false);
static GEN: AtomicU64 = AtomicU64::new(1);
static TICKER: OnceLock<std::thread::Thread> = OnceLock::new();

fn engine() -> Option<&'static Engine> {
    ENGINE.get().and_then(|e| e.as_ref())
}

pub fn available() -> bool {
    engine().is_some()
}

pub fn init(app: &AppHandle) {
    if start(Some(app.clone())).is_none() {
        eprintln!("[zaudio] no audio output device, using webview audio");
        let _ = ENGINE.set(None);
    }
}

fn start(app: Option<AppHandle>) -> Option<&'static Engine> {
    if let Some(e) = ENGINE.get() {
        return e.as_ref();
    }
    if !output::start() {
        return None;
    }
    let outs = output::decks()?;
    let decks = outs
        .into_iter()
        .enumerate()
        .map(|(i, out)| Deck {
            tx: decode::spawn(i, out.clone(), on_deck_event),
            out,
            buf: None,
            src: String::new(),
            ready: 0,
            dur: None,
            ended: false,
            gain: 1.0,
            want_play: false,
            buffering: false,
            pending_seek: None,
            errored: false,
            gen: 0,
            last_t: 0.0,
            norm: 1.0,
            loud_sum: 0.0,
            loud_n: 0,
        })
        .collect();
    let st = State {
        decks,
        active: 0,
        master: 0.8,
        duck: 1.0,
        muted: false,
        rate: 1.0,
        fade_token: 0,
        fading: false,
        norm_on: false,
        ab: None,
        ab_hold_until: None,
    };
    let _ = ENGINE.set(Some(Engine {
        st: Mutex::new(st),
        app,
    }));
    if let Ok(h) = std::thread::Builder::new()
        .name("zaudio-tick".into())
        .spawn(tick_loop)
    {
        let _ = TICKER.set(h.thread().clone());
    }
    engine()
}

fn kick() {
    if let Some(t) = TICKER.get() {
        t.unpark();
    }
}

fn pos_of(d: &Deck) -> f64 {
    if d.ready < 1 {
        return d.pending_seek.unwrap_or(d.last_t);
    }
    if let Some(p) = d.pending_seek {
        return p;
    }
    d.out.pos()
}

fn dur_of(d: &Deck) -> Option<f64> {
    if d.src.is_empty() || d.ready < 1 {
        return None;
    }
    d.dur.filter(|v| *v > 0.0)
}

fn snap_of(st: &State) -> Snapshot {
    let d = &st.decks[st.active];
    let o = &st.decks[1 - st.active];
    Snapshot {
        t: pos_of(d),
        d: dur_of(d),
        paused: !d.want_play,
        ready: d.ready,
        src: d.src.clone(),
        has_source: !d.src.is_empty() || !o.src.is_empty() || st.fading,
        crossfading: st.fading,
        ended: d.ended,
        muted: st.muted,
    }
}

fn emit(e: &Engine, kind: &'static str, snap: Snapshot) {
    if HEADLESS.load(Ordering::SeqCst) {
        return;
    }
    if let Some(app) = &e.app {
        let _ = app.emit("zaudio", Ev { kind, snap });
    }
}

fn apply_volume(st: &State, i: usize) {
    let d = &st.decks[i];
    let v = if st.muted {
        0.0
    } else {
        (st.master * st.duck * d.gain * d.norm).clamp(0.0, 1.0)
    };
    d.out.set_gain(v);
}

fn set_duck(f: f64) {
    let Some(e) = engine() else { return };
    let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
    if (st.duck - f).abs() < 1e-9 {
        return;
    }
    st.duck = f;
    apply_volume(&st, 0);
    apply_volume(&st, 1);
}

fn set_playing(d: &Deck, on: bool) {
    d.out.playing.store(on, Ordering::SeqCst);
    if on {
        output::wake();
        let _ = d.tx.send(DecCmd::Wake);
        kick();
    }
}

fn clear_deck(d: &mut Deck) {
    set_playing(d, false);
    if let Some(b) = d.buf.take() {
        b.cancel();
    }
    d.out.queue().flush();
    d.out.set_pos(0.0);
    d.out.starved.store(false, Ordering::SeqCst);
    d.out.drained.store(false, Ordering::SeqCst);
    let _ = d.tx.send(DecCmd::Stop);
    d.src.clear();
    d.ready = 0;
    d.dur = None;
    d.ended = false;
    d.want_play = false;
    d.buffering = false;
    d.pending_seek = None;
    d.errored = false;
    d.last_t = 0.0;
    d.gen = GEN.fetch_add(1, Ordering::SeqCst);
}

fn load_deck(d: &mut Deck, url: &str, rate: f64) {
    clear_deck(d);
    d.norm = 1.0;
    d.loud_sum = 0.0;
    d.loud_n = 0;
    d.src = url.to_string();
    let buf = source::open(url);
    d.buf = Some(buf.clone());
    let epoch = d.out.queue().epoch;
    let _ = d.tx.send(DecCmd::Load {
        buf,
        gen: d.gen,
        epoch,
        rate,
    });
}

fn do_seek(d: &mut Deck, t: f64, rate: f64) {
    let t = t.max(0.0);
    d.last_t = t;
    d.ended = false;
    if d.ready < 1 {
        d.pending_seek = Some(t);
        return;
    }
    d.pending_seek = None;
    let epoch = d.out.queue().flush();
    d.out.set_pos(t);
    d.out.drained.store(false, Ordering::SeqCst);
    let _ = d.tx.send(DecCmd::Seek { t, epoch, rate });
}

fn on_deck_event(i: usize, gen: u64, ev: DeckEv) {
    let Some(e) = engine() else { return };
    let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
    if st.decks[i].gen != gen {
        return;
    }
    let is_active = st.active == i;
    let rate = st.rate;
    let norm_on = st.norm_on;
    let mut out: Vec<&'static str> = Vec::new();
    let mut norm_changed = false;
    {
        let d = &mut st.decks[i];
        match ev {
            DeckEv::Ready(dur) => {
                if d.ready < 4 && !d.src.is_empty() {
                    d.dur = dur;
                    d.ready = 4;
                    if let Some(t) = d.pending_seek.take() {
                        if t > 0.05 {
                            do_seek(d, t, rate);
                        }
                    }
                    out.extend(["loadedmetadata", "durationchange", "canplay"]);
                    if d.want_play && !d.buffering {
                        set_playing(d, true);
                    }
                }
            }
            DeckEv::Duration(v) => {
                d.dur = Some(v);
                out.push("durationchange");
            }
            DeckEv::Level(db) => {
                if norm_on && d.loud_n < dsp::NORM_BLOCKS && d.want_play {
                    if let Some(g) = dsp::norm_update(&mut d.loud_sum, &mut d.loud_n, db) {
                        let cur = 20.0 * d.norm.max(1e-4).log10();
                        let next = cur + (g - cur).clamp(-1.0, 1.0);
                        d.norm = 10f64.powf(next / 20.0);
                        norm_changed = true;
                    }
                }
            }
            DeckEv::Error(msg) => {
                if !d.src.is_empty() && !d.errored {
                    eprintln!("[zaudio] deck{i} error: {msg}");
                    d.errored = true;
                    d.want_play = false;
                    set_playing(d, false);
                    out.push("error");
                }
            }
        }
    }
    if norm_changed && st.norm_on && !st.fading {
        apply_volume(&st, i);
    }
    if out.is_empty() || !is_active {
        return;
    }
    let snap = snap_of(&st);
    drop(st);
    for k in out {
        emit(e, k, snap.clone());
    }
}

fn watch_decks(e: &Engine) {
    let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
    let active = st.active;
    let mut out: Vec<&'static str> = Vec::new();
    let mut ended = false;
    for i in 0..2 {
        let d = &mut st.decks[i];
        if d.out.drained.swap(false, Ordering::SeqCst) && !d.src.is_empty() && !d.ended {
            d.last_t = pos_of(d);
            d.ended = true;
            d.want_play = false;
            set_playing(d, false);
            if i == active {
                out.extend(["timeupdate", "pause", "ended"]);
                ended = true;
            }
            continue;
        }
        if i != active || d.ready < 4 || !d.want_play {
            continue;
        }
        let starved = d.out.starved.load(Ordering::SeqCst);
        if starved && !d.buffering {
            d.buffering = true;
            out.push("waiting");
        } else if d.buffering {
            let q = d.out.queue();
            let enough = q.eof || q.frames as f64 >= 0.3 * output::sample_rate() as f64;
            drop(q);
            if enough {
                d.buffering = false;
                d.out.starved.store(false, Ordering::SeqCst);
                out.push("canplay");
            }
        }
    }
    if out.is_empty() {
        return;
    }
    let snap = snap_of(&st);
    drop(st);
    for k in out {
        emit(e, k, snap.clone());
    }
    if ended && HEADLESS.load(Ordering::SeqCst) {
        std::thread::spawn(headless::on_ended);
    }
}

pub fn ab_range(a: Option<f64>, b: Option<f64>) -> Option<(f64, f64)> {
    match (a, b) {
        (Some(a), Some(b)) if a.is_finite() && b.is_finite() && a >= 0.0 && b > a + 0.2 => {
            Some((a, b))
        }
        _ => None,
    }
}

pub fn ab_jump(ab: Option<(f64, f64)>, t: f64) -> Option<f64> {
    let (a, b) = ab?;
    (t >= b - 0.03).then_some(a)
}

const TICK_MS: u64 = 50;
const TICKS_PER_UPDATE: u32 = 5;

fn busy(st: &State) -> bool {
    st.fading || st.decks.iter().any(|d| d.want_play)
}

fn tick_loop() {
    let Some(e) = engine() else { return };
    let mut n: u32 = 0;
    loop {
        if !busy(&e.st.lock().unwrap_or_else(|p| p.into_inner())) {
            std::thread::park_timeout(Duration::from_secs(60));
            continue;
        }
        std::thread::sleep(Duration::from_millis(TICK_MS));
        n = n.wrapping_add(1);
        watch_decks(e);
        let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
        let a = st.active;
        let d = &st.decks[a];
        if !d.want_play || d.ready < 4 || d.buffering {
            continue;
        }
        let mut looped = None;
        let held = st.ab_hold_until.is_some_and(|until| Instant::now() < until);
        if st.ab.is_some() && !st.fading && !held {
            if let Some(to) = ab_jump(st.ab, pos_of(d)) {
                let rate = st.rate;
                do_seek(&mut st.decks[a], to, rate);
                st.ab_hold_until = Some(Instant::now() + Duration::from_millis(400));
                looped = Some(to);
            }
        }
        if looped.is_none() && n % TICKS_PER_UPDATE != 0 {
            continue;
        }
        let mut snap = snap_of(&st);
        drop(st);
        if let Some(to) = looped {
            snap.t = to;
        }
        emit(e, "timeupdate", snap.clone());
        if HEADLESS.load(Ordering::SeqCst) {
            headless::on_tick(&snap);
        }
    }
}

pub fn snapshot() -> Snapshot {
    engine()
        .map(|e| snap_of(&e.st.lock().unwrap_or_else(|p| p.into_inner())))
        .unwrap_or_default()
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> Option<R> {
    let e = engine()?;
    let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
    Some(f(&mut st))
}

fn cancel_fade(st: &mut State) {
    st.fade_token += 1;
    st.fading = false;
    let a = st.active;
    st.decks[a].gain = 1.0;
    apply_volume(st, a);
}

fn silence_other(st: &mut State) {
    let o = 1 - st.active;
    clear_deck(&mut st.decks[o]);
    st.decks[o].gain = 0.0;
    apply_volume(st, o);
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Cmd {
    SetSrc {
        url: String,
    },
    ClearSrc,
    Pause,
    Seek {
        t: f64,
    },
    Volume {
        v: f64,
    },
    Muted {
        m: bool,
    },
    Rate {
        r: f64,
    },
    Eq {
        bands: Vec<f64>,
        #[serde(default)]
        bass: f64,
    },
    Norm {
        on: bool,
    },
    AbortAll,
    ReleaseInactive,
    Load,
    Loop {
        a: Option<f64>,
        b: Option<f64>,
    },
}

pub fn run_cmd(cmd: Cmd) -> Snapshot {
    let Some(e) = engine() else {
        return Snapshot::default();
    };
    let mut events: Vec<&'static str> = Vec::new();
    {
        let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
        let a = st.active;
        let rate = st.rate;
        match cmd {
            Cmd::SetSrc { url } => {
                st.ab = None;
                cancel_fade(&mut st);
                silence_other(&mut st);
                load_deck(&mut st.decks[a], &url, rate);
                apply_volume(&st, a);
            }
            Cmd::ClearSrc => {
                st.ab = None;
                cancel_fade(&mut st);
                silence_other(&mut st);
                clear_deck(&mut st.decks[a]);
            }
            Cmd::Pause => {
                cancel_fade(&mut st);
                silence_other(&mut st);
                let d = &mut st.decks[a];
                if d.want_play {
                    d.last_t = pos_of(d);
                    d.want_play = false;
                    set_playing(d, false);
                    events.push("pause");
                }
            }
            Cmd::Seek { t } => {
                do_seek(&mut st.decks[a], t, rate);
                events.push("timeupdate");
            }
            Cmd::Volume { v } => {
                st.master = v.clamp(0.0, 1.0);
                if !st.fading {
                    apply_volume(&st, a);
                }
            }
            Cmd::Muted { m } => {
                st.muted = m;
                apply_volume(&st, 0);
                apply_volume(&st, 1);
            }
            Cmd::Rate { r } => {
                let r = r.clamp(0.25, 4.0);
                let changed = (r - st.rate).abs() > 1e-6;
                st.rate = r;
                if changed {
                    for i in 0..2 {
                        let d = &mut st.decks[i];
                        if d.ready >= 4 {
                            let t = pos_of(d);
                            do_seek(d, t, r);
                        }
                    }
                }
            }
            Cmd::Eq { bands, bass } => output::set_eq(&bands, bass),
            Cmd::Norm { on } => {
                st.norm_on = on;
                decode::NORM_ON.store(on, Ordering::SeqCst);
                for i in 0..2 {
                    if !on {
                        st.decks[i].norm = 1.0;
                    }
                    if !st.fading {
                        apply_volume(&st, i);
                    }
                }
            }
            Cmd::AbortAll => {
                st.ab = None;
                cancel_fade(&mut st);
                for i in 0..2 {
                    clear_deck(&mut st.decks[i]);
                }
                st.decks[1 - a].gain = 1.0;
                apply_volume(&st, a);
            }
            Cmd::ReleaseInactive => {
                if !st.fading {
                    silence_other(&mut st);
                }
            }
            Cmd::Loop { a: from, b: to } => {
                st.ab = ab_range(from, to);
                st.ab_hold_until = None;
            }
            Cmd::Load => {
                let d = &mut st.decks[a];
                if !d.src.is_empty() {
                    let url = d.src.clone();
                    let wp = d.want_play;
                    load_deck(d, &url, rate);
                    d.want_play = wp;
                }
            }
        }
    }
    let snap = snapshot();
    for k in events {
        emit(e, k, snap.clone());
    }
    snap
}

pub async fn play() -> Result<Snapshot, String> {
    let e = engine().ok_or("no engine")?;
    let gen = {
        let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
        let a = st.active;
        let rate = st.rate;
        apply_volume(&st, a);
        let d = &mut st.decks[a];
        if d.src.is_empty() {
            return Err("NotSupportedError: no source".into());
        }
        if d.ended {
            d.ended = false;
            d.pending_seek = None;
            d.ready = 4;
            do_seek(d, 0.0, rate);
        }
        let was = d.want_play;
        d.want_play = true;
        if d.ready >= 4 && !d.buffering {
            set_playing(d, true);
        }
        kick();
        let g = d.gen;
        drop(st);
        if !was {
            emit(e, "play", snapshot());
        }
        g
    };
    wait_for(gen, true, Duration::from_secs(14)).await?;
    Ok(snapshot())
}

async fn wait_for(gen: u64, playing: bool, timeout: Duration) -> Result<(), String> {
    let e = engine().ok_or("no engine")?;
    let start = Instant::now();
    loop {
        {
            let st = e.st.lock().unwrap_or_else(|p| p.into_inner());
            let Some(d) = st.decks.iter().find(|d| d.gen == gen) else {
                return Err("AbortError: superseded".into());
            };
            if d.errored {
                return Err("decode error".into());
            }
            if d.ready >= 4 {
                if !playing {
                    return Ok(());
                }
                if !d.want_play {
                    return Err("AbortError: paused".into());
                }
                if d.out.playing.load(Ordering::SeqCst) || d.buffering {
                    return Ok(());
                }
            }
        }
        if start.elapsed() > timeout {
            return Err("timeout".into());
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

pub async fn wait_ready(timeout_ms: u64) -> bool {
    let Some(gen) = with(|st| st.decks[st.active].gen) else {
        return false;
    };
    wait_for(gen, false, Duration::from_millis(timeout_ms))
        .await
        .is_ok()
}

pub async fn crossfade(url: String, seconds: f64) -> Result<Snapshot, String> {
    let e = engine().ok_or("no engine")?;
    let (token, gen, from_audible) = {
        let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
        st.ab = None;
        st.fade_token += 1;
        st.fading = false;
        let token = st.fade_token;
        let a = st.active;
        let o = 1 - a;
        let rate = st.rate;
        let prerolled = st.decks[o].src == url && !st.decks[o].errored && st.decks[o].ready >= 1;
        if !prerolled {
            silence_other(&mut st);
        }
        let from_audible = st.decks[a].want_play && !st.decks[a].src.is_empty();
        if !prerolled {
            load_deck(&mut st.decks[o], &url, rate);
        }
        st.decks[o].gain = 0.0;
        apply_volume(&st, o);
        (token, st.decks[o].gen, from_audible)
    };
    let tok_ok = |e: &Engine| e.st.lock().unwrap_or_else(|p| p.into_inner()).fade_token == token;
    let fail = |e: &Engine, msg: String| {
        let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
        if st.fade_token == token {
            silence_other(&mut st);
        }
        msg
    };
    if let Err(m) = wait_for(gen, false, Duration::from_secs(14)).await {
        return Err(fail(e, if tok_ok(e) { m } else { "superseded".into() }));
    }
    if !tok_ok(e) {
        return Err("superseded".into());
    }
    {
        let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
        let o = 1 - st.active;
        st.decks[o].want_play = true;
        set_playing(&st.decks[o], true);
    }
    if let Err(m) = wait_for(gen, true, Duration::from_secs(14)).await {
        return Err(fail(e, m));
    }
    if !tok_ok(e) {
        return Err("superseded".into());
    }
    {
        let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
        st.active = 1 - st.active;
        st.fading = true;
    }
    kick();
    emit(e, "durationchange", snapshot());
    let dur = (seconds * 1000.0).max(180.0);
    std::thread::spawn(move || {
        let started = Instant::now();
        loop {
            let t = (started.elapsed().as_secs_f64() * 1000.0 / dur).min(1.0);
            let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
            if st.fade_token != token {
                let f = 1 - st.active;
                if st.decks[f].gen != gen {
                    clear_deck(&mut st.decks[f]);
                }
                return;
            }
            let to = st.active;
            let from = 1 - to;
            st.decks[to].gain = (t * std::f64::consts::FRAC_PI_2).sin();
            apply_volume(&st, to);
            if from_audible {
                st.decks[from].gain = (t * std::f64::consts::FRAC_PI_2).cos();
                apply_volume(&st, from);
            }
            if t >= 1.0 {
                st.fading = false;
                clear_deck(&mut st.decks[from]);
                st.decks[to].gain = 1.0;
                apply_volume(&st, to);
                return;
            }
            drop(st);
            std::thread::sleep(Duration::from_millis(16));
        }
    });
    Ok(snapshot())
}

#[tauri::command]
pub fn zaudio_available() -> bool {
    available()
}

#[tauri::command]
pub fn zaudio_duck(on: bool, level: f64, sensitivity: f64) -> Result<(), String> {
    if !on {
        duck::stop();
        return Ok(());
    }
    if !available() {
        return Err("no engine".into());
    }
    duck::configure(level, sensitivity);
    duck::start()
}

#[tauri::command]
pub fn zaudio_duck_meter() -> (f64, bool) {
    duck::meter()
}

#[tauri::command]
pub fn zaudio_cmd(cmd: Cmd) -> Snapshot {
    run_cmd(cmd)
}

#[tauri::command]
pub async fn zaudio_play() -> Result<Snapshot, String> {
    play().await
}

#[tauri::command]
pub async fn zaudio_wait_ready(timeout_ms: u64) -> bool {
    wait_ready(timeout_ms).await
}

#[tauri::command]
pub fn zaudio_preroll(url: String) -> bool {
    preroll(&url)
}

pub fn preroll(url: &str) -> bool {
    let Some(e) = engine() else { return false };
    let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
    if st.fading || url.is_empty() {
        return false;
    }
    let o = 1 - st.active;
    if st.decks[o].src == url && !st.decks[o].errored {
        return true;
    }
    let rate = st.rate;
    load_deck(&mut st.decks[o], url, rate);
    st.decks[o].want_play = false;
    st.decks[o].gain = 0.0;
    apply_volume(&st, o);
    true
}

#[tauri::command]
pub async fn zaudio_tail(url: String, d: f64) -> Option<f64> {
    if url.is_empty() || !d.is_finite() || d < 30.0 {
        return None;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let buf = source::open(&url);
        let r = decode::audible_end(buf.clone(), d);
        buf.cancel();
        r.ok().flatten()
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub async fn zaudio_crossfade(url: String, seconds: f64) -> Result<Snapshot, String> {
    crossfade(url, seconds).await
}

#[tauri::command]
pub fn zaudio_plan(plan: Value) {
    headless::set_plan(plan);
}

#[tauri::command]
pub fn zaudio_attach(app: AppHandle) -> Value {
    HEADLESS.store(false, Ordering::SeqCst);
    let _ = app;
    headless::take_restore(snapshot())
}

pub fn is_headless() -> bool {
    HEADLESS.load(Ordering::SeqCst)
}

pub fn set_headless(on: bool) {
    HEADLESS.store(on, Ordering::SeqCst);
    if on {
        headless::began();
    }
}

pub mod headless {
    use super::*;

    #[derive(Default)]
    struct H {
        plan: Value,
        played: Vec<Value>,
        moved: bool,
        fade_started_for: Option<usize>,
        prefetched_for: Option<usize>,
        busy: bool,
    }
    static H_: Mutex<Option<H>> = Mutex::new(None);

    fn h<R>(f: impl FnOnce(&mut H) -> R) -> R {
        let mut g = H_.lock().unwrap_or_else(|p| p.into_inner());
        f(g.get_or_insert_with(H::default))
    }

    pub fn set_plan(plan: Value) {
        h(|h| {
            h.plan = plan;
            h.fade_started_for = None;
            h.prefetched_for = None;
        });
    }

    pub fn began() {
        h(|h| {
            h.played.clear();
            h.moved = false;
            h.fade_started_for = None;
            h.prefetched_for = None;
        });
        save_state();
    }

    fn queue_len(p: &Value) -> usize {
        p["queue"].as_array().map(|a| a.len()).unwrap_or(0)
    }
    fn index(p: &Value) -> usize {
        p["index"].as_u64().unwrap_or(0) as usize
    }
    fn loop_mode(p: &Value) -> String {
        p["loopMode"].as_str().unwrap_or("off").to_string()
    }
    fn next_index(p: &Value) -> Option<usize> {
        let n = queue_len(p);
        let i = index(p);
        if i + 1 < n {
            Some(i + 1)
        } else if loop_mode(p) == "all" && n > 0 {
            Some(0)
        } else {
            None
        }
    }
    fn prev_index(p: &Value) -> Option<usize> {
        let n = queue_len(p);
        let i = index(p);
        if i > 0 {
            Some(i - 1)
        } else if loop_mode(p) == "all" && n > 0 {
            Some(n - 1)
        } else {
            None
        }
    }
    fn track_id(p: &Value, i: usize) -> Option<String> {
        p["queue"][i]["id"].as_str().map(String::from)
    }

    async fn resolve(id: &str) -> Option<String> {
        let e = engine()?;
        crate::stream::get_stream_url(e.app.clone()?, id.to_string(), None)
            .await
            .ok()
            .flatten()
    }

    fn mark_started(i: usize) {
        eprintln!("[zaudio] headless: started queue index {i}");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        h(|h| {
            h.plan["index"] = Value::from(i as u64);
            h.moved = true;
            let id = h.plan["queue"][i]["id"].clone();
            h.played
                .push(serde_json::json!({ "index": i, "id": id, "at": now }));
            h.fade_started_for = None;
            h.prefetched_for = None;
        });
        save_state();
        discord_presence(true);
    }

    async fn start_index(i: usize, fade: f64) {
        let Some(id) = h(|h| track_id(&h.plan, i)) else {
            return;
        };
        let mut url = resolve(&id).await;
        if url.is_none() {
            url = resolve(&id).await;
        }
        let Some(url) = url else {
            eprintln!("[zaudio] headless: no stream for {id}, skipping");
            if let Some(n) = h(|h| {
                h.plan["index"] = Value::from(i as u64);
                next_index(&h.plan)
            }) {
                if n != i {
                    Box::pin(start_index(n, 0.0)).await;
                }
            }
            return;
        };
        if fade > 0.0 && crossfade(url.clone(), fade).await.is_ok() {
            mark_started(i);
            return;
        }
        run_cmd(Cmd::SetSrc { url });
        if play().await.is_ok() {
            mark_started(i);
        }
    }

    fn spawn_once(f: impl std::future::Future<Output = ()> + Send + 'static) {
        if h(|h| std::mem::replace(&mut h.busy, true)) {
            return;
        }
        tauri::async_runtime::spawn(async move {
            f.await;
            h(|h| h.busy = false);
        });
    }

    pub fn on_tick(s: &Snapshot) {
        let Some(d) = s.d else { return };
        let remaining = d - s.t;
        let (cf, loop_one, next, fade_for, pre_for) = h(|h| {
            (
                h.plan["crossfade"].as_f64().unwrap_or(0.0),
                loop_mode(&h.plan) == "one",
                next_index(&h.plan),
                h.fade_started_for,
                h.prefetched_for,
            )
        });
        let Some(next) = next else { return };
        if loop_one {
            return;
        }
        if remaining < cf + 20.0 && pre_for != Some(next) {
            h(|h| h.prefetched_for = Some(next));
            if let Some(id) = h(|h| track_id(&h.plan, next)) {
                tauri::async_runtime::spawn(async move {
                    let _ = resolve(&id).await;
                });
            }
        }
        if cf > 0.0
            && !s.crossfading
            && remaining <= cf
            && remaining > 0.35
            && fade_for != Some(next)
        {
            h(|h| h.fade_started_for = Some(next));
            spawn_once(start_index(next, remaining.max(1.0)));
        }
    }

    pub fn on_ended() {
        let (loop_one, next) = h(|h| (loop_mode(&h.plan) == "one", next_index(&h.plan)));
        if loop_one {
            run_cmd(Cmd::Seek { t: 0.0 });
            tauri::async_runtime::spawn(async {
                let _ = play().await;
            });
            return;
        }
        match next {
            Some(n) => spawn_once(start_index(n, 0.0)),
            None => {
                save_state();
                discord_presence(false);
            }
        }
    }

    pub fn action(action: &str) {
        match action {
            "toggle-play" => {
                if snapshot().paused {
                    tauri::async_runtime::spawn(async {
                        if !snapshot().has_source {
                            let i = h(|h| index(&h.plan));
                            start_index(i, 0.0).await;
                        } else {
                            let _ = play().await;
                        }
                        save_state();
                        discord_presence(true);
                    });
                } else {
                    run_cmd(Cmd::Pause);
                    save_state();
                    discord_presence(false);
                }
            }
            "next" => {
                if let Some(n) = h(|h| next_index(&h.plan)) {
                    let cf = h(|h| h.plan["crossfade"].as_f64().unwrap_or(0.0));
                    spawn_once(start_index(n, if snapshot().has_source { cf } else { 0.0 }));
                }
            }
            "prev" => {
                if snapshot().t > 3.0 {
                    run_cmd(Cmd::Seek { t: 0.0 });
                } else if let Some(p) = h(|h| prev_index(&h.plan)) {
                    let cf = h(|h| h.plan["crossfade"].as_f64().unwrap_or(0.0));
                    spawn_once(start_index(p, if snapshot().has_source { cf } else { 0.0 }));
                }
            }
            _ => {}
        }
    }

    fn discord_presence(playing: bool) {
        let (cid, track, context) = h(|h| {
            (
                h.plan["discordClientId"].as_str().map(String::from),
                h.plan["queue"][index(&h.plan)].clone(),
                h.plan["playingFrom"].as_str().map(String::from),
            )
        });
        let Some(client_id) = cid else { return };
        let s = snapshot();
        let payload = crate::discord::PresencePayload {
            client_id,
            title: track["title"].as_str().unwrap_or("").to_string(),
            artist: track["artist"].as_str().unwrap_or("").to_string(),
            duration: s.d.unwrap_or(0.0),
            position: s.t,
            is_playing: playing && !s.paused,
            cover_url: track["coverLarge"]
                .as_str()
                .or_else(|| track["cover"].as_str())
                .map(String::from),
            context,
            track_url: track["id"]
                .as_str()
                .map(|id| format!("https://music.youtube.com/watch?v={id}")),
        };
        std::thread::spawn(move || {
            let _ = crate::discord::discord_update_presence(payload);
        });
    }

    fn state_path() -> Option<std::path::PathBuf> {
        let e = engine()?;
        let dir = e.app.as_ref()?.path().app_data_dir().ok()?;
        let _ = std::fs::create_dir_all(&dir);
        Some(dir.join("headless_state.json"))
    }

    pub fn save_state() {
        let Some(p) = state_path() else { return };
        let s = snapshot();
        let v = h(|h| {
            serde_json::json!({
                "plan": h.plan,
                "progress": s.t,
                "wasPlaying": !s.paused,
                "moved": h.moved,
                "savedAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
            })
        });
        let _ = std::fs::write(p, v.to_string());
    }

    pub fn take_restore(s: Snapshot) -> Value {
        let disk = state_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .unwrap_or(Value::Null);

        h(|h| {
            serde_json::json!({
                "plan": h.plan,
                "played": std::mem::take(&mut h.played),
                "moved": std::mem::replace(&mut h.moved, false),
                "snap": s,
                "disk": disk,
            })
        })
    }
}

#[cfg(test)]
mod ab_tests {
    use super::{ab_jump, ab_range};

    #[test]
    fn range_needs_b_after_a() {
        assert_eq!(ab_range(Some(10.0), Some(25.0)), Some((10.0, 25.0)));
        assert_eq!(ab_range(Some(10.0), Some(10.1)), None);
        assert_eq!(ab_range(Some(25.0), Some(10.0)), None);
        assert_eq!(ab_range(Some(10.0), None), None);
        assert_eq!(ab_range(Some(f64::NAN), Some(20.0)), None);
    }

    #[test]
    fn jumps_back_to_a_at_b() {
        let ab = Some((10.0, 25.0));
        assert_eq!(ab_jump(ab, 20.0), None);
        assert_eq!(ab_jump(ab, 24.98), Some(10.0));
        assert_eq!(ab_jump(ab, 40.0), Some(10.0));
        assert_eq!(ab_jump(None, 40.0), None);
    }
}

#[cfg(test)]
mod engine_tests {
    use super::*;

    fn url(name: &str) -> String {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        format!("file://{}", p.display())
    }

    async fn until(secs: f64, f: impl Fn(&Snapshot) -> bool) -> Snapshot {
        let start = Instant::now();
        loop {
            let s = snapshot();
            if f(&s) || start.elapsed().as_secs_f64() > secs {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn gains() -> (f64, f64) {
        with(|st| (st.decks[0].gain, st.decks[1].gain)).unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn plays_seeks_loops_and_crossfades_end_to_end() {
        std::env::set_var("ZENITH_AUDIO_SINK", "fake");
        assert!(start(None).is_some());

        run_cmd(Cmd::SetSrc {
            url: url("tone.webm"),
        });
        assert!(wait_ready(5000).await);
        let s = play().await.unwrap();
        assert!(!s.paused);
        assert!((s.d.unwrap() - 3.0).abs() < 0.1, "{:?}", s.d);
        tokio::time::sleep(Duration::from_millis(600)).await;
        let t = snapshot().t;
        assert!(t > 0.35 && t < 0.9, "position moves in real time: {t}");

        run_cmd(Cmd::Pause);
        let a = snapshot().t;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!((snapshot().t - a).abs() < 0.02, "paused position holds");
        play().await.unwrap();

        run_cmd(Cmd::Loop {
            a: Some(1.0),
            b: Some(1.6),
        });
        let mut wraps = 0;
        let mut last = snapshot().t;
        let start_t = Instant::now();
        while wraps < 2 && start_t.elapsed() < Duration::from_secs(5) {
            tokio::time::sleep(Duration::from_millis(30)).await;
            let t = snapshot().t;
            if t + 0.3 < last {
                wraps += 1;
                assert!(t >= 0.95 && t < 1.3, "wrapped to {t}");
            }
            last = t;
        }
        assert_eq!(wraps, 2, "A-B loop wraps twice");
        run_cmd(Cmd::Loop { a: None, b: None });

        run_cmd(Cmd::Rate { r: 2.0 });
        let a = snapshot().t;
        tokio::time::sleep(Duration::from_millis(400)).await;
        let moved = snapshot().t - a;
        assert!(moved > 0.55 && moved < 1.0, "double speed moved {moved}");
        run_cmd(Cmd::Rate { r: 1.0 });

        run_cmd(Cmd::Eq {
            bands: vec![6.0; 15],
            bass: 6.0,
        });
        run_cmd(Cmd::Eq {
            bands: vec![0.0; 15],
            bass: 0.0,
        });

        run_cmd(Cmd::Seek { t: 2.7 });
        let s = until(3.0, |s| s.ended).await;
        assert!(s.ended && s.paused, "track ends after seek near the end");
        assert!(s.t > 2.8, "{}", s.t);

        play().await.unwrap();
        let t = until(1.0, |s| s.t > 0.2).await.t;
        assert!(t < 1.0, "play after end restarts: {t}");

        assert!(preroll(&url("tone.m4a")));
        crossfade(url("tone.m4a"), 0.6).await.unwrap();
        let s = snapshot();
        assert!(s.crossfading && s.src.ends_with("tone.m4a"));
        tokio::time::sleep(Duration::from_millis(250)).await;
        let (g0, g1) = gains();
        assert!(
            g0 > 0.05 && g0 < 0.99 && g1 > 0.05 && g1 < 0.99,
            "mid fade {g0} {g1}"
        );
        let s = until(2.0, |s| !s.crossfading).await;
        assert!(!s.crossfading && !s.paused);
        let (g0, g1) = gains();
        assert!((g0 - 1.0).abs() < 1e-9 || (g1 - 1.0).abs() < 1e-9);
        assert!(with(|st| st.decks[1 - st.active].src.is_empty()).unwrap());

        crossfade(url("tone.webm"), 0.3).await.unwrap();
        let s = until(2.0, |s| !s.crossfading).await;
        assert!(s.src.ends_with("tone.webm") && !s.paused);

        run_cmd(Cmd::SetSrc {
            url: "file:///nope/missing.webm".into(),
        });
        let r = play().await;
        assert!(r.is_err(), "missing file reports an error");

        run_cmd(Cmd::AbortAll);
        let s = snapshot();
        assert!(!s.has_source && s.paused);
    }
}
