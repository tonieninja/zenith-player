import { ZenithPlugin } from './types';

/** tray lives in rust, this plugin is just the toggle */
export const systemTrayPlugin: ZenithPlugin = {
  id: 'system-tray',
  name: 'System Tray',
  category: 'utility',
  description: 'Minimize to tray with play/pause, next and show controls. Always active via Rust.',
  defaultEnabled: true,
};
