import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn(async (cmd: string) => {
  if (cmd === 'get_ytm_cookies') return 'SAPISID=test-sapisid; __Secure-3PSID=test-psid';
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string) => invokeMock(cmd) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
const fetchMock = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => fetchMock(...a) }));

import {
  addToPlaylist,
  AlreadyInPlaylistError,
  applyPlaylistOverrides,
  getRadioTracks,
  isGeneratedMixId,
  loadPlaylistItems,
  playlistBrowseCandidates,
  playlistContentRoot,
  rememberPlaylistDeleted,
  rememberPlaylistRenamed,
  pickSongTwins,
  searchSongsStrict,
  toPlaylistBrowseId,
} from '../api/youtube';
import { addMissingTracks } from '../api/playlistManager';
import { loadPersistedQueue, savePersistedQueue } from '../plugins/queuePersist';

const item = (videoId: string, title: string) => ({
  musicResponsiveListItemRenderer: {
    playlistItemData: { videoId },
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Artist' }] } } },
    ],
  },
});

const playlistPage = (own: unknown[], suggestions: unknown[] = []) => ({
  contents: {
    twoColumnBrowseResultsRenderer: {
      secondaryContents: {
        sectionListRenderer: {
          contents: [
            ...(own.length ? [{ musicPlaylistShelfRenderer: { contents: own } }] : []),
            ...(suggestions.length ? [{ musicShelfRenderer: { contents: suggestions } }] : []),
          ],
        },
      },
    },
  },
});

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

