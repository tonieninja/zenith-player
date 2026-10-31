import { beforeEach, describe, expect, it } from 'vitest';
import {
  BASS_BOOST_BANDS,
  EQ_LABELS,
  EQ_MAX_DB,
  EQ_MIN_DB,
  EQ_PRESETS,
  EQ_FREQS,
  eqPreampDb,
  fromLegacyBands,
  getEqBands,
} from '../plugins/equalizer';
import {
  GAPLESS_BLEND_SECS,
  getGaplessAlbums,
  isAlbumCollectionId,
  planAutoTransition,
  saveGaplessAlbums,
} from '../plugins/crossfade';
import {
  acceleratorFromEvent,
  DEFAULT_HOTKEYS,
  getHotkeyBindings,
  HOTKEY_BINDINGS_KEY,
  prettyAccelerator,
} from '../plugins/globalHotkeys';
import { entryToTrack, formatBytes } from '../plugins/offlineDownloads';
import { ALL_PLUGINS } from '../plugins';
import { translations } from '../i18n';
import { pluginText } from '../utils/pluginI18n';

const ev = (key: string, code: string, m: Partial<Record<string, boolean>> = {}) => ({
  key,
  code,
  ctrlKey: !!m.ctrl,
  altKey: !!m.alt,
  shiftKey: !!m.shift,
  metaKey: !!m.meta,
});

beforeEach(() => localStorage.clear());

describe('equalizer bass boost', () => {
  it('is 15-band ISO with the Bass Boost curve and headroom', () => {
    expect([...EQ_FREQS]).toEqual([
      25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000,
    ]);
    expect(EQ_LABELS[8]).toBe('1k');
    expect(EQ_LABELS[9]).toBe('1.6k');
    expect(BASS_BOOST_BANDS.slice(0, 5)).toEqual([4, 5.5, 5, 1.8, 0]);
    expect(eqPreampDb([...BASS_BOOST_BANDS])).toBe(-5.5);
    expect(eqPreampDb(EQ_PRESETS.flat)).toBe(-0);
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

describe('gapless / crossfade planner', () => {
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

describe('offline downloads helpers', () => {
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
});

describe('download and offline strings', () => {
  it('every download key has a Polish text', () => {
    const keys = Object.keys(translations.en).filter((k) => /^(hk|dl|gapless)/.test(k));
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) {
      const pl = (translations.pl as Record<string, string>)[k];
      expect(pl, k).toBeTruthy();
      expect(pl).not.toContain('\u2014');
      expect((translations.en as Record<string, string>)[k]).not.toContain('\u2014');
    }
  });
  it('the downloads plugin is registered and translated', () => {
    expect(ALL_PLUGINS.some((p) => p.id === 'offline-downloads')).toBe(true);
    expect(pluginText('pl', 'offline-downloads', { name: 'x', desc: 'x' }).name).toBe(
      'Pobrane offline'
    );
  });
});
