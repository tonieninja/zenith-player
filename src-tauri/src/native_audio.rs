//! Native audio engine (Linux): GStreamer playback in the main process instead of two
//! <audio> elements in the web process.
//!
//! Why: the web process can then be destroyed while the window sits in the tray and the
//! music keeps playing (see `headless`). The engine mirrors the semantics of the old
//! `DualAudio` (two decks, equal-power crossfade, master volume, mute, rate) so the
//! frontend keeps its playback logic unchanged; `src/audio/nativeAudio.ts` is the JS side.
//!
//! Events go to the ui as `zaudio` (only for the active deck, like DualAudio). While no
//! main webview exists (`headless`) the engine advances the queue itself from the last
//! plan the ui pushed (`zaudio_plan`), and the state is handed back on restore.

use gst::prelude::*;
use gstreamer as gst;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub t: f64,
    /// NaN in js when None
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
    pb: gst::Element,
    src: String,
    /// html-ish readyState: 0 nothing, 1 metadata, 4 enough data
    ready: u8,
    ended: bool,
    gain: f64,
    want_play: bool,
    buffering: bool,
    pending_seek: Option<f64>,
    errored: bool,
    gen: u64,
    /// position at the last flush/seek, served while the pipeline has no position yet
    last_t: f64,
    /// equalizer-nbands (15 bands) / level inside the deck's audio-filter bin (None if the plugins
    /// are missing: then EQ / normalization just do nothing on this system)
    eq: Option<gst::Element>,
    level: Option<gst::Element>,
    /// loudness normalization: per-track attenuation, measured over the first seconds
    norm: f64,
    loud_sum: f64,
    loud_n: u32,
}

struct State {
    decks: Vec<Deck>,
    active: usize,
    master: f64,
    muted: bool,
    rate: f64,
    fade_token: u64,
    fading: bool,
    norm_on: bool,
    /// equalizer headroom (linear, <= 1) so boosted presets do not clip
    preamp: f64,
}

pub struct Engine {
    st: Mutex<State>,
    app: AppHandle,
}

static ENGINE: OnceLock<Option<Engine>> = OnceLock::new();
static HEADLESS: AtomicBool = AtomicBool::new(false);
static GEN: AtomicU64 = AtomicU64::new(1);

fn engine() -> Option<&'static Engine> {
    ENGINE.get().and_then(|e| e.as_ref())
}

pub fn available() -> bool {
    engine().is_some()
}

fn make_sink() -> Option<gst::Element> {
    match std::env::var("ZENITH_AUDIO_SINK").as_deref() {
        Ok("fake") => gst::ElementFactory::make("fakesink")
            .property("sync", true)
            .build()
            .ok(),
        Ok(name) if !name.is_empty() => gst::ElementFactory::make(name).build().ok(),
        _ => None, // playbin picks autoaudiosink
    }
}

/// ISO 2/3-octave graphic EQ centres; must match EQ_FREQS in src/plugins/equalizer.ts
pub const EQ_FREQS: [f64; 15] = [
    25.0, 40.0, 63.0, 100.0, 160.0, 250.0, 400.0, 630.0, 1000.0, 1600.0, 2500.0, 4000.0, 6300.0,
    10000.0, 16000.0,
];
/// peaking filter Q for 2/3-octave spacing
pub const EQ_Q: f64 = 1.4;

/// attenuation (linear) that keeps a boosted curve from clipping: -max(boost) dB
pub fn eq_preamp(bands: &[f64]) -> f64 {
    let peak = bands.iter().cloned().fold(0.0f64, f64::max).min(12.0);
    10f64.powf(-peak / 20.0)
}

fn setup_eq_bands(eq: &gst::Element) {
    let Some(cp) = eq.dynamic_cast_ref::<gst::ChildProxy>() else {
        return;
    };
    for (k, f) in EQ_FREQS.iter().enumerate() {
        if let Some(b) = cp.child_by_index(k as u32) {
            // the element makes the outer bands shelves by default; a graphic EQ wants
            // the same peaking shape on every band (matches the Web Audio engine)
            b.set_property_from_str("type", "peak");
            b.set_property("freq", *f);
            b.set_property("bandwidth", *f / EQ_Q);
            b.set_property("gain", 0.0f64);
        }
    }
}

