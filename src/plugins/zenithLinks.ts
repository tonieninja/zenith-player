import { invoke } from '@tauri-apps/api/core';
import { ZenithPlugin } from './types';

// rejestracja w systemie tylko przy włączonej wtyczce, wyłączenie ją usuwa
const register = (on: boolean) => void invoke('deeplink_register', { on }).catch(() => undefined);

export const zenithLinksPlugin: ZenithPlugin = {
  id: 'zenith-links',
  name: 'zenith:// links',
  category: 'control',
  description: 'Opens zenith://play?v=<id> links from the browser or other apps in Zenith.',
  defaultEnabled: false,
  onEnable() {
    register(true);
  },
  onDisable() {
    register(false);
  },
};
