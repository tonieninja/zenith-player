import { beforeEach, describe, expect, it, vi } from 'vitest';
import fx from './fixtures/ytm/home_feed.json';

// prawdziwe odpowiedzi gościa (pl, en) przycięte do 3 pozycji na półkę
type Args = { browseId: string; params: string | null; continuation?: string; hl: string };
let cookie = '';
let route: (a: Args) => unknown | Promise<unknown> = () => ({});
const calls: Args[] = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: Args) => {
    if (cmd === 'get_ytm_cookies') return cookie;
    if (cmd !== 'ytm_browse') return null;
    calls.push(args);
    return JSON.stringify(await route(args));
  },
}));
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: async () => {
    throw new Error('offline');
  },
}));

const SIGNED = 'SAPISID=test; __Secure-3PSID=test';

const tokenOf = (node: unknown): string | null => {
  if (!node || typeof node !== 'object') return null;
  const n = node as Record<string, any>;
  const t =
    n.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ??
    n.nextContinuationData?.continuation;
  if (typeof t === 'string') return t;
  for (const v of Object.values(n)) {
    const found = tokenOf(v);
    if (found) return found;
  }
  return null;
};

/** Główna z kolejnymi stronami podpiętymi pod ich tokeny. */
const homeRoute = (pages: unknown[], extra: (a: Args) => unknown = () => ({ error: 1 })) => {
  const byToken = new Map(pages.slice(0, -1).map((p, i) => [tokenOf(p), pages[i + 1]]));
  return (a: Args) => {
    if (a.continuation) return byToken.get(a.continuation) ?? { error: 1 };
    if (a.browseId === 'FEmusic_home' && !a.params) return pages[0];
    return extra(a);
  };
};

const contCalls = () => calls.filter((c) => c.continuation).length;

const mixShelf = (title: string, ids: string[]) => ({
  musicCarouselShelfRenderer: {
    header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: title }] } } },
    contents: ids.map((id, i) => ({
      musicTwoRowItemRenderer: {
        title: { runs: [{ text: `My Mix ${i + 1}` }] },
        subtitle: { runs: [{ text: 'Artist' }] },
        navigationEndpoint: {
          browseEndpoint: {
            browseId: `VL${id}`,
            browseEndpointContextSupportedConfigs: {
              browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_PLAYLIST' },
            },
          },
        },
      },
    })),
  },
});

/** Kanał chipu w kształcie zalogowanego: gościnny kanał z półką osobistych miksów na górze. */
const signedChipFeed = () => {
  const feed = structuredClone(fx.chipEnergize) as any;
  const list = feed.contents.singleColumnBrowseResultsRenderer.tabs[0].tabRenderer.content;
  list.sectionListRenderer.contents.unshift(
    mixShelf('Mixed for you: Energize', ['RDTMAK5uy_energize1', 'RDTMAK5uy_energize2'])
  );
  return feed;
};

let yt: typeof import('../api/youtube');

beforeEach(async () => {
  vi.resetModules();
  cookie = '';
  calls.length = 0;
  route = () => ({});
  yt = await import('../api/youtube');
});

