import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
const httpFetch = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => httpFetch(...a) }));

import { getLyrics, type Track } from '../api/youtube';

const track: Track = {
  id: 'autoRace1xxxxxxx',
  type: 'track',
  title: 'Get Lucky',
  artist: 'Daft Punk',
  cover: '',
};

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
  headers: { get: () => null },
});

describe('Auto lyrics race', () => {
  it('does not flash Lyrics.ovh text before a verified LRCLib match', async () => {
    httpFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('api.lyrics.ovh')) {
        return json({ lyrics: 'One More Time\\nMusic is the key' });
      }
      if (u.includes('lrclib.net')) {
        await new Promise((r) => setTimeout(r, 40));
        return json([
          {
            trackName: 'Get Lucky',
            artistName: 'Daft Punk',
            duration: 369,
            syncedLyrics: '[00:00.00] Like the legend of the phoenix\\n[00:04.00] All ends with beginnings',
            plainLyrics: 'Like the legend of the phoenix',
          },
        ]);
      }
      if (u.includes('musixmatch') || u.includes('mxmcdn')) {
        await new Promise((r) => setTimeout(r, 80));
        return { ok: false, status: 503, text: async () => '', headers: { get: () => null } };
      }
      if (u.includes('genius.com')) {
        return { ok: false, status: 403, text: async () => '', headers: { get: () => null } };
      }
      if (u.includes('youtube.com') || u.includes('youtubekey') || u.includes('youtubei')) {
        return { ok: false, status: 404, text: async () => '', headers: { get: () => null } };
      }
      return { ok: false, status: 404, text: async () => '', headers: { get: () => null } };
    });

    const plains: Array<{ provider: string; text: string | null }> = [];
    const result = await getLyrics(track, 'en', 'Auto', (plain) => {
      plains.push({ provider: plain.provider, text: plain.text });
    });
    expect(plains.some((p) => p.provider === 'Lyrics.ovh')).toBe(false);
    expect(plains.some((p) => (p.text || '').includes('One More Time'))).toBe(false);
    expect(result?.provider).toBe('LRCLib');
    expect(result?.synced?.length).toBeGreaterThan(0);
  });
});
