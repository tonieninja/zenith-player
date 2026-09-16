import { ZenithPlugin } from './types';

export const DUCK_LEVEL_KEY = 'zenith_duck_level';
export const DUCK_SENSITIVITY_KEY = 'zenith_duck_sensitivity';

let monitor: DuckMonitor | null = null;

export function getDuckLevel(): number {
  try {
    const v = Number(localStorage.getItem(DUCK_LEVEL_KEY));
    if (Number.isFinite(v) && v >= 0.05 && v <= 0.5) return v;
  } catch {}
  return 0.2;
}

export function setDuckLevel(v: number) {
  try {
    localStorage.setItem(DUCK_LEVEL_KEY, String(v));
  } catch {}
}

export function getDuckSensitivity(): number {
  try {
    const v = Number(localStorage.getItem(DUCK_SENSITIVITY_KEY));
    if (Number.isFinite(v) && v >= 0.01 && v <= 0.15) return v;
  } catch {}
  return 0.04;
}

export function setDuckSensitivity(v: number) {
  try {
    localStorage.setItem(DUCK_SENSITIVITY_KEY, String(v));
  } catch {}
}

type VolumeSetter = (v: number) => void;

class DuckMonitor {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;
  private ducking = false;

  constructor(
    private getMaster: () => number,
    private setVol: VolumeSetter
  ) {}

  async start() {
    if (this.ctx) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      this.tick();
    } catch (e) {
      console.warn('[duck-on-voice] mic access denied', e);
    }
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
    this.ducking = false;
    this.setVol(this.getMaster());
  }

  private tick = () => {
    if (!this.analyser) return;
    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 1) sum += buf[i];
    const avg = sum / buf.length / 255;
    const threshold = getDuckSensitivity();
    const targetMaster = this.getMaster();

    if (avg > threshold && !this.ducking) {
      this.ducking = true;
      this.setVol(targetMaster * getDuckLevel());
    } else if (avg < threshold * 0.6 && this.ducking) {
      this.ducking = false;
      this.setVol(targetMaster);
    }
    this.raf = requestAnimationFrame(this.tick);
  };
}

export function startDuckMonitor(getMaster: () => number, setVol: VolumeSetter) {
  stopDuckMonitor();
  monitor = new DuckMonitor(getMaster, setVol);
  monitor.start();
}

export function stopDuckMonitor() {
  monitor?.stop();
  monitor = null;
}

export const duckOnVoicePlugin: ZenithPlugin = {
  id: 'duck-on-voice',
  name: 'Duck on Voice',
  category: 'playback',
  description: 'Lowers music volume when your microphone detects speech (Discord, calls).',
  defaultEnabled: false,
  onDisable() {
    stopDuckMonitor();
  },
};
