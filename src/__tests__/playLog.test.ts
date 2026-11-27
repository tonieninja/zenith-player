import { describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn(async (_cmd: string, _args: { play: { listened: number } }) => undefined);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: { play: { listened: number } }) => invokeMock(cmd, args),
}));

import { playLogRepeat, playLogSwitch, playLogTick } from '../utils/playLog';

const song = { id: 'aaaaaaaaaaa', type: 'track' as const, title: 'A', artist: 'B', cover: '' };
const logged = () =>
  invokeMock.mock.calls.map((c) => (c[1] as { play: { listened: number } }).play);

describe('play log', () => {
  it('counts every repeat of one song and the song playing at quit', () => {
    invokeMock.mockClear();
    playLogSwitch(song);
    playLogTick(song.id, 180);
    playLogRepeat();
    playLogTick(song.id, 40);
    playLogSwitch(null);
    expect(logged().map((p) => p.listened)).toEqual([180, 40]);
    playLogRepeat();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