fn set_eq_gains(eq: &gst::Element, bands: &[f64]) {
    let Some(cp) = eq.dynamic_cast_ref::<gst::ChildProxy>() else {
        return;
    };
    for k in 0..EQ_FREQS.len() {
        let g = bands.get(k).copied().unwrap_or(0.0).clamp(-24.0, 12.0);
        if let Some(b) = cp.child_by_index(k as u32) {
            b.set_property("gain", g);
        }
    }
}

/// audio-filter for a deck: scaletempo (pitch-correct speed), 15-band equalizer-nbands (flat =
/// passthrough) and level (loudness probe, messages off unless normalization is on)
fn make_filter(
    idx: usize,
) -> (
    Option<gst::Element>,
    Option<gst::Element>,
    Option<gst::Element>,
) {
    let desc = format!(
        "scaletempo ! audioconvert ! equalizer-nbands num-bands=15 name=zeq{idx} ! level name=zlevel{idx} interval=400000000 post-messages=false"
    );
    if let Ok(bin) = gst::parse::bin_from_description(&desc, true) {
        let eq = bin.by_name(&format!("zeq{idx}"));
        if let Some(e) = &eq {
            setup_eq_bands(e);
        }
        let lv = bin.by_name(&format!("zlevel{idx}"));
        return (Some(bin.upcast()), eq, lv);
    }
    (
        gst::ElementFactory::make("scaletempo").build().ok(),
        None,
        None,
    )
}

/// video decoders that playbin plugs for a muxed source: one thread instead of one per core
fn quiet_video_decoder(el: &gst::Element) {
    let Some(f) = el.factory() else { return };
    if !f.has_type(gst::ElementFactoryType::DECODER | gst::ElementFactoryType::MEDIA_VIDEO) {
        return;
    }
    if el.find_property("max-threads").is_some() {
        el.set_property("max-threads", 1i32);
    }
}

fn make_deck(idx: usize) -> Option<gst::Element> {
    let pb = gst::ElementFactory::make("playbin")
        .name(format!("zdeck{idx}"))
        .build()
        .ok()?;
    // audio only: no video / subtitle / visualisation branches get built
    pb.set_property_from_str("flags", "audio+soft-volume");
    if let Some(s) = make_sink() {
        pb.set_property("audio-sink", &s);
    }
    // some tracks only come as a muxed mp4 (itag 18, h264 + aac). playbin2 still decodes
    // the video branch of those and opened a GL sink: ~8 decoder threads and a few % CPU
    // for pictures nobody sees. Send video to a sink that never waits and tell the
    // decoder to use a single thread.
    if let Ok(v) = gst::ElementFactory::make("fakesink")
        .property("sync", false)
        .property("async", false)
        .property("enable-last-sample", false)
        .build()
    {
        pb.set_property("video-sink", &v);
    }
    pb.connect("element-setup", false, |args| {
        if let Some(el) = args.get(1).and_then(|v| v.get::<gst::Element>().ok()) {
            quiet_video_decoder(&el);
        }
        None
    });
    // keep pitch when the playback speed plugin changes the rate (what <audio> does);
    // scaletempo is passthrough at 1.0
    if let (Some(f), _, _) = make_filter(idx) {
        pb.set_property("audio-filter", &f);
    }
    Some(pb)
}

