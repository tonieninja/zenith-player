import type { LibraryCategory } from '../api/youtube';

export const LIBRARY_CATEGORIES: {
  id: LibraryCategory;
  labelKey:
    | 'libAll'
    | 'libPlaylists'
    | 'libSongs'
    | 'libAlbums'
    | 'libArtists'
    | 'libSubscriptions'
    | 'libHistory'
    | 'libPodcasts';
}[] = [
  { id: 'landing', labelKey: 'libAll' },
  { id: 'playlists', labelKey: 'libPlaylists' },
  { id: 'songs', labelKey: 'libSongs' },
  { id: 'albums', labelKey: 'libAlbums' },
  { id: 'artists', labelKey: 'libArtists' },
  { id: 'subscriptions', labelKey: 'libSubscriptions' },
  { id: 'history', labelKey: 'libHistory' },
  { id: 'podcasts', labelKey: 'libPodcasts' },
];

export const LIB_EMPTY_KEYS: Record<
  LibraryCategory,
  | 'libraryNoItems'
  | 'libEmptyPlaylists'
  | 'libEmptySongs'
  | 'libEmptyAlbums'
  | 'libEmptyArtists'
  | 'libEmptyPodcasts'
  | 'libEmptySubscriptions'
  | 'libEmptyHistory'
> = {
  landing: 'libraryNoItems',
  playlists: 'libEmptyPlaylists',
  songs: 'libEmptySongs',
  albums: 'libEmptyAlbums',
  artists: 'libEmptyArtists',
  subscriptions: 'libEmptySubscriptions',
  history: 'libEmptyHistory',
  podcasts: 'libEmptyPodcasts',
};

/** drop the previous tab's items immediately so the chip never shows stale rows */
export function nextLibraryViewState(
  current: LibraryCategory,
  next: LibraryCategory
): { category: LibraryCategory; clear: boolean } {
  if (current === next) return { category: current, clear: false };
  return { category: next, clear: true };
}

