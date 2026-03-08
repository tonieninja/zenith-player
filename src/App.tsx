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
