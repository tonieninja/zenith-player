import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FolderOpen, Pencil, Plus, Tag, Trash2, X } from 'lucide-react';
import type { Track } from '../api/youtube';
import { listCollections, trackIn, type Collection } from '../api/library';
import { errorText, translations, type Language } from '../i18n';
import { ModalOverlay } from './ui/ModalOverlay';
import { Select } from './ui/Select';
import { pushToast } from './Toast';

interface LibTrack {
  id: string;
  title: string;
  artist: string;
  album?: string | null;
  durationSec?: number | null;
  cover?: string | null;
  addedAt: number;
  plays: number;
  lastPlayed?: number | null;
  tags: string[];
}

type Sort = 'default' | 'title' | 'artist' | 'plays' | 'recent';

const toTrack = (t: LibTrack): Track => ({
  id: t.id,
  type: 'track',
  title: t.title,
  artist: t.artist,
  album: t.album ?? undefined,
  durationSec: t.durationSec ?? undefined,
  cover: t.cover ?? '',
});

/** Nowa kolekcja albo zmiana nazwy; folder to zwykła etykieta grupująca kolekcje w panelu. */
export function CollectionDialog({
  lang,
  initial,
  onDone,
  onClose,
}: {
  lang: Language;
  initial?: Collection;
  onDone: (id: number, name: string) => void;
  onClose: () => void;
}) {
  const t = translations[lang];
  const [name, setName] = useState(initial?.name ?? '');
  const [folder, setFolder] = useState(initial?.folder ?? '');
  const save = () =>
    void invoke<number>('lib_collection_save', { id: initial?.id ?? null, name, folder })
      .then((id) => onDone(id, name.trim()))
      .catch((e) => pushToast(errorText(t, e), 'error'));
  return (
    <ModalOverlay onClick={onClose} onEscape={onClose} testId="collection-dialog">
      <div className="glass-modal-container lib-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{initial ? t.libRenameCollection : t.libNewCollection}</h2>
          <button
            type="button"
            className="modal-close-icon"
            aria-label={t.winClose}
            onClick={onClose}
          >
            <X size={26} />
          </button>
        </div>
        <form
          className="modal-body lib-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save();
          }}
        >
          <input
            autoFocus
            className="lib-input"
            aria-label={t.libCollectionName}
            placeholder={t.libCollectionName}
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="lib-input"
            aria-label={t.libFolderOptional}
            placeholder={t.libFolderOptional}
            value={folder}
            maxLength={120}
            onChange={(e) => setFolder(e.target.value)}
          />
          <button type="submit" className="np-cancel-btn" disabled={!name.trim()}>
            {t.libSave}
          </button>
        </form>
      </div>
    </ModalOverlay>
  );
}

export function TagsDialog({
  lang,
  track,
  onClose,
}: {
  lang: Language;
  track: Track;
  onClose: () => void;
}) {
  const t = translations[lang];
  const [tags, setTags] = useState<string[]>([]);
  const [known, setKnown] = useState<string[]>([]);
  const [text, setText] = useState('');
  useEffect(() => {
    void invoke<string[]>('lib_track_tags', { videoId: track.id }).then(setTags, () => undefined);
    void invoke<{ tag: string }[]>('lib_tags').then(
      (l) => setKnown(l.map((x) => x.tag)),
      () => undefined
    );
  }, [track.id]);
  const add = (raw: string) => {
    const v = raw.trim().toLowerCase();
    if (v && !tags.includes(v)) setTags([...tags, v]);
    setText('');
  };
  const save = () =>
    void invoke('lib_set_tags', {
      track: trackIn(track),
      tags: text.trim() ? [...tags, text] : tags,
    })
      .then(() => {
        pushToast(t.libTagsSaved, 'success');
        onClose();
      })
      .catch((e) => pushToast(errorText(t, e), 'error'));
  return (
    <ModalOverlay onClick={onClose} onEscape={onClose} testId="tags-dialog">
      <div className="glass-modal-container lib-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t.libTagsFor.replace('{title}', track.title)}</h2>
          <button
            type="button"
            className="modal-close-icon"
            aria-label={t.winClose}
            onClick={onClose}
          >
            <X size={26} />
          </button>
        </div>
        <div className="modal-body lib-form">
          <div className="lib-chips">
            {tags.map((g) => (
              <button
                key={g}
                type="button"
                className="lib-chip active"
                onClick={() => setTags(tags.filter((x) => x !== g))}
              >
                {g} <X size={12} />
              </button>
            ))}
          </div>
          <input
            autoFocus
            className="lib-input"
            aria-label={t.libTagPlaceholder}
            placeholder={t.libTagPlaceholder}
            value={text}
            maxLength={40}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                add(text);
              }
            }}
          />
          {known.some((k) => !tags.includes(k)) && (
            <div className="lib-chips">
              {known
                .filter((k) => !tags.includes(k))
                .slice(0, 24)
                .map((k) => (
                  <button key={k} type="button" className="lib-chip" onClick={() => add(k)}>
                    {k}
                  </button>
                ))}
            </div>
          )}
          <button type="button" className="np-cancel-btn" onClick={save}>
            {t.libSave}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