describe('playlist content', () => {
  it('reads only the playlist shelf, not the suggestions', () => {
    const page = playlistPage([item('aaaaaaaaaaa', 'Mine')], [item('bbbbbbbbbbb', 'Suggested')]);
    const root = playlistContentRoot(page, 'VLPLxyz');
    expect(JSON.stringify(root)).toContain('aaaaaaaaaaa');
    expect(JSON.stringify(root)).not.toContain('bbbbbbbbbbb');
  });

  it('treats a playlist with only suggestions as empty', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse(playlistPage([], [item('bbbbbbbbbbb', 'Sug')])));
    const res = await loadPlaylistItems('VLPLempty', 'en');
    expect(res.status).toBe('empty');
    expect(res.items).toEqual([]);
  });

  it('reads podcast episodes from the episodes-for-later list', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      jsonResponse({
        contents: {
          sectionListRenderer: {
            contents: [
              {
                musicShelfRenderer: {
                  contents: [
                    {
                      musicMultiRowListItemRenderer: {
                        title: { runs: [{ text: 'Episode 1' }] },
                        subtitle: { runs: [{ text: 'Show' }] },
                        onTap: { watchEndpoint: { videoId: 'ccccccccccc' } },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      })
    );
    const res = await loadPlaylistItems('VLSE', 'en');
    expect(res.status).toBe('ok');
    expect(res.items.map((t) => t.id)).toEqual(['ccccccccccc']);
  });

  it('reports a failed request as failed, not empty', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => '' });
    expect((await loadPlaylistItems('VLPLx', 'en')).status).toBe('failed');
  });

  it('takes the album artist from the album header when tracks have none', async () => {
    fetchMock.mockReset();
    const noArtist = {
      musicResponsiveListItemRenderer: {
        playlistItemData: { videoId: 'aaaaaaaaaaa' },
        flexColumns: [
          { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Usseewa' }] } } },
        ],
      },
    };
    const header = { straplineTextOne: { runs: [{ text: 'Ado' }] } };
    fetchMock.mockResolvedValue(
      jsonResponse({
        contents: {
          twoColumnBrowseResultsRenderer: {
            tabs: [
              {
                tabRenderer: {
                  content: {
                    sectionListRenderer: {
                      contents: [{ musicResponsiveHeaderRenderer: header }],
                    },
                  },
                },
              },
            ],
            secondaryContents: {
              sectionListRenderer: {
                contents: [
                  { musicShelfRenderer: { contents: [noArtist, item('bbbbbbbbbbb', 'B')] } },
                ],
              },
            },
          },
        },
      })
    );
    const res = await loadPlaylistItems('MPREb_album', 'en');
    expect(res.items.map((t) => t.artist)).toEqual(['Ado', 'Artist']);
  });

  it('browses generated mix / supermix ids as VLRD..., never the bare RD id', () => {
    expect(isGeneratedMixId('VLRDTMAK5uyEnergy')).toBe(true);
    expect(isGeneratedMixId('RDTMAK5uyEnergy')).toBe(true);
    expect(isGeneratedMixId('VLPLabc')).toBe(false);
    expect(toPlaylistBrowseId('RDTMAK5uyEnergy')).toBe('VLRDTMAK5uyEnergy');
    expect(toPlaylistBrowseId('VLRDTMAK5uyEnergy')).toBe('VLRDTMAK5uyEnergy');
    expect(toPlaylistBrowseId('PLabc')).toBe('VLPLabc');
    expect(playlistBrowseCandidates('VLRDTMAK5uyEnergy')).toEqual(['VLRDTMAK5uyEnergy']);
    expect(playlistBrowseCandidates('RDTMAK5uyEnergy')).toEqual(['VLRDTMAK5uyEnergy']);
  });

  it('reads Energy Supermix tracks from a plain music shelf, even on a VLRD id', () => {
    const page = {
      contents: {
        sectionListRenderer: {
          contents: [{ musicShelfRenderer: { contents: [item('ddddddddddd', 'High Energy')] } }],
        },
      },
    };
    const root = playlistContentRoot(page, 'VLRDTMAK5uyEnergy');
    expect(JSON.stringify(root)).toContain('ddddddddddd');
  });

  const continuation = (token: string) => ({
    continuationItemRenderer: {
      continuationEndpoint: { continuationCommand: { token } },
    },
  });
  const contPage = (items: unknown[], next?: string) => ({
    onResponseReceivedActions: [
      {
        appendContinuationItemsAction: {
          continuationItems: [...items, ...(next ? [continuation(next)] : [])],
        },
      },
    ],
  });
  const ids = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => `mix${String(i + from).padStart(8, '0')}`);

  it('loads a supermix from VLRD... and stops when the next pages only repeat', async () => {
    fetchMock.mockReset();
    const first = ids(100);
    let continuations = 0;
    fetchMock.mockImplementation(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.browseId === 'RDTMAK5uyEnergy') {
        return { ok: false, status: 400, text: async () => '{"error":{"code":400}}' };
      }
      if (body.browseId === 'VLRDTMAK5uyEnergy') {
        return jsonResponse(playlistPage([...first.map((id) => item(id, id)), continuation('c1')]));
      }
      if (body.continuation) {
        continuations += 1;
        return jsonResponse(
          contPage(
            first.slice(0, 50).map((id) => item(id, id)),
            'cN'
          )
        );
      }
      return { ok: false, status: 404, text: async () => '' };
    });
    const pages: number[] = [];
    const res = await loadPlaylistItems('VLRDTMAK5uyEnergy', 'en', (items) =>
      pages.push(items.length)
    );
    expect(res.status).toBe('ok');
    expect(res.items).toHaveLength(100);
    expect(pages[0]).toBe(100);
    expect(continuations).toBe(1);
    const firstBrowse = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body || '{}'));
    expect(firstBrowse.browseId).toBe('VLRDTMAK5uyEnergy');
  });

  it('caps a generated mix at a few continuation pages', async () => {
    fetchMock.mockReset();
    let n = 0;
    fetchMock.mockImplementation(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.browseId) {
        return jsonResponse(
          playlistPage([...ids(100).map((id) => item(id, id)), continuation('c')])
        );
      }
      n += 1;
      return jsonResponse(
        contPage(
          ids(100, n * 100).map((id) => item(id, id)),
          `c${n}`
        )
      );
    });
    const res = await loadPlaylistItems('RDTMAK5uyEnergy', 'en');
    expect(res.items).toHaveLength(300);
    expect(n).toBe(2);
  });

  it('keeps the first page when a later page fails', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body || '{}'));
      if (body.browseId) {
        return jsonResponse(playlistPage([item('aaaaaaaaaaa', 'A'), continuation('c')]));
      }
      throw new Error('timed out');
    });
    const res = await loadPlaylistItems('VLPLlong', 'en');
    expect(res.status).toBe('ok');
    expect(res.items.map((t) => t.id)).toEqual(['aaaaaaaaaaa']);
  });

  it('falls back to the watch queue for a radio mix without a browse page', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body || '{}'));
      if (String(url).includes('/browse')) return jsonResponse({ responseContext: {} });
      if (String(url).includes('/next') && body.playlistId === 'RDAMVMZP69PLBqFUo') {
        return jsonResponse({
          contents: {
            playlistPanelRenderer: {
              contents: [
                {
                  playlistPanelVideoRenderer: {
                    videoId: 'ZP69PLBqFUo',
                    title: { runs: [{ text: 'Song' }] },
                    longBylineText: {
                      runs: [{ text: 'Some Artist' }, { text: ' • ' }, { text: 'Album' }],
                    },
                    lengthText: { runs: [{ text: '3:21' }] },
                  },
                },
              ],
            },
          },
        });
      }
      return { ok: false, status: 404, text: async () => '' };
    });
    const res = await loadPlaylistItems('RDAMVMZP69PLBqFUo', 'en');
    expect(res.status).toBe('ok');
    expect(res.items[0]).toMatchObject({
      id: 'ZP69PLBqFUo',
      title: 'Song',
      artist: 'Some Artist',
      durationSec: 201,
    });
  });
});

