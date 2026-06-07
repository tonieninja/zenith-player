import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  ChevronLeft,
  Copy,
  Download,
  GitMerge,
  GripVertical,
  Heart,
  ListMusic,
  Music2,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { Language } from '../i18n';
import { ModalOverlay } from './ui/ModalOverlay';
import { translations } from '../i18n';
import {
  createPlaylist,
  deletePlaylist,
  SessionExpiredError,
  type PlaylistPrivacy,
  type Track,
} from '../api/youtube';
import {
  addTracks,
  createWithTracks,
  samePlaylist,
  markOwned,
  preserveOwned,
  filterAndSort,
  listAllPlaylists,
  loadPlaylistDetails,
  moveEntry,
  removeEntries,
  reorder,
  toCsv,
  toJson,
  updatePlaylistDetails,
  type PlaylistDetails,
  type PlaylistEntry,
  type PlaylistKind,
  type PlaylistSort,
  type PlaylistSummary,
} from '../api/playlistManager';
import {
  connectSpotify,
  disconnectSpotify,
  exportToSpotify,
  getSpotifyClientId,
  isSpotifyConnected,
  setSpotifyClientId,
  SPOTIFY_REDIRECT_URI,
  type ExportResult,
} from '../api/spotify';
import { Select } from './ui/Select';
import { PopoverMenu } from './ui/PopoverMenu';
import { pushToast } from './Toast';
import './PlaylistManager.css';

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

export function tracksLabel(
  n: number,
  L: { pmTracks: string; pmTracksOne: string; pmTracksFew: string }
): string {
  if (n === 1) return L.pmTracksOne;
  const tens = n % 100;
  const few = n % 10 >= 2 && n % 10 <= 4 && (tens < 12 || tens > 14);
  return (few ? L.pmTracksFew : L.pmTracks).replace('{n}', String(n));
}

const fmtTotal = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

const fmtDur = (s: number | null) =>
  s === null ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

const COVER_HUES = [262, 218, 330, 188, 24, 145, 290, 205];

function hueFor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return COVER_HUES[h % COVER_HUES.length];
}

