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
