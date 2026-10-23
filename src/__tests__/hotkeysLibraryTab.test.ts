import { describe, expect, it } from 'vitest';
import { acceleratorFromEvent } from '../plugins/globalHotkeys';
import { nextLibraryViewState } from '../constants/library';

describe('hotkey capture rejects clipboard combos', () => {
  it('blocks Ctrl+V / Ctrl+C', () => {
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
    expect(
      acceleratorFromEvent({
        key: 'c',
        code: 'KeyC',
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      })
    ).toBeNull();
  });
  it('still allows Ctrl+Alt+V', () => {
    expect(
      acceleratorFromEvent({
        key: 'v',
        code: 'KeyV',
        ctrlKey: true,
        altKey: true,
        shiftKey: false,
        metaKey: false,
      })
    ).toBe('Ctrl+Alt+KeyV');
  });
});

describe('library tab switch', () => {
  it('clears the previous tab so Songs do not linger under Albums', () => {
    expect(nextLibraryViewState('songs', 'albums')).toEqual({ category: 'albums', clear: true });
    expect(nextLibraryViewState('songs', 'songs')).toEqual({ category: 'songs', clear: false });
  });
});