type View = { kind: 'all' } | { kind: 'collection'; id: number } | { kind: 'tag'; tag: string };

export function LocalLibrary({
  lang,
  onClose,
  onPlay,
}: {
  lang: Language;
  onClose: () => void;
  onPlay: (tracks: Track[], index: number, title: string) => void;
}) {
  const t = translations[lang];
  const [cols, setCols] = useState<Collection[]>([]);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [view, setView] = useState<View>({ kind: 'all' });
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('default');
  const [rows, setRows] = useState<LibTrack[]>([]);
  const [dialog, setDialog] = useState<'new' | Collection | null>(null);
  const [tagging, setTagging] = useState<Track | null>(null);
  // kosz kasuje kolekcję bez cofnięcia, więc pierwszy klik tylko uzbraja go na 3 s
  const [armedDelete, setArmedDelete] = useState<number | null>(null);
  useEffect(() => {
    if (armedDelete === null) return;
    const id = window.setTimeout(() => setArmedDelete(null), 3000);
    return () => window.clearTimeout(id);
  }, [armedDelete]);

  const refreshSide = useCallback(() => {
    void listCollections().then(setCols);
    void invoke<{ tag: string; count: number }[]>('lib_tags').then(setTags, () => undefined);
  }, []);
  const refreshRows = useCallback(() => {
    void invoke<LibTrack[]>('lib_query', {
      query: {
        collection: view.kind === 'collection' ? view.id : null,
        tag: view.kind === 'tag' ? view.tag : null,
        search: search || null,
        sort: sort === 'default' ? null : sort,
      },
    }).then(setRows, () => setRows([]));
  }, [view, search, sort]);
  useEffect(refreshSide, [refreshSide]);
  useEffect(refreshRows, [refreshRows]);

  const current = view.kind === 'collection' ? cols.find((c) => c.id === view.id) : undefined;
  const title =
    view.kind === 'collection'
      ? (current?.name ?? '')
      : view.kind === 'tag'
        ? `#${view.tag}`
        : t.libAllSaved;
  const folders = [...new Set(cols.map((c) => c.folder))];
  const tracks = rows.map(toTrack);

  return (
    <ModalOverlay
      // okna tagów i kolekcji są portalem w tym drzewie, więc ich tło też by tu trafiało
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onEscape={onClose}
      testId="local-library"
    >
      <div className="glass-modal-container local-lib" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t.libMine}</h2>
          <button
            type="button"
            className="modal-close-icon"
            aria-label={t.winClose}
            onClick={onClose}
          >
            <X size={26} />
          </button>
        </div>
        <div className="local-lib-body">
          <aside className="local-lib-side">
            <button
              type="button"
              className={`local-lib-nav${view.kind === 'all' ? ' active' : ''}`}
              onClick={() => setView({ kind: 'all' })}
            >
              {t.libAllSaved}
            </button>
            {folders.map((f) => (
              <div key={f || '-'} className="local-lib-group">
                {f && (
                  <div className="local-lib-folder">
                    <FolderOpen size={14} /> {f}
                  </div>
                )}
                {cols
                  .filter((c) => c.folder === f)
                  .map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`local-lib-nav${view.kind === 'collection' && view.id === c.id ? ' active' : ''}`}
                      onClick={() => setView({ kind: 'collection', id: c.id })}
                      onDoubleClick={() => setDialog(c)}
                    >
                      <span>{c.name}</span>
                      <span className="local-lib-count">{c.count}</span>
                    </button>
                  ))}
              </div>
            ))}
            <button
              type="button"
              className="local-lib-nav local-lib-add"
              onClick={() => setDialog('new')}
            >
              <Plus size={14} /> {t.libNewCollection}
            </button>
            {tags.length > 0 && <div className="local-lib-folder">{t.libTags}</div>}
            <div className="lib-chips">
              {tags.map((g) => (
                <button
                  key={g.tag}
                  type="button"
                  className={`lib-chip${view.kind === 'tag' && view.tag === g.tag ? ' active' : ''}`}
                  onClick={() => setView({ kind: 'tag', tag: g.tag })}
                >
                  {g.tag} <span className="local-lib-count">{g.count}</span>
                </button>
              ))}
            </div>
          </aside>
          <section className="local-lib-main">
            <div className="local-lib-toolbar">
              <h3>{title}</h3>
              <input
                className="lib-input"
                aria-label={t.libSearch}
                placeholder={t.libSearch}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Select<Sort>
                value={sort}
                ariaLabel={t.libSort}
                onChange={setSort}
                options={[
                  {
                    value: 'default',
                    label: view.kind === 'collection' ? t.libSortOrder : t.libSortAdded,
                  },
                  { value: 'title', label: t.libSortTitle },
                  { value: 'artist', label: t.libSortArtist },
                  { value: 'plays', label: t.libSortPlays },
                  { value: 'recent', label: t.libSortRecent },
                ]}
              />
              {current && (
                <button
                  type="button"
                  className="np-cancel-btn"
                  aria-label={t.libRenameCollection}
                  title={t.libRenameCollection}
                  onClick={() => setDialog(current)}
                >
                  <Pencil size={16} />
                </button>
              )}
              {current && (
                <button
                  type="button"
                  className="np-cancel-btn"
                  aria-label={
                    armedDelete === current.id ? t.libDeleteConfirm : t.libDeleteCollection
                  }
                  title={t.libDeleteCollection}
                  onClick={() => {
                    if (armedDelete !== current.id) return setArmedDelete(current.id);
                    setArmedDelete(null);
                    void invoke('lib_collection_delete', { id: current.id }).then(
                      () => {
                        setView({ kind: 'all' });
                        refreshSide();
                      },
                      (e) => pushToast(errorText(t, e), 'error')
                    );
                  }}
                >
                  {armedDelete === current.id ? t.libDeleteConfirm : <Trash2 size={16} />}
                </button>
              )}
            </div>
            {rows.length === 0 ? (
              <p className="plugin-desc local-lib-empty">{t.libLocalEmpty}</p>
            ) : (
              // shortcut: wszystkie wiersze naraz (limit 5000 w zapytaniu), WindowedList dopiero przy większych bibliotekach
              <ul className="local-lib-list">
                {rows.map((r, i) => (
                  <li key={r.id} className="local-lib-row">
                    <button
                      type="button"
                      className="local-lib-play"
                      onClick={() => onPlay(tracks, i, title)}
                    >
                      {r.cover ? (
                        <img src={r.cover} alt="" loading="lazy" />
                      ) : (
                        <span className="local-lib-nocover" />
                      )}
                      <span className="local-lib-text">
                        <span className="local-lib-title">{r.title}</span>
                        <span className="local-lib-artist">
                          {r.artist}
                          {r.tags.map((g) => (
                            <span key={g} className="local-lib-tag">
                              #{g}
                            </span>
                          ))}
                        </span>
                      </span>
                      <span className="local-lib-count">{r.plays > 0 ? `${r.plays}×` : ''}</span>
                    </button>
                    <button
                      type="button"
                      className="local-lib-icon"
                      aria-label={t.libEditTags}
                      title={t.libEditTags}
                      onClick={() => setTagging(tracks[i])}
                    >
                      <Tag size={15} />
                    </button>
                    {current && (
                      <button
                        type="button"
                        className="local-lib-icon"
                        aria-label={t.libRemoveFromCollection}
                        title={t.libRemoveFromCollection}
                        onClick={() =>
                          void invoke('lib_collection_remove', {
                            id: current.id,
                            videoId: r.id,
                          }).then(
                            () => {
                              refreshRows();
                              refreshSide();
                            },
                            (e) => pushToast(errorText(t, e), 'error')
                          )
                        }
                      >
                        <X size={15} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      {dialog && (
        <CollectionDialog
          lang={lang}
          initial={dialog === 'new' ? undefined : dialog}
          onClose={() => setDialog(null)}
          onDone={(id) => {
            setDialog(null);
            refreshSide();
            setView({ kind: 'collection', id });
          }}
        />
      )}
      {tagging && (
        <TagsDialog
          lang={lang}
          track={tagging}
          onClose={() => {
            setTagging(null);
            refreshRows();
            refreshSide();
          }}
        />
      )}
    </ModalOverlay>
  );
}
