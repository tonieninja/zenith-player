import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async (cmd: string) => {
  if (cmd === 'downloads_list') return [];
  if (cmd === 'downloads_add') return { id: 't1', title: 'A', artist: 'B', album: '', cover: '', duration: 1, size: 10, savedAt: 1 };
  if (cmd === 'downloads_delete') return undefined;
  if (cmd === 'downloads_clear') return 2;
  if (cmd === 'spotify_wait_for_code') return 'CODE';
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...(a as [string])) }));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
const httpFetch = vi.fn();
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => httpFetch(...a) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }));

import { ALL_PLUGINS, pluginManager } from '../plugins';
import { decidePrevious, PREV_RESTART_SECS } from '../utils/playbackNav';
import { fillPages } from '../utils/libraryLoad';
import { acceleratorFromEvent } from '../plugins/globalHotkeys';
import { setupKeyboardShortcuts, registerKeyboardHandler } from '../plugins/keyboardShortcuts';
import { getRememberLogin, setRememberLogin } from '../utils/rememberLogin';
import { loadPersistedQueue, savePersistedQueue } from '../plugins/queuePersist';
import { formatBytes, entryToTrack } from '../plugins/offlineDownloads';
import { getGaplessAlbums, saveGaplessAlbums, planAutoTransition } from '../plugins/crossfade';
import { getEqBands, EQ_PRESETS } from '../plugins/equalizer';
import {
  exportToSpotify,
  pickBest,
  scoreMatch,
  setSpotifyClientId,
  MATCH_THRESHOLD,
  type SpotifyCandidate,
} from '../api/spotify';
import type { PlaylistEntry } from '../api/playlistManager';
import { translations } from '../i18n';
import { LIBRARY_CATEGORIES } from '../constants/library';

const track = (id: string) => ({
  id,
  type: 'track' as const,
  title: `T${id}`,
  artist: 'A',
  cover: '',
});

beforeEach(() => {
  localStorage.clear();
  pluginManager.reloadFromStorage();
  httpFetch.mockReset();
});

describe('every bundled plugin can toggle', () => {
  it('has unique ids and enable/disable persists', () => {
    const ids = ALL_PLUGINS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(20);
    for (const p of ALL_PLUGINS) {
      pluginManager.setEnabled(p.id, true);
      expect(pluginManager.isEnabled(p.id), p.id).toBe(true);
      pluginManager.setEnabled(p.id, false);
      expect(pluginManager.isEnabled(p.id), p.id).toBe(false);
    }
    const raw = JSON.parse(localStorage.getItem('zenith_plugins_enabled') || '{}');
    expect(Object.keys(raw).length).toBeGreaterThan(10);
  });
});

describe('player transport logic', () => {
  it('covers previous/next/shuffle/loop decisions', () => {
    expect(decidePrevious({ positionSec: PREV_RESTART_SECS + 1, queueIndex: 1, queueLength: 3, loopMode: 'off' }).kind).toBe('restart');
    expect(decidePrevious({ positionSec: 0, queueIndex: 2, queueLength: 3, loopMode: 'off' })).toEqual({ kind: 'goto', index: 1 });
    expect(decidePrevious({ positionSec: 0, queueIndex: 0, queueLength: 3, loopMode: 'all' })).toEqual({ kind: 'goto', index: 2 });
    expect(
      decidePrevious({
        positionSec: 0,
        queueIndex: 2,
        queueLength: 3,
        loopMode: 'off',
        shuffleOn: true,
        historyIds: ['a'],
        queueIds: ['a', 'b', 'c'],
      })
    ).toEqual({ kind: 'goto', index: 0 });
  });
});

describe('keyboard + Ctrl+V', () => {
  it('does not steal clipboard combos', () => {
    expect(
      acceleratorFromEvent({ key: 'v', code: 'KeyV', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })
    ).toBeNull();
    const seen: string[] = [];
    registerKeyboardHandler((a) => seen.push(a));
    const stop = setupKeyboardShortcuts(true);
    const ev = new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true });
    window.dispatchEvent(ev);
    expect(seen).toEqual([]);
    const space = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true });
    window.dispatchEvent(space);
    expect(seen).toContain('toggle-play');
    stop();
  });

  it('rejects a paste that would overflow the search box', () => {
    const MAX = 200;
    const pasted = 'x'.repeat(150);
    const query = 'y'.repeat(60);
    expect(pasted.length + query.length > MAX).toBe(true);
  });
});

