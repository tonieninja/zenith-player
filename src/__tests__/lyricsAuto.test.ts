import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
const httpFetch = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => httpFetch(...a) }));

import { ALL_OFF, getLyrics, type Track } from '../api/youtube';
import {
  getLyricsPrefs,
  lyricsUpgrade,
  moveSource,
  setLyricsPrefs,
  toggleSource,
} from '../lyrics/prefs';
import { localizeLyricsReason } from '../lyrics/reasons';

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
            syncedLyrics:
              '[00:00.00] Like the legend of the phoenix\\n[00:04.00] All ends with beginnings',
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

describe('Auto lyrics upgrades', () => {
  const LRC = '[00:00.00] Like the legend of the phoenix\n[00:04.00] All ends with beginnings';
  const miss = { ok: false, status: 404, text: async () => '', headers: { get: () => null } };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const routes = (boiduMs: number) => {
    const urls: string[] = [];
    httpFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('lrclib.net')) {
        await wait(40);
        return json([
          { trackName: 'Get Lucky', artistName: 'Daft Punk', duration: 369, syncedLyrics: LRC },
        ]);
      }
      if (u.includes('boidu.dev')) {
        await wait(boiduMs);
        return json({ syncedLyrics: LRC });
      }
      return miss;
    });
    return urls;
  };
  const song = (id: string): Track => ({ ...track, id, durationSec: 369 });
  const boiduFirst = () =>
    setLyricsPrefs({ order: moveSource(getLyricsPrefs(), 'Boidu', 0).order, off: [] });

  afterEach(() => {
    setLyricsPrefs(null);
    lyricsUpgrade.set(true);
  });

  it('shows LRCLib first and switches once to the top source when it arrives', async () => {
    routes(2000);
    boiduFirst();
    const seen: string[] = [];
    const res = await getLyrics(song('upgrade1xxxxxxx'), 'en', 'Auto', (r) => {
      if (r.synced?.length) seen.push(r.provider);
    });
    expect(seen).toEqual(['LRCLib', 'Boidu']);
    expect(res?.provider).toBe('Boidu');
    expect(res?.upgradedFrom).toBe('LRCLib');
  });

  it('never switches down to a lower-ranked source', async () => {
    routes(2000);
    const seen: string[] = [];
    const res = await getLyrics(song('upgrade2xxxxxxx'), 'en', 'Auto', (r) => {
      if (r.synced?.length) seen.push(r.provider);
    });
    expect(seen).toEqual(['LRCLib']);
    expect(res?.provider).toBe('LRCLib');
  });

  it('keeps today timing without a listener or with upgrades off', async () => {
    routes(2000);
    boiduFirst();
    expect((await getLyrics(song('upgrade3xxxxxxx'), 'en', 'Auto'))?.provider).toBe('LRCLib');
    lyricsUpgrade.set(false);
    const seen: string[] = [];
    const res = await getLyrics(song('upgrade4xxxxxxx'), 'en', 'Auto', (r) => {
      if (r.synced?.length) seen.push(r.provider);
    });
    expect(seen).toEqual([]);
    expect(res?.provider).toBe('LRCLib');
  });

  it('skips disabled sources and refetches when the sources change', async () => {
    const urls = routes(10);
    setLyricsPrefs(toggleSource(getLyricsPrefs(), 'Boidu', false));
    await getLyrics(song('upgrade5xxxxxxx'), 'en', 'Auto');
    expect(urls.some((u) => u.includes('boidu'))).toBe(false);
    setLyricsPrefs(null);
    await getLyrics(song('upgrade5xxxxxxx'), 'en', 'Auto');
    expect(urls.some((u) => u.includes('boidu'))).toBe(true);
  });

  it('asks nobody when every source is off', async () => {
    const urls = routes(10);
    const p = getLyricsPrefs();
    setLyricsPrefs({ order: p.order, off: [...p.order] });
    const res = await getLyrics(song('upgrade6xxxxxxx'), 'en', 'Auto');
    expect(urls).toEqual([]);
    expect(res?.failures?.[0]?.reason).toBe(ALL_OFF);
    expect(localizeLyricsReason(ALL_OFF, 'pl')).toContain('wyłączone');
  });
});
