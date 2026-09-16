import { ZenithPlugin } from './types';

export const windowTitlePlugin: ZenithPlugin = {
  id: 'window-title',
  name: 'Dynamic Window Title',
  category: 'visual',
  description: 'Updates the window title to show the current artist and track name.',
  defaultEnabled: true,
  onNowPlaying(info) {
    document.title = info ? `${info.artist} - ${info.title} | Zenith` : 'Zenith';
  },
  onDisable() {
    document.title = 'Zenith';
  },
};
