import { describe, expect, it } from 'vitest';
import {
  addFolder,
  groupPlaylists,
  moveToFolder,
  removeFolder,
  renameFolder,
} from '../utils/playlistFolders';

describe('playlist folders', () => {
  it('groups, renames and removes without losing playlists', () => {
    let [s, id] = addFolder({ folders: [], assign: {} }, '  Chill ');
    expect(s.folders[0].name).toBe('Chill');
    s = moveToFolder(s, 'b', id);
    s = moveToFolder(s, 'x', 'nope');
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    let g = groupPlaylists(s, items);
    expect(g.root.map((i) => i.id)).toEqual(['a', 'c']);
    expect(g.byFolder.get(id)!.map((i) => i.id)).toEqual(['b']);
    s = renameFolder(s, id, 'Night');
    expect(s.folders[0].name).toBe('Night');
    s = removeFolder(s, id);
    g = groupPlaylists(s, items);
    expect(g.root).toHaveLength(3);
  });
});
