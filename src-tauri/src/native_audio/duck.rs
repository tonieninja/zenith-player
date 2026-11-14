use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;

static LEVEL: AtomicU64 = AtomicU64::new(0);
static SENS: AtomicU64 = AtomicU64::new(0);
static GEN: AtomicU64 = AtomicU64::new(0);
static STOP: Mutex<Option<(u64, Sender<()>)>> = Mutex::new(None);

fn load(a: &AtomicU64) -> f64 {
    f64::from_bits(a.load(Ordering::Relaxed))
}

pub fn configure(level: f64, sensitivity: f64) {
    LEVEL.store(level.clamp(0.05, 0.5).to_bits(), Ordering::Relaxed);
    SENS.store(sensitivity.clamp(0.01, 0.15).to_bits(), Ordering::Relaxed);
}

pub fn stop() {
    // nowa generacja od razu ucisza callbacki strumienia, który jeszcze się zamyka
    GEN.fetch_add(1, Ordering::SeqCst);
    if let Some((_, tx)) = STOP.lock().unwrap_or_else(|p| p.into_inner()).take() {
        let _ = tx.send(());
    }
    super::set_duck(1.0);
}

// histereza jak w starym analizatorze: wyciszamy nad progiem, puszczamy poniżej 60% progu
pub struct Gate {
    acc: f64,
    n: usize,
    window: usize,
    ducking: bool,
}

impl Gate {
    pub fn new(window: usize) -> Self {
        Self {
            acc: 0.0,
            n: 0,
            window: window.max(1),
            ducking: false,
        }
    }

    pub fn feed(&mut self, samples: impl Iterator<Item = f32>, threshold: f64) -> Option<bool> {
        let mut flip = None;
        for s in samples {
            self.acc += f64::from(s) * f64::from(s);
            self.n += 1;
            if self.n < self.window {
                continue;
            }
            let rms = (self.acc / self.n as f64).sqrt();
            self.acc = 0.0;
            self.n = 0;
            if !self.ducking && rms > threshold {
                self.ducking = true;
                flip = Some(true);
            } else if self.ducking && rms < threshold * 0.6 {
                self.ducking = false;
                flip = Some(false);
            }
        }
        flip
    }
}

fn build<T: SizedSample + 'static>(
    dev: &cpal::Device,
    cfg: &cpal::StreamConfig,
    gen: u64,
    to_f32: fn(T) -> f32,
) -> Result<cpal::Stream, String> {
    // okno 100 ms, tak jak tick starego monitora w webview
    let window = (cfg.sample_rate.0 as usize * cfg.channels as usize) / 10;
    let mut gate = Gate::new(window);
    dev.build_input_stream(
        cfg,
        move |data: &[T], _| {
            let Some(ducking) = gate.feed(data.iter().map(|s| to_f32(*s)), load(&SENS)) else {
                return;
            };
            if GEN.load(Ordering::SeqCst) == gen {
                super::set_duck(if ducking { load(&LEVEL) } else { 1.0 });
            }
        },
        |e| eprintln!("[zaudio] mic stream error: {e}"),
        None,
    )
    .map_err(|e| e.to_string())
}

fn open(gen: u64) -> Result<cpal::Stream, String> {
    let dev = cpal::default_host()
        .default_input_device()
        .ok_or("no microphone")?;
    let sup = dev.default_input_config().map_err(|e| e.to_string())?;
    let cfg: cpal::StreamConfig = sup.config();
    let stream = match sup.sample_format() {
        SampleFormat::F32 => build::<f32>(&dev, &cfg, gen, |s| s),
        SampleFormat::I16 => build::<i16>(&dev, &cfg, gen, |s| f32::from(s) / 32768.0),
        SampleFormat::U16 => build::<u16>(&dev, &cfg, gen, |s| (f32::from(s) - 32768.0) / 32768.0),
        SampleFormat::I32 => build::<i32>(&dev, &cfg, gen, |s| s as f32 / 2_147_483_648.0),
        f => Err(format!("unsupported mic format {f:?}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

pub fn start() -> Result<(), String> {
    let mut slot = STOP.lock().unwrap_or_else(|p| p.into_inner());
    if slot.is_some() {
        return Ok(());
    }
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    // cpal::Stream nie jest Send, więc żyje na własnym wątku do sygnału stop;
    // nie czekamy na otwarcie mikrofonu, bo komenda blokowałaby główny wątek
    std::thread::Builder::new()
        .name("zaudio-duck".into())
        .spawn(move || match open(gen) {
            Ok(stream) => {
                let _ = stop_rx.recv();
                drop(stream);
            }
            Err(e) => {
                eprintln!("[zaudio] duck on voice: {e}");
                let mut slot = STOP.lock().unwrap_or_else(|p| p.into_inner());
                if slot.as_ref().is_some_and(|(g, _)| *g == gen) {
                    slot.take();
                }
            }
        })
        .map_err(|e| e.to_string())?;
    *slot = Some((gen, stop_tx));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Gate;

    #[test]
    fn ducks_on_loud_window_and_releases_with_hysteresis() {
        let mut g = Gate::new(4);
        assert_eq!(g.feed([0.001f32; 4].into_iter(), 0.04), None);
        assert_eq!(g.feed([0.2f32; 4].into_iter(), 0.04), Some(true));
        // 0.03 jest pod progiem, ale nad 60% progu, więc wciąż wyciszamy
        assert_eq!(g.feed([0.03f32; 4].into_iter(), 0.04), None);
        assert_eq!(g.feed([0.01f32; 4].into_iter(), 0.04), Some(false));
    }

    #[test]
    fn waits_for_a_full_window() {
        let mut g = Gate::new(8);
        assert_eq!(g.feed([0.5f32; 7].into_iter(), 0.04), None);
        assert_eq!(g.feed([0.5f32; 1].into_iter(), 0.04), Some(true));
    }
}
