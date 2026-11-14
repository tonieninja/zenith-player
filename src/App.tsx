import { mergeFavoriteTracks, readSavedTracks, persistFavorites } from './utils/favorites';
import { applyWheelVolume, isTypingEvent } from './utils/dom';
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
import { createPortal } from 'react-dom';
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
  setTrackRating,
  getTrackLikeStatus,
  nextLikeStatus,
  type TrackLikeStatus,
  isEditablePlaylist,
  toPlainPlaylistId,
  invalidateLibraryCache,
  getAccountProfile,
  getAudioStream,
  getExplore,
  moodBrowseIdFor,
  getHomeFeed,
  getLibrary,
  peekLibraryCache,
  prefetchLibrary,
  extendLibrarySections,
  getLyrics,
  getMoodPlaylist,
  loadPlaylistItems,
  AlreadyInPlaylistError,
  SessionExpiredError,
  getUserPlaylists,
  getWatchRelated,
  getRadioTracks,
  getRelatedTracks,
  preloadImage,
  resolveLoginState,
  searchMusic,
  isLoggedIn,
  waitForLogin,
  lastSessionCheckWasInconclusive,
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
import {
  browseIdFromMood,
  browseMoodId,
  isBrowseMood,
  isViewingPlaylist,
  itemClickPlan,
  sidebarClickPlan,
} from './utils/itemClick';
import { ctxTrackAttr, parseCtxTrackAttr } from './utils/ctxTrack';
import { SyncedLyricsRail } from './components/SyncedLyricsRail';
import { LIB_EMPTY_KEYS, LIBRARY_CATEGORIES, nextLibraryViewState } from './constants/library';
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
import { ModalOverlay } from './components/ui/ModalOverlay';
import { YtmRatingButtons } from './components/player/YtmRatingButtons';
import { PlaylistManager } from './components/PlaylistManager';
import { streamStuckMessage, translations, type Language } from './i18n';
import { AUX_WINDOW_PLUGINS, pluginManager } from './plugins';
import { syncCloseToTray } from './plugins/systemTray';
import { pushHotkeyBindings, syncGlobalHotkeys } from './plugins/globalHotkeys';
import {
  abLoopPhase,
  cycleAbLoop,
  getAbLoop,
  registerAbLoopSink,
  subscribeAbLoop,
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
import { copyTrackLink } from './plugins/copyTrackLink';
import {
  getSleepEndsAt,
  rearmSleepTimer,
  registerSleepTimerCallback,
  setSleepTimerMinutes,
} from './plugins/sleepTimer';
import { getPlaybackSpeed } from './plugins/playbackSpeed';
import { rampVolume, rampVolumeAsync } from './plugins/smoothVolume';
import type { LoopMode, ViewTab } from './types/views';
import {
  getActiveLyricIndex,
  secondsUntilLyricChange,
  setActiveLyricLine,
  useActiveLyricLine,
} from './utils/activeLyric';
import { applyCoverTheme, resetCoverTheme } from './utils/coverTheme';
import { barDurationForTrack, formatTime, knownDurationSec } from './utils/formatTime';
import {
  committedPlaylistDescription,
  committedPlaylistTitle,
  isCommitKey,
} from './utils/playlistForm';
import { localizeLyricsReason } from './utils/lyricsReasons';
import { getRememberLogin, setRememberLogin } from './utils/rememberLogin';
import { setLightLyrics, useLightLyrics } from './utils/lightLyrics';
import {
  checkGithubUpdate,
  checkSignedUpdate,
  DONATE_URL,
  GITHUB_RELEASES,
  installPendingUpdate,
} from './utils/appUpdate';
import { resetOnboarding, shouldShowOnboarding } from './utils/onboarding';

const Onboarding = lazy(() =>
  import('./components/Onboarding').then((m) => ({ default: m.Onboarding }))
);
const PluginsPanel = lazy(() =>
  import('./components/PluginsPanel').then((m) => ({ default: m.PluginsPanel }))
);
import { smartShuffle } from './utils/smartShuffle';
import {
  decidePrevious,
  pickPrevPosition,
  popPlayHistory,
  pushPlayHistory,
} from './utils/playbackNav';
import { stableOrderSections } from './utils/feed';
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
  Minus,
  Square,
  Maximize2,
  LogOut,
  Loader2,
  Folder,
  FolderOpen,
} from 'lucide-react';
import { useLatest } from './hooks/useLatest';
import './App.css';

const appWindow = getCurrentWindow();
const FAVORITES_ID = '__favorites';
const MAX_SEARCH_LENGTH = 200;

type FeedLoadTab = 'home' | 'explore' | 'mood' | 'search';
const FEED_LOADING_INITIAL: Record<FeedLoadTab, boolean> = {
  home: false,
  explore: false,
  mood: false,
  search: false,
};

function PlayerLyricsRail(props: Omit<ComponentProps<typeof SyncedLyricsRail>, 'idx'>) {
  const idx = useActiveLyricLine();
  return <SyncedLyricsRail {...props} idx={idx} />;
}

