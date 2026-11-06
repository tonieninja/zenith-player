import { applyWheelVolume } from './utils/volumeWheel';
import {
  lazy,
  Suspense,
  type ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  clearAuthCache,
  clearCaches,
  clearHomeBrowseCache,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addToPlaylist,
  setTrackLiked,
  isEditablePlaylist,
  toPlainPlaylistId,
  invalidateLibraryCache,
  getAccountProfile,
  getAudioStream,
  getExplore,
  moodBrowseIdFor,
  getHomeFeed,
  getLibrary,
  extendLibrarySections,
  getLyrics,
  getMoodPlaylist,
  loadPlaylistItems,
  AlreadyInPlaylistError,
  getUserPlaylists,
  getWatchRelated,
  preloadImage,
  resolveLoginState,
  searchMusic,
  isLoggedIn,
  waitForLogin,
  lastSessionCheckWasNetworkError,
  applyInnertubeConfig,
  type LibraryCategory,
  type LyricsProvider,
  type LyricsResult,
  type PlaylistPrivacy,
  type RelatedResult,
  type Section,
  type Track,
  type AccountProfile,
} from './api/youtube';
import {
  createAudio,
  isNativeAudio,
  isRestoredUi,
  takeAudioRestore,
  type PlayerAudio,
} from './audio/engine';
import { getDiscordClientId } from './plugins/discordPresence';
import {
  ExploreView,
  FeedHero,
  FeedSkeleton,
  LibrarySkeleton,
  coverAttrs,
} from './components/FeedUI';
import { HeroSection } from './components/feed/HeroSection';
import { MoodChips } from './components/feed/MoodChips';
import { MoodsGenresView } from './components/feed/MoodsGenresView';
import { QuickPicks, SectionRow } from './components/feed/FeedCarousel';
import { UpNextItem } from './components/player/UpNextItem';
import { WindowedList } from './components/ui/WindowedList';
import { QueueDrawer } from './components/queue/QueueDrawer';
import { ToastHost, pushToast } from './components/Toast';
import { tmark } from './utils/timeline';
import {
  browseIdFromMood,
  browseMoodId,
  isBrowseMood,
  itemClickPlan,
  sidebarClickPlan,
} from './utils/itemClick';
import { SyncedLyricsRail } from './components/SyncedLyricsRail';
import { LIB_EMPTY_KEYS, LIBRARY_CATEGORIES } from './constants/library';
import {
  MINI_PLAYER_SYNC_MS,
  STREAM_CACHE_LIMIT,
  STREAM_CACHE_TTL,
  PREFETCH_PAUSE_AFTER_FAIL_MS,
  UI_PROGRESS_MS,
} from './constants/playback';
import { useDebounce } from './hooks/useDebounce';
import { useScrubBar } from './hooks/useScrubBar';
import { PopoverMenu } from './components/ui/PopoverMenu';
import { PlaylistManager } from './components/PlaylistManager';
import { translations, type Language } from './i18n';
import { AUX_WINDOW_PLUGINS, pluginManager } from './plugins';
import { syncCloseToTray } from './plugins/systemTray';
import { pushHotkeyBindings, syncGlobalHotkeys } from './plugins/globalHotkeys';
import {
  clearAbLoop,
  getAbLoop,
  registerAbLoopSeek,
  setAbPoint,
  tickAbLoop,
} from './plugins/abLoop';
import { registerAutoPauseCallback } from './plugins/autoPauseBlur';
import { Select } from './components/ui/Select';
import {
  addFolder,
  groupPlaylists,
  loadFolders,
  moveToFolder,
  removeFolder,
  renameFolder,
  saveFolders,
  toggleFolder,
  type FolderState,
} from './utils/playlistFolders';
import {
  getCrossfadeSeconds,
  getGaplessAlbums,
  GAPLESS_LEAD_SECS,
  GAPLESS_PREROLL_SECS,
  isAlbumCollectionId,
  planAutoTransition,
} from './plugins/crossfade';

/** fade length for a manual track change when crossfade is on */
const MANUAL_FADE_SECS = 0.35;
import { registerDualSenseHandler } from './plugins/dualSense';
import { bindFx } from './plugins/equalizer';
import {
  pushRemoteLyrics,
  pushRemoteMessage,
  pushRemoteState,
  registerRemotePusher,
  startRemote,
  stopRemote,
  type RemoteCommand,
  type RemoteTrack,
} from './plugins/remoteControl';
import { startDuckMonitor, stopDuckMonitor } from './plugins/duckOnVoice';
import { getFadePauseMs } from './plugins/fadeOnPause';
import {
  broadcastRoom,
  getRoomCode,
  isRoomHost,
  registerRoomStatusHandler,
  registerRoomSyncHandler,
  unregisterRoomSyncHandler,
} from './plugins/listeningRoom';
import {
  getLyricsSyncOffset,
  OVERLAY_SETTINGS_EVENT,
  pushLyricsOverlay,
} from './plugins/lyricsOverlay';
import { registerMediaSessionHandlers } from './plugins/mediaSession';
import { pushMiniPlayerState } from './plugins/miniPlayer';
import { getPreloadDepth } from './plugins/preloadNext';
import { loadPersistedQueue, savePersistedQueue } from './plugins/queuePersist';
import { getRememberedVolume, saveRememberedVolume } from './plugins/rememberVolume';
import { registerKeyboardHandler, setupKeyboardShortcuts } from './plugins/keyboardShortcuts';
import { copyShareCardToClipboard } from './plugins/shareCard';
import {
  getSleepEndsAt,
  rearmSleepTimer,
  registerSleepTimerCallback,
  setSleepTimerMinutes,
} from './plugins/sleepTimer';
import { getPlaybackSpeed } from './plugins/playbackSpeed';
import { rampVolume, rampVolumeAsync } from './plugins/smoothVolume';
import type { LoopMode, ViewTab } from './types/views';
import { getActiveLyricIndex, secondsUntilLyricChange } from './utils/activeLyricIndex';
import { applyCoverTheme, resetCoverTheme } from './utils/coverTheme';
import { formatTime } from './utils/formatTime';
import { localizeLyricsReason } from './utils/lyricsReasons';
import { getRememberLogin, setRememberLogin } from './utils/rememberLogin';
import { setLightLyrics, useLightLyrics } from './utils/lightLyrics';
import {
  checkGithubUpdate,
  checkSignedUpdate,
  GITHUB_RELEASES,
  installPendingUpdate,
} from './utils/appUpdate';
import { resetOnboarding, shouldShowOnboarding } from './utils/onboarding';
import { setActiveLyricLine, useActiveLyricLine } from './utils/activeLyricStore';

// rarely open panels load on demand, keeps them out of the startup parse and heap
const Onboarding = lazy(() =>
  import('./components/Onboarding').then((m) => ({ default: m.Onboarding }))
);
const PluginsPanel = lazy(() =>
  import('./components/PluginsPanel').then((m) => ({ default: m.PluginsPanel }))
);
import { smartShuffle } from './utils/smartShuffle';
import { decidePrevious, pickPrevPosition, popPlayHistory, pushPlayHistory } from './utils/playbackNav';
import { stableOrderSections } from './utils/sections';
import { streamCacheSet } from './utils/streamCache';
import {
  installMaximizeStateHandler,
  installWindowOcclusionHandlers,
} from './utils/windowOcclusion';
import {
  Home,
  Compass,
  Library,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  Volume1,
  VolumeX,
  Shuffle,
  Repeat,
  Repeat1,
  Plus,
  RefreshCw,
  Search,
  Mic2,
  ListMusic,
  ListPlus,
  MoreHorizontal,
  Settings,
  Puzzle,
  X,
  ChevronLeft,
  UserCircle,
  ChevronRight,
  Share2,
  Repeat2,
  Minus,
  Square,
  Maximize2,
  LogOut,
  Loader2,
  Folder,
  FolderOpen,
} from 'lucide-react';
import './App.css';

const appWindow = getCurrentWindow();
/** pseudo mood id for the local favorites list */
const FAVORITES_ID = '__favorites';
/** innertube chokes on (and silently ignores) giant queries, nobody types more than this */
const MAX_SEARCH_LENGTH = 200;

type FeedLoadTab = 'home' | 'explore' | 'mood' | 'search';
const FEED_LOADING_INITIAL: Record<FeedLoadTab, boolean> = {
  home: false,
  explore: false,
  mood: false,
  search: false,
};

/** the player's lyrics list, subscribed to the active line on its own */
function PlayerLyricsRail(props: Omit<ComponentProps<typeof SyncedLyricsRail>, 'idx'>) {
  const idx = useActiveLyricLine();
  return <SyncedLyricsRail {...props} idx={idx} />;
}

/** serialized track for the right-click menu, only rows that are real songs get one */
function ctxTrackAttr(item: Track): string | undefined {
  if (item.type !== 'track' || !/^[\w-]{11}$/.test(item.id)) return undefined;
  return JSON.stringify({
    id: item.id,
    type: 'track',
    title: item.title,
    artist: item.artist,
    cover: item.cover,
  });
}

