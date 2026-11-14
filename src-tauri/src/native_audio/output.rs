use super::dsp::{Eq, Limiter};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub struct Chunk {
    pub t0: f64,
    pub step: f64,
    pub data: Vec<f32>,
    pub off: usize,
}

#[derive(Default)]
pub struct Queue {
    pub chunks: VecDeque<Chunk>,
    pub frames: usize,
    pub eof: bool,
    pub epoch: u64,
}

impl Queue {
    pub fn flush(&mut self) -> u64 {
        self.chunks.clear();
        self.frames = 0;
        self.eof = false;
        self.epoch += 1;
        self.epoch
    }
}

#[derive(Default)]
pub struct DeckOut {
    pub q: Mutex<Queue>,
    pub playing: AtomicBool,
    gain: AtomicU32,
    pos: AtomicU64,
    pub starved: AtomicBool,
    pub drained: AtomicBool,
}

impl DeckOut {
    pub fn queue(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.q.lock().unwrap_or_else(|p| p.into_inner())
    }
    pub fn set_gain(&self, g: f64) {
        self.gain.store((g as f32).to_bits(), Ordering::Relaxed);
    }
    fn gain(&self) -> f32 {
        f32::from_bits(self.gain.load(Ordering::Relaxed))
    }
    pub fn pos(&self) -> f64 {
        f64::from_bits(self.pos.load(Ordering::Relaxed))
    }
    pub fn set_pos(&self, t: f64) {
        self.pos.store(t.to_bits(), Ordering::Relaxed);
    }
}

pub struct Mixer {
    decks: [Arc<DeckOut>; 2],
    cur: [f32; 2],
    eq: Eq,
    eq_ver: u64,
    lim: Limiter,
    sr: u32,
}

static EQ_BANDS: Mutex<(u64, Vec<f64>, f64)> = Mutex::new((0, Vec::new(), 0.0));
static EQ_VER: AtomicU64 = AtomicU64::new(0);

pub fn set_eq(bands: &[f64], bass: f64) {
    let mut g = EQ_BANDS.lock().unwrap_or_else(|p| p.into_inner());
    g.0 += 1;
    g.1 = bands.to_vec();
    g.2 = bass;
    EQ_VER.store(g.0, Ordering::SeqCst);
}

impl Mixer {
    pub fn new(decks: [Arc<DeckOut>; 2], sr: u32) -> Self {
        Mixer {
            decks,
            cur: [0.0; 2],
            eq: Eq::new(&[], sr as f64),
            eq_ver: 0,
            lim: Limiter::new(sr),
            sr,
        }
    }

    fn sync_eq(&mut self) {
        let v = EQ_VER.load(Ordering::Relaxed);
        if v == self.eq_ver {
            return;
        }
        if let Ok(g) = EQ_BANDS.try_lock() {
            self.eq.set(&g.1, g.2);
            self.eq_ver = g.0;
        }
    }

    pub fn render(&mut self, out: &mut [f32]) -> bool {
        out.fill(0.0);
        self.sync_eq();
        let frames = out.len() / 2;
        let k = 1.0 - (-1.0 / (0.006 * self.sr as f32)).exp();
        let mut any = false;
        for (i, d) in self.decks.iter().enumerate() {
            if !d.playing.load(Ordering::Relaxed) {
                self.cur[i] = 0.0;
                continue;
            }
            any = true;
            let target = d.gain();
            let mut g = self.cur[i];
            let mut q = d.queue();
            let mut n = 0;
            while n < frames {
                let Some(c) = q.chunks.front_mut() else { break };
                let avail = c.data.len() / 2 - c.off;
                let take = avail.min(frames - n);
                for f in 0..take {
                    g += (target - g) * k;
                    let s = (c.off + f) * 2;
                    out[(n + f) * 2] += c.data[s] * g;
                    out[(n + f) * 2 + 1] += c.data[s + 1] * g;
                }
                c.off += take;
                n += take;
                d.set_pos(c.t0 + c.off as f64 * c.step);
                if c.off * 2 >= c.data.len() {
                    q.chunks.pop_front();
                }
            }
            q.frames = q.frames.saturating_sub(n);
            if n < frames {
                if q.eof {
                    d.drained.store(true, Ordering::Relaxed);
                } else {
                    d.starved.store(true, Ordering::Relaxed);
                }
            } else {
                d.starved.store(false, Ordering::Relaxed);
            }
            self.cur[i] = if n > 0 { g } else { self.cur[i] };
        }
        if any {
            self.eq.process(out);
            // limiter działa zawsze, przełączanie dodawałoby i zabierało 5 ms opóźnienia, czyli trzask
            self.lim.process(out);
            for s in out.iter_mut() {
                *s = s.clamp(-1.0, 1.0);
            }
        } else {
            self.lim.reset();
        }
        any
    }
}

enum Msg {
    Wake,
}

