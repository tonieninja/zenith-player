import { afterEach, describe, expect, it, vi } from 'vitest';

const emitTo = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/event', () => ({ emitTo: (...a: unknown[]) => emitTo(...a) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: class {} }));

import { pushLyricsOverlay } from '../plugins/lyricsOverlay';

const base = {
  title: 'Song',
  artist: 'Artist',
  trackId: 'dQw4w9WgXcQ',
  isPlaying: true,
  synced: [
    { time: 1, text: 'a' },
    { time: 2, text: 'b' },
  ],
  text: null,
};
const sent = () => emitTo.mock.calls.at(-1)![2];

describe('lyrics overlay push', () => {
  it('sends the lyrics once and then only the clock until they change', async () => {
    await pushLyricsOverlay({ ...base, progress: 1 });
    expect(sent().synced).toHaveLength(2);
    await pushLyricsOverlay({ ...base, progress: 2 });
    expect(sent().synced).toBeUndefined();
    expect(sent().lyricsSame).toBe(true);
    await pushLyricsOverlay({ ...base, progress: 2 }, { force: true });
    expect(sent().synced).toHaveLength(2);
    await pushLyricsOverlay({ ...base, trackId: 'other000000', progress: 3 });
    expect(sent().synced).toHaveLength(2);
    expect(sent().lyricsSame).toBeUndefined();
  });
});

describe('lyrics overlay clock packets', () => {
  afterEach(() => vi.useRealTimers());
  const at = (ms: number, progress: number) => {
    vi.setSystemTime(ms);
    return pushLyricsOverlay({ ...base, progress, activeLyricIndex: 1 });
  };

  it('sends a steady clock about every 5 s, not every second', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    const before = emitTo.mock.calls.length;
    for (let ms = 0; ms <= 60_000; ms += 250) await at(t0 + ms, 100 + ms / 1000);
    expect(emitTo.mock.calls.length - before).toBeLessThanOrEqual(14);
  });

  it('sends right away after a seek inside the same line', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now() + 100_000;
    await at(t0, 10);
    const before = emitTo.mock.calls.length;
    await at(t0 + 1000, 13);
    expect(emitTo.mock.calls.length).toBe(before + 1);
  });
});
