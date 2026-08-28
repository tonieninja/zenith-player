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
