export interface PlaylistFolder {
  id: string;
  name: string;
  collapsed?: boolean;
}
export interface FolderState {
  folders: PlaylistFolder[];
  assign: Record<string, string>;
}

const KEY = 'zenith.playlistFolders';

export function loadFolders(): FolderState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (v && Array.isArray(v.folders) && v.assign && typeof v.assign === 'object') return v;
  } catch {}
  return { folders: [], assign: {} };
}

export function saveFolders(s: FolderState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}

export function addFolder(s: FolderState, name: string): [FolderState, string] {
  const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return [{ ...s, folders: [...s.folders, { id, name: name.trim().slice(0, 80) }] }, id];
}

export function renameFolder(s: FolderState, id: string, name: string): FolderState {
  return {
    ...s,
    folders: s.folders.map((f) => (f.id === id ? { ...f, name: name.trim().slice(0, 80) } : f)),
  };
}

export function removeFolder(s: FolderState, id: string): FolderState {
  const assign = Object.fromEntries(Object.entries(s.assign).filter(([, f]) => f !== id));
  return { folders: s.folders.filter((f) => f.id !== id), assign };
}

export function toggleFolder(s: FolderState, id: string): FolderState {
  return {
    ...s,
    folders: s.folders.map((f) => (f.id === id ? { ...f, collapsed: !f.collapsed } : f)),
  };
}

export function moveToFolder(
  s: FolderState,
  playlistId: string,
  folderId: string | null
): FolderState {
  const assign = { ...s.assign };
  if (folderId && s.folders.some((f) => f.id === folderId)) assign[playlistId] = folderId;
  else delete assign[playlistId];
  return { ...s, assign };
}

export function groupPlaylists<T extends { id: string }>(
  s: FolderState,
  items: T[]
): { root: T[]; byFolder: Map<string, T[]> } {
  const byFolder = new Map<string, T[]>(s.folders.map((f) => [f.id, []]));
  const root: T[] = [];
  for (const it of items) {
    const f = s.assign[it.id];
    const bucket = f ? byFolder.get(f) : undefined;
    if (bucket) bucket.push(it);
    else root.push(it);
  }
  return { root, byFolder };
}
