use super::dsp::{to_stereo, Loudness, Resampler, Wsola};
use super::output::{Chunk, DeckOut};
use super::source::{Buf, Reader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::Duration;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL, CODEC_TYPE_OPUS};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::{Time, TimeBase};

pub static NORM_ON: AtomicBool = AtomicBool::new(false);
const AHEAD_SECS: f64 = 3.0;
const PREROLL_SECS: f64 = 0.1;

pub enum DecCmd {
    Load {
        buf: Arc<Buf>,
        gen: u64,
        epoch: u64,
        rate: f64,
    },
    Seek {
        t: f64,
        epoch: u64,
        rate: f64,
    },
    Stop,
    Wake,
}

#[derive(Debug)]
pub enum DeckEv {
    Ready(Option<f64>),
    Duration(f64),
    Level(f64),
    Error(String),
}

pub type Sink = fn(usize, u64, DeckEv);

struct Opus(*mut opusic_sys::OpusDecoder);

unsafe impl Send for Opus {}

impl Opus {
    fn new(ch: usize) -> Result<Self, String> {
        let mut err = 0;
        let p = unsafe { opusic_sys::opus_decoder_create(48000, ch as i32, &mut err) };
        if p.is_null() || err != 0 {
            return Err(format!("opus init {err}"));
        }
        Ok(Opus(p))
    }

    fn decode(&mut self, pkt: &[u8], pcm: &mut [f32], ch: usize) -> Result<usize, String> {
        let n = unsafe {
            opusic_sys::opus_decode_float(
                self.0,
                pkt.as_ptr(),
                pkt.len() as i32,
                pcm.as_mut_ptr(),
                (pcm.len() / ch) as i32,
                0,
            )
        };
        if n < 0 {
            return Err(format!("opus {n}"));
        }
        Ok(n as usize)
    }
}

impl Drop for Opus {
    fn drop(&mut self) {
        unsafe { opusic_sys::opus_decoder_destroy(self.0) };
    }
}

enum Dec {
    Sym(Box<dyn symphonia::core::codecs::Decoder>),
    Opus {
        d: Opus,
        ch: usize,
        skip: usize,
        pre: usize,
    },
}

pub struct Session {
    buf: Arc<Buf>,
    gen: u64,
    epoch: u64,
    rate: f64,
    fmt: Box<dyn FormatReader>,
    dec: Dec,
    track: u32,
    tb: TimeBase,
    src_sr: u32,
    out_sr: u32,
    rs: Option<Resampler>,
    ws: Option<Wsola>,
    trim: Option<f64>,
    t_next: f64,
    dur: Option<f64>,
    guessed: bool,
    eof: bool,
    ready: bool,
    loud: Loudness,
    errors: u32,
    stereo: Vec<f32>,
    pcm: Vec<f32>,
    staged: Vec<f32>,
}

fn opus_head(extra: Option<&[u8]>) -> (usize, usize) {
    match extra {
        Some(h) if h.len() >= 12 && &h[..8] == b"OpusHead" => (
            h[9].clamp(1, 2) as usize,
            u16::from_le_bytes([h[10], h[11]]) as usize,
        ),
        _ => (2, 312),
    }
}

fn hint_for(mime: &str) -> Hint {
    let mut h = Hint::new();
    let m = mime.to_ascii_lowercase();
    if m.contains("webm") || m.contains("matroska") {
        h.with_extension("webm");
    } else if m.contains("mp4") || m.contains("m4a") || m.contains("aac") {
        h.with_extension("m4a");
    } else if m.contains("mpeg") || m.contains("mp3") {
        h.with_extension("mp3");
    } else if m.contains("ogg") || m.contains("opus") {
        h.with_extension("ogg");
    } else if m.contains("flac") {
        h.with_extension("flac");
    } else if m.contains("wav") {
        h.with_extension("wav");
    }
    h
}

