import { ZenithPlugin } from './types';

// obraz pokazuje CoverVideo w widoku odtwarzacza, plugin jest tylko przełącznikiem
export const musicVideoPlugin: ZenithPlugin = {
  id: 'music-video',
  name: 'Music video',
  category: 'interface',
  description: 'Plays the music video in place of the cover art. The sound stays the same.',
  defaultEnabled: false,
};
