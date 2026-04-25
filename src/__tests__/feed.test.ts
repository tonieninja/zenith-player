import { describe, expect, it } from 'vitest';
import { resolveFeedItem, bylineFromRuns, tidyByline } from '../utils/feed';
import {
  browseMoodId,
  isViewingPlaylist,
  itemClickPlan,
  shouldOpenCollection,
  sidebarClickPlan,
} from '../utils/itemClick';

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
    expect(shouldOpenCollection(artist!)).toBe(true);
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
    expect(shouldOpenCollection(album!)).toBe(true);
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
    expect(itemClickPlan({ id: 'VLPLxxxx', type: 'playlist' }).kind).toBe('play-collection');
    expect(itemClickPlan({ id: 'dQw4w9WgXcQ', type: 'track' }).kind).toBe('play-track');
  });

  it('opens sidebar playlists and episodes-for-later as a page', () => {
    expect(sidebarClickPlan({ id: 'VLSE', type: 'playlist' }).kind).toBe('browse-page');
    expect(sidebarClickPlan({ id: 'SE', type: 'podcast' }).kind).toBe('browse-page');
    expect(sidebarClickPlan({ id: 'VLPLxxxx', type: 'playlist' }).kind).toBe('browse-page');
    expect(sidebarClickPlan({ id: 'VLRDTMAK5uyEnergy', type: 'playlist' }).kind).toBe(
      'browse-page'
    );
    expect(itemClickPlan({ id: 'VLPLxxxx', type: 'playlist' }).kind).toBe('play-collection');
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
    expect(bylineFromRuns([{ text: 'AC/DC' }])).toBe('AC/DC');
    expect(bylineFromRuns([])).toBe('');
  });

  it('still splits the album and length off at the bullets', () => {
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
    ).toBe('Daft Punk, Pharrell Williams & Nile Rodgers • Random Access Memories • 4:08');
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