pub fn init(app: &AppHandle) {
    if std::env::var("ZENITH_AUDIO").as_deref() == Ok("web") {
        let _ = ENGINE.set(None);
        return;
    }
    let ok = gst::init().is_ok()
        && gst::ElementFactory::find("playbin").is_some()
        && [
            "souphttpsrc",
            "matroskademux",
            "opusdec",
            "audioconvert",
            "autoaudiosink",
        ]
        .iter()
        .all(|f| gst::ElementFactory::find(f).is_some());
    let decks: Option<Vec<gst::Element>> = if ok {
        (0..2).map(make_deck).collect()
    } else {
        None
    };
    let Some(decks) = decks else {
        eprintln!("[zaudio] gstreamer playbin/souphttpsrc missing, using webview audio");
        let _ = ENGINE.set(None);
        return;
    };
    let st = State {
        decks: decks
            .into_iter()
            .enumerate()
            .map(|(i, pb)| Deck {
                eq: pb
                    .property::<Option<gst::Element>>("audio-filter")
                    .and_then(|f| f.downcast::<gst::Bin>().ok())
                    .and_then(|b| b.by_name(&format!("zeq{i}"))),
                level: pb
                    .property::<Option<gst::Element>>("audio-filter")
                    .and_then(|f| f.downcast::<gst::Bin>().ok())
                    .and_then(|b| b.by_name(&format!("zlevel{i}"))),
                norm: 1.0,
                loud_sum: 0.0,
                loud_n: 0,
                pb,
                src: String::new(),
                ready: 0,
                ended: false,
                gain: 1.0,
                want_play: false,
                buffering: false,
                pending_seek: None,
                errored: false,
                gen: 0,
                last_t: 0.0,
            })
            .collect(),
        active: 0,
        master: 0.8,
        muted: false,
        rate: 1.0,
        fade_token: 0,
        fading: false,
        norm_on: false,
        preamp: 1.0,
    };
    let _ = ENGINE.set(Some(Engine {
        st: Mutex::new(st),
        app: app.clone(),
    }));
    let Some(e) = engine() else { return };
    for i in 0..2 {
        let Some(bus) = e.st.lock().unwrap_or_else(|p| p.into_inner()).decks[i]
            .pb
            .bus()
        else {
            continue;
        };
        std::thread::Builder::new()
            .name(format!("zaudio-bus{i}"))
            .spawn(move || bus_loop(i, bus))
            .ok();
    }
    std::thread::Builder::new()
        .name("zaudio-tick".into())
        .spawn(tick_loop)
        .ok();
}

fn pos_of(d: &Deck) -> f64 {
    if d.ready < 1 {
        return d.pending_seek.unwrap_or(d.last_t);
    }
    if let Some(p) = d.pending_seek {
        return p;
    }
    d.pb.query_position::<gst::ClockTime>()
        .map(|p| p.nseconds() as f64 / 1e9)
        .unwrap_or(d.last_t)
}

fn dur_of(d: &Deck) -> Option<f64> {
    if d.src.is_empty() || d.ready < 1 {
        return None;
    }
    d.pb.query_duration::<gst::ClockTime>()
        .map(|p| p.nseconds() as f64 / 1e9)
        .filter(|v| *v > 0.0)
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
    let _ = e.app.emit("zaudio", Ev { kind, snap });
}

fn apply_volume(st: &State, i: usize) {
    let d = &st.decks[i];
    let v = (st.master * d.gain * d.norm * st.preamp).clamp(0.0, 1.0);
    d.pb.set_property("volume", v);
    d.pb.set_property("mute", st.muted);
}

fn clear_deck(d: &mut Deck) {
    let _ = d.pb.set_state(gst::State::Null);
    d.src.clear();
    d.ready = 0;
    d.ended = false;
    d.want_play = false;
    d.buffering = false;
    d.pending_seek = None;
    d.errored = false;
    d.last_t = 0.0;
    d.gen = GEN.fetch_add(1, Ordering::SeqCst);
}

fn load_deck(d: &mut Deck, url: &str) {
    clear_deck(d);
    d.norm = 1.0;
    d.loud_sum = 0.0;
    d.loud_n = 0;
    d.src = url.to_string();
    d.pb.set_property("uri", url);
    // preroll = preload="auto": fetch + decode the first buffers, ready to start
    let _ = d.pb.set_state(gst::State::Paused);
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
    let pos = gst::ClockTime::from_nseconds((t * 1e9) as u64);
    let _ = d.pb.seek(
        rate,
        gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE,
        gst::SeekType::Set,
        pos,
        gst::SeekType::None,
        gst::ClockTime::NONE,
    );
}

