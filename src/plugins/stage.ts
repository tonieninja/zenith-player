import { setKaraokeMode } from './lyricsKaraoke';
import { ZenithPlugin } from './types';

export const STAGE_BUNDLE = ['lyrics-overlay', 'lyrics-karaoke', 'share-card'] as const;

export const zenithStagePlugin: ZenithPlugin = {
  id: 'zenith-stage',
  name: 'Zenith Stage',
  category: 'integrations',
  description:
    'Streamer pack: opens lyrics overlay, turns on karaoke, and enables the share card in one toggle.',
  defaultEnabled: false,
  onEnable() {
    setKaraokeMode(true);
  },
  onDisable() {
    setKaraokeMode(false);
  },
};