struct Out {
    decks: [Arc<DeckOut>; 2],
    sr: AtomicU32,
    tx: Mutex<Sender<Msg>>,
}

static OUT: OnceLock<Out> = OnceLock::new();

pub fn decks() -> Option<[Arc<DeckOut>; 2]> {
    OUT.get().map(|o| o.decks.clone())
}

pub fn sample_rate() -> u32 {
    OUT.get()
        .map(|o| o.sr.load(Ordering::Relaxed))
        .unwrap_or(48000)
}

pub fn wake() {
    if let Some(o) = OUT.get() {
        let _ =
            o.tx.lock()
                .unwrap_or_else(|p| p.into_inner())
                .send(Msg::Wake);
    }
}

fn any_playing(d: &[Arc<DeckOut>; 2]) -> bool {
    d.iter().any(|d| d.playing.load(Ordering::Relaxed))
}

pub fn start() -> bool {
    if OUT.get().is_some() {
        return true;
    }
    let fake = std::env::var("ZENITH_AUDIO_SINK").as_deref() == Ok("fake");
    let sr = if fake {
        48000
    } else {
        match probe_device() {
            Some(sr) => sr,
            None => return false,
        }
    };
    let (tx, rx) = channel::<Msg>();
    let decks = [Arc::new(DeckOut::default()), Arc::new(DeckOut::default())];
    let _ = OUT.set(Out {
        decks: decks.clone(),
        sr: AtomicU32::new(sr),
        tx: Mutex::new(tx),
    });
    std::thread::Builder::new()
        .name("zaudio-out".into())
        .spawn(move || {
            let mut dev: Option<Opened> = None;
            let mut idle_since: Option<Instant> = None;
            loop {
                let playing = any_playing(&decks);
                if playing {
                    idle_since = None;
                    if dev.as_ref().is_some_and(|d| d.broken()) {
                        dev = None;
                    }
                    if dev.is_none() {
                        dev = Device::open(&decks, fake);
                        if let (Some(d), Some(o)) = (&dev, OUT.get()) {
                            o.sr.store(d.sr, Ordering::Relaxed);
                        }
                    }
                } else if dev.is_some() {
                    let since = *idle_since.get_or_insert_with(Instant::now);
                    if since.elapsed() > Duration::from_secs(4) {
                        dev = None;
                        idle_since = None;
                    }
                }
                let wait = if dev.is_some() || playing {
                    Duration::from_millis(if dev.is_none() { 1500 } else { 500 })
                } else {
                    Duration::from_secs(3600)
                };
                match rx.recv_timeout(wait) {
                    Ok(Msg::Wake) | Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        })
        .ok();
    true
}

fn probe_device() -> Option<u32> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let dev = host.default_output_device()?;
    let cfg = dev.default_output_config().ok()?;
    Some(cfg.sample_rate().0)
}

enum Device {
    Real {
        _stream: cpal::Stream,
        broken: Arc<AtomicBool>,
    },
    Fake {
        stop: Arc<AtomicBool>,
    },
}

impl Drop for Device {
    fn drop(&mut self) {
        if let Device::Fake { stop } = self {
            stop.store(true, Ordering::SeqCst);
        }
    }
}

struct Opened {
    dev: Device,
    sr: u32,
}

impl std::ops::Deref for Opened {
    type Target = Device;
    fn deref(&self) -> &Device {
        &self.dev
    }
}

impl Device {
    fn broken(&self) -> bool {
        match self {
            Device::Real { broken, .. } => broken.load(Ordering::Relaxed),
            Device::Fake { .. } => false,
        }
    }

    fn open(decks: &[Arc<DeckOut>; 2], fake: bool) -> Option<Opened> {
        if fake {
            let stop = Arc::new(AtomicBool::new(false));
            let s = stop.clone();
            let mut mixer = Mixer::new(decks.clone(), 48000);
            std::thread::Builder::new()
                .name("zaudio-null".into())
                .spawn(move || {
                    let mut buf = vec![0f32; 480 * 2];
                    let start = Instant::now();
                    let mut done = 0u64;
                    while !s.load(Ordering::SeqCst) {
                        mixer.render(&mut buf);
                        done += 480;
                        let due = start + Duration::from_micros(done * 1_000_000 / 48000);
                        if let Some(w) = due.checked_duration_since(Instant::now()) {
                            std::thread::sleep(w);
                        }
                    }
                })
                .ok()?;
            return Some(Opened {
                dev: Device::Fake { stop },
                sr: 48000,
            });
        }
        open_cpal(decks)
    }
}

fn open_cpal(decks: &[Arc<DeckOut>; 2]) -> Option<Opened> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let host = cpal::default_host();
    let dev = host.default_output_device()?;
    let sup = dev.default_output_config().ok()?;
    let sr = sup.sample_rate().0;
    let ch = sup.channels() as usize;
    let cfg: cpal::StreamConfig = sup.config();
    let broken = Arc::new(AtomicBool::new(false));
    let b = broken.clone();
    let err = move |e: cpal::StreamError| {
        eprintln!("[zaudio] output error: {e}");
        b.store(true, Ordering::Relaxed);
    };
    let mixer = Mixer::new(decks.clone(), sr);
    let stream = match sup.sample_format() {
        cpal::SampleFormat::F32 => build::<f32>(&dev, &cfg, ch, mixer, err),
        cpal::SampleFormat::I16 => build::<i16>(&dev, &cfg, ch, mixer, err),
        cpal::SampleFormat::U16 => build::<u16>(&dev, &cfg, ch, mixer, err),
        cpal::SampleFormat::I32 => build::<i32>(&dev, &cfg, ch, mixer, err),
        other => {
            eprintln!("[zaudio] unsupported sample format {other:?}");
            None
        }
    }?;
    if let Err(e) = stream.play() {
        eprintln!("[zaudio] output play failed: {e}");
        return None;
    }
    Some(Opened {
        dev: Device::Real {
            _stream: stream,
            broken,
        },
        sr,
    })
}

