import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => '' }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

import {
  classifyPlaylist,
  collectEntries,
  detailActions,
  filterAndSort,
  moveAction,
  parseDuration,
  parseTrackCount,
  reorder,
  toCsv,
  type PlaylistEntry,
  type PlaylistSummary,
  findHeader,
  markOwned,
} from '../api/playlistManager';
import {
  normalizeTitle,
  pickBest,
  pkceChallenge,
  randomVerifier,
  scoreMatch,
  similarity,
  splitArtists,
} from '../api/spotify';

const row = (videoId: string, setVideoId: string, title: string, artist: string, dur: string) => ({
  musicResponsiveListItemRenderer: {
    playlistItemData: { videoId, playlistSetVideoId: setVideoId },
    flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: artist }] } } },
    ],
    fixedColumns: [
      { musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: dur }] } } },
    ],
  },
});

const entry = (n: number): PlaylistEntry => ({
  videoId: `vid${n}`.padEnd(11, 'x'),
  setVideoId: `set${n}`,
  title: `T${n}`,
  artist: 'A',
  album: '',
  durationSec: 180,
  cover: '',
});

describe('playlist manager data', () => {
  it('reads entries with their slot ids and skips the suggestions shelf', () => {
    const page = {
      contents: [
        {
          musicPlaylistShelfRenderer: {
            contents: [
              row('aaaaaaaaaaa', 's1', 'One', 'Ado', '3:05'),
              row('bbbbbbbbbbb', 's2', 'Two', 'Ado', '1:02:03'),
            ],
          },
        },
        {
          musicShelfRenderer: {
            title: { runs: [{ text: 'Suggestions' }] },
            contents: [row('ccccccccccc', 's3', 'Nope', 'X', '2:00')],
          },
        },
      ],
    };
    const got = collectEntries(page);
    expect(got.map((e) => e.title)).toEqual(['One', 'Two']);
    expect(got[0]).toMatchObject({ setVideoId: 's1', artist: 'Ado', durationSec: 185 });
    expect(got[1].durationSec).toBe(3723);
  });

  it('parses counts and durations in both languages', () => {
    expect(parseTrackCount('tonieninja • 28 tracks')).toBe(28);
    expect(parseTrackCount('Playlista • 1,204 utworów')).toBe(1204);
    expect(parseTrackCount('Auto playlist')).toBeNull();
    expect(parseDuration('4:07')).toBe(247);
    expect(parseDuration('soon')).toBeNull();
  });

  it('sorts out whose playlist is whose', () => {
    expect(
      classifyPlaylist({ id: 'VLLM', title: 'Liked Music', artist: 'Auto playlist' }, 'me')
    ).toBe('liked');
    expect(
      classifyPlaylist(
        { id: 'VLRDTMAK5uy', title: 'Supermix', artist: 'Mix • YouTube Music' },
        'me'
      )
    ).toBe('generated');
    expect(
      classifyPlaylist(
        { id: 'VLPL1', title: 'Gym', artist: 'tonieninja • 28 tracks' },
        'tonieninja'
      )
    ).toBe('own');
    expect(
      classifyPlaylist(
        { id: 'VLPL2', title: 'Someone', artist: 'DJ Bob • 10 tracks' },
        'tonieninja'
      )
    ).toBe('saved');
  });

  it('filters and sorts the list', () => {
    const base = { subtitle: '', cover: '', editable: false } as const;
    const list: PlaylistSummary[] = [
      { ...base, id: '1', title: 'Zebra', count: 3, kind: 'own' },
      { ...base, id: '2', title: 'apple', count: 30, kind: 'saved' },
      { ...base, id: '3', title: 'Mango', count: null, kind: 'own' },
    ];
    expect(filterAndSort(list, '', 'title').map((p) => p.id)).toEqual(['2', '3', '1']);
    expect(filterAndSort(list, '', 'count').map((p) => p.id)).toEqual(['2', '1', '3']);
    expect(filterAndSort(list, 'an', 'default', ['own']).map((p) => p.id)).toEqual(['3']);
  });

  it('builds the right move action for drag and drop', () => {
    const list = [entry(0), entry(1), entry(2), entry(3)];
    expect(moveAction(list, 0, 2)).toEqual({
      action: 'ACTION_MOVE_VIDEO_BEFORE',
      setVideoId: 'set0',
      movedSetVideoIdSuccessor: 'set3',
    });
    expect(moveAction(list, 3, 0)).toEqual({
      action: 'ACTION_MOVE_VIDEO_BEFORE',
      setVideoId: 'set3',
      movedSetVideoIdSuccessor: 'set0',
    });
    expect(moveAction(list, 1, 3)).toEqual({
      action: 'ACTION_MOVE_VIDEO_BEFORE',
      setVideoId: 'set1',
    });
    expect(moveAction(list, 2, 2)).toBeNull();
    expect(reorder(list, 0, 2).map((e) => e.setVideoId)).toEqual(['set1', 'set2', 'set0', 'set3']);
  });

  it('maps detail edits to edit_playlist actions', () => {
    expect(detailActions({ title: ' New ', description: 'd', privacy: 'UNLISTED' })).toEqual([
      { action: 'ACTION_SET_PLAYLIST_NAME', playlistName: 'New' },
      { action: 'ACTION_SET_PLAYLIST_DESCRIPTION', playlistDescription: 'd' },
      { action: 'ACTION_SET_PLAYLIST_PRIVACY', playlistPrivacy: 'UNLISTED' },
    ]);
    expect(() => detailActions({ title: '  ' })).toThrow();
  });

  it('quotes csv cells that need it', () => {
    const csv = toCsv('Mix', [{ ...entry(1), title: 'Hello, "world"', artist: 'A' }]);
    expect(csv.split('\n')[2]).toBe(
      '"Hello, ""world""",A,,180,https://music.youtube.com/watch?v=vid1xxxxxxx'
    );
  });
});

