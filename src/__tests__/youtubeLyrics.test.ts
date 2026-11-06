import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => '') }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
const httpFetch = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => httpFetch(...a) }));

import {
  captionTrackUrlsFromPlayer,
  getLyrics,
  withVttFmt,
  youtubeTimedtextHeaders,
  type Track,
} from '../api/youtube';

const track: Track = {
  id: 'szampanVid1',
  type: 'track',
  title: 'Szampan',
  artist: 'Sanah',
  cover: '',
};

const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
raz

00:00:02.000 --> 00:00:04.000
dwa

00:00:04.000 --> 00:00:06.000
trzy

00:00:06.000 --> 00:00:08.000
cztery
`;

describe('YouTube timedtext lyrics', () => {
  it('sends a watch Referer and UA so the request is not 403', () => {
    const headers = youtubeTimedtextHeaders('szampanVid1');
    expect(headers.Referer).toBe('https://www.youtube.com/watch?v=szampanVid1');
    expect(headers.Origin).toBe('https://www.youtube.com');
    expect(headers['User-Agent']).toMatch(/Mozilla/);
  });

  it('reads caption URLs from a player payload and asks for vtt', () => {
    const urls = captionTrackUrlsFromPlayer({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { baseUrl: 'https://www.youtube.com/api/timedtext?v=szampanVid1&lang=pl' },
          ],
        },
      },
    });
    expect(urls[0]).toContain('timedtext');
    expect(withVttFmt(urls[0])).toContain('fmt=vtt');
  });

  it('fetches Szampan lyrics through timedtext with those headers', async () => {
    httpFetch.mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
      const u = String(url);
      if (u.includes('timedtext')) {
        expect(init?.headers?.Referer).toContain('youtube.com/watch');
        return { ok: true, status: 200, text: async () => vtt, headers: { get: () => null } };
      }
      return { ok: false, status: 404, text: async () => '', headers: { get: () => null } };
    });
    const result = await getLyrics(track, 'pl', 'YouTube Music');
    expect(result?.provider).toBe('YouTube Music');
    expect(result?.synced?.length).toBeGreaterThanOrEqual(4);
  });
});