fn open_format(buf: &Arc<Buf>) -> Result<Box<dyn FormatReader>, String> {
    buf.wait_header()?;
    let mss = MediaSourceStream::new(
        Box::new(Reader::new(buf.clone())),
        MediaSourceStreamOptions::default(),
    );
    let fo = FormatOptions {
        enable_gapless: true,
        ..Default::default()
    };
    symphonia::default::get_probe()
        .format(
            &hint_for(&buf.mime()),
            mss,
            &fo,
            &MetadataOptions::default(),
        )
        .map(|p| p.format)
        .map_err(|e| format!("probe: {e}"))
}

fn make_dec(fmt: &dyn FormatReader) -> Result<(Dec, u32, TimeBase, u32, Option<f64>), String> {
    let t = fmt
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("no audio track")?;
    let p = &t.codec_params;
    let tb = p
        .time_base
        .unwrap_or_else(|| TimeBase::new(1, p.sample_rate.unwrap_or(48000)));
    let dur = p.n_frames.map(|n| {
        let tm = tb.calc_time(n);
        tm.seconds as f64 + tm.frac
    });
    if p.codec == CODEC_TYPE_OPUS {
        let (ch, skip) = opus_head(p.extra_data.as_deref());
        let d = Opus::new(ch)?;
        return Ok((
            Dec::Opus {
                d,
                ch,
                skip,
                pre: skip,
            },
            t.id,
            tb,
            48000,
            dur,
        ));
    }
    let d = symphonia::default::get_codecs()
        .make(p, &DecoderOptions::default())
        .map_err(|e| format!("codec: {e}"))?;
    let sr = p.sample_rate.unwrap_or(44100);
    Ok((Dec::Sym(d), t.id, tb, sr, dur))
}

const TAIL_SPAN: f64 = 25.0;
const TAIL_BLOCK: f64 = 0.1;

pub fn audible_end(buf: Arc<Buf>, d: f64) -> Result<Option<f64>, String> {
    let from = (d - TAIL_SPAN).max(0.0);
    let mut s = Session::open(buf, 0, 0, 1.0, 48000)?;
    if from > 0.0 {
        s.seek(from, 0, 1.0, 48000)?;
    }
    let sr = s.src_sr as f64;
    let per = ((sr * TAIL_BLOCK) as usize).max(1);
    let mut blocks: Vec<(f64, f64)> = Vec::new();
    let (mut acc, mut n, mut start) = (0.0f64, 0usize, None::<f64>);
    let mut skipped = 0u32;
    while let Some(pts) = s.decode_packet()? {
        if pts < 0.0 {
            skipped += 1;
            if skipped > 10_000 {
                break;
            }
            continue;
        }
        for (i, fr) in s.stereo.chunks_exact(2).enumerate() {
            let at = pts + i as f64 / sr;
            if at < from {
                continue;
            }
            let b0 = *start.get_or_insert(at);
            acc += (fr[0] as f64).powi(2) + (fr[1] as f64).powi(2);
            n += 1;
            if n >= per {
                blocks.push((b0, 10.0 * (acc / (2 * n) as f64).max(1e-12).log10()));
                acc = 0.0;
                n = 0;
                start = None;
            }
        }
    }
    Ok(pick_end(&blocks, d))
}

// crossfade startuje tam, gdzie muzyka cichnie, a nie na końcu pliku z ciszą
pub fn pick_end(blocks: &[(f64, f64)], d: f64) -> Option<f64> {
    let peak = blocks.iter().map(|b| b.1).fold(f64::MIN, f64::max);
    if peak < -60.0 {
        return None;
    }
    let floor = (peak - 30.0).max(-50.0);
    let last = blocks.iter().rev().find(|b| b.1 > floor)?;
    let end = (last.0 + TAIL_BLOCK).max(d - 20.0);
    (d - end >= 1.0).then_some(end)
}

