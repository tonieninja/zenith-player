import { ZenithPlugin } from './types';

export const STAGE_BUNDLE = ['lyrics-overlay', 'share-card'] as const;

export const zenithStagePlugin: ZenithPlugin = {
  id: 'zenith-stage',
  name: 'Zenith Stage',
  category: 'integrations',
  description: 'Streamer pack: opens lyrics overlay and enables the share card in one toggle.',
  defaultEnabled: false,
};
