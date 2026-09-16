import { ZenithPlugin } from './types';

export const smoothVolumePlugin: ZenithPlugin = {
  id: 'smooth-volume',
  name: 'Smooth Volume',
  category: 'playback',
  description: 'Ramps volume changes smoothly instead of jumping instantly.',
  defaultEnabled: true,
};

let rampToken = 0;

export function rampVolume(
  audio: { volume: number },
  target: number,
  enabled: boolean,
  durationMs = 180
): void {
  if (!enabled) {
    audio.volume = target;
    return;
  }
  const token = ++rampToken;
  const start = audio.volume;
  const delta = target - start;
  if (Math.abs(delta) < 0.01) {
    audio.volume = target;
    return;
  }
  const t0 = performance.now();
  const step = (now: number) => {
    if (token !== rampToken) return;
    const t = Math.min(1, (now - t0) / durationMs);
    audio.volume = start + delta * t;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function rampVolumeAsync(
  audio: { volume: number },
  target: number,
  durationMs = 280
): Promise<void> {
  const token = ++rampToken;
  return new Promise((resolve) => {
    const start = audio.volume;
    const delta = target - start;
    if (Math.abs(delta) < 0.01) {
      audio.volume = target;
      resolve();
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      if (token !== rampToken) {
        resolve();
        return;
      }
      const t = Math.min(1, (now - t0) / durationMs);
      audio.volume = start + delta * t;
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}
