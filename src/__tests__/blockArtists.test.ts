import { afterEach, describe, expect, it, vi } from 'vitest';

const emit = vi.fn(async (_e: string, _p?: unknown) => {});
vi.mock('@tauri-apps/api/event', () => ({ emit: (...a: unknown[]) => emit(...(a as [string])) }));

const { blockArtistsPlugin, isBlocked, saveBlocked } = await import('../plugins/blockArtists');

const info = (artist: string, id = 'x') => ({
  id,
  title: 't',
  artist,
  duration: 1,
  position: 0,
  isPlaying: true,
});

afterEach(() => {
  localStorage.clear();
  emit.mockClear();
  blockArtistsPlugin.onTrackChange?.(info('nobody'), null);
});

describe('block artists', () => {
  it('matches whole names, ignoring case, accents and view counts', () => {
    expect(isBlocked('Prince', ['prince'])).toBe(true);
    expect(isBlocked('Princess Nokia', ['Prince'])).toBe(false);
    expect(isBlocked('Ella Langley • 374M plays', ['ella langley'])).toBe(true);
    expect(isBlocked('Beyoncé, JAY-Z', ['beyonce'])).toBe(true);
    expect(isBlocked('Daft Punk', ['  '])).toBe(false);
  });

  it('skips a blocked track and stops after ten in a row', () => {
    saveBlocked(['AI Band']);
    blockArtistsPlugin.onTrackChange?.(info('Real Band'), null);
    expect(emit).not.toHaveBeenCalled();
    for (let i = 0; i < 12; i++) blockArtistsPlugin.onTrackChange?.(info('AI Band', `${i}`), null);
    expect(emit).toHaveBeenCalledTimes(10);
    expect(emit).toHaveBeenLastCalledWith('zenith-mini-action', 'next');
    blockArtistsPlugin.onTrackChange?.(info('Real Band'), null);
    blockArtistsPlugin.onTrackChange?.(info('AI Band'), null);
    expect(emit).toHaveBeenCalledTimes(11);
  });
});
