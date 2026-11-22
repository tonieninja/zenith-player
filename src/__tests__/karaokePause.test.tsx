import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LyricKaraokeText } from '../components/LyricKaraokeText';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = () => ({});
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const syncTimers = (playing: boolean) => {
  const spy = vi.spyOn(window, 'setInterval');
  const el = document.createElement('div');
  document.body.appendChild(el);
  act(() =>
    createRoot(el).render(
      <LyricKaraokeText
        text="la la"
        active
        start={10}
        end={14}
        getProgress={() => 11}
        playing={playing}
      />
    )
  );
  return spy.mock.calls.filter(([, ms]) => ms === 250).length;
};

describe('karaoke wipe', () => {
  it('polls the clock while playing', () => {
    expect(syncTimers(true)).toBe(1);
  });

  it('keeps no timer running while paused', () => {
    expect(syncTimers(false)).toBe(0);
  });
});
