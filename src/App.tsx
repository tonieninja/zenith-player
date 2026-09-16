import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  getAccountProfile,
  getAudioStream,
  getExplore,
  getHomeFeed,
  getLibrary,
  getLyrics,
  getMoodPlaylist,
  getPlaylistItems,
  getUserPlaylists,
  getWatchRelated,
  preloadImage,
  resolveLoginState,
  searchMusic,
  isLoggedIn,
  waitForLogin,
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
import { DualAudio } from './audio/dualAudio';
import { Onboarding, shouldShowOnboarding } from './components/Onboarding';
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
import { PluginsPanel } from './components/PluginsPanel';
import { QueueDrawer } from './components/queue/QueueDrawer';
import { ToastHost, pushToast } from './components/Toast';
import { isQaEnabled, qaAutoMode } from './qa/flags';
import { SyncedLyricsRail } from './components/SyncedLyricsRail';
import { LIB_EMPTY_KEYS, LIBRARY_CATEGORIES } from './constants/library';
import {
  MINI_PLAYER_SYNC_MS,
  STREAM_CACHE_LIMIT,
  STREAM_CACHE_TTL,
  UI_PROGRESS_MS,
} from './constants/playback';
import { useDebounce } from './hooks/useDebounce';
import { useScrubBar } from './hooks/useScrubBar';
import { translations, type Language } from './i18n';
import { pluginManager } from './plugins';
import {
  clearAbLoop,
  getAbLoop,
  registerAbLoopSeek,
  setAbPoint,
  tickAbLoop,
} from './plugins/abLoop';
import { registerAutoPauseCallback } from './plugins/autoPauseBlur';
import { getCrossfadeSeconds } from './plugins/crossfade';
import { registerDualSenseHandler } from './plugins/dualSense';
import { startDuckMonitor, stopDuckMonitor } from './plugins/duckOnVoice';
import { getFadePauseMs } from './plugins/fadeOnPause';
import {
  broadcastRoom,
  createRoom,
  getRoomCode,
  isRoomHost,
  leaveRoom,
  registerRoomStatusHandler,
  registerRoomSyncHandler,
  unregisterRoomSyncHandler,
} from './plugins/listeningRoom';
import { getLyricsSyncOffset, pushLyricsOverlay } from './plugins/lyricsOverlay';
import { registerMediaSessionHandlers } from './plugins/mediaSession';
import { pushMiniPlayerState } from './plugins/miniPlayer';
import { getPreloadDepth } from './plugins/preloadNext';
import { loadPersistedQueue, savePersistedQueue } from './plugins/queuePersist';
import { getRememberedVolume, saveRememberedVolume } from './plugins/rememberVolume';
import { registerKeyboardHandler, setupKeyboardShortcuts } from './plugins/keyboardShortcuts';
import { copyShareCardToClipboard } from './plugins/shareCard';
import { registerSleepTimerCallback } from './plugins/sleepTimer';
import { getPlaybackSpeed } from './plugins/playbackSpeed';
import { rampVolume, rampVolumeAsync } from './plugins/smoothVolume';
import type { LoopMode, ViewTab } from './types/views';
import { getActiveLyricIndex } from './utils/activeLyricIndex';
import { applyCoverTheme, resetCoverTheme } from './utils/coverTheme';
import { formatTime } from './utils/formatTime';
import { getRememberLogin, setRememberLogin } from './utils/rememberLogin';
import { checkGithubUpdate, GITHUB_RELEASES } from './utils/appUpdate';
import { resetOnboarding } from './utils/onboarding';
import { smartShuffle } from './utils/smartShuffle';
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
} from 'lucide-react';
import './App.css';

const appWindow = getCurrentWindow();

type FeedLoadTab = 'home' | 'explore' | 'mood' | 'search';
const FEED_LOADING_INITIAL: Record<FeedLoadTab, boolean> = {
  home: false,
  explore: false,
  mood: false,
  search: false,
};

