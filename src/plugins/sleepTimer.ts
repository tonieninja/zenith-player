import { ZenithPlugin } from './types';

export const SLEEP_TIMER_KEY = 'zenith_sleep_timer_mins';
export const SLEEP_TIMER_OPTIONS = [15, 30, 45, 60, 90] as const;

let timer: ReturnType<typeof setTimeout> | null = null;
let onExpire: (() => void) | null = null;

export function registerSleepTimerCallback(cb: () => void) {
  onExpire = cb;
}

export function getSleepTimerMinutes(): number {
  try {
    return Number(localStorage.getItem(SLEEP_TIMER_KEY)) || 30;
  } catch {
    return 30;
  }
}

export function setSleepTimerMinutes(mins: number) {
  try {
    localStorage.setItem(SLEEP_TIMER_KEY, String(mins));
  } catch {}
}

function armTimer() {
  if (timer) clearTimeout(timer);
  const mins = getSleepTimerMinutes();
  timer = setTimeout(
    () => {
      onExpire?.();
      timer = null;
    },
    mins * 60 * 1000
  );
}

export function rearmSleepTimer() {
  armTimer();
}

export const sleepTimerPlugin: ZenithPlugin = {
  id: 'sleep-timer',
  name: 'Sleep Timer',
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
    if (info?.isPlaying) armTimer();
  },
};
