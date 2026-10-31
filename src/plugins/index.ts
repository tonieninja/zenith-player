import { abLoopPlugin } from './abLoop';
import { ambientGlowPlugin } from './ambientGlow';
import { autoPauseBlurPlugin } from './autoPauseBlur';
import { copyTrackLinkPlugin } from './copyTrackLink';
import { crossfadePlugin } from './crossfade';
import { discordPresencePlugin } from './discordPresence';
import { dualSensePlugin } from './dualSense';
import { duckOnVoicePlugin } from './duckOnVoice';
import { equalizerPlugin, loudnessPlugin } from './equalizer';
import { lastfmPlugin } from './lastfm';
import { fadeOnPausePlugin } from './fadeOnPause';
import { globalHotkeysPlugin } from './globalHotkeys';
import { keyboardShortcutsPlugin } from './keyboardShortcuts';
import { listeningHistoryPlugin } from './listeningHistory';
import { listeningRoomPlugin } from './listeningRoom';
import { lyricsKaraokePlugin } from './lyricsKaraoke';
import { lyricsOverlayPlugin } from './lyricsOverlay';
import { mediaSessionPlugin } from './mediaSession';
import { offlineDownloadsPlugin } from './offlineDownloads';
import { miniPlayerPlugin } from './miniPlayer';
import { playbackSpeedPlugin } from './playbackSpeed';
import { preloadNextPlugin } from './preloadNext';
import { queuePersistPlugin } from './queuePersist';
import { remoteControlPlugin } from './remoteControl';
import { rememberVolumePlugin } from './rememberVolume';
import { secondScreenLyricsPlugin } from './secondScreenLyrics';
import { shareCardPlugin } from './shareCard';
import { sleepTimerPlugin } from './sleepTimer';
import { smoothVolumePlugin } from './smoothVolume';
import { STAGE_BUNDLE, zenithStagePlugin } from './stage';
import { smartLyricsPlugin } from './smartLyrics';
import { statsTrackerPlugin } from './statsTracker';
import { systemTrayPlugin } from './systemTray';
import { webhookPlugin } from './webhook';
import { windowTitlePlugin } from './windowTitle';
import { NowPlayingInfo, PluginCategory, PLUGIN_CATEGORY_ORDER, ZenithPlugin } from './types';

const STORAGE_KEY = 'zenith_plugins_enabled';

/** display order inside each category, most useful first */
export const PLUGIN_ORDER = [
  'preload-next',
  'queue-persist',
  'remember-volume',
  'crossfade',
  'offline-downloads',
  'sleep-timer',
  'playback-speed',
  'ab-loop',
  'auto-pause-blur',
  'equalizer',
  'loudness-normalization',
  'fade-on-pause',
  'smooth-volume',
  'duck-on-voice',
  'smart-lyrics',
  'lyrics-karaoke',
  'lyrics-overlay',
  'second-screen-lyrics',
  'media-session',
  'global-hotkeys',
  'keyboard-shortcuts',
  'remote-control',
  'dualsense-pad',
  'webhook',
  'lastfm-scrobbler',
  'discord-rpc',
  'listening-room',
  'zenith-stage',
  'share-card',
  'copy-track-link',
  'system-tray',
  'window-title',
  'ambient-glow',
  'mini-player',
  'stats-tracker',
  'listening-history',
];

function pluginRank(id: string): number {
  const i = PLUGIN_ORDER.indexOf(id);
  return i < 0 ? PLUGIN_ORDER.length : i;
}

/**
 * plugins that pop their own always-on-top window. they are session-only:
 * the window only ever appears after the user flips the toggle, never on a cold start
 */
export const AUX_WINDOW_PLUGINS: Record<string, string> = {
  'lyrics-overlay': 'lyrics-overlay',
  'second-screen-lyrics': 'lyrics-second',
  'mini-player': 'mini-player',
};

type PluginListener = (states: Record<string, boolean>) => void;

export const ALL_PLUGINS: ZenithPlugin[] = [
  abLoopPlugin,
  ambientGlowPlugin,
  autoPauseBlurPlugin,
  copyTrackLinkPlugin,
  crossfadePlugin,
  discordPresencePlugin,
  dualSensePlugin,
  duckOnVoicePlugin,
  equalizerPlugin,
  fadeOnPausePlugin,
  globalHotkeysPlugin,
  keyboardShortcutsPlugin,
  listeningHistoryPlugin,
  listeningRoomPlugin,
  loudnessPlugin,
  lastfmPlugin,
  lyricsKaraokePlugin,
  lyricsOverlayPlugin,
  mediaSessionPlugin,
  offlineDownloadsPlugin,
  miniPlayerPlugin,
  playbackSpeedPlugin,
  preloadNextPlugin,
  queuePersistPlugin,
  rememberVolumePlugin,
  remoteControlPlugin,
  secondScreenLyricsPlugin,
  shareCardPlugin,
  sleepTimerPlugin,
  smartLyricsPlugin,
  smoothVolumePlugin,
  statsTrackerPlugin,
  systemTrayPlugin,
  webhookPlugin,
  windowTitlePlugin,
  zenithStagePlugin,
];