impl Session {
    pub fn open(
        buf: Arc<Buf>,
        gen: u64,
        epoch: u64,
        rate: f64,
        out_sr: u32,
    ) -> Result<Self, String> {
        let fmt = open_format(&buf)?;
        let (dec, track, tb, src_sr, dur) = make_dec(fmt.as_ref())?;
        let mut s = Session {
            buf,
            gen,
            epoch,
            rate,
            fmt,
            dec,
            track,
            tb,
            src_sr,
            out_sr,
            rs: None,
            ws: None,
            trim: None,
            t_next: 0.0,
            dur,
            guessed: false,
            eof: false,
            ready: false,
            loud: Loudness::new(src_sr),
            errors: 0,
            stereo: Vec::new(),
            pcm: Vec::new(),
            staged: Vec::new(),
        };
        s.reset_dsp();
        Ok(s)
    }

    fn reset_dsp(&mut self) {
        self.rs = Resampler::new(self.src_sr, self.out_sr);
        self.ws = ((self.rate - 1.0).abs() > 1e-3).then(|| Wsola::new(self.rate, self.out_sr));
        self.loud = Loudness::new(self.src_sr);
    }

    pub fn duration(&self) -> Option<f64> {
        self.dur
    }

    pub fn seek(&mut self, t: f64, epoch: u64, rate: f64, out_sr: u32) -> Result<(), String> {
        self.epoch = epoch;
        self.rate = rate;
        self.out_sr = out_sr;
        self.eof = false;
        self.errors = 0;
        self.fmt = open_format(&self.buf)?;
        let (dec, track, tb, src_sr, dur) = make_dec(self.fmt.as_ref())?;
        if let Dec::Opus { d, ch, pre, .. } = dec {
            self.dec = Dec::Opus {
                d,
                ch,
                skip: if t <= 0.0 { pre } else { 0 },
                pre,
            };
        } else {
            self.dec = dec;
        }
        self.track = track;
        self.tb = tb;
        self.src_sr = src_sr;
        self.dur = dur.or(self.dur);
        let from = (t - PREROLL_SECS).max(0.0);
        if from > 0.0 {
            let to = SeekTo::Time {
                time: Time::from(from),
                track_id: Some(track),
            };
            if let Err(e) = self.fmt.seek(SeekMode::Accurate, to) {
                if !matches!(e, SymError::SeekError(_)) {
                    return Err(format!("seek: {e}"));
                }
                self.eof = true;
            }
        }
        self.trim = (t > 0.0).then_some(t);
        self.t_next = t;
        self.reset_dsp();
        Ok(())
    }

