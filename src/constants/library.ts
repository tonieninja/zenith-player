import type { LibraryCategory } from '../api/youtube';

export const LIBRARY_CATEGORIES: {
  id: LibraryCategory;
  labelKey: 'libAll' | 'libPlaylists' | 'libSongs' | 'libAlbums' | 'libArtists' | 'libPodcasts';
}[] = [
  { id: 'landing', labelKey: 'libAll' },
  { id: 'playlists', labelKey: 'libPlaylists' },
  { id: 'songs', labelKey: 'libSongs' },
  { id: 'albums', labelKey: 'libAlbums' },
  { id: 'artists', labelKey: 'libArtists' },
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
> = {
  landing: 'libraryNoItems',
  playlists: 'libEmptyPlaylists',
  songs: 'libEmptySongs',
  albums: 'libEmptyAlbums',
  artists: 'libEmptyArtists',
  podcasts: 'libEmptyPodcasts',
};
