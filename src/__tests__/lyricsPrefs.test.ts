import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SOURCE_ORDER,
  enabledSources,
  getLyricsPrefs,
  lyricsPrefsKey,
  moveSource,
  normalizeLyricsPrefs,
  setLyricsPrefs,
  toggleSource,
} from '../lyrics/prefs';

afterEach(() => setLyricsPrefs(null));

describe('lyrics source preferences', () => {
  it('survives bad data and keeps every known source exactly once', () => {
    expect(normalizeLyricsPrefs('{oops').order).toEqual(DEFAULT_SOURCE_ORDER);
    const p = normalizeLyricsPrefs(
      JSON.stringify({ order: ['Kugou', 'Nope', 'Kugou', 'LRCLib'], off: ['Boidu', 'Nope'] })
    );
    expect(p.order.indexOf('Kugou')).toBeLessThan(p.order.indexOf('LRCLib'));
    expect([...p.order].sort()).toEqual([...DEFAULT_SOURCE_ORDER].sort());
    expect(p.off).toEqual(['Boidu']);
  });

  it('puts a source missing from an old save at its default slot', () => {
    const old = DEFAULT_SOURCE_ORDER.filter((id) => id !== 'LyricsPlus');
    const p = normalizeLyricsPrefs(JSON.stringify({ order: old }));
    expect(p.order.indexOf('LyricsPlus')).toBe(DEFAULT_SOURCE_ORDER.indexOf('LyricsPlus'));
  });

  it('moves, toggles and saves', () => {
    let p = moveSource(getLyricsPrefs(), 'Kugou', 0);
    p = toggleSource(p, 'Musixmatch', false);
    setLyricsPrefs(p);
    const saved = normalizeLyricsPrefs(localStorage.getItem('zenith_lyrics_sources'));
    expect(saved.order[0]).toBe('Kugou');
    expect(enabledSources(saved)).not.toContain('Musixmatch');
    expect(lyricsPrefsKey(saved)).not.toBe(lyricsPrefsKey(normalizeLyricsPrefs(null)));
    expect(moveSource(p, 'Kugou', 99)).toBe(p);
  });
});
