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
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; track: Track } | null>(null);
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