    fn decode_packet(&mut self) -> Result<Option<f64>, String> {
        let pkt = match self.fmt.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                return Ok(None)
            }
            Err(SymError::IoError(e)) if self.buf.cancelled() => return Err(e.to_string()),
            Err(SymError::ResetRequired) => {
                let (dec, ..) = make_dec(self.fmt.as_ref())?;
                self.dec = dec;
                return Ok(Some(-1.0));
            }
            Err(e) => {
                if self.buf.cancelled() {
                    return Err("cancelled".into());
                }
                eprintln!("[zaudio] demux stopped: {e}");
                return Ok(None);
            }
        };
        if pkt.track_id() != self.track {
            return Ok(Some(-1.0));
        }
        let tm = self.tb.calc_time(pkt.ts());
        let pts = tm.seconds as f64 + tm.frac;
        self.stereo.clear();
        match &mut self.dec {
            Dec::Sym(d) => match d.decode(&pkt) {
                Ok(buf) => {
                    let spec = *buf.spec();
                    let ch = spec.channels.count();
                    let mut sb = SampleBuffer::<f32>::new(buf.capacity() as u64, spec);
                    sb.copy_interleaved_ref(buf);
                    to_stereo(sb.samples(), ch, &mut self.stereo);
                    self.errors = 0;
                }
                Err(SymError::DecodeError(_)) => {
                    self.errors += 1;
                    if self.errors > 50 {
                        return Err("too many decode errors".into());
                    }
                    return Ok(Some(-1.0));
                }
                Err(e) => return Err(format!("decode: {e}")),
            },
            Dec::Opus { d, ch, skip, .. } => {
                if self.pcm.len() < 5760 * 2 {
                    self.pcm.resize(5760 * 2, 0.0);
                }
                match d.decode(&pkt.data, &mut self.pcm, *ch) {
                    Ok(n) => {
                        let cut = (*skip).min(n);
                        *skip -= cut;
                        to_stereo(&self.pcm[cut * *ch..n * *ch], *ch, &mut self.stereo);
                        self.errors = 0;
                        return Ok(Some(pts));
                    }
                    Err(e) => {
                        self.errors += 1;
                        if self.errors > 50 {
                            return Err(e);
                        }
                        return Ok(Some(-1.0));
                    }
                }
            }
        }
        Ok(Some(pts))
    }

    pub fn step(&mut self, out: &DeckOut, levels: &mut Vec<f64>) -> Result<bool, String> {
        let Some(pts) = self.decode_packet()? else {
            self.eof = true;
            if self.dur.is_none() {
                self.dur = Some(self.t_next);
                self.guessed = true;
            }
            let mut q = out.queue();
            if q.epoch == self.epoch {
                q.eof = true;
            }
            return Ok(false);
        };
        if pts < 0.0 || self.stereo.is_empty() {
            return Ok(true);
        }
        let mut src: &[f32] = &self.stereo;
        if let Some(t) = self.trim {
            let n = src.len() / 2;
            let end = pts + n as f64 / self.src_sr as f64;
            if end <= t {
                return Ok(true);
            }
            let drop = (((t - pts) * self.src_sr as f64).max(0.0) as usize).min(n);
            src = &src[drop * 2..];
            self.trim = None;
        }
        if NORM_ON.load(Ordering::Relaxed) {
            levels.extend(self.loud.feed(src));
        }
        self.staged.clear();
        let mut tmp = Vec::new();
        let resampled: &[f32] = match self.rs.as_mut() {
            Some(r) => {
                r.process(src, &mut tmp);
                &tmp
            }
            None => src,
        };
        match self.ws.as_mut() {
            Some(w) => w.process(resampled, &mut self.staged),
            None => self.staged.extend_from_slice(resampled),
        }
        let n = self.staged.len() / 2;
        if n == 0 {
            return Ok(true);
        }
        let step = self.rate / self.out_sr as f64;
        let chunk = Chunk {
            t0: self.t_next,
            step,
            data: std::mem::take(&mut self.staged),
            off: 0,
        };
        self.t_next += n as f64 * step;
        let mut q = out.queue();
        if q.epoch == self.epoch {
            q.chunks.push_back(chunk);
            q.frames += n;
        }
        Ok(true)
    }
}

pub fn spawn(i: usize, out: Arc<DeckOut>, sink: Sink) -> Sender<DecCmd> {
    let (tx, rx) = channel();
    std::thread::Builder::new()
        .name(format!("zaudio-dec{i}"))
        .spawn(move || worker(i, out, rx, sink))
        .ok();
    tx
}

