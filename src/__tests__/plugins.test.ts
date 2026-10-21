import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async (cmd: string) => {
  if (cmd === 'downloads_list') return [];
  if (cmd === 'downloads_add')
    return {
      id: 't1',
      title: 'A',
      artist: 'B',
      album: '',
      cover: '',
      duration: 1,
      size: 10,
      savedAt: 1,
    };
  if (cmd === 'downloads_delete') return undefined;
  if (cmd === 'downloads_clear') return 2;
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...a: unknown[]) => invoke(...(a as [string])),
}));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

import { ALL_PLUGINS, pluginManager } from '../plugins';
import { setupKeyboardShortcuts, registerKeyboardHandler } from '../plugins/keyboardShortcuts';
import { getRememberLogin, setRememberLogin } from '../utils/rememberLogin';
import { loadPersistedQueue, savePersistedQueue } from '../plugins/queuePersist';
import { formatBytes, entryToTrack } from '../plugins/offlineDownloads';
import {
  GAPLESS_BLEND_SECS,
  getGaplessAlbums,
  isAlbumCollectionId,
  planAutoTransition,
  saveGaplessAlbums,
} from '../plugins/crossfade';
import {
  BASS_BOOST_BANDS,
  EQ_LABELS,
  EQ_MAX_DB,
  EQ_MIN_DB,
  EQ_PRESETS,
  EQ_FREQS,
  EQ_PRESET_BASS,
  fromLegacyBands,
  getEqBands,
} from '../plugins/equalizer';
import {
  acceleratorFromEvent,
  DEFAULT_HOTKEYS,
  getHotkeyBindings,
  HOTKEY_BINDINGS_KEY,
  prettyAccelerator,
} from '../plugins/globalHotkeys';
import { getRemotePairMode, setRemotePairMode } from '../plugins/remoteControl';
import { normGainDb } from '../audio/webFx';
import { pluginText } from '../utils/pluginI18n';
import { pluginQueryMatches } from '../utils/pluginSearch';
import { LIBRARY_CATEGORIES } from '../constants/library';

const track = (id: string) => ({
  id,
  type: 'track' as const,
  title: `T${id}`,
  artist: 'A',
  cover: '',
});

const ev = (key: string, code: string, m: Partial<Record<string, boolean>> = {}) => ({
  key,
  code,
  ctrlKey: !!m.ctrl,
  altKey: !!m.alt,
  shiftKey: !!m.shift,
  metaKey: !!m.meta,
});

beforeEach(() => {
  localStorage.clear();
  pluginManager.reloadFromStorage();
});

describe('plugin manager', () => {
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

describe('keyboard shortcuts', () => {
  it('does not steal clipboard combos', () => {
    expect(
      acceleratorFromEvent({
        key: 'v',
        code: 'KeyV',
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      })
    ).toBeNull();
    const seen: string[] = [];
    registerKeyboardHandler((a) => seen.push(a));
    const stop = setupKeyboardShortcuts(true);
    const ev = new KeyboardEvent('keydown', {
      key: 'v',
      code: 'KeyV',
      ctrlKey: true,
      bubbles: true,
    });
    window.dispatchEvent(ev);
    expect(seen).toEqual([]);
    const space = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true });
    window.dispatchEvent(space);
    expect(seen).toContain('toggle-play');
    stop();
  });
});

describe('saved settings', () => {
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
    expect(
      planAutoTransition({
        crossfadeOn: true,
        crossfadeSecs: 6,
        album: false,
        gapless: true,
        remaining: 5,
      })
    ).toEqual({
      at: 5,
      fade: 5,
    });
    expect(getEqBands()).toHaveLength(15);
    expect(EQ_PRESETS.flat).toHaveLength(15);
  });
});