export default function App() {
  const [sections, setSections] = useState<Section[]>([]);
  const [homeSections, setHomeSections] = useState<Section[]>([]);
  const [exploreSections, setExploreSections] = useState<Section[]>([]);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
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
  const [feedLoading, setFeedLoading] =
    useState<Record<FeedLoadTab, boolean>>(FEED_LOADING_INITIAL);
  const [searchQuery, setSearchQuery] = useState('');
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
  const [showSplash, setShowSplash] = useState(true);
  const [splashLeaving, setSplashLeaving] = useState(false);

  const [prefetchTotal, setPrefetchTotal] = useState(0);
  const [prefetchDone, setPrefetchDone] = useState(0);
  const [prefetchComplete, setPrefetchComplete] = useState(false);
  const [minSplashElapsed, setMinSplashElapsed] = useState(false);
  const mountedRef = useRef(true);

  const audioRef = useRef<DualAudio | null>(null);
  const loadGenRef = useRef(0);
  const streamFailStreakRef = useRef(0);
  const streamErrorRetryRef = useRef<string | null>(null);
  const queueIndexRef = useRef(0);
  const queueRef = useRef<Track[]>([]);
  const playByIndexRef = useRef<(index: number, fadeSeconds?: number) => Promise<void>>(
    async () => {}
  );
  const playingFromRef = useRef<string | null>(null);
  const progressRef = useRef(0);
  const durationRef = useRef(0);
  const volumeRef = useRef(0.8);
  const isPlayingRef = useRef(false);
  const crossfadeEnabledRef = useRef(false);
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
  const autoFadeTrackRef = useRef<string | null>(null);
  const autoFadePendingRef = useRef(false);
  const lastAutoFadeAtRef = useRef(0);
  const overlayPluginsOnRef = useRef(false);
  const secondScreenLyricsRef = useRef(false);
  const activeLyricLineRef = useRef(-1);
  const [activeLyricLine, setActiveLyricLine] = useState(-1);
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
  const [authBootstrapping, setAuthBootstrapping] = useState(true);
  const [libError, setLibError] = useState<string | null>(null);
  const [libAccount, setLibAccount] = useState<AccountProfile | null>(null);
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
  const [npTitle, setNpTitle] = useState('');
  const [npDesc, setNpDesc] = useState('');
  const [npPrivacy, setNpPrivacy] = useState<PlaylistPrivacy>('PRIVATE');
  const [npBusy, setNpBusy] = useState(false);
  const [npError, setNpError] = useState(false);

  const [savedIds, setSavedIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('zenith_saved') || '[]');
    } catch {
      return [];
    }
  });

  const [lang, setLang] = useState<Language>(() => {
    return (localStorage.getItem('zenith_lang') as Language) || 'en';
  });
  const [rememberLogin, setRememberLoginState] = useState(() => getRememberLogin());
  const [appVersion, setAppVersion] = useState('1.0.0');
  const [updateBusy, setUpdateBusy] = useState(false);
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
      .catch(() => {});
  }, []);

  const checkForAppUpdate = useCallback(async () => {
    if (updateBusy) return;
    setUpdateBusy(true);
    try {
      const result = await checkGithubUpdate(appVersion);
      if (result.status === 'newer') {
        pushToast(`${t.updateAvailable} ${result.tag}`, 'success');
        try {
          await openUrl(result.url);
        } catch {}
      } else if (result.status === 'current') {
        pushToast(t.upToDate, 'success');
      } else {
        pushToast(t.updateNotPublished, 'info');
      }
    } catch (e) {
      console.warn('[update]', e);
      pushToast(t.updateCheckFailed, 'error');
    } finally {
      setUpdateBusy(false);
    }
  }, [appVersion, t, updateBusy]);

  const [pluginStates, setPluginStates] = useState<Record<string, boolean>>(() =>
    pluginManager.getStates()
  );
  /** bump this when listening room host/guest flips so the broadcast effect rewires */
  const [roomSyncTick, setRoomSyncTick] = useState(0);
  const togglePlugin = useCallback((id: string) => {
    pluginManager.setEnabled(id, !pluginManager.isEnabled(id));
    setPluginStates(pluginManager.getStates());
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
  const prefetchStream = useCallback(
    (track: Track | undefined) => {
      if (!track) return;
      const now = Date.now();
      const cached = streamCacheRef.current.get(track.id);
      if (cached && now - cached.ts < STREAM_CACHE_TTL) return;
      if (prefetchInflightRef.current >= 2) return;
      prefetchInflightRef.current += 1;
      getAudioStream(track.id, lang)
        .then((url) => {
          if (!url) return;
          streamCacheSet(streamCacheRef.current, track.id, url, STREAM_CACHE_LIMIT);
        })
        .catch(() => {})
        .finally(() => {
          prefetchInflightRef.current = Math.max(0, prefetchInflightRef.current - 1);
        });
    },
    [lang]
  );
  if (!audioRef.current) {
    audioRef.current = new DualAudio();
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

  const loading = useMemo(() => {
    if (activeTab === 'home') return feedLoading.home;
    if (activeTab === 'explore') return feedLoading.explore;
    if (activeTab === 'mood') return feedLoading.mood;
    if (activeTab === 'search') return feedLoading.search;
    return false;
  }, [activeTab, feedLoading]);

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

  const changeLanguage = useCallback((newLang: Language) => {
    setLang(newLang);
    localStorage.setItem('zenith_lang', newLang);
    window.location.reload();
  }, []);

  const debouncedSearch = useDebounce(searchQuery, 400);

  const handleSearch = useCallback(
    (query: string, language: Language = lang) => {
      if (!query.trim()) return;
      const dataSeq = ++feedSeqRef.current.search;
      setFeedTabLoading('search', true);
      const safety = window.setTimeout(() => setFeedTabLoading('search', false), 8000);
      navigateTo('search');
      setActiveMood(null);
      searchMusic(query, language)
        .then((data) => {
          if (dataSeq !== feedSeqRef.current.search) return;
          setSections(stableOrderSections(data));
        })
        .catch(() => {
          if (dataSeq !== feedSeqRef.current.search) return;
          setSections(stableOrderSections([]));
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
      clearHomeBrowseCache();
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

  useEffect(() => {
    if (!debouncedSearch.trim()) return;
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
        let sections = await getLibrary(category, lang);
        if (sections.length === 0) {
          await new Promise((r) => setTimeout(r, 400));
          clearAuthCache();
          sections = await getLibrary(category, lang);
        }
        void loadUserPlaylists();
        void refreshAccountProfile();
        if (reqId !== libReqIdRef.current) return;
        setLibSections(sections);
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
  useEffect(() => {
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
      const authed = await waitForLogin(lang, 8, 500);
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
      try {
        await invoke('clear_stream_cache');
        await invoke('clear_ytm_auth');
        await invoke('clear_ytm_session_store');
        await invoke('clear_login_webview_data');
      } catch (e) {
        console.warn('[logout] cleanup failed', e);
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
      const reqId = ++lyricsReqIdRef.current;
      setLyricsLoading(true);
      setLyrics(null);
      debugLyricsProviders(track);
      getLyrics(track, lang, lyricsProvider)
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

  const resolveStreamUrl = useCallback(
    async (trackId: string, forceFresh = false) => {
      const url = await getAudioStream(trackId, lang, forceFresh);
      if (url) streamCacheSet(streamCacheRef.current, trackId, url, STREAM_CACHE_LIMIT);
      return url;
    },
    [lang]
  );

  const loadTrack = useCallback(
    async (track: Track, autoPlay = true, fadeSeconds?: number, startAt = 0) => {
      const gen = ++loadGenRef.current;
      setCurrentTrack(track);
      setBuffering(true);
      const stale = () => gen !== loadGenRef.current;

      const skipOnFail = () => {
        const L = (localStorage.getItem('zenith_lang') as Language) || 'en';
        streamFailStreakRef.current += 1;
        const streak = streamFailStreakRef.current;
        const qi = queueIndexRef.current;
        const q = queueRef.current;
        if (streak >= 3) {
          pushToast(translations[L].streamUnavailableStuck, 'error');
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
          }, 700);
        }
      };

      const baseFade = fadeSeconds ?? getCrossfadeSeconds();
      const fadeDur = audio.isCrossfading ? Math.min(0.55, baseFade) : baseFade;
      const wantFade =
        crossfadeEnabled && autoPlay && audio.hasSource && fadeDur > 0 && startAt <= 0;

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
        let streamUrl = await resolveStreamUrl(track.id);
        if (stale()) return;
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
            if (stale()) return;
            setIsPlaying(true);
            progressRef.current = 0;
            paintProgressUiRef.current(0);
            streamFailStreakRef.current = 0;
            streamErrorRetryRef.current = null;
            autoFadePendingRef.current = false;
            setBuffering(false);
            audio.releaseInactive();
            return;
          } catch {
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
            streamFailStreakRef.current = 0;
            streamErrorRetryRef.current = null;
            autoFadePendingRef.current = false;
            setBuffering(false);
            return;
          } catch {
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
    },
    [audio, crossfadeEnabled, resolveStreamUrl]
  );

  const playByIndex = useCallback(
    async (index: number, fadeSeconds?: number) => {
      const q = queueRef.current;
      if (index < 0 || index >= q.length) return;
      const nextTrack = q[index];
      const manualFade = fadeSeconds ?? (crossfadeEnabled ? getCrossfadeSeconds() : undefined);
      queueIndexRef.current = index;
      setQueueIndex(index);
      await loadTrack(nextTrack, true, manualFade);
      if (queueIndexRef.current !== index) return;
      hydratePanels(nextTrack);
    },
    [loadTrack, hydratePanels, crossfadeEnabled]
  );
  playByIndexRef.current = playByIndex;

  const handleCollectionClick = useCallback(
    async (collection: Track) => {
      try {
        const items = await getPlaylistItems(collection.id, lang);
        if (!items.length) {
          pushToast(translations[lang].playlistOpenFailed, 'error');
          return;
        }

        const itemsWithCover = items.map((i) => ({
          ...i,
          cover: i.cover.includes('ui-avatars') ? collection.cover : i.cover,
          coverSmall: i.coverSmall?.includes('ui-avatars') ? collection.coverSmall : i.coverSmall,
          coverLarge: i.coverLarge?.includes('ui-avatars') ? collection.coverLarge : i.coverLarge,
        }));

        setQueue(itemsWithCover);
        setQueueIndex(0);
        setShuffleOn(false);
        originalQueueRef.current = null;
        setPlayingFrom(collection.title);
        openPlayer();
        await loadTrack(itemsWithCover[0]);
        hydratePanels(itemsWithCover[0]);
      } catch (e) {
        console.warn('[playlist] open failed', e);
        pushToast(translations[lang].playlistOpenFailed, 'error');
      }
    },
    [lang, openPlayer, loadTrack, hydratePanels]
  );

  const handleItemClick = useCallback(
    async (track: Track, sectionTitle?: string, sectionItems?: Track[]) => {
      const playable = track.type === 'track' || /^[\w-]{11}$/.test(track.id);
      if (!playable) {
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
      await loadTrack(track);
      hydratePanels(track);
    },
    [openPlayer, loadTrack, hydratePanels, handleCollectionClick]
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
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    const idx = queueIndexRef.current;
    const q = queueRef.current;
    if (idx > 0) playByIndex(idx - 1);
    else if (loopMode === 'all' && q.length > 0) playByIndex(q.length - 1);
  }, [audio, currentTrack, playByIndex, loopMode]);

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
      setShuffleOn(false);
    }
  }, [queue, queueIndex, shuffleOn, currentTrack]);

  const toggleSave = useCallback(() => {
    if (!currentTrack) return;
    setSavedIds((prev) =>
      prev.includes(currentTrack.id)
        ? prev.filter((id) => id !== currentTrack.id)
        : [...prev, currentTrack.id]
    );
  }, [currentTrack]);

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

  const handleVolumeClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setVolume(ratio);
      rampVolume(audio, ratio, pluginManager.isEnabled('smooth-volume'));
      if (pluginManager.isEnabled('remember-volume')) saveRememberedVolume(ratio);
      if (isMuted) {
        audio.muted = false;
        setIsMuted(false);
      }
    },
    [audio, isMuted]
  );

  useEffect(() => {
    let lastUiAt = 0;
    const onTimeUpdate = () => {
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
        crossfadeEnabledRef.current &&
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
        if (
          remaining <= cfs &&
          remaining > 0.35 &&
          trackId &&
          autoFadeTrackRef.current !== trackId
        ) {
          if (Date.now() - lastAutoFadeAtRef.current >= Math.max(cfs * 1000 + 2000, 5000)) {
            let nextIndex = -1;
            if (qi < q.length - 1) nextIndex = qi + 1;
            else if (loopModeRef.current === 'all' && q.length > 1) nextIndex = 0;
            if (nextIndex >= 0) {
              autoFadeTrackRef.current = trackId;
              autoFadePendingRef.current = true;
              lastAutoFadeAtRef.current = Date.now();
              void playByIndex(nextIndex, Math.max(1, remaining)).catch(() => {
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
    const onPause = () => setIsPlaying(false);
    const onWaiting = () => setBuffering(true);
    const onCanPlay = () => setBuffering(false);
    const onError = () => {
      if (!audio.hasSource) return;
      const id = currentTrackIdRef.current;
      const resumeAt = progressRef.current;
      const skipAhead = () => {
        setIsPlaying(false);
        setBuffering(false);
        const qi = queueIndexRef.current;
        const q = queueRef.current;
        if (qi < q.length - 1) {
          window.setTimeout(() => {
            if (currentTrackIdRef.current !== id) return;
            void playByIndexRef.current(qi + 1);
          }, 500);
        }
      };
      if (!id || streamErrorRetryRef.current === id) {
        skipAhead();
        return;
      }
      streamErrorRetryRef.current = id;
      void resolveStreamUrl(id, true).then((url) => {
        if (!url || currentTrackIdRef.current !== id) {
          skipAhead();
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
          skipAhead();
        });
      });
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('canplay', onCanPlay);
    audio.addEventListener('error', onError);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('play', onPlay);
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
    localStorage.setItem('zenith_saved', JSON.stringify(savedIds));
  }, [savedIds]);

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

  const pluginsBootstrappedRef = useRef(false);

  useEffect(() => {
    if (pluginsBootstrappedRef.current) return;
    pluginsBootstrappedRef.current = true;

    const pluginTimer = window.setTimeout(() => {
      for (const p of pluginManager.plugins) {
        if (pluginManager.isEnabled(p.id)) {
          try {
            p.onEnable?.();
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
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        if (pluginManager.isEnabled('queue-persist') && queueRef.current.length) {
          savePersistedQueue(
            queueRef.current,
            queueIndexRef.current,
            playingFromRef.current,
            progressRef.current,
            isPlayingRef.current
          );
        }
        for (const label of ['lyrics-overlay', 'lyrics-second', 'mini-player', 'google-login']) {
          try {
            const w = await WebviewWindow.getByLabel(label);
            await w?.close();
          } catch {}
        }
        try {
          await invoke('app_prepare_shutdown');
        } catch {}
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

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
    const minTimer = window.setTimeout(() => setMinSplashElapsed(true), 1800);
    const leaveTimer = window.setTimeout(() => setSplashLeaving(true), 1400);
    const hardCap = window.setTimeout(() => {
      setShowSplash(false);
    }, 3200);
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
      }, 900);
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
    if (!currentTrack) return;
    hydratePanels(currentTrack);
  }, [lyricsProvider]);

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
    savePersistedQueue(queue, queueIndex, playingFrom, progressRef.current, isPlaying);
  }, [queue, queueIndex, playingFrom, isPlaying, pluginStates]);

  useEffect(() => {
    if (!pluginManager.isEnabled('queue-persist') || !currentTrack) return;
    const iv = window.setInterval(() => {
      savePersistedQueue(
        queueRef.current,
        queueIndexRef.current,
        playingFromRef.current,
        progressRef.current,
        isPlayingRef.current
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
    registerKeyboardHandler((action) => {
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
    });
  }, [audio]);

  useEffect(() => {
    return setupKeyboardShortcuts(pluginManager.isEnabled('keyboard-shortcuts'));
  }, [pluginStates]);

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
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
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
  const homeHeroTrack = useMemo(
    () => (activeTab === 'home' ? (quickPicks[0] ?? homeSections[0]?.items[0] ?? null) : null),
    [activeTab, quickPicks, homeSections]
  );

  // qa junk, only in dev or if you set VITE_ZENITH_QA=1
  const qaRanRef = useRef(false);
  const qaSnapRef = useRef(() => ({
    activeTab: 'home' as string,
    loading: true,
    libLoading: false,
    libAuthed: false,
    sectionCount: 0,
    sectionTitles: [] as string[],
    quickPickCount: 0,
    queueLen: 0,
    queueIndex: 0,
    isPlaying: false,
    buffering: false,
    hasTrack: false,
    trackTitle: null as string | null,
    trackArtist: null as string | null,
    progress: 0,
    duration: 0,
    volume: 0.8,
    muted: false,
    loopMode: 'off',
    shuffleOn: false,
    lang: 'en',
    pluginsEnabled: [] as string[],
    splashVisible: true,
    panels: { plugins: false, settings: false, queue: false },
    lyricsLoading: false,
    lyricsLines: 0,
    relatedSections: 0,
    userPlaylistCount: 0,
    frozenSuspect: false,
  }));
  const qaActionsRef = useRef({
    goHome: () => {},
    goExplore: () => {},
    goLibrary: () => {},
    goMoods: () => {},
    goPlayer: () => {},
    search: (_q: string) => {},
    playFirstHomeTrack: async () => false as boolean,
    playFirstSearchTrack: async () => false as boolean,
    togglePlay: async () => {},
    playNext: () => {},
    playPrev: () => {},
    seek: (_t: number) => {},
    toggleMute: () => {},
    cycleLoop: () => {},
    toggleShuffle: () => {},
    openPlugins: () => {},
    openSettings: () => {},
    openQueue: () => {},
    closePanels: () => {},
    setVolume: (_v: number) => {},
    setPlugin: (_id: string, _on: boolean) => {},
    openMoodCategory: (_id: string) => {},
    createListeningRoom: async () => '' as string,
    leaveListeningRoom: async () => {},
  });

  qaSnapRef.current = () => ({
    activeTab,
    loading,
    libLoading,
    libAuthed: Boolean(libAuthed),
    sectionCount: sections.length,
    sectionTitles: sections.map((s) => s.title).slice(0, 12),
    quickPickCount: quickPicks.length,
    queueLen: queue.length,
    queueIndex,
    isPlaying,
    buffering,
    hasTrack: Boolean(currentTrack),
    trackTitle: currentTrack?.title ?? null,
    trackArtist: currentTrack?.artist ?? null,
    progress: progressRef.current,
    duration,
    volume,
    muted: isMuted,
    loopMode,
    shuffleOn,
    lang,
    pluginsEnabled: pluginManager.plugins
      .filter((p) => pluginManager.isEnabled(p.id))
      .map((p) => p.id),
    splashVisible: showSplash,
    panels: {
      plugins: isPluginsOpen,
      settings: isSettingsOpen,
      queue: queueOpen,
    },
    lyricsLoading,
    lyricsLines: lyrics?.synced?.length || (lyrics?.text ? 1 : 0),
    relatedSections: related?.sections?.length || 0,
    userPlaylistCount: userPlaylists.length,
    frozenSuspect: showFeedSkeleton && !showSplash,
  });
  qaActionsRef.current = {
    goHome: () => loadHome(),
    goExplore: () => loadExplore(),
    goLibrary: () => {
      navigateTo('library');
      void loadLibrary();
    },
    goMoods: () => openMoodsGenres(),
    goPlayer: () => openPlayer(),
    search: (q) => {
      setSearchQuery(q);
      handleSearch(q, lang);
    },
    playFirstHomeTrack: async () => {
      const fromQuick = quickPicks.find((t) => t.type === 'track') || quickPicks[0];
      if (fromQuick) {
        await handleItemClick(fromQuick, 'Quick picks', quickPicks);
        return true;
      }
      for (const section of sections) {
        const track = section.items.find((i) => i.type === 'track');
        if (track) {
          await handleItemClick(track, section.title, section.items);
          return true;
        }
      }
      return false;
    },
    playFirstSearchTrack: async () => {
      if (activeTab !== 'search') return false;
      for (const section of sections) {
        const track = section.items.find((i) => i.type === 'track');
        if (track) {
          await handleItemClick(track, section.title, section.items);
          return true;
        }
      }
      return false;
    },
    togglePlay: async () => {
      await togglePlay();
    },
    playNext: () => playNext(),
    playPrev: () => playPrev(),
    seek: (t) => seekTo(t),
    toggleMute: () => toggleMute(),
    cycleLoop: () => cycleLoop(),
    toggleShuffle: () => toggleShuffle(),
    openPlugins: () => setIsPluginsOpen(true),
    openSettings: () => setIsSettingsOpen(true),
    openQueue: () => setQueueOpen(true),
    closePanels: () => {
      setIsPluginsOpen(false);
      setIsSettingsOpen(false);
      setQueueOpen(false);
    },
    setVolume: (v) => {
      const next = Math.max(0, Math.min(1, v));
      setVolume(next);
      audio.volume = next;
      setIsMuted(false);
      if (pluginManager.isEnabled('remember-volume')) saveRememberedVolume(next);
    },
    setPlugin: (id, on) => {
      pluginManager.setEnabled(id, on);
      setPluginStates(pluginManager.getStates());
    },
    openMoodCategory: (id) => {
      const map: Record<string, string> = {
        focus: 'FEmusic_mood_playlist_Focus',
        workout: 'FEmusic_mood_playlist_Workout',
        chill: 'FEmusic_mood_playlist_Chill',
      };
      loadMood(id, map[id] || map.focus);
    },
    createListeningRoom: async () => createRoom(),
    leaveListeningRoom: async () => {
      await leaveRoom();
    },
  };

  useEffect(() => {
    if (!isQaEnabled()) return;
    let disposed = false;
    let installed: { uninstall?: () => void } | null = null;
    void import('./qa/selfCheck').then(({ installZenithQa }) => {
      if (disposed) return;
      const api = installZenithQa({
        getSnapshot: () => qaSnapRef.current(),
        goHome: () => qaActionsRef.current.goHome(),
        goExplore: () => qaActionsRef.current.goExplore(),
        goLibrary: () => qaActionsRef.current.goLibrary(),
        goMoods: () => qaActionsRef.current.goMoods(),
        goPlayer: () => qaActionsRef.current.goPlayer(),
        search: (q) => qaActionsRef.current.search(q),
        playFirstHomeTrack: () => qaActionsRef.current.playFirstHomeTrack(),
        playFirstSearchTrack: () => qaActionsRef.current.playFirstSearchTrack(),
        togglePlay: () => qaActionsRef.current.togglePlay(),
        playNext: () => qaActionsRef.current.playNext(),
        playPrev: () => qaActionsRef.current.playPrev(),
        seek: (t) => qaActionsRef.current.seek(t),
        toggleMute: () => qaActionsRef.current.toggleMute(),
        cycleLoop: () => qaActionsRef.current.cycleLoop(),
        toggleShuffle: () => qaActionsRef.current.toggleShuffle(),
        openPlugins: () => qaActionsRef.current.openPlugins(),
        openSettings: () => qaActionsRef.current.openSettings(),
        openQueue: () => qaActionsRef.current.openQueue(),
        closePanels: () => qaActionsRef.current.closePanels(),
        setVolume: (v) => qaActionsRef.current.setVolume(v),
        setPlugin: (id, on) => qaActionsRef.current.setPlugin(id, on),
        openMoodCategory: (id) => qaActionsRef.current.openMoodCategory(id),
        createListeningRoom: () => qaActionsRef.current.createListeningRoom(),
        leaveListeningRoom: () => qaActionsRef.current.leaveListeningRoom(),
      });
      installed = {
        uninstall: () => {
          if (window.__zenithQA === api) delete window.__zenithQA;
        },
      };
      void invoke('debug_write_dump', {
        name: 'qa_boot.json',
        contents: JSON.stringify({ at: new Date().toISOString(), boot: true, mode: qaAutoMode() }),
      }).catch(() => {});
    });
    return () => {
      disposed = true;
      installed?.uninstall?.();
    };
  }, []);

  useEffect(() => {
    const mode = qaAutoMode();
    if (!mode || showSplash || qaRanRef.current) return;
    const t = window.setTimeout(() => {
      void (async () => {
        const deadline = Date.now() + 20000;
        while (!window.__zenithQA && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
        if (qaRanRef.current || !window.__zenithQA) return;
        qaRanRef.current = true;
        const qa = window.__zenithQA;
        const run =
          mode === 'release'
            ? qa.runRelease()
            : mode === 'full'
              ? qa.runFull()
              : mode === 'smoke'
                ? qa.runSmoke()
                : qa.runSocial();
        try {
          await run;
        } catch (e) {
          console.warn('[qa] auto suite failed', e);
        }
      })();
    }, 4000);
    return () => window.clearTimeout(t);
  }, [showSplash]);

  useEffect(() => {
    if (showSplash || isQaEnabled()) return;
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
      <Onboarding
        lang={lang}
        open={showOnboarding}
        onClose={() => setShowOnboarding(false)}
        onSignIn={() => void handleLogin()}
        libAuthed={libAuthed}
      />
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
              type="text"
              placeholder={t.searchPlaceholder}
              className="search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch(searchQuery);
              }}
            />
          </div>
        </div>
        <div className="titlebar-actions">
          <button
            type="button"
            className={`titlebar-pill-btn no-window-drag${libAuthed ? ' logged-in' : ''}`}
            onClick={handleLogin}
            title={libAuthed ? (libAccount?.name ?? t.loggedIn) : t.login}
            data-tour="login"
          >
            <UserCircle size={17} />
            <span className="hide-on-mobile titlebar-user-name">
              {libAuthed ? (libAccount?.name ?? t.loggedIn) : t.login}
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
              aria-label="Minimize"
              onClick={() => void appWindow.minimize()}
            >
              <Minus size={14} strokeWidth={2.25} />
            </button>
            <button
              type="button"
              className="win-ctrl-btn no-window-drag"
              aria-label={isMaximized ? 'Restore' : 'Maximize'}
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
              aria-label="Close"
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
            {activeTab === 'player' && (
              <div className="nav-item back-btn" onClick={() => navigateTo(prevTab)}>
                <ChevronLeft size={22} />
                <span>{t.back}</span>
              </div>
            )}
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
            <div
              className="nav-item playlist-link"
              onClick={() => {
                setLibCategory('songs');
                navigateTo('library');
              }}
            >
              <ListMusic size={18} />
              <span>{t.favs}</span>
            </div>
            <div
              className="nav-item playlist-link"
              onClick={() => loadMood('workout', 'FEmusic_mood_playlist_Workout')}
            >
              <ListMusic size={18} />
              <span>{t.workout}</span>
            </div>
            <div
              className="nav-item playlist-link"
              onClick={() => loadMood('focus', 'FEmusic_mood_playlist_Focus')}
            >
              <ListMusic size={18} />
              <span>{t.nightCode}</span>
            </div>
            {userPlaylists.map((pl) => (
              <div
                key={pl.id}
                className="nav-item playlist-link user-playlist-link"
                onClick={() => void handleCollectionClick(pl)}
                title={pl.title}
              >
                <ListMusic size={18} />
                <span>{pl.title}</span>
              </div>
            ))}
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
                                          {...coverAttrs(item)}
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
                          <button className="lyrics-provider-nav" onClick={() => cycleProvider(-1)}>
                            <ChevronLeft size={16} />
                          </button>
                          <div className="lyrics-provider-title">
                            {lyrics?.provider || t.lyrics}
                          </div>
                          <button className="lyrics-provider-nav" onClick={() => cycleProvider(1)}>
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
                            <SyncedLyricsRail
                              synced={lyrics.synced}
                              idx={activeLyricLine}
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
                                      <span className="lyrics-failure-reason">{f.reason}</span>
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
                            <div className="library-list">
                              {section.items.map((item) => (
                                <button
                                  key={item.id}
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
                                  <span className="search-result-badge">{item.type}</span>
                                </button>
                              ))}
                            </div>
                          </section>
                        ))
                      )}
                    </div>
                  )
                ) : showFeedSkeleton ? (
                  <FeedSkeleton />
                ) : !tabHasFeedContent && activeTab !== 'moods_genres' ? (
                  <div className="empty-state-message">
                    <h2>{t.noResults}</h2>
                    <p>{t.noResultsDesc}</p>
                  </div>
                ) : (
                  <>
                    {(activeTab === 'home' || activeTab === 'mood') && (
                      <MoodChips
                        activeCategory={activeMood}
                        onCategoryClick={loadMood}
                        lang={lang}
                        t={t}
                      />
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
                                <span className="search-result-badge">{item.type}</span>
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
                    {...coverAttrs(currentTrack)}
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
                <SkipBack size={22} className="control-icon-btn" onClick={playPrev} />
                <div className="main-play-pause-circle" onClick={togglePlay}>
                  {buffering ? (
                    <Loader2 size={24} className="spin-icon" />
                  ) : isPlaying ? (
                    <Pause size={24} fill="currentColor" />
                  ) : (
                    <Play size={24} fill="currentColor" />
                  )}
                </div>
                <SkipForward size={22} className="control-icon-btn" onClick={playNext} />
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
              <Mic2
                size={20}
                className="extra-icon-btn"
                aria-label={t.lyrics}
                onClick={() => currentTrack && openPlayer()}
              />
              <div className="volume-control-block">
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
              setQueue((prev) => {
                if (idx < 0 || idx >= prev.length) return prev;
                const wasCurrent = idx === queueIndexRef.current;
                const next = prev.filter((_, i) => i !== idx);
                queueRef.current = next;
                let newIndex = queueIndexRef.current;
                if (idx < newIndex) newIndex -= 1;
                else if (idx === newIndex) {
                  newIndex = Math.min(newIndex, Math.max(0, next.length - 1));
                }
                queueIndexRef.current = newIndex;
                setQueueIndex(newIndex);
                if (next.length === 0) {
                  audio.pause();
                  audio.src = '';
                  setCurrentTrack(null);
                  setIsPlaying(false);
                } else if (wasCurrent && next[newIndex]) {
                  void loadTrack(next[newIndex], isPlayingRef.current);
                }
                return next;
              });
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
                  <span className="setting-label">{t.replayOnboarding}</span>
                  <span className="plugin-desc">{t.replayOnboardingDesc}</span>
                </div>
                <button
                  type="button"
                  className="lang-option-btn"
                  onClick={() => {
                    resetOnboarding();
                    setIsSettingsOpen(false);
                    setShowOnboarding(true);
                  }}
                >
                  {t.onbTourCta}
                </button>
              </div>
              <div className="settings-row-item">
                <div className="language-selector-group">
                  <button
                    className={`lang-option-btn ${lang === 'en' ? 'active' : ''}`}
                    onClick={() => changeLanguage('en')}
                  >
                    {t.langEn}
                  </button>
                  <button
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
                  <span className="setting-label">
                    {t.appVersion} {appVersion}
                  </span>
                  <span className="plugin-desc">{t.aboutLegal}</span>
                </div>
                <button
                  type="button"
                  className="lang-option-btn"
                  disabled={updateBusy}
                  onClick={() => void checkForAppUpdate()}
                >
                  {updateBusy ? t.checkingUpdates : t.checkUpdates}
                </button>
              </div>
              <div className="settings-row-item">
                <button
                  type="button"
                  className="lang-option-btn"
                  onClick={() => void openUrl(GITHUB_RELEASES).catch(() => {})}
                >
                  {t.openRelease}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isPluginsOpen && (
        <PluginsPanel
          lang={lang}
          pluginStates={pluginStates}
          togglePlugin={togglePlugin}
          onClose={() => setIsPluginsOpen(false)}
          discordClientId={discordClientId}
          saveDiscordClientId={saveDiscordClientId}
          audio={audio}
        />
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
