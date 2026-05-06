import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSleepEndsAt,
  rearmSleepTimer,
  registerSleepTimerCallback,
  setSleepTimerMinutes,
  sleepTimerPlugin,
} from '../plugins/sleepTimer';

describe('sleep timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    sleepTimerPlugin.onDisable?.();
    vi.useRealTimers();
  });

  it('fires once after the chosen minutes', () => {
    const cb = vi.fn();
    registerSleepTimerCallback(cb);
    setSleepTimerMinutes(15);
    sleepTimerPlugin.onEnable?.();
    expect(getSleepEndsAt()).toBeGreaterThan(Date.now());
    vi.advanceTimersByTime(15 * 60 * 1000 - 1);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(getSleepEndsAt()).toBe(0);
  });

  it('track changes do not push the deadline back', () => {
    const cb = vi.fn();
    registerSleepTimerCallback(cb);
    setSleepTimerMinutes(30);
    sleepTimerPlugin.onEnable?.();
    const end = getSleepEndsAt();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(60_000);
      sleepTimerPlugin.onNowPlaying?.({ isPlaying: true } as never);
    }
    expect(getSleepEndsAt()).toBe(end);
    vi.advanceTimersByTime(20 * 60_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('rearm restarts the countdown and disable cancels it', () => {
    const cb = vi.fn();
    registerSleepTimerCallback(cb);
    setSleepTimerMinutes(15);
    sleepTimerPlugin.onEnable?.();
    vi.advanceTimersByTime(10 * 60_000);
    setSleepTimerMinutes(45);
    rearmSleepTimer();
    vi.advanceTimersByTime(40 * 60_000);
    expect(cb).not.toHaveBeenCalled();
    sleepTimerPlugin.onDisable?.();
    vi.advanceTimersByTime(60 * 60_000);
    expect(cb).not.toHaveBeenCalled();
    expect(getSleepEndsAt()).toBe(0);
  });
});
