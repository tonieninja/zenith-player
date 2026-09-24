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

use dsp::eq_preamp;

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
    preamp: f64,
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
        preamp: 1.0,
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
        (st.master * st.duck * d.gain * d.norm * st.preamp).clamp(0.0, 1.0)
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
    SetSrc { url: String },
    ClearSrc,
    Pause,
    Seek { t: f64 },
    Volume { v: f64 },
    Muted { m: bool },
    Rate { r: f64 },
    Eq { bands: Vec<f64> },
    Norm { on: bool },
    AbortAll,
    ReleaseInactive,
    Load,
    Loop { a: Option<f64>, b: Option<f64> },
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
            Cmd::Eq { bands } => {
                output::set_eq(&bands);
                st.preamp = eq_preamp(&bands);
                for i in 0..st.decks.len() {
                    apply_volume(&st, i);
                }
            }
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