export default function App() {
  const [sections, setSections] = useState<Section[]>([]);
  const [homeSections, setHomeSections] = useState<Section[]>([]);
  const [exploreSections, setExploreSections] = useState<Section[]>([]);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const hotkeyActionRef = useRef<((action: string) => void) | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [playingFrom, setPlayingFrom] = useState<string | null>(null);
  const [related, setRelated] = useState<RelatedResult | null>(null);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [panelTab, setPanelTab] = useState<'upnext' | 'related'>('upnext');
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricsProvider, setLyricsProvider] = useState<LyricsProvider>('Auto');
  const lyricsProviderRef = useRef<LyricsProvider>('Auto');
  const lastHydrateKeyRef = useRef('');
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
  useEffect(() => subscribeAbLoop(setAbLoop), []);
  const [activeTab, setActiveTab] = useState<ViewTab>('home');
  const [prevTab, setPrevTab] = useState<ViewTab>('home');
  const [quickPicks, setQuickPicks] = useState<Track[]>([]);
  const [activeMood, setActiveMood] = useState<string | null>(null);
  const [browseTitle, setBrowseTitle] = useState<string | null>(null);
  const [browseEmptyKind, setBrowseEmptyKind] = useState<'episodes' | 'collection' | null>(null);
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
  const playingFromIdRef = useRef<string | null>(null);
  const progressRef = useRef(0);
  const audioDurationTrackIdRef = useRef<string | null>(null);
  const syncDurationFromAudioRef = useRef<() => void>(() => {});
  const playingAlbumRef = useRef(false);
  const forceBlendRef = useRef(false);
  const prerollForRef = useRef<string | null>(null);
  const streamCacheRef = useRef<Map<string, { url: string; ts: number }>>(new Map());
  const lyricsReqIdRef = useRef(0);
  const relatedReqIdRef = useRef(0);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const progressHandleRef = useRef<HTMLDivElement>(null);
  const progressTimeElRef = useRef<HTMLSpanElement>(null);
  const durationTimeElRef = useRef<HTMLSpanElement>(null);
  const lastRoomPushRef = useRef(0);
  const preloadDoneRef = useRef(new Set<string>());
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [showRemaining, setShowRemaining] = useState(false);
  const showRemainingRef = useLatest(showRemaining);
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
  const coverWheelRef = useRef<HTMLDivElement | null>(null);
  const [loopMode, setLoopMode] = useState<LoopMode>('off');
  const [shuffleOn, setShuffleOn] = useState(false);
  const originalQueueRef = useRef<Track[] | null>(null);
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

  const [libAuthed, setLibAuthed] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
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
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    track: Track;
    at?: number;
  } | null>(null);
  const [trackRating, setTrackRatingState] = useState<TrackLikeStatus>('INDIFFERENT');
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

  const [npOpen, setNpOpen] = useState(false);
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
  const npTitleRef = useRef<HTMLInputElement>(null);
  const [npDesc, setNpDesc] = useState('');
  const npDescRef = useRef<HTMLTextAreaElement>(null);
  const [npPrivacy, setNpPrivacy] = useState<PlaylistPrivacy>('PRIVATE');
  const [npBusy, setNpBusy] = useState(false);
  const [npError, setNpError] = useState(false);

  const [savedTracks, setSavedTracks] = useState<Track[]>(() =>
    readSavedTracks(localStorage.getItem('zenith_saved_tracks'))
  );
  const [accountLikes, setAccountLikes] = useState<Track[]>([]);
  const likedIdSet = useMemo(() => {
    const ids = new Set(savedTracks.map((x) => x.id));
    for (const x of accountLikes) ids.add(x.id);
    return ids;
  }, [savedTracks, accountLikes]);
  const likedIdSetRef = useLatest(likedIdSet);

  const [lang, setLang] = useState<Language>(() => {
    return (localStorage.getItem('zenith_lang') as Language) || 'en';
  });
  const [rememberLogin, setRememberLoginState] = useState(() => getRememberLogin());
  const lightLyrics = useLightLyrics();
  const [appVersion, setAppVersion] = useState('1.0.0');
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<{
    kind: 'newer' | 'current' | 'ahead' | 'unpublished' | 'failed';
    tag?: string;
    url?: string;
    installable?: boolean;
  } | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState<number | null | false>(false);
  const t = translations[lang];

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
      .catch((err) => console.debug('App', err));
  }, []);

  const checkForAppUpdate = useCallback(async () => {
    if (updateBusy) return;
    setUpdateBusy(true);
    setUpdateStatus(null);
    try {
      let version = appVersion;
      try {
        const live = await getVersion();
        if (live) {
          version = live;
          if (live !== appVersion) setAppVersion(live);
        }
      } catch (err) {
        console.debug('App', err);
      }
      const tr = translations[lang];
      const signed = await checkSignedUpdate(version);
      if (signed) {
        setUpdateStatus({ kind: 'newer', tag: signed.version, installable: true });
        pushToast(
          tr.updateAvailableTag.replace('{tag}', signed.version),
          'success',
          12000,
          {
            label: tr.updateNow,
            labelKey: 'updateNow',
            onClick: () => void installAppUpdateRef.current(),
          },
          { key: 'updateAvailableTag', vars: { tag: signed.version } }
        );
        return;
      }
      const result = await checkGithubUpdate(version);
      if (result.status === 'newer') {
        setUpdateStatus({ kind: 'newer', tag: result.tag, url: result.url });
        pushToast(tr.updateAvailableTag.replace('{tag}', result.tag), 'success', 3200, undefined, {
          key: 'updateAvailableTag',
          vars: { tag: result.tag },
        });
      } else if (result.status === 'ahead') {
        setUpdateStatus({ kind: 'ahead', tag: result.tag });
        pushToast(
          tr.updateAhead.replace('{current}', version).replace('{tag}', result.tag),
          'info',
          3200,
          undefined,
          { key: 'updateAhead', vars: { current: version, tag: result.tag } }
        );
      } else if (result.status === 'current') {
        setUpdateStatus({ kind: 'current', tag: result.tag });
        pushToast(tr.upToDate, 'success', 3200, undefined, { key: 'upToDate' });
      } else {
        setUpdateStatus({ kind: 'unpublished' });
        pushToast(tr.updateNotPublished, 'info', 3200, undefined, { key: 'updateNotPublished' });
      }
    } catch (e) {
      console.warn('[update]', e);
      setUpdateStatus({ kind: 'failed' });
      pushToast(translations[lang].updateCheckFailed, 'error', 3200, undefined, {
        key: 'updateCheckFailed',
      });
    } finally {
      setUpdateBusy(false);
    }
  }, [appVersion, lang, updateBusy]);

  const installAppUpdate = useCallback(async () => {
    if (updateInstalling !== false) return;
    setUpdateInstalling(null);
    pushToast(t.updateDownloading, 'info', 3200, undefined, { key: 'updateDownloading' });
    try {
      await installPendingUpdate((pct) => setUpdateInstalling(pct));
    } catch (e) {
      console.warn('[update] install failed', e);
      setUpdateInstalling(false);
      pushToast(
        t.updateInstallFailed,
        'error',
        8000,
        {
          label: t.openRelease,
          labelKey: 'openRelease',
          onClick: () =>
            void openUrl(`${GITHUB_RELEASES}/latest`).catch((err) =>
              console.debug('App onClick', err)
            ),
        },
        { key: 'updateInstallFailed' }
      );
    }
  }, [t, updateInstalling]);
  const installAppUpdateRef = useLatest(installAppUpdate);

  useEffect(() => {
    if (import.meta.env.DEV || localStorage.getItem('zenith_auto_update_check') === '0') return;
    const id = window.setTimeout(() => {
      void (async () => {
        let version = '';
        try {
          version = await getVersion();
        } catch (err) {
          console.debug('App', err);
        }
        const u = await checkSignedUpdate(version || undefined);
        if (!u) return;
        const stored = localStorage.getItem('zenith_lang');
        const tr = translations[stored === 'pl' ? 'pl' : 'en'];
        setUpdateStatus({ kind: 'newer', tag: u.version, installable: true });
        pushToast(
          tr.updateAvailableTag.replace('{tag}', u.version),
          'success',
          20000,
          {
            label: tr.updateNow,
            labelKey: 'updateNow',
            onClick: () => void installAppUpdateRef.current(),
          },
          { key: 'updateAvailableTag', vars: { tag: u.version } }
        );
      })();
    }, 20000);
    return () => window.clearTimeout(id);
  }, []);

  const [pluginStates, setPluginStates] = useState<Record<string, boolean>>(() =>
    pluginManager.getStates()
  );
  const [roomSyncTick, setRoomSyncTick] = useState(0);
  const togglePlugin = useCallback((id: string) => {
    pluginManager.setEnabled(id, !pluginManager.isEnabled(id));
    setPluginStates(pluginManager.getStates());
  }, []);

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
  const crossfadeEnabledRef = useLatest(crossfadeEnabled);
  const crossfadeSecsRef = useLatest(crossfadeSecs);
  const volumeRef = useLatest(volume);
  const isPlayingRef = useLatest(isPlaying);
  const durationRef = useLatest(duration);
  const libAuthedRef = useLatest(libAuthed);
  const activeTabRef = useLatest<ViewTab>(activeTab);
  const panelTabRef = useLatest<'upnext' | 'related'>(panelTab);
  const currentTrackIdRef = useLatest<string | null>(currentTrack?.id ?? null);
  const loopModeRef = useLatest<LoopMode>(loopMode);
  const [speedRate] = useState(() => getPlaybackSpeed(pluginManager.isEnabled('playback-speed')));

  const [discordClientId, setDiscordClientId] = useState(
    () => localStorage.getItem('zenith_discord_client_id') || ''
  );
  const saveDiscordClientId = useCallback((value: string) => {
    setDiscordClientId(value);
    try {
      if (value.trim()) localStorage.setItem('zenith_discord_client_id', value.trim());
      else localStorage.removeItem('zenith_discord_client_id');
    } catch (err) {
      console.debug('App', err);
    }
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
            via: res?.via || '',
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
  const prefetchPausedUntilRef = useRef(0);
  const prefetchPendingRef = useRef<Track[]>([]);
  const foregroundResolvingRef = useRef(false);
  const prefetchStream = useCallback(
    (track: Track | undefined) => {
      if (!track) return;
      const now = Date.now();
      if (now < prefetchPausedUntilRef.current) return;
      const cached = streamCacheRef.current.get(track.id);
      if (cached && now - cached.ts < STREAM_CACHE_TTL) return;
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
        .catch((err) => console.debug('App', err))
        .finally(() => {
          prefetchInflightRef.current = Math.max(0, prefetchInflightRef.current - 1);
          const next = prefetchPendingRef.current.shift();
          if (next) prefetchStreamRef.current?.(next);
        });
    },
    [lang]
  );
  const prefetchStreamRef = useLatest<((t: Track | undefined) => void) | null>(prefetchStream);

  if (!audioRef.current) {
    audioRef.current = createAudio();
    audioRef.current.volume = volume;
  }
  const audio = audioRef.current;
  const queueRef = useLatest<Track[]>(queue);
  const queueIndexRef = useLatest(queueIndex);
  const playingFromRef = useLatest<string | null>(playingFrom);

  const isSaved = currentTrack ? likedIdSet.has(currentTrack.id) || trackRating === 'LIKE' : false;

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

  const changeLanguage = useCallback(
    (newLang: Language) => {
      if (newLang === lang) return;
      try {
        localStorage.setItem('zenith_lang', newLang);
      } catch (err) {
        console.debug('App', err);
      }
      setLang(newLang);
      clearHomeBrowseCache();
      const dataSeq = ++feedSeqRef.current.home;
      setFeedTabLoading('home', true);
      setHomeSections([]);
      setQuickPicks([]);
      getHomeFeed(newLang)
        .then(({ sections: nextHome, quickPicks: picks }) => {
          if (dataSeq !== feedSeqRef.current.home) return;
          setHomeSections(stableOrderSections(nextHome));
          setQuickPicks(picks);
        })
        .catch((err) => console.debug('App', err))
        .finally(() => {
          if (dataSeq === feedSeqRef.current.home) setFeedTabLoading('home', false);
        });
      const exploreSeq = ++feedSeqRef.current.explore;
      getExplore(newLang)
        .then((data) => {
          if (exploreSeq !== feedSeqRef.current.explore) return;
          setExploreSections(stableOrderSections(data));
        })
        .catch((err) => console.debug('App', err));
    },
    [lang, setFeedTabLoading]
  );

  useEffect(() => {
    document.documentElement.lang = lang;
    const tt = translations[lang];
    invoke('set_tray_labels', {
      play: tt.trayPlayPause,
      next: tt.trayNext,
      show: tt.trayShow,
      quit: tt.trayQuit,
    }).catch((err) => console.debug('App', err));
  }, [lang]);

  const debouncedSearch = useDebounce(searchQuery, 400);

  const handleSearch = useCallback(
    (rawQuery: string, language: Language = lang) => {
      const query = rawQuery.trim().slice(0, MAX_SEARCH_LENGTH).trim();
      if (!query) return;
      const dataSeq = ++feedSeqRef.current.search;
      setFeedTabLoading('search', true);
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
    (language: Language = lang, navigate = true) => {
      const dataSeq = ++feedSeqRef.current.home;
      setFeedTabLoading('home', true);
      if (navigate) {
        navigateTo('home');
        setSearchQuery('');
        setActiveMood(null);
        setBrowseEmptyKind(null);
        clearHomeBrowseCache();
      }
      const safety = window.setTimeout(() => setFeedTabLoading('home', false), 8000);
      getHomeFeed(language)
        .then(({ sections: nextHome, quickPicks: picks }) => {
          if (dataSeq !== feedSeqRef.current.home) return;
          const normalizedHome = stableOrderSections(nextHome);
          setHomeSections(normalizedHome);
          setQuickPicks(picks);
          try {
            const allTracks = [
              ...picks,
              ...normalizedHome.flatMap((s) => s.items).filter((i) => i.type === 'track'),
            ];
            startBackgroundPrefetch(allTracks);
            allTracks.slice(0, 3).forEach((t) => prefetchStream(t));
          } catch (err) {
            console.debug('App', err);
          }
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

  const lastCollectionRef = useRef<Track | null>(null);
  const openCollectionPage = useCallback(
    async (collection: Track) => {
      const dataSeq = ++feedSeqRef.current.mood;
      lastCollectionRef.current = collection;
      const plain = toPlainPlaylistId(collection.id);
      const emptyKind = plain === 'SE' ? 'episodes' : 'collection';
      setFeedTabLoading('mood', true);
      setSearchQuery('');
      setActiveMood(browseMoodId(collection.id));
      setBrowseTitle(collection.title);
      setBrowseEmptyKind(null);
      setSections([]);
      navigateTo('mood');
      const safety = window.setTimeout(() => setFeedTabLoading('mood', false), 45000);
      try {
        const res = await loadPlaylistItems(collection.id, lang, (items) => {
          if (dataSeq !== feedSeqRef.current.mood) return;
          setSections([{ title: collection.title, items }]);
          setFeedTabLoading('mood', false);
        });
        if (dataSeq !== feedSeqRef.current.mood) return;
        if (res.items.length) {
          setBrowseEmptyKind(null);
          setSections([{ title: collection.title, items: res.items }]);
          return;
        }
        setSections([]);
        setBrowseEmptyKind(res.status === 'failed' ? null : emptyKind);
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
    const seq = ++feedSeqRef.current.mood;
    navigateTo('mood');
    setSearchQuery('');
    setBrowseTitle(t.favs);
    setBrowseEmptyKind(null);
    setActiveMood(FAVORITES_ID);
    if (savedTracks.length === 0) setFeedTabLoading('mood', true);
    else setFeedTabLoading('mood', false);
    void (async () => {
      let remote: Track[] = [];
      try {
        if (await isLoggedIn()) {
          const playlist = await loadPlaylistItems('VLLM', lang);
          remote = playlist.items.filter((item) => item.type === 'track');
          if (!remote.length) {
            const songs = await getLibrary('songs', lang);
            remote = songs
              .flatMap((section) => section.items)
              .filter((item) => item.type === 'track');
          }
        }
      } catch {
        remote = [];
      }
      if (seq !== feedSeqRef.current.mood) return;
      setAccountLikes(remote);
      setFeedTabLoading('mood', false);
    })();
  }, [navigateTo, savedTracks.length, setFeedTabLoading, t.favs, lang]);

  const openMoodById = useCallback(
    (categoryId: string) => {
      const browseId = moodBrowseIdFor(categoryId) ?? moodBrowseIdFor('focus');
      if (browseId) loadMood(categoryId, browseId);
    },
    [loadMood]
  );

  const leavePlayer = useCallback(() => {
    const dest = prevTab === 'player' ? 'home' : prevTab;
    if (dest === 'home' && homeSections.length === 0 && quickPicks.length === 0) {
      if (feedLoading.home) {
        navigateTo('home');
        return;
      }
      loadHome();
      return;
    }
    if (dest === 'explore' && exploreSections.length === 0) {
      if (feedLoading.explore) {
        navigateTo('explore');
        return;
      }
      loadExplore();
      return;
    }
    navigateTo(dest);
  }, [
    prevTab,
    homeSections.length,
    quickPicks.length,
    exploreSections.length,
    feedLoading.home,
    feedLoading.explore,
    loadHome,
    loadExplore,
    navigateTo,
  ]);

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
      setLibError(null);
      const cached = peekLibraryCache(category, lang);
      if (cached?.length) {
        setLibSections(cached);
        setLibLoading(false);
      } else {
        setLibLoading(true);
      }
      const safety = window.setTimeout(() => setLibLoading(false), 8000);
      try {
        if (!(await isLoggedIn())) {
          clearAuthCache();
          if (!(await isLoggedIn())) {
            if (reqId !== libReqIdRef.current) return;
            setLibAuthed(false);
            setLibSections([]);
            return;
          }
        }
        if (reqId !== libReqIdRef.current) return;
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
        prefetchLibrary(lang, category);
        void extendLibrarySections(category, lang, sections).then((more) => {
          if (reqId !== libReqIdRef.current) return;
          if (more !== sections) setLibSections(more);
        });
      } catch (e) {
        console.warn('[library] load failed', e);
        if (reqId === libReqIdRef.current && !cached?.length) {
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
  }, [activeTab, libAuthed, authBootstrapping, libCategory]);

  const authBootRanRef = useRef(false);
  useEffect(() => {
    if (authBootRanRef.current) return;
    authBootRanRef.current = true;
    (async () => {
      try {
        let restored = false;
        const lateLogin = () =>
          window.setTimeout(async () => {
            if (!(await waitForLogin(lang, 6, 1500))) return;
            setIsOffline(false);
            setSessionExpired(false);
            setLibAuthed(true);
            void loadUserPlaylists();
            void refreshAccountProfile();
          }, 1500);
        if (getRememberLogin()) {
          try {
            restored = await invoke<boolean>('restore_ytm_session');
            clearAuthCache();
          } catch (e) {
            console.warn('[auth] restore session failed', e);
          }
        } else {
          try {
            await invoke('clear_ytm_session_store');
          } catch (err) {
            console.debug('App', err);
          }
          clearAuthCache();
        }
        if (!(await isLoggedIn())) {
          setLibAuthed(false);
          if (restored) lateLogin();
        } else {
          const ok = await resolveLoginState(lang);
          if (!ok && lastSessionCheckWasNetworkError()) {
            setIsOffline(true);
            setLibAuthed(false);
            lateLogin();
          } else if (!ok && lastSessionCheckWasInconclusive()) {
            setLibAuthed(false);
            lateLogin();
          } else if (ok) {
            setIsOffline(false);
            setSessionExpired(false);
            setLibAuthed(true);
            void loadUserPlaylists();
            void refreshAccountProfile();
            void persistSessionIfWanted();
          } else {
            setLibAuthed(false);
            setUserPlaylists([]);
            setLibAccount(null);
            setSessionExpired(true);
            pushToast(translations[lang].sessionExpired, 'error');
          }
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

  const completeLogin = useCallback(async () => {
    if (loginFinishingRef.current) return;
    loginFinishingRef.current = true;
    try {
      clearAuthCache();
      clearHomeBrowseCache();
      let captured = false;
      try {
        captured = await invoke<boolean>('capture_ytm_login_session');
      } catch (err) {
        console.debug('App', err);
      }
      if (!captured) {
        try {
          captured = await invoke<boolean>('sync_ytm_auth_to_main');
        } catch (err) {
          console.debug('App', err);
        }
      }
      if (!captured) {
        clearAuthCache();
        if (!(await isLoggedIn())) return;
      }
      clearAuthCache();
      let authed = await waitForLogin(lang, 8, 500);
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
      } catch (err) {
        console.debug('App', err);
      }
      loginClosingRef.current = true;
      try {
        await invoke('close_google_login');
      } catch (err) {
        console.debug('App', err);
      }
      window.setTimeout(() => {
        loginClosingRef.current = false;
      }, 800);

      setLibAuthed(true);
      setSessionExpired(false);
      pushToast(translations[lang].loginSuccess, 'success');
      loadHome(lang);
      setLibCategory('landing');
      void loadLibrary('landing');
      void loadUserPlaylists();
      void refreshAccountProfile();
      try {
        await appWindow.setFocus();
      } catch (err) {
        console.debug('App', err);
      }
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
    } catch (err) {
      console.debug('App', err);
    }
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
    setAccountLikes([]);
    setLibSections([]);
    setLibAccount(null);
    setLibError(null);
    setLibAuthed(false);
    setSessionExpired(false);
    setLibCategory('landing');
    setFeedLoading(FEED_LOADING_INITIAL);
    setLibLoading(false);
    setIsSettingsOpen(false);
    pushToast(translations[lang].loggedOut, 'info');

    void (async () => {
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

  const changeLibCategory = useCallback(
    (category: LibraryCategory) => {
      const plan = nextLibraryViewState(libCategory, category);
      if (!plan.clear) return;
      setLibSections([]);
      setLibLoading(true);
      setLibCategory(plan.category);
    },
    [libCategory]
  );

  const handleLogin = useCallback(async () => {
    clearAuthCache();
    const valid = await resolveLoginState(lang);
    if (!valid && lastSessionCheckWasNetworkError()) {
      setIsOffline(true);
      return;
    }
    setIsOffline(false);
    setLibAuthed(valid);
    if (valid) {
      setSessionExpired(false);
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
            if (captured)
              finalizeLoginFromPopup().catch((err) =>
                console.debug('App attachLoginWindowHandlers', err)
              );
          })
          .catch((err) => console.debug('App attachLoginWindowHandlers', err));
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
        .catch((err) => console.debug('App attachLoginWindowHandlers', err));
    };

    try {
      const existing = await WebviewWindow.getByLabel('google-login');
      if (existing) {
        await existing.show();
        await existing.setFocus();
        attachLoginWindowHandlers();
        return;
      }
    } catch (err) {
      console.debug('App', err);
    }
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
    } catch (err) {
      console.debug('App', err);
    }
  }, [stopLoginPoll]);

  const refreshAuth = useCallback(() => {
    void (async () => {
      clearAuthCache();
      clearHomeBrowseCache();
      invalidateLibraryCache();
      const ok = await resolveLoginState(lang, true);
      if (ok) {
        setIsOffline(false);
        setSessionExpired(false);
        setLibAuthed(true);
        void loadLibrary();
        void loadUserPlaylists();
        void refreshAccountProfile();
        loadHome(lang);
        return;
      }
      if (lastSessionCheckWasNetworkError()) {
        setIsOffline(true);
        return;
      }
      if (lastSessionCheckWasInconclusive()) {
        return;
      }
      setLibAuthed(false);
      setUserPlaylists([]);
      setLibAccount(null);
      setLibSections([]);
      setSessionExpired(true);
      pushToast(translations[lang].sessionExpired, 'error');
    })();
  }, [lang, loadLibrary, loadHome, loadUserPlaylists, refreshAccountProfile]);

  useEffect(() => () => stopLoginPoll(), [stopLoginPoll]);

  useEffect(() => {
    if (!loginBusy || loginDoneRef.current) return;
    let disposed = false;
    const tick = async () => {
      if (disposed || loginFinishingRef.current || loginDoneRef.current) return;
      try {
        const captured = await invoke<boolean>('capture_ytm_login_session');
        if (captured) await finalizeLoginFromPopup();
      } catch (err) {
        console.debug('App tick', err);
      }
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
      finalizeLoginFromPopup().catch((err) => console.debug('App onCookiesSynced', err));
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
    const title = committedPlaylistTitle(npTitle, npTitleRef.current?.value);
    const desc = committedPlaylistDescription(npDesc, npDescRef.current?.value);
    if (!title || npBusy) return;
    if (title !== npTitle) setNpTitle(title);
    setNpBusy(true);
    setNpError(false);
    try {
      const id = await createPlaylist(title, desc, npPrivacy, lang);
      if (!id) throw new Error('no playlist id');
      setNpOpen(false);
      setNpTitle('');
      setNpDesc('');
      setNpPrivacy('PRIVATE');
      setLibCategory('playlists');
      loadLibrary('playlists');
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        setLibAuthed(false);
        setUserPlaylists([]);
        setLibAccount(null);
        setLibSections([]);
        setSessionExpired(true);
        setNpOpen(false);
        pushToast(translations[lang].sessionExpired, 'error');
      }
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
      getLyrics(lyricsTrack, lang, provider, (plain) => {
        if (reqId !== lyricsReqIdRef.current) return;
        setLyrics(plain);
        setLyricsLoading(false);
      })
        .then((data) => {
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

  const showStreamStuck = async (L: Language) => {
    let kind: string | null = null;
    try {
      kind = await invoke<string | null>('stream_last_failure');
    } catch (err) {
      console.debug('App showStreamStuck', err);
    }
    const msg = streamStuckMessage(translations[L], kind, libAuthedRef.current);
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
  const resolveStreamUrlRef = useLatest(async (id: string) => {
    const c = streamCacheRef.current.get(id);
    if (c && Date.now() - c.ts < STREAM_CACHE_TTL) return c.url;
    return resolveStreamUrl(id);
  });

  const loadTrack = useCallback(
    async (track: Track, autoPlay = true, fadeSeconds?: number, startAt = 0) => {
      const gen = ++loadGenRef.current;
      const switchingTrack = currentTrackIdRef.current !== track.id;
      currentTrackIdRef.current = track.id;
      setCurrentTrack(track);
      setBuffering(true);
      const stale = () => gen !== loadGenRef.current;
      const scheduleOutputCheck = (g: number) => {
        window.setTimeout(() => {
          if (g !== loadGenRef.current || !isPlayingRef.current) return;
          audio.ensureOutput(true);
        }, 1200);
      };

      trackSwitchingRef.current = true;
      if (switchingTrack) {
        if (lyricsProviderRef.current !== 'Auto') {
          lyricsProviderRef.current = 'Auto';
          setLyricsProvider('Auto');
        }
      }
      if (switchingTrack) {
        audioDurationTrackIdRef.current = null;
        const knownDuration = knownDurationSec(track);
        durationRef.current = knownDuration;
        setDuration(knownDuration);
        progressRef.current = startAt > 0 ? startAt : 0;
      }
      if (lastHydrateKeyRef.current.split('|')[0] !== track.id) hydratePanels(track);
      const knownDuration = knownDurationSec(track, switchingTrack ? 0 : durationRef.current);
      const paintKnown = (pos: number) => {
        const d = knownDurationSec(track, switchingTrack ? 0 : durationRef.current);
        durationRef.current = d;
        setDuration(d);
        paintProgressUiRef.current(pos, d);
      };
      if (switchingTrack || startAt > 0 || knownDuration > 0) {
        progressRef.current = startAt > 0 ? startAt : switchingTrack ? 0 : progressRef.current;
        paintKnown(progressRef.current);
      }
      try {
        await loadTrackInner();
      } finally {
        if (!stale()) {
          trackSwitchingRef.current = false;
          syncDurationFromAudioRef.current();
        }
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
          paintKnown(progressRef.current);
        }

        try {
          foregroundResolvingRef.current = true;
          let streamUrl: string | null;
          try {
            streamUrl = await resolveStreamUrl(track.id);
          } finally {
            foregroundResolvingRef.current = false;
            window.setTimeout(() => {
              for (let k = 0; k < 3; k++) {
                const next = prefetchPendingRef.current.shift();
                if (!next) break;
                prefetchStreamRef.current?.(next);
              }
            }, 0);
          }
          if (stale()) return;
          if (!streamUrl) {
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
            audio.abortAll();
            audioDurationTrackIdRef.current = null;
            setIsPlaying(false);
            setBuffering(false);
            skipOnFail();
            return;
          }
          if (wantFade) {
            try {
              await audio.crossfadeTo(streamUrl, fadeDur);
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
              if (stale()) return;
              audio.abortAll();
              progressRef.current = 0;
              paintKnown(0);
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
              if (stale()) return;
              setIsPlaying(true);
              scheduleOutputCheck(gen);
              streamFailStreakRef.current = 0;
              streamErrorRetryRef.current = null;
              autoFadePendingRef.current = false;
              setBuffering(false);
              return;
            } catch (e) {
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
                  } catch (err) {
                    console.debug('App loadTrackInner', err);
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
        autoFadePendingRef.current = false;
        autoFadeTrackRef.current = currentTrackIdRef.current;
        forceBlendRef.current = false;
      }
      if (recordHistory) {
        playHistoryRef.current = pushPlayHistory(playHistoryRef.current, currentTrackIdRef.current);
      }
      queueIndexRef.current = index;
      setQueueIndex(index);
      await loadTrack(nextTrack, true, manualFade);
    },
    [loadTrack, crossfadeEnabled]
  );
  const playByIndexRef =
    useLatest<(index: number, fadeSeconds?: number) => Promise<void>>(playByIndex);

  const collectionReqRef = useRef(0);
  const handleCollectionClick = useCallback(
    async (collection: Track) => {
      if (toPlainPlaylistId(collection.id) === 'SE') {
        await openCollectionPage(collection);
        return;
      }

      const req = ++collectionReqRef.current;
      const L = translations[lang];
      const slowHint = window.setTimeout(() => {
        if (req === collectionReqRef.current) {
          pushToast(L.openingPlaylist.replace('{name}', collection.title), 'info', 2000);
        }
      }, 700);
      try {
        openPlayer();
        setPlayingFrom(collection.title);
        const res = await loadPlaylistItems(collection.id, lang);
        if (req !== collectionReqRef.current) return;
        const items = res.items;
        if (!items.length) {
          await openCollectionPage(collection);
          return;
        }

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

  const radioForRef = useRef<string | null>(null);
  const tailRef = useRef<{ id: string; end: number | null } | null>(null);
  const radioLangRef = useLatest(lang);
  const radioBusyRef = useRef<Promise<number> | null>(null);
  const extendQueueWithRadio = useCallback((): Promise<number> => {
    if (radioBusyRef.current) return radioBusyRef.current;
    const job = (async () => {
      const q = queueRef.current;
      const cur = q[queueIndexRef.current] ?? q[q.length - 1];
      if (!cur) return 0;
      const have = new Set(q.map((t) => t.id));
      const fresh = (list: Track[]) => list.filter((t) => t.type === 'track' && !have.has(t.id));
      let more: Track[] = [];
      try {
        more = fresh(await getRadioTracks(cur.id, radioLangRef.current));
      } catch (err) {
        console.debug('App radio', err);
      }
      if (more.length === 0) {
        try {
          const who = (cur.artist || '').split(' • ')[0];
          more = fresh(
            await getRelatedTracks(`${cur.title} ${who}`.trim(), radioLangRef.current, cur.id)
          );
        } catch (err) {
          console.debug('App related', err);
        }
      }
      if (more.length === 0) return 0;
      const latest = queueRef.current;
      const next = [
        ...latest,
        ...more.slice(0, 25).filter((t) => !latest.some((x) => x.id === t.id)),
      ];
      queueRef.current = next;
      setQueue(next);
      return next.length - latest.length;
    })();
    radioBusyRef.current = job;
    void job.finally(() => {
      radioBusyRef.current = null;
    });
    return job;
  }, []);

  const playNext = useCallback(() => {
    const idx = queueIndexRef.current;
    const q = queueRef.current;
    if (idx < q.length - 1) playByIndex(idx + 1);
    else if (loopMode === 'all' && q.length > 0) playByIndex(0);
    else if (q.length > 0) {
      const at = q.length;
      void extendQueueWithRadio().then((added) => {
        if (added > 0 && queueIndexRef.current === idx) void playByIndexRef.current(at);
      });
    }
  }, [playByIndex, loopMode, extendQueueWithRadio]);

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

  const ratingReqRef = useRef(0);
  useEffect(() => {
    const id = currentTrack?.id;
    const req = ++ratingReqRef.current;
    setTrackRatingState(id && likedIdSetRef.current.has(id) ? 'LIKE' : 'INDIFFERENT');
    if (!id || !libAuthed || !/^[\w-]{11}$/.test(id)) return;
    getTrackLikeStatus(id, lang)
      .then((st) => {
        if (st && req === ratingReqRef.current) setTrackRatingState(st);
      })
      .catch((e) => console.debug('[like] status lookup failed', e));
  }, [currentTrack?.id, libAuthed]);

  useEffect(() => {
    const id = currentTrack?.id;
    if (id && likedIdSet.has(id)) setTrackRatingState((r) => (r === 'DISLIKE' ? r : 'LIKE'));
  }, [likedIdSet, currentTrack?.id]);

  const applyTrackRating = useCallback(
    (next: TrackLikeStatus) => {
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
      const wasSaved = savedTracks.some((x) => x.id === track.id);
      ratingReqRef.current += 1;
      setTrackRatingState(next);
      if (next !== 'LIKE') {
        setAccountLikes((prev) =>
          prev.some((x) => x.id === track.id) ? prev.filter((x) => x.id !== track.id) : prev
        );
      }
      if (next === 'LIKE' && !wasSaved) {
        pushToast(t.addedToFavs, 'success', 1800);
        setSavedTracks((prev) => [track, ...prev]);
      } else if (next !== 'LIKE' && wasSaved) {
        pushToast(t.removedFromFavs, 'success', 1800);
        setSavedTracks((prev) => prev.filter((x) => x.id !== track.id));
      }
      if (libAuthed && /^[\w-]{11}$/.test(track.id)) {
        setTrackRating(track.id, next, lang).catch((e) => {
          console.warn('[like] sync failed', e);
          pushToast(
            translations[lang][next === 'DISLIKE' ? 'dislikeSyncFailed' : 'likeSyncFailed'],
            'error'
          );
        });
      }
    },
    [currentTrack, savedTracks, t, libAuthed, lang]
  );

  const toggleSave = useCallback(() => {
    const liked = trackRating === 'LIKE' || savedTracks.some((x) => x.id === currentTrack?.id);
    applyTrackRating(liked ? 'INDIFFERENT' : 'LIKE');
  }, [applyTrackRating, savedTracks, currentTrack, trackRating]);

  const toggleLike = useCallback(() => {
    applyTrackRating(nextLikeStatus(trackRating, 'like'));
  }, [applyTrackRating, trackRating]);

  const toggleDislike = useCallback(() => {
    applyTrackRating(nextLikeStatus(trackRating, 'dislike'));
  }, [applyTrackRating, trackRating]);

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
  const addCurrentToPlaylistRef = useLatest(addCurrentToPlaylist);

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
        if (isViewingPlaylist(activeTab, activeMood, plEdit.pl.id)) {
          ++feedSeqRef.current.mood;
          setSections([]);
          setBrowseTitle(null);
          setBrowseEmptyKind(null);
          setActiveMood(null);
          navigateTo('library');
        }
        pushToast(translations[lang].playlistDeleted, 'success');
      }
      setPlEdit(null);
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
    activeMood,
    libCategory,
    navigateTo,
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
    } else {
      durationTimeElRef.current?.replaceChildren(
        document.createTextNode(d > 0 ? formatTime(d) : '0:00')
      );
    }
  }, []);
  const paintProgressUiRef = useLatest<(t: number, d?: number) => void>(paintProgressUi);

  const getLyricProgress = useCallback(
    () =>
      (audioRef.current?.currentTime ?? progressRef.current) + lyricsSyncOffsetRef.current / 1000,
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
        }).catch((err) => console.debug('App', err));
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

  const volumeBlockRef = useRef<HTMLDivElement | null>(null);
  const volumeNowRef = useLatest(isMuted ? 0 : volume);
  const setVolumeToRef = useLatest(setVolumeTo);
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

  const coverWheelHandler = useLatest((e: WheelEvent) => {
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
    coverVolHintTimer.current = window.setTimeout(() => setCoverVolHint(null), 900);
  });
  const hasTrack = Boolean(currentTrack);
  useEffect(() => {
    const el = coverWheelRef.current;
    if (!el) return;
    // React podpina onWheel jako pasywny, więc tylko natywny listener powstrzyma przewijanie widoku
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      coverWheelHandler.current(e);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [activeTab, hasTrack]);

  useEffect(() => {
    let lastUiAt = 0;
    const syncDurationFromAudio = () => {
      const id = currentTrackIdRef.current;
      if (!id || trackSwitchingRef.current || !audio.hasSource) return;
      const ad = audio.duration;
      if (!Number.isFinite(ad) || ad <= 0) return;
      audioDurationTrackIdRef.current = id;
      const d = barDurationForTrack(durationRef.current, ad, true);
      if (d > 0 && Math.abs(d - durationRef.current) > 0.25) {
        durationRef.current = d;
        setDuration(d);
        paintProgressUi(progressRef.current, d);
      } else if (d > 0) {
        durationRef.current = d;
      }
    };
    syncDurationFromAudioRef.current = syncDurationFromAudio;
    const onTimeUpdate = () => {
      if (trackSwitchingRef.current) return;
      const t = audio.currentTime;
      if (audioDurationTrackIdRef.current !== currentTrackIdRef.current) syncDurationFromAudio();
      const trusted = audioDurationTrackIdRef.current === currentTrackIdRef.current;
      const d = barDurationForTrack(durationRef.current, audio.duration, trusted);
      progressRef.current = t;
      if (d > 0) durationRef.current = d;

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

      if (overlayPluginsOnRef.current && (lineChanged || document.hidden)) {
        const lyr = lyricsRef.current;
        const m = overlayMetaRef.current;
        void pushLyricsOverlay(
          {
            title: m.title,
            artist: m.artist,
            coverUrl: m.coverUrl,
            trackId: m.trackId,
            progress: t,
            rate: audio.playbackRate,
            activeLyricIndex: lyricIdx,
            isPlaying: isPlayingRef.current,
            synced: lyr?.synced,
            text: lyr?.text,
          },
          { secondScreen: secondScreenLyricsRef.current }
        );
      }

      const nearId = currentTrackIdRef.current;
      if (nearId && d > 0 && isPlayingRef.current && loopModeRef.current !== 'one') {
        const left = d - t;
        const cfsNow = crossfadeSecsRef.current;
        if (
          left <= cfsNow + 30 &&
          radioForRef.current !== nearId &&
          loopModeRef.current !== 'all' &&
          queueIndexRef.current >= queueRef.current.length - 1
        ) {
          radioForRef.current = nearId;
          void extendQueueWithRadio();
        }
        if (crossfadeEnabledRef.current && left <= cfsNow + 25 && tailRef.current?.id !== nearId) {
          tailRef.current = { id: nearId, end: null };
          const src = audio.src;
          if (src) {
            void invoke<number | null>('zaudio_tail', { url: src, d })
              .then((end) => {
                if (tailRef.current?.id === nearId) tailRef.current = { id: nearId, end };
              })
              .catch((err) => console.debug('App tail', err));
          }
        }
      }

      if (
        (crossfadeEnabledRef.current || playingAlbumRef.current) &&
        !audio.isCrossfading &&
        loopModeRef.current !== 'one' &&
        d > 0 &&
        isPlayingRef.current
      ) {
        const cfs = crossfadeSecsRef.current;
        const q = queueRef.current;
        const qi = queueIndexRef.current;
        const trackId = currentTrackIdRef.current;
        const gapless = playingAlbumRef.current && getGaplessAlbums();
        const tail = tailRef.current;
        const end =
          !gapless && tail && tail.id === trackId && tail.end && tail.end > 0
            ? Math.min(d, tail.end)
            : d;
        const remaining = end - t;
        const plan = planAutoTransition({
          crossfadeOn: crossfadeEnabledRef.current,
          crossfadeSecs: cfs,
          album: playingAlbumRef.current,
          gapless,
          remaining,
        });
        if (
          (gapless || crossfadeEnabledRef.current) &&
          trackId &&
          prerollForRef.current !== trackId &&
          remaining <= (gapless ? GAPLESS_PREROLL_SECS : cfs + 8) &&
          remaining > (gapless ? GAPLESS_LEAD_SECS : cfs)
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
              .catch((err) => console.debug('App onTimeUpdate', err));
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
          }).catch((err) => console.debug('App onTimeUpdate', err));
        }
      }

      const now = performance.now();
      if (now - lastUiAt < UI_PROGRESS_MS) return;
      lastUiAt = now;
      paintProgressUi(t, d);
      if (d > 0 && Math.abs(d - duration) > 0.25) {
        setDuration(d);
        const idx = queueIndexRef.current;
        const cur = queueRef.current[idx];
        if (
          cur &&
          cur.id === currentTrackIdRef.current &&
          Math.abs((cur.durationSec || 0) - d) > 0.5
        ) {
          const next = queueRef.current.slice();
          next[idx] = { ...cur, durationSec: d };
          queueRef.current = next;
          setQueue(next);
        }
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
      else if (queue.length > 0) {
        const at = queueRef.current.length;
        const idx = queueIndexRef.current;
        void extendQueueWithRadio().then((added) => {
          if (added > 0 && queueIndexRef.current === idx) void playByIndexRef.current(at);
          else if (added === 0) setIsPlaying(false);
        });
      } else setIsPlaying(false);
    };
    const onPlay = () => setIsPlaying(true);
    let startTicker = 0;
    const onPlaying = () => {
      setIsPlaying(true);
      setBuffering(false);
      window.clearInterval(startTicker);
      const until = performance.now() + 1000;
      const tick = () => {
        if (performance.now() > until) window.clearInterval(startTicker);
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
    const onDurationReady = () => {
      if (trackSwitchingRef.current) return;
      syncDurationFromAudio();
    };
    const onError = () => {
      if (!audio.hasSource) return;
      const id = currentTrackIdRef.current;
      const resumeAt = progressRef.current;
      const skipAhead = () => {
        setIsPlaying(false);
        setBuffering(false);
        const qi = queueIndexRef.current;
        const q = queueRef.current;
        prefetchPausedUntilRef.current = Date.now() + PREFETCH_PAUSE_AFTER_FAIL_MS;
        streamFailStreakRef.current += 1;
        if (streamFailStreakRef.current >= 3) {
          const L = (localStorage.getItem('zenith_lang') as Language) || 'en';
          void showStreamStuck(L);
          return;
        }
        if (qi < q.length - 1) {
          window.setTimeout(() => {
            if (currentTrackIdRef.current !== id) return;
            void playByIndexRef.current(qi + 1);
          }, 1200 * streamFailStreakRef.current);
        }
      };
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
    audio.addEventListener('loadedmetadata', onDurationReady);
    audio.addEventListener('durationchange', onDurationReady);
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
      audio.removeEventListener('loadedmetadata', onDurationReady);
      audio.removeEventListener('durationchange', onDurationReady);
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
    extendQueueWithRadio,
  ]);

  useEffect(() => {
    try {
      const body = JSON.stringify(savedTracks.slice(0, 500));
      localStorage.setItem('zenith_saved_tracks', body);
      localStorage.removeItem('zenith_saved');
      persistFavorites(body);
    } catch (err) {
      console.debug('App', err);
    }
  }, [savedTracks]);

  useEffect(() => {
    if (activeTab !== 'mood' || activeMood !== FAVORITES_ID) return;
    const items = mergeFavoriteTracks(savedTracks, accountLikes);
    setSections(items.length ? [{ title: t.favs, items }] : []);
  }, [activeTab, activeMood, savedTracks, accountLikes, t.favs]);

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
  const loadTrackRef = useLatest(loadTrack);
  const hydratePanelsRef = useLatest(hydratePanels);
  const loadHomeRef = useLatest(loadHome);
  const openPlayerRef = useLatest(openPlayer);
  const adoptEngineRef = useLatest<() => boolean>(() => {
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
      const d = (snap.d && snap.d > 0 ? snap.d : track.durationSec) || 0;
      progressRef.current = snap.t;
      durationRef.current = d;
      setDuration(d);
      setIsPlaying(!snap.paused);
      isPlayingRef.current = !snap.paused;
      setBuffering(false);
      paintProgressUiRef.current(snap.t, d);
      let tab: string | null = null;
      try {
        tab = localStorage.getItem('zenith_ui_tab');
      } catch (err) {
        console.debug('App', err);
      }
      const bootLang = (localStorage.getItem('zenith_lang') as Language) || 'en';
      if (tab === 'player' || !isRestoredUi()) {
        openPlayerRef.current();
        loadHomeRef.current(bootLang, false);
      } else loadHomeRef.current();
      plan.queue.slice(idx + 1, idx + 3).forEach((t) => prefetchStream(t));
      return true;
    }
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
  });

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
      }).catch((err) => console.debug('App', err));
    }, 150);
    return () => window.clearTimeout(handle);
  }, [queue, queueIndex, loopMode, crossfadeEnabled, crossfadeSecs, playingFrom, pluginStates]);

  const pluginsBootstrappedRef = useRef(false);

  useEffect(() => {
    if (pluginsBootstrappedRef.current) return;
    pluginsBootstrappedRef.current = true;

    void syncCloseToTray(pluginManager.isEnabled('system-tray'));
    void syncGlobalHotkeys(pluginManager.isEnabled('global-hotkeys'));
    void pushHotkeyBindings();

    const pluginTimer = window.setTimeout(() => {
      for (const p of pluginManager.plugins) {
        if (AUX_WINDOW_PLUGINS[p.id]) continue;
        if (p.id === 'system-tray' || p.id === 'global-hotkeys') continue;
        if (pluginManager.isEnabled(p.id)) {
          try {
            const r: unknown = p.onEnable?.();
            if (r instanceof Promise) r.catch((e) => console.warn(`[plugins] ${p.id}`, e));
          } catch (err) {
            console.debug('App', err);
          }
        }
      }
    }, 900);

    const bootstrap = async () => {
      void (async () => {
        try {
          const cached = await invoke<{ clientVersion?: string; apiKey?: string }>(
            'get_innertube_config'
          );
          applyInnertubeConfig(cached);
        } catch (err) {
          console.debug('App bootstrap', err);
        }
        try {
          const report = await invoke<{
            innertubeVersion?: string;
            innertubeKey?: string;
            playerVersion?: string;
          }>('refresh_playback_deps');
          applyInnertubeConfig(report);
        } catch (err) {
          console.debug('App bootstrap', err);
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
            const restoredDur = knownDurationSec(track);
            if (restoredDur > 0) {
              durationRef.current = restoredDur;
              setDuration(restoredDur);
            }
            progressRef.current = saved.progress || 0;
            openPlayerRef.current();
            loadHomeRef.current((localStorage.getItem('zenith_lang') as Language) || 'en', false);
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
        const idx = queueIndexRef.current;
        let queue = queueRef.current;
        const cur = queue[idx];
        const d = knownDurationSec(cur, durationRef.current);
        if (d > 0 && cur && Math.abs((cur.durationSec || 0) - d) > 0.5) {
          queue = queue.slice();
          queue[idx] = { ...cur, durationSec: d };
          queueRef.current = queue;
        }
        savePersistedQueue(
          queue,
          idx,
          playingFromRef.current,
          progressRef.current,
          isPlayingRef.current,
          playingFromIdRef.current
        );
      }
    };
    let unlistenQuit: (() => void) | undefined;
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
    let unlistenHidden: (() => void) | undefined;
    listen('zenith-hidden-to-tray', () => {
      persistQueueNow();
      try {
        localStorage.setItem('zenith_ui_tab', activeTabRef.current);
      } catch (err) {
        console.debug('App', err);
      }
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
    const minTimer = window.setTimeout(() => setMinSplashElapsed(true), 600);
    const leaveTimer = window.setTimeout(() => setSplashLeaving(true), 2600);
    const hardCap = window.setTimeout(() => {
      setShowSplash(false);
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
      }, 350);
      return () => window.clearTimeout(hide);
    }
  }, [prefetchComplete, minSplashElapsed]);

  const startBackgroundPrefetch = useCallback((tracks: Track[]) => {
    if (!tracks || tracks.length === 0) {
      setPrefetchComplete(true);
      return;
    }
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
    if (lastHydrateKeyRef.current === `${currentTrack.id}|${lyricsProvider}|${lang}`) return;
    hydratePanels(currentTrack);
  }, [lyricsProvider, lang]);

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
      context: playingFrom || undefined,
    };
    pluginManager.notifyNowPlaying(info);
    pluginManager.notifyTrackChange(info);
  }, [audio, currentTrack, duration, isPlaying, playingFrom]);

  useEffect(() => {
    if (!currentTrack) {
      pluginManager.notifyNowPlaying(null);
      pluginManager.notifyTrackChange(null);
      return;
    }
    broadcastPlayback();
  }, [currentTrack?.id, isPlaying]);

  useEffect(() => {
    pluginManager.notifyPlayState(isPlaying);
  }, [isPlaying]);

  useEffect(() => {
    audio.playbackRate = getPlaybackSpeed(pluginManager.isEnabled('playback-speed'));
  }, [audio, pluginStates, speedRate]);

  useEffect(() => {
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
  const togglePlayRef = useLatest(togglePlay);
  const playNextRef = useLatest(playNext);
  const playPrevRef = useLatest(playPrev);
  const seekToRef = useLatest(seekTo);
  const toggleMuteRef = useLatest(toggleMute);

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
    registerAbLoopSink((a, b) => audio.setLoop(a, b));
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
  const overlayStackRef = useLatest({
    np: npOpen,
    plEdit: plEdit !== null,
    fdEdit: fdEdit !== null,
    plugins: isPluginsOpen,
    settings: isSettingsOpen,
    queue: queueOpen,
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = isTypingEvent(e);
      if (e.key === 'Escape') {
        if (document.querySelector('.zen-select.open')) return;
        if (typing && (e.target as HTMLInputElement | null)?.value) return;
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

  const currentTrackLatest = useLatest(currentTrack);
  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      const row = target?.closest<HTMLElement>('[data-ctx-track]');
      const onCover =
        pluginManager.isEnabled('copy-track-link') && target?.closest('.player-view-cover-wrap');
      const track = onCover ? currentTrackLatest.current : parseCtxTrackAttr(row?.dataset.ctxTrack);
      if (track) {
        e.stopPropagation();
        const x = Math.min(e.clientX, window.innerWidth - 230);
        const y = Math.min(e.clientY, window.innerHeight - 260);
        setCtxMenu({ x, y, track, at: onCover ? progressRef.current : undefined });
      } else {
        setCtxMenu(null);
      }
    };
    const onAuxClick = (e: MouseEvent) => {
      if (e.button !== 2) return;
      if ((e.target as HTMLElement | null)?.closest('[data-ctx-track]')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('contextmenu', onContext, true);
    window.addEventListener('auxclick', onAuxClick, true);
    return () => {
      window.removeEventListener('contextmenu', onContext, true);
      window.removeEventListener('auxclick', onAuxClick, true);
    };
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
    }).catch((err) => console.debug('App', err));
  }, [pluginStates['listening-room'], currentTrack?.id, isPlaying, roomSyncTick, audio]);

  useEffect(() => {
    bindFx(
      audio,
      Boolean(pluginStates['equalizer']),
      Boolean(pluginStates['loudness-normalization'])
    );
  }, [audio, pluginStates]);

  const remoteEnabled = Boolean(pluginStates['remote-control']);
  const toggleSaveRef = useLatest(toggleSave);
  const toggleShuffleRef = useLatest(toggleShuffle);
  const cycleLoopRef = useLatest(cycleLoop);
  const handleItemClickRef = useLatest(handleItemClick);
  const langRef = useLatest(lang);
  const remoteSnapRef = useLatest<() => void>(() => {
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
  });
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
        void audio.play().catch((err) => console.debug('App', err));
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
          rate: audio.playbackRate,
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

  const lyricsRef = useLatest<LyricsResult | null>(lyrics);

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
              rate: audio.playbackRate,
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
            rate: audio.playbackRate,
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
    const overlayOn = pluginStates['lyrics-overlay'] || pluginStates['second-screen-lyrics'];
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

    const overlayOn = pluginStates['lyrics-overlay'] || pluginStates['second-screen-lyrics'];
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
    const overlayOn = pluginStates['lyrics-overlay'] || pluginStates['second-screen-lyrics'];
    overlayPluginsOnRef.current = overlayOn;
    secondScreenLyricsRef.current = Boolean(pluginStates['second-screen-lyrics']);
    const miniOn = pluginStates['mini-player'];
    if (!miniOn) return;

    const send = () => {
      const track = currentTrackIdRef.current;
      if (!track) return;
      const m = overlayMetaRef.current;
      pushMiniPlayerState({
        title: m.title,
        artist: m.artist,
        coverUrl: m.coverUrl,
        trackId: m.trackId,
        progress: audio.currentTime || progressRef.current,
        duration: durationRef.current,
        isPlaying: !audio.paused,
        rate: audio.playbackRate,
      });
    };
    const iv = setInterval(send, MINI_PLAYER_SYNC_MS);
    const evs = ['play', 'playing', 'pause', 'seeked', 'ratechange'] as const;
    evs.forEach((ev) => audio.addEventListener(ev, send));
    return () => {
      clearInterval(iv);
      evs.forEach((ev) => audio.removeEventListener(ev, send));
    };
  }, [pluginStates, audio]);

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
    setShareCardOk(ok);
    pushToast(ok ? t.shareCardCopied : t.shareCardFailed, ok ? 'success' : 'error');
    if (ok) window.setTimeout(() => setShareCardOk(false), 2000);
  }, [currentTrack, duration, isPlaying, t]);

  const heroTrack = useMemo(
    () =>
      sections.length > 0 && sections[0].items.length > 0 && activeTab === 'search'
        ? sections[0].items[0]
        : null,
    [sections, activeTab]
  );

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
      <ToastHost lang={lang} />
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
                if (activeTab === 'player') leavePlayer();
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
            <button
              type="button"
              className="nav-item settings-link"
              data-tour="plugins"
              data-testid="open-plugins"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                setIsSettingsOpen(false);
                setIsPluginsOpen(true);
              }}
              onClick={() => {
                setIsSettingsOpen(false);
                setIsPluginsOpen(true);
              }}
            >
              <Puzzle size={22} />
              <span>{t.plugins}</span>
            </button>
            <button
              type="button"
              className="nav-item settings-link"
              data-testid="open-settings"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                setIsPluginsOpen(false);
                setIsSettingsOpen(true);
              }}
              onClick={() => {
                setIsPluginsOpen(false);
                setIsSettingsOpen(true);
              }}
            >
              <Settings size={22} />
              <span>{t.settings}</span>
            </button>
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
                      ref={coverWheelRef}
                      title={`${Math.round(volume * 100)}%`}
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
                        {currentTrack && /^[\w-]{11}$/.test(currentTrack.id) && (
                          <YtmRatingButtons
                            rating={trackRating}
                            onLike={toggleLike}
                            onDislike={toggleDislike}
                            likeLabel={t.likeTrack}
                            dislikeLabel={t.dislikeTrack}
                          />
                        )}
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
                      <p className="library-empty-desc">
                        {sessionExpired ? t.sessionExpired : t.libraryEmptyDesc}
                      </p>
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
                    <div className="empty-state-message">
                      <h2>{t.feedLoadFailedTitle}</h2>
                      <p>{t.feedLoadFailedDesc}</p>
                      <button
                        type="button"
                        className="primary-action-btn empty-state-retry"
                        onClick={() => {
                          const lastCollection = lastCollectionRef.current;
                          if (activeTab === 'explore') loadExplore(lang);
                          else if (
                            activeTab === 'mood' &&
                            lastCollection &&
                            activeMood === browseMoodId(lastCollection.id)
                          ) {
                            void openCollectionPage(lastCollection);
                          } else if (activeTab === 'mood' && isBrowseMood(activeMood)) {
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
              {currentTrack && /^[\w-]{11}$/.test(currentTrack.id) && (
                <YtmRatingButtons
                  rating={trackRating}
                  onLike={toggleLike}
                  onDislike={toggleDislike}
                  likeLabel={t.likeTrack}
                  dislikeLabel={t.dislikeTrack}
                />
              )}
              {pluginStates['ab-loop'] &&
                (() => {
                  const phase = abLoopPhase(abLoop);
                  const hint =
                    phase === 'off' ? t.abLoopSetA : phase === 'a' ? t.abLoopSetB : t.abLoopClear;
                  return (
                    <button
                      type="button"
                      className={`extra-icon-btn ab-loop-btn${phase === 'off' ? '' : ` ${phase === 'a' ? 'armed' : 'active'}`}`}
                      data-phase={phase}
                      aria-label={`${t.abLoop}: ${hint}`}
                      aria-pressed={phase === 'ab'}
                      title={hint}
                      data-testid="ab-loop-btn"
                      disabled={!currentTrack}
                      onClick={() => cycleAbLoop(audio.currentTime || progressRef.current)}
                    >
                      <span className="ab-loop-letter">A</span>
                      <span className="ab-loop-dash" aria-hidden />
                      <span className="ab-loop-letter">B</span>
                    </button>
                  );
                })()}
              {pluginStates['share-card'] && (
                <button
                  type="button"
                  className={`extra-icon-btn share-card-btn ${shareCardOk ? 'active' : ''}`}
                  aria-label={t.shareCard}
                  title={shareCardOk ? t.shareCardCopied : t.shareCard}
                  disabled={!currentTrack}
                  onClick={() => void handleShareCard()}
                >
                  <Share2 size={20} strokeWidth={2.25} />
                </button>
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
                  if (activeTab === 'player') leavePlayer();
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
        <ModalOverlay onClick={() => setIsSettingsOpen(false)} testId="settings-overlay">
          <div className="glass-modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header-polished">
              <h2>{t.generalSettings}</h2>
              <X size={26} className="modal-close-icon" onClick={() => setIsSettingsOpen(false)} />
            </div>
            <div className="modal-body-polished">
              <div className="settings-row-item settings-toggle-row">
                <div className="settings-account-info">
                  <span className="setting-label">{t.offlineDownloads}</span>
                  <span className="plugin-desc">{t.offlineDownloadsDesc}</span>
                </div>
                <button
                  type="button"
                  className={`lang-option-btn remember-login-toggle${pluginStates['offline-downloads'] ? ' active' : ''}`}
                  aria-pressed={Boolean(pluginStates['offline-downloads'])}
                  data-testid="offline-downloads-toggle"
                  onClick={() => togglePlugin('offline-downloads')}
                >
                  {pluginStates['offline-downloads'] ? t.pluginEnabled : t.pluginDisabled}
                </button>
              </div>
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
                      } catch (err) {
                        console.debug('App', err);
                      }
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
                          : updateStatus.kind === 'unpublished' || updateStatus.kind === 'ahead'
                            ? 'info'
                            : 'success'
                      }`}
                      role="status"
                    >
                      {updateStatus.kind === 'newer'
                        ? t.updateAvailableTag.replace('{tag}', updateStatus.tag || '')
                        : updateStatus.kind === 'ahead'
                          ? t.updateAhead
                              .replace('{current}', appVersion)
                              .replace('{tag}', updateStatus.tag || '')
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
                  onClick={() =>
                    void openUrl(updateStatus?.url || GITHUB_RELEASES).catch((err) =>
                      console.debug('App', err)
                    )
                  }
                >
                  {t.openRelease}
                </button>
              </div>
              <div className="settings-row-item settings-toggle-row">
                <div className="settings-account-info">
                  <span className="setting-label">{t.supportApp}</span>
                  <span className="plugin-desc">{t.supportAppDesc}</span>
                </div>
                <button
                  type="button"
                  className="lang-option-btn settings-action-btn"
                  onClick={() => void openUrl(DONATE_URL).catch((err) => console.debug('App', err))}
                >
                  {t.supportAppBtn}
                </button>
              </div>
            </div>
          </div>
        </ModalOverlay>
      )}

      {pmOpen && (
        <PlaylistManager
          lang={lang}
          ownerName={libAccount?.name ?? null}
          onClose={() => setPmOpen(false)}
          onSessionExpired={() => {
            setLibAuthed(false);
            setUserPlaylists([]);
            setLibAccount(null);
            setLibSections([]);
            setSessionExpired(true);
            setPmOpen(false);
          }}
          onPlay={(tracks, index, title) => {
            if (tracks[index]) handleItemClick(tracks[index], title, tracks);
          }}
          onChanged={(change) => {
            void loadUserPlaylists();
            if (change?.deletedId && isViewingPlaylist(activeTab, activeMood, change.deletedId)) {
              ++feedSeqRef.current.mood;
              setSections([]);
              setBrowseTitle(null);
              setBrowseEmptyKind(null);
              setActiveMood(null);
              navigateTo('library');
            }
          }}
        />
      )}
      {ctxMenu &&
        createPortal(
          <>
            <div
              className="ctx-menu-catcher"
              onClick={() => setCtxMenu(null)}
              onContextMenu={() => setCtxMenu(null)}
            />
            <div
              className="ctx-menu"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
              role="menu"
              data-testid="track-ctx-menu"
            >
              {ctxMenu.at !== undefined &&
                [undefined, ctxMenu.at].map((sec) => (
                  <button
                    key={sec === undefined ? 'link' : 'link-at'}
                    role="menuitem"
                    onClick={() => {
                      const id = ctxMenu.track.id;
                      setCtxMenu(null);
                      void copyTrackLink(id, sec).then((ok) =>
                        pushToast(ok ? t.linkCopied : t.linkCopyFailed, ok ? 'success' : 'error')
                      );
                    }}
                  >
                    {sec === undefined
                      ? t.ctxCopyLink
                      : t.ctxCopyLinkAt.replace('{time}', formatTime(sec))}
                  </button>
                ))}
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
          </>,
          document.body
        )}
      {isPluginsOpen && (
        <Suspense
          fallback={
            <ModalOverlay onClick={() => setIsPluginsOpen(false)} testId="plugins-overlay">
              <div className="glass-modal-container" onClick={(e) => e.stopPropagation()} />
            </ModalOverlay>
          }
        >
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
        <ModalOverlay onClick={() => !plEditBusy && setPlEdit(null)}>
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
        </ModalOverlay>
      )}

      {fdEdit && (
        <ModalOverlay onClick={() => setFdEdit(null)}>
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
        </ModalOverlay>
      )}

      {npOpen && (
        <ModalOverlay onClick={() => setNpOpen(false)}>
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
                  ref={npTitleRef}
                  value={npTitle}
                  maxLength={150}
                  autoFocus
                  onChange={(e) => setNpTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (!isCommitKey(e.nativeEvent)) return;
                    e.preventDefault();
                    setNpTitle(e.currentTarget.value);
                    submitNewPlaylist();
                  }}
                  spellCheck={false}
                />
              </label>
              <label className="np-field">
                <span className="np-field-label">{t.npDesc}</span>
                <textarea
                  className="settings-text-input np-input np-textarea"
                  ref={npDescRef}
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
        </ModalOverlay>
      )}
    </div>
  );
}
