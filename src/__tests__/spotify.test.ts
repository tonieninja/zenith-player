import { describe, expect, it, vi } from 'vitest';

const httpFetch = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => httpFetch(...a) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === 'spotify_wait_for_code' ? 'CODE' : null)),
}));

import {
  canReadSpotifyPlaylists,
  exportToSpotify,
  listSpotifyPlaylists,
  matchOnYoutube,
  spotifyPlaylistTracks,
  pickBest,
  scoreMatch,
  setSpotifyClientId,
  MATCH_THRESHOLD,
  type SpotifyCandidate,
} from '../api/spotify';
import type { PlaylistEntry } from '../api/playlistManager';

describe('spotify export', () => {
  const entry = (title: string, artist: string): PlaylistEntry => ({
    videoId: 'xxxxxxxxxxx',
    setVideoId: 's',
    title,
    artist,
    album: '',
    durationSec: 180,
    cover: '',
  });

  it('matches, creates a private playlist and reports unmatched', async () => {
    setSpotifyClientId('cid-test');
    localStorage.setItem(
      'zenith_spotify_token',
      JSON.stringify({ access: 'tok', refresh: 'r', expires: Date.now() + 60_000 })
    );
    httpFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/search')) {
        const cand: { tracks: { items: SpotifyCandidate[] } } = {
          tracks: {
            items: [
              {
                uri: 'spotify:track:aaa',
                name: 'Hello',
                artists: [{ name: 'Adele' }],
                duration_ms: 180000,
              },
            ] as unknown as SpotifyCandidate[],
          },
        };
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify(cand),
          json: async () => cand,
        };
      }
      if (u.endsWith('/me')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ id: 'user1' }),
          json: async () => ({ id: 'user1' }),
        };
      }
      if (u.includes('/playlists') && !u.includes('/items') && !u.includes('/tracks')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () =>
            JSON.stringify({
              id: 'pl1',
              external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' },
            }),
          json: async () => ({
            id: 'pl1',
            external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' },
          }),
        };
      }
      if (u.includes('/items') || u.includes('/tracks')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => '{}',
          json: async () => ({}),
        };
      }
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: async () => '{}',
        json: async () => ({}),
      };
    });

    const res = await exportToSpotify('Mix', 'desc', [
      entry('Hello', 'Adele'),
      entry('Completely Unknown Song XYZ', 'Nobody McNobody'),
    ]);
    expect(res.matched + res.unmatched.length).toBe(2);
    expect(res.playlistUrl).toContain('spotify.com');
    expect(
      scoreMatch(entry('Hello', 'Adele'), {
        name: 'Hello',
        artists: ['Adele'],
        uri: 'spotify:track:aaa',
        durationMs: 180000,
      })
    ).toBeGreaterThan(MATCH_THRESHOLD);
    expect(
      pickBest(entry('Hello', 'Adele'), [
        { name: 'Hello', artists: ['Adele'], uri: 'u', durationMs: 180000 },
      ])
    ).toBeTruthy();
  });
});

describe('spotify import', () => {
  const reply = (body: unknown, status = 200) => ({
    ok: status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  });

  it('pages through playlists, falls back to /tracks and skips local files', async () => {
    localStorage.setItem(
      'zenith_spotify_token',
      JSON.stringify({
        access: 'tok',
        refresh: 'r',
        expires: Date.now() + 60_000,
        scope: 'playlist-read-private',
      })
    );
    expect(canReadSpotifyPlaylists()).toBe(true);
    httpFetch.mockReset();
    httpFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/me/playlists?limit=50'))
        return reply({
          items: [{ id: 'a', name: 'One', items: { total: 2 } }],
          next: 'https://api.spotify.com/v1/me/playlists?offset=50&limit=50',
        });
      if (u.includes('/me/playlists?offset=50'))
        return reply({ items: [{ id: 'b', name: 'Two', tracks: { total: 1 } }], next: null });
      if (u.includes('/items')) return reply({ error: { message: 'nope' } }, 404);
      return reply({
        items: [
          {
            track: {
              type: 'track',
              name: 'Hello',
              artists: [{ name: 'Adele' }],
              duration_ms: 295000,
            },
          },
          { track: { type: 'track', name: 'Mine', artists: [], is_local: true } },
          { track: { type: 'episode', name: 'Pod' } },
          { track: null },
        ],
        next: null,
      });
    });
    expect(await listSpotifyPlaylists()).toEqual([
      { id: 'a', name: 'One', total: 2 },
      { id: 'b', name: 'Two', total: 1 },
    ]);
    expect(await spotifyPlaylistTracks('a')).toEqual([
      { title: 'Hello', artist: 'Adele', durationSec: 295 },
    ]);
  });

  it('old tokens without read access need a new connection', () => {
    localStorage.setItem(
      'zenith_spotify_token',
      JSON.stringify({ access: 'tok', refresh: 'r', expires: Date.now() + 60_000 })
    );
    expect(canReadSpotifyPlaylists()).toBe(false);
  });

  it('matches tracks on youtube music and keeps the misses', async () => {
    const search = vi.fn(async (q: string) =>
      q.startsWith('Hello')
        ? [
            {
              id: 'cover000000',
              title: 'Hello (Piano Cover)',
              artist: 'Someone',
              durationSec: 250,
            },
            { id: 'YQHsXMglC9A', title: 'Hello', artist: 'Adele', durationSec: 296 },
          ]
        : []
    );
    const r = await matchOnYoutube(
      [
        { title: 'Hello', artist: 'Adele', durationSec: 295 },
        { title: 'Nothing Here', artist: 'Nobody', durationSec: 100 },
      ],
      search
    );
    expect(r.videoIds).toEqual(['YQHsXMglC9A']);
    expect(r.unmatched.map((t) => t.title)).toEqual(['Nothing Here']);
  });
});