fn worker(i: usize, out: Arc<DeckOut>, rx: Receiver<DecCmd>, sink: Sink) {
    let mut s: Option<Session> = None;
    let mut levels = Vec::new();
    loop {
        let full = s
            .as_ref()
            .is_none_or(|s| s.eof || out.queue().frames as f64 >= AHEAD_SECS * s.out_sr as f64);
        let cmd = if !full {
            match rx.try_recv() {
                Ok(c) => Some(c),
                Err(std::sync::mpsc::TryRecvError::Empty) => None,
                Err(_) => return,
            }
        } else if s.as_ref().is_some_and(|s| !s.eof) && out.playing.load(Ordering::Relaxed) {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(c) => Some(c),
                Err(RecvTimeoutError::Timeout) => None,
                Err(_) => return,
            }
        } else {
            match rx.recv() {
                Ok(c) => Some(c),
                Err(_) => return,
            }
        };
        match cmd {
            Some(DecCmd::Load {
                buf,
                gen,
                epoch,
                rate,
            }) => {
                s = None;
                match Session::open(buf.clone(), gen, epoch, rate, super::output::sample_rate()) {
                    Ok(n) => s = Some(n),
                    Err(e) => {
                        if !buf.cancelled() {
                            eprintln!("[zaudio] deck{i} open failed: {e}");
                            sink(i, gen, DeckEv::Error(e));
                        }
                    }
                }
                continue;
            }
            Some(DecCmd::Seek { t, epoch, rate }) => {
                if let Some(cur) = s.as_mut() {
                    let started = std::time::Instant::now();
                    if let Err(e) = cur.seek(t, epoch, rate, super::output::sample_rate()) {
                        if !cur.buf.cancelled() {
                            sink(i, cur.gen, DeckEv::Error(e));
                        }
                        s = None;
                    } else if crate::debug_log_enabled() {
                        eprintln!("[zaudio] deck{i} seek {t:.2} took {:?}", started.elapsed());
                    }
                }
                continue;
            }
            Some(DecCmd::Stop) => {
                s = None;
                continue;
            }
            Some(DecCmd::Wake) => continue,
            None => {}
        }
        let Some(cur) = s.as_mut() else { continue };
        if cur.eof {
            continue;
        }
        let res = cur.step(&out, &mut levels);
        let gen = cur.gen;
        for db in levels.drain(..) {
            sink(i, gen, DeckEv::Level(db));
        }
        match res {
            Ok(more) => {
                let queued = out.queue().frames;
                if !cur.ready && (queued > 0 || !more) {
                    cur.ready = true;
                    sink(i, gen, DeckEv::Ready(cur.duration()));
                }
                if !more && cur.guessed {
                    if let Some(d) = cur.duration() {
                        sink(i, gen, DeckEv::Duration(d));
                    }
                }
            }
            Err(e) => {
                if !cur.buf.cancelled() {
                    eprintln!("[zaudio] deck{i} decode failed: {e}");
                    sink(i, gen, DeckEv::Error(e));
                }
                s = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Arc<Buf> {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        let mime = if name.ends_with(".webm") {
            "audio/webm"
        } else {
            "audio/mp4"
        };
        Buf::from_bytes(std::fs::read(p).unwrap(), mime)
    }

    fn drain(s: &mut Session, out: &DeckOut) -> Vec<f32> {
        let mut lv = Vec::new();
        while s.step(out, &mut lv).unwrap() {}
        let mut v = Vec::new();
        for c in out.queue().chunks.iter() {
            v.extend_from_slice(&c.data);
        }
        v
    }

    fn tone_hz(v: &[f32], sr: f64) -> f64 {
        let mono: Vec<f32> = v.iter().step_by(2).cloned().collect();
        let zc = mono
            .windows(2)
            .filter(|w| w[0] < 0.0 && w[1] >= 0.0)
            .count() as f64;
        zc / (mono.len() as f64 / sr)
    }

    fn rms_db(v: &[f32]) -> f64 {
        let p = v.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / v.len() as f64;
        10.0 * p.log10()
    }

    #[test]
    fn decodes_opus_webm_and_aac_mp4() {
        for name in ["tone.webm", "tone.m4a"] {
            let out = DeckOut::default();
            let mut s = Session::open(fixture(name), 1, 0, 1.0, 48000).unwrap();
            let d = s.duration().unwrap_or(0.0);
            let v = drain(&mut s, &out);
            let secs = v.len() as f64 / 2.0 / 48000.0;
            assert!((secs - 3.0).abs() < 0.1, "{name}: {secs}s");
            assert!(d == 0.0 || (d - 3.0).abs() < 0.1, "{name}: dur {d}");
            let mid = &v[48000..48000 * 4];
            let hz = tone_hz(mid, 48000.0);
            assert!((hz - 1000.0).abs() < 10.0, "{name}: {hz} Hz");
            let db = rms_db(mid);
            assert!((db + 30.1).abs() < 0.5, "{name}: {db} dB");
            assert!(out.queue().eof);
        }
    }

    #[test]
    fn seek_lands_on_the_right_time() {
        for name in ["tone.webm", "tone.m4a"] {
            let out = DeckOut::default();
            let mut s = Session::open(fixture(name), 1, 0, 1.0, 48000).unwrap();
            let epoch = out.queue().flush();
            s.seek(2.0, epoch, 1.0, 48000).unwrap();
            let v = drain(&mut s, &out);
            let secs = v.len() as f64 / 2.0 / 48000.0;
            assert!((secs - 1.0).abs() < 0.1, "{name}: {secs}s left after seek");
            assert!((out.queue().chunks[0].t0 - 2.0).abs() < 1e-6);
            let epoch = out.queue().flush();
            s.seek(0.5, epoch, 1.0, 48000).unwrap();
            let v = drain(&mut s, &out);
            let secs = v.len() as f64 / 2.0 / 48000.0;
            assert!(
                (secs - 2.5).abs() < 0.1,
                "{name}: {secs}s after seeking back"
            );
        }
    }

    #[test]
    fn speed_keeps_pitch_and_time() {
        let out = DeckOut::default();
        let mut s = Session::open(fixture("tone.webm"), 1, 0, 1.5, 48000).unwrap();
        let v = drain(&mut s, &out);
        let secs = v.len() as f64 / 2.0 / 48000.0;
        assert!((secs - 2.0).abs() < 0.12, "{secs}");
        let hz = tone_hz(&v[24000..v.len() - 24000], 48000.0);
        assert!((hz - 1000.0).abs() < 15.0, "{hz}");
        let q = out.queue();
        let last = q.chunks.back().unwrap();
        let end = last.t0 + (last.data.len() / 2) as f64 * last.step;
        assert!((end - 3.0).abs() < 0.1, "{end}");
    }

    #[test]
    fn stale_epoch_chunks_are_dropped() {
        let out = DeckOut::default();
        let mut s = Session::open(fixture("tone.webm"), 1, 0, 1.0, 48000).unwrap();
        out.queue().flush();
        let mut lv = Vec::new();
        for _ in 0..20 {
            s.step(&out, &mut lv).unwrap();
        }
        assert_eq!(out.queue().frames, 0);
    }

    #[test]
    fn tail_end_skips_fade_and_silence() {
        let mut b: Vec<(f64, f64)> = (0..250).map(|i| (200.0 + i as f64 * 0.1, -14.0)).collect();
        for (k, x) in b.iter_mut().enumerate().skip(150) {
            x.1 = -14.0 - (k - 150) as f64 * 1.5;
        }
        let end = pick_end(&b, 225.0).unwrap();
        assert!((end - 217.0).abs() < 0.05, "{end}");
        let flat: Vec<(f64, f64)> = (0..250).map(|i| (200.0 + i as f64 * 0.1, -14.0)).collect();
        assert_eq!(pick_end(&flat, 225.0), None);
        let quiet: Vec<(f64, f64)> = (0..250).map(|i| (200.0 + i as f64 * 0.1, -80.0)).collect();
        assert_eq!(pick_end(&quiet, 225.0), None);
    }

    #[test]
    fn loudness_levels_come_out_when_normalizing() {
        NORM_ON.store(true, Ordering::SeqCst);
        let out = DeckOut::default();
        let mut s = Session::open(fixture("tone.m4a"), 1, 0, 1.0, 48000).unwrap();
        let mut lv = Vec::new();
        while s.step(&out, &mut lv).unwrap() {}
        NORM_ON.store(false, Ordering::SeqCst);
        assert!(lv.len() >= 6, "{}", lv.len());
        assert!((lv[3] + 30.1).abs() < 0.5, "{}", lv[3]);
    }
}
