use std::f64::consts::PI;

pub const EQ_FREQS: [f64; 15] = [
    25.0, 40.0, 63.0, 100.0, 160.0, 250.0, 400.0, 630.0, 1000.0, 1600.0, 2500.0, 4000.0, 6300.0,
    10000.0, 16000.0,
];
pub const EQ_Q: f64 = 1.4;
pub const BASS_HZ: f64 = 90.0;
// S=1, najstromsza półka bez przerzutu, więc bas rośnie bez dudnienia
const SHELF_Q: f64 = 0.707;
// poniżej 22 Hz nikt nie słyszy, a te częstotliwości zjadają zapas przed limiterem
const HPF_HZ: f64 = 22.0;
const STAGES: usize = EQ_FREQS.len() + 1;
const GLIDE_FRAMES: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Coefs {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

const UNITY: Coefs = Coefs {
    b0: 1.0,
    b1: 0.0,
    b2: 0.0,
    a1: 0.0,
    a2: 0.0,
};

fn biquad(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Coefs {
    Coefs {
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: a1 / a0,
        a2: a2 / a0,
    }
}

pub fn peaking(freq: f64, q: f64, gain_db: f64, sr: f64) -> Coefs {
    if gain_db.abs() < 0.01 || freq >= sr * 0.47 {
        return UNITY;
    }
    let a = 10f64.powf(gain_db / 40.0);
    let (s, c) = (2.0 * PI * freq / sr).sin_cos();
    let al = s / (2.0 * q);
    biquad(
        1.0 + al * a,
        -2.0 * c,
        1.0 - al * a,
        1.0 + al / a,
        -2.0 * c,
        1.0 - al / a,
    )
}

pub fn low_shelf(freq: f64, q: f64, gain_db: f64, sr: f64) -> Coefs {
    if gain_db.abs() < 0.01 {
        return UNITY;
    }
    let a = 10f64.powf(gain_db / 40.0);
    let (s, c) = (2.0 * PI * freq / sr).sin_cos();
    let k = 2.0 * a.sqrt() * s / (2.0 * q);
    biquad(
        a * ((a + 1.0) - (a - 1.0) * c + k),
        2.0 * a * ((a - 1.0) - (a + 1.0) * c),
        a * ((a + 1.0) - (a - 1.0) * c - k),
        (a + 1.0) + (a - 1.0) * c + k,
        -2.0 * ((a - 1.0) + (a + 1.0) * c),
        (a + 1.0) + (a - 1.0) * c - k,
    )
}

pub fn high_pass(freq: f64, q: f64, sr: f64) -> Coefs {
    let (s, c) = (2.0 * PI * freq / sr).sin_cos();
    let al = s / (2.0 * q);
    biquad(
        (1.0 + c) / 2.0,
        -(1.0 + c),
        (1.0 + c) / 2.0,
        1.0 + al,
        -2.0 * c,
        1.0 - al,
    )
}

fn stage(k: usize, gain_db: f64, sr: f64) -> Coefs {
    if k < EQ_FREQS.len() {
        peaking(EQ_FREQS[k], EQ_Q, gain_db, sr)
    } else {
        low_shelf(BASS_HZ, SHELF_Q, gain_db, sr)
    }
}

// filtry żyją cały czas, a wzmocnienia dojeżdżają do celu w ~30 ms, więc suwak nie trzeszczy
#[derive(Clone)]
pub struct Eq {
    sr: f64,
    target: [f64; STAGES],
    cur: [f64; STAGES],
    coefs: [Coefs; STAGES],
    hp: Coefs,
    z: [[[f64; 4]; 2]; STAGES + 1],
    tick: usize,
}

impl Eq {
    pub fn new(bands: &[f64], sr: f64) -> Self {
        let mut eq = Eq {
            sr,
            target: [0.0; STAGES],
            cur: [0.0; STAGES],
            coefs: [UNITY; STAGES],
            hp: high_pass(HPF_HZ, SHELF_Q, sr),
            z: [[[0.0; 4]; 2]; STAGES + 1],
            tick: 0,
        };
        eq.set(bands, 0.0);
        eq.cur = eq.target;
        for k in 0..STAGES {
            eq.coefs[k] = stage(k, eq.cur[k], sr);
        }
        eq
    }

    pub fn set(&mut self, bands: &[f64], bass: f64) {
        for k in 0..EQ_FREQS.len() {
            self.target[k] = bands.get(k).copied().unwrap_or(0.0).clamp(-24.0, 12.0);
        }
        self.target[STAGES - 1] = bass.clamp(0.0, 12.0);
    }

    pub fn is_flat(&self) -> bool {
        self.target.iter().chain(&self.cur).all(|g| g.abs() < 0.01)
    }

    fn glide(&mut self) {
        let k = 1.0 - (-(GLIDE_FRAMES as f64) / (0.03 * self.sr)).exp();
        for i in 0..STAGES {
            let d = self.target[i] - self.cur[i];
            if d == 0.0 {
                continue;
            }
            self.cur[i] = if d.abs() < 0.01 {
                self.target[i]
            } else {
                self.cur[i] + d * k
            };
            self.coefs[i] = stage(i, self.cur[i], self.sr);
        }
    }

    pub fn process(&mut self, stereo: &mut [f32]) {
        if self.is_flat() {
            self.z = [[[0.0; 4]; 2]; STAGES + 1];
            return;
        }
        for fr in stereo.chunks_exact_mut(2) {
            if self.tick == 0 {
                self.glide();
            }
            self.tick = (self.tick + 1) % GLIDE_FRAMES;
            for (ch, v) in fr.iter_mut().enumerate() {
                let mut x = *v as f64;
                for (c, z) in std::iter::once(&self.hp)
                    .chain(self.coefs.iter())
                    .zip(self.z.iter_mut())
                {
                    let s = &mut z[ch];
                    let y = c.b0 * x + c.b1 * s[0] + c.b2 * s[1] - c.a1 * s[2] - c.a2 * s[3];
                    s[1] = s[0];
                    s[0] = x;
                    s[3] = s[2];
                    s[2] = if y.abs() < 1e-30 { 0.0 } else { y };
                    x = y;
                }
                *v = x as f32;
            }
        }
    }
}

// -0.5 dBFS zostawia miejsce na szczyty między próbkami po przetworniku
pub const LIMIT_CEIL: f32 = 0.944;

// zamiast przyciszać cały miks o największe podbicie EQ, ścinamy tylko szczyty;
// 5 ms wyprzedzenia i 150 ms powrotu, żeby nie modulować pojedynczych okresów basu
pub struct Limiter {
    sr: u32,
    delay: Vec<[f32; 2]>,
    need: Vec<f32>,
    held: Vec<f32>,
    sum: f64,
    i: usize,
    j: usize,
    gain: f32,
    rel: f32,
}

impl Limiter {
    pub fn new(sr: u32) -> Self {
        let n = (sr as usize / 200).max(8);
        Limiter {
            sr,
            delay: vec![[0.0; 2]; n - 1],
            need: vec![1.0; n],
            held: vec![1.0; n],
            sum: n as f64,
            i: 0,
            j: 0,
            gain: 1.0,
            rel: 1.0 - (-1.0 / (0.15 * sr as f32)).exp(),
        }
    }

    pub fn reset(&mut self) {
        *self = Limiter::new(self.sr);
    }

    pub fn process(&mut self, stereo: &mut [f32]) {
        let n = self.need.len();
        for fr in stereo.chunks_exact_mut(2) {
            let peak = fr[0].abs().max(fr[1].abs());
            self.need[self.i] = if peak > LIMIT_CEIL {
                LIMIT_CEIL / peak
            } else {
                1.0
            };
            // liniowe minimum z 240 wartości na ramkę wystarcza; kolejka monotoniczna, jeśli wyjdzie w profilerze
            let h = self.need.iter().copied().fold(1.0f32, f32::min);
            self.sum += h as f64 - self.held[self.i] as f64;
            self.held[self.i] = h;
            self.i = (self.i + 1) % n;
            let smooth = (self.sum / n as f64) as f32;
            self.gain = if smooth < self.gain {
                smooth
            } else {
                self.gain + (smooth - self.gain) * self.rel
            };
            let out = std::mem::replace(&mut self.delay[self.j], [fr[0], fr[1]]);
            self.j = (self.j + 1) % self.delay.len();
            fr[0] = out[0] * self.gain;
            fr[1] = out[1] * self.gain;
        }
    }
}

const TAPS: usize = 32;
const PHASES: usize = 256;

pub struct Resampler {
    step: f64,
    table: Vec<f32>,
    buf: Vec<f32>,
    pos: f64,
}

fn bessel_i0(x: f64) -> f64 {
    let mut s = 1.0;
    let mut t = 1.0;
    for k in 1..30 {
        t *= (x / (2.0 * k as f64)).powi(2);
        s += t;
    }
    s
}

impl Resampler {
    pub fn new(from: u32, to: u32) -> Option<Self> {
        if from == to || from == 0 || to == 0 {
            return None;
        }
        let ratio = to as f64 / from as f64;
        let cutoff = ratio.min(1.0) * 0.93;
        let beta = 8.0;
        let half = (TAPS / 2) as f64;
        let mut table = vec![0f32; (PHASES + 1) * TAPS];
        for p in 0..=PHASES {
            let frac = p as f64 / PHASES as f64;
            let mut sum = 0.0;
            let row: Vec<f64> = (0..TAPS)
                .map(|k| {
                    let x = k as f64 - (half - 1.0) - frac;
                    let sinc = if x.abs() < 1e-9 {
                        1.0
                    } else {
                        (PI * x * cutoff).sin() / (PI * x)
                    };
                    let r = x / half;
                    let w = if r.abs() >= 1.0 {
                        0.0
                    } else {
                        bessel_i0(beta * (1.0 - r * r).sqrt()) / bessel_i0(beta)
                    };
                    let v = sinc * w;
                    sum += v;
                    v
                })
                .collect();
            for (k, v) in row.into_iter().enumerate() {
                table[p * TAPS + k] = (v / sum) as f32;
            }
        }
        Some(Resampler {
            step: from as f64 / to as f64,
            table,
            buf: vec![0.0; TAPS * 2],
            pos: (TAPS / 2 - 1) as f64,
        })
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        self.buf.extend_from_slice(input);
        let frames = self.buf.len() / 2;
        while (self.pos as usize) + TAPS / 2 + 1 < frames {
            let ip = self.pos.floor();
            let frac = (self.pos - ip) * PHASES as f64;
            let p0 = frac.floor() as usize;
            let t = (frac - p0 as f64) as f32;
            let start = ip as usize + 1 - TAPS / 2;
            let r0 = &self.table[p0 * TAPS..p0 * TAPS + TAPS];
            let r1 = &self.table[(p0 + 1) * TAPS..(p0 + 1) * TAPS + TAPS];
            let (mut l, mut r) = (0f32, 0f32);
            for k in 0..TAPS {
                let w = r0[k] + (r1[k] - r0[k]) * t;
                let i = (start + k) * 2;
                l += self.buf[i] * w;
                r += self.buf[i + 1] * w;
            }
            out.push(l);
            out.push(r);
            self.pos += self.step;
        }
        let keep_from = (self.pos as usize).saturating_sub(TAPS);
        if keep_from > 0 {
            self.buf.drain(..keep_from * 2);
            self.pos -= keep_from as f64;
        }
    }
}

pub struct Wsola {
    rate: f64,
    ov: usize,
    delta: usize,
    buf: Vec<f32>,
    nominal: f64,
    prev: Vec<f32>,
    natural: usize,
    started: bool,
}

impl Wsola {
    pub fn new(rate: f64, sr: u32) -> Self {
        let ov = (sr as usize * 20 / 1000).max(64);
        Wsola {
            rate,
            ov,
            delta: (sr as usize * 10 / 1000).max(16),
            buf: Vec::new(),
            nominal: 0.0,
            prev: vec![0.0; ov * 2],
            natural: 0,
            started: false,
        }
    }

    fn best(&self, target: usize) -> usize {
        let ov = self.ov;
        let lo = target.saturating_sub(self.delta);
        let hi = target + self.delta;
        let nat = self.natural;
        let score = |k: usize, stride: usize| -> f32 {
            let mut s = 0f32;
            let mut e = 1e-9f32;
            let mut i = 0;
            while i < ov {
                let a = self.buf[(k + i) * 2] + self.buf[(k + i) * 2 + 1];
                let b = self.buf[(nat + i) * 2] + self.buf[(nat + i) * 2 + 1];
                s += a * b;
                e += a * a;
                i += stride;
            }
            s / e.sqrt()
        };
        let mut best = target;
        let mut bs = f32::MIN;
        let mut k = lo;
        while k <= hi {
            let v = score(k, 4);
            if v > bs {
                bs = v;
                best = k;
            }
            k += 4;
        }
        let (a, b) = (best.saturating_sub(3).max(lo), (best + 3).min(hi));
        for k in a..=b {
            let v = score(k, 1);
            if v > bs {
                bs = v;
                best = k;
            }
        }
        best
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        self.buf.extend_from_slice(input);
        let ov = self.ov;
        loop {
            let frames = self.buf.len() / 2;
            let target = self.nominal.round() as usize;
            if target + self.delta + 2 * ov >= frames || self.natural + ov >= frames {
                break;
            }
            let k = if self.started {
                self.best(target)
            } else {
                target
            };
            for i in 0..ov {
                let w = 0.5 - 0.5 * (PI as f32 * i as f32 / ov as f32).cos();
                for ch in 0..2 {
                    let p = if self.started {
                        self.prev[i * 2 + ch]
                    } else {
                        0.0
                    };
                    let n = self.buf[(k + i) * 2 + ch];
                    out.push(if self.started {
                        p * (1.0 - w) + n * w
                    } else {
                        n
                    });
                }
            }
            self.prev
                .copy_from_slice(&self.buf[(k + ov) * 2..(k + 2 * ov) * 2]);
            self.started = true;
            self.natural = k + ov;
            self.nominal += ov as f64 * self.rate;
            let drop = self
                .natural
                .min(self.nominal.floor() as usize)
                .saturating_sub(self.delta + 1);
            if drop > 0 {
                self.buf.drain(..drop * 2);
                self.natural -= drop;
                self.nominal -= drop as f64;
            }
        }
    }
}

pub struct Loudness {
    sum: f64,
    n: usize,
    block: usize,
}

impl Loudness {
    pub fn new(sr: u32) -> Self {
        Loudness {
            sum: 0.0,
            n: 0,
            block: (sr as usize * 2 / 5).max(1),
        }
    }

    pub fn feed(&mut self, stereo: &[f32]) -> Vec<f64> {
        let mut out = Vec::new();
        for fr in stereo.chunks_exact(2) {
            self.sum += (fr[0] as f64).powi(2) + (fr[1] as f64).powi(2);
            self.n += 1;
            if self.n >= self.block {
                let p = self.sum / (2 * self.n) as f64;
                out.push(10.0 * p.max(1e-12).log10());
                self.sum = 0.0;
                self.n = 0;
            }
        }
        out
    }
}

pub const NORM_BLOCKS: u32 = 30;
const NORM_TARGET_DB: f64 = -16.0;
const NORM_MAX_CUT_DB: f64 = -10.0;

pub fn norm_update(sum: &mut f64, n: &mut u32, rms_db: f64) -> Option<f64> {
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

pub fn to_stereo(src: &[f32], ch: usize, out: &mut Vec<f32>) {
    match ch {
        0 => {}
        1 => {
            for s in src {
                out.push(*s);
                out.push(*s);
            }
        }
        2 => out.extend_from_slice(src),
        _ => {
            for fr in src.chunks_exact(ch) {
                out.push(fr[0]);
                out.push(fr[1]);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, sr: u32, secs: f64, amp: f32) -> Vec<f32> {
        let n = (sr as f64 * secs) as usize;
        let mut v = Vec::with_capacity(n * 2);
        for i in 0..n {
            let s = amp * (2.0 * PI * freq * i as f64 / sr as f64).sin() as f32;
            v.push(s);
            v.push(s);
        }
        v
    }

    fn rms(v: &[f32]) -> f64 {
        (v.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / v.len().max(1) as f64).sqrt()
    }

    fn db(a: f64, b: f64) -> f64 {
        20.0 * (a / b).log10()
    }

    #[test]
    fn flat_eq_is_bypassed() {
        assert!(Eq::new(&[0.0; 15], 48000.0).is_flat());
        assert!(Eq::new(&[], 48000.0).is_flat());
        assert!(!Eq::new(&[3.0], 48000.0).is_flat());
    }

    #[test]
    fn eq_band_boosts_its_frequency_only() {
        let mut bands = [0.0; 15];
        bands[8] = 6.0;
        for sr in [44100u32, 48000] {
            let mut eq = Eq::new(&bands, sr as f64);
            let mut at = sine(1000.0, sr, 1.0, 0.25);
            eq.process(&mut at);
            let g = db(rms(&at[sr as usize..]), rms(&sine(1000.0, sr, 0.5, 0.25)));
            assert!((g - 6.0).abs() < 0.3, "{g}");
            let mut eq = Eq::new(&bands, sr as f64);
            let mut far = sine(100.0, sr, 1.0, 0.25);
            eq.process(&mut far);
            let g = db(rms(&far[sr as usize..]), rms(&sine(100.0, sr, 0.5, 0.25)));
            assert!(g.abs() < 0.3, "{g}");
        }
    }

    #[test]
    fn eq_cut_and_top_band_stay_stable() {
        let mut bands = [0.0; 15];
        bands[0] = -24.0;
        bands[14] = 12.0;
        let mut eq = Eq::new(&bands, 44100.0);
        let mut v = sine(25.0, 44100, 2.0, 0.5);
        eq.process(&mut v);
        let g = db(rms(&v[44100..]), rms(&sine(25.0, 44100, 1.0, 0.5)));
        assert!(g < -18.0, "{g}");
        assert!(v.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn bass_shelf_is_strong_and_stays_low() {
        let sr = 48000u32;
        let gain = |freq: f64| {
            let mut eq = Eq::new(&[0.0; 15], sr as f64);
            eq.set(&[0.0; 15], 9.0);
            let mut v = sine(freq, sr, 2.0, 0.1);
            eq.process(&mut v);
            db(rms(&v[sr as usize * 2..]), rms(&sine(freq, sr, 1.0, 0.1)))
        };
        let low = gain(45.0);
        assert!((low - 8.5).abs() < 1.0, "{low}");
        let mid = gain(1000.0);
        assert!(mid.abs() < 0.3, "{mid}");
        let sub = gain(10.0);
        assert!(
            sub < low - 12.0,
            "sub rumble stays far below the boosted bass: {sub}"
        );
    }

    #[test]
    fn eq_change_glides_without_clicks() {
        let sr = 48000u32;
        let src = sine(200.0, sr, 0.5, 0.3);
        let max_step = |v: &[f32]| {
            v.chunks_exact(2)
                .map(|f| f[0])
                .collect::<Vec<_>>()
                .windows(2)
                .map(|w| (w[1] - w[0]).abs())
                .fold(0.0f32, f32::max)
        };
        let mut eq = Eq::new(&[0.0; 15], sr as f64);
        eq.set(&[0.0; 15], 1.0);
        let mut v = src.clone();
        let half = v.len() / 2;
        eq.process(&mut v[..half]);
        eq.set(&[0.0; 15], 9.0);
        eq.process(&mut v[half..]);
        // +9 dB na 200 Hz to ok. 1.6x amplitudy, skok ponad to byłby trzaskiem
        assert!(
            max_step(&v) < max_step(&src) * 2.2,
            "{} vs {}",
            max_step(&v),
            max_step(&src)
        );
    }

    #[test]
    fn limiter_holds_ceiling_and_leaves_quiet_audio_alone() {
        let mut l = Limiter::new(48000);
        let src = sine(1000.0, 48000, 0.5, 0.5);
        let mut v = src.clone();
        l.process(&mut v);
        let lag = (48000 / 200 - 1) * 2;
        assert!(v[lag..].iter().zip(&src).all(|(a, b)| (a - b).abs() < 1e-6));
        let mut l = Limiter::new(48000);
        let mut loud = sine(60.0, 48000, 1.0, 2.0);
        l.process(&mut loud);
        assert!(loud.iter().all(|x| x.abs() <= LIMIT_CEIL + 1e-5));
        let g = db(
            rms(&loud[48000..]),
            rms(&sine(60.0, 48000, 0.5, LIMIT_CEIL)),
        );
        assert!(g > -0.5, "{g}");
    }

    #[test]
    fn resampler_keeps_pitch_and_level() {
        let mut r = Resampler::new(44100, 48000).unwrap();
        let input = sine(1000.0, 44100, 1.0, 0.5);
        let mut out = Vec::new();
        for c in input.chunks(2 * 441) {
            r.process(c, &mut out);
        }
        let frames = out.len() / 2;
        assert!((frames as i64 - 48000).abs() < 100, "{frames}");
        let tail = &out[4000..out.len() - 4000];
        assert!((db(rms(tail), rms(&input)).abs()) < 0.2);
        let mono: Vec<f32> = tail.iter().step_by(2).cloned().collect();
        let zc = mono
            .windows(2)
            .filter(|w| w[0] < 0.0 && w[1] >= 0.0)
            .count() as f64;
        let hz = zc / (mono.len() as f64 / 48000.0);
        assert!((hz - 1000.0).abs() < 5.0, "{hz}");
        assert!(Resampler::new(48000, 48000).is_none());
    }

    #[test]
    fn resampler_rejects_aliases() {
        let mut r = Resampler::new(48000, 44100).unwrap();
        let input = sine(23500.0, 48000, 0.5, 0.5);
        let mut out = Vec::new();
        r.process(&input, &mut out);
        assert!(db(rms(&out[2000..]), rms(&input)) < -30.0);
    }

    #[test]
    fn wsola_changes_length_not_pitch() {
        for rate in [0.75, 1.5, 2.0] {
            let sr = 48000;
            let input = sine(440.0, sr, 4.0, 0.5);
            let mut w = Wsola::new(rate, sr);
            let mut out = Vec::new();
            for c in input.chunks(2 * 1024) {
                w.process(c, &mut out);
            }
            let want = 4.0 * sr as f64 / rate;
            let got = (out.len() / 2) as f64;
            assert!(
                (got - want).abs() / want < 0.04,
                "rate {rate}: {got} vs {want}"
            );
            let mono: Vec<f32> = out[4000..out.len() - 4000]
                .iter()
                .step_by(2)
                .cloned()
                .collect();
            let zc = mono
                .windows(2)
                .filter(|w| w[0] < 0.0 && w[1] >= 0.0)
                .count() as f64;
            let hz = zc / (mono.len() as f64 / sr as f64);
            assert!((hz - 440.0).abs() < 8.0, "rate {rate}: {hz} Hz");
            assert!((db(rms(&out[4000..out.len() - 4000]), rms(&input))).abs() < 1.0);
        }
    }

    #[test]
    fn loudness_blocks_are_400ms() {
        let mut l = Loudness::new(48000);
        let v = l.feed(&sine(440.0, 48000, 2.0, 0.708));
        assert_eq!(v.len(), 5);
        assert!((v[2] + 6.0).abs() < 0.1, "{}", v[2]);
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
        assert_eq!(g, Some(0.0));
        assert!(norm_update(&mut s, &mut n, -70.0).is_none());
    }

    #[test]
    fn downmix_and_upmix() {
        let mut o = Vec::new();
        to_stereo(&[0.5, -0.5], 1, &mut o);
        assert_eq!(o, vec![0.5, 0.5, -0.5, -0.5]);
        o.clear();
        to_stereo(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6], 6, &mut o);
        assert_eq!(o, vec![0.1, 0.2]);
    }
}
