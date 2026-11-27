import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { Track } from '../api/youtube';
import { CollectionView } from '../components/feed/CollectionView';
import { translations } from '../i18n';
import { letterCover } from '../utils/covers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const song: Track = {
  id: 'abcdefghijk',
  type: 'track',
  title: 'Song',
  artist: 'Artist',
  cover: 'https://lh3.googleusercontent.com/song=w226-h226',
  coverLarge: 'https://lh3.googleusercontent.com/song=w544-h544',
};

function heroCover(collection: Track): string | null {
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() =>
    root.render(
      <CollectionView
        collection={collection}
        kind="Playlist"
        items={[song]}
        album={false}
        onItemClick={() => undefined}
        onPlay={() => undefined}
        t={translations.en}
      />
    )
  );
  const src = host.querySelector('.collection-cover')?.getAttribute('src') ?? null;
  act(() => root.unmount());
  return src;
}

describe('collection page cover', () => {
  it('shows the first song cover instead of the letter placeholder of a playlist from search', () => {
    const plain = { id: 'VLPLx', type: 'playlist', title: 'Mix', artist: '' } as const;
    expect(heroCover({ ...plain, cover: letterCover('Mix') })).toBe(song.coverLarge);
    expect(heroCover({ ...plain, cover: '' })).toBe(song.coverLarge);
    const own = 'https://lh3.googleusercontent.com/own=w544-h544';
    expect(heroCover({ ...plain, cover: own, coverLarge: own })).toBe(own);
  });
});
