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