export default function App() {
  const [sections, setSections] = useState<Section[]>([]);
  const [homeSections, setHomeSections] = useState<Section[]>([]);
  const [exploreSections, setExploreSections] = useState<Section[]>([]);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  /** shared by in-app keys, global hotkeys and the tray */
  const hotkeyActionRef = useRef<((action: string) => void) | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [playingFrom, setPlayingFrom] = useState<string | null>(null);
  const [related, setRelated] = useState<RelatedResult | null>(null);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [panelTab, setPanelTab] = useState<'upnext' | 'related'>('upnext');
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null);
  const lyricsRef = useRef<LyricsResult | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricsProvider, setLyricsProvider] = useState<LyricsProvider>('Auto');
  const lyricsProviderRef = useRef<LyricsProvider>('Auto');
  /** trackId|provider|lang of the last lyrics request, avoids double fetches */
  const lastHydrateKeyRef = useRef('');
  /** true between "load this track" and its audio actually being ready */
  const trackSwitchingRef = useRef(false);
  const [feedLoading, setFeedLoading] =
    useState<Record<FeedLoadTab, boolean>>(FEED_LOADING_INITIAL);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isPluginsOpen, setIsPluginsOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [shareCardOk, setShareCardOk] = useState(false);
  const [abLoop, setAbLoop] = useState(getAbLoop);
  const [activeTab, setActiveTab] = useState<ViewTab>('home');
  const [prevTab, setPrevTab] = useState<ViewTab>('home');
  const [quickPicks, setQuickPicks] = useState<Track[]>([]);
  const [activeMood, setActiveMood] = useState<string | null>(null);
  const [browseTitle, setBrowseTitle] = useState<string | null>(null);
  /** empty playlist / episodes-for-later page, distinct from a failed feed load */
  const [browseEmptyKind, setBrowseEmptyKind] = useState<'episodes' | 'collection' | null>(null);
  // a ui rebuilt after being dropped to the tray comes back without the splash, like
  // showing a hidden window did
  const [showSplash, setShowSplash] = useState(() => !isRestoredUi());
  const [splashLeaving, setSplashLeaving] = useState(false);

  const [prefetchTotal, setPrefetchTotal] = useState(0);
  const [prefetchDone, setPrefetchDone] = useState(0);
  const [prefetchComplete, setPrefetchComplete] = useState(false);
  const [minSplashElapsed, setMinSplashElapsed] = useState(false);
  const mountedRef = useRef(true);

  const audioRef = useRef<PlayerAudio | null>(null);
  const loadGenRef = useRef(0);
  const streamFailStreakRef = useRef(0);
  const streamErrorRetryRef = useRef<string | null>(null);
  const streamAltTriedRef = useRef<string | null>(null);
  const queueIndexRef = useRef(0);
  const queueRef = useRef<Track[]>([]);
  const playByIndexRef = useRef<(index: number, fadeSeconds?: number) => Promise<void>>(
    async () => {}
  );
  const playingFromRef = useRef<string | null>(null);
  // plain playlist id behind "playing from" (null for feeds/search), so a rename or
  // delete of that playlist can update the label
  const playingFromIdRef = useRef<string | null>(null);
  const progressRef = useRef(0);
  const durationRef = useRef(0);
  const volumeRef = useRef(0.8);
  const isPlayingRef = useRef(false);
  const crossfadeEnabledRef = useRef(false);
  /** queue came from an album: eligible for gapless handoff */
  const playingAlbumRef = useRef(false);
  /** next loadTrack must blend even with the crossfade plugin off (gapless album handoff) */
  const forceBlendRef = useRef(false);
  /** track whose successor is already buffered in the idle deck */
  const prerollForRef = useRef<string | null>(null);
  const crossfadeSecsRef = useRef(5);
  const currentTrackIdRef = useRef<string | null>(null);
  const loopModeRef = useRef<LoopMode>('off');
  const streamCacheRef = useRef<Map<string, { url: string; ts: number }>>(new Map());
  const lyricsReqIdRef = useRef(0);
  const relatedReqIdRef = useRef(0);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const progressHandleRef = useRef<HTMLDivElement>(null);
  const progressTimeElRef = useRef<HTMLSpanElement>(null);
  const durationTimeElRef = useRef<HTMLSpanElement>(null);
  const activeTabRef = useRef<ViewTab>('home');
  const panelTabRef = useRef<'upnext' | 'related'>('upnext');
  const lastRoomPushRef = useRef(0);
  const preloadDoneRef = useRef(new Set<string>());
  const paintProgressUiRef = useRef<(t: number, d?: number) => void>(() => {});
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [showRemaining, setShowRemaining] = useState(false);
  const showRemainingRef = useRef(false);
  showRemainingRef.current = showRemaining;
  const [volume, setVolume] = useState(() => {
    if (pluginManager.isEnabled('remember-volume')) {
      const saved = getRememberedVolume();
      if (saved !== null) return saved;
    }
    return 0.8;
  });
  const [isMuted, setIsMuted] = useState(false);
  const [coverVolHint, setCoverVolHint] = useState<number | null>(null);
  const coverVolHintTimer = useRef(0);
  const [loopMode, setLoopMode] = useState<LoopMode>('off');
  const [shuffleOn, setShuffleOn] = useState(false);
  const originalQueueRef = useRef<Track[] | null>(null);
  /** previous-track history under shuffle (ids), most recent last */
  const playHistoryRef = useRef<string[]>([]);
  const autoFadeTrackRef = useRef<string | null>(null);
  const autoFadePendingRef = useRef(false);
  const lastAutoFadeAtRef = useRef(0);
  const overlayPluginsOnRef = useRef(false);
  const secondScreenLyricsRef = useRef(false);
  const activeLyricLineRef = useRef(-1);
  const lyricsSyncOffsetRef = useRef(getLyricsSyncOffset());
  const overlayMetaRef = useRef({
    trackId: '',
    title: '',
    artist: '',
    coverUrl: '',
    syncedLen: 0,
    textLen: 0,
  });

  // library stuff
  const [libAuthed, setLibAuthed] = useState(false);
  const [isOffline, setIsOffline] = useState(
    () => typeof navigator !== 'undefined' && navigator.onLine === false
  );
  useEffect(() => {
    const on = () => setIsOffline(false);
    const off = () => setIsOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  const [authBootstrapping, setAuthBootstrapping] = useState(true);
  const [libError, setLibError] = useState<string | null>(null);
  const [libAccount, setLibAccount] = useState<AccountProfile | null>(null);
  const [pmOpen, setPmOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track } | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [userPlaylists, setUserPlaylists] = useState<Track[]>([]);
  const [libSections, setLibSections] = useState<Section[]>([]);
  const [libLoading, setLibLoading] = useState(false);
  const [libCategory, setLibCategory] = useState<LibraryCategory>('landing');
  const libReqIdRef = useRef(0);
  const loginPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loginPollDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loginFinishingRef = useRef(false);
  const loginClosingRef = useRef(false);
  const loginDoneRef = useRef(false);

  // new playlist popup
  const [npOpen, setNpOpen] = useState(false);
  // rename / delete one of the user's own youtube music playlists
  const [plEdit, setPlEdit] = useState<{ mode: 'rename' | 'delete'; pl: Track } | null>(null);
  const [plEditTitle, setPlEditTitle] = useState('');
  const [plEditBusy, setPlEditBusy] = useState(false);
  const [plEditError, setPlEditError] = useState(false);
  const [plFolders, setPlFolders] = useState<FolderState>(() => loadFolders());
  const updateFolders = useCallback((next: FolderState) => {
    setPlFolders(next);
    saveFolders(next);
  }, []);
  const [fdEdit, setFdEdit] = useState<
    { mode: 'move'; plId: string; target: string } | { mode: 'rename'; folderId: string } | null
  >(null);
  const [fdName, setFdName] = useState('');
  const submitFolderEdit = () => {
    if (!fdEdit) return;
    if (fdEdit.mode === 'rename') {
      if (fdName.trim()) updateFolders(renameFolder(plFolders, fdEdit.folderId, fdName));
    } else if (fdEdit.target === '__new') {
      if (!fdName.trim()) return;
      const [withNew, id] = addFolder(plFolders, fdName);
      updateFolders(moveToFolder(withNew, fdEdit.plId, id));
    } else {
      updateFolders(moveToFolder(plFolders, fdEdit.plId, fdEdit.target || null));
    }
    setFdEdit(null);
  };
  const [npTitle, setNpTitle] = useState('');
  const [npDesc, setNpDesc] = useState('');
  const [npPrivacy, setNpPrivacy] = useState<PlaylistPrivacy>('PRIVATE');
  const [npBusy, setNpBusy] = useState(false);
  const [npError, setNpError] = useState(false);

  // "Save" keeps the whole track locally so Favorites works without a google account
  const [savedTracks, setSavedTracks] = useState<Track[]>(() => {
    try {
      const list = JSON.parse(localStorage.getItem('zenith_saved_tracks') || '[]');
      return Array.isArray(list) ? list.filter((x: Track) => x && typeof x.id === 'string') : [];
    } catch {
      return [];
    }
  });
  const savedIds = useMemo(() => savedTracks.map((x) => x.id), [savedTracks]);

  const [lang, setLang] = useState<Language>(() => {
    return (localStorage.getItem('zenith_lang') as Language) || 'en';
  });
  const [rememberLogin, setRememberLoginState] = useState(() => getRememberLogin());
  const lightLyrics = useLightLyrics();
  const [appVersion, setAppVersion] = useState('1.0.0');
  const [updateBusy, setUpdateBusy] = useState(false);
  // kept language-neutral so the text follows a language switch
  const [updateStatus, setUpdateStatus] = useState<{
    kind: 'newer' | 'current' | 'unpublished' | 'failed';
    tag?: string;
    url?: string;
    /** a signed update (latest.json) is ready to download+install in-app */
    installable?: boolean;
  } | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState<number | null | false>(false);
  const t = translations[lang];
  const tRef = useRef(t);
  tRef.current = t;

  const persistSessionIfWanted = useCallback(async () => {
    if (!getRememberLogin()) return;
    try {
      await invoke('persist_ytm_session');
    } catch (e) {
      console.warn('[auth] persist session failed', e);
    }
  }, []);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  const checkForAppUpdate = useCallback(async () => {
    if (updateBusy) return;
    setUpdateBusy(true);
    setUpdateStatus(null);
    try {
      const signed = await checkSignedUpdate();
      if (signed) {
        setUpdateStatus({ kind: 'newer', tag: signed.version, installable: true });
        pushToast(`${t.updateAvailable}: ${signed.version}`, 'success', 12000, {
          label: t.updateNow,
          onClick: () => void installAppUpdateRef.current(),
        });
        return;
      }
      const result = await checkGithubUpdate(appVersion);
      if (result.status === 'newer') {
        const msg = `${t.updateAvailable}: ${result.tag}`;
        setUpdateStatus({ kind: 'newer', tag: result.tag, url: result.url });
        pushToast(msg, 'success');
      } else if (result.status === 'current') {
        setUpdateStatus({ kind: 'current', tag: result.tag });
        pushToast(t.upToDate, 'success');
      } else {
        setUpdateStatus({ kind: 'unpublished' });
        pushToast(t.updateNotPublished, 'info');
      }
    } catch (e) {
      console.warn('[update]', e);
      setUpdateStatus({ kind: 'failed' });
      pushToast(t.updateCheckFailed, 'error');
    } finally {
      setUpdateBusy(false);
    }
  }, [appVersion, t, updateBusy]);

  const installAppUpdate = useCallback(async () => {
    if (updateInstalling !== false) return;
    setUpdateInstalling(null);
    pushToast(t.updateDownloading, 'info');
    try {
      await installPendingUpdate((pct) => setUpdateInstalling(pct));
    } catch (e) {
      console.warn('[update] install failed', e);
      setUpdateInstalling(false);
      pushToast(t.updateInstallFailed, 'error', 8000, {
        label: t.openRelease,
        onClick: () => void openUrl(`${GITHUB_RELEASES}/latest`).catch(() => {}),
      });
    }
  }, [t, updateInstalling]);
  const installAppUpdateRef = useRef(installAppUpdate);
  installAppUpdateRef.current = installAppUpdate;

  // one quiet signed-update check per launch, well after startup; no polling, no UI unless newer
  useEffect(() => {
    if (import.meta.env.DEV || localStorage.getItem('zenith_auto_update_check') === '0') return;
    const id = window.setTimeout(() => {
      void checkSignedUpdate().then((u) => {
        if (!u) return;
        setUpdateStatus({ kind: 'newer', tag: u.version, installable: true });
        pushToast(`${tRef.current.updateAvailable}: ${u.version}`, 'success', 20000, {
          label: tRef.current.updateNow,
          onClick: () => void installAppUpdateRef.current(),
        });
      });
    }, 20000);
    return () => window.clearTimeout(id);
  }, []);

  const [pluginStates, setPluginStates] = useState<Record<string, boolean>>(() =>
    pluginManager.getStates()
  );
  /** bump this when listening room host/guest flips so the broadcast effect rewires */
  const [roomSyncTick, setRoomSyncTick] = useState(0);
  const togglePlugin = useCallback((id: string) => {
    pluginManager.setEnabled(id, !pluginManager.isEnabled(id));
    setPluginStates(pluginManager.getStates());
  }, []);

  // toggles can flip from outside the panel too (overlay X button, stage bundle)
  useEffect(() => pluginManager.subscribe((states) => setPluginStates(states)), []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>('zenith-aux-window-closed', (e) => {
      pluginManager.markWindowClosed(e.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const crossfadeEnabled = Boolean(pluginStates['crossfade']);
  const crossfadeSecs = getCrossfadeSeconds();
  crossfadeEnabledRef.current = crossfadeEnabled;
  crossfadeSecsRef.current = crossfadeSecs;
  volumeRef.current = volume;
  isPlayingRef.current = isPlaying;
  durationRef.current = duration;
  activeTabRef.current = activeTab;
  panelTabRef.current = panelTab;
  currentTrackIdRef.current = currentTrack?.id ?? null;
  loopModeRef.current = loopMode;
  const [speedRate] = useState(() => getPlaybackSpeed(pluginManager.isEnabled('playback-speed')));

  const [discordClientId, setDiscordClientId] = useState(
    () => localStorage.getItem('zenith_discord_client_id') || ''
  );
  const saveDiscordClientId = useCallback((value: string) => {
    setDiscordClientId(value);
    try {
      if (value.trim()) localStorage.setItem('zenith_discord_client_id', value.trim());
      else localStorage.removeItem('zenith_discord_client_id');
    } catch {}
  }, []);

  const lyricProviders = useMemo<LyricsProvider[]>(
    () => ['Auto', 'Musixmatch', 'YouTube Music', 'LRCLib', 'LyricsGenius', 'Lyrics.ovh'],
    []
  );
  const providerIndex = useMemo(() => {
    const idx = lyricProviders.indexOf(lyricsProvider);
    return idx >= 0 ? idx : 0;
  }, [lyricProviders, lyricsProvider]);
  const cycleProvider = useCallback(
    (dir: 1 | -1) => {
      const next = (providerIndex + dir + lyricProviders.length) % lyricProviders.length;
      setLyricsProvider(lyricProviders[next]);
    },
    [providerIndex, lyricProviders]
  );

  const debugLyricsProviders = useCallback(
    (track: Track) => {
      if (localStorage.getItem('zenith_lyrics_debug') !== '1') return;
      const providers = lyricProviders.filter((p) => p !== 'Auto');
      const label = `${track.title} - ${track.artist}`;
      const started = performance.now();
      console.groupCollapsed(`[lyrics-debug] ${label}`);
      console.debug('[lyrics-debug] providers', providers);
      Promise.allSettled(
        providers.map(async (provider) => {
          const start = performance.now();
          const res = await getLyrics(track, lang, provider);
          const ms = Math.round(performance.now() - start);
          return {
            provider,
            ok: Boolean(res?.synced?.length || res?.text),
            syncedLines: res?.synced?.length || 0,
            textChars: res?.text ? res.text.length : 0,
            ms,
          };
        })
      ).then((results) => {
        const rows = results.map((result, idx) => {
          if (result.status === 'fulfilled') return result.value;
          return { provider: providers[idx], ok: false, error: true, ms: 0 };
        });
        console.table(rows);
        console.debug('[lyrics-debug] total ms', Math.round(performance.now() - started));
        console.groupEnd();
      });
    },
    [lang, lyricProviders]
  );

  const prefetchInflightRef = useRef(0);
  // after a stream failure, background warmups pause for a while: if one track can't be
  // resolved the next ones usually can't either, and every attempt is a yt-dlp + node run
  const prefetchPausedUntilRef = useRef(0);
  // warmups that arrived while 3 were already running. they used to be dropped, so the
  // next queue tracks were never resolved when the home feed warmup came first. newest
  // first: what the queue asked for last is what plays soonest
  const prefetchPendingRef = useRef<Track[]>([]);
  const foregroundResolvingRef = useRef(false);
  const prefetchStreamRef = useRef<((t: Track | undefined) => void) | null>(null);
  const prefetchStream = useCallback(
    (track: Track | undefined) => {
      if (!track) return;
      const now = Date.now();
      if (now < prefetchPausedUntilRef.current) return;
      const cached = streamCacheRef.current.get(track.id);
      if (cached && now - cached.ts < STREAM_CACHE_TTL) return;
      // the track the user just picked resolves first; warmups wait until it has
      if (prefetchInflightRef.current >= 3 || foregroundResolvingRef.current) {
        const pending = prefetchPendingRef.current.filter((t) => t.id !== track.id);
        pending.unshift(track);
        prefetchPendingRef.current = pending.slice(0, 6);
        return;
      }
      prefetchInflightRef.current += 1;
      getAudioStream(track.id, lang)
        .then((url) => {
          if (!url) {
            prefetchPausedUntilRef.current = Date.now() + PREFETCH_PAUSE_AFTER_FAIL_MS;
            return;
          }
          streamCacheSet(streamCacheRef.current, track.id, url, STREAM_CACHE_LIMIT);
        })
        .catch(() => {})
        .finally(() => {
          prefetchInflightRef.current = Math.max(0, prefetchInflightRef.current - 1);
          const next = prefetchPendingRef.current.shift();
          if (next) prefetchStreamRef.current?.(next);
        });
    },
    [lang]
  );
  prefetchStreamRef.current = prefetchStream;

  if (!audioRef.current) {
    audioRef.current = createAudio();
    audioRef.current.volume = volume;
  }
  const audio = audioRef.current;
  queueRef.current = queue;
  queueIndexRef.current = queueIndex;
  playingFromRef.current = playingFrom;

  const isSaved = currentTrack ? savedIds.includes(currentTrack.id) : false;

  const navigateTo = useCallback((tab: ViewTab) => {
    if (tab !== 'player') setPrevTab(tab);
    setActiveTab(tab);
  }, []);

  const feedSeqRef = useRef<Record<FeedLoadTab, number>>({
    home: 0,
    explore: 0,
    mood: 0,
    search: 0,
  });

  const setFeedTabLoading = useCallback((tab: FeedLoadTab, on: boolean) => {
    setFeedLoading((prev) => (prev[tab] === on ? prev : { ...prev, [tab]: on }));
  }, []);

  const showFeedSkeleton = useMemo(() => {
    if (activeTab === 'home') {
      return feedLoading.home && homeSections.length === 0 && quickPicks.length === 0;
    }
    if (activeTab === 'explore') {
      return feedLoading.explore && exploreSections.length === 0;
    }
    if (activeTab === 'mood') return feedLoading.mood && sections.length === 0;
    if (activeTab === 'search') return feedLoading.search && sections.length === 0;
    return false;
  }, [activeTab, feedLoading, homeSections, exploreSections, sections, quickPicks]);

  const tabHasFeedContent = useMemo(() => {
    if (activeTab === 'home') return homeSections.length > 0 || quickPicks.length > 0;
    if (activeTab === 'explore') return exploreSections.length > 0;
    if (activeTab === 'mood' || activeTab === 'search') return sections.length > 0;
    return true;
  }, [activeTab, homeSections, exploreSections, sections, quickPicks]);

  const openPlayer = useCallback(() => {
    setPrevTab((prev) => (prev === 'player' ? 'home' : prev));
    setActiveLyricLine(activeLyricLineRef.current);
    setActiveTab('player');
  }, []);

  useEffect(() => {
    if (activeTab !== 'player') return;
    setActiveLyricLine(activeLyricLineRef.current);
  }, [activeTab]);

  const openMoodsGenres = useCallback(() => navigateTo('moods_genres'), [navigateTo]);

  // switching language must not reload the webview: that used to kill playback, re-buffer
  // the track and re-open every aux window. we swap strings in place and refetch feeds quietly
  const changeLanguage = useCallback(
    (newLang: Language) => {
      if (newLang === lang) return;
      try {
        localStorage.setItem('zenith_lang', newLang);
      } catch {}
      setLang(newLang);
      clearHomeBrowseCache();
      const dataSeq = ++feedSeqRef.current.home;
      getHomeFeed(newLang)
        .then(({ sections: nextHome, quickPicks: picks }) => {
          if (dataSeq !== feedSeqRef.current.home) return;
          setHomeSections(stableOrderSections(nextHome));
          setQuickPicks(picks);
        })
        .catch(() => {});
      if (activeTabRef.current === 'explore') {
        getExplore(newLang)
          .then((data) => setExploreSections(stableOrderSections(data)))
          .catch(() => {});
      }
    },
    [lang]
  );

  useEffect(() => {
    document.documentElement.lang = lang;
    const tt = translations[lang];
    invoke('set_tray_labels', {
      play: tt.trayPlayPause,
      next: tt.trayNext,
      show: tt.trayShow,
      quit: tt.trayQuit,
    }).catch(() => {});
  }, [lang]);

  const debouncedSearch = useDebounce(searchQuery, 400);

  const handleSearch = useCallback(
    (rawQuery: string, language: Language = lang) => {
      const query = rawQuery.trim().slice(0, MAX_SEARCH_LENGTH).trim();
      if (!query) return;
      const dataSeq = ++feedSeqRef.current.search;
      setFeedTabLoading('search', true);
      // never leave the previous query's results on screen while the new one loads
      setSections([]);
      const safety = window.setTimeout(() => setFeedTabLoading('search', false), 15000);
      navigateTo('search');
      setActiveMood(null);
      setBrowseEmptyKind(null);
      searchMusic(query, language)
        .then((data) => {
          if (dataSeq !== feedSeqRef.current.search) return;
          setSections(stableOrderSections(data));
        })
        .catch(() => {
          if (dataSeq !== feedSeqRef.current.search) return;
          setSections(stableOrderSections([]));
          pushToast(translations[language].searchFailed, 'error');
        })
        .finally(() => {
          window.clearTimeout(safety);
          setFeedTabLoading('search', false);
        });
    },
    [lang, navigateTo, setFeedTabLoading]
  );

  const loadHome = useCallback(
    (language: Language = lang) => {
      const dataSeq = ++feedSeqRef.current.home;
      setFeedTabLoading('home', true);
      navigateTo('home');
      setSearchQuery('');
      setActiveMood(null);
      setBrowseEmptyKind(null);
      clearHomeBrowseCache();
      const safety = window.setTimeout(() => setFeedTabLoading('home', false), 8000);
      getHomeFeed(language)
        .then(({ sections: nextHome, quickPicks: picks }) => {
          if (dataSeq !== feedSeqRef.current.home) return;
          const normalizedHome = stableOrderSections(nextHome);
          setHomeSections(normalizedHome);
          setQuickPicks(picks);
          tmark('home feed ready');
          try {
            const allTracks = [
              ...picks,
              ...normalizedHome.flatMap((s) => s.items).filter((i) => i.type === 'track'),
            ];
            startBackgroundPrefetch(allTracks);
            allTracks.slice(0, 3).forEach((t) => prefetchStream(t));
          } catch {}
        })
        .catch(() => {
          if (dataSeq !== feedSeqRef.current.home) return;
        })
        .finally(() => {
          window.clearTimeout(safety);
          setFeedTabLoading('home', false);
        });
    },
    [lang, navigateTo, setFeedTabLoading, prefetchStream]
  );

  const searchLangRef = useRef(lang);
  useEffect(() => {
    const langChanged = searchLangRef.current !== lang;
    searchLangRef.current = lang;
    if (!debouncedSearch.trim()) return;
    // a language switch only refreshes results the user is actually looking at
    if (langChanged && activeTabRef.current !== 'search') return;
    handleSearch(debouncedSearch, lang);
  }, [debouncedSearch, lang, handleSearch]);

  useEffect(() => {
    if (searchQuery.trim() !== '' || activeTab !== 'search') return;
    loadHome(lang);
  }, [searchQuery, activeTab, lang, loadHome]);

  const loadExplore = useCallback(
    (language: Language = lang) => {
      const dataSeq = ++feedSeqRef.current.explore;
      setFeedTabLoading('explore', true);
      navigateTo('explore');
      setSearchQuery('');
      setActiveMood(null);
      setBrowseEmptyKind(null);
      clearHomeBrowseCache();
      const safety = window.setTimeout(() => setFeedTabLoading('explore', false), 8000);
      getExplore(language)
        .then((data) => {
          if (dataSeq !== feedSeqRef.current.explore) return;
          setExploreSections(stableOrderSections(data));
        })
        .catch(() => {
          if (dataSeq !== feedSeqRef.current.explore) return;
        })
        .finally(() => {
          window.clearTimeout(safety);
          setFeedTabLoading('explore', false);
        });
    },
    [lang, navigateTo, setFeedTabLoading]
  );

  const loadMood = useCallback(
    (categoryId: string, browseId: string, language: Language = lang) => {
      const dataSeq = ++feedSeqRef.current.mood;
      setFeedTabLoading('mood', true);
      navigateTo('mood');
      setSearchQuery('');
      setBrowseTitle(null);
      setBrowseEmptyKind(null);
      setActiveMood(categoryId);
      const safety = window.setTimeout(() => setFeedTabLoading('mood', false), 8000);
      getMoodPlaylist(browseId, language)
        .then((data) => {
          if (dataSeq !== feedSeqRef.current.mood) return;
          setSections(stableOrderSections(data));
        })
        .catch(() => {
          if (dataSeq !== feedSeqRef.current.mood) return;
          setSections(stableOrderSections([]));
        })
        .finally(() => {
          window.clearTimeout(safety);
          setFeedTabLoading('mood', false);
        });
    },
    [lang, navigateTo, setFeedTabLoading]
  );

  const openBrowsePage = useCallback(
    (item: Track) => {
      const dataSeq = ++feedSeqRef.current.mood;
      setFeedTabLoading('mood', true);
      setSearchQuery('');
      setActiveMood(browseMoodId(item.id));
      setBrowseTitle(item.title);
      setBrowseEmptyKind(null);
      setSections([]);
      navigateTo('mood');
      const safety = window.setTimeout(() => setFeedTabLoading('mood', false), 12000);
      getMoodPlaylist(item.id, lang)
        .then((data) => {
          if (dataSeq !== feedSeqRef.current.mood) return;
          setSections(stableOrderSections(data));
        })
        .catch(() => {
          if (dataSeq !== feedSeqRef.current.mood) return;
          setSections(stableOrderSections([]));
          pushToast(translations[lang].playlistOpenFailed, 'error');
        })
        .finally(() => {
          window.clearTimeout(safety);
          if (dataSeq === feedSeqRef.current.mood) setFeedTabLoading('mood', false);
        });
    },
    [lang, navigateTo, setFeedTabLoading]
  );

  const openCollectionPage = useCallback(
    async (collection: Track) => {
      const dataSeq = ++feedSeqRef.current.mood;
      const plain = toPlainPlaylistId(collection.id);
      const emptyKind = plain === 'SE' ? 'episodes' : 'collection';
      setFeedTabLoading('mood', true);
      setSearchQuery('');
      setActiveMood(browseMoodId(collection.id));
      setBrowseTitle(collection.title);
      setBrowseEmptyKind(null);
      setSections([]);
      navigateTo('mood');
      const safety = window.setTimeout(() => setFeedTabLoading('mood', false), 12000);
      try {
        const res = await loadPlaylistItems(collection.id, lang);
        if (dataSeq !== feedSeqRef.current.mood) return;
        if (res.items.length) {
          setBrowseEmptyKind(null);
          setSections([{ title: collection.title, items: res.items }]);
          return;
        }
        setSections([]);
        setBrowseEmptyKind(emptyKind);
        if (res.status === 'failed') {
          pushToast(translations[lang].playlistOpenFailed, 'error');
        }
      } catch (e) {
        console.warn('[playlist] open page failed', e);
        if (dataSeq === feedSeqRef.current.mood) {
          setSections([]);
          setBrowseEmptyKind(emptyKind);
          pushToast(translations[lang].playlistOpenFailed, 'error');
        }
      } finally {
        window.clearTimeout(safety);
        if (dataSeq === feedSeqRef.current.mood) setFeedTabLoading('mood', false);
      }
    },
    [lang, navigateTo, setFeedTabLoading]
  );

  const openFavorites = useCallback(() => {
    ++feedSeqRef.current.mood;
    setFeedTabLoading('mood', false);
    navigateTo('mood');
    setSearchQuery('');
    setBrowseTitle(t.favs);
    setBrowseEmptyKind(null);
    setActiveMood(FAVORITES_ID);
    setSections(savedTracks.length ? [{ title: t.favs, items: savedTracks }] : []);
  }, [navigateTo, savedTracks, setFeedTabLoading, t.favs]);

  const openMoodById = useCallback(
    (categoryId: string) => {
      const browseId = moodBrowseIdFor(categoryId) ?? moodBrowseIdFor('focus');
      if (browseId) loadMood(categoryId, browseId);
    },
    [loadMood]
  );

  const loadUserPlaylists = useCallback(async () => {
    if (!(await isLoggedIn())) {
      setUserPlaylists([]);
      return;
    }
    const playlists = await getUserPlaylists(lang);
    setUserPlaylists(playlists);
  }, [lang]);

  const refreshAccountProfile = useCallback(async () => {
    if (!(await isLoggedIn())) {
      setLibAccount(null);
      return;
    }
    const profile = await getAccountProfile(lang);
    if (profile) setLibAccount(profile);
  }, [lang]);

  const loadLibrary = useCallback(
    async (category: LibraryCategory = libCategory) => {
      const reqId = ++libReqIdRef.current;
      setLibLoading(true);
      setLibError(null);
      const safety = window.setTimeout(() => setLibLoading(false), 8000);
      try {
        let authed = await isLoggedIn();
        if (!authed) {
          clearAuthCache();
          authed = await isLoggedIn();
        }
        if (reqId !== libReqIdRef.current) return;
        setLibAuthed(authed);
        if (!authed) {
          setLibSections([]);
          return;
        }
        // first paint: only a couple of continuation pages (was up to 60 sequential awaits)
        let sections = await getLibrary(category, lang);
        if (sections.length === 0) {
          await new Promise((r) => setTimeout(r, 400));
          clearAuthCache();
          sections = await getLibrary(category, lang, { bypassCache: true });
        }
        void loadUserPlaylists();
        void refreshAccountProfile();
        if (reqId !== libReqIdRef.current) return;
        setLibSections(sections);
        setLibLoading(false);
        window.clearTimeout(safety);
        // background: keep filling the open shelf without blocking the UI
        void extendLibrarySections(category, lang, sections).then((more) => {
          if (reqId !== libReqIdRef.current) return;
          if (more !== sections) setLibSections(more);
        });
      } catch (e) {
        console.warn('[library] load failed', e);
        if (reqId === libReqIdRef.current) {
          setLibSections([]);
          setLibError(translations[lang].libraryLoadError);
        }
      } finally {
        window.clearTimeout(safety);
        if (reqId === libReqIdRef.current) {
          setLibLoading(false);
        }
      }
    },
    [lang, libCategory, loadUserPlaylists, refreshAccountProfile]
  );

  useEffect(() => {
    if (activeTab === 'library' && libAuthed && !authBootstrapping) {
      void loadLibrary(libCategory);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, libAuthed, authBootstrapping, libCategory]);

  // restore login from the session file, dont poke the webview on boot
  // runs once: a language switch must not re-run the whole session restore
  const authBootRanRef = useRef(false);
  useEffect(() => {
    if (authBootRanRef.current) return;
    authBootRanRef.current = true;
    (async () => {
      try {
        if (getRememberLogin()) {
          try {
            await invoke<boolean>('restore_ytm_session');
            clearAuthCache();
          } catch (e) {
            console.warn('[auth] restore session failed', e);
          }
        } else {
          try {
            await invoke('clear_ytm_session_store');
          } catch {}
          clearAuthCache();
        }
        const authed = await isLoggedIn();
        setLibAuthed(authed);
        if (authed) {
          void loadUserPlaylists();
          void refreshAccountProfile();
          void persistSessionIfWanted();
          void resolveLoginState(lang).then((ok) => {
            // no answer from ytm means we're offline, not signed out: keep the account
            if (!ok && lastSessionCheckWasNetworkError()) {
              setIsOffline(true);
              return;
            }
            if (ok) setIsOffline(false);
            if (!ok) {
              setLibAuthed(false);
              setUserPlaylists([]);
              setLibAccount(null);
            }
          });
        }
      } finally {
        setAuthBootstrapping(false);
      }
    })();
  }, [lang, loadUserPlaylists, persistSessionIfWanted, refreshAccountProfile]);

  const stopLoginPoll = useCallback(() => {
    if (loginPollDelayRef.current) {
      clearTimeout(loginPollDelayRef.current);
      loginPollDelayRef.current = null;
    }
    if (loginPollRef.current) {
      clearInterval(loginPollRef.current);
      loginPollRef.current = null;
    }
  }, []);

  /** steal cookies into zenith, only close the popup once ytm actually says youre in */
  const completeLogin = useCallback(async () => {
    if (loginFinishingRef.current) return;
    loginFinishingRef.current = true;
    try {
      clearAuthCache();
      clearHomeBrowseCache();
      let captured = false;
      try {
        captured = await invoke<boolean>('capture_ytm_login_session');
      } catch {}
      if (!captured) {
        try {
          captured = await invoke<boolean>('sync_ytm_auth_to_main');
        } catch {}
      }
      if (!captured) {
        // rust maybe already stuffed cookies from the popup
        clearAuthCache();
        if (!(await isLoggedIn())) return;
      }
      clearAuthCache();
      let authed = await waitForLogin(lang, 8, 500);
      // the popup handed over real auth cookies but ytm couldn't be reached to double-check
      // (school/company proxy, flaky wifi): trust the fresh cookies instead of leaving the
      // popup hanging on music.youtube.com forever
      if (!authed && captured && lastSessionCheckWasNetworkError() && (await isLoggedIn())) {
        console.warn('[login] session check unreachable, accepting popup cookies');
        authed = true;
      }
      if (!authed) {
        return;
      }
      loginDoneRef.current = true;
      setLoginBusy(false);
      stopLoginPoll();
      try {
        if (getRememberLogin()) await persistSessionIfWanted();
        else await invoke('forget_ytm_session_file');
      } catch {}
      loginClosingRef.current = true;
      try {
        await invoke('close_google_login');
      } catch {}
      window.setTimeout(() => {
        loginClosingRef.current = false;
      }, 800);

      setLibAuthed(true);
      pushToast(translations[lang].loginSuccess, 'success');
      loadHome(lang);
      setLibCategory('landing');
      void loadLibrary('landing');
      void loadUserPlaylists();
      void refreshAccountProfile();
      try {
        await appWindow.setFocus();
      } catch {}
    } finally {
      loginFinishingRef.current = false;
    }
  }, [
    lang,
    loadHome,
    loadLibrary,
    loadUserPlaylists,
    persistSessionIfWanted,
    refreshAccountProfile,
    stopLoginPoll,
  ]);

  const finalizeLoginFromPopup = useCallback(async () => {
    if (loginFinishingRef.current || loginDoneRef.current) return;
    let captured = false;
    try {
      captured = await invoke<boolean>('capture_ytm_login_session');
    } catch {}
    if (!captured) return;
    await completeLogin();
  }, [completeLogin]);

  const handleLogout = useCallback(() => {
    stopLoginPoll();
    setLoginBusy(false);
    loginDoneRef.current = false;
    loginFinishingRef.current = false;

    feedSeqRef.current.home += 1;
    feedSeqRef.current.explore += 1;
    feedSeqRef.current.mood += 1;
    feedSeqRef.current.search += 1;
    libReqIdRef.current += 1;

    clearAuthCache();
    clearCaches();
    streamCacheRef.current.clear();
    setSections([]);
    setHomeSections([]);
    setExploreSections([]);
    setQuickPicks([]);
    setUserPlaylists([]);
    setLibSections([]);
    setLibAccount(null);
    setLibError(null);
    setLibAuthed(false);
    setLibCategory('landing');
    setFeedLoading(FEED_LOADING_INITIAL);
    setLibLoading(false);
    setIsSettingsOpen(false);
    pushToast(translations[lang].loggedOut, 'info');

    void (async () => {
      // each step on its own: one failing must not leave the session file or cookies behind
      for (const cmd of [
        'clear_stream_cache',
        'clear_ytm_auth',
        'clear_ytm_session_store',
        'clear_login_webview_data',
      ]) {
        try {
          await invoke(cmd);
        } catch (e) {
          console.warn(`[logout] ${cmd} failed`, e);
        }
      }
      clearAuthCache();
      clearCaches();
      loadHome(lang);
    })();
  }, [lang, loadHome, stopLoginPoll]);

  const changeLibCategory = useCallback((category: LibraryCategory) => {
    setLibCategory(category);
  }, []);

  const handleLogin = useCallback(async () => {
    clearAuthCache();
    const valid = await resolveLoginState(lang);
    if (!valid && lastSessionCheckWasNetworkError()) {
      // offline: opening the login popup would just show an error page
      setIsOffline(true);
      return;
    }
    setIsOffline(false);
    setLibAuthed(valid);
    if (valid) {
      clearHomeBrowseCache();
      loadHome(lang);
      void loadLibrary();
      void refreshAccountProfile();
      return;
    }
    setLoginBusy(true);
    loginDoneRef.current = false;

    const attachLoginWindowHandlers = () => {
      window.setTimeout(() => {
        void invoke<boolean>('capture_ytm_login_session')
          .then((captured) => {
            if (captured) finalizeLoginFromPopup().catch(() => {});
          })
          .catch(() => {});
      }, 1200);

      WebviewWindow.getByLabel('google-login')
        .then((loginWindow) => {
          loginWindow?.once('tauri://destroyed', () => {
            if (loginClosingRef.current || loginFinishingRef.current || loginDoneRef.current) {
              return;
            }
            setLoginBusy(false);
            clearAuthCache();
            pushToast(translations[lang].loginCancelled, 'info');
          });
        })
        .catch(() => {});
    };

    // popup's already up, just shove it in front
    try {
      const existing = await WebviewWindow.getByLabel('google-login');
      if (existing) {
        await existing.show();
        await existing.setFocus();
        attachLoginWindowHandlers();
        return;
      }
    } catch {}
    try {
      await invoke('open_google_login', { title: t.loginWindowTitle });
    } catch (e) {
      console.error('[login] failed to open the sign-in window', e);
      setLoginBusy(false);
      pushToast(translations[lang].loginFailed, 'error');
      return;
    }

    try {
      const loginWindow = await WebviewWindow.getByLabel('google-login');
      if (!loginWindow) {
        setLoginBusy(false);
        pushToast(translations[lang].loginFailed, 'error');
        return;
      }
      await loginWindow.show();
      await loginWindow.setFocus();
    } catch (e) {
      console.error('[login] sign-in window missing after open', e);
      setLoginBusy(false);
      pushToast(translations[lang].loginFailed, 'error');
      return;
    }

    attachLoginWindowHandlers();
  }, [
    lang,
    t.loginWindowTitle,
    completeLogin,
    finalizeLoginFromPopup,
    loadHome,
    loadLibrary,
    refreshAccountProfile,
  ]);

  const cancelLogin = useCallback(async () => {
    stopLoginPoll();
    loginDoneRef.current = true;
    setLoginBusy(false);
    try {
      await invoke('close_google_login');
    } catch {}
  }, [stopLoginPoll]);

  const refreshAuth = useCallback(() => {
    clearAuthCache();
    clearHomeBrowseCache();
    // "refresh" has to really refetch: library pages were served from the 2-minute
    // browse cache, so the button showed the same (stale) list again
    invalidateLibraryCache();
    loadLibrary();
    loadHome(lang);
  }, [loadLibrary, loadHome, lang]);

  useEffect(() => () => stopLoginPoll(), [stopLoginPoll]);

  // if theyre already on youtube grab the session anyway
  useEffect(() => {
    if (!loginBusy || loginDoneRef.current) return;
    let disposed = false;
    const tick = async () => {
      if (disposed || loginFinishingRef.current || loginDoneRef.current) return;
      try {
        const captured = await invoke<boolean>('capture_ytm_login_session');
        if (captured) await finalizeLoginFromPopup();
      } catch {}
    };
    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, 3000);
    return () => {
      disposed = true;
      clearInterval(id);
    };
  }, [loginBusy, finalizeLoginFromPopup]);

  useEffect(() => {
    let disposed = false;
    const unsubs: Array<() => void> = [];
    const onCookiesSynced = () => {
      finalizeLoginFromPopup().catch(() => {});
    };
    listen('ytm-login-cookies-synced', () => {
      onCookiesSynced();
    }).then((fn) => {
      if (disposed) fn();
      else unsubs.push(fn);
    });
    return () => {
      disposed = true;
      unsubs.forEach((fn) => fn());
    };
  }, [finalizeLoginFromPopup]);

  const submitNewPlaylist = useCallback(async () => {
    if (!npTitle.trim() || npBusy) return;
    setNpBusy(true);
    setNpError(false);
    try {
      const id = await createPlaylist(npTitle.trim(), npDesc.trim(), npPrivacy, lang);
      if (!id) throw new Error('no playlist id');
      setNpOpen(false);
      setNpTitle('');
      setNpDesc('');
      setNpPrivacy('PRIVATE');
      setLibCategory('playlists');
      loadLibrary('playlists');
    } catch {
      setNpError(true);
    } finally {
      setNpBusy(false);
    }
  }, [npTitle, npDesc, npPrivacy, npBusy, lang, loadLibrary]);

  const hydratePanels = useCallback(
    (track: Track) => {
      const provider = lyricsProviderRef.current;
      lastHydrateKeyRef.current = `${track.id}|${provider}|${lang}`;
      const reqId = ++lyricsReqIdRef.current;
      setLyricsLoading(true);
      setLyrics(null);
      lyricsRef.current = null;
      activeLyricLineRef.current = -1;
      setActiveLyricLine(-1);
      const lyricsTrack =
        !track.durationSec && durationRef.current > 0
          ? { ...track, durationSec: durationRef.current }
          : track;
      debugLyricsProviders(lyricsTrack);
      tmark(`lyrics start ${track.id}`);
      getLyrics(lyricsTrack, lang, provider, (plain) => {
        if (reqId !== lyricsReqIdRef.current) return;
        tmark(`lyrics plain ${track.id}`);
        setLyrics(plain);
        setLyricsLoading(false);
      })
        .then((data) => {
          tmark(
            `lyrics end ${track.id} lines=${data?.synced?.length ?? (data?.text ? 'text' : 0)}`
          );
          if (reqId !== lyricsReqIdRef.current) return;
          setLyrics(data);
          setLyricsLoading(false);
        })
        .catch(() => {
          if (reqId !== lyricsReqIdRef.current) return;
          setLyrics(null);
          setLyricsLoading(false);
        });

      if (panelTabRef.current === 'related') {
        const relReqId = ++relatedReqIdRef.current;
        setRelatedLoading(true);
        setRelated(null);
        getWatchRelated(track.id, lang)
          .then((data) => {
            if (relReqId !== relatedReqIdRef.current) return;
            setRelated(data);
            setRelatedLoading(false);
          })
          .catch(() => {
            if (relReqId !== relatedReqIdRef.current) return;
            setRelated(null);
            setRelatedLoading(false);
          });
      }
    },
    [lang, lyricsProvider]
  );

  const fetchRelatedForTrack = useCallback(
    (track: Track) => {
      const relReqId = ++relatedReqIdRef.current;
      setRelatedLoading(true);
      setRelated(null);
      getWatchRelated(track.id, lang)
        .then((data) => {
          if (relReqId !== relatedReqIdRef.current) return;
          setRelated(data);
          setRelatedLoading(false);
        })
        .catch(() => {
          if (relReqId !== relatedReqIdRef.current) return;
          setRelated(null);
          setRelatedLoading(false);
        });
    },
    [lang]
  );

  // the give-up toast names the likely cause (the backend remembers why the last
  // resolve failed): this network blocking YouTube, YouTube's bot check for this IP,
  // the yt-dlp download being blocked, or just this track
  const showStreamStuck = async (L: Language) => {
    let kind: string | null = null;
    try {
      kind = await invoke<string | null>('stream_last_failure');
    } catch {
      /* older backend */
    }
    const tr = translations[L];
    const msg =
      kind === 'network'
        ? tr.streamBlockedNetwork
        : kind === 'bot'
          ? tr.streamBlockedBot
          : kind === 'component'
            ? tr.streamBlockedComponent
            : tr.streamUnavailableStuck;
    pushToast(msg, 'error');
  };

  const resolveStreamUrl = useCallback(
    async (trackId: string, forceFresh = false) => {
      const url = await getAudioStream(trackId, lang, forceFresh);
      if (url) streamCacheSet(streamCacheRef.current, trackId, url, STREAM_CACHE_LIMIT);
      return url;
    },
    [lang]
  );
  const resolveStreamUrlRef = useRef(resolveStreamUrl);
  resolveStreamUrlRef.current = async (id: string) => {
    const c = streamCacheRef.current.get(id);
    if (c && Date.now() - c.ts < STREAM_CACHE_TTL) return c.url;
    return resolveStreamUrl(id);
  };

  const loadTrack = useCallback(
    async (track: Track, autoPlay = true, fadeSeconds?: number, startAt = 0) => {
      const gen = ++loadGenRef.current;
      tmark(`loadTrack ${track.id}`);
      const switchingTrack = currentTrackIdRef.current !== track.id;
      currentTrackIdRef.current = track.id;
      setCurrentTrack(track);
      setBuffering(true);
      const stale = () => gen !== loadGenRef.current;
      // a second after a switch: if the ui says playing, make sure a deck really is
      const scheduleOutputCheck = (g: number) => {
        window.setTimeout(() => {
          if (g !== loadGenRef.current || !isPlayingRef.current) return;
          if (audio.ensureOutput(true)) tmark(`output repaired after switch`);
        }, 1200);
      };

      // everything on screen has to belong to the new track from the very first frame:
      // lyrics/related start loading now (not after the stream resolves), the provider
      // chip goes back to auto and elapsed/duration restart at the new position
      trackSwitchingRef.current = true;
      if (switchingTrack) {
        if (lyricsProviderRef.current !== 'Auto') {
          lyricsProviderRef.current = 'Auto';
          setLyricsProvider('Auto');
        }
      }
      if (lastHydrateKeyRef.current.split('|')[0] !== track.id) hydratePanels(track);
      if (switchingTrack || startAt > 0) {
        progressRef.current = startAt > 0 ? startAt : 0;
        setDuration(0);
        durationRef.current = 0;
        paintProgressUiRef.current(progressRef.current, 0);
        durationTimeElRef.current?.replaceChildren(document.createTextNode(formatTime(0)));
      }
      try {
        await loadTrackInner();
      } finally {
        if (!stale()) trackSwitchingRef.current = false;
      }
      return;

      async function loadTrackInner() {
        const skipOnFail = () => {
          const L = (localStorage.getItem('zenith_lang') as Language) || 'en';
          prefetchPausedUntilRef.current = Date.now() + PREFETCH_PAUSE_AFTER_FAIL_MS;
          streamFailStreakRef.current += 1;
          const streak = streamFailStreakRef.current;
          const qi = queueIndexRef.current;
          const q = queueRef.current;
          if (streak >= 3) {
            void showStreamStuck(L);
            autoFadeTrackRef.current = null;
            window.setTimeout(() => {
              autoFadePendingRef.current = false;
            }, 8000);
            return;
          }
          pushToast(translations[L].streamUnavailable, 'error');
          autoFadeTrackRef.current = null;
          if (autoFadePendingRef.current) {
            autoFadePendingRef.current = false;
            window.setTimeout(() => {
              if (loadGenRef.current !== gen) return;
              void playByIndexRef.current(qi);
            }, 700);
            return;
          }
          if (qi < q.length - 1) {
            window.setTimeout(() => {
              if (loadGenRef.current !== gen) return;
              void playByIndexRef.current(qi + 1);
            }, 700 * streak);
          }
        };

        // a click or skip switches with a short fade (the full crossfade is for the automatic
        // transition at the end of a track, which passes its own length)
        const baseFade = fadeSeconds ?? Math.min(MANUAL_FADE_SECS, getCrossfadeSeconds());
        const fadeDur = audio.isCrossfading ? Math.min(0.55, baseFade) : baseFade;
        const forceBlend = forceBlendRef.current;
        forceBlendRef.current = false;
        const wantFade =
          (crossfadeEnabled || forceBlend) &&
          autoPlay &&
          audio.hasSource &&
          fadeDur > 0 &&
          startAt <= 0;

        if (!wantFade) {
          audio.abortAll();
          setIsPlaying(false);
          progressRef.current = startAt > 0 ? startAt : 0;
          setDuration(0);
          durationRef.current = 0;
          paintProgressUiRef.current(progressRef.current, 0);
          durationTimeElRef.current?.replaceChildren(document.createTextNode(formatTime(0)));
        }

        try {
          foregroundResolvingRef.current = true;
          let streamUrl: string | null;
          try {
            streamUrl = await resolveStreamUrl(track.id);
          } finally {
            foregroundResolvingRef.current = false;
            // let the warmups that waited run now
            window.setTimeout(() => {
              for (let k = 0; k < 3; k++) {
                const next = prefetchPendingRef.current.shift();
                if (!next) break;
                prefetchStreamRef.current?.(next);
              }
            }, 0);
          }
          tmark(`resolved ${track.id} ok=${Boolean(streamUrl)} fade=${wantFade}`);
          if (stale()) return;
          if (!streamUrl) {
            // no client gave this upload out: another upload of the same song first
            try {
              streamUrl = await invoke<string | null>('resolve_alternate_stream', {
                videoId: track.id,
                query: `${track.title} ${track.artist}`,
                title: track.title,
                duration: null,
              });
            } catch {
              streamUrl = null;
            }
            if (stale()) return;
          }
          if (!streamUrl) {
            console.warn('[playback] stream unavailable:', track.id);
            setIsPlaying(false);
            setBuffering(false);
            skipOnFail();
            return;
          }
          if (wantFade) {
            try {
              await audio.crossfadeTo(streamUrl, fadeDur);
              tmark(`crossfade done ${track.id}`);
              if (stale()) return;
              setIsPlaying(true);
              progressRef.current = 0;
              paintProgressUiRef.current(0);
              streamFailStreakRef.current = 0;
              streamErrorRetryRef.current = null;
              autoFadePendingRef.current = false;
              setBuffering(false);
              audio.releaseInactive();
              scheduleOutputCheck(gen);
              return;
            } catch (e) {
              tmark(`crossfade failed ${track.id} ${String(e).slice(0, 120)}`);
              if (stale()) return;
              audio.abortAll();
              progressRef.current = 0;
              setDuration(0);
              durationRef.current = 0;
              paintProgressUiRef.current(0, 0);
              streamUrl = await resolveStreamUrl(track.id, true);
              if (stale() || !streamUrl) {
                setBuffering(false);
                if (!streamUrl) skipOnFail();
                return;
              }
            }
          }
          if (stale()) return;
          audio.src = streamUrl;
          tmark(`src set ${track.id}`);
          audio.volume = volumeRef.current;
          audio.releaseInactive();
          if (startAt > 0) {
            audio.currentTime = startAt;
            progressRef.current = startAt;
            paintProgressUiRef.current(startAt);
          }
          if (autoPlay) {
            try {
              await audio.play();
              tmark(`play resolved ${track.id}`);
              if (stale()) return;
              setIsPlaying(true);
              scheduleOutputCheck(gen);
              streamFailStreakRef.current = 0;
              streamErrorRetryRef.current = null;
              autoFadePendingRef.current = false;
              setBuffering(false);
              return;
            } catch (e) {
              tmark(`play failed ${track.id} ${String(e).slice(0, 120)}`);
              audio.load();
              const ready = await audio.waitReady(5000);
              if (stale()) return;
              if (!ready) {
                const fresh = await resolveStreamUrl(track.id, true);
                if (fresh && gen === loadGenRef.current) {
                  audio.src = fresh;
                  audio.volume = volumeRef.current;
                  try {
                    await audio.play();
                    if (stale()) return;
                    setIsPlaying(true);
                    streamFailStreakRef.current = 0;
                    streamErrorRetryRef.current = null;
                    autoFadePendingRef.current = false;
                    setBuffering(false);
                    return;
                  } catch {
                    /* keep going */
                  }
                }
                setIsPlaying(false);
                setBuffering(false);
                skipOnFail();
                return;
              }
              if (autoPlay) {
                await audio.play();
                if (stale()) return;
                setIsPlaying(true);
              }
            }
          }
          streamFailStreakRef.current = 0;
          streamErrorRetryRef.current = null;
          autoFadePendingRef.current = false;
          setBuffering(false);
        } catch (err) {
          if (stale()) return;
          console.warn('[playback] load failed:', track.id, err);
          setIsPlaying(false);
          setBuffering(false);
          skipOnFail();
        }
      }
    },
    [audio, crossfadeEnabled, resolveStreamUrl, hydratePanels]
  );

  const playByIndex = useCallback(
    async (index: number, fadeSeconds?: number, recordHistory = true) => {
      const q = queueRef.current;
      if (index < 0 || index >= q.length) return;
      const nextTrack = q[index];
      const manualFade =
        fadeSeconds ??
        (crossfadeEnabled ? Math.min(MANUAL_FADE_SECS, getCrossfadeSeconds()) : undefined);
      if (fadeSeconds === undefined) {
        // a manual skip owns the switch: a pending automatic transition must not swallow the
        // old deck's 'ended' or fire again for the track we are leaving
        autoFadePendingRef.current = false;
        autoFadeTrackRef.current = currentTrackIdRef.current;
        forceBlendRef.current = false;
      }
      // previous already popped the stack, so don't push the track we are leaving back onto it
      if (recordHistory) {
        playHistoryRef.current = pushPlayHistory(playHistoryRef.current, currentTrackIdRef.current);
      }
      queueIndexRef.current = index;
      setQueueIndex(index);
      await loadTrack(nextTrack, true, manualFade);
    },
    [loadTrack, crossfadeEnabled]
  );
  playByIndexRef.current = playByIndex;

  const collectionReqRef = useRef(0);
  const handleCollectionClick = useCallback(
    async (collection: Track) => {
      // episodes for later is a saved list, not a "hit play" playlist
      if (toPlainPlaylistId(collection.id) === 'SE') {
        await openCollectionPage(collection);
        return;
      }

      const req = ++collectionReqRef.current;
      const L = translations[lang];
      // big playlists take a moment; say something instead of looking dead
      const slowHint = window.setTimeout(() => {
        if (req === collectionReqRef.current) {
          pushToast(L.openingPlaylist.replace('{name}', collection.title), 'info', 2000);
        }
      }, 700);
      try {
        // show the player immediately so the click does not feel dead while the list loads
        openPlayer();
        setPlayingFrom(collection.title);
        const res = await loadPlaylistItems(collection.id, lang);
        if (req !== collectionReqRef.current) return;
        const items = res.items;
        if (!items.length) {
          // leave the player and show a real empty page instead of a toast with no UI change
          await openCollectionPage(collection);
          return;
        }

        // album pages leave the artist column empty (it is the album's artist), the parser
        // then says "various artists" for every track
        const albumArtist =
          collection.type === 'album'
            ? ((collection.artist || '')
                .split(' • ')
                .map((x) => x.trim())
                .find((x) => x && !/^\d{4}$/.test(x) && !/^(album|single|singiel|ep)$/i.test(x)) ??
              '')
            : '';
        const itemsWithCover = items.map((i) => ({
          ...i,
          artist: albumArtist && i.artist === L.variousArtists ? albumArtist : i.artist,
          cover: i.cover.includes('ui-avatars') ? collection.cover : i.cover,
          coverSmall: i.coverSmall?.includes('ui-avatars') ? collection.coverSmall : i.coverSmall,
          coverLarge: i.coverLarge?.includes('ui-avatars') ? collection.coverLarge : i.coverLarge,
        }));

        setQueue(itemsWithCover);
        setQueueIndex(0);
        setShuffleOn(false);
        originalQueueRef.current = null;
        setPlayingFrom(collection.title);
        playingFromIdRef.current = toPlainPlaylistId(collection.id);
        playingAlbumRef.current = collection.type === 'album' || isAlbumCollectionId(collection.id);
        openPlayer();
        await loadTrack(itemsWithCover[0]);
      } catch (e) {
        console.warn('[playlist] open failed', e);
        if (req === collectionReqRef.current) pushToast(L.playlistOpenFailed, 'error');
      } finally {
        window.clearTimeout(slowHint);
      }
    },
    [lang, openPlayer, loadTrack, openCollectionPage]
  );

  const handleItemClick = useCallback(
    async (track: Track, sectionTitle?: string, sectionItems?: Track[]) => {
      const plan = itemClickPlan(track);
      if (plan.kind === 'browse-page') {
        openBrowsePage(track);
        return;
      }
      if (plan.kind === 'play-collection') {
        await handleCollectionClick(track);
        return;
      }
      openPlayer();
      const items = (sectionItems || []).filter(
        (i) => i.type === 'track' || /^[\w-]{11}$/.test(i.id)
      );
      setShuffleOn(false);
      originalQueueRef.current = null;
      if (items.length > 0) {
        const idx = Math.max(
          0,
          items.findIndex((i) => i.id === track.id)
        );
        setQueue(items);
        setQueueIndex(idx);
        setPlayingFrom(sectionTitle || null);
      } else {
        setQueue([track]);
        setQueueIndex(0);
        setPlayingFrom(null);
      }
      playingFromIdRef.current = null;
      playingAlbumRef.current = false;
      await loadTrack(track);
    },
    [openPlayer, loadTrack, handleCollectionClick, openBrowsePage]
  );

  const togglePlay = useCallback(async () => {
    if (!currentTrack) return;
    const fadeMs = pluginManager.isEnabled('fade-on-pause') ? getFadePauseMs() : 0;
    if (isPlaying) {
      if (fadeMs > 0) {
        await rampVolumeAsync(audio, 0, fadeMs);
        audio.pause();
        audio.volume = volume;
      } else {
        audio.pause();
      }
      setIsPlaying(false);
    } else {
      const deadAudio =
        !audio.hasSource ||
        !audio.isReady ||
        !Number.isFinite(audio.duration) ||
        audio.duration <= 0;
      if (deadAudio) {
        await loadTrack(currentTrack, true, undefined, progressRef.current);
        return;
      }
      try {
        if (fadeMs > 0) {
          audio.volume = 0;
          await audio.play();
          await rampVolumeAsync(audio, volume, fadeMs);
        } else {
          audio.volume = volume;
          await audio.play();
        }
        setIsPlaying(true);
      } catch {
        audio.volume = volume;
        await loadTrack(currentTrack, true, undefined, progressRef.current);
      }
    }
  }, [audio, currentTrack, isPlaying, volume, loadTrack]);

  const playNext = useCallback(() => {
    const idx = queueIndexRef.current;
    const q = queueRef.current;
    if (idx < q.length - 1) playByIndex(idx + 1);
    else if (loopMode === 'all' && q.length > 0) playByIndex(0);
  }, [playByIndex, loopMode]);

  const playPrev = useCallback(() => {
    if (!currentTrack) return;
    const positionSec = pickPrevPosition(progressRef.current, audioRef.current?.currentTime);
    const q = queueRef.current;
    const decision = decidePrevious({
      positionSec,
      queueIndex: queueIndexRef.current,
      queueLength: q.length,
      loopMode,
      shuffleOn,
      historyIds: playHistoryRef.current,
      queueIds: q.map((t) => t.id),
    });
    if (decision.kind === 'restart') {
      audio.currentTime = 0;
      progressRef.current = 0;
      paintProgressUiRef.current(0);
      return;
    }
    if (decision.kind === 'goto') {
      const popped = popPlayHistory(playHistoryRef.current, currentTrack.id);
      playHistoryRef.current = popped.history;
      playByIndex(decision.index, undefined, false);
    }
  }, [audio, currentTrack, playByIndex, loopMode, shuffleOn]);

  const toggleMute = useCallback(() => {
    setIsMuted((m) => {
      audio.muted = !m;
      return !m;
    });
  }, [audio]);

  const cycleLoop = useCallback(() => {
    setLoopMode((m) => (m === 'off' ? 'all' : m === 'all' ? 'one' : 'off'));
  }, []);

  const toggleShuffle = useCallback(() => {
    if (queue.length === 0) return;
    if (!shuffleOn) {
      originalQueueRef.current = queue;
      const current = queue[queueIndex];
      const rest = queue.filter((_, i) => i !== queueIndex);
      setQueue(current ? [current, ...smartShuffle(rest)] : smartShuffle(rest));
      setQueueIndex(0);
      setShuffleOn(true);
    } else {
      const original = originalQueueRef.current;
      if (original && original.length > 0) {
        const idx = currentTrack
          ? Math.max(
              0,
              original.findIndex((i) => i.id === currentTrack.id)
            )
          : 0;
        setQueue(original);
        setQueueIndex(idx);
      }
      originalQueueRef.current = null;
      playHistoryRef.current = [];
      setShuffleOn(false);
    }
  }, [queue, queueIndex, shuffleOn, currentTrack]);

  const toggleSave = useCallback(() => {
    if (!currentTrack) return;
    const track: Track = {
      id: currentTrack.id,
      type: 'track',
      title: currentTrack.title,
      artist: currentTrack.artist,
      cover: currentTrack.cover,
      coverSmall: currentTrack.coverSmall,
      coverLarge: currentTrack.coverLarge,
    };
    const had = savedTracks.some((x) => x.id === track.id);
    pushToast(had ? t.removedFromFavs : t.addedToFavs, 'success', 1800);
    setSavedTracks((prev) =>
      prev.some((x) => x.id === track.id) ? prev.filter((x) => x.id !== track.id) : [track, ...prev]
    );
    // signed in: mirror the heart to youtube music's Liked Music
    if (libAuthed && /^[\w-]{11}$/.test(track.id)) {
      setTrackLiked(track.id, !had, lang).catch((e) => {
        console.warn('[like] sync failed', e);
        pushToast(translations[lang].likeSyncFailed, 'error');
      });
    }
  }, [currentTrack, savedTracks, t, libAuthed, lang]);

  const addCurrentToPlaylist = useCallback(
    async (pl: Track, allowDuplicate = false, picked?: Track) => {
      const track = picked ?? currentTrack;
      if (!track) return;
      const L = translations[lang];
      try {
        await addToPlaylist(pl.id, track.id, lang, { allowDuplicate });
        pushToast(L.addedToPlaylist.replace('{name}', pl.title), 'success');
      } catch (e) {
        if (e instanceof AlreadyInPlaylistError) {
          pushToast(L.alreadyInPlaylist.replace('{name}', pl.title), 'info', 6000, {
            label: L.addAnyway,
            onClick: () => void addCurrentToPlaylistRef.current(pl, true, track),
          });
          return;
        }
        console.warn('[playlist] add failed', e);
        pushToast(L.addToPlaylistFailed, 'error');
      }
    },
    [currentTrack, lang]
  );
  const addCurrentToPlaylistRef = useRef(addCurrentToPlaylist);
  addCurrentToPlaylistRef.current = addCurrentToPlaylist;

  const submitPlaylistEdit = useCallback(async () => {
    if (!plEdit || plEditBusy) return;
    if (plEdit.mode === 'rename' && !plEditTitle.trim()) return;
    setPlEditBusy(true);
    setPlEditError(false);
    try {
      if (plEdit.mode === 'rename') {
        const title = plEditTitle.trim();
        await renamePlaylist(plEdit.pl.id, title, lang);
        setUserPlaylists((prev) => prev.map((p) => (p.id === plEdit.pl.id ? { ...p, title } : p)));
        setLibSections((prev) =>
          prev.map((sec) => ({
            ...sec,
            items: sec.items.map((p) => (p.id === plEdit.pl.id ? { ...p, title } : p)),
          }))
        );
        if (playingFromIdRef.current === toPlainPlaylistId(plEdit.pl.id)) setPlayingFrom(title);
        pushToast(translations[lang].playlistRenamed, 'success');
      } else {
        await deletePlaylist(plEdit.pl.id, lang);
        // the sidebar and the open library page drop it right away (the server keeps
        // listing it for a bit, getLibrary filters that out too)
        setUserPlaylists((prev) => prev.filter((p) => p.id !== plEdit.pl.id));
        setLibSections((prev) =>
          prev.map((sec) => ({
            ...sec,
            items: sec.items.filter(
              (p) => toPlainPlaylistId(p.id) !== toPlainPlaylistId(plEdit.pl.id)
            ),
          }))
        );
        if (playingFromIdRef.current === toPlainPlaylistId(plEdit.pl.id)) {
          playingFromIdRef.current = null;
          setPlayingFrom(null);
        }
        pushToast(translations[lang].playlistDeleted, 'success');
      }
      setPlEdit(null);
      // the server list is the source of truth, refresh it quietly
      void loadUserPlaylists();
      if (activeTab === 'library') void loadLibrary(libCategory);
    } catch (e) {
      console.warn('[playlist] edit failed', e);
      setPlEditError(true);
    } finally {
      setPlEditBusy(false);
    }
  }, [
    plEdit,
    plEditBusy,
    plEditTitle,
    lang,
    loadUserPlaylists,
    loadLibrary,
    activeTab,
    libCategory,
  ]);

  useEffect(() => {
    if (panelTab !== 'related' || !currentTrack) return;
    fetchRelatedForTrack(currentTrack);
  }, [panelTab, currentTrack?.id, fetchRelatedForTrack]);

  const progressScrubRef = useRef(false);

  const paintProgressUi = useCallback((t: number, d = durationRef.current) => {
    const pct = d > 0 ? (t / d) * 100 : 0;
    progressFillRef.current?.style.setProperty('width', `${pct}%`);
    progressHandleRef.current?.style.setProperty('left', `${pct}%`);
    if (!progressScrubRef.current) {
      progressTimeElRef.current?.replaceChildren(document.createTextNode(formatTime(t)));
    }
    if (showRemainingRef.current && d > 0) {
      durationTimeElRef.current?.replaceChildren(
        document.createTextNode(`-${formatTime(Math.max(0, d - t))}`)
      );
    }
  }, []);
  paintProgressUiRef.current = paintProgressUi;

  const getLyricProgress = useCallback(
    () => audioRef.current?.currentTime ?? progressRef.current,
    []
  );

  const seekTo = useCallback(
    (time: number) => {
      audio.currentTime = time;
      progressRef.current = time;
      paintProgressUi(time);
      const idx = getActiveLyricIndex(lyricsRef.current?.synced, time, lyricsSyncOffsetRef.current);
      activeLyricLineRef.current = idx;
      if (activeTabRef.current === 'player' || overlayPluginsOnRef.current) {
        setActiveLyricLine(idx);
      }
      pluginManager.notifySeek(time);
      if (pluginManager.isEnabled('listening-room') && isRoomHost() && currentTrackIdRef.current) {
        lastRoomPushRef.current = Date.now();
        const m = overlayMetaRef.current;
        void broadcastRoom({
          trackId: currentTrackIdRef.current,
          title: m.title,
          artist: m.artist,
          coverUrl: m.coverUrl,
          position: time,
          isPlaying: isPlayingRef.current,
          hostId: getRoomCode(),
        }).catch(() => {});
      }
    },
    [audio, paintProgressUi]
  );

  const {
    trackRef: progressTrackRef,
    scrubbing: progressScrubbing,
    scrubTime: progressScrubTime,
    onPointerDown: onProgressPointerDown,
    onPointerMove: onProgressPointerMove,
    onPointerUp: onProgressPointerUp,
  } = useScrubBar(duration, seekTo);

  useEffect(() => {
    progressScrubRef.current = progressScrubbing;
  }, [progressScrubbing]);

  useEffect(() => {
    if (!progressScrubbing) return;
    paintProgressUi(progressScrubTime);
    progressTimeElRef.current?.replaceChildren(
      document.createTextNode(formatTime(progressScrubTime))
    );
  }, [progressScrubbing, progressScrubTime, paintProgressUi]);

  const setVolumeTo = useCallback(
    (ratio: number) => {
      setVolume(ratio);
      rampVolume(audio, ratio, pluginManager.isEnabled('smooth-volume'));
      if (pluginManager.isEnabled('remember-volume')) saveRememberedVolume(ratio);
      if (isMuted && ratio > 0) {
        audio.muted = false;
        setIsMuted(false);
      }
    },
    [audio, isMuted]
  );

  const handleVolumeClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setVolumeTo(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
    },
    [setVolumeTo]
  );

  // mouse wheel over the volume block; non-passive so the page under it doesn't scroll
  const volumeBlockRef = useRef<HTMLDivElement | null>(null);
  const volumeNowRef = useRef(0);
  volumeNowRef.current = isMuted ? 0 : volume;
  const setVolumeToRef = useRef(setVolumeTo);
  setVolumeToRef.current = setVolumeTo;
  useEffect(() => {
    const el = volumeBlockRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const next = applyWheelVolume(volumeNowRef.current, e);
      if (next !== volumeNowRef.current) setVolumeToRef.current(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    let lastUiAt = 0;
    const onTimeUpdate = () => {
      // the old deck can still tick while the new stream resolves, ignore it
      if (trackSwitchingRef.current) return;
      const t = audio.currentTime;
      const d = audio.duration || 0;
      progressRef.current = t;
      durationRef.current = d;

      const synced = lyricsRef.current?.synced;
      const lyricIdx = synced?.length
        ? getActiveLyricIndex(synced, t, lyricsSyncOffsetRef.current)
        : -1;
      const lineChanged = lyricIdx !== activeLyricLineRef.current;
      if (lineChanged) {
        activeLyricLineRef.current = lyricIdx;
        if (activeTabRef.current === 'player' || overlayPluginsOnRef.current) {
          setActiveLyricLine(lyricIdx);
        }
      }

      if (overlayPluginsOnRef.current && lineChanged) {
        const lyr = lyricsRef.current;
        const m = overlayMetaRef.current;
        void pushLyricsOverlay(
          {
            title: m.title,
            artist: m.artist,
            coverUrl: m.coverUrl,
            trackId: m.trackId,
            progress: t,
            activeLyricIndex: lyricIdx,
            isPlaying: isPlayingRef.current,
            synced: lyr?.synced,
            text: lyr?.text,
          },
          { secondScreen: secondScreenLyricsRef.current }
        );
      }

      if (pluginManager.isEnabled('ab-loop')) tickAbLoop(t, d);

      if (
        (crossfadeEnabledRef.current || playingAlbumRef.current) &&
        !audio.isCrossfading &&
        loopModeRef.current !== 'one' &&
        d > 0 &&
        isPlayingRef.current
      ) {
        const remaining = d - t;
        const cfs = crossfadeSecsRef.current;
        const q = queueRef.current;
        const qi = queueIndexRef.current;
        const trackId = currentTrackIdRef.current;
        const gapless = playingAlbumRef.current && getGaplessAlbums();
        const plan = planAutoTransition({
          crossfadeOn: crossfadeEnabledRef.current,
          crossfadeSecs: cfs,
          album: playingAlbumRef.current,
          gapless,
          remaining,
        });
        if (
          gapless &&
          trackId &&
          prerollForRef.current !== trackId &&
          remaining <= GAPLESS_PREROLL_SECS &&
          remaining > GAPLESS_LEAD_SECS
        ) {
          const ni = qi < q.length - 1 ? qi + 1 : loopModeRef.current === 'all' ? 0 : -1;
          const next = ni >= 0 && ni !== qi ? q[ni] : null;
          if (next) {
            prerollForRef.current = trackId;
            void resolveStreamUrlRef
              .current(next.id)
              .then((u) => {
                if (u && currentTrackIdRef.current === trackId) audio.preroll(u);
              })
              .catch(() => {});
          }
        }
        if (plan && trackId && autoFadeTrackRef.current !== trackId) {
          const spacing = gapless ? 1500 : Math.max(cfs * 1000 + 2000, 5000);
          if (Date.now() - lastAutoFadeAtRef.current >= spacing) {
            let nextIndex = -1;
            if (qi < q.length - 1) nextIndex = qi + 1;
            else if (loopModeRef.current === 'all' && q.length > 1) nextIndex = 0;
            if (nextIndex >= 0) {
              autoFadeTrackRef.current = trackId;
              autoFadePendingRef.current = true;
              lastAutoFadeAtRef.current = Date.now();
              forceBlendRef.current = gapless;
              void playByIndex(nextIndex, plan.fade).catch(() => {
                autoFadePendingRef.current = false;
              });
            }
          }
        }
      }

      if (progressScrubRef.current) return;

      if (pluginManager.isEnabled('listening-room') && isRoomHost() && currentTrackIdRef.current) {
        const roomNow = Date.now();
        if (roomNow - lastRoomPushRef.current >= 5000) {
          lastRoomPushRef.current = roomNow;
          const m = overlayMetaRef.current;
          void broadcastRoom({
            trackId: currentTrackIdRef.current,
            title: m.title,
            artist: m.artist,
            coverUrl: m.coverUrl,
            position: t,
            isPlaying: isPlayingRef.current,
            hostId: getRoomCode(),
          }).catch(() => {});
        }
      }

      const now = performance.now();
      if (now - lastUiAt < UI_PROGRESS_MS) return;
      lastUiAt = now;
      paintProgressUi(t, d);
      if (d > 0 && Math.abs(d - duration) > 0.25) {
        setDuration(d);
        if (showRemainingRef.current) {
          durationTimeElRef.current?.replaceChildren(
            document.createTextNode(`-${formatTime(Math.max(0, d - t))}`)
          );
        } else {
          durationTimeElRef.current?.replaceChildren(document.createTextNode(formatTime(d)));
        }
      }
    };
    const onEnded = () => {
      if (audio.isCrossfading) return;
      if (autoFadePendingRef.current) {
        autoFadePendingRef.current = false;
        return;
      }
      if (loopMode === 'one') {
        audio.currentTime = 0;
        audio.play().catch(() => setIsPlaying(false));
        return;
      }
      if (queueIndex < queue.length - 1) playNext();
      else if (loopMode === 'all' && queue.length > 0) playByIndex(0);
      else setIsPlaying(false);
    };
    const onPlay = () => setIsPlaying(true);
    // the moment sound starts the ui follows: play state, buffering off and the progress
    // painted right away, then every 100 ms for the first second (timeupdate only comes
    // about 4 times a second and the paint is throttled to 2 a second after that)
    let startTicker = 0;
    const onPlaying = () => {
      setIsPlaying(true);
      setBuffering(false);
      window.clearInterval(startTicker);
      const until = performance.now() + 1000;
      const tick = () => {
        if (performance.now() > until) window.clearInterval(startTicker);
        // still finishing the switch (crossfade): the next tick paints
        if (trackSwitchingRef.current) return;
        lastUiAt = 0;
        onTimeUpdate();
      };
      tick();
      startTicker = window.setInterval(tick, 100);
    };
    const onPause = () => setIsPlaying(false);
    const onWaiting = () => setBuffering(true);
    const onCanPlay = () => setBuffering(false);
    const onError = () => {
      if (!audio.hasSource) return;
      const id = currentTrackIdRef.current;
      tmark(`audio error ${id}`);
      const resumeAt = progressRef.current;
      const skipAhead = () => {
        setIsPlaying(false);
        setBuffering(false);
        const qi = queueIndexRef.current;
        const q = queueRef.current;
        // same give-up rule as a failed resolve: three broken tracks in a row stop the
        // auto-advance instead of walking (and re-resolving) the whole queue
        prefetchPausedUntilRef.current = Date.now() + PREFETCH_PAUSE_AFTER_FAIL_MS;
        streamFailStreakRef.current += 1;
        if (streamFailStreakRef.current >= 3) {
          const L = (localStorage.getItem('zenith_lang') as Language) || 'en';
          void showStreamStuck(L);
          return;
        }
        if (qi < q.length - 1) {
          // back off a little more with every failure in a row, a burst of instant skips
          // looks like "it skips everything" and also hammers youtube
          window.setTimeout(() => {
            if (currentTrackIdRef.current !== id) return;
            void playByIndexRef.current(qi + 1);
          }, 1200 * streamFailStreakRef.current);
        }
      };
      // every client refused this upload: try another upload of the same song (official
      // audio / topic channel, same length) under the same queue entry before skipping
      const tryAlternate = async (): Promise<boolean> => {
        if (!id || streamAltTriedRef.current === id) return false;
        streamAltTriedRef.current = id;
        const tr = queueRef.current[queueIndexRef.current];
        if (!tr || tr.id !== id) return false;
        const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
        try {
          const alt = await invoke<string | null>('resolve_alternate_stream', {
            videoId: id,
            query: `${tr.title} ${tr.artist}`,
            title: tr.title,
            duration: dur,
          });
          if (!alt || currentTrackIdRef.current !== id) return false;
          audio.src = alt;
          audio.volume = volumeRef.current;
          await audio.play();
          return true;
        } catch {
          return false;
        }
      };
      const giveUp = () => {
        void tryAlternate().then((ok) => {
          if (!ok) skipAhead();
        });
      };
      if (!id || streamErrorRetryRef.current === id) {
        giveUp();
        return;
      }
      streamErrorRetryRef.current = id;
      void resolveStreamUrl(id, true).then((url) => {
        if (!url || currentTrackIdRef.current !== id) {
          if (currentTrackIdRef.current === id) giveUp();
          return;
        }
        audio.src = url;
        audio.volume = volumeRef.current;
        const restore = () => {
          audio.removeEventListener('loadedmetadata', restore);
          if (resumeAt > 0.4 && Number.isFinite(audio.duration) && audio.duration > 0) {
            audio.currentTime = Math.min(resumeAt, Math.max(0, audio.duration - 0.25));
          }
        };
        audio.addEventListener('loadedmetadata', restore);
        audio.play().catch(() => {
          giveUp();
        });
      });
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('canplay', onCanPlay);
    audio.addEventListener('error', onError);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('playing', onPlaying);
      window.clearInterval(startTicker);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('canplay', onCanPlay);
      audio.removeEventListener('error', onError);
    };
  }, [
    audio,
    queueIndex,
    queue.length,
    playNext,
    playByIndex,
    loopMode,
    duration,
    paintProgressUi,
    resolveStreamUrl,
  ]);

  useEffect(() => {
    try {
      localStorage.setItem('zenith_saved_tracks', JSON.stringify(savedTracks.slice(0, 500)));
      localStorage.removeItem('zenith_saved');
    } catch {}
  }, [savedTracks]);

  // favorites view follows saves/unsaves live
  useEffect(() => {
    if (activeTab !== 'mood' || activeMood !== FAVORITES_ID) return;
    setSections(savedTracks.length ? [{ title: t.favs, items: savedTracks }] : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedTracks, t.favs]);

  useEffect(() => {
    (window as any).__zenithCacheCleanup = clearCaches;
    return () => {
      audio.pause();
      audio.src = '';
      audio.load();
      clearCaches();
      streamCacheRef.current.clear();
      (window as any).__zenithCacheCleanup = undefined;
    };
  }, [audio]);

  const loadTrackRef = useRef(loadTrack);
  const hydratePanelsRef = useRef(hydratePanels);
  const loadHomeRef = useRef(loadHome);
  const openPlayerRef = useRef(openPlayer);
  loadTrackRef.current = loadTrack;
  hydratePanelsRef.current = hydratePanels;
  loadHomeRef.current = loadHome;
  openPlayerRef.current = openPlayer;

  // Native audio engine hand-over with the engine (ui dropped to tray / rebuilt)
  const adoptEngineRef = useRef<() => boolean>(() => false);
  adoptEngineRef.current = () => {
    const r = takeAudioRestore();
    if (!r) return false;
    const plan = r.plan;
    const snap = r.snap;
    if (snap?.hasSource && plan?.queue?.length) {
      const idx = Math.min(Math.max(0, plan.index | 0), plan.queue.length - 1);
      const track = plan.queue[idx];
      if (!track?.id) return false;
      if (!track.type) track.type = 'track';
      setQueue(plan.queue);
      queueRef.current = plan.queue;
      setQueueIndex(idx);
      queueIndexRef.current = idx;
      setPlayingFrom(plan.playingFrom ?? null);
      playingFromRef.current = plan.playingFrom ?? null;
      playingFromIdRef.current = plan.playingFromId ?? null;
      playingAlbumRef.current = isAlbumCollectionId(playingFromIdRef.current);
      // tracks the engine moved through while there was no ui: history / stats /
      // webhook plugins still hear about each of them, in order
      for (const p of r.played.slice(0, -1)) {
        const t = plan.queue[p.index];
        if (!t) continue;
        pluginManager.notifyTrackChange({
          id: t.id,
          title: t.title,
          artist: t.artist,
          duration: 0,
          position: 0,
          isPlaying: true,
          coverUrl: t.coverLarge || t.cover,
        });
      }
      currentTrackIdRef.current = track.id;
      setCurrentTrack(track);
      hydratePanelsRef.current(track);
      if (snap.muted) setIsMuted(true);
      const d = snap.d ?? 0;
      progressRef.current = snap.t;
      durationRef.current = d;
      setDuration(d);
      setIsPlaying(!snap.paused);
      isPlayingRef.current = !snap.paused;
      setBuffering(false);
      paintProgressUiRef.current(snap.t, d);
      setFeedTabLoading('home', false);
      let tab: string | null = null;
      try {
        tab = localStorage.getItem('zenith_ui_tab');
      } catch {}
      if (tab === 'player' || !isRestoredUi()) openPlayerRef.current();
      else loadHomeRef.current();
      plan.queue.slice(idx + 1, idx + 3).forEach((t) => prefetchStream(t));
      return true;
    }
    // quit from the tray while the ui was gone: the engine's copy on disk is newer than
    // the one in localStorage, let queue-persist restore from it
    const disk = r.disk;
    if (disk?.plan?.queue?.length && pluginManager.isEnabled('queue-persist')) {
      const saved = loadPersistedQueue();
      if (!saved || disk.savedAt > saved.savedAt) {
        savePersistedQueue(
          disk.plan.queue,
          disk.plan.index,
          disk.plan.playingFrom ?? null,
          disk.progress,
          disk.wasPlaying,
          disk.plan.playingFromId ?? null
        );
      }
    }
    return false;
  };

  // the engine keeps the queue going while the ui is dropped, so it always knows the plan
  useEffect(() => {
    if (!isNativeAudio()) return;
    const LIMIT = 200;
    const safeIndex = Math.max(0, Math.min(queueIndex, queue.length - 1));
    const start =
      queue.length > LIMIT ? Math.max(0, Math.min(safeIndex - 20, queue.length - LIMIT)) : 0;
    const handle = window.setTimeout(() => {
      void invoke('zaudio_plan', {
        plan: {
          queue: queue.slice(start, start + LIMIT),
          index: safeIndex - start,
          loopMode,
          crossfade: crossfadeEnabled && pluginManager.isEnabled('crossfade') ? crossfadeSecs : 0,
          playingFrom,
          playingFromId: playingFromIdRef.current,
          discordClientId: pluginManager.isEnabled('discord-rpc') ? getDiscordClientId() : null,
        },
      }).catch(() => {});
    }, 150);
    return () => window.clearTimeout(handle);
  }, [queue, queueIndex, loopMode, crossfadeEnabled, crossfadeSecs, playingFrom, pluginStates]);

  const pluginsBootstrappedRef = useRef(false);

  useEffect(() => {
    if (pluginsBootstrappedRef.current) return;
    pluginsBootstrappedRef.current = true;

    // os-level bits follow the saved toggles right away (both on and off)
    void syncCloseToTray(pluginManager.isEnabled('system-tray'));
    void syncGlobalHotkeys(pluginManager.isEnabled('global-hotkeys'));
    void pushHotkeyBindings();

    const pluginTimer = window.setTimeout(() => {
      for (const p of pluginManager.plugins) {
        // windowed plugins never auto-open, they are off on every cold start anyway
        if (AUX_WINDOW_PLUGINS[p.id]) continue;
        if (p.id === 'system-tray' || p.id === 'global-hotkeys') continue;
        if (pluginManager.isEnabled(p.id)) {
          try {
            const r: unknown = p.onEnable?.();
            if (r instanceof Promise) r.catch((e) => console.warn(`[plugins] ${p.id}`, e));
          } catch {}
        }
      }
    }, 900);

    const bootstrap = async () => {
      // innertube + yt-dlp refresh on every boot, dont freeze the ui waiting
      void (async () => {
        try {
          const cached = await invoke<{ clientVersion?: string; apiKey?: string }>(
            'get_innertube_config'
          );
          applyInnertubeConfig(cached);
        } catch {
          /* no cache yet */
        }
        try {
          const report = await invoke<{
            innertubeVersion?: string;
            innertubeKey?: string;
            ytdlpVersion?: string;
          }>('refresh_playback_deps');
          applyInnertubeConfig(report);
        } catch {
          /* rust still has last-known copies */
        }
      })();

      if (adoptEngineRef.current()) return;
      if (pluginManager.isEnabled('queue-persist')) {
        const saved = loadPersistedQueue();
        if (saved?.queue.length) {
          const idx = Math.min(Math.max(0, saved.index), saved.queue.length - 1);
          const track = saved.queue[idx];
          if (track?.id) {
            if (!track.type) track.type = 'track';
            setQueue(saved.queue);
            queueRef.current = saved.queue;
            setQueueIndex(idx);
            queueIndexRef.current = idx;
            setPlayingFrom(saved.playingFrom);
            playingFromRef.current = saved.playingFrom;
            playingFromIdRef.current = saved.playingFromId ?? null;
            playingAlbumRef.current = isAlbumCollectionId(playingFromIdRef.current);
            setFeedTabLoading('home', false);
            openPlayerRef.current();
            hydratePanelsRef.current(track);
            saved.queue.slice(idx, idx + 3).forEach((t) => prefetchStream(t));
            await loadTrackRef.current(track, saved.wasPlaying, undefined, saved.progress);
            return;
          }
        }
      }
      loadHomeRef.current();
    };
    void bootstrap();

    return () => window.clearTimeout(pluginTimer);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const persistQueueNow = () => {
      if (pluginManager.isEnabled('queue-persist') && queueRef.current.length) {
        savePersistedQueue(
          queueRef.current,
          queueIndexRef.current,
          playingFromRef.current,
          progressRef.current,
          isPlayingRef.current,
          playingFromIdRef.current
        );
      }
    };
    let unlistenQuit: (() => void) | undefined;
    // rust decides between hide-to-tray and quit, the ui only has to save its state
    getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        persistQueueNow();
      })
      .then((fn) => {
        unlisten = fn;
      });
    listen('zenith-app-quitting', () => persistQueueNow()).then((fn) => {
      unlistenQuit = fn;
    });
    // the ui may be dropped while in the tray: remember which view to come back to
    let unlistenHidden: (() => void) | undefined;
    listen('zenith-hidden-to-tray', () => {
      persistQueueNow();
      try {
        localStorage.setItem('zenith_ui_tab', activeTabRef.current);
      } catch {}
    }).then((fn) => {
      unlistenHidden = fn;
    });
    window.addEventListener('beforeunload', persistQueueNow);
    return () => {
      unlisten?.();
      unlistenQuit?.();
      unlistenHidden?.();
      window.removeEventListener('beforeunload', persistQueueNow);
    };
  }, []);

  // search results: the top tracks are what gets clicked, resolve them while the user
  // reads the list (two per search, after a short pause so typing doesn't fire it)
  useEffect(() => {
    if (activeTab !== 'search' || !sections.length) return;
    const timer = window.setTimeout(() => {
      const picks: Track[] = [];
      for (const section of sections) {
        for (const item of section.items) {
          if (item.type === 'track' && picks.length < 2) picks.push(item);
        }
        if (picks.length >= 2) break;
      }
      picks.reverse().forEach((t) => prefetchStream(t));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeTab, sections, prefetchStream]);

  useEffect(() => {
    if (!pluginManager.isEnabled('preload-next')) return;
    const depth = getPreloadDepth();
    const upcoming = queue.slice(queueIndex + 1, queueIndex + 1 + depth);
    const upcomingIds = new Set(upcoming.map((t) => t.id));
    for (const id of preloadDoneRef.current) {
      if (!upcomingIds.has(id)) preloadDoneRef.current.delete(id);
    }
    for (const item of upcoming) {
      if (preloadDoneRef.current.has(item.id)) continue;
      preloadDoneRef.current.add(item.id);
      prefetchStream(item);
    }
  }, [prefetchStream, queue, queueIndex, pluginStates['preload-next']]);

  useEffect(() => {
    audio.volume = volume;
  }, [audio, volume]);

  useEffect(() => {
    mountedRef.current = true;
    // the splash goes as soon as the home feed and its first covers are in (a short
    // minimum so it never just flashes); it used to stay at least 1.8 s plus a 0.9 s fade
    const minTimer = window.setTimeout(() => setMinSplashElapsed(true), 600);
    const leaveTimer = window.setTimeout(() => setSplashLeaving(true), 2600);
    const hardCap = window.setTimeout(() => {
      setShowSplash(false);
      tmark('splash hidden (cap)');
    }, 3000);
    return () => {
      window.clearTimeout(minTimer);
      window.clearTimeout(leaveTimer);
      window.clearTimeout(hardCap);
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (prefetchComplete && minSplashElapsed) {
      setSplashLeaving(true);
      const hide = window.setTimeout(() => {
        if (mountedRef.current) setShowSplash(false);
        tmark('splash hidden');
      }, 350);
      return () => window.clearTimeout(hide);
    }
  }, [prefetchComplete, minSplashElapsed]);

  const startBackgroundPrefetch = useCallback((tracks: Track[]) => {
    if (!tracks || tracks.length === 0) {
      setPrefetchComplete(true);
      return;
    }
    // covers on boot only, resolving streams here used to freeze the whole window
    // streamow na starcie nie ruszac, kiedys zamarzlo wszystko i myslalem ze padl windows
    const covers = tracks
      .filter((t) => Boolean(t.cover))
      .slice(0, 2)
      .map((t) => preloadImage(t.coverSmall || t.cover));
    setPrefetchTotal(covers.length || 1);
    setPrefetchDone(0);
    setPrefetchComplete(false);
    if (!covers.length) {
      setPrefetchComplete(true);
      return;
    }
    covers.forEach((p) => p.finally(() => setPrefetchDone((prev) => prev + 1)));
    Promise.allSettled(covers).then(() => {
      if (mountedRef.current) setPrefetchComplete(true);
    });
  }, []);

  useEffect(() => {
    lyricsProviderRef.current = lyricsProvider;
    if (!currentTrack) return;
    // user picked another provider (or language changed) for the same track
    if (lastHydrateKeyRef.current === `${currentTrack.id}|${lyricsProvider}|${lang}`) return;
    hydratePanels(currentTrack);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lyricsProvider, lang]);

  // plug plugins in
  const presenceSyncRef = useRef({ sentAt: 0, sentPos: 0 });
  const broadcastPlayback = useCallback(() => {
    if (!currentTrack) {
      pluginManager.notifyNowPlaying(null);
      pluginManager.notifyTrackChange(null);
      return;
    }
    const position = audio.currentTime || 0;
    presenceSyncRef.current = { sentAt: Date.now(), sentPos: position };
    const info = {
      id: currentTrack.id,
      title: currentTrack.title,
      artist: currentTrack.artist,
      duration: isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration,
      position,
      isPlaying,
      coverUrl: currentTrack.coverLarge || currentTrack.cover,
    };
    pluginManager.notifyNowPlaying(info);
    pluginManager.notifyTrackChange(info);
  }, [audio, currentTrack, duration, isPlaying]);

  useEffect(() => {
    if (!currentTrack) {
      pluginManager.notifyNowPlaying(null);
      pluginManager.notifyTrackChange(null);
      return;
    }
    broadcastPlayback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id, isPlaying]);

  useEffect(() => {
    pluginManager.notifyPlayState(isPlaying);
  }, [isPlaying]);

  useEffect(() => {
    audio.playbackRate = getPlaybackSpeed(pluginManager.isEnabled('playback-speed'));
  }, [audio, pluginStates, speedRate]);

  useEffect(() => {
    // save when the queue actually changes, progress has its own interval below
    if (!pluginManager.isEnabled('queue-persist') || !queue.length) return;
    savePersistedQueue(
      queue,
      queueIndex,
      playingFrom,
      progressRef.current,
      isPlaying,
      playingFromIdRef.current
    );
  }, [queue, queueIndex, playingFrom, isPlaying, pluginStates]);

  useEffect(() => {
    if (!pluginManager.isEnabled('queue-persist') || !currentTrack) return;
    const iv = window.setInterval(() => {
      // paused: position and queue cannot change without an event that already saves
      if (!isPlayingRef.current) return;
      savePersistedQueue(
        queueRef.current,
        queueIndexRef.current,
        playingFromRef.current,
        progressRef.current,
        isPlayingRef.current,
        playingFromIdRef.current
      );
    }, 12000);
    return () => window.clearInterval(iv);
  }, [currentTrack, pluginStates]);

  const togglePlayRef = useRef(togglePlay);
  const playNextRef = useRef(playNext);
  const playPrevRef = useRef(playPrev);
  const seekToRef = useRef(seekTo);
  const toggleMuteRef = useRef(toggleMute);
  togglePlayRef.current = togglePlay;
  playNextRef.current = playNext;
  playPrevRef.current = playPrev;
  seekToRef.current = seekTo;
  toggleMuteRef.current = toggleMute;

  useEffect(() => {
    registerMediaSessionHandlers({
      play: () => {
        if (!isPlayingRef.current) void togglePlayRef.current();
      },
      pause: () => {
        if (isPlayingRef.current) void togglePlayRef.current();
      },
      next: () => playNextRef.current(),
      prev: () => playPrevRef.current(),
      seek: (t) => seekToRef.current(t),
    });
  }, []);

  useEffect(() => {
    registerSleepTimerCallback(() => {
      audio.pause();
      setIsPlaying(false);
    });
    registerAbLoopSeek((t) => seekToRef.current(t));
    registerAutoPauseCallback(() => {
      if (isPlayingRef.current) {
        audio.pause();
        setIsPlaying(false);
      }
    });
    const onHotkey = (action: string) => {
      if (action === 'toggle-play') togglePlayRef.current();
      else if (action === 'next') playNextRef.current();
      else if (action === 'prev') playPrevRef.current();
      else if (action === 'seek-forward')
        seekToRef.current(Math.min(durationRef.current, progressRef.current + 10));
      else if (action === 'seek-back') seekToRef.current(Math.max(0, progressRef.current - 10));
      else if (action === 'volume-up') {
        const v = Math.min(1, volumeRef.current + 0.05);
        setVolume(v);
        rampVolume(audio, v, pluginManager.isEnabled('smooth-volume'));
        if (pluginManager.isEnabled('remember-volume')) saveRememberedVolume(v);
      } else if (action === 'volume-down') {
        const v = Math.max(0, volumeRef.current - 0.05);
        setVolume(v);
        rampVolume(audio, v, pluginManager.isEnabled('smooth-volume'));
        if (pluginManager.isEnabled('remember-volume')) saveRememberedVolume(v);
      } else if (action === 'mute') toggleMuteRef.current();
      else if (action === 'like') toggleSaveRef.current();
    };
    hotkeyActionRef.current = onHotkey;
    registerKeyboardHandler(onHotkey);
  }, [audio]);

  useEffect(() => {
    return setupKeyboardShortcuts(pluginManager.isEnabled('keyboard-shortcuts'));
  }, [pluginStates]);

  // app-wide keys that must work regardless of the keyboard-shortcuts plugin:
  // Escape closes the top-most overlay, Ctrl/Cmd+F and "/" jump to search
  const overlayStackRef = useRef({
    np: false,
    plEdit: false,
    fdEdit: false,
    plugins: false,
    settings: false,
    queue: false,
  });
  overlayStackRef.current = {
    np: npOpen,
    plEdit: plEdit !== null,
    fdEdit: fdEdit !== null,
    plugins: isPluginsOpen,
    settings: isSettingsOpen,
    queue: queueOpen,
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        Boolean(target?.isContentEditable);
      if (e.key === 'Escape') {
        // an open dropdown inside a modal closes first
        if (document.querySelector('.zen-select.open')) return;
        const open = overlayStackRef.current;
        if (open.np) setNpOpen(false);
        else if (open.plEdit) setPlEdit(null);
        else if (open.fdEdit) setFdEdit(null);
        else if (open.plugins) setIsPluginsOpen(false);
        else if (open.settings) setIsSettingsOpen(false);
        else if (open.queue) setQueueOpen(false);
        else return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const findCombo = (e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyF';
      const slash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing;
      if (findCombo || slash) {
        const open = overlayStackRef.current;
        if (open.np || open.plugins || open.settings) return;
        e.preventDefault();
        const input = searchInputRef.current;
        if (input) {
          input.focus();
          input.select();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // no webkit "Reload / Inspect element" menu in a desktop app, except where text is edited
  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      const row = target?.closest<HTMLElement>('[data-ctx-track]');
      if (row?.dataset.ctxTrack) {
        try {
          const track = JSON.parse(row.dataset.ctxTrack) as Track;
          const x = Math.min(e.clientX, window.innerWidth - 230);
          const y = Math.min(e.clientY, window.innerHeight - 260);
          setCtxMenu({ x, y, track });
        } catch {
          /* not a track row after all */
        }
      } else {
        setCtxMenu(null);
      }
    };
    window.addEventListener('contextmenu', onContext);
    return () => window.removeEventListener('contextmenu', onContext);
  }, []);

  useEffect(() => {
    if (!pluginManager.isEnabled('duck-on-voice')) {
      stopDuckMonitor();
      return;
    }
    startDuckMonitor(
      () => volumeRef.current,
      (v) => {
        audio.volume = v;
      }
    );
    return () => stopDuckMonitor();
  }, [audio, pluginStates]);

  useEffect(() => {
    let unlistenTray: (() => void) | undefined;
    let unlistenMini: (() => void) | undefined;
    listen<string>('zenith-tray-action', (e) => {
      const a = e.payload;
      if (a === 'toggle-play') togglePlay();
      else if (a === 'next') playNext();
      else if (a === 'prev') playPrev();
      else hotkeyActionRef.current?.(a);
    }).then((fn) => {
      unlistenTray = fn;
    });
    listen<string>('zenith-mini-action', (e) => {
      const a = e.payload;
      if (a === 'toggle-play') togglePlay();
      else if (a === 'next') playNext();
      else if (a === 'prev') playPrev();
    }).then((fn) => {
      unlistenMini = fn;
    });
    return () => {
      unlistenTray?.();
      unlistenMini?.();
    };
  }, [togglePlay, playNext, playPrev]);

  useEffect(() => {
    registerRoomStatusHandler(() => setRoomSyncTick((n) => n + 1));
  }, []);

  useEffect(() => {
    if (!pluginManager.isEnabled('listening-room') || !isRoomHost() || !currentTrack) return;
    lastRoomPushRef.current = Date.now();
    void broadcastRoom({
      trackId: currentTrack.id,
      title: currentTrack.title,
      artist: currentTrack.artist,
      coverUrl: currentTrack.coverLarge || currentTrack.cover,
      position: audio.currentTime,
      isPlaying,
      hostId: getRoomCode(),
    }).catch(() => {});
  }, [pluginStates['listening-room'], currentTrack?.id, isPlaying, roomSyncTick, audio]);

  // equalizer / loudness normalization live in the audio engine
  useEffect(() => {
    bindFx(
      audio,
      Boolean(pluginStates['equalizer']),
      Boolean(pluginStates['loudness-normalization'])
    );
  }, [audio, pluginStates]);

  // Control over the local network (LAN remote)
  const remoteEnabled = Boolean(pluginStates['remote-control']);
  const toggleSaveRef = useRef(toggleSave);
  const toggleShuffleRef = useRef(toggleShuffle);
  const cycleLoopRef = useRef(cycleLoop);
  const handleItemClickRef = useRef(handleItemClick);
  const langRef = useRef(lang);
  toggleSaveRef.current = toggleSave;
  toggleShuffleRef.current = toggleShuffle;
  cycleLoopRef.current = cycleLoop;
  handleItemClickRef.current = handleItemClick;
  langRef.current = lang;
  const remoteSnapRef = useRef<() => void>(() => {});
  remoteSnapRef.current = () => {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    const start = q.length > 300 ? Math.max(0, Math.min(idx - 50, q.length - 300)) : 0;
    const toRemote = (x: Track): RemoteTrack => ({
      id: x.id,
      title: x.title,
      artist: x.artist,
      cover: x.coverSmall || x.cover || '',
    });
    pushRemoteState({
      track: currentTrack
        ? { ...toRemote(currentTrack), cover: currentTrack.coverLarge || currentTrack.cover || '' }
        : null,
      isPlaying,
      position: audio.currentTime || 0,
      duration: Number.isFinite(audio.duration) ? audio.duration : 0,
      volume,
      muted: isMuted,
      liked: currentTrack ? savedTracks.some((x) => x.id === currentTrack.id) : false,
      shuffle: shuffleOn,
      queue: q.slice(start, start + 300).map(toRemote),
      queueOffset: start,
      queueIndex: idx,
      sleepLeft: getSleepEndsAt()
        ? Math.max(0, Math.round((getSleepEndsAt() - Date.now()) / 1000))
        : 0,
    });
  };
  useEffect(() => {
    if (!remoteEnabled) return;
    const synced = lyrics?.synced?.map((l) => ({ time: l.time, text: l.text }));
    pushRemoteLyrics(currentTrack?.id ?? null, synced, lyrics?.text);
  }, [remoteEnabled, lyrics, currentTrack?.id]);
  useEffect(() => {
    if (remoteEnabled) remoteSnapRef.current();
  }, [
    remoteEnabled,
    currentTrack,
    isPlaying,
    volume,
    isMuted,
    savedTracks,
    shuffleOn,
    queue,
    queueIndex,
  ]);
  useEffect(() => {
    if (!remoteEnabled) return;
    const setVol = (v: number) => {
      setVolume(v);
      rampVolume(audio, v, pluginManager.isEnabled('smooth-volume'));
      if (pluginManager.isEnabled('remember-volume')) saveRememberedVolume(v);
      if (audio.muted && v > 0) {
        audio.muted = false;
        setIsMuted(false);
      }
    };
    const asTrack = (r: RemoteTrack): Track => ({
      id: r.id,
      type: 'track',
      title: r.title || 'Unknown',
      artist: r.artist || '',
      cover: r.cover,
      coverSmall: r.cover,
      coverLarge: r.cover,
    });
    const insertTrack = (t: Track, next: boolean) => {
      const q = queueRef.current;
      if (!q.length || !currentTrackIdRef.current) {
        void handleItemClickRef.current(t);
        return;
      }
      const at = next ? Math.min(q.length, queueIndexRef.current + 1) : q.length;
      const nq = [...q.slice(0, at), t, ...q.slice(at)];
      queueRef.current = nq;
      setQueue(nq);
    };
    const handler = (c: RemoteCommand) => {
      switch (c.cmd) {
        case 'toggle':
          void togglePlayRef.current();
          break;
        case 'play':
          if (!isPlayingRef.current) void togglePlayRef.current();
          break;
        case 'pause':
          if (isPlayingRef.current) void togglePlayRef.current();
          break;
        case 'next':
          playNextRef.current();
          break;
        case 'prev':
          playPrevRef.current();
          break;
        case 'seek':
          seekToRef.current(Math.min(c.value, durationRef.current || c.value));
          break;
        case 'volume':
          setVol(c.value);
          break;
        case 'mute':
          toggleMuteRef.current();
          break;
        case 'like':
          toggleSaveRef.current();
          break;
        case 'shuffle':
          toggleShuffleRef.current();
          break;
        case 'loop':
          cycleLoopRef.current();
          break;
        case 'jump':
          void playByIndexRef.current?.(c.index);
          break;
        case 'sleep':
          if (c.minutes > 0) {
            setSleepTimerMinutes(c.minutes);
            if (pluginManager.isEnabled('sleep-timer')) rearmSleepTimer();
            else pluginManager.setEnabled('sleep-timer', true);
          } else {
            pluginManager.setEnabled('sleep-timer', false);
          }
          remoteSnapRef.current();
          break;
        case 'playTrack':
          void handleItemClickRef.current(asTrack(c.track));
          break;
        case 'addTrack':
          insertTrack(asTrack(c.track), false);
          break;
        case 'playNextTrack':
          insertTrack(asTrack(c.track), true);
          break;
        case 'search':
          searchMusic(c.query, langRef.current)
            .then((sections) => {
              const seen = new Set<string>();
              const items: RemoteTrack[] = [];
              for (const sec of sections)
                for (const x of sec.items) {
                  if (items.length >= 30) break;
                  const playable = x.type === 'track' || /^[\w-]{11}$/.test(x.id);
                  if (!playable || seen.has(x.id)) continue;
                  seen.add(x.id);
                  items.push({
                    id: x.id,
                    title: x.title,
                    artist: x.artist,
                    cover: x.coverSmall || x.cover || '',
                  });
                }
              pushRemoteMessage({ type: 'search', req: c.req, items });
            })
            .catch(() => pushRemoteMessage({ type: 'search', req: c.req, items: [] }));
          break;
      }
    };
    registerRemotePusher(() => remoteSnapRef.current());
    let cancelled = false;
    startRemote(handler)
      .then(() => {
        if (!cancelled) remoteSnapRef.current();
      })
      .catch((e) => {
        console.warn('[remote] start failed', e);
        pushToast(`${translations[langRef.current].remoteError}: ${String(e)}`, 'error');
      });
    return () => {
      cancelled = true;
      registerRemotePusher(null);
      void stopRemote();
    };
  }, [remoteEnabled, audio]);

  useEffect(() => {
    if (!pluginManager.isEnabled('listening-room')) {
      unregisterRoomSyncHandler();
      return;
    }
    registerRoomSyncHandler((state) => {
      if (isRoomHost()) return;
      let q = queueRef.current;
      let idx = q.findIndex((t) => t.id === state.trackId);
      if (idx < 0) {
        const guestTrack: Track = {
          id: state.trackId,
          type: 'track',
          title: state.title || 'Unknown',
          artist: state.artist || 'Unknown',
          cover: state.coverUrl || '',
          coverSmall: state.coverUrl,
          coverLarge: state.coverUrl,
        };
        q = [...q, guestTrack];
        queueRef.current = q;
        setQueue(q);
        idx = q.length - 1;
      }
      if (idx >= 0 && idx !== queueIndexRef.current) void playByIndex(idx);

      let targetPos = state.position;
      if (state.sentAt && state.isPlaying) {
        targetPos += Math.max(0, (Date.now() - state.sentAt) / 1000);
      }
      if (Math.abs(audio.currentTime - targetPos) > 1.25) seekTo(targetPos);

      if (state.isPlaying && audio.paused) {
        void audio.play().catch(() => {});
      } else if (!state.isPlaying && !audio.paused) {
        audio.pause();
      }
    });
    return () => unregisterRoomSyncHandler();
  }, [pluginStates, audio, playByIndex, seekTo]);

  useEffect(() => {
    registerDualSenseHandler((action) => {
      if (!pluginManager.isEnabled('dualsense-pad')) return;
      if (action === 'toggle-play') togglePlayRef.current();
      else if (action === 'next') playNextRef.current();
      else if (action === 'prev') playPrevRef.current();
    });
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    appWindow
      .onFocusChanged(({ payload: focused }) => {
        pluginManager.notifyAppFocus(focused);
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const unOcclude = installWindowOcclusionHandlers(() => {
      audioRef.current?.releaseInactive();
    });
    const unMax = installMaximizeStateHandler(setIsMaximized);
    return () => {
      unOcclude();
      unMax();
    };
  }, []);

  // catch seeks so discord rpc doesnt lie
  useEffect(() => {
    if (!currentTrack || !isPlaying) return;
    const iv = window.setInterval(() => {
      const { sentAt, sentPos } = presenceSyncRef.current;
      const expected = sentPos + (Date.now() - sentAt) / 1000;
      if (Math.abs(progressRef.current - expected) > 4) broadcastPlayback();
    }, 3000);
    return () => window.clearInterval(iv);
  }, [currentTrack?.id, isPlaying, broadcastPlayback]);

  useEffect(() => {
    return () => {
      pluginManager.notifyNowPlaying(null);
      pluginManager.notifyTrackChange(null);
    };
  }, []);

  useEffect(() => {
    progressTimeElRef.current?.replaceChildren(
      document.createTextNode(formatTime(progressRef.current))
    );
    const d = duration;
    const label =
      showRemaining && d > 0
        ? `-${formatTime(Math.max(0, d - progressRef.current))}`
        : formatTime(d);
    durationTimeElRef.current?.replaceChildren(document.createTextNode(label));
  }, [duration, showRemaining]);

  useEffect(() => {
    const idx = getActiveLyricIndex(
      lyrics?.synced,
      progressRef.current,
      lyricsSyncOffsetRef.current
    );
    activeLyricLineRef.current = idx;
    if (activeTabRef.current === 'player') {
      setActiveLyricLine(idx);
    }
  }, [lyrics]);

  useEffect(() => {
    const onSyncOffset = () => {
      lyricsSyncOffsetRef.current = getLyricsSyncOffset();
      const synced = lyricsRef.current?.synced;
      const t = progressRef.current;
      const idx = synced?.length ? getActiveLyricIndex(synced, t, lyricsSyncOffsetRef.current) : -1;
      activeLyricLineRef.current = idx;
      setActiveLyricLine(idx);
      if (!overlayPluginsOnRef.current) return;
      const lyr = lyricsRef.current;
      const m = overlayMetaRef.current;
      void pushLyricsOverlay(
        {
          title: m.title,
          artist: m.artist,
          coverUrl: m.coverUrl,
          trackId: m.trackId,
          progress: t,
          activeLyricIndex: idx,
          isPlaying: isPlayingRef.current,
          synced: lyr?.synced,
          text: lyr?.text,
        },
        { secondScreen: secondScreenLyricsRef.current, force: true }
      );
    };
    window.addEventListener('zenith-lyrics-sync-changed', onSyncOffset);
    return () => window.removeEventListener('zenith-lyrics-sync-changed', onSyncOffset);
  }, []);

  lyricsRef.current = lyrics;

  useEffect(() => {
    if (!isPlaying || !lyrics?.synced?.length) return;
    let raf = 0;
    let lastOverlayAt = 0;
    const tick = () => {
      const t = audio.currentTime;
      const synced = lyricsRef.current?.synced;
      const idx = synced?.length ? getActiveLyricIndex(synced, t, lyricsSyncOffsetRef.current) : -1;
      if (idx !== activeLyricLineRef.current) {
        activeLyricLineRef.current = idx;
        if (activeTabRef.current === 'player' || overlayPluginsOnRef.current) {
          setActiveLyricLine(idx);
        }
        if (overlayPluginsOnRef.current) {
          lastOverlayAt = Date.now();
          const lyr = lyricsRef.current;
          const m = overlayMetaRef.current;
          void pushLyricsOverlay(
            {
              title: m.title,
              artist: m.artist,
              coverUrl: m.coverUrl,
              trackId: m.trackId,
              progress: t,
              activeLyricIndex: idx,
              isPlaying: true,
              synced: lyr?.synced,
              text: lyr?.text,
            },
            { secondScreen: secondScreenLyricsRef.current }
          );
        }
      } else if (overlayPluginsOnRef.current && Date.now() - lastOverlayAt > 2200) {
        lastOverlayAt = Date.now();
        const lyr = lyricsRef.current;
        const m = overlayMetaRef.current;
        void pushLyricsOverlay(
          {
            title: m.title,
            artist: m.artist,
            coverUrl: m.coverUrl,
            trackId: m.trackId,
            progress: t,
            activeLyricIndex: idx,
            isPlaying: true,
            synced: lyr?.synced,
            text: lyr?.text,
          },
          { secondScreen: secondScreenLyricsRef.current }
        );
      }
      schedule();
    };
    // while the lyrics are on screen (or an overlay shows them) line changes must land on
    // the exact display frame. polling every frame did that but cost a JS wakeup + a
    // BeginFrame per vsync (200/s on a 200 Hz monitor) for a value that changes every few
    // seconds. instead: sleep on a timer until ~40 ms before the next stamp could become
    // active, then follow frames until it does. same frame-exact switch, a few rAFs per
    // line. a slow timer when nothing shows them; seeks re-run immediately
    let timer = 0;
    const schedule = () => {
      const visible =
        !document.hidden && (activeTabRef.current === 'player' || overlayPluginsOnRef.current);
      if (!visible) {
        timer = window.setTimeout(tick, 400);
        return;
      }
      const rate = audio.playbackRate > 0 ? audio.playbackRate : 1;
      const wait =
        (secondsUntilLyricChange(
          lyricsRef.current?.synced,
          audio.currentTime,
          activeLyricLineRef.current,
          lyricsSyncOffsetRef.current
        ) /
          rate) *
          1000 -
        40;
      // cap keeps the overlay refresh (every ~2.2 s) and tab switches responsive
      if (wait > 8) timer = window.setTimeout(tick, Math.min(wait, 250));
      else raf = requestAnimationFrame(tick);
    };
    const kick = () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      tick();
    };
    audio.addEventListener('seeked', kick);
    audio.addEventListener('ratechange', kick);
    schedule();
    return () => {
      audio.removeEventListener('seeked', kick);
      audio.removeEventListener('ratechange', kick);
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [isPlaying, lyrics, audio]);

  useEffect(() => {
    const overlayOn =
      pluginStates['lyrics-overlay'] ||
      pluginStates['second-screen-lyrics'] ||
      pluginStates['lyrics-karaoke'];
    if (!overlayOn || !currentTrack) return;
    const m = overlayMetaRef.current;
    const lyr = lyricsRef.current;
    pushLyricsOverlay(
      {
        title: m.title,
        artist: m.artist,
        coverUrl: m.coverUrl,
        trackId: m.trackId,
        progress: progressRef.current,
        activeLyricIndex: activeLyricLineRef.current,
        isPlaying,
        synced: lyr?.synced,
        text: lyr?.text,
      },
      { secondScreen: secondScreenLyricsRef.current, force: true }
    );
  }, [isPlaying, pluginStates, currentTrack?.id]);

  useEffect(() => {
    if (!currentTrack) return;
    const meta = overlayMetaRef.current;
    const syncedLen = lyrics?.synced?.length ?? 0;
    const textLen = lyrics?.text?.length ?? 0;
    const changed =
      meta.trackId !== currentTrack.id || meta.syncedLen !== syncedLen || meta.textLen !== textLen;
    meta.trackId = currentTrack.id;
    meta.title = currentTrack.title;
    meta.artist = currentTrack.artist;
    meta.coverUrl = currentTrack.coverLarge || currentTrack.cover;
    meta.syncedLen = syncedLen;
    meta.textLen = textLen;

    const overlayOn =
      pluginStates['lyrics-overlay'] ||
      pluginStates['second-screen-lyrics'] ||
      pluginStates['lyrics-karaoke'];
    if (overlayOn && changed) {
      pushLyricsOverlay(
        {
          title: currentTrack.title,
          artist: currentTrack.artist,
          coverUrl: meta.coverUrl,
          trackId: currentTrack.id,
          progress: progressRef.current,
          activeLyricIndex: activeLyricLineRef.current,
          isPlaying: isPlayingRef.current,
          synced: lyrics?.synced,
          text: lyrics?.text,
        },
        { secondScreen: Boolean(pluginStates['second-screen-lyrics']), force: true }
      );
    }
    if (pluginStates['mini-player'] && changed) {
      pushMiniPlayerState({
        title: currentTrack.title,
        artist: currentTrack.artist,
        trackId: currentTrack.id,
        coverUrl: currentTrack.coverSmall || currentTrack.cover,
        progress: progressRef.current,
        duration: durationRef.current,
        isPlaying: isPlayingRef.current,
      });
    }
  }, [pluginStates, currentTrack, lyrics, isPlaying]);

  useEffect(() => {
    const overlayOn =
      pluginStates['lyrics-overlay'] ||
      pluginStates['second-screen-lyrics'] ||
      pluginStates['lyrics-karaoke'];
    overlayPluginsOnRef.current = overlayOn;
    secondScreenLyricsRef.current = Boolean(pluginStates['second-screen-lyrics']);
    const miniOn = pluginStates['mini-player'];
    if (!miniOn) return;

    const iv = setInterval(() => {
      const track = currentTrackIdRef.current;
      if (!track) return;
      const m = overlayMetaRef.current;
      pushMiniPlayerState({
        title: m.title,
        artist: m.artist,
        coverUrl: m.coverUrl,
        trackId: m.trackId,
        progress: progressRef.current,
        duration: durationRef.current,
        isPlaying: isPlayingRef.current,
      });
    }, MINI_PLAYER_SYNC_MS);
    return () => clearInterval(iv);
  }, [pluginStates]);

  // freshly opened aux windows (and overlay setting tweaks) get a full snapshot right away
  useEffect(() => {
    const pushOverlayNow = () => {
      if (!overlayPluginsOnRef.current || !currentTrackIdRef.current) return;
      const m = overlayMetaRef.current;
      const lyr = lyricsRef.current;
      void pushLyricsOverlay(
        {
          title: m.title,
          artist: m.artist,
          coverUrl: m.coverUrl,
          trackId: m.trackId,
          progress: progressRef.current,
          activeLyricIndex: activeLyricLineRef.current,
          isPlaying: isPlayingRef.current,
          synced: lyr?.synced,
          text: lyr?.text,
        },
        { secondScreen: secondScreenLyricsRef.current, force: true }
      );
    };
    const pushMiniNow = () => {
      if (!currentTrackIdRef.current) return;
      const m = overlayMetaRef.current;
      void pushMiniPlayerState({
        title: m.title,
        artist: m.artist,
        coverUrl: m.coverUrl,
        trackId: m.trackId,
        progress: progressRef.current,
        duration: durationRef.current,
        isPlaying: isPlayingRef.current,
      });
    };
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    const keep = (fn: () => void) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    };
    listen('zenith-overlay-ready', pushOverlayNow).then(keep);
    listen('zenith-mini-ready', pushMiniNow).then(keep);
    window.addEventListener(OVERLAY_SETTINGS_EVENT, pushOverlayNow);
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
      window.removeEventListener(OVERLAY_SETTINGS_EVENT, pushOverlayNow);
    };
  }, []);

  const handleShareCard = useCallback(async () => {
    if (!currentTrack) return;
    const ok = await copyShareCardToClipboard({
      id: currentTrack.id,
      title: currentTrack.title,
      artist: currentTrack.artist,
      duration,
      position: progressRef.current,
      isPlaying,
      coverUrl: currentTrack.coverLarge || currentTrack.cover,
    });
    if (ok) setShareCardOk(true);
    setTimeout(() => setShareCardOk(false), 2000);
  }, [currentTrack, duration, isPlaying]);

  const heroTrack = useMemo(
    () =>
      sections.length > 0 && sections[0].items.length > 0 && activeTab === 'search'
        ? sections[0].items[0]
        : null,
    [sections, activeTab]
  );

  // dont render a 400 track queue, the images will eat ram
  // 51 i koniec, wiecej i windows zaczyna plakac xD
  const upNextTracks = useMemo(
    () => queue.slice(queueIndex + 1, queueIndex + 51),
    [queue, queueIndex]
  );
  const isContentTab = activeTab !== 'player';
  const typeLabel = (type: Track['type']) => {
    switch (type) {
      case 'track':
        return t.typeTrack;
      case 'album':
        return t.typeAlbum;
      case 'playlist':
        return t.typePlaylist;
      case 'artist':
        return t.typeArtist;
      case 'profile':
        return t.typeProfile;
      case 'podcast':
        return t.typePodcast;
      default:
        return type;
    }
  };
  const homeHeroTrack = useMemo(
    () => (activeTab === 'home' ? (quickPicks[0] ?? homeSections[0]?.items[0] ?? null) : null),
    [activeTab, quickPicks, homeSections]
  );

  useEffect(() => {
    if (showSplash) return;
    if (!shouldShowOnboarding()) return;
    const t = window.setTimeout(() => setShowOnboarding(true), 600);
    return () => window.clearTimeout(t);
  }, [showSplash]);

  useEffect(() => {
    if (pluginStates['ambient-glow']) {
      applyCoverTheme(currentTrack?.coverLarge || currentTrack?.cover);
    } else {
      resetCoverTheme();
    }
  }, [
    currentTrack?.id,
    currentTrack?.cover,
    currentTrack?.coverLarge,
    pluginStates['ambient-glow'],
  ]);

  const sectionRows = useMemo(
    () =>
      stableOrderSections(activeTab === 'home' ? homeSections : sections).map((section, idx) => (
        <SectionRow
          key={`${section.title}-${idx}`}
          section={section}
          sectionIndex={idx}
          onItemClick={handleItemClick}
        />
      )),
    [activeTab, homeSections, sections, handleItemClick]
  );

  return (
    <div className="zenith-app">
      <ToastHost />
      {showOnboarding && (
        <Suspense fallback={null}>
          <Onboarding
            lang={lang}
            open={showOnboarding}
            onClose={() => setShowOnboarding(false)}
            onSignIn={() => void handleLogin()}
            libAuthed={libAuthed}
          />
        </Suspense>
      )}
      {loginBusy && (
        <div className="login-busy-overlay" aria-live="polite">
          <div className="login-busy-card">
            <span className="login-busy-spinner" aria-hidden />
            {t.loginInProgress}
            <button
              type="button"
              className="login-busy-cancel no-window-drag"
              onClick={() => void cancelLogin()}
            >
              {t.loginCancel}
            </button>
          </div>
        </div>
      )}
      {showSplash && (
        <div className={`startup-splash ${splashLeaving ? 'leaving' : ''}`}>
          <div className="startup-splash-title">Zenith</div>
          <div className="startup-splash-subtitle">tonieninja</div>
          <div className="startup-splash-progress" aria-hidden>
            <div className="startup-splash-progress-track">
              <div
                className="startup-splash-progress-fill"
                style={{
                  width: prefetchTotal
                    ? `${Math.round((prefetchDone / prefetchTotal) * 100)}%`
                    : prefetchComplete
                      ? '100%'
                      : '0%',
                }}
              />
            </div>
          </div>
        </div>
      )}
      <div className="global-glass-bg">
        <div className={`glass-static-backdrop ${currentTrack ? 'has-track' : ''}`} />
        <div className="glass-overlay-dark" />
      </div>

      <header
        className="titlebar"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest('.no-window-drag')) return;
          e.preventDefault();
          void appWindow.startDragging();
        }}
      >
        <div className="titlebar-drag-spacer" aria-hidden="true" />
        <div className="titlebar-center">
          <div className="titlebar-search no-window-drag" data-tour="search">
            <Search size={15} className="search-icon" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t.searchPlaceholder}
              aria-label={t.searchPlaceholder}
              className="search-input"
              value={searchQuery}
              maxLength={MAX_SEARCH_LENGTH}
              spellCheck={false}
              onChange={(e) => {
                const v = e.target.value;
                if (v.length >= MAX_SEARCH_LENGTH && searchQuery.length < MAX_SEARCH_LENGTH) {
                  pushToast(t.searchTooLong, 'info');
                }
                setSearchQuery(v.slice(0, MAX_SEARCH_LENGTH));
              }}
              onPaste={(e) => {
                const pasted = e.clipboardData.getData('text');
                if (pasted.length + searchQuery.length > MAX_SEARCH_LENGTH) {
                  pushToast(t.searchTooLong, 'info');
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch(searchQuery);
                else if (e.key === 'Escape') {
                  e.stopPropagation();
                  if (searchQuery) setSearchQuery('');
                  else e.currentTarget.blur();
                }
              }}
            />
          </div>
        </div>
        <div className="titlebar-actions">
          <button
            type="button"
            className={`titlebar-pill-btn no-window-drag${libAuthed ? ' logged-in' : ''}${isOffline ? ' offline' : ''}`}
            onClick={handleLogin}
            title={
              isOffline ? t.offlineHint : libAuthed ? (libAccount?.name ?? t.loggedIn) : t.login
            }
            data-tour="login"
          >
            <UserCircle size={17} />
            <span className="hide-on-mobile titlebar-user-name">
              {isOffline ? t.offlineBadge : libAuthed ? (libAccount?.name ?? t.loggedIn) : t.login}
            </span>
          </button>
          {libAuthed && (
            <button
              type="button"
              className="titlebar-pill-btn titlebar-logout-btn no-window-drag"
              onClick={() => void handleLogout()}
              title={t.logout}
              aria-label={t.logout}
            >
              <LogOut size={16} />
              <span className="hide-on-mobile">{t.logout}</span>
            </button>
          )}
          <div className="titlebar-window-controls">
            <button
              type="button"
              className="win-ctrl-btn no-window-drag"
              aria-label={t.winMinimize}
              title={t.winMinimize}
              onClick={() => void appWindow.minimize()}
            >
              <Minus size={14} strokeWidth={2.25} />
            </button>
            <button
              type="button"
              className="win-ctrl-btn no-window-drag"
              aria-label={isMaximized ? t.winRestore : t.winMaximize}
              title={isMaximized ? t.winRestore : t.winMaximize}
              onClick={() => void appWindow.toggleMaximize()}
            >
              {isMaximized ? (
                <Maximize2 size={13} strokeWidth={2.25} />
              ) : (
                <Square size={12} strokeWidth={2.25} />
              )}
            </button>
            <button
              type="button"
              className="win-ctrl-btn win-ctrl-close no-window-drag"
              aria-label={t.winClose}
              title={t.winClose}
              onClick={() => void appWindow.close()}
            >
              <X size={15} strokeWidth={2.25} />
            </button>
          </div>
        </div>
      </header>

      <div className="app-main-layout">
        <aside className="sidebar">
          <div className="brand">
            <span>ZENITH</span>
          </div>
          <nav className="nav-menu">
            <div
              className={`nav-item back-btn${activeTab === 'player' ? '' : ' is-placeholder'}`}
              aria-hidden={activeTab !== 'player'}
              onClick={() => {
                if (activeTab === 'player') navigateTo(prevTab);
              }}
            >
              <ChevronLeft size={22} />
              <span>{t.back}</span>
            </div>
            <div
              className={`nav-item ${activeTab === 'home' ? 'active' : ''}`}
              onClick={() => loadHome()}
              data-tour="home"
            >
              <Home size={22} />
              <span>{t.home}</span>
            </div>
            <div
              className={`nav-item ${activeTab === 'explore' ? 'active' : ''}`}
              onClick={() => loadExplore()}
            >
              <Compass size={22} />
              <span>{t.explore}</span>
            </div>
            <div
              className={`nav-item ${activeTab === 'library' ? 'active' : ''}`}
              onClick={() => navigateTo('library')}
              data-tour="library"
            >
              <Library size={22} />
              <span>{t.library}</span>
            </div>
          </nav>
          <div className="playlists-section">
            <span className="section-title">{t.playlistsTitle}</span>
            {libAuthed && (
              <div className="nav-item playlist-link pm-open-link" onClick={() => setPmOpen(true)}>
                <ListMusic size={18} />
                <span>{t.pmOpen}</span>
              </div>
            )}
            <div
              className={`nav-item playlist-link ${activeTab === 'mood' && activeMood === FAVORITES_ID ? 'active' : ''}`}
              onClick={openFavorites}
            >
              <ListMusic size={18} />
              <span>{t.favs}</span>
            </div>
            <div
              className={`nav-item playlist-link ${activeTab === 'mood' && activeMood === 'workout' ? 'active' : ''}`}
              onClick={() => openMoodById('workout')}
            >
              <ListMusic size={18} />
              <span>{t.workout}</span>
            </div>
            <div
              className={`nav-item playlist-link ${activeTab === 'mood' && activeMood === 'focus' ? 'active' : ''}`}
              onClick={() => openMoodById('focus')}
            >
              <ListMusic size={18} />
              <span>{t.nightCode}</span>
            </div>
            {(() => {
              const renderPl = (pl: Track) => (
                <div
                  key={pl.id}
                  className={`nav-item playlist-link user-playlist-link${
                    activeTab === 'mood' && activeMood === browseMoodId(pl.id) ? ' active' : ''
                  }`}
                  onClick={() => {
                    if (sidebarClickPlan(pl).kind === 'browse-page') {
                      void openCollectionPage(pl);
                      return;
                    }
                    void handleCollectionClick(pl);
                  }}
                  title={pl.title}
                >
                  <ListMusic size={18} />
                  <span>{pl.title}</span>
                  {
                    <PopoverMenu
                      ariaLabel={t.playlistActions}
                      trigger={<MoreHorizontal size={16} />}
                      items={[
                        {
                          key: 'folder',
                          label: t.moveToFolder,
                          onSelect: () => {
                            setFdName('');
                            setFdEdit({
                              mode: 'move',
                              plId: pl.id,
                              target: plFolders.assign[pl.id] ?? '',
                            });
                          },
                        },
                        ...(!isEditablePlaylist(pl.id)
                          ? []
                          : [
                              {
                                key: 'rename',
                                label: t.renamePlaylist,
                                onSelect: () => {
                                  setPlEditTitle(pl.title);
                                  setPlEditError(false);
                                  setPlEdit({ mode: 'rename', pl });
                                },
                              },
                              {
                                key: 'delete',
                                label: t.deletePlaylist,
                                danger: true,
                                onSelect: () => {
                                  setPlEditError(false);
                                  setPlEdit({ mode: 'delete', pl });
                                },
                              },
                            ]),
                      ]}
                    />
                  }
                </div>
              );
              const g = groupPlaylists(plFolders, userPlaylists);
              return (
                <>
                  {plFolders.folders.map((f) => (
                    <div key={f.id} className="playlist-folder">
                      <div
                        className="nav-item playlist-link user-playlist-link playlist-folder-head"
                        onClick={() => updateFolders(toggleFolder(plFolders, f.id))}
                        title={f.name}
                      >
                        {f.collapsed ? <Folder size={18} /> : <FolderOpen size={18} />}
                        <span>{f.name}</span>
                        <PopoverMenu
                          ariaLabel={t.playlistActions}
                          trigger={<MoreHorizontal size={16} />}
                          items={[
                            {
                              key: 'rename',
                              label: t.renameFolder,
                              onSelect: () => {
                                setFdName(f.name);
                                setFdEdit({ mode: 'rename', folderId: f.id });
                              },
                            },
                            {
                              key: 'delete',
                              label: t.deleteFolder,
                              danger: true,
                              onSelect: () => updateFolders(removeFolder(plFolders, f.id)),
                            },
                          ]}
                        />
                      </div>
                      {!f.collapsed && (
                        <div className="playlist-folder-items">
                          {(g.byFolder.get(f.id) ?? []).map(renderPl)}
                        </div>
                      )}
                    </div>
                  ))}
                  {g.root.map(renderPl)}
                </>
              );
            })()}
          </div>
          <div className="sidebar-bottom-actions">
            <div
              className="nav-item settings-link"
              onClick={() => setIsPluginsOpen(true)}
              data-tour="plugins"
            >
              <Puzzle size={22} />
              <span>{t.plugins}</span>
            </div>
            <div className="nav-item settings-link" onClick={() => setIsSettingsOpen(true)}>
              <Settings size={22} />
              <span>{t.settings}</span>
            </div>
          </div>
        </aside>

        <div className="main-column">
          <main className="content-area">
            {activeTab === 'player' && currentTrack && (
              <div className="content-scrollable player-view">
                <div className="player-view-inner">
                  <div className="player-col-cover">
                    <div
                      className="player-view-cover-wrap"
                      title={`${Math.round(volume * 100)}%`}
                      onWheel={(e) => {
                        e.preventDefault();
                        const delta = e.deltaY > 0 ? -0.03 : 0.03;
                        const next = Math.max(0, Math.min(1, volumeRef.current + delta));
                        setVolume(next);
                        volumeRef.current = next;
                        if (!audio.isCrossfading) {
                          rampVolume(audio, next, pluginManager.isEnabled('smooth-volume'));
                        } else {
                          audio.volume = next;
                        }
                        if (pluginManager.isEnabled('remember-volume')) saveRememberedVolume(next);
                        setCoverVolHint(Math.round(next * 100));
                        window.clearTimeout(coverVolHintTimer.current);
                        coverVolHintTimer.current = window.setTimeout(
                          () => setCoverVolHint(null),
                          900
                        );
                      }}
                    >
                      <img
                        loading="eager"
                        decoding="async"
                        alt=""
                        className="player-view-cover"
                        fetchPriority="high"
                        {...coverAttrs(currentTrack, 'large')}
                      />
                      <div className={`cover-vol-badge ${coverVolHint !== null ? 'show' : ''}`}>
                        {coverVolHint !== null
                          ? `${coverVolHint}%`
                          : `${Math.round(volume * 100)}%`}
                      </div>
                    </div>
                    <div className="player-view-meta">
                      <div className="player-view-label">{t.nowPlaying}</div>
                      <h1 className="player-view-title">{currentTrack.title}</h1>
                      <div className="player-view-artist">{currentTrack.artist}</div>
                      {playingFrom && (
                        <div className="player-view-from">
                          {t.playingFrom} <strong>{playingFrom}</strong>
                        </div>
                      )}
                      <div className="player-view-actions">
                        <button className="primary-action-btn" onClick={toggleSave}>
                          {isSaved ? t.saved : t.save}
                        </button>
                        {libAuthed && /^[\w-]{11}$/.test(currentTrack.id) && (
                          <PopoverMenu
                            align="left"
                            ariaLabel={t.addToPlaylist}
                            triggerClassName="primary-action-btn"
                            trigger={
                              <>
                                <ListPlus size={15} />
                                <span>{t.addToPlaylist}</span>
                              </>
                            }
                            emptyLabel={t.noEditablePlaylists}
                            items={userPlaylists
                              .filter((pl) => isEditablePlaylist(pl.id))
                              .map((pl) => ({
                                key: pl.id,
                                label: pl.title,
                                onSelect: () => void addCurrentToPlaylist(pl),
                              }))}
                          />
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="player-col-upnext">
                    <div className="player-view-section h-full">
                      <div className="panel-tabs">
                        <button
                          className={`panel-tab ${panelTab === 'upnext' ? 'active' : ''}`}
                          onClick={() => setPanelTab('upnext')}
                        >
                          {t.upNext}
                        </button>
                        <button
                          className={`panel-tab ${panelTab === 'related' ? 'active' : ''}`}
                          onClick={() => setPanelTab('related')}
                        >
                          {t.relatedTab}
                        </button>
                      </div>
                      {panelTab === 'upnext' ? (
                        <div className="up-next-list-full">
                          {upNextTracks.length === 0 ? (
                            <div className="up-next-empty">{t.upNextEmpty}</div>
                          ) : (
                            upNextTracks.map((track) => (
                              <UpNextItem
                                key={track.id}
                                track={track}
                                onClick={() =>
                                  handleItemClick(track, playingFrom || undefined, queue)
                                }
                              />
                            ))
                          )}
                        </div>
                      ) : (
                        <div className="related-panel">
                          {relatedLoading ? (
                            <div className="up-next-empty">{t.loadingRelated}</div>
                          ) : !related || (related.sections.length === 0 && !related.about) ? (
                            <div className="up-next-empty">{t.relatedEmpty}</div>
                          ) : (
                            <>
                              {related.sections.map((section, sIdx) => (
                                <div key={`${section.title}-${sIdx}`} className="related-section">
                                  <h5 className="related-section-title">{section.title}</h5>
                                  <div className="related-section-items">
                                    {section.items.slice(0, 8).map((item) => (
                                      <button
                                        key={item.id}
                                        data-ctx-track={ctxTrackAttr(item)}
                                        className={`up-next-item related-item-${item.type}`}
                                        onClick={() =>
                                          handleItemClick(item, section.title, section.items)
                                        }
                                      >
                                        <img
                                          loading="lazy"
                                          decoding="async"
                                          alt=""
                                          className="up-next-cover"
                                          {...coverAttrs(item, 'thumb')}
                                        />
                                        <div className="up-next-meta">
                                          <span className="up-next-title">{item.title}</span>
                                          <span className="up-next-artist">{item.artist}</span>
                                        </div>
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              ))}
                              {related.about && (
                                <div className="related-section">
                                  <h5 className="related-section-title">{t.aboutArtist}</h5>
                                  <p className="related-about-text">{related.about}</p>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="player-col-lyrics">
                    <div className="player-view-section h-full">
                      <div className="lyrics-panel-full">
                        <div className="lyrics-provider-header">
                          <button
                            className="lyrics-provider-nav"
                            onClick={() => cycleProvider(-1)}
                            aria-label={t.lyricsPrevSource}
                            title={t.lyricsPrevSource}
                          >
                            <ChevronLeft size={16} />
                          </button>
                          <div className="lyrics-provider-title">
                            {lyricsLoading || !lyrics
                              ? lyricsProvider === 'Auto'
                                ? t.lyrics
                                : lyricsProvider
                              : lyrics.provider && lyrics.provider !== 'Auto'
                                ? lyrics.provider
                                : lyricsProvider === 'Auto'
                                  ? t.lyrics
                                  : lyricsProvider}
                          </div>
                          <button
                            className="lyrics-provider-nav"
                            onClick={() => cycleProvider(1)}
                            aria-label={t.lyricsNextSource}
                            title={t.lyricsNextSource}
                          >
                            <ChevronRight size={16} />
                          </button>
                        </div>
                        <div className="lyrics-provider-dots">
                          {lyricProviders.map((p, i) => (
                            <span
                              key={p}
                              className={`lyrics-provider-dot ${i === providerIndex ? 'active' : ''}`}
                            />
                          ))}
                        </div>
                        <div className="lyrics-provider-list">
                          {lyricProviders.map((p) => (
                            <button
                              key={p}
                              className={`lyrics-provider-pill ${lyricsProvider === p ? 'active' : ''}`}
                              onClick={() => setLyricsProvider(p)}
                            >
                              {p}
                            </button>
                          ))}
                        </div>
                        <div className="lyrics-text-content">
                          {lyricsLoading ? (
                            t.loadingLyrics
                          ) : lyrics?.synced && lyrics.synced.length > 0 ? (
                            <PlayerLyricsRail
                              synced={lyrics.synced}
                              onLineClick={seekTo}
                              mode="full"
                              className="synced-lyrics-rail--player"
                              getProgress={getLyricProgress}
                            />
                          ) : lyrics?.text ? (
                            lyrics.text
                          ) : (
                            <div className="lyrics-failures">
                              <div className="lyrics-failures-title">{t.lyricsNotAvailable}</div>
                              {lyrics?.failures && lyrics.failures.length > 0 && (
                                <>
                                  <div className="lyrics-failures-why">{t.lyricsWhyFailed}</div>
                                  {lyrics.failures.map((f) => (
                                    <div key={f.provider} className="lyrics-failure-row">
                                      <span className="lyrics-failure-provider">{f.provider}</span>
                                      <span className="lyrics-failure-reason">
                                        {localizeLyricsReason(f.reason, lang)}
                                      </span>
                                    </div>
                                  ))}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {isContentTab && (
              <div className="content-scrollable">
                {activeTab === 'library' ? (
                  libAuthed === false ? (
                    <div className="library-empty-view">
                      <div className="library-empty-icon">
                        <Library size={56} strokeWidth={1.2} />
                      </div>
                      <h2 className="library-empty-title">{t.libraryEmptyTitle}</h2>
                      <p className="library-empty-desc">{t.libraryEmptyDesc}</p>
                      <button className="library-signin-btn" onClick={handleLogin}>
                        {t.signIn}
                      </button>
                      <button className="library-refresh-btn" onClick={refreshAuth}>
                        <RefreshCw size={14} />
                        {t.checkAgain}
                      </button>
                    </div>
                  ) : (
                    <div className="library-view">
                      {libAccount && (
                        <div className="library-account-banner">
                          {libAccount.avatarUrl ? (
                            <img
                              src={libAccount.avatarUrl}
                              alt=""
                              className="library-account-avatar"
                            />
                          ) : (
                            <div className="library-account-avatar placeholder">
                              <UserCircle size={28} />
                            </div>
                          )}
                          <div>
                            <div className="library-account-name">{libAccount.name}</div>
                            <div className="library-account-sub">{t.librarySignedInAs}</div>
                          </div>
                        </div>
                      )}
                      {libError && (
                        <div className="library-error-banner">
                          <span>{libError}</span>
                          <button
                            type="button"
                            className="library-refresh-btn"
                            onClick={refreshAuth}
                          >
                            <RefreshCw size={14} />
                            {t.libraryRetry}
                          </button>
                        </div>
                      )}
                      <div className="library-chips-row">
                        {LIBRARY_CATEGORIES.map((cat) => (
                          <button
                            key={cat.id}
                            className={`library-chip ${libCategory === cat.id ? 'active' : ''}`}
                            onClick={() => changeLibCategory(cat.id)}
                          >
                            {t[cat.labelKey]}
                          </button>
                        ))}
                        <button
                          className="library-newpl-btn"
                          onClick={() => {
                            setNpError(false);
                            setNpOpen(true);
                          }}
                        >
                          <Plus size={15} />
                          {t.newPlaylist}
                        </button>
                      </div>
                      {authBootstrapping || libLoading ? (
                        <LibrarySkeleton />
                      ) : libSections.length === 0 ? (
                        <div className="empty-state-message">
                          <h2>{t.noResults}</h2>
                          <p>{t[LIB_EMPTY_KEYS[libCategory]]}</p>
                          <div className="library-empty-actions">
                            <button className="library-refresh-btn" onClick={refreshAuth}>
                              <RefreshCw size={14} />
                              {t.checkAgain}
                            </button>
                          </div>
                        </div>
                      ) : (
                        libSections.map((section, sIdx) => (
                          <section key={`${section.title}-${sIdx}`} className="library-section">
                            {libSections.length > 1 && (
                              <h3 className="library-section-title">{section.title}</h3>
                            )}
                            <WindowedList
                              className="library-list"
                              count={section.items.length}
                              renderRow={(i) => {
                                const item = section.items[i];
                                return (
                                  <button
                                    key={item.id}
                                    data-ctx-track={ctxTrackAttr(item)}
                                    className={`search-result-row search-result-type-${item.type}`}
                                    onClick={() =>
                                      handleItemClick(item, section.title, section.items)
                                    }
                                  >
                                    <div className="search-result-cover-wrap">
                                      <img
                                        alt=""
                                        className="search-result-cover"
                                        loading="lazy"
                                        decoding="async"
                                        {...coverAttrs(item)}
                                      />
                                      <div className="search-result-play-icon">
                                        <Play size={14} fill="currentColor" />
                                      </div>
                                    </div>
                                    <div className="search-result-meta">
                                      <span className="search-result-title">{item.title}</span>
                                      <span className="search-result-artist">{item.artist}</span>
                                    </div>
                                    <span className="search-result-badge">
                                      {typeLabel(item.type)}
                                    </span>
                                  </button>
                                );
                              }}
                            />
                          </section>
                        ))
                      )}
                    </div>
                  )
                ) : showFeedSkeleton ? (
                  <FeedSkeleton />
                ) : !tabHasFeedContent && activeTab !== 'moods_genres' ? (
                  activeTab === 'mood' && activeMood === FAVORITES_ID ? (
                    <div className="empty-state-message">
                      <h2>{t.favsEmptyTitle}</h2>
                      <p>{t.favsEmptyDesc}</p>
                    </div>
                  ) : activeTab === 'mood' && browseEmptyKind === 'episodes' ? (
                    <div className="empty-state-message">
                      {browseTitle && <h2 className="library-section-title">{browseTitle}</h2>}
                      <h2>{t.episodesEmptyTitle}</h2>
                      <p>{t.episodesEmptyDesc}</p>
                    </div>
                  ) : activeTab === 'mood' && browseEmptyKind === 'collection' ? (
                    <div className="empty-state-message">
                      {browseTitle && <h2 className="library-section-title">{browseTitle}</h2>}
                      <h2>{t.collectionEmptyTitle}</h2>
                      <p>{t.collectionEmptyDesc}</p>
                    </div>
                  ) : activeTab === 'search' ? (
                    <div className="empty-state-message">
                      <h2>{t.noResults}</h2>
                      <p>{t.noResultsDesc}</p>
                    </div>
                  ) : (
                    // home / explore / mood came back empty: almost always no connection
                    <div className="empty-state-message">
                      <h2>{t.feedLoadFailedTitle}</h2>
                      <p>{t.feedLoadFailedDesc}</p>
                      <button
                        type="button"
                        className="primary-action-btn empty-state-retry"
                        onClick={() => {
                          if (activeTab === 'explore') loadExplore(lang);
                          else if (activeTab === 'mood' && isBrowseMood(activeMood)) {
                            const id = browseIdFromMood(activeMood);
                            if (id) {
                              openBrowsePage({
                                id,
                                type: 'artist',
                                title: browseTitle || '',
                                artist: '',
                                cover: '',
                              });
                            }
                          } else if (activeTab === 'mood' && activeMood) openMoodById(activeMood);
                          else loadHome(lang);
                        }}
                      >
                        {t.retry}
                      </button>
                    </div>
                  )
                ) : (
                  <>
                    {(activeTab === 'home' ||
                      (activeTab === 'mood' &&
                        !isBrowseMood(activeMood) &&
                        activeMood !== FAVORITES_ID)) && (
                      <MoodChips
                        activeCategory={activeMood}
                        onCategoryClick={loadMood}
                        lang={lang}
                        t={t}
                      />
                    )}
                    {activeTab === 'mood' &&
                      browseTitle &&
                      (isBrowseMood(activeMood) || activeMood === FAVORITES_ID) && (
                        <h2 className="library-section-title">{browseTitle}</h2>
                      )}

                    {activeTab === 'home' && homeHeroTrack && (
                      <FeedHero
                        track={homeHeroTrack}
                        eyebrow={t.featured}
                        playLabel={t.play}
                        onPlay={() =>
                          handleItemClick(
                            homeHeroTrack,
                            t.quickPicks,
                            quickPicks.length ? quickPicks : undefined
                          )
                        }
                      />
                    )}

                    {activeTab === 'home' && (
                      <QuickPicks tracks={quickPicks} onItemClick={handleItemClick} t={t} />
                    )}

                    {activeTab === 'search' && heroTrack && (
                      <HeroSection
                        track={heroTrack}
                        onPlay={() =>
                          handleItemClick(heroTrack, sections[0]?.title, sections[0]?.items)
                        }
                        t={t}
                      />
                    )}
                    {activeTab === 'search' && (
                      <div className="search-results-list">
                        {sections
                          .flatMap((s) => s.items)
                          .slice(0, 48)
                          .map((item) => {
                            const ownerSection = sections.find((s) =>
                              s.items.some((i) => i.id === item.id)
                            );
                            return (
                              <button
                                key={item.id}
                                data-ctx-track={ctxTrackAttr(item)}
                                className={`search-result-row search-result-type-${item.type}`}
                                onClick={() =>
                                  handleItemClick(item, ownerSection?.title, ownerSection?.items)
                                }
                              >
                                <div className="search-result-cover-wrap">
                                  <img
                                    alt=""
                                    className="search-result-cover"
                                    loading="lazy"
                                    decoding="async"
                                    {...coverAttrs(item)}
                                  />
                                  <div className="search-result-play-icon">
                                    <Play size={14} fill="currentColor" />
                                  </div>
                                </div>
                                <div className="search-result-meta">
                                  <span className="search-result-title">{item.title}</span>
                                  <span className="search-result-artist">{item.artist}</span>
                                </div>
                                <span className="search-result-badge">{typeLabel(item.type)}</span>
                              </button>
                            );
                          })}
                      </div>
                    )}

                    {activeTab === 'explore' && (
                      <ExploreView
                        sections={exploreSections}
                        onItemClick={handleItemClick}
                        onNavigateMoods={openMoodsGenres}
                        t={t}
                        lang={lang}
                        renderSection={(section, idx) => (
                          <SectionRow
                            key={`${section.title}-${idx}`}
                            section={section}
                            sectionIndex={idx}
                            onItemClick={handleItemClick}
                          />
                        )}
                      />
                    )}

                    {activeTab === 'moods_genres' && (
                      <MoodsGenresView onCategoryClick={loadMood} t={t} lang={lang} />
                    )}

                    {activeTab !== 'explore' &&
                      activeTab !== 'moods_genres' &&
                      activeTab !== 'search' && (
                        <div className="sections-container">{sectionRows}</div>
                      )}
                  </>
                )}
              </div>
            )}
          </main>

          <footer className="player-bar-premium">
            <div
              className={`player-now-playing-block ${currentTrack ? 'clickable' : ''}`}
              onClick={() => currentTrack && openPlayer()}
            >
              {currentTrack && (
                <>
                  <img
                    loading="lazy"
                    decoding="async"
                    alt=""
                    className="player-mini-cover"
                    {...coverAttrs(currentTrack, 'thumb')}
                  />
                  <div className="player-mini-info">
                    <span className="player-title">{currentTrack.title}</span>
                    <span className="player-artist">{currentTrack.artist}</span>
                  </div>
                </>
              )}
            </div>

            <div className="player-core-controls">
              <div className="playback-buttons-group">
                <Shuffle
                  size={18}
                  className={`control-icon-btn pb-mode-btn ${shuffleOn ? 'active' : ''}`}
                  aria-label={t.shuffle}
                  onClick={toggleShuffle}
                />
                <SkipBack
                  size={22}
                  className="control-icon-btn"
                  aria-label={t.previousTrack}
                  onClick={playPrev}
                >
                  <title>{t.previousTrack}</title>
                </SkipBack>
                <div
                  className="main-play-pause-circle"
                  onClick={togglePlay}
                  role="button"
                  aria-label={isPlaying ? t.pause : t.play}
                  title={isPlaying ? t.pause : t.play}
                >
                  {buffering ? (
                    <Loader2 size={24} className="spin-icon" />
                  ) : isPlaying ? (
                    <Pause size={24} fill="currentColor" />
                  ) : (
                    <Play size={24} fill="currentColor" />
                  )}
                </div>
                <SkipForward
                  size={22}
                  className="control-icon-btn"
                  aria-label={t.nextTrack}
                  onClick={playNext}
                >
                  <title>{t.nextTrack}</title>
                </SkipForward>
                {loopMode === 'one' ? (
                  <Repeat1
                    size={18}
                    className="control-icon-btn pb-mode-btn active"
                    aria-label={t.loopOne}
                    onClick={cycleLoop}
                  />
                ) : (
                  <Repeat
                    size={18}
                    className={`control-icon-btn pb-mode-btn ${loopMode === 'all' ? 'active' : ''}`}
                    aria-label={loopMode === 'all' ? t.loopAll : t.loop}
                    onClick={cycleLoop}
                  />
                )}
              </div>
              <div className={`progress-bar-wrapper${progressScrubbing ? ' scrubbing' : ''}`}>
                <span ref={progressTimeElRef} className="progress-time-text" />
                <div
                  ref={progressTrackRef}
                  className="progress-bar-track"
                  onPointerDown={onProgressPointerDown}
                  onPointerMove={onProgressPointerMove}
                  onPointerUp={onProgressPointerUp}
                  onPointerCancel={onProgressPointerUp}
                >
                  <div ref={progressFillRef} className="progress-bar-fill" />
                  {pluginStates['ab-loop'] && abLoop.a !== null && duration > 0 && (
                    <div
                      className="ab-marker ab-a"
                      style={{ left: `${(abLoop.a / duration) * 100}%` }}
                      title="A"
                    />
                  )}
                  {pluginStates['ab-loop'] && abLoop.b !== null && duration > 0 && (
                    <div
                      className="ab-marker ab-b"
                      style={{ left: `${(abLoop.b / duration) * 100}%` }}
                      title="B"
                    />
                  )}
                  {pluginStates['ab-loop'] &&
                    abLoop.active &&
                    abLoop.a !== null &&
                    abLoop.b !== null &&
                    duration > 0 && (
                      <div
                        className="ab-loop-region"
                        style={{
                          left: `${(abLoop.a! / duration) * 100}%`,
                          width: `${((abLoop.b! - abLoop.a!) / duration) * 100}%`,
                        }}
                      />
                    )}
                  <div
                    ref={progressHandleRef}
                    className={`progress-bar-handle${progressScrubbing ? ' dragging' : ''}`}
                  />
                </div>
                <button
                  type="button"
                  className="progress-time-text remaining-toggle"
                  title={showRemaining ? t.remainingLabel : t.durationLabel}
                  onClick={() => setShowRemaining((v) => !v)}
                >
                  <span ref={durationTimeElRef} />
                </button>
              </div>
            </div>

            <div className="player-extra-controls-group">
              {pluginStates['ab-loop'] && (
                <Repeat2
                  size={18}
                  className={`extra-icon-btn ${abLoop.active ? 'active' : ''}`}
                  aria-label={t.abLoop}
                  onClick={() => {
                    if (abLoop.active) {
                      clearAbLoop();
                      setAbLoop(getAbLoop());
                    } else {
                      setAbPoint('a', progressRef.current);
                      setAbPoint('b', Math.min(duration, progressRef.current + 15));
                      setAbLoop(getAbLoop());
                    }
                  }}
                />
              )}
              {pluginStates['share-card'] && (
                <Share2
                  size={18}
                  className={`extra-icon-btn ${shareCardOk ? 'active' : ''}`}
                  aria-label={shareCardOk ? t.shareCardCopied : t.shareCard}
                  onClick={handleShareCard}
                />
              )}
              <button
                type="button"
                className={`extra-icon-btn lyrics-toggle-btn ${activeTab === 'player' ? 'active' : ''}`}
                aria-label={activeTab === 'player' ? t.lyricsClose : t.lyrics}
                title={activeTab === 'player' ? t.lyricsClose : t.lyrics}
                aria-pressed={activeTab === 'player'}
                disabled={!currentTrack}
                data-testid="lyrics-toggle"
                onClick={() => {
                  // in the player the lyrics are already up, so the same button takes you back
                  if (activeTab === 'player') navigateTo(prevTab === 'player' ? 'home' : prevTab);
                  else if (currentTrack) openPlayer();
                }}
              >
                <Mic2 size={20} />
              </button>
              <div className="volume-control-block" ref={volumeBlockRef} data-testid="volume-block">
                {isMuted || volume === 0 ? (
                  <VolumeX
                    size={20}
                    className="extra-icon-btn volume-muted-icon"
                    aria-label={t.unmute}
                    onClick={toggleMute}
                  />
                ) : volume < 0.5 ? (
                  <Volume1
                    size={20}
                    className="extra-icon-btn"
                    aria-label={t.mute}
                    onClick={toggleMute}
                  />
                ) : (
                  <Volume2
                    size={20}
                    className="extra-icon-btn"
                    aria-label={t.mute}
                    onClick={toggleMute}
                  />
                )}
                <div className="volume-bar-track" onClick={handleVolumeClick}>
                  <div
                    className={`volume-bar-fill ${isMuted ? 'muted' : ''}`}
                    style={{ width: `${isMuted ? 0 : volume * 100}%` }}
                  ></div>
                </div>
                <span className="volume-pct">
                  {isMuted ? '0%' : `${Math.round(volume * 100)}%`}
                </span>
              </div>
              <button
                type="button"
                className={`extra-icon-btn queue-toggle-btn ${queueOpen ? 'active' : ''}`}
                aria-label={t.openQueue}
                aria-expanded={queueOpen}
                onClick={() => setQueueOpen((o) => !o)}
              >
                <ListMusic size={20} />
              </button>
            </div>
          </footer>

          <QueueDrawer
            open={queueOpen}
            queue={queue}
            queueIndex={queueIndex}
            t={t}
            onClose={() => setQueueOpen(false)}
            onSelectTrack={(idx, _track) => {
              if (idx !== queueIndex) void playByIndex(idx);
            }}
            onRemoveTrack={(idx) => {
              const prev = queueRef.current;
              if (idx < 0 || idx >= prev.length) return;
              const wasCurrent = idx === queueIndexRef.current;
              const next = prev.filter((_, i) => i !== idx);
              let newIndex = queueIndexRef.current;
              if (idx < newIndex) newIndex -= 1;
              else if (idx === newIndex) {
                newIndex = Math.min(newIndex, Math.max(0, next.length - 1));
              }
              queueRef.current = next;
              queueIndexRef.current = newIndex;
              setQueue(next);
              setQueueIndex(newIndex);
              if (next.length === 0) {
                ++loadGenRef.current;
                audio.pause();
                audio.src = '';
                setCurrentTrack(null);
                setIsPlaying(false);
                setBuffering(false);
              } else if (wasCurrent && next[newIndex]) {
                void loadTrack(next[newIndex], isPlayingRef.current);
              }
            }}
            onReorder={(from, to) => {
              const prev = queueRef.current;
              if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length)
                return;
              const next = prev.slice();
              const [moved] = next.splice(from, 1);
              next.splice(to, 0, moved);
              // keep the playing track playing, only its position in the list changes
              const cur = queueIndexRef.current;
              let newIndex = cur;
              if (from === cur) newIndex = to;
              else if (from < cur && to >= cur) newIndex = cur - 1;
              else if (from > cur && to <= cur) newIndex = cur + 1;
              queueRef.current = next;
              queueIndexRef.current = newIndex;
              setQueue(next);
              setQueueIndex(newIndex);
            }}
            onClearQueue={() => {
              const current = queueRef.current[queueIndexRef.current];
              if (current) {
                setQueue([current]);
                queueRef.current = [current];
                setQueueIndex(0);
                queueIndexRef.current = 0;
              } else {
                setQueue([]);
                queueRef.current = [];
                setQueueIndex(0);
              }
              pushToast(t.queueCleared, 'success');
            }}
          />
        </div>
      </div>

      {isSettingsOpen && (
        <div className="global-modal-overlay" onClick={() => setIsSettingsOpen(false)}>
          <div className="glass-modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header-polished">
              <h2>{t.generalSettings}</h2>
              <X size={26} className="modal-close-icon" onClick={() => setIsSettingsOpen(false)} />
            </div>
            <div className="modal-body-polished">
              <div className="settings-row-item settings-toggle-row">
                <div className="settings-account-info">
                  <span className="setting-label">{t.rememberLogin}</span>
                  <span className="plugin-desc">{t.rememberLoginDesc}</span>
                </div>
                <button
                  type="button"
                  className={`lang-option-btn remember-login-toggle${rememberLogin ? ' active' : ''}`}
                  onClick={async () => {
                    const next = !rememberLogin;
                    setRememberLoginState(next);
                    setRememberLogin(next);
                    if (next) {
                      await persistSessionIfWanted();
                    } else {
                      try {
                        await invoke('forget_ytm_session_file');
                      } catch {}
                    }
                  }}
                >
                  {rememberLogin ? t.pluginEnabled : t.pluginDisabled}
                </button>
              </div>
              <div className="settings-row-item settings-toggle-row">
                <div className="settings-account-info">
                  <span className="setting-label">{t.lightLyrics}</span>
                  <span className="plugin-desc">{t.lightLyricsDesc}</span>
                </div>
                <button
                  type="button"
                  className={`lang-option-btn remember-login-toggle${lightLyrics ? ' active' : ''}`}
                  aria-pressed={lightLyrics}
                  onClick={() => setLightLyrics(!lightLyrics)}
                >
                  {lightLyrics ? t.pluginEnabled : t.pluginDisabled}
                </button>
              </div>
              <div className="settings-row-item settings-toggle-row">
                <div className="settings-account-info">
                  <span className="setting-label">{t.replayOnboarding}</span>
                  <span className="plugin-desc">{t.replayOnboardingDesc}</span>
                </div>
                <button
                  type="button"
                  className="lang-option-btn settings-action-btn"
                  onClick={() => {
                    resetOnboarding();
                    setIsSettingsOpen(false);
                    setShowOnboarding(true);
                  }}
                >
                  {t.onbTourCta}
                </button>
              </div>
              <div className="settings-row-item settings-toggle-row">
                <div className="settings-account-info">
                  <span className="setting-label" id="settings-language-label">
                    {t.language}
                  </span>
                  <span className="plugin-desc">{t.languageDesc}</span>
                </div>
                <div
                  className="language-selector-group"
                  role="radiogroup"
                  aria-labelledby="settings-language-label"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={lang === 'en'}
                    className={`lang-option-btn ${lang === 'en' ? 'active' : ''}`}
                    onClick={() => changeLanguage('en')}
                  >
                    {t.langEn}
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={lang === 'pl'}
                    className={`lang-option-btn ${lang === 'pl' ? 'active' : ''}`}
                    onClick={() => changeLanguage('pl')}
                  >
                    {t.langPl}
                  </button>
                </div>
              </div>
              {libAuthed && (
                <div className="settings-row-item settings-account-row">
                  <div className="settings-account-info">
                    <span className="setting-label">{t.logout}</span>
                    <span className="plugin-desc">{t.logoutDesc}</span>
                  </div>
                  <button
                    type="button"
                    className="settings-logout-btn"
                    onClick={() => void handleLogout()}
                  >
                    <LogOut size={16} />
                    {t.logout}
                  </button>
                </div>
              )}
              <div className="settings-row-item settings-toggle-row">
                <div className="settings-account-info">
                  <span className="setting-label">{t.checkUpdates}</span>
                  <span className="plugin-desc">
                    {t.appVersion} {appVersion}
                  </span>
                  {updateStatus && (
                    <span
                      className={`settings-update-status tone-${
                        updateStatus.kind === 'failed'
                          ? 'error'
                          : updateStatus.kind === 'unpublished'
                            ? 'info'
                            : 'success'
                      }`}
                      role="status"
                    >
                      {updateStatus.kind === 'newer'
                        ? `${t.updateAvailable}: ${updateStatus.tag}`
                        : updateStatus.kind === 'current'
                          ? `${t.upToDate} (${updateStatus.tag})`
                          : updateStatus.kind === 'unpublished'
                            ? t.updateNotPublished
                            : t.updateCheckFailed}
                    </span>
                  )}
                </div>
                {updateStatus?.installable ? (
                  <button
                    type="button"
                    className="lang-option-btn settings-action-btn"
                    disabled={updateInstalling !== false}
                    onClick={() => void installAppUpdate()}
                  >
                    {updateInstalling === false
                      ? t.updateNow
                      : `${t.updateDownloading}${updateInstalling != null ? ` ${updateInstalling}%` : ''}`}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="lang-option-btn settings-action-btn"
                    disabled={updateBusy}
                    onClick={() => void checkForAppUpdate()}
                  >
                    {updateBusy ? t.checkingUpdates : t.checkUpdatesShort}
                  </button>
                )}
              </div>
              <div className="settings-row-item settings-toggle-row">
                <div className="settings-account-info">
                  <span className="setting-label">{t.downloadPage}</span>
                  <span className="plugin-desc">{t.aboutLegal}</span>
                </div>
                <button
                  type="button"
                  className="lang-option-btn settings-action-btn"
                  onClick={() => void openUrl(updateStatus?.url || GITHUB_RELEASES).catch(() => {})}
                >
                  {t.openRelease}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {pmOpen && (
        <PlaylistManager
          lang={lang}
          ownerName={libAccount?.name ?? null}
          onClose={() => setPmOpen(false)}
          onPlay={(tracks, index, title) => {
            if (tracks[index]) handleItemClick(tracks[index], title, tracks);
          }}
          onChanged={() => void loadUserPlaylists()}
        />
      )}
      {ctxMenu && (
        <>
          <div
            className="ctx-menu-catcher"
            onClick={() => setCtxMenu(null)}
            onContextMenu={() => setCtxMenu(null)}
          />
          <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} role="menu">
            <div className="ctx-menu-label">{t.ctxAddToPlaylist}</div>
            {userPlaylists.filter((p) => isEditablePlaylist(p.id)).length === 0 ? (
              <div className="ctx-menu-empty">{t.ctxNoPlaylists}</div>
            ) : (
              userPlaylists
                .filter((p) => isEditablePlaylist(p.id))
                .map((p) => (
                  <button
                    key={p.id}
                    role="menuitem"
                    onClick={() => {
                      const track = ctxMenu.track;
                      setCtxMenu(null);
                      void addCurrentToPlaylist(p, false, track);
                    }}
                  >
                    {p.title}
                  </button>
                ))
            )}
            {libAuthed && (
              <button
                role="menuitem"
                onClick={() => {
                  setCtxMenu(null);
                  setPmOpen(true);
                }}
              >
                {t.pmOpen}
              </button>
            )}
          </div>
        </>
      )}
      {isPluginsOpen && (
        <Suspense fallback={null}>
          <PluginsPanel
            lang={lang}
            pluginStates={pluginStates}
            togglePlugin={togglePlugin}
            onClose={() => setIsPluginsOpen(false)}
            discordClientId={discordClientId}
            saveDiscordClientId={saveDiscordClientId}
            audio={audio}
            currentTrack={currentTrack}
            onPlayTrack={(track, list) => {
              setIsPluginsOpen(false);
              void handleItemClick(track, t.historyTitle, list);
            }}
          />
        </Suspense>
      )}

      {plEdit && (
        <div className="global-modal-overlay" onClick={() => !plEditBusy && setPlEdit(null)}>
          <div className="glass-modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header-polished">
              <h2>{plEdit.mode === 'rename' ? t.renamePlaylist : t.deletePlaylist}</h2>
              <X size={26} className="modal-close-icon" onClick={() => setPlEdit(null)} />
            </div>
            <div className="modal-body-polished np-modal-body">
              {plEdit.mode === 'rename' ? (
                <label className="np-field">
                  <span className="np-field-label">{t.npTitle}</span>
                  <input
                    className="settings-text-input np-input"
                    type="text"
                    value={plEditTitle}
                    maxLength={150}
                    autoFocus
                    onChange={(e) => setPlEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitPlaylistEdit();
                    }}
                    spellCheck={false}
                  />
                </label>
              ) : (
                <p className="plugin-desc">
                  {t.deletePlaylistConfirm.replace('{name}', plEdit.pl.title)}
                </p>
              )}
              {plEditError && <div className="np-error">{t.playlistEditFailed}</div>}
              <div className="np-actions">
                <button className="np-cancel-btn" onClick={() => setPlEdit(null)}>
                  {t.npCancel}
                </button>
                <button
                  className={`np-create-btn${plEdit.mode === 'delete' ? ' danger' : ''}`}
                  disabled={plEditBusy || (plEdit.mode === 'rename' && !plEditTitle.trim())}
                  onClick={() => void submitPlaylistEdit()}
                >
                  {plEditBusy
                    ? t.working
                    : plEdit.mode === 'rename'
                      ? t.saveChanges
                      : t.deletePlaylist}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {fdEdit && (
        <div className="global-modal-overlay" onClick={() => setFdEdit(null)}>
          <div className="glass-modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header-polished">
              <h2>{fdEdit.mode === 'rename' ? t.renameFolder : t.moveToFolder}</h2>
              <X size={26} className="modal-close-icon" onClick={() => setFdEdit(null)} />
            </div>
            <div className="modal-body-polished np-modal-body">
              {fdEdit.mode === 'move' && (
                <label className="np-field">
                  <span className="np-field-label">{t.folder}</span>
                  <Select
                    value={fdEdit.target}
                    ariaLabel={t.folder}
                    options={[
                      { value: '', label: t.noFolder },
                      ...plFolders.folders.map((f) => ({ value: f.id, label: f.name })),
                      { value: '__new', label: t.newFolder },
                    ]}
                    onChange={(v) => setFdEdit({ ...fdEdit, target: String(v) })}
                  />
                </label>
              )}
              {(fdEdit.mode === 'rename' || fdEdit.target === '__new') && (
                <label className="np-field">
                  <span className="np-field-label">{t.folderName}</span>
                  <input
                    className="settings-text-input np-input"
                    type="text"
                    value={fdName}
                    maxLength={80}
                    autoFocus
                    onChange={(e) => setFdName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitFolderEdit();
                    }}
                    spellCheck={false}
                  />
                </label>
              )}
              <p className="plugin-desc">{t.folderLocalHint}</p>
              <div className="np-actions">
                <button className="np-cancel-btn" onClick={() => setFdEdit(null)}>
                  {t.npCancel}
                </button>
                <button
                  className="np-create-btn"
                  disabled={
                    (fdEdit.mode === 'rename' || fdEdit.target === '__new') && !fdName.trim()
                  }
                  onClick={submitFolderEdit}
                >
                  {t.saveChanges}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {npOpen && (
        <div className="global-modal-overlay" onClick={() => setNpOpen(false)}>
          <div className="glass-modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header-polished">
              <h2>{t.newPlaylist}</h2>
              <X size={26} className="modal-close-icon" onClick={() => setNpOpen(false)} />
            </div>
            <div className="modal-body-polished np-modal-body">
              <label className="np-field">
                <span className="np-field-label">{t.npTitle}</span>
                <input
                  className="settings-text-input np-input"
                  type="text"
                  value={npTitle}
                  maxLength={150}
                  autoFocus
                  onChange={(e) => setNpTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitNewPlaylist();
                  }}
                  spellCheck={false}
                />
              </label>
              <label className="np-field">
                <span className="np-field-label">{t.npDesc}</span>
                <textarea
                  className="settings-text-input np-input np-textarea"
                  value={npDesc}
                  maxLength={5000}
                  rows={3}
                  onChange={(e) => setNpDesc(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <div className="np-field">
                <span className="np-field-label">{t.npPrivacy}</span>
                <div className="np-privacy-group">
                  {(
                    [
                      ['PRIVATE', t.npPrivate],
                      ['UNLISTED', t.npUnlisted],
                      ['PUBLIC', t.npPublic],
                    ] as [PlaylistPrivacy, string][]
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      className={`np-privacy-pill ${npPrivacy === value ? 'active' : ''}`}
                      onClick={() => setNpPrivacy(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {npError && <div className="np-error">{t.npError}</div>}
              <div className="np-actions">
                <button className="np-cancel-btn" onClick={() => setNpOpen(false)}>
                  {t.npCancel}
                </button>
                <button
                  className="np-create-btn"
                  disabled={!npTitle.trim() || npBusy}
                  onClick={submitNewPlaylist}
                >
                  {npBusy ? t.npCreating : t.npCreate}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
