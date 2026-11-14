import { invoke } from '@tauri-apps/api/core';
import { isNativeAudio } from '../audio/engine';
import { ZenithPlugin } from './types';

export const DUCK_LEVEL_KEY = 'zenith_duck_level';
export const DUCK_SENSITIVITY_KEY = 'zenith_duck_sensitivity';

let monitor: DuckMonitor | null = null;
let nativeDuck = false;

function syncNativeDuck() {
  void invoke('zaudio_duck', {
    on: nativeDuck,
    level: getDuckLevel(),
    sensitivity: getDuckSensitivity(),
  }).catch((err) => console.warn('[duck-on-voice] mic unavailable', err));
}

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
  if (nativeDuck) syncNativeDuck();
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
  if (nativeDuck) syncNativeDuck();
}

type VolumeSetter = (v: number) => void;

class DuckMonitor {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private timer = 0;
  private buf: Uint8Array<ArrayBuffer> | null = null;
  ducking = false;
  level = 0;
  private stopped = false;

  constructor(
    private getMaster: () => number,
    private setVol: VolumeSetter
  ) {}

  async start() {
    if (this.ctx) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (this.stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      this.buf = new Uint8Array(this.analyser.frequencyBinCount);
      this.timer = window.setInterval(this.tick, 100);
    } catch (e) {
      console.warn('[duck-on-voice] mic access denied', e);
    }
  }

  stop() {
    const wasDucking = this.ducking;
    this.stopped = true;
    window.clearInterval(this.timer);
    this.timer = 0;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
    this.ducking = false;
    if (wasDucking) this.setVol(this.getMaster());
  }

  private tick = () => {
    if (!this.analyser || !this.buf || this.stopped) return;
    const buf = this.buf;
    this.analyser.getByteFrequencyData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 1) sum += buf[i];
    const avg = sum / buf.length / 255;
    this.level = avg;
    const threshold = getDuckSensitivity();
    const targetMaster = this.getMaster();

    if (avg > threshold && !this.ducking) {
      this.ducking = true;
      this.setVol(targetMaster * getDuckLevel());
    } else if (avg < threshold * 0.6 && this.ducking) {
      this.ducking = false;
      this.setVol(targetMaster);
    }
  };
}

export function startDuckMonitor(getMaster: () => number, setVol: VolumeSetter) {
  stopDuckMonitor();
  // przy silniku w Ruście mikrofon i wyciszanie obsługuje Rust, także po zamknięciu UI do zasobnika
  if (isNativeAudio()) {
    nativeDuck = true;
    syncNativeDuck();
    return;
  }
  monitor = new DuckMonitor(getMaster, setVol);
  monitor.start();
}

export type DuckMeter = { level: number; ducking: boolean };

// null, gdy plugin nie słucha mikrofonu
export async function readDuckMeter(): Promise<DuckMeter | null> {
  if (nativeDuck) {
    try {
      const [level, ducking] = await invoke<[number, boolean]>('zaudio_duck_meter');
      return { level, ducking };
    } catch {
      return null;
    }
  }
  return monitor ? { level: monitor.level, ducking: monitor.ducking } : null;
}

export function stopDuckMonitor() {
  if (nativeDuck) {
    nativeDuck = false;
    syncNativeDuck();
  }
  monitor?.stop();
  monitor = null;
}

export const duckOnVoicePlugin: ZenithPlugin = {
  id: 'duck-on-voice',
  name: 'Duck on Voice',
  category: 'sound',
  description: 'Lowers music volume when your microphone detects speech (Discord, calls).',
  defaultEnabled: false,
  onDisable() {
    stopDuckMonitor();
  },
};