describe('add to playlist', () => {
  beforeEach(() => fetchMock.mockReset());

  it('refuses a duplicate and does not call edit_playlist', async () => {
    fetchMock.mockResolvedValue(jsonResponse(playlistPage([item('aaaaaaaaaaa', 'Mine')])));
    await expect(addToPlaylist('PLxyz', 'aaaaaaaaaaa', 'en')).rejects.toBeInstanceOf(
      AlreadyInPlaylistError
    );
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('edit_playlist'))).toBe(false);
  });

  it('adds a new track, and a duplicate when asked to', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('edit_playlist')
        ? jsonResponse({ status: 'STATUS_SUCCEEDED' })
        : jsonResponse(playlistPage([item('aaaaaaaaaaa', 'Mine')]))
    );
    await addToPlaylist('PLxyz', 'ddddddddddd', 'en');
    await addToPlaylist('PLxyz', 'aaaaaaaaaaa', 'en', { allowDuplicate: true });
    const edits = fetchMock.mock.calls.filter((c) => String(c[0]).includes('edit_playlist'));
    expect(edits).toHaveLength(2);
    expect(String(edits[0][1].body)).not.toContain('DEDUPE_OPTION_SKIP');
    expect(String(edits[1][1].body)).toContain('DEDUPE_OPTION_SKIP');
  });

  it('sends only tracks the target does not have yet', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('edit_playlist')
        ? jsonResponse({ status: 'STATUS_SUCCEEDED' })
        : jsonResponse(playlistPage([item('aaaaaaaaaaa', 'Mine')]))
    );
    expect(
      await addMissingTracks('PLxyz', ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'bbbbbbbbbbb'], 'en')
    ).toBe(1);
    expect(await addMissingTracks('PLxyz', ['aaaaaaaaaaa'], 'en')).toBe(0);
    const edits = fetchMock.mock.calls.filter((c) => String(c[0]).includes('edit_playlist'));
    expect(edits).toHaveLength(1);
    const body = String(edits[0][1].body);
    expect(body).not.toContain('aaaaaaaaaaa');
    expect(body.match(/bbbbbbbbbbb/g)).toHaveLength(1);
  });
});

