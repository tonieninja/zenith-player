import type { Language } from '../i18n';
import {
  createPlaylist,
  findContinuationToken,
  getUserPlaylists,
  invalidateLibraryCache,
  isEditablePlaylist,
  rememberPlaylistRenamed,
  toPlainPlaylistId,
  toPlaylistBrowseId,
  ytmAction,
  ytmBrowseRaw,
  type PlaylistPrivacy,
  type Track,
} from './youtube';

export type PlaylistKind = 'liked' | 'own' | 'saved' | 'generated';

export interface PlaylistSummary {
  id: string;
  title: string;
  subtitle: string;
  cover: string;
  count: number | null;
  kind: PlaylistKind;
  editable: boolean;
}

export interface PlaylistEntry {
  videoId: string;
  /** youtube's id for this slot in the playlist, needed to remove or move it */
  setVideoId: string | null;
  title: string;
  artist: string;
  album: string;
  durationSec: number | null;
  cover: string;
}

export interface PlaylistDetails {
  title: string;
  description: string;
  privacy: PlaylistPrivacy | null;
  /** true when youtube hands us the edit header, which only happens for playlists you own */
  owned: boolean;
  entries: PlaylistEntry[];
}

const COUNT_RE = /(\d[\d,.\s]*)\s*(tracks?|songs?|utw\S*|piosen\S*|episodes?|odcin\S*)/i;

