import { ZenithPlugin } from './types';

// kolory nakłada efekt w App (applyCoverTheme), plugin jest tylko przełącznikiem
export const ambientGlowPlugin: ZenithPlugin = {
  id: 'ambient-glow',
  name: 'Ambient Cover Glow',
  category: 'interface',
  description: 'Tints the player backdrop with colors sampled from the current album art.',
  defaultEnabled: false,
};
