import { describe, expect, it } from 'vitest';
import { mergeFavoriteTracks, readSavedTracks } from '../utils/favorites';
import type { Track } from '../api/youtube';

const track = (id: string, title = id): Track => ({
  id,
  type: 'track',
  title,
  artist: 'A',
  cover: '',
});

describe('favorites', () => {
  it('reads a saved list and ignores junk', () => {
    expect(readSavedTracks(JSON.stringify([track('a')])).map((t) => t.id)).toEqual(['a']);
    expect(readSavedTracks('nope')).toEqual([]);
    expect(readSavedTracks('{"id":"a"}')).toEqual([]);
  });

  it('shows account likes when the device list is empty, without duplicating a save', () => {
    const local = [track('local', 'On this PC')];
    const account = [track('local', 'From YouTube'), track('vllm', 'Liked on YouTube')];
    const merged = mergeFavoriteTracks(local, account);
    expect(merged.map((t) => t.id)).toEqual(['local', 'vllm']);
    expect(merged[0].title).toBe('On this PC');
    expect(mergeFavoriteTracks([], account).map((t) => t.title)).toEqual([
      'From YouTube',
      'Liked on YouTube',
    ]);
  });

  it('repairs a stored artist line', () => {
    const raw = JSON.stringify([
      {
        id: 'x',
        type: 'track',
        title: 'Get Lucky',
        artist: 'Daft Punk • , • Pharrell Williams • & • Nile Rodgers',
        cover: '',
      },
    ]);
    expect(readSavedTracks(raw)[0].artist).toBe('Daft Punk, Pharrell Williams & Nile Rodgers');
  });
});
