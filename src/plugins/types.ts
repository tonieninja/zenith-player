export interface NowPlayingInfo {
  id: string;
  title: string;
  artist: string;
  duration: number;
  position: number;
  isPlaying: boolean;
  coverUrl?: string;
}

export type PluginCategory =
  | 'playback'
  | 'sound'
  | 'lyrics'
  | 'control'
  | 'integrations'
  | 'interface';

/** order the plugins panel shows the groups in */
export const PLUGIN_CATEGORY_ORDER: PluginCategory[] = [
  'playback',
  'sound',
  'lyrics',
  'control',
  'integrations',
  'interface',
];

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
  sound: { en: 'Sound', pl: 'Dźwięk' },
  lyrics: { en: 'Lyrics', pl: 'Teksty' },
  control: { en: 'Control and remote', pl: 'Sterowanie i pilot' },
  integrations: { en: 'Sharing and services', pl: 'Udostępnianie i usługi' },
  interface: { en: 'Window and stats', pl: 'Okno i statystyki' },
};
