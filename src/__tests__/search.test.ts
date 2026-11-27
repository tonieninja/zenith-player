import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
const fetchMock = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => fetchMock(...a) }));

import {
  parseSearchChips,
  parseSearchSuggestions,
  searchFilterPage,
  searchMusic,
  searchMusicPage,
} from '../api/youtube';
import { addSearchHistory, loadSearchHistory, removeSearchHistory } from '../utils/searchHistory';

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

const chip = (title: string, params?: string) => ({
  chipCloudChipRenderer: {
    text: text(title),
    navigationEndpoint: params ? { searchEndpoint: { query: 'q', params } } : {},
  },
});
const withChips = (body: { contents: unknown }, chips: unknown[]) => ({
  ...body,
  header: { chipCloudRenderer: { chips } },
});
const shelf = (rows: unknown[], next?: string) => ({
  musicShelfRenderer: {
    contents: rows,
    ...(next ? { continuations: [{ nextContinuationData: { continuation: next } }] } : {}),
  },
});

describe('search filters and suggestions', () => {
  beforeEach(() => fetchMock.mockReset());

  it('reads filter chips with their params and drops the clear-filters chip', () => {
    const data = withChips(page([]), [chip('Songs', 'P_SONGS'), chip('Albums', 'P_ALB'), chip('')]);
    expect(parseSearchChips(data)).toEqual([
      { title: 'Songs', params: 'P_SONGS' },
      { title: 'Albums', params: 'P_ALB' },
    ]);
    expect(parseSearchChips({})).toEqual([]);
  });

  it('returns the chips of the unfiltered response with the results', async () => {
    fetchMock.mockImplementation(async (_u: string, init?: { body?: string }) =>
      json(isSongsFilter(init) ? songsFilter : withChips(songsFilter, [chip('Songs', 'P_SONGS')]))
    );
    const res = await searchMusicPage('chips query', 'en');
    expect(res.chips).toEqual([{ title: 'Songs', params: 'P_SONGS' }]);
    expect(res.sections.length).toBeGreaterThan(0);
  });

  it('splits suggestions into bold text runs and quick results', () => {
    const data = {
      contents: [
        {
          searchSuggestionsSectionRenderer: {
            contents: [
              {
                searchSuggestionRenderer: {
                  suggestion: { runs: [{ text: 'daft', bold: true }, { text: ' punk' }] },
                  navigationEndpoint: { searchEndpoint: { query: 'daft punk' } },
                },
              },
            ],
          },
        },
        {
          searchSuggestionsSectionRenderer: {
            contents: [row('bbbbbbbbbbb', 'Get Lucky', ['Song', ' • ', 'Daft Punk'])],
          },
        },
      ],
    };
    const res = parseSearchSuggestions(data, 'en');
    expect(res.texts).toEqual([
      {
        query: 'daft punk',
        runs: [
          { text: 'daft', bold: true },
          { text: ' punk', bold: false },
        ],
      },
    ]);
    expect(res.items.map((i) => i.id)).toEqual(['bbbbbbbbbbb']);
    expect(parseSearchSuggestions({}, 'en')).toEqual({ texts: [], items: [] });
  });

  it('pages a filter with continuation tokens and stops at the last page', async () => {
    fetchMock
      .mockResolvedValueOnce(json(page([shelf([row('ccccccccccc', 'One', ['Song'])], 'TOK1')])))
      .mockResolvedValueOnce(
        json({
          // nagłówek pierwszej strony wraca w `contents`; jego wiersze nie mogą trafić drugi raz na listę
          ...page([shelf([row('ccccccccccc', 'One', ['Song'])], 'TOK1')]),
          continuationContents: {
            musicShelfContinuation: { contents: [row('ddddddddddd', 'Two', ['Song'])] },
          },
        })
      );
    const first = await searchFilterPage('q', 'P_SONGS', 'en');
    expect(first).toMatchObject({ next: 'TOK1', items: [{ id: 'ccccccccccc' }] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      query: 'q',
      params: 'P_SONGS',
    });
    const second = await searchFilterPage('q', 'P_SONGS', 'en', first.next);
    expect(second).toEqual({ next: null, items: [expect.objectContaining({ id: 'ddddddddddd' })] });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ continuation: 'TOK1' });
  });
});

describe('search history', () => {
  beforeEach(() => localStorage.removeItem('zenith_search_history'));

  it('keeps the newest ten, without case duplicates, and removes one entry', () => {
    for (let i = 0; i < 12; i++) addSearchHistory(`q${i}`);
    expect(loadSearchHistory()).toHaveLength(10);
    expect(addSearchHistory(' Q11 ')[0]).toBe('Q11');
    expect(loadSearchHistory().filter((q) => q.toLowerCase() === 'q11')).toHaveLength(1);
    expect(removeSearchHistory('Q11')).not.toContain('Q11');
    localStorage.setItem('zenith_search_history', '{broken');
    expect(loadSearchHistory()).toEqual([]);
  });
});
