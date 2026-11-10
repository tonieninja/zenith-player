import { describe, expect, it } from 'vitest';
import type { Track } from '../api/youtube';
import { withCollectionMeta } from '../utils/tracks';

const album: Track = {
  id: 'MPREb_mvIFxcPCNAi',
  type: 'album',
  title: 'All Night Radio',
  artist: 'Ado • 2023',
  cover: 'https://yt3.googleusercontent.com/a=w226-h226',
  coverSmall: 'https://yt3.googleusercontent.com/a=w120-h120',
  coverLarge: 'https://yt3.googleusercontent.com/a=w544-h544',
};

describe('album page tracks', () => {
  it('takes the album artist and square cover instead of video frames', () => {
    const [t] = withCollectionMeta(
      album,
      [
        {
          id: 'lfw8W3uWO7s',
          type: 'track',
          title: 'All Night Radio',
          artist: 'Various artists',
          cover: 'https://i.ytimg.com/vi/lfw8W3uWO7s/hqdefault.jpg',
        },
      ],
      'Various artists'
    );
    expect(t.artist).toBe('Ado');
    expect(t.cover).toBe(album.cover);
    expect(t.coverLarge).toBe(album.coverLarge);
  });

  it('keeps real artists and covers of playlist tracks', () => {
    const playlist: Track = { ...album, id: 'VLPL1', type: 'playlist', artist: 'Someone' };
    const own = 'https://i.ytimg.com/vi/x/hqdefault.jpg';
    const [t] = withCollectionMeta(
      playlist,
      [{ id: 'abcdefghijk', type: 'track', title: 'x', artist: 'Real', cover: own }],
      'Various artists'
    );
    expect(t.artist).toBe('Real');
    expect(t.cover).toBe(own);
  });
});