describe('home feed', () => {
  it('turns the song-mix shelf into quick picks and keeps straplines, chips and "more"', async () => {
    route = homeRoute(fx.pl);
    const feed = await yt.getHomeFeed('pl');
    expect(feed.key).toBe('FEmusic_home:pl:0');
    expect(feed.quickPicks.length).toBeGreaterThan(0);
    expect(feed.quickPicks.every((t) => t.type === 'track')).toBe(true);
    expect(feed.sections.map((s) => s.title)).not.toContain('Składanki na bazie utworu');
    expect(feed.sections[0]).toMatchObject({
      title: 'Muzyka na imprezę',
      strapline: "IT'S THAT TIME OF THE WEEK",
    });
    expect(feed.more).toBe(true);
    const chips = Object.fromEntries(feed.chips.map((c) => [c.title, c.browseId]));
    // gość: chip z odpowiednikiem w kategoriach otwiera kategorię, reszta kanał chipu
    expect(chips['Relaks']).toBe(yt.MOODS_AND_MOMENTS.find((m) => m.id === 'chill')!.browseId);
    expect(chips['Podcasty']).toMatch(/^FEmusic_home::/);
  });

  it('loads one continuation page per call and stops after the last one', async () => {
    route = homeRoute(fx.pl);
    await yt.getHomeFeed('pl');
    const [a, b] = await Promise.all([yt.getHomeNextPage('pl'), yt.getHomeNextPage('pl')]);
    expect(a).toBe(b);
    expect(contCalls()).toBe(1);
    const releases = a.sections.find((s) => s.title === 'Nowości');
    expect(releases?.more?.browseId).toBe('FEmusic_new_releases_albums');
    expect(a.more).toBe(true);
    const last = await yt.getHomeNextPage('pl');
    expect(last.sections.length).toBeGreaterThan(0);
    expect(last.more).toBe(false);
    expect((await yt.getHomeNextPage('pl')).sections).toEqual([]);
    expect(contCalls()).toBe(2);
    // powrót na Główną z pamięci podręcznej oddaje też doładowane półki
    const again = await yt.getHomeFeed('pl');
    expect(again.sections.map((s) => s.title)).toContain('Nowości');
    expect(again.more).toBe(false);
  });

  it('moves quick picks that arrive with a continuation page', async () => {
    route = homeRoute(fx.en);
    const feed = await yt.getHomeFeed('en');
    expect(feed.quickPicks).toEqual([]);
    const page = await yt.getHomeNextPage('en');
    expect(page.quickPicks.length).toBeGreaterThan(0);
    expect(page.sections.map((s) => s.title)).not.toContain('Quick picks');
    expect((await yt.getHomeFeed('en')).quickPicks).toEqual(page.quickPicks);
  });

  it('does not invent quick picks from playlist shelves', async () => {
    const first = structuredClone(fx.pl[0]) as any;
    const list = first.contents.singleColumnBrowseResultsRenderer.tabs[0].tabRenderer.content;
    list.sectionListRenderer.contents = list.sectionListRenderer.contents.filter(
      (s: any) => !JSON.stringify(s).includes('Składanki na bazie utworu')
    );
    route = homeRoute([first, ...fx.pl.slice(1)]);
    const feed = await yt.getHomeFeed('pl');
    expect(feed.quickPicks).toEqual([]);
    expect(feed.sections.length).toBeGreaterThan(0);
  });

  it('drops a continuation that belongs to a home feed fetched again meanwhile', async () => {
    let release: () => void = () => {};
    const base = homeRoute(fx.pl);
    route = (a) => (a.continuation ? new Promise((r) => (release = () => r(base(a)))) : base(a));
    await yt.getHomeFeed('pl');
    const pending = yt.getHomeNextPage('pl');
    await vi.waitFor(() => expect(contCalls()).toBe(1));
    yt.clearHomeBrowseCache();
    await yt.getHomeFeed('pl');
    release();
    const page = await pending;
    expect(page.sections).toEqual([]);
    expect(page.more).toBe(true);
  });

  it('shows podcast episodes from the Podcasts chip with the show name', async () => {
    route = () => fx.podcasts;
    const [shelf] = await yt.getMoodPage('FEmusic_home::podcasts', 'Podcasts', 'en');
    expect(shelf.title).toBe('History');
    expect(shelf.items[0]).toMatchObject({ type: 'track', artist: 'Scandalous Women' });
    expect(shelf.items[0].id).toMatch(/^[\w-]{11}$/);
  });

  it('keeps the grid title of a mood page and marks it as a wrapping grid', async () => {
    route = () => fx.christmas;
    const page = await yt.getMoodPage('FEmusic_moods_and_genres_category::xmas', 'Christmas', 'en');
    expect(page.map((s) => [s.title, s.layout])).toEqual([
      ['Spotlight', 'grid'],
      ['Featured playlists', undefined],
    ]);
  });

  it('signed in: chips open the filtered home feed', async () => {
    cookie = SIGNED;
    route = homeRoute(fx.en);
    const feed = await yt.getHomeFeed('en');
    expect(feed.key).toBe('FEmusic_home:en:1');
    expect(feed.chips.length).toBeGreaterThan(5);
    expect(feed.chips.every((c) => c.browseId.startsWith('FEmusic_home::'))).toBe(true);
  });
});

describe('mood page mixes', () => {
  const ENERGIZE = 'FEmusic_moods_and_genres_category::ggMPOg1uX1JOQWZFeDByc2Jm';
  const extra = (a: Args) =>
    a.browseId === 'FEmusic_home' ? signedChipFeed() : (fx.chipEnergize as unknown);

  it('signed in: puts the mixes from the chip with the same name on top', async () => {
    cookie = SIGNED;
    route = homeRoute(fx.en, extra);
    const page = await yt.getMoodPage(ENERGIZE, 'Energize', 'en');
    expect(page[0].title).toBe('Mixes for you');
    expect(page[0].items.map((t) => t.id.replace(/^VL/, ''))).toEqual([
      'RDTMAK5uy_energize1',
      'RDTMAK5uy_energize2',
    ]);
    expect(page.length).toBeGreaterThan(1);
    expect(calls.some((c) => c.browseId === 'FEmusic_home' && c.params)).toBe(true);
  });

  it('guest: shows the category page as it is', async () => {
    route = homeRoute(fx.en, extra);
    const page = await yt.getMoodPage(ENERGIZE, 'Energize', 'en');
    expect(page[0].title).not.toBe('Mixes for you');
    expect(calls.some((c) => c.browseId === 'FEmusic_home')).toBe(false);
  });
});

describe('moods and genres', () => {
  it('reads groups, names and stripe colours from the live page', () => {
    const groups = yt.parseMoodGroups(fx.moods);
    expect(groups.map((g) => g.title)).toEqual(['Moods & moments', 'Genres']);
    for (const g of groups) {
      expect(g.items.length).toBeGreaterThan(0);
      for (const c of g.items) {
        expect(c.color).toMatch(/^#[0-9a-f]{6}$/);
        expect(c.browseId).toMatch(/^FEmusic_moods_and_genres_category::/);
      }
    }
  });

  it('falls back (null) when the page fails', async () => {
    route = () => ({ error: 1 });
    expect(await yt.getMoodGroups('en')).toBeNull();
  });
});