describe('spotify matching', () => {
  it('cleans titles and artists', () => {
    expect(normalizeTitle('Numb (Official Music Video)')).toBe('numb');
    expect(normalizeTitle('Tamagotchi (Remix) (feat. Dawid Podsiadło)')).toBe('tamagotchi remix');
    expect(splitArtists('Taco Hemingway & Rumak • Umowa')).toEqual([
      'taco hemingway',
      'rumak',
      'umowa',
    ]);
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('abc', 'xyz')).toBe(0);
  });

  it('picks the right candidate and rejects bad ones', () => {
    const e = { ...entry(1), title: 'Marmur', artist: 'Taco Hemingway', durationSec: 200 };
    const good = {
      uri: 'spotify:track:good',
      name: 'Marmur',
      artists: ['Taco Hemingway'],
      durationMs: 201000,
    };
    const cover = {
      uri: 'spotify:track:cover',
      name: 'Marmur - Cover',
      artists: ['Somebody'],
      durationMs: 150000,
    };
    const other = {
      uri: 'spotify:track:x',
      name: 'Totally Different',
      artists: ['Nobody'],
      durationMs: 100000,
    };
    expect(scoreMatch(e, good)).toBeGreaterThan(scoreMatch(e, cover));
    expect(pickBest(e, [cover, good, other])?.c.uri).toBe('spotify:track:good');
    expect(pickBest(e, [other])).toBeNull();
  });

  it('makes a valid PKCE pair', async () => {
    const v = randomVerifier();
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{64}$/);
    // RFC 7636 appendix B
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });
});

describe('ownership', () => {
  it('treats an edit header as proof of ownership', () => {
    const own = findHeader({ header: { musicPlaylistEditHeaderRenderer: { privacy: 'PRIVATE' } } });
    expect(own.owned).toBe(true);
    expect(own.privacy).toBe('PRIVATE');
    expect(findHeader({ header: { musicResponsiveHeaderRenderer: {} } }).owned).toBe(false);
  });

  it('flips a saved summary to editable once we know it is ours', () => {
    const list = [
      {
        id: 'VLPLabc',
        title: 'mine',
        subtitle: '',
        cover: '',
        count: 3,
        kind: 'saved' as const,
        editable: false,
      },
      {
        id: 'VLLM',
        title: 'Liked',
        subtitle: '',
        cover: '',
        count: 3,
        kind: 'liked' as const,
        editable: false,
      },
    ];
    const out = markOwned(list, 'PLabc');
    expect(out[0]).toMatchObject({ kind: 'own', editable: true });
    expect(markOwned(list, 'LM')[1].editable).toBe(false);
  });
});

describe('tracksLabel', () => {
  it('picks the right plural form', async () => {
    const { tracksLabel } = await import('../components/PlaylistManager');
    const { translations } = await import('../i18n');
    expect(tracksLabel(1, translations.en)).toBe('1 track');
    expect(tracksLabel(3, translations.en)).toBe('3 tracks');
    expect(tracksLabel(1, translations.pl)).toBe('1 utwór');
    expect(tracksLabel(3, translations.pl)).toBe('3 utwory');
    expect(tracksLabel(12, translations.pl)).toBe('12 utworów');
    expect(tracksLabel(22, translations.pl)).toBe('22 utwory');
  });
});
