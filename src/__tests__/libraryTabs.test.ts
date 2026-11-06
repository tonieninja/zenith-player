import { describe, expect, it } from 'vitest';
import { nextLibraryViewState } from '../constants/library';

describe('library tab switch', () => {
  it('clears the previous tab so Songs do not linger under Albums', () => {
    expect(nextLibraryViewState('songs', 'albums')).toEqual({ category: 'albums', clear: true });
    expect(nextLibraryViewState('songs', 'songs')).toEqual({ category: 'songs', clear: false });
  });
});