/// loudness normalization (attenuation only, like YouTube's own): the mean power of the
/// first ~12 s of a track above a -50 dBFS gate, target -16 dBFS RMS, at most -10 dB.
/// shared with the web engine (src/audio/webFx.ts uses the same numbers)
const NORM_BLOCKS: u32 = 30;
const NORM_TARGET_DB: f64 = -16.0;
const NORM_MAX_CUT_DB: f64 = -10.0;

/// returns the gain in dB to apply once enough blocks were seen (>= 5, i.e. 2 s)
fn norm_update(sum: &mut f64, n: &mut u32, rms_db: f64) -> Option<f64> {
    if !rms_db.is_finite() || rms_db < -50.0 {
        return None;
    }
    *sum += 10f64.powf(rms_db / 10.0);
    *n += 1;
    if *n < 5 {
        return None;
    }
    let mean_db = 10.0 * (*sum / *n as f64).log10();
    Some((NORM_TARGET_DB - mean_db).clamp(NORM_MAX_CUT_DB, 0.0))
}

fn level_rms_db(s: &gst::StructureRef) -> Option<f64> {
    #[allow(deprecated)]
    let arr = s.get::<gst::glib::ValueArray>("rms").ok()?;
    let mut p = 0.0;
    let mut c = 0.0;
    for v in arr.iter() {
        if let Ok(db) = v.get::<f64>() {
            p += 10f64.powf(db / 10.0);
            c += 1.0;
        }
    }
    (c > 0.0).then(|| 10.0 * (p / c).log10())
}

fn bus_loop(i: usize, bus: gst::Bus) {
    let Some(e) = engine() else { return };
    loop {
        let Some(msg) = bus.timed_pop(gst::ClockTime::from_mseconds(500)) else {
            continue;
        };
        let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
        let is_active = st.active == i;
        let rate = st.rate;
        let mut out: Vec<&'static str> = Vec::new();
        let mut norm_changed = false;
        {
            let d = &mut st.decks[i];
            let from_pb = msg
                .src()
                .map(|s| s == d.pb.upcast_ref::<gst::Object>())
                .unwrap_or(false);
            match msg.view() {
                gst::MessageView::AsyncDone(_) => {
                    if d.ready < 4 && !d.src.is_empty() {
                        d.ready = 4;
                        if let Some(t) = d.pending_seek.take() {
                            if t > 0.05 || rate != 1.0 {
                                d.ready = 1;
                                do_seek(d, t, rate);
                                d.ready = 4;
                            }
                        } else if rate != 1.0 {
                            let t = pos_of(d);
                            do_seek(d, t, rate);
                        }
                        out.extend(["loadedmetadata", "durationchange", "canplay"]);
                        if d.want_play && !d.buffering {
                            let _ = d.pb.set_state(gst::State::Playing);
                        }
                    }
                }
                gst::MessageView::DurationChanged(_) => out.push("durationchange"),
                gst::MessageView::Element(el) => {
                    if let Some(s) = el.structure() {
                        if s.name() == "level" && d.loud_n < NORM_BLOCKS && d.want_play {
                            if let Some(db) = level_rms_db(s) {
                                if let Some(g) = norm_update(&mut d.loud_sum, &mut d.loud_n, db) {
                                    // at most 1 dB per 400 ms step: no audible jump
                                    let cur = 20.0 * d.norm.max(1e-4).log10();
                                    let next = cur + (g - cur).clamp(-1.0, 1.0);
                                    d.norm = 10f64.powf(next / 20.0);
                                    norm_changed = true;
                                }
                            }
                        }
                    }
                }
                gst::MessageView::StateChanged(sc) if from_pb => {
                    if sc.current() == gst::State::Playing && sc.old() != gst::State::Playing {
                        out.push("playing");
                    }
                }
                gst::MessageView::Buffering(b) => {
                    let p = b.percent();
                    if p < 100 && !d.buffering && d.ready >= 4 {
                        d.buffering = true;
                        if d.want_play {
                            let _ = d.pb.set_state(gst::State::Paused);
                        }
                        out.push("waiting");
                    } else if p >= 100 && d.buffering {
                        d.buffering = false;
                        if d.want_play {
                            let _ = d.pb.set_state(gst::State::Playing);
                        }
                        out.push("canplay");
                    }
                }
                gst::MessageView::Eos(_) => {
                    if !d.src.is_empty() && !d.ended {
                        d.last_t = pos_of(d);
                        d.ended = true;
                        d.want_play = false;
                        let _ = d.pb.set_state(gst::State::Paused);
                        out.extend(["timeupdate", "pause", "ended"]);
                    }
                }
                gst::MessageView::Error(err) if !d.src.is_empty() && !d.errored => {
                    eprintln!("[zaudio] deck{i} error: {} {:?}", err.error(), err.debug());
                    d.errored = true;
                    d.want_play = false;
                    out.push("error");
                }
                _ => {}
            }
        }
        if norm_changed && st.norm_on && !st.fading {
            apply_volume(&st, i);
        }
        if out.is_empty() {
            continue;
        }
        let snap = snap_of(&st);
        let ended = out.contains(&"ended");
        drop(st);
        if is_active {
            for k in out {
                if k != "playing" {
                    emit(e, k, snap.clone());
                }
            }
            if ended && HEADLESS.load(Ordering::SeqCst) {
                std::thread::spawn(headless::on_ended);
            }
        }
    }
}

