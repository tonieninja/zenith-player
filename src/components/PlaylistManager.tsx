import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  ChevronLeft,
  Copy,
  Download,
  GitMerge,
  GripVertical,
  Import,
  Heart,
  ListMusic,
  Music2,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { errorText, type Language, translations } from '../i18n';
import { isTypingEvent } from '../utils/dom';
import { ModalOverlay } from './ui/ModalOverlay';
import {
  createPlaylist,
  deletePlaylist,
  invalidateLibraryCache,
  searchSongsStrict,
  SessionExpiredError,
  type PlaylistPrivacy,
  type Track,
} from '../api/youtube';
import {
  addMissingTracks,
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
  canReadSpotifyPlaylists,
  isSpotifyConnected,
  listSpotifyPlaylists,
  matchOnYoutube,
  setSpotifyClientId,
  spotifyPlaylistTracks,
  SPOTIFY_REDIRECT_URI,
  type ExportResult,
  type ImportResult,
  type SpotifyPlaylist,
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

export const fmtTotal = (sec: number) => {
  // zaokrąglenie całości, bo reszta z godziny zaokrąglona osobno dawała „1 h 60 min”
  const all = Math.round(sec / 60);
  const h = Math.floor(all / 60);
  const m = all % 60;
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
  // pierwsze strony są już widoczne, reszta się dociąga; kopia czy eksport wzięłyby tylko ten kawałek
  const [partial, setPartial] = useState(false);
  const moveChain = useRef<Promise<unknown>>(Promise.resolve());
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
  const [importOpen, setImportOpen] = useState(false);
  const reqRef = useRef(0);

  const refreshLists = useCallback(async () => {
    try {
      const fresh = await listAllPlaylists(lang, ownerName);
      setLists((prev) => preserveOwned(fresh, prev));
      // trzy naraz: setka zapisanych list wysłana jednocześnie to proszenie się o limit zapytań
      const todo = fresh.filter((p) => p.kind === 'saved' && /^(VL)?PL/.test(p.id));
      const mine: string[] = [];
      void Promise.all(
        Array.from({ length: 3 }, async () => {
          for (let p = todo.shift(); p; p = todo.shift()) {
            const d = await loadPlaylistDetails(p.id, lang, 0).catch(() => null);
            if (d?.owned) mine.push(p.id);
          }
        })
      ).then(() => {
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
      if (e.key !== 'Escape' || e.defaultPrevented || isTypingEvent(e)) return;
      if (!confirmDelete && !spotifyOpen && !importOpen) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirmDelete, spotifyOpen, importOpen]);

  const active = useMemo(
    () => (activeId && lists?.find((p) => samePlaylist(p.id, activeId))) || null,
    [lists, activeId]
  );
  // te same warunki co w saveDetails; przy niezapisanych zmianach klik obok okna go nie zamyka
  const dirty =
    !!active &&
    !!details &&
    !partial &&
    (form.title.trim() !== (details.title || active.title) ||
      form.description !== details.description ||
      (!!details.privacy && form.privacy !== details.privacy));
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
      setPartial(true);
      try {
        const d = await loadPlaylistDetails(id, lang, 60, (part) => {
          if (req !== reqRef.current) return;
          setDetails(part);
          setDetailState('idle');
        });
        if (req !== reqRef.current) return;
        setPartial(false);
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
        // lista zostaje oznaczona jako niepełna, żeby eksport, duplikat ani scalanie nie zapisały jej ucięcia
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
        // YouTube pokazuje nową listę z opóźnieniem; ponowienie z pamięci podręcznej nigdy by jej nie zobaczyło
        invalidateLibraryCache();
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
      if (!active || partial) return;
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
      if (!active || partial) return;
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
      if (!active || !details || partial || !selectedEntries.length) return;
      const removed = await removeEntries(active.id, selectedEntries, lang);
      if (!removed.length) throw new Error('nothing removable');
      const gone = new Set(removed.map(keyOf));
      setDetails({ ...details, entries: entries.filter((e) => !gone.has(keyOf(e))) });
      setSelected(new Set());
      pushToast(fill(t.pmRemoved, { count: tracksLabel(gone.size, t) }), 'success');
      onChanged?.();
    });

  const addSelectedTo = (target: PlaylistSummary) =>
    run(async () => {
      if (partial && !selectedEntries.length) return;
      const ids = (selectedEntries.length ? selectedEntries : entries).map((e) => e.videoId);
      if (!ids.length) return;
      const added = await addMissingTracks(target.id, ids, lang);
      if (!added) {
        pushToast(fill(t.alreadyInPlaylist, { name: target.title }), 'info');
        return;
      }
      pushToast(fill(t.pmAdded, { count: tracksLabel(added, t), name: target.title }), 'success');
      onChanged?.();
    });

  const onDrop = (to: number) => {
    const from = dragFrom;
    setDragFrom(null);
    setDragOver(null);
    // kolejna doczytana strona nadpisałaby zmianę zrobioną w trakcie ładowania
    if (from === null || from === to || !active?.editable || !details || partial) return;
    const before = entries;
    const id = active.id;
    setDetails({ ...details, entries: reorder(entries, from, to) });
    // przesunięcia po kolei: równoległe liczyły pozycje z różnych wersji listy
    moveChain.current = moveChain.current
      .then(() => moveEntry(id, before, from, to, lang))
      .catch(() => {
        pushToast(t.pmMoveFailed, 'error');
        void openPlaylist(id);
      });
  };

  const saveExport = (ext: 'csv' | 'json') =>
    run(async () => {
      if (!active || partial) return;
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
    <ModalOverlay onClick={() => !dirty && onClose()} testId="playlist-manager-overlay">
      <div className="glass-modal-container pm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t.pmTitle}</h2>
          <button
            type="button"
            className="modal-close-icon"
            aria-label={t.winClose}
            title={t.winClose}
            onClick={onClose}
          >
            <X size={26} />
          </button>
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
              <button
                className="pm-btn"
                onClick={() => setImportOpen(true)}
                disabled={busy}
                title={t.pmSpotifyImport}
                aria-label={t.pmSpotifyImport}
              >
                <Import size={15} />
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
                            maxLength={5000}
                            value={form.description}
                            onChange={(e) => setForm({ ...form, description: e.target.value })}
                          />
                        </label>
                        <div className="pm-field-row">
                          {details?.privacy && (
                            <label className="pm-field pm-field-inline">
                              <span>{t.pmPrivacy}</span>
                              <Select<PlaylistPrivacy>
                                value={form.privacy}
                                onChange={(v) => setForm({ ...form, privacy: v })}
                                ariaLabel={t.pmPrivacy}
                                options={[
                                  { value: 'PRIVATE', label: t.pmPrivate },
                                  { value: 'UNLISTED', label: t.pmUnlisted },
                                  { value: 'PUBLIC', label: t.pmPublic },
                                ]}
                              />
                            </label>
                          )}
                          <button
                            className="pm-btn pm-btn-accent"
                            onClick={saveDetails}
                            disabled={busy || !details || !form.title.trim()}
                          >
                            {t.pmSave}
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <h3 className="pm-head-title">{active.title}</h3>
                        {details?.description && (
                          <p className="pm-head-desc">{details.description}</p>
                        )}
                        <p className="pm-readonly">{t.pmReadOnly}</p>
                      </>
                    )}
                  </div>
                </div>

                <div className="pm-actions">
                  <button
                    className="pm-btn"
                    disabled={!entries.length}
                    onClick={() => onPlay(asTracks(entries), 0, active.title)}
                  >
                    <Play size={15} /> {t.pmPlay}
                  </button>
                  <button
                    className="pm-btn"
                    disabled={busy || partial || !entries.length}
                    onClick={duplicate}
                  >
                    <Copy size={15} /> {t.pmDuplicate}
                  </button>
                  <PopoverMenu
                    ariaLabel={t.pmMerge}
                    triggerClassName="pm-btn"
                    trigger={
                      <>
                        <GitMerge size={15} /> {t.pmMerge}
                      </>
                    }
                    items={(lists ?? [])
                      .filter((p) => p.id !== active.id)
                      .map((p) => ({
                        key: p.id,
                        label: p.title,
                        disabled: partial,
                        onSelect: () => void mergeWith(p),
                      }))}
                  />
                  <PopoverMenu
                    ariaLabel={t.pmExport}
                    triggerClassName="pm-btn"
                    trigger={
                      <>
                        <Download size={15} /> {t.pmExport}
                      </>
                    }
                    items={[
                      {
                        key: 'csv',
                        label: t.pmExportCsv,
                        disabled: partial || !entries.length,
                        onSelect: () => void saveExport('csv'),
                      },
                      {
                        key: 'json',
                        label: t.pmExportJson,
                        disabled: partial || !entries.length,
                        onSelect: () => void saveExport('json'),
                      },
                      {
                        key: 'spotify',
                        label: t.pmSpotify,
                        disabled: partial || !entries.length,
                        onSelect: () => setSpotifyOpen(true),
                      },
                    ]}
                  />
                  {active.editable && (
                    <button
                      className="pm-btn pm-btn-danger"
                      disabled={busy}
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 size={15} /> {t.pmDelete}
                    </button>
                  )}
                </div>

                {entries.length > 0 && (
                  <div className="pm-selbar">
                    <label className="pm-check">
                      <input
                        type="checkbox"
                        checked={selected.size > 0 && selected.size === entries.length}
                        onChange={(e) =>
                          setSelected(e.target.checked ? new Set(entries.map(keyOf)) : new Set())
                        }
                      />
                      {selected.size ? fill(t.pmSelected, { n: selected.size }) : t.pmSelectAll}
                    </label>
                    {selected.size > 0 && (
                      <>
                        <PopoverMenu
                          ariaLabel={t.pmAddTo}
                          triggerClassName="pm-btn pm-btn-small"
                          trigger={
                            <>
                              <Plus size={14} /> {t.pmAddTo}
                            </>
                          }
                          emptyLabel={t.ctxNoPlaylists}
                          items={editableTargets.map((p) => ({
                            key: p.id,
                            label: p.title,
                            onSelect: () => void addSelectedTo(p),
                          }))}
                        />
                        {active.editable && (
                          <button
                            className="pm-btn pm-btn-small pm-btn-danger"
                            disabled={busy || partial}
                            onClick={removeSelected}
                          >
                            <Trash2 size={14} /> {t.pmRemove}
                          </button>
                        )}
                        <button
                          className="pm-btn pm-btn-small"
                          onClick={() => setSelected(new Set())}
                        >
                          {t.pmClearSelection}
                        </button>
                      </>
                    )}
                    {active.editable && <span className="pm-hint">{t.pmDragHint}</span>}
                  </div>
                )}

                <div className="pm-tracks">
                  {detailState === 'loading' && (
                    <div className="pm-skeleton" aria-label={t.pmLoading}>
                      {Array.from({ length: 8 }, (_, i) => (
                        <span key={i} />
                      ))}
                    </div>
                  )}
                  {detailState === 'failed' && <div className="pm-empty">{t.pmLoadFailed}</div>}
                  {detailState === 'idle' && details && entries.length === 0 && (
                    <div className="pm-empty pm-empty-big">
                      <ListMusic size={34} />
                      <span>{t.pmEmptyTracks}</span>
                    </div>
                  )}
                  {entries.map((e, i) => {
                    const k = keyOf(e);
                    const canDrag = active.editable && !partial && Boolean(e.setVideoId);
                    return (
                      <div
                        key={`${k}-${i}`}
                        className={`pm-track ${selected.has(k) ? 'sel' : ''} ${dragOver === i ? 'drop' : ''} ${dragFrom === i ? 'dragging' : ''}`}
                        draggable={canDrag}
                        onDragStart={(ev) => {
                          setDragFrom(i);
                          ev.dataTransfer.effectAllowed = 'move';
                          ev.dataTransfer.setData('text/plain', String(i));
                        }}
                        onDragOver={(ev) => {
                          if (dragFrom === null) return;
                          ev.preventDefault();
                          setDragOver(i);
                        }}
                        onDragEnd={() => {
                          setDragFrom(null);
                          setDragOver(null);
                        }}
                        onDrop={(ev) => {
                          ev.preventDefault();
                          onDrop(i);
                        }}
                        onDoubleClick={() => onPlay(asTracks(entries), i, active.title)}
                      >
                        {canDrag && <GripVertical size={15} className="pm-grip" />}
                        <input
                          type="checkbox"
                          aria-label={e.title}
                          checked={selected.has(k)}
                          onChange={() =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (next.has(k)) next.delete(k);
                              else next.add(k);
                              return next;
                            })
                          }
                        />
                        <span className="pm-track-n">{i + 1}</span>
                        <PmCover
                          className="pm-track-cover"
                          src={e.cover}
                          seed={e.title}
                          size={14}
                        />
                        <span className="pm-track-text">
                          <span className="pm-track-title">{e.title}</span>
                          <span className="pm-track-artist">{e.artist}</span>
                        </span>
                        <span className="pm-track-album">{e.album}</span>
                        <span className="pm-track-dur">{fmtDur(e.durationSec)}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>
        </div>

        {confirmDelete && active && (
          <div className="pm-dialog-backdrop" onClick={() => setConfirmDelete(false)}>
            <div className="pm-dialog" role="alertdialog" onClick={(e) => e.stopPropagation()}>
              <p>{fill(t.pmDeleteConfirm, { name: active.title })}</p>
              <div className="pm-dialog-actions">
                <button className="pm-btn" onClick={() => setConfirmDelete(false)}>
                  {t.pmCancel}
                </button>
                <button className="pm-btn pm-btn-danger" disabled={busy} onClick={doDelete}>
                  {t.pmDeleteYes}
                </button>
              </div>
            </div>
          </div>
        )}

        {spotifyOpen && active && (
          <SpotifyExport
            lang={lang}
            name={active.title}
            description={details?.description ?? ''}
            entries={entries}
            onClose={() => setSpotifyOpen(false)}
          />
        )}
        {importOpen && (
          <SpotifyImport
            lang={lang}
            onClose={() => setImportOpen(false)}
            onImported={(name) => {
              pushToast(fill(t.pmSpotifyImported, { name }), 'success');
              void refreshLists();
              onChanged?.();
            }}
          />
        )}
      </div>
    </ModalOverlay>
  );
}

function SpotifyExport({
  lang,
  name,
  description,
  entries,
  onClose,
}: {
  lang: Language;
  name: string;
  description: string;
  entries: PlaylistEntry[];
  onClose: () => void;
}) {
  const t = translations[lang];
  const [connected, setConnected] = useState(isSpotifyConnected());
  const [phase, setPhase] = useState<'idle' | 'matching' | 'done'>('idle');
  const [progress, setProgress] = useState({ done: 0, total: entries.length });
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    setPhase('matching');
    try {
      const r = await exportToSpotify(name, description, entries, (done, total) =>
        setProgress({ done, total })
      );
      setResult(r);
      setPhase('done');
    } catch (e) {
      setError(fill(t.pmSpotifyFailed, { err: errorText(t, e) }));
      setPhase('idle');
      if (String((e as Error).message).includes('not connected')) setConnected(false);
    }
  };

  return (
    <div className="pm-dialog-backdrop" onClick={phase === 'matching' ? undefined : onClose}>
      <div
        className="pm-dialog pm-spotify"
        role="dialog"
        aria-label={t.pmSpotify}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{t.pmSpotify}</h3>
        {!connected ? (
          <SpotifyConnect
            lang={lang}
            failText={t.pmSpotifyFailed}
            onClose={onClose}
            onConnected={() => setConnected(true)}
          />
        ) : phase === 'done' && result ? (
          <>
            <p>{fill(t.pmSpotifyDone, { matched: result.matched, total: entries.length })}</p>
            {result.unmatched.length > 0 && (
              <div className="pm-unmatched">
                <span>{t.pmSpotifyUnmatched}</span>
                <ul>
                  {result.unmatched.map((e, i) => (
                    <li key={`${e.videoId}-${i}`}>
                      {e.title} <em>{e.artist}</em>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="pm-dialog-actions">
              <button className="pm-btn" onClick={onClose}>
                {t.pmCancel}
              </button>
              <button
                className="pm-btn pm-btn-accent"
                onClick={() => void openUrl(result.playlistUrl)}
              >
                {t.pmSpotifyOpen}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="pm-hint">{t.pmSpotifyConnected}</p>
            {phase === 'matching' && (
              <div className="pm-progress">
                <div style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
                <span>{fill(t.pmSpotifyMatching, progress)}</span>
              </div>
            )}
            <div className="pm-dialog-actions">
              <button
                className="pm-btn"
                disabled={phase === 'matching'}
                onClick={() => {
                  disconnectSpotify();
                  setConnected(false);
                }}
              >
                {t.pmSpotifyDisconnect}
              </button>
              <button
                className="pm-btn pm-btn-accent"
                disabled={phase === 'matching'}
                onClick={() => void start()}
              >
                {t.pmSpotify}
              </button>
            </div>
          </>
        )}
        {error && <p className="pm-error">{error}</p>}
      </div>
    </div>
  );
}

function SpotifyConnect({
  lang,
  failText,
  onClose,
  onConnected,
}: {
  lang: Language;
  failText: string;
  onClose: () => void;
  onConnected: () => void;
}) {
  const t = translations[lang];
  const [clientId, setClientId] = useState(getSpotifyClientId());
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setError(null);
    setSpotifyClientId(clientId);
    setWaiting(true);
    try {
      await connectSpotify();
      onConnected();
    } catch (e) {
      setError(fill(failText, { err: errorText(t, e) }));
    } finally {
      setWaiting(false);
    }
  };

  return (
    <>
      <label className="pm-field">
        <span>{t.pmSpotifyClientId}</span>
        <input value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} />
      </label>
      <p className="pm-hint">{fill(t.pmSpotifyClientHelp, { uri: SPOTIFY_REDIRECT_URI })}</p>
      <div className="pm-dialog-actions">
        <button className="pm-btn" onClick={onClose}>
          {t.pmCancel}
        </button>
        <button
          className="pm-btn pm-btn-accent"
          disabled={!clientId.trim() || waiting}
          onClick={() => void connect()}
        >
          {waiting ? t.pmSpotifyWaiting : t.pmSpotifyConnect}
        </button>
      </div>
      {error && <p className="pm-error">{error}</p>}
    </>
  );
}

function SpotifyImport({
  lang,
  onClose,
  onImported,
}: {
  lang: Language;
  onClose: () => void;
  onImported: (name: string) => void;
}) {
  const t = translations[lang];
  const [connected, setConnected] = useState(
    () => isSpotifyConnected() && canReadSpotifyPlaylists()
  );
  const [lists, setLists] = useState<SpotifyPlaylist[] | null>(null);
  const [pick, setPick] = useState('');
  const [phase, setPhase] = useState<'idle' | 'matching' | 'done'>('idle');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<(ImportResult & { total: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failText = t.pmSpotifyImportFailed;

  useEffect(() => {
    if (!connected) return;
    listSpotifyPlaylists().then(
      (l) => {
        setLists(l);
        setPick(l[0]?.id ?? '');
      },
      (e) => {
        setError(fill(failText, { err: errorText(t, e) }));
        if (String((e as Error).message).includes('not connected')) setConnected(false);
      }
    );
  }, [connected, failText, t]);

  const start = async () => {
    const pl = lists?.find((p) => p.id === pick);
    if (!pl) return;
    setError(null);
    setPhase('matching');
    try {
      const tracks = await spotifyPlaylistTracks(pl.id);
      setProgress({ done: 0, total: tracks.length });
      const r = await matchOnYoutube(
        tracks,
        (q) => searchSongsStrict(q, lang),
        (done, total) => setProgress({ done, total })
      );
      const name = (pl.name || 'Spotify').slice(0, 150);
      if (r.videoIds.length) {
        await createWithTracks(name, t.pmSpotifyImportedDesc, 'PRIVATE', r.videoIds, lang);
        onImported(name);
      }
      setResult({ ...r, total: tracks.length });
      setPhase('done');
    } catch (e) {
      setError(fill(failText, { err: errorText(t, e) }));
      setPhase('idle');
    }
  };

  return (
    <div className="pm-dialog-backdrop" onClick={phase === 'matching' ? undefined : onClose}>
      <div
        className="pm-dialog pm-spotify"
        role="dialog"
        aria-label={t.pmSpotifyImport}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{t.pmSpotifyImport}</h3>
        {!connected ? (
          <>
            <p className="pm-hint">{t.pmSpotifyReadHint}</p>
            <SpotifyConnect
              lang={lang}
              failText={failText}
              onClose={onClose}
              onConnected={() => setConnected(true)}
            />
          </>
        ) : phase === 'done' && result ? (
          <>
            <p>
              {fill(t.pmSpotifyImportDone, {
                matched: result.videoIds.length,
                total: result.total,
              })}
            </p>
            {result.unmatched.length > 0 && (
              <div className="pm-unmatched">
                <span>{t.pmSpotifyNotOnYtm}</span>
                <ul>
                  {result.unmatched.map((e, i) => (
                    <li key={`${e.title}-${i}`}>
                      {e.title} <em>{e.artist}</em>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="pm-dialog-actions">
              <button className="pm-btn" onClick={onClose}>
                {t.pmCancel}
              </button>
            </div>
          </>
        ) : (
          <>
            {lists === null ? (
              <p className="pm-hint">{t.pmSpotifyLoading}</p>
            ) : lists.length === 0 ? (
              <p className="pm-hint">{t.pmSpotifyNoPlaylists}</p>
            ) : (
              <label className="pm-field">
                <span>{t.pmSpotifyPick}</span>
                <Select<string>
                  value={pick}
                  onChange={setPick}
                  ariaLabel={t.pmSpotifyPick}
                  options={lists.map((p) => ({ value: p.id, label: `${p.name} (${p.total})` }))}
                />
              </label>
            )}
            {phase === 'matching' && (
              <div className="pm-progress">
                <div style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
                <span>{fill(t.pmSpotifyFinding, progress)}</span>
              </div>
            )}
            <div className="pm-dialog-actions">
              <button className="pm-btn" disabled={phase === 'matching'} onClick={onClose}>
                {t.pmCancel}
              </button>
              <button
                className="pm-btn pm-btn-accent"
                disabled={!pick || phase === 'matching'}
                onClick={() => void start()}
              >
                {t.pmSpotifyImportGo}
              </button>
            </div>
          </>
        )}
        {error && <p className="pm-error">{error}</p>}
      </div>
    </div>
  );
}
