import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
const fetchMock = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => fetchMock(...a) }));

import { searchMusic } from '../api/youtube';

const text = (t: string) => ({ runs: [{ text: t }] });
const row = (videoId: string, title: string, sub: string[]) => ({
  musicResponsiveListItemRenderer: {
    playlistItemData: { videoId },
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: text(title) } },
      {
        musicResponsiveListItemFlexColumnRenderer: {
          text: { runs: sub.map((s) => ({ text: s })) },
        },
      },
    ],
  },
});
const browse = (browseId: string, pageType: string) => ({
  browseEndpoint: {
    browseId,
    browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType } },
  },
});
const page = (contents: unknown[]) => ({ contents: { sectionListRenderer: { contents } } });
const topCard = (onTap: unknown, songs: unknown[]) =>
  page([
    {
      musicCardShelfRenderer: {
        header: { musicCardShelfHeaderBasicRenderer: { title: text('Top result') } },
        title: text('Daft Punk'),
        subtitle: { runs: [{ text: 'Artist' }, { text: ' • ' }, { text: '66M monthly audience' }] },
        onTap,
        contents: songs,
      },
    },
  ]);
const songsFilter = page([
  {
    musicShelfRenderer: {
      title: text('Songs'),
      contents: [
        row('aaaaaaaaaaa', 'The Son of Flynn', ['Daft Punk', ' • ', 'TRON', ' • ', '1:36']),
      ],
    },
  },
]);
const json = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const isSongsFilter = (init?: { body?: string }) => Boolean(JSON.parse(init?.body || '{}').params);

describe('searchMusic', () => {
  beforeEach(() => fetchMock.mockReset());

  it('gives top-result songs the artist instead of their length', async () => {
    const card = topCard(browse('UCdaft', 'MUSIC_PAGE_TYPE_ARTIST'), [
      row('aaaaaaaaaaa', 'The Son of Flynn', ['Song', ' • ', '1:36']),
    ]);
    fetchMock.mockImplementation(async (_u: string, init?: { body?: string }) =>
      json(isSongsFilter(init) ? page([]) : card)
    );
    const items = (await searchMusic('daft punk artist card', 'en')).flatMap((s) => s.items);
    const song = items.find((i) => i.id === 'aaaaaaaaaaa');
    expect(song?.artist).toBe('Daft Punk');
    expect(song?.durationSec).toBe(96);
  });

  it('takes the artist from the songs filter when the card has none', async () => {
    const card = topCard(browse('MPREb_tron', 'MUSIC_PAGE_TYPE_ALBUM'), [
      row('aaaaaaaaaaa', 'The Son of Flynn', ['Song', ' • ', '1:36']),
    ]);
    fetchMock.mockImplementation(async (_u: string, init?: { body?: string }) =>
      json(isSongsFilter(init) ? songsFilter : card)
    );
    const items = (await searchMusic('tron album card', 'en')).flatMap((s) => s.items);
    expect(items.find((i) => i.id === 'aaaaaaaaaaa')?.artist).toBe('Daft Punk • TRON');
  });

  it('fails when both requests fail, so the view can offer a retry', async () => {
    fetchMock.mockRejectedValue(new Error('error sending request'));
    await expect(searchMusic('offline query', 'en')).rejects.toThrow('search failed');
    fetchMock.mockResolvedValue(json(page([])));
    await expect(searchMusic('nothing matches this', 'en')).resolves.toEqual([]);
  });

  it('shares one request between two calls for the same query', async () => {
    fetchMock.mockImplementation(async () => json(songsFilter));
    const [a, b] = await Promise.all([
      searchMusic('same query', 'en'),
      searchMusic('Same query ', 'en'),
    ]);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