function PmCover({
  src,
  seed,
  kind,
  mosaic,
  className,
  size = 18,
}: {
  src?: string;
  seed: string;
  kind?: PlaylistKind;
  mosaic?: string[];
  className: string;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (src && !broken) {
    return (
      <img className={className} src={src} alt="" loading="lazy" onError={() => setBroken(true)} />
    );
  }
  const tiles = (mosaic ?? []).filter(Boolean).slice(0, 4);
  if (tiles.length === 4) {
    return (
      <span className={`${className} pm-mosaic`}>
        {tiles.map((t, i) => (
          <img key={i} src={t} alt="" loading="lazy" />
        ))}
      </span>
    );
  }
  const hue = kind === 'liked' ? 340 : hueFor(seed);
  return (
    <span
      className={`${className} pm-cover-ph`}
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 70% 58%), hsl(${(hue + 48) % 360} 65% 34%))`,
      }}
    >
      {kind === 'liked' ? <Heart size={size} fill="currentColor" /> : <ListMusic size={size} />}
    </span>
  );
}

export function PlaylistManager({
  lang,
  ownerName,
  onClose,
  onPlay,
  onChanged,
  onSessionExpired,
}: {
  lang: Language;
  ownerName: string | null;
  onClose: () => void;
  onPlay: (tracks: Track[], index: number, title: string) => void;
  onChanged?: (change?: { deletedId?: string }) => void;
  onSessionExpired?: () => void;
}) {
  const t = translations[lang];
  const [lists, setLists] = useState<PlaylistSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<PlaylistSort>('default');
  const [kind, setKind] = useState<PlaylistKind | 'all'>('all');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [details, setDetails] = useState<PlaylistDetails | null>(null);
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [form, setForm] = useState({
    title: '',
    description: '',
    privacy: 'PRIVATE' as PlaylistPrivacy,
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [spotifyOpen, setSpotifyOpen] = useState(false);
  const reqRef = useRef(0);

  const refreshLists = useCallback(async () => {
    try {
      const fresh = await listAllPlaylists(lang, ownerName);
      setLists((prev) => preserveOwned(fresh, prev));
      void Promise.all(
        fresh
          .filter((p) => p.kind === 'saved' && /^(VL)?PL/.test(p.id))
          .map((p) =>
            loadPlaylistDetails(p.id, lang, 0)
              .then((d) => (d.owned ? p.id : null))
              .catch(() => null)
          )
      ).then((ids) => {
        const mine = ids.filter((x): x is string => Boolean(x));
        if (mine.length)
          setLists((prev) => (prev ? mine.reduce((acc, id) => markOwned(acc, id), prev) : prev));
      });
    } catch {
      setLists([]);
    }
  }, [lang, ownerName]);

  useEffect(() => {
    void refreshLists();
  }, [refreshLists]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmDelete && !spotifyOpen) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirmDelete, spotifyOpen]);

  const active = useMemo(
    () => (activeId && lists?.find((p) => samePlaylist(p.id, activeId))) || null,
    [lists, activeId]
  );
  const shown = useMemo(
    () => filterAndSort(lists ?? [], query, sort, kind === 'all' ? undefined : [kind]),
    [lists, query, sort, kind]
  );
  const editableTargets = useMemo(
    () => (lists ?? []).filter((p) => p.editable && p.id !== activeId),
    [lists, activeId]
  );

  const openPlaylist = useCallback(
    async (id: string) => {
      const req = ++reqRef.current;
      setActiveId(id);
      setSelected(new Set());
      setConfirmDelete(false);
      setDetails(null);
      setDetailState('loading');
      try {
        const d = await loadPlaylistDetails(id, lang, 60, (partial) => {
          if (req !== reqRef.current) return;
          setDetails(partial);
          setDetailState('idle');
        });
        if (req !== reqRef.current) return;
        setDetails(d);
        if (d.owned) setLists((prev) => (prev ? markOwned(prev, id) : prev));
        const summary = lists?.find((p) => samePlaylist(p.id, id));
        setForm({
          title: d.title || summary?.title || '',
          description: d.description,
          privacy: d.privacy ?? 'PRIVATE',
        });
        setDetailState('idle');
      } catch {
        if (req === reqRef.current) setDetailState('failed');
      }
    },
    [lang, lists]
  );

  const run = async (fn: () => Promise<void>, failMsg = t.pmActionFailed) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      console.warn('[playlists]', e);
      if (e instanceof SessionExpiredError) {
        pushToast(t.sessionExpired, 'error');
        onSessionExpired?.();
      } else {
        pushToast(failMsg, 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const entries = details?.entries ?? [];
  const totalSec = entries.reduce((sum, e) => sum + (e.durationSec ?? 0), 0);
  const selectedEntries = entries.filter((e) => selected.has(e.setVideoId || e.videoId));
  const keyOf = (e: PlaylistEntry) => e.setVideoId || e.videoId;
  const asTracks = (list: PlaylistEntry[]): Track[] =>
    list.map((e) => ({
      id: e.videoId,
      type: 'track',
      title: e.title,
      artist: e.artist,
      cover: e.cover,
    }));

  const saveDetails = () =>
    run(async () => {
      if (!active || !details) return;
      const change: { title?: string; description?: string; privacy?: PlaylistPrivacy } = {};
      if (form.title.trim() !== (details.title || active.title)) change.title = form.title;
      if (form.description !== details.description) change.description = form.description;
      if (details.privacy && form.privacy !== details.privacy) change.privacy = form.privacy;
      if (!Object.keys(change).length) return;
      await updatePlaylistDetails(active.id, change, lang);
      setDetails({
        ...details,
        title: form.title.trim(),
        description: form.description,
        privacy: details.privacy ? form.privacy : null,
      });
      setLists(
        (prev) =>
          prev?.map((p) => (p.id === active.id ? { ...p, title: form.title.trim() } : p)) ?? prev
      );
      pushToast(t.pmSaved, 'success', 1800);
      onChanged?.();
    }, t.pmSaveFailed);

  const createNew = () =>
    run(async () => {
      const raw = await createPlaylist(t.pmNewDefaultName, '', 'PRIVATE', lang);
      if (!raw) throw new Error('no playlist id');
      const id = raw.startsWith('VL') ? raw : `VL${raw}`;
      pushToast(fill(t.pmCreated, { name: t.pmNewDefaultName }), 'success', 1800);
      onChanged?.();
      for (let i = 0; i < 4; i += 1) {
        const fresh = await listAllPlaylists(lang, ownerName).catch(() => null);
        if (fresh?.some((p) => samePlaylist(p.id, id))) {
          setLists((prev) => preserveOwned(fresh, prev, [id]));
          break;
        }
        if (i === 3) {
          const stub: PlaylistSummary = {
            id,
            title: t.pmNewDefaultName,
            subtitle: '',
            cover: '',
            count: 0,
            kind: 'own',
            editable: true,
          };
          setLists((prev) => [stub, ...preserveOwned(fresh ?? prev ?? [], prev)]);
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      void openPlaylist(id);
    });

  const duplicate = () =>
    run(async () => {
      if (!active) return;
      const name = fill(t.pmCopyOf, { name: active.title });
      await createWithTracks(
        name,
        details?.description ?? '',
        'PRIVATE',
        entries.map((e) => e.videoId),
        lang
      );
      pushToast(fill(t.pmDuplicated, { name }), 'success');
      await refreshLists();
      onChanged?.();
    });

  const mergeWith = (other: PlaylistSummary) =>
    run(async () => {
      if (!active) return;
      const theirs = await loadPlaylistDetails(other.id, lang);
      const name = fill(t.pmMergedName, { a: active.title, b: other.title }).slice(0, 150);
      await createWithTracks(
        name,
        '',
        'PRIVATE',
        [...entries, ...theirs.entries].map((e) => e.videoId),
        lang
      );
      pushToast(fill(t.pmMerged, { name }), 'success');
      await refreshLists();
      onChanged?.();
    });

  const doDelete = () =>
    run(async () => {
      if (!active) return;
      await deletePlaylist(active.id, lang);
      setConfirmDelete(false);
      setActiveId(null);
      setDetails(null);
      setLists((prev) => prev?.filter((p) => p.id !== active.id) ?? prev);
      pushToast(t.pmDeleted, 'success');
      onChanged?.({ deletedId: active.id });
    });

  const removeSelected = () =>
    run(async () => {
      if (!active || !details || !selectedEntries.length) return;
      await removeEntries(active.id, selectedEntries, lang);
      const gone = new Set(selectedEntries.map(keyOf));
      setDetails({ ...details, entries: entries.filter((e) => !gone.has(keyOf(e))) });
      setSelected(new Set());
      pushToast(fill(t.pmRemoved, { count: tracksLabel(gone.size, t) }), 'success');
      onChanged?.();
    });

  const addSelectedTo = (target: PlaylistSummary) =>
    run(async () => {
      const ids = (selectedEntries.length ? selectedEntries : entries).map((e) => e.videoId);
      if (!ids.length) return;
      await addTracks(target.id, ids, lang);
      pushToast(
        fill(t.pmAdded, { count: tracksLabel(ids.length, t), name: target.title }),
        'success'
      );
      onChanged?.();
    });

  const onDrop = (to: number) => {
    const from = dragFrom;
    setDragFrom(null);
    setDragOver(null);
    if (from === null || from === to || !active?.editable || !details) return;
    const before = entries;
    setDetails({ ...details, entries: reorder(entries, from, to) });
    moveEntry(active.id, before, from, to, lang).catch(() => {
      setDetails((d) => (d ? { ...d, entries: before } : d));
      pushToast(t.pmMoveFailed, 'error');
    });
  };

  const saveExport = (ext: 'csv' | 'json') =>
    run(async () => {
      if (!active) return;
      const contents = ext === 'csv' ? toCsv(active.title, entries) : toJson(active.title, entries);
      const path = await invoke<string>('save_playlist_export', {
        name: active.title,
        ext,
        contents,
      });
      pushToast(fill(t.pmExportSaved, { path }), 'success', 6000);
    });

  const kinds: { id: PlaylistKind | 'all'; label: string }[] = [
    { id: 'all', label: t.pmKindAll },
    { id: 'own', label: t.pmKindOwn },
    { id: 'saved', label: t.pmKindSaved },
    { id: 'liked', label: t.pmKindLiked },
    { id: 'generated', label: t.pmKindGenerated },
  ];

  return (
    <ModalOverlay onClick={onClose} testId="playlist-manager-overlay">
      <div
        className="glass-modal-container pm-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t.pmTitle}
      >
        <div className="modal-header-polished">
          <h2>{t.pmTitle}</h2>
          <X size={26} className="modal-close-icon" onClick={onClose} aria-label={t.pmCancel} />
        </div>
        <div className={`pm-body ${active ? 'has-active' : ''}`}>
          <aside className="pm-side">
            <div className="pm-search">
              <Search size={15} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t.pmSearch}
                aria-label={t.pmSearch}
              />
            </div>
            <div className="pm-side-tools">
              <Select<PlaylistSort>
                value={sort}
                onChange={setSort}
                ariaLabel={t.pmSortDefault}
                options={[
                  { value: 'default', label: t.pmSortDefault },
                  { value: 'title', label: t.pmSortTitle },
                  { value: 'count', label: t.pmSortCount },
                ]}
              />
              <button className="pm-btn pm-btn-accent" onClick={createNew} disabled={busy}>
                <Plus size={15} /> {t.pmNew}
              </button>
            </div>
            <div className="pm-chips" role="tablist">
              {kinds.map((k) => (
                <button
                  key={k.id}
                  role="tab"
                  aria-selected={kind === k.id}
                  className={`pm-chip ${kind === k.id ? 'on' : ''}`}
                  onClick={() => setKind(k.id)}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <div className="pm-list">
              {lists === null ? (
                <div className="pm-empty">{t.pmLoading}</div>
              ) : shown.length === 0 ? (
                <div className="pm-empty">{lists.length ? t.pmNoMatch : t.pmEmptyList}</div>
              ) : (
                shown.map((p) => (
                  <button
                    key={p.id}
                    className={`pm-list-row ${p.id === activeId ? 'active' : ''}`}
                    onClick={() => void openPlaylist(p.id)}
                  >
                    <PmCover className="pm-list-cover" src={p.cover} seed={p.title} kind={p.kind} />
                    <span className="pm-list-text">
                      <span className="pm-list-title">{p.title}</span>
                      <span className="pm-list-sub">
                        {p.count !== null ? tracksLabel(p.count, t) : p.subtitle}
                      </span>
                    </span>
                    <span className={`pm-kind pm-kind-${p.kind}`}>
                      {kinds.find((k) => k.id === p.kind)?.label}
                    </span>
                  </button>
                ))
              )}
            </div>
          </aside>

          <section className="pm-main">
            {!active ? (
              <div className="pm-empty pm-empty-big">
                <Music2 size={34} />
                <span>{t.pmPick}</span>
              </div>
            ) : (
              <>
                <button className="pm-back" onClick={() => setActiveId(null)}>
                  <ChevronLeft size={16} /> {t.pmBack}
                </button>
                <div className="pm-head">
                  <PmCover
                    className="pm-head-cover"
                    src={active.cover}
                    seed={active.title}
                    kind={active.kind}
                    size={40}
                    mosaic={Array.from(new Set(entries.map((e) => e.cover)))}
                  />
                  <div className="pm-head-fields">
                    <span className="pm-head-stats">
                      {kinds.find((k) => k.id === active.kind)?.label}
                      {' \u00b7 '}
                      {detailState === 'loading' && !entries.length
                        ? t.pmLoading
                        : tracksLabel(entries.length || active.count || 0, t)}
                      {totalSec > 0 && ` \u00b7 ${fmtTotal(totalSec)}`}
                    </span>
                    {active.editable ? (
                      <>
                        <label className="pm-field">
                          <span>{t.pmName}</span>
                          <input
                            value={form.title}
                            maxLength={150}
                            onChange={(e) => setForm({ ...form, title: e.target.value })}
                          />
                        </label>
                        <label className="pm-field">
                          <span>{t.pmDescription}</span>
                          <textarea
                            rows={2}