describe('equalizer', () => {
  it('is 15-band ISO and bass boost comes from the shelf, not sub bands', () => {
    expect([...EQ_FREQS]).toEqual([
      25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000,
    ]);
    expect(EQ_LABELS[8]).toBe('1k');
    expect(EQ_LABELS[9]).toBe('1.6k');
    expect(BASS_BOOST_BANDS.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(EQ_PRESET_BASS.bass).toBe(9);
  });
  it('migrates saved 10-band curves', () => {
    localStorage.setItem('zenith_eq_bands', JSON.stringify([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]));
    localStorage.setItem('zenith_eq_preset', 'custom');
    expect(getEqBands()).toEqual(EQ_FREQS.map(() => 1));
    localStorage.setItem('zenith_eq_preset', 'bass');
    expect(getEqBands()).toEqual([...BASS_BOOST_BANDS]);
    expect(fromLegacyBands([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toHaveLength(15);
  });
  it('preset reads the single constant and stays in range', () => {
    expect(EQ_PRESETS.bass).toEqual([...BASS_BOOST_BANDS]);
    expect(BASS_BOOST_BANDS).toHaveLength(EQ_LABELS.length);
    for (const g of BASS_BOOST_BANDS) {
      expect(g).toBeGreaterThanOrEqual(EQ_MIN_DB);
      expect(g).toBeLessThanOrEqual(EQ_MAX_DB);
    }
  });
});

describe('crossfade planner', () => {
  const base = { crossfadeOn: true, crossfadeSecs: 6, album: false, gapless: true };
  it('crossfades singles near the end', () => {
    expect(planAutoTransition({ ...base, remaining: 10 })).toBeNull();
    expect(planAutoTransition({ ...base, remaining: 5 })).toEqual({ at: 5, fade: 5 });
    expect(planAutoTransition({ ...base, remaining: 0.2 })).toBeNull();
  });
  it('albums hand off gaplessly, even with crossfade off', () => {
    const a = { ...base, album: true, crossfadeOn: false };
    expect(planAutoTransition({ ...a, remaining: 5 })).toBeNull();
    expect(planAutoTransition({ ...a, remaining: 0.4 })).toEqual({
      at: 0.4,
      fade: GAPLESS_BLEND_SECS,
    });
  });
  it('album with gapless off falls back to crossfade', () => {
    expect(planAutoTransition({ ...base, album: true, gapless: false, remaining: 4 })).toEqual({
      at: 4,
      fade: 4,
    });
  });
  it('recognises album ids', () => {
    expect(isAlbumCollectionId('MPREb_abc')).toBe(true);
    expect(isAlbumCollectionId('VLOLAK5uy_x')).toBe(true);
    expect(isAlbumCollectionId('PL123')).toBe(false);
    expect(isAlbumCollectionId(null)).toBe(false);
  });
  it('setting defaults on and persists', () => {
    expect(getGaplessAlbums()).toBe(true);
    saveGaplessAlbums(false);
    expect(getGaplessAlbums()).toBe(false);
  });
});

describe('global hotkeys', () => {
  it('builds accelerators from key events', () => {
    expect(acceleratorFromEvent(ev('p', 'KeyP', { ctrl: true, shift: true }))).toBe(
      'Ctrl+Shift+KeyP'
    );
    expect(acceleratorFromEvent(ev(' ', 'Space', { ctrl: true, alt: true }))).toBe(
      'Ctrl+Alt+Space'
    );
    expect(acceleratorFromEvent(ev('F9', 'F9'))).toBe('F9');
    expect(acceleratorFromEvent(ev('a', 'KeyA'))).toBeNull();
    expect(acceleratorFromEvent(ev('Control', 'ControlLeft', { ctrl: true }))).toBeNull();
  });
  it('pretty prints', () => {
    expect(prettyAccelerator('Ctrl+Alt+ArrowRight')).toBe('Ctrl + Alt + →');
    expect(prettyAccelerator('Ctrl+KeyP')).toBe('Ctrl + P');
  });
  it('merges stored bindings over defaults', () => {
    expect(getHotkeyBindings()).toEqual(DEFAULT_HOTKEYS);
    localStorage.setItem(HOTKEY_BINDINGS_KEY, JSON.stringify({ next: 'F10', junk: 'x' }));
    const b = getHotkeyBindings();
    expect(b.next).toBe('F10');
    expect(b.prev).toBe(DEFAULT_HOTKEYS.prev);
    expect('junk' in b).toBe(false);
  });
});

describe('offline downloads', () => {
  it('formats sizes', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
  it('maps an entry to a playable track', () => {
    const t = entryToTrack({
      id: 'abcdefghijk',
      title: 'Song',
      artist: 'Band',
      album: '',
      cover: 'c',
      duration: 1,
      size: 1,
      savedAt: 1,
    });
    expect(t).toMatchObject({ id: 'abcdefghijk', type: 'track', title: 'Song' });
  });
  it('downloads plugin is registered with a polish name', () => {
    expect(ALL_PLUGINS.some((p) => p.id === 'offline-downloads')).toBe(true);
    expect(pluginText('pl', 'offline-downloads', { name: 'x', desc: 'x' }).name).toBe(
      'Pobrane offline'
    );
  });
});

describe('remote pairing', () => {
  it('is on for a fresh profile and remembers an explicit off', () => {
    localStorage.removeItem('zenith_remote_pair');
    expect(getRemotePairMode()).toBe(true);
    setRemotePairMode(false);
    expect(getRemotePairMode()).toBe(false);
    setRemotePairMode(true);
    expect(getRemotePairMode()).toBe(true);
  });
});

describe('loudness normalization', () => {
  it('needs a few blocks, only cuts, never boosts, and caps the cut', () => {
    expect(normGainDb(1, 2)).toBeNull();
    expect(normGainDb(5 * 1e-3, 5)).toBe(0);
    expect(normGainDb(5 * 1, 5)).toBe(-10);
  });
});

const names = ['A-B loop', 'Loop a section of the track', 'Pętla A-B', 'Pętla fragmentu utworu'];

describe('plugin search', () => {
  it('treats spaces and hyphens as the same', () => {
    expect(pluginQueryMatches(names, 'ab loop')).toBe(true);
    expect(pluginQueryMatches(names, 'a-b loop')).toBe(true);
    expect(pluginQueryMatches(names, 'loop')).toBe(true);
    expect(pluginQueryMatches(names, 'petla')).toBe(true);
  });

  it('does not match an unrelated query', () => {
    expect(pluginQueryMatches(names, 'equalizer')).toBe(false);
  });
});