/** async hooks (dualsense, hotkeys...) reject outside the try/catch, keep them quiet */
function catchAsync(r: unknown, label: string) {
  if (r && typeof (r as Promise<unknown>).then === 'function') {
    (r as Promise<unknown>).catch((err) => console.warn(label, err));
  }
}

class PluginManager {
  readonly plugins: ZenithPlugin[];
  private enabled: Record<string, boolean>;
  private lastTrackId: string | null = null;
  private listeners = new Set<PluginListener>();

  constructor(plugins: ZenithPlugin[]) {
    this.plugins = plugins;
    this.enabled = {};
    // no persist here: this runs at import time, before the prefs mirror has put back the
    // saved choices, and writing defaults now would win over them (see reloadFromStorage)
    this.readStored();
  }

  private readStored() {
    let stored: Record<string, boolean> = {};
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      stored = {};
    }
    for (const plugin of this.plugins) {
      this.enabled[plugin.id] = stored[plugin.id] ?? plugin.defaultEnabled;
    }
    for (const id of Object.keys(AUX_WINDOW_PLUGINS)) this.enabled[id] = false;
  }

  /** call once the prefs mirror restored localStorage, before the first render */
  reloadFromStorage() {
    this.readStored();
    this.persist();
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.enabled));
    } catch {}
  }

  /** ui re-render hook, fires whenever any toggle flips (incl. from outside, eg. window X) */
  subscribe(fn: PluginListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emitChange() {
    const snapshot = this.getStates();
    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch {}
    }
  }

  /** the aux window was closed by the user, just flip the switch without re-closing it */
  markWindowClosed(label: string) {
    const id = Object.keys(AUX_WINDOW_PLUGINS).find((k) => AUX_WINDOW_PLUGINS[k] === label);
    if (!id || !this.enabled[id]) return;
    this.enabled[id] = false;
    this.persist();
    this.emitChange();
  }

  isEnabled(id: string): boolean {
    return Boolean(this.enabled[id]);
  }

  getStates(): Record<string, boolean> {
    return { ...this.enabled };
  }

  byCategory(): Record<PluginCategory, ZenithPlugin[]> {
    const groups = Object.fromEntries(
      PLUGIN_CATEGORY_ORDER.map((c) => [c, [] as ZenithPlugin[]])
    ) as Record<PluginCategory, ZenithPlugin[]>;
    for (const p of this.plugins) groups[p.category].push(p);
    // inside a group: the ones most people want first, as listed in PLUGIN_ORDER
    for (const c of PLUGIN_CATEGORY_ORDER)
      groups[c].sort((a, b) => pluginRank(a.id) - pluginRank(b.id));
    return groups;
  }

  setEnabled(id: string, on: boolean) {
    if (this.enabled[id] === on) return;
    this.enabled[id] = on;
    this.persist();
    const plugin = this.plugins.find((p) => p.id === id);
    if (!plugin) return;
    try {
      const r: unknown = on ? plugin.onEnable?.() : plugin.onDisable?.();
      catchAsync(r, `[plugins] ${id} toggle failed`);
    } catch (err) {
      console.warn(`[plugins] ${id} toggle failed`, err);
    }

    // one toggle for the whole streamer bundle, both ways
    if (id === 'zenith-stage') {
      for (const bundled of STAGE_BUNDLE) {
        if (Boolean(this.enabled[bundled]) !== on) this.setEnabled(bundled, on);
      }
    }
    this.emitChange();
  }

  private forEachEnabled(fn: (p: ZenithPlugin) => unknown) {
    for (const plugin of this.plugins) {
      if (!this.enabled[plugin.id]) continue;
      try {
        catchAsync(fn(plugin), `[plugins] ${plugin.id} hook failed`);
      } catch (err) {
        console.warn(`[plugins] ${plugin.id} hook failed`, err);
      }
    }
  }

  notifyNowPlaying(info: NowPlayingInfo | null) {
    this.forEachEnabled((p) => p.onNowPlaying?.(info));
  }

  notifyTrackChange(info: NowPlayingInfo | null) {
    const prev = this.lastTrackId;
    const next = info?.id ?? null;
    if (next !== prev) {
      this.forEachEnabled((p) => p.onTrackChange?.(info, prev));
      this.lastTrackId = next;
    }
  }

  notifyPlayState(isPlaying: boolean) {
    this.forEachEnabled((p) => p.onPlayStateChange?.(isPlaying));
  }

  notifySeek(position: number) {
    this.forEachEnabled((p) => p.onSeek?.(position));
  }

  notifyAppFocus(focused: boolean) {
    this.forEachEnabled((p) => p.onAppFocus?.(focused));
  }
}

export const pluginManager = new PluginManager(ALL_PLUGINS);
export type { NowPlayingInfo, ZenithPlugin, PluginCategory };
export { PLUGIN_CATEGORY_LABELS, PLUGIN_CATEGORY_ORDER } from './types';