export function parseTrackCount(subtitle: string): number | null {
  const m = COUNT_RE.exec(subtitle);
  if (!m) return null;
  const n = Number(m[1].replace(/[\s,.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function classifyPlaylist(
  item: Pick<Track, 'id' | 'artist' | 'title'>,
  owner: string | null
): PlaylistKind {
  const plain = toPlainPlaylistId(item.id);
  if (plain === 'LM' || plain === 'LL') return 'liked';
  if (plain.startsWith('RD') || /youtube music/i.test(item.artist)) return 'generated';
  if (owner && item.artist.toLowerCase().includes(owner.toLowerCase())) return 'own';
  return 'saved';
}

export async function listAllPlaylists(
  lang: Language,
  owner: string | null
): Promise<PlaylistSummary[]> {
  const items = await getUserPlaylists(lang);
  return items.map((p) => {
    const kind = classifyPlaylist(p, owner);
    return {
      id: p.id,
      title: p.title,
      subtitle: p.artist,
      cover: p.coverLarge || p.cover,
      count: parseTrackCount(p.artist),
      kind,
      editable: kind === 'own' && isEditablePlaylist(p.id),
    };
  });
}

export type PlaylistSort = 'default' | 'title' | 'count';

export function filterAndSort(
  list: PlaylistSummary[],
  query: string,
  sort: PlaylistSort,
  kinds?: PlaylistKind[]
): PlaylistSummary[] {
  const q = query.trim().toLowerCase();
  let out = list.filter(
    (p) =>
      (!kinds || kinds.length === 0 || kinds.includes(p.kind)) &&
      (!q || p.title.toLowerCase().includes(q) || p.subtitle.toLowerCase().includes(q))
  );
  if (sort === 'title') out = [...out].sort((a, b) => a.title.localeCompare(b.title));
  if (sort === 'count') out = [...out].sort((a, b) => (b.count ?? -1) - (a.count ?? -1));
  return out;
}

const runsText = (node: any): string =>
  Array.isArray(node?.runs) ? node.runs.map((r: any) => r?.text ?? '').join('') : '';

export function parseDuration(text: string): number | null {
  if (!/^\d+(:\d{1,2}){1,2}$/.test(text.trim())) return null;
  return text
    .trim()
    .split(':')
    .reduce((acc, part) => acc * 60 + Number(part), 0);
}

function entryFromRow(r: any): PlaylistEntry | null {
  const data = r?.playlistItemData;
  const videoId = data?.videoId;
  if (typeof videoId !== 'string' || !videoId) return null;
  const col = (i: number) => r.flexColumns?.[i]?.musicResponsiveListItemFlexColumnRenderer?.text;
  const fixed = runsText(r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text);
  const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
  return {
    videoId,
    setVideoId: typeof data.playlistSetVideoId === 'string' ? data.playlistSetVideoId : null,
    title: runsText(col(0)),
    artist: runsText(col(1)),
    album: runsText(col(2)),
    durationSec: parseDuration(fixed),
    cover: Array.isArray(thumbs) && thumbs.length ? thumbs[thumbs.length - 1].url : '',
  };
}

/** every row with playlistItemData, in page order, skipping suggestion shelves */
export function collectEntries(data: any): PlaylistEntry[] {
  const out: PlaylistEntry[] = [];
  const walk = (n: any, inSuggestions: boolean) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach((x) => walk(x, inSuggestions));
      return;
    }
    if (n.musicResponsiveListItemRenderer) {
      if (!inSuggestions) {
        const e = entryFromRow(n.musicResponsiveListItemRenderer);
        if (e) out.push(e);
      }
      return;
    }
    for (const [k, v] of Object.entries(n)) {
      const sugg =
        inSuggestions ||
        (k === 'musicShelfRenderer' &&
          /suggest|sugest|propozy/i.test(runsText((v as any)?.title) || ''));
      walk(v, sugg);
    }
  };
  walk(data, false);
  return out;
}

export function findHeader(data: any): {
  title: string;
  description: string;
  privacy: PlaylistPrivacy | null;
  owned: boolean;
} {
  let owned = false;
  let title = '';
  let description = '';
  let privacy: PlaylistPrivacy | null = null;
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    const edit = n.musicPlaylistEditHeaderRenderer;
    if (edit) {
      owned = true;
      const p = edit.privacy;
      if (p === 'PRIVATE' || p === 'PUBLIC' || p === 'UNLISTED') privacy = p;
      if (!title) title = runsText(edit.title);
      if (!description) description = runsText(edit.description);
    }
    const head = n.musicResponsiveHeaderRenderer || n.musicDetailHeaderRenderer;
    if (head) {
      if (!title) title = runsText(head.title);
      const d = head.description?.musicDescriptionShelfRenderer?.description ?? head.description;
      if (!description) description = runsText(d);
    }
    Object.values(n).forEach(walk);
  };
  walk(data);
  return { title, description, privacy, owned };
}

export async function loadPlaylistDetails(
  id: string,
  lang: Language,
  maxPages = 60,
  onPage?: (partial: PlaylistDetails) => void
): Promise<PlaylistDetails> {
  const first = await ytmBrowseRaw({ browseId: toPlaylistBrowseId(toPlainPlaylistId(id)) }, lang);
  const head = findHeader(first);
  const entries = collectEntries(first);
  let token = findContinuationToken(first);
  // show the first page right away, big playlists keep filling in behind it
  if (token) onPage?.({ ...head, entries: [...entries] });
  for (let i = 0; token && i < maxPages; i += 1) {
    const page = await ytmBrowseRaw({ continuation: token }, lang);
    entries.push(...collectEntries(page));
    onPage?.({ ...head, entries: [...entries] });
    const next = findContinuationToken(page);
    token = next && next !== token ? next : null;
  }
  return { ...head, entries };
}

async function edit(id: string, actions: Record<string, unknown>[], lang: Language) {
  if (!actions.length) return;
  if (!isEditablePlaylist(id)) throw new Error('playlist not editable');
  await ytmAction('browse/edit_playlist', { playlistId: toPlainPlaylistId(id), actions }, lang);
  invalidateLibraryCache();
}

export function detailActions(change: {
  title?: string;
  description?: string;
  privacy?: PlaylistPrivacy;
}): Record<string, unknown>[] {
  const actions: Record<string, unknown>[] = [];
  if (change.title !== undefined) {
    const name = change.title.trim().slice(0, 150);
    if (!name) throw new Error('empty title');
    actions.push({ action: 'ACTION_SET_PLAYLIST_NAME', playlistName: name });
  }
  if (change.description !== undefined) {
    actions.push({
      action: 'ACTION_SET_PLAYLIST_DESCRIPTION',
      playlistDescription: change.description.slice(0, 5000),
    });
  }
  if (change.privacy) {
    actions.push({ action: 'ACTION_SET_PLAYLIST_PRIVACY', playlistPrivacy: change.privacy });
  }
  return actions;
}

export async function updatePlaylistDetails(
  id: string,
  change: { title?: string; description?: string; privacy?: PlaylistPrivacy },
  lang: Language
) {
  await edit(id, detailActions(change), lang);
  if (change.title) rememberPlaylistRenamed(id, change.title.trim());
}

export async function addTracks(id: string, videoIds: string[], lang: Language) {
  await edit(
    id,
    videoIds.map((v) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: v })),
    lang
  );
}

