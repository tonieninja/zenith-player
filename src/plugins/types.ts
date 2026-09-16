export interface NowPlayingInfo {
  id: string;
  title: string;
  artist: string;
  duration: number;
  position: number;
  isPlaying: boolean;
  coverUrl?: string;
}

export type PluginCategory = 'playback' | 'visual' | 'social' | 'utility';

export interface ZenithPlugin {
  id: string;
  name: string;
  description: string;
  category: PluginCategory;
  defaultEnabled: boolean;
  onNowPlaying?(info: NowPlayingInfo | null): void;
  /** fires on track id change, not every progress tick */
  onTrackChange?(info: NowPlayingInfo | null, previousId: string | null): void;
  onPlayStateChange?(isPlaying: boolean): void;
  onSeek?(position: number): void;
  onAppFocus?(focused: boolean): void;
  onEnable?(): void;
  onDisable?(): void;
}

export const PLUGIN_CATEGORY_LABELS: Record<PluginCategory, { en: string; pl: string }> = {
  playback: { en: 'Playback', pl: 'Odtwarzanie' },
  visual: { en: 'Visual', pl: 'Wygląd' },
  social: { en: 'Social', pl: 'Społeczność' },
  utility: { en: 'Utility', pl: 'Narzędzia' },
};
