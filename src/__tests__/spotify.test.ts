import { describe, expect, it, vi } from 'vitest';

const httpFetch = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => httpFetch(...a) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === 'spotify_wait_for_code' ? 'CODE' : null)),
}));

import {
  exportToSpotify,
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