export async function removeEntries(id: string, entries: PlaylistEntry[], lang: Language) {
  const actions = entries
    .filter((e) => e.setVideoId)
    .map((e) => ({
      action: 'ACTION_REMOVE_VIDEO',
      setVideoId: e.setVideoId,
      removedVideoId: e.videoId,
    }));
  await edit(id, actions, lang);
}

/** where to put a dragged slot: before the entry that will follow it, or at the end */
export function moveAction(
  entries: PlaylistEntry[],
  from: number,
  to: number
): Record<string, unknown> | null {
  if (from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length)
    return null;
  const moved = entries[from];
  if (!moved.setVideoId) return null;
  const rest = entries.filter((_, i) => i !== from);
  const successor = rest[to];
  const action: Record<string, unknown> = {
    action: 'ACTION_MOVE_VIDEO_BEFORE',
    setVideoId: moved.setVideoId,
  };
  if (successor?.setVideoId) action.movedSetVideoIdSuccessor = successor.setVideoId;
  return action;
}

export function reorder<T>(list: T[], from: number, to: number): T[] {
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

export async function moveEntry(
  id: string,
  entries: PlaylistEntry[],
  from: number,
  to: number,
  lang: Language
) {
  const action = moveAction(entries, from, to);
  if (action) await edit(id, [action], lang);
}

/** new playlist with these tracks, used for duplicate and merge */
export async function createWithTracks(
  title: string,
  description: string,
  privacy: PlaylistPrivacy,
  videoIds: string[],
  lang: Language
): Promise<string | null> {
  const unique = [...new Set(videoIds)];
  const newId = await createPlaylist(title, description, privacy, lang);
  if (newId && unique.length) {
    for (let i = 0; i < unique.length; i += 100) {
      await addTracks(newId, unique.slice(i, i + 100), lang);
    }
  }
  return newId;
}

const csvCell = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(title: string, entries: PlaylistEntry[]): string {
  const rows = [['title', 'artist', 'album', 'duration_sec', 'youtube_url']];
  for (const e of entries) {
    rows.push([
      e.title,
      e.artist,
      e.album,
      e.durationSec === null ? '' : String(e.durationSec),
      `https://music.youtube.com/watch?v=${e.videoId}`,
    ]);
  }
  return `# ${title}\n` + rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

export function toJson(title: string, entries: PlaylistEntry[]): string {
  return JSON.stringify(
    {
      title,
      exportedAt: new Date().toISOString(),
      tracks: entries.map((e) => ({
        title: e.title,
        artist: e.artist,
        album: e.album,
        durationSec: e.durationSec,
        videoId: e.videoId,
      })),
    },
    null,
    2
  );
}

export function samePlaylist(a: string, b: string): boolean {
  return toPlainPlaylistId(a) === toPlainPlaylistId(b);
}

/** once details prove we own a playlist, flip its summary to editable */
export function markOwned(list: PlaylistSummary[], id: string): PlaylistSummary[] {
  return list.map((p) =>
    samePlaylist(p.id, id) && isEditablePlaylist(p.id) ? { ...p, kind: 'own', editable: true } : p
  );
}