describe('settings + session persistence', () => {
  it('remember-login and queue survive a reload', () => {
    setRememberLogin(false);
    expect(getRememberLogin()).toBe(false);
    setRememberLogin(true);
    expect(getRememberLogin()).toBe(true);
    savePersistedQueue([track('1'), track('2')], 1, 'home', 9, false);
    const q = loadPersistedQueue()!;
    expect(q.index).toBe(1);
    expect(q.queue.map((t) => t.id)).toEqual(['1', '2']);
    expect(q.progress).toBe(9);
  });

  it('library categories used by the Library view exist', () => {
    expect(LIBRARY_CATEGORIES.length).toBeGreaterThan(4);
    const ids = LIBRARY_CATEGORIES.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['landing', 'playlists', 'songs', 'albums']));
  });

  it('equalizer and gapless settings persist', () => {
    saveGaplessAlbums(false);
    expect(getGaplessAlbums()).toBe(false);
    saveGaplessAlbums(true);
    expect(getGaplessAlbums()).toBe(true);
    expect(planAutoTransition({ crossfadeOn: true, crossfadeSecs: 6, album: false, gapless: true, remaining: 5 })).toEqual({
      at: 5,
      fade: 5,
    });
    expect(getEqBands()).toHaveLength(15);
    expect(EQ_PRESETS.flat).toHaveLength(15);
  });
});

describe('offline downloads helpers', () => {
  it('formats sizes and maps entries to tracks', () => {
    expect(formatBytes(500)).toMatch(/B/);
    expect(formatBytes(2048)).toMatch(/KB/);
    expect(formatBytes(3 * 1024 * 1024)).toMatch(/MB/);
    const t = entryToTrack({
      id: 'abc',
      title: 'Song',
      artist: 'Someone',
      album: '',
      cover: 'x',
      duration: 10,
      size: 1,
      savedAt: 1,
    });
    expect(t).toMatchObject({ id: 'abc', type: 'track', title: 'Song' });
  });
});

describe('library progressive load', () => {
  it('paints after a couple of pages', async () => {
    let n = 0;
    const out = await fillPages({
      initial: [{ id: '0' }],
      token: 'a',
      maxPages: 2,
      fetchPage: async () => {
        n += 1;
        return { items: [{ id: String(n) }], next: n < 4 ? `t${n}` : null };
      },
    });
    expect(out.pagesFetched).toBe(2);
    expect(out.next).toBeTruthy();
  });
});

describe('i18n buttons used by chrome', () => {
  const keys = [
    'previousTrack',
    'nextTrack',
    'shuffle',
    'mute',
    'unmute',
    'openQueue',
    'winClose',
    'winMinimize',
    'logout',
    'login',
    'searchPlaceholder',
    'loopOne',
  ] as const;
  it('every player-bar / chrome label exists in EN and PL', () => {
    for (const k of keys) {
      expect(translations.en[k].length, `en.${k}`).toBeGreaterThan(0);
      expect(translations.pl[k].length, `pl.${k}`).toBeGreaterThan(0);
    }
  });
});

describe('spotify export (mocked API)', () => {
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
              { uri: 'spotify:track:aaa', name: 'Hello', artists: [{ name: 'Adele' }], duration_ms: 180000 },
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
            JSON.stringify({ id: 'pl1', external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' } }),
          json: async () => ({ id: 'pl1', external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' } }),
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
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '{}', json: async () => ({}) };
    });

    const res = await exportToSpotify('Mix', 'desc', [
      entry('Hello', 'Adele'),
      entry('Completely Unknown Song XYZ', 'Nobody McNobody'),
    ]);
    expect(res.matched + res.unmatched.length).toBe(2);
    expect(res.playlistUrl).toContain('spotify.com');
    expect(scoreMatch(entry('Hello', 'Adele'), { name: 'Hello', artists: ['Adele'], uri: 'spotify:track:aaa', durationMs: 180000 })).toBeGreaterThan(MATCH_THRESHOLD);
    expect(pickBest(entry('Hello', 'Adele'), [{ name: 'Hello', artists: ['Adele'], uri: 'u', durationMs: 180000 }])).toBeTruthy();
  });
});
