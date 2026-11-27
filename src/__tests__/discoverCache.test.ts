import { beforeEach, describe, expect, it, vi } from 'vitest';

const picks = [
  { artist: 'A', title: 'one', because: 'x' },
  { artist: 'B', title: 'two', because: 'x' },
  { artist: 'C', title: 'three', because: 'x' },
  { artist: 'D', title: 'four', because: 'x' },
];
const invokeMock = vi.fn(async () => picks);
const searchMock = vi.fn(async (q: string) => [
  { id: q, type: 'track', title: q, artist: q.split(' ')[0], cover: '' },
]);
vi.mock('@tauri-apps/api/core', () => ({ invoke: () => invokeMock() }));
vi.mock('../api/youtube', () => ({ searchSongsStrict: (q: string) => searchMock(q) }));

let discover: typeof import('../plugins/discover');

beforeEach(async () => {
  vi.resetModules();
  invokeMock.mockClear();
  searchMock.mockClear();
  discover = await import('../plugins/discover');
});

describe('discover home row', () => {
  it('searches once for parallel callers and serves later visits from memory', async () => {
    expect(discover.peekDiscoverSection('en')).toBeUndefined();
    const [a, b] = await Promise.all([
      discover.discoverSection('en', 'Discover'),
      discover.discoverSection('en', 'Discover'),
    ]);
    expect(a).toBe(b);
    expect(a?.items).toHaveLength(4);
    expect(searchMock).toHaveBeenCalledTimes(4);
    expect(discover.peekDiscoverSection('en')).toBe(a);
    await discover.discoverSection('en', 'Discover');
    expect(searchMock).toHaveBeenCalledTimes(4);
  });

  it('does not remember an empty answer, so the next visit tries again', async () => {
    invokeMock.mockResolvedValueOnce([]);
    expect(await discover.discoverSection('pl', 'Odkryj')).toBeNull();
    expect(discover.peekDiscoverSection('pl')).toBeUndefined();
  });
});