fn tick_loop() {
    let Some(e) = engine() else { return };
    loop {
        // timeupdate is ~4/s in webkit too; nothing runs while paused
        std::thread::sleep(Duration::from_millis(250));
        let st = e.st.lock().unwrap_or_else(|p| p.into_inner());
        let d = &st.decks[st.active];
        if !d.want_play || d.ready < 4 || d.buffering {
            continue;
        }
        let snap = snap_of(&st);
        drop(st);
        emit(e, "timeupdate", snap.clone());
        if HEADLESS.load(Ordering::SeqCst) {
            headless::on_tick(&snap);
        }
    }
}

// Engine ops

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
    /// 15 gains in dB (EQ_FREQS, 25 Hz .. 16 kHz), all 0 = flat
    Eq {
        bands: Vec<f64>,
    },
    Norm {
        on: bool,
    },
    AbortAll,
    ReleaseInactive,
    Load,
}

pub fn run_cmd(cmd: Cmd) -> Snapshot {
    let Some(e) = engine() else {
        return Snapshot::default();
    };
    let mut events: Vec<&'static str> = Vec::new();
    {
        let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
        let a = st.active;
        match cmd {
            Cmd::SetSrc { url } => {
                cancel_fade(&mut st);
                silence_other(&mut st);
                load_deck(&mut st.decks[a], &url);
                apply_volume(&st, a);
            }
            Cmd::ClearSrc => {
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
                    if !d.src.is_empty() {
                        let _ = d.pb.set_state(gst::State::Paused);
                    }
                    events.push("pause");
                }
            }
            Cmd::Seek { t } => {
                let rate = st.rate;
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
                st.rate = r.clamp(0.25, 4.0);
                let rate = st.rate;
                for i in 0..2 {
                    let d = &mut st.decks[i];
                    if d.ready >= 4 {
                        let t = pos_of(d);
                        do_seek(d, t, rate);
                    }
                }
            }
            Cmd::Eq { bands } => {
                for d in st.decks.iter() {
                    if let Some(eq) = &d.eq {
                        set_eq_gains(eq, &bands);
                    }
                }
                st.preamp = if st.decks.iter().any(|d| d.eq.is_some()) {
                    eq_preamp(&bands)
                } else {
                    1.0
                };
                for i in 0..st.decks.len() {
                    apply_volume(&st, i);
                }
            }
            Cmd::Norm { on } => {
                st.norm_on = on;
                for i in 0..2 {
                    if let Some(lv) = &st.decks[i].level {
                        lv.set_property("post-messages", on);
                    }
                    if !on {
                        st.decks[i].norm = 1.0;
                    }
                    if !st.fading {
                        apply_volume(&st, i);
                    }
                }
            }
            Cmd::AbortAll => {
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
            Cmd::Load => {
                let d = &mut st.decks[a];
                if !d.src.is_empty() {
                    let url = d.src.clone();
                    let wp = d.want_play;
                    load_deck(d, &url);
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

/// play the active deck; resolves once audio actually runs (html play() promise)
pub async fn play() -> Result<Snapshot, String> {
    let e = engine().ok_or("no engine")?;
    let gen = {
        let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
        let a = st.active;
        apply_volume(&st, a);
        let d = &mut st.decks[a];
        if d.src.is_empty() {
            return Err("NotSupportedError: no source".into());
        }
        if d.ended {
            // like <audio>: play() after the end starts over
            d.ended = false;
            d.pending_seek = None;
            let rate = st.rate;
            let d = &mut st.decks[a];
            d.ready = 4;
            do_seek(d, 0.0, rate);
        }
        let d = &mut st.decks[a];
        let was = d.want_play;
        d.want_play = true;
        if d.ready >= 4 && !d.buffering {
            let _ = d.pb.set_state(gst::State::Playing);
        }
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

/// wait until the deck carrying `gen` is ready (and playing when `playing`)
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
                let (_, cur, _) = d.pb.state(gst::ClockTime::ZERO);
                if cur == gst::State::Playing || d.buffering {
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

/// equal-power crossfade into `url` (same curve and rules as DualAudio.crossfadeTo)
pub async fn crossfade(url: String, seconds: f64) -> Result<Snapshot, String> {
    let e = engine().ok_or("no engine")?;
    let (token, gen, from_audible) = {
        let mut st = e.st.lock().unwrap_or_else(|p| p.into_inner());
        st.fade_token += 1;
        st.fading = false;
        let token = st.fade_token;
        let a = st.active;
        let o = 1 - a;
        // gapless: the idle deck may already hold this url, prerolled and paused
        let prerolled = st.decks[o].src == url && !st.decks[o].errored && st.decks[o].ready >= 1;
        if !prerolled {
            silence_other(&mut st);
        }
        let from_audible = st.decks[a].want_play && !st.decks[a].src.is_empty();
        if !prerolled {
            load_deck(&mut st.decks[o], &url);
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
        let _ = st.decks[o].pb.set_state(gst::State::Playing);
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

// commands

#[tauri::command]
pub fn zaudio_available() -> bool {
    available()
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

/// load url into the idle deck, paused and silent, so a following crossfade to the same
/// url starts at once (gapless album handoff). Never touches the playing deck.
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
    load_deck(&mut st.decks[o], url);
    st.decks[o].want_play = false;
    st.decks[o].gain = 0.0;
    apply_volume(&st, o);
    true
}

#[tauri::command]
pub async fn zaudio_crossfade(url: String, seconds: f64) -> Result<Snapshot, String> {
    crossfade(url, seconds).await
}

/// the ui's playback plan (queue window, index, loop, crossfade, plugin bits the engine
/// needs while the ui is gone). opaque json for the ui, read by `headless`
#[tauri::command]
pub fn zaudio_plan(plan: Value) {
    headless::set_plan(plan);
}

/// called once by a (re)created main ui: hands over what happened while it was gone
#[tauri::command]
pub fn zaudio_attach(app: AppHandle) -> Value {
    HEADLESS.store(false, Ordering::SeqCst);
    let _ = app;
    headless::take_restore(snapshot())
}

// headless

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
    //! queue advance while the main webview does not exist
    use super::*;

    #[derive(Default)]
    struct H {
        plan: Value,
        /// tracks started while headless (ids + start time), replayed to plugins on restore
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
        crate::stream::get_stream_url(e.app.clone(), id.to_string(), None)
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

    /// start queue[i] (crossfade when `fade` seconds > 0)
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
        // warm the stream cache well before the switch (prefetch, like preload-next)
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

    /// tray menu / media keys while there is no ui
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
        let (cid, track) = h(|h| {
            (
                h.plan["discordClientId"].as_str().map(String::from),
                h.plan["queue"][index(&h.plan)].clone(),
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
            cover_url: track["cover"].as_str().map(String::from),
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
        let dir = e.app.path().app_data_dir().ok()?;
        let _ = std::fs::create_dir_all(&dir);
        Some(dir.join("headless_state.json"))
    }

    /// queue/position on disk, so quitting from the tray while headless still restores
    /// the right track next launch (the ui's localStorage copy is older then)
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
mod fx_tests {
    use super::*;
    use std::sync::Mutex;

    /// equalizer-nbands registers GObject types; parallel tests crash with
    /// "cannot register existing type GstIirEqualizerBand" + SIGSEGV
    static GST_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn with_gst<T>(f: impl FnOnce() -> T) -> T {
        let _g = GST_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _ = gst::init();
        f()
    }

    #[test]
    fn normalization_only_attenuates() {
        let (mut s, mut n) = (0.0, 0);
        for _ in 0..4 {
            assert!(norm_update(&mut s, &mut n, -8.0).is_none());
        }
        let g = norm_update(&mut s, &mut n, -8.0).unwrap();
        assert!((g + 8.0).abs() < 0.01, "{g}");
        let (mut s, mut n) = (0.0, 0);
        let mut g = None;
        for _ in 0..6 {
            g = norm_update(&mut s, &mut n, -30.0);
        }
        assert_eq!(g, Some(0.0), "quiet tracks are never boosted");
        assert!(
            norm_update(&mut s, &mut n, -70.0).is_none(),
            "silence is gated"
        );
    }

    #[test]
    fn deck_is_audio_only() {
        with_gst(|| {
            if gst::ElementFactory::find("playbin").is_none() {
                return;
            }
            let pb = make_deck(9).expect("deck");
            let flags = pb.property_value("flags");
            let s = flags.serialize().map(|g| g.to_string()).unwrap_or_default();
            eprintln!("deck flags = {s}");
            assert!(!s.contains("video"), "{s}");
            let _ = pb.set_state(gst::State::Null);
        });
    }

    #[test]
    fn filter_bin_has_eq_and_level() {
        with_gst(|| {
            let (f, eq, lv) = make_filter(7);
            assert!(f.is_some());
            if gst::ElementFactory::find("equalizer-nbands").is_some() {
                let eq = eq.expect("eq");
                assert_eq!(eq.property::<u32>("num-bands"), 15);
                set_eq_gains(&eq, &[4.0, 5.5, 5.0, 1.8]);
                let cp = eq.dynamic_cast_ref::<gst::ChildProxy>().unwrap();
                let b1 = cp.child_by_index(1).unwrap();
                assert_eq!(b1.property::<f64>("freq"), 40.0);
                assert_eq!(b1.property::<f64>("gain"), 5.5);
                let b0 = cp.child_by_index(0).unwrap();
                let ty = b0
                    .property_value("type")
                    .serialize()
                    .map(|g| g.to_string())
                    .unwrap_or_default();
                assert!(ty.to_lowercase().contains("peak"), "{ty}");
                assert!(lv.is_some());
            }
            if let Some(bin) = f {
                let _ = bin.set_state(gst::State::Null);
            }
            assert!((eq_preamp(&[4.0, 5.5, 0.0]) - 10f64.powf(-5.5 / 20.0)).abs() < 1e-9);
            assert_eq!(eq_preamp(&[-3.0, 0.0]), 1.0);
        });
    }

    /// renders pink noise through the real deck filter (flat vs Bass Boost) and a loud tone
    /// through the level probe; run with `cargo test --release measure_ -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn measure_eq_and_loudness() {
        gst::init().unwrap();
        const BOOST: [f64; 15] = [
            4.0, 5.5, 5.0, 1.8, 0.0, 0.0, 0.8, 0.8, 0.0, 0.0, 0.5, 0.5, 0.5, 0.3, 0.3,
        ];
        fn run(gains: Option<&[f64]>) -> Vec<f64> {
            let pipe = gst::Pipeline::new();
            let src = gst::parse::bin_from_description(
                "audiotestsrc wave=pink-noise num-buffers=400 samplesperbuffer=1024 ! capsfilter caps=audio/x-raw,rate=48000,channels=1",
                true,
            )
            .unwrap();
            let (f, eq, _) = make_filter(9);
            let f = f.unwrap();
            let pre = eq_preamp(gains.unwrap_or(&[]));
            if let (Some(eq), Some(g)) = (eq.as_ref(), gains) {
                set_eq_gains(eq, g);
            }
            let vol = gst::ElementFactory::make("volume")
                .property("volume", pre)
                .build()
                .unwrap();
            let spec = gst::ElementFactory::make("spectrum")
                .property("bands", 4096u32)
                .property("threshold", -120i32)
                .property("post-messages", true)
                .property("interval", 50_000_000u64)
                .build()
                .unwrap();
            let sink = gst::ElementFactory::make("fakesink")
                .property("sync", false)
                .build()
                .unwrap();
            pipe.add_many([src.upcast_ref(), &f, &vol, &spec, &sink])
                .unwrap();
            gst::Element::link_many([src.upcast_ref(), &f, &vol, &spec, &sink]).unwrap();
            pipe.set_state(gst::State::Playing).unwrap();
            let bus = pipe.bus().unwrap();
            let mut acc = vec![0.0f64; 4096];
            let mut n = 0.0f64;
            for msg in bus.iter_timed(gst::ClockTime::from_seconds(30)) {
                match msg.view() {
                    gst::MessageView::Element(e) => {
                        if let Some(st) = e.structure() {
                            if st.name() == "spectrum" {
                                #[allow(deprecated)]
                                if let Ok(arr) = st.get::<gst::List>("magnitude") {
                                    for (i, v) in arr.iter().enumerate() {
                                        acc[i] += 10f64.powf(v.get::<f32>().unwrap() as f64 / 10.0);
                                    }
                                    n += 1.0;
                                }
                            }
                        }
                    }
                    gst::MessageView::Eos(_) | gst::MessageView::Error(_) => break,
                    _ => {}
                }
            }
            pipe.set_state(gst::State::Null).unwrap();
            acc.iter().map(|p| p / n.max(1.0)).collect()
        }
        let band = |v: &[f64], lo: f64, hi: f64| {
            let w = 24000.0 / v.len() as f64;
            let p: f64 = v
                .iter()
                .enumerate()
                .filter(|(i, _)| {
                    let f = (*i as f64 + 0.5) * w;
                    f >= lo && f < hi
                })
                .map(|(_, p)| p)
                .sum();
            10.0 * p.log10()
        };
        let flat = run(None);
        let boost = run(Some(&BOOST));
        for (lo, hi) in [
            (20.0, 50.0),
            (50.0, 80.0),
            (80.0, 130.0),
            (200.0, 500.0),
            (500.0, 2000.0),
            (2000.0, 8000.0),
            (8000.0, 20000.0),
        ] {
            println!(
                "EQ {lo:>6}-{hi:<6} Hz  boost minus flat = {:+.2} dB",
                band(&boost, lo, hi) - band(&flat, lo, hi)
            );
        }
        // loudness: the level probe on a loud and a quiet sine, fed through norm_update
        for (name, amp) in [
            ("loud -3 dBFS sine", 0.708f64),
            ("quiet -26 dBFS sine", 0.05),
        ] {
            let pipe = gst::parse::launch(&format!(
                "audiotestsrc wave=sine freq=440 volume={amp} num-buffers=300 ! capsfilter caps=audio/x-raw,rate=48000,channels=2 ! level name=lv interval=400000000 post-messages=true ! fakesink sync=false"
            )).unwrap();
            pipe.set_state(gst::State::Playing).unwrap();
            let bus = pipe.bus().unwrap();
            let (mut sum, mut cnt, mut gain) = (0.0, 0u32, None);
            for msg in bus.iter_timed(gst::ClockTime::from_seconds(30)) {
                match msg.view() {
                    gst::MessageView::Element(e) => {
                        if let Some(st) = e.structure() {
                            if st.name() == "level" {
                                if let Some(db) = level_rms_db(st) {
                                    if let Some(g) = norm_update(&mut sum, &mut cnt, db) {
                                        gain = Some((db, g));
                                    }
                                }
                            }
                        }
                    }
                    gst::MessageView::Eos(_) | gst::MessageView::Error(_) => break,
                    _ => {}
                }
            }
            pipe.set_state(gst::State::Null).unwrap();
            println!("LOUDNESS {name}: measured rms and applied gain = {gain:?}");
        }
    }
}
