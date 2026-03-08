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
