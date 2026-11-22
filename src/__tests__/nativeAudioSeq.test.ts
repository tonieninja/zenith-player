import { describe, expect, it, vi } from 'vitest';

type Handler = (e: { payload: { type: string; snap: Record<string, unknown> } }) => void;
const h = vi.hoisted(() => ({
  on: null as Handler | null,
  reply: null as ((v: unknown) => void) | null,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_: string, cb: Handler) => {
    h.on = cb;
    return () => {};
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string) =>
    cmd === 'zaudio_cmd' ? new Promise((r) => (h.reply = r)) : Promise.resolve({})
  ),
}));

import { NativeAudio } from '../audio/nativeAudio';

const snap = (t: number, seq: number) => ({
  t,
  d: 300,
  paused: true,
  ready: 4,
  src: 'x',
  hasSource: true,
  crossfading: false,
  ended: false,
  seq,
});

describe('native audio snapshots', () => {
  it('ignores ticks older than the seek it is waiting for', async () => {
    const a = new NativeAudio(snap(10, 5));
    await Promise.resolve();
    a.currentTime = 120;
    h.on!({ payload: { type: 'timeupdate', snap: snap(11, 6) } });
    expect(a.currentTime).toBe(120);
    h.reply!(snap(120, 7));
    await Promise.resolve();
    await Promise.resolve();
    h.on!({ payload: { type: 'timeupdate', snap: snap(11, 6) } });
    expect(a.currentTime).toBe(120);
    h.on!({ payload: { type: 'timeupdate', snap: snap(121, 8) } });
    expect(a.currentTime).toBe(121);
  });
});
