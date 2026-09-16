import { ZenithPlugin } from './types';

/** rust registers the global shortcuts, this is just the on/off toggle */
export const globalHotkeysPlugin: ZenithPlugin = {
  id: 'global-hotkeys',
  name: 'Global Hotkeys & Media Keys',
  category: 'utility',
  description:
    'Ctrl+Alt+Space play/pause, Ctrl+Alt+←/→ prev/next, plus hardware media keys - work in any app.',
  defaultEnabled: true,
};
