// mniejsza poprawka byłaby widoczna jako szarpanie, bo czas dźwięku przychodzi co ~240 ms i jest ekstrapolowany
export const VIDEO_DRIFT_MAX = 0.3;

export type AudioClock = { t: number; paused: boolean; buffering: boolean; rate: number };

// poniżej progu skoku rozjazd zostawał na stałe (po przewinięciu ~0,2 s), więc doganiamy go prędkością
const VIDEO_DRIFT_OK = 0.05;
const VIDEO_CATCH_UP = 0.05;

export function videoStep(audio: AudioClock, videoTime: number) {
  const drift = videoTime - audio.t;
  const nudge = Math.abs(drift) > VIDEO_DRIFT_OK ? -Math.sign(drift) * VIDEO_CATCH_UP : 0;
  return {
    play: !audio.paused && !audio.buffering,
    rate: audio.rate * (1 + nudge),
    seekTo: Math.abs(drift) > VIDEO_DRIFT_MAX ? audio.t : null,
  };
}

// id utworu, który naprawdę gra; wersja zastępcza ma inne id i inną oś czasu niż teledysk
export function proxiedId(src: string): string | null {
  return /\/(?:zenith|offline)\/[^/]+\/([\w-]{11})(?:[?#]|$)/.exec(src)?.[1] ?? null;
}
