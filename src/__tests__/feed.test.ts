import { describe, expect, it } from 'vitest';
import type { Section, Track } from '../api/youtube';
import {
  resolveFeedItem,
  bylineFromRuns,
  tidyByline,
  upsertSections,
  shelfKey,
  QUICK_PICKS_SHELF,
  hiddenShelfEntry,
  isShelfHidden,
  loadHiddenShelves,
  saveHiddenShelves,
  saveHomeSnapshot,
  loadHomeSnapshot,
} from '../utils/feed';
import {
  browseMoodId,
  hitsPlayIcon,
  isViewingPlaylist,
  itemClickPlan,
  sidebarClickPlan,
} from '../utils/tracks';

describe('search / feed item identity', () => {
  it('opens an artist page rather than playing the overlay song (Instant Crush)', () => {
    const artist = resolveFeedItem({
      videoId: 'a5uQMwRMHcs',
      browseId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
      pageType: 'MUSIC_PAGE_TYPE_ARTIST',
      subtitle: 'Artist',
      primaryIsBrowse: true,
    });
    expect(artist).toEqual({ id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw', type: 'artist' });
    expect(itemClickPlan(artist!).kind).toBe('browse-page');
  });

  it('still treats a song row as a track even when the subtitle links the artist channel', () => {
    const track = resolveFeedItem({
      videoId: 'anHK6aMMcOM',
      browseId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
      pageType: null,
      subtitle: 'Daft Punk • Song',
      primaryIsBrowse: false,
    });
    expect(track).toEqual({ id: 'anHK6aMMcOM', type: 'track' });
    expect(itemClickPlan(track!).kind).toBe('play-track');
  });

  it('classifies albums and playlists from page type / id prefix', () => {
    expect(
      resolveFeedItem({
        browseId: 'MPREb_albumId',
        pageType: 'MUSIC_PAGE_TYPE_ALBUM',
        primaryIsBrowse: true,
      })
    ).toEqual({ id: 'MPREb_albumId', type: 'album' });
    expect(
      resolveFeedItem({
        browseId: 'VLPLxxxx',
        pageType: 'MUSIC_PAGE_TYPE_PLAYLIST',
        primaryIsBrowse: true,
      })
    ).toEqual({ id: 'VLPLxxxx', type: 'playlist' });
    expect(itemClickPlan({ id: 'MPREb_albumId', type: 'album' }).kind).toBe('browse-page');
  });

  it('opens an album page rather than playing the overlay first track (Random Access Memories)', () => {
    const album = resolveFeedItem({
      videoId: 'anHK6aMMcOM',
      browseId: 'MPREb_ramAlbum',
      pageType: 'MUSIC_PAGE_TYPE_ALBUM',
      subtitle: 'Daft Punk • 2013',
      primaryIsBrowse: true,
    });
    expect(album).toEqual({ id: 'MPREb_ramAlbum', type: 'album' });
    expect(itemClickPlan(album!).kind).toBe('browse-page');
  });

  it('still classifies MPREb rows as albums when the overlay videoId is present without pageType', () => {
    const album = resolveFeedItem({
      videoId: 'anHK6aMMcOM',
      browseId: 'MPREb_ramAlbum',
      primaryIsBrowse: true,
    });
    expect(album).toEqual({ id: 'MPREb_ramAlbum', type: 'album' });
  });

  it('strips MPLAUC library prefix so the artist page gets a plain channel id', () => {
    expect(
      resolveFeedItem({
        browseId: 'MPLAUC_x5XG1OV2P6uZZ5FSM9Ttw',
        primaryIsBrowse: true,
      })
    ).toEqual({ id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw', type: 'artist' });
  });
});

describe('optimistic click routing', () => {
  it('sends artist/profile/album clicks to a browse page, not the player', () => {
    expect(itemClickPlan({ id: 'UCabc', type: 'artist' }).kind).toBe('browse-page');
    expect(itemClickPlan({ id: 'UCabc', type: 'profile' }).kind).toBe('browse-page');
    expect(itemClickPlan({ id: 'MPREb_x', type: 'album' }).kind).toBe('browse-page');
    expect(itemClickPlan({ id: 'VLPLxxxx', type: 'playlist' }).kind).toBe('browse-page');
    expect(itemClickPlan({ id: 'dQw4w9WgXcQ', type: 'track' }).kind).toBe('play-track');
  });

  it('opens playlists like YouTube Music, while the play button plays them at once', () => {
    expect(itemClickPlan({ id: 'VLRDCLAK5uy_k1Wu8', type: 'playlist' }).kind).toBe('browse-page');
    expect(itemClickPlan({ id: 'VLRDTMAK5uyEnergy', type: 'playlist' }).kind).toBe('browse-page');
    expect(itemClickPlan({ id: 'MPSPPLxyz', type: 'podcast' }).kind).toBe('browse-page');
    expect(itemClickPlan({ id: 'VLPLxxxx', type: 'playlist' }, true).kind).toBe('play-collection');
    expect(itemClickPlan({ id: 'MPREb_x', type: 'album' }, true).kind).toBe('play-collection');
    expect(itemClickPlan({ id: 'UCabc', type: 'artist' }, true).kind).toBe('browse-page');
    expect(itemClickPlan({ id: 'dQw4w9WgXcQ', type: 'track' }, true).kind).toBe('play-track');
    // radio od utworu lub wykonawcy nie ma strony, więc dalej gra od razu
    expect(itemClickPlan({ id: 'VLRDAMVMdQw4w9WgXcQ', type: 'playlist' }).kind).toBe(
      'play-collection'
    );
    expect(itemClickPlan({ id: 'RDEMni3jl65KF37F9JYsJM8DGg', type: 'playlist' }).kind).toBe(
      'play-collection'
    );
  });

  it('plays only when the cover icon of a row is clicked', () => {
    const row = document.createElement('button');
    row.innerHTML = '<div class="search-result-play-icon"><svg></svg></div><span>t</span>';
    expect(hitsPlayIcon({ target: row.querySelector('svg') })).toBe(true);
    expect(hitsPlayIcon({ target: row.querySelector('span') })).toBe(false);
    expect(hitsPlayIcon({ target: null })).toBe(false);
  });

  it('opens sidebar playlists and episodes-for-later as a page', () => {
    expect(sidebarClickPlan({ id: 'VLSE', type: 'playlist' }).kind).toBe('browse-page');
    expect(sidebarClickPlan({ id: 'SE', type: 'podcast' }).kind).toBe('browse-page');
    expect(sidebarClickPlan({ id: 'VLPLxxxx', type: 'playlist' }).kind).toBe('browse-page');
    expect(sidebarClickPlan({ id: 'VLRDTMAK5uyEnergy', type: 'playlist' }).kind).toBe(
      'browse-page'
    );
    expect(sidebarClickPlan({ id: 'VLRDAMVMdQw4w9WgXcQ', type: 'playlist' }).kind).toBe(
      'browse-page'
    );
  });

  it('classifies generated mix / supermix browse ids as playlists', () => {
    expect(
      resolveFeedItem({
        browseId: 'RDTMAK5uyEnergy',
        primaryIsBrowse: true,
      })
    ).toEqual({ id: 'RDTMAK5uyEnergy', type: 'playlist' });
    expect(
      resolveFeedItem({
        browseId: 'RDTMAK5uyEnergy',
        videoId: 'anHK6aMMcOM',
        primaryIsBrowse: true,
      })
    ).toEqual({ id: 'RDTMAK5uyEnergy', type: 'playlist' });
  });

  it('leaves a deleted playlist view and ignores a different open playlist', () => {
    const open = browseMoodId('VLPL123');
    expect(isViewingPlaylist('mood', open, 'PL123')).toBe(true);
    expect(isViewingPlaylist('mood', open, 'VLPL123')).toBe(true);
    expect(isViewingPlaylist('mood', open, 'VLPL999')).toBe(false);
    expect(isViewingPlaylist('home', open, 'PL123')).toBe(false);
    expect(isViewingPlaylist('mood', 'focus', 'PL123')).toBe(false);
  });
});

describe('artist bylines from YouTube Music', () => {
  const runs = [
    { text: 'Daft Punk' },
    { text: ', ' },
    { text: 'Pharrell Williams' },
    { text: ' & ' },
    { text: 'Nile Rodgers' },
  ];

  it('joins artist runs into one credit instead of one entry per separator', () => {
    expect(bylineFromRuns(runs)).toBe('Daft Punk, Pharrell Williams & Nile Rodgers');
    expect(bylineFromRuns([{ text: 'A' }, { text: ' / ' }, { text: 'B' }])).toBe('A / B');
    expect(
      bylineFromRuns([{ text: 'Singiel' }, { text: ' • ' }, { text: 'X' }, { text: ' • 2023' }])
    ).toBe('X • 2023');
    expect(bylineFromRuns([{ text: 'Odcinek' }, { text: ' • ' }, { text: 'Pod' }])).toBe('Pod');
    expect(bylineFromRuns([{ text: 'AC/DC' }])).toBe('AC/DC');
    expect(bylineFromRuns([])).toBe('');
  });

  it('keeps the album but drops the length, which the row carries separately', () => {
    expect(
      bylineFromRuns([
        { text: 'Song' },
        { text: ' • ' },
        ...runs,
        { text: ' • ' },
        { text: 'Random Access Memories' },
        { text: ' • ' },
        { text: '4:08' },
      ])
    ).toBe('Daft Punk, Pharrell Williams & Nile Rodgers • Random Access Memories');
  });

  it('repairs bylines saved by older builds', () => {
    expect(tidyByline('Daft Punk • , • Pharrell Williams • & • Nile Rodgers')).toBe(
      'Daft Punk, Pharrell Williams & Nile Rodgers'
    );
    expect(tidyByline('A • / • B • Album • 2013')).toBe('A / B • Album • 2013');
    expect(tidyByline('Queen • A Night at the Opera')).toBe('Queen • A Night at the Opera');
  });

  it('repairs separator bullets already present in the runs', () => {
    expect(
      bylineFromRuns([
        { text: 'Daft Punk' },
        { text: ' • ' },
        { text: ', ' },
        { text: ' • ' },
        { text: 'Pharrell Williams' },
        { text: ' • ' },
        { text: '& ' },
        { text: ' • ' },
        { text: 'Nile Rodgers' },
      ])
    ).toBe('Daft Punk, Pharrell Williams & Nile Rodgers');
  });
});

describe('byline play counts', () => {
  it('drops play and view counts but keeps the artist and years', () => {
    expect(tidyByline('Justin Bieber • 1.5B plays')).toBe('Justin Bieber');
    expect(tidyByline('Kingfishr • 291K views')).toBe('Kingfishr');
    expect(tidyByline('Sanah • 1,5 mln odtworzeń')).toBe('Sanah');
    expect(tidyByline('Sanah • 291 tys. wyświetleń')).toBe('Sanah');
    expect(tidyByline('Daft Punk • 2013')).toBe('Daft Punk • 2013');
    expect(tidyByline('Avi, Oskar • 3M plays')).toBe('Avi, Oskar');
    expect(tidyByline('Daft Punk • 4:09')).toBe('Daft Punk');
    expect(tidyByline('Mix • 1:02:33')).toBe('Mix');
    expect(tidyByline('7 min 9 sec • DJ Vini')).toBe('DJ Vini');
    expect(tidyByline('1.5B plays • 4:09')).toBe('1.5B plays • 4:09');
  });

  it('plays an episode card (MPED + video id) instead of opening an empty album', () => {
    expect(resolveFeedItem({ browseId: 'MPED_JTOeHJLkhM' })).toEqual({
      id: '_JTOeHJLkhM',
      type: 'track',
    });
    expect(resolveFeedItem({ browseId: 'MPEDi_ZUw4sB7RE', videoId: 'i_ZUw4sB7RE' })).toEqual({
      id: 'i_ZUw4sB7RE',
      type: 'track',
    });
  });
});

const track = (id: string): Track => ({ id, type: 'track', title: id, artist: '', cover: '' });
const shelf = (title: string, n = 2, extra: Partial<Section> = {}): Section => ({
  title,
  items: Array.from({ length: n }, (_, i) => track(`${title}-${i}`)),
  ...extra,
});

describe('home shelves merge', () => {
  it('replaces a shelf with the same title in place and appends new ones', () => {
    const a = shelf('A');
    const b = shelf('B');
    const b2 = shelf('B', 3);
    const next = upsertSections([a, b], [b2, shelf('C')]);
    expect(next.map((s) => s.title)).toEqual(['A', 'B', 'C']);
    expect(next[1]).toBe(b2);
  });

  it('keeps the same array when nothing changed', () => {
    const cur = [shelf('A'), shelf('B')];
    expect(upsertSections(cur, [cur[1]])).toBe(cur);
  });
});

describe('hidden home shelves', () => {
  it('keys by the "more" target when there is one, else by title', () => {
    expect(shelfKey(shelf('New releases', 1, { more: { browseId: 'FEmusic_new_releases' } }))).toBe(
      'FEmusic_new_releases'
    );
    expect(shelfKey(shelf(' Party Music '))).toBe('party music');
  });

  it('keeps a fixed key for quick picks and tells shelves with one target apart by params', () => {
    expect(shelfKey(shelf('Szybki wybór', 1, { id: QUICK_PICKS_SHELF }))).toBe(QUICK_PICKS_SHELF);
    const mood = (params: string) =>
      shelfKey(shelf('x', 1, { more: { browseId: 'FEmusic_moods_and_genres_category', params } }));
    expect(mood('a')).not.toBe(mood('b'));
  });

  it('moves a quick picks key saved under the translated title', () => {
    localStorage.setItem('zenith_home_hidden', JSON.stringify({ 'szybki wybór': 'Szybki wybór' }));
    expect(loadHiddenShelves()).toEqual({ [QUICK_PICKS_SHELF]: { title: 'Szybki wybór' } });
    localStorage.removeItem('zenith_home_hidden');
  });

  it('remembers the first items of a title-keyed shelf and finds it again in another language', () => {
    const en = shelf('Party music', 8);
    const entry = hiddenShelfEntry(en);
    expect(entry.ids).toHaveLength(6);
    expect(hiddenShelfEntry(shelf('x', 3, { more: { browseId: 'FEmusic_x' } }))).toEqual({
      title: 'x',
    });
    const hidden = { [shelfKey(en)]: entry };
    const pl = { ...en, title: 'Muzyka na imprezę', items: [...en.items].reverse() };
    expect(isShelfHidden(hidden, en)).toBe(true);
    expect(isShelfHidden(hidden, pl)).toBe(true);
    // połowa wspólnych utworów to jeszcze nie ta sama półka
    const mixed = { ...pl, items: [...en.items.slice(0, 3), ...shelf('Other', 5).items] };
    expect(isShelfHidden(hidden, mixed)).toBe(false);
    expect(isShelfHidden(hidden, shelf('Other', 8))).toBe(false);
    // półka z celem „Więcej” ma już stały klucz, więc wspólne utwory jej nie ukrywają
    expect(isShelfHidden(hidden, { ...pl, more: { browseId: 'FEmusic_y' } })).toBe(false);
  });

  it('survives a restart and clears the key when empty', () => {
    const party = { title: 'Party music', ids: ['a', 'b'] };
    saveHiddenShelves({ 'party music': party });
    expect(loadHiddenShelves()).toEqual({ 'party music': party });
    localStorage.setItem(
      'zenith_home_hidden',
      JSON.stringify({ old: 'Old', bad: 1, junk: { title: 'J', ids: ['a', 2] } })
    );
    expect(loadHiddenShelves()).toEqual({
      old: { title: 'Old' },
      junk: { title: 'J', ids: ['a'] },
    });
    saveHiddenShelves({});
    expect(localStorage.getItem('zenith_home_hidden')).toBeNull();
    localStorage.setItem('zenith_home_hidden', '[1]');
    expect(loadHiddenShelves()).toEqual({});
  });
});

describe('home snapshot for a cold start', () => {
  it('is read back only for the same language and sign-in state, trimmed', () => {
    const sections = Array.from({ length: 10 }, (_, i) => shelf(`S${i}`, 20));
    saveHomeSnapshot({ key: 'FEmusic_home:pl:0', sections, quickPicks: [track('q')], chips: [] });
    const snap = loadHomeSnapshot('FEmusic_home:pl:0')!;
    expect(snap.sections).toHaveLength(8);
    expect(snap.sections[0].items).toHaveLength(12);
    expect(snap.quickPicks).toHaveLength(1);
    expect(loadHomeSnapshot('FEmusic_home:pl:1')).toBeNull();
    expect(loadHomeSnapshot('FEmusic_home:en:0')).toBeNull();
    localStorage.setItem('zenith_home_cache_v1', '{broken');
    expect(loadHomeSnapshot('FEmusic_home:pl:0')).toBeNull();
  });
});