fn build<T>(
    dev: &cpal::Device,
    cfg: &cpal::StreamConfig,
    ch: usize,
    mut mixer: Mixer,
    err: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Option<cpal::Stream>
where
    T: cpal::SizedSample + cpal::FromSample<f32>,
{
    use cpal::traits::DeviceTrait;
    let mut scratch: Vec<f32> = vec![0.0; 4096 * 2];
    dev.build_output_stream(
        cfg,
        move |data: &mut [T], _| {
            let frames = data.len() / ch.max(1);
            if scratch.len() < frames * 2 {
                scratch.resize(frames * 2, 0.0);
            }
            let mix = &mut scratch[..frames * 2];
            mixer.render(mix);
            for (f, out) in data.chunks_exact_mut(ch.max(1)).enumerate() {
                let (l, r) = (mix[f * 2], mix[f * 2 + 1]);
                match ch {
                    1 => out[0] = T::from_sample((l + r) * 0.5),
                    _ => {
                        out[0] = T::from_sample(l);
                        out[1] = T::from_sample(r);
                        for o in out.iter_mut().skip(2) {
                            *o = T::from_sample(0.0);
                        }
                    }
                }
            }
        },
        err,
        None,
    )
    .map_err(|e| eprintln!("[zaudio] output open failed: {e}"))
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deck_with(frames: usize, v: f32) -> Arc<DeckOut> {
        let d = Arc::new(DeckOut::default());
        d.queue().chunks.push_back(Chunk {
            t0: 10.0,
            step: 1.0 / 48000.0,
            data: vec![v; frames * 2],
            off: 0,
        });
        d.queue().frames = frames;
        d
    }

    #[test]
    fn mixes_both_decks_with_ramped_gain() {
        let a = deck_with(48000, 0.5);
        let b = deck_with(48000, 0.5);
        a.set_gain(1.0);
        b.set_gain(0.0);
        a.playing.store(true, Ordering::Relaxed);
        b.playing.store(true, Ordering::Relaxed);
        let mut m = Mixer::new([a.clone(), b.clone()], 48000);
        let mut out = vec![0f32; 4800 * 2];
        m.render(&mut out);
        assert!(out[0] < 0.05, "gain ramps in, no click: {}", out[0]);
        assert!((out[out.len() - 1] - 0.5).abs() < 0.01);
        assert!((a.pos() - 10.1).abs() < 1e-6);
        b.set_gain(1.0);
        m.render(&mut out);
        let ceil = super::super::dsp::LIMIT_CEIL;
        assert!(
            (out[out.len() - 1] - ceil).abs() < 0.01,
            "sum above ceiling is limited"
        );
    }

    #[test]
    fn reports_starve_and_drain() {
        let a = deck_with(100, 0.1);
        a.set_gain(1.0);
        a.playing.store(true, Ordering::Relaxed);
        let mut m = Mixer::new([a.clone(), Arc::new(DeckOut::default())], 48000);
        let mut out = vec![0f32; 480 * 2];
        m.render(&mut out);
        assert!(a.starved.load(Ordering::Relaxed));
        assert!(!a.drained.load(Ordering::Relaxed));
        a.queue().eof = true;
        m.render(&mut out);
        assert!(a.drained.load(Ordering::Relaxed));
    }

    #[test]
    fn paused_deck_keeps_its_queue() {
        let a = deck_with(1000, 0.3);
        a.set_gain(1.0);
        let mut m = Mixer::new([a.clone(), Arc::new(DeckOut::default())], 48000);
        let mut out = vec![1f32; 480 * 2];
        assert!(!m.render(&mut out));
        assert!(out.iter().all(|s| *s == 0.0));
        assert_eq!(a.queue().frames, 1000);
    }
}
