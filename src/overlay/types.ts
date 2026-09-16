export interface OverlayLyricsLine {
  time: number;
  text: string;
}

export interface OverlayPayload {
  title: string;
  artist: string;
  trackId?: string;
  coverUrl?: string;
  progress: number;
  activeLyricIndex?: number;
  isPlaying: boolean;
  synced?: OverlayLyricsLine[];
  text?: string | null;
  fontSize: 'sm' | 'md' | 'lg' | 'xl' | 'auto';
  align: 'bottom' | 'top' | 'center';
  opacity: number;
  karaoke: boolean;
  highContrast: boolean;
  secondScreen: boolean;
  hideTrackMeta?: boolean;
  /** positive = highlight earlier, late lyrics, in ms */
  syncOffsetMs?: number;
}
