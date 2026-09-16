import { abLoopPlugin } from './abLoop';
import { ambientGlowPlugin } from './ambientGlow';
import { autoPauseBlurPlugin } from './autoPauseBlur';
import { copyTrackLinkPlugin } from './copyTrackLink';
import { crossfadePlugin } from './crossfade';
import { discordPresencePlugin } from './discordPresence';
import { dualSensePlugin } from './dualSense';
import { duckOnVoicePlugin } from './duckOnVoice';
import { fadeOnPausePlugin } from './fadeOnPause';
import { globalHotkeysPlugin } from './globalHotkeys';
import { keyboardShortcutsPlugin } from './keyboardShortcuts';
import { listeningHistoryPlugin } from './listeningHistory';
import { listeningRoomPlugin } from './listeningRoom';
import { lyricsKaraokePlugin } from './lyricsKaraoke';
import { lyricsOverlayPlugin } from './lyricsOverlay';
import { mediaSessionPlugin } from './mediaSession';
import { miniPlayerPlugin } from './miniPlayer';
import { playbackSpeedPlugin } from './playbackSpeed';
import { preloadNextPlugin } from './preloadNext';
import { queuePersistPlugin } from './queuePersist';
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
import { NowPlayingInfo, PluginCategory, ZenithPlugin } from './types';

const STORAGE_KEY = 'zenith_plugins_enabled';

const ALL_PLUGINS: ZenithPlugin[] = [
  abLoopPlugin,
  ambientGlowPlugin,
  autoPauseBlurPlugin,
  copyTrackLinkPlugin,
  crossfadePlugin,
  discordPresencePlugin,
  dualSensePlugin,
  duckOnVoicePlugin,
  fadeOnPausePlugin,
  globalHotkeysPlugin,
  keyboardShortcutsPlugin,
  listeningHistoryPlugin,
  listeningRoomPlugin,
  lyricsKaraokePlugin,
  lyricsOverlayPlugin,
  mediaSessionPlugin,
  miniPlayerPlugin,
  playbackSpeedPlugin,
  preloadNextPlugin,
  queuePersistPlugin,
  rememberVolumePlugin,
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

class PluginManager {
  readonly plugins: ZenithPlugin[];
  private enabled: Record<string, boolean>;
  private lastTrackId: string | null = null;

  constructor(plugins: ZenithPlugin[]) {
    this.plugins = plugins;
    let stored: Record<string, boolean> = {};
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      stored = {};
    }
    this.enabled = {};
    for (const plugin of plugins) {
      this.enabled[plugin.id] = stored[plugin.id] ?? plugin.defaultEnabled;
    }
  }

  isEnabled(id: string): boolean {
    return Boolean(this.enabled[id]);
  }

  getStates(): Record<string, boolean> {
    return { ...this.enabled };
  }

  byCategory(): Record<PluginCategory, ZenithPlugin[]> {
    const groups: Record<PluginCategory, ZenithPlugin[]> = {
      playback: [],
      visual: [],
      social: [],
      utility: [],
    };
    for (const p of this.plugins) groups[p.category].push(p);
    return groups;
  }

  setEnabled(id: string, on: boolean) {
    if (this.enabled[id] === on) return;
    this.enabled[id] = on;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.enabled));
    } catch {}
    const plugin = this.plugins.find((p) => p.id === id);
    if (!plugin) return;
    try {
      if (on) plugin.onEnable?.();
      else plugin.onDisable?.();
    } catch (err) {
      console.warn(`[plugins] ${id} toggle failed`, err);
    }

    // one toggle for the whole streamer bundle
    if (id === 'zenith-stage' && on) {
      for (const bundled of STAGE_BUNDLE) {
        if (!this.enabled[bundled]) this.setEnabled(bundled, true);
      }
    }
  }

  private forEachEnabled(fn: (p: ZenithPlugin) => void) {
    for (const plugin of this.plugins) {
      if (!this.enabled[plugin.id]) continue;
      try {
        fn(plugin);
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
export { PLUGIN_CATEGORY_LABELS } from './types';