describe('import search', () => {
  it('fails loudly on a rate limit instead of returning no songs', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => '' });
    await expect(searchSongsStrict('Hello Adele', 'en')).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('playlist overrides', () => {
  it('hides deleted and renames renamed playlists for a while', () => {
    const now = 1_000_000;
    rememberPlaylistDeleted('VLPLgone', now);
    rememberPlaylistRenamed('PLren', 'New name', now);
    const list = [
      { id: 'VLPLgone', title: 'Gone' },
      { id: 'VLPLren', title: 'Old' },
      { id: 'VLPLkeep', title: 'Keep' },
    ];
    expect(applyPlaylistOverrides(list, now + 1000).map((p) => p.title)).toEqual([
      'New name',
      'Keep',
    ]);
    expect(applyPlaylistOverrides(list, now + 11 * 60 * 1000)).toHaveLength(3);
  });
});

describe('queue persistence', () => {
  it('persists the playlist id behind "playing from"', () => {
    savePersistedQueue(
      [{ id: 'aaaaaaaaaaa', type: 'track', title: 't', artist: 'a', cover: '' }],
      0,
      'My list',
      0,
      false,
      'PLmine'
    );
    expect(loadPersistedQueue()?.playingFromId).toBe('PLmine');
  });
});

describe('radio', () => {
  beforeEach(() => fetchMock.mockReset());

  it('keeps the song and skips its music video twin', async () => {
    const panel = (videoId: string, title: string) => ({
      playlistPanelVideoRenderer: { videoId, title: { runs: [{ text: title }] } },
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        contents: [
          {
            playlistPanelVideoWrapperRenderer: {
              primaryRenderer: panel('aaaaaaaaaaa', 'Song'),
              counterpart: [{ counterpartRenderer: panel('bbbbbbbbbbb', 'Song (Video)') }],
            },
          },
          panel('ccccccccccc', 'Other'),
        ],
      })
    );
    const tracks = await getRadioTracks('zzzzzzzzzzz', 'en');
    expect(tracks.map((t) => t.id)).toEqual(['aaaaaaaaaaa', 'ccccccccccc']);
  });
});

describe('song twin of an age-gated video', () => {
  const t = (id: string, title: string, artist: string) => ({
    id,
    type: 'track' as const,
    title,
    artist,
    cover: '',
  });

  it('finds the YouTube Music song behind a fan upload title', () => {
    const video = t(
      'qkO6iBwcoe4',
      "Rammstein - ''Pussy'' - (OFFICIAL VIDEO) -  [FIXED AUDIO]",
      'Eliass Kevrelis'
    );
    const found = [
      t('wyS_Kg5MvXI', 'Pussy', 'Rammstein'),
      t('xxxxxxxxxxx', 'Pussy Galore', 'Someone Else'),
    ];
    expect(pickSongTwins(video, found)).toEqual(['wyS_Kg5MvXI']);
  });

  it('accepts a longer song title and either part order', () => {
    const lyrics = t('kDhhjD74C8M', 'GHOSTEMANE - Mercury (LYRICS)', 'Promo Sound');
    expect(pickSongTwins(lyrics, [t('4wvTEbsEOws', 'Mercury: Retrograde', 'Ghostemane')])).toEqual([
      '4wvTEbsEOws',
    ]);
    const swapped = t('Tq92D6wQ1mg', '[MMD] Adios - EVERGLOW [+Motion DL]', 'Projekt Melody');
    expect(pickSongTwins(swapped, [t('aaaaaaaaaaa', 'Adios', 'EVERGLOW')])).toEqual([
      'aaaaaaaaaaa',
    ]);
  });

  it('uses the uploader as the artist and skips other artists and itself', () => {
    const omv = t('p7FCgw_GlWc', 'Famous', 'Kanye West');
    const found = [
      t('p7FCgw_GlWc', 'Famous', 'Kanye West'),
      t('bbbbbbbbbbb', 'Famous', 'Charli XCX'),
      t('Lq2TmRzg19k', 'Famous', 'Kanye West, Rihanna'),
    ];
    expect(pickSongTwins(omv, found)).toEqual(['Lq2TmRzg19k']);
  });
});
