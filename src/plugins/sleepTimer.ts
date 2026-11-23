import { ZenithPlugin } from './types';

export const SLEEP_TIMER_KEY = 'zenith_sleep_timer_mins';
export const SLEEP_TIMER_OPTIONS = [15, 30, 45, 60, 90] as const;

let timer: ReturnType<typeof setTimeout> | null = null;
let onExpire: (() => void) | null = null;
let endsAt = 0;

export function getSleepEndsAt(): number {
  return timer ? endsAt : 0;
}

export function registerSleepTimerCallback(cb: () => void) {
  onExpire = cb;
}

export function getSleepTimerMinutes(): number {
  return Number(localStorage.getItem(SLEEP_TIMER_KEY)) || 30;
}

export function setSleepTimerMinutes(mins: number) {
  localStorage.setItem(SLEEP_TIMER_KEY, String(mins));
}

function armTimer() {
  if (timer) clearTimeout(timer);
  const mins = getSleepTimerMinutes();
  endsAt = Date.now() + mins * 60 * 1000;
  timer = setTimeout(
    () => {
      onExpire?.();
      timer = null;
    },
    mins * 60 * 1000
  );
}

/** Termin od Rusta po odbudowie okna: 0 znaczy, że licznik wygasł albo nie był uzbrojony. */
export function adoptSleepEndsAt(at: number) {
  if (timer) clearTimeout(timer);
  timer = null;
  const left = at - Date.now();
  if (!(at > 0) || left <= 0) return;
  endsAt = at;
  timer = setTimeout(() => {
    onExpire?.();
    timer = null;
  }, left);
}

export function rearmSleepTimer() {
  armTimer();
}

export const sleepTimerPlugin: ZenithPlugin = {
  id: 'sleep-timer',
  name: 'Sleep timer',
  category: 'playback',
  description: 'Automatically stops playback after a set number of minutes.',
  defaultEnabled: false,
  onEnable() {
    armTimer();
  },
  onDisable() {
    if (timer) clearTimeout(timer);
    timer = null;
  },
  onNowPlaying(info) {
    if (info?.isPlaying && !timer) armTimer();
  },
  onPlayStateChange(playing) {
    if (playing && !timer) armTimer();
  },
};
